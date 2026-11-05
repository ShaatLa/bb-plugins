import { gunzipSync, gzipSync } from "node:zlib";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { minimumDate } from "./date-range";
import { historicalRecordsSchema } from "./metrics";
import { sortSignals } from "./ci-signals";
import type { Signal } from "./ci-jobs-types";

export const cacheMaxBytes = 64 * 1024 * 1024;
export const jobMaxBytes = 64 * 1024 * 1024;
export const deepDays = 90; // the largest range preset; older coverage lives only while a deeper range is being viewed
export const deepIdleMs = 7 * 86_400_000;
export const openSignalsCap = 200;
/** Newest, most severe first; dropping the rest before the tracker sees them keeps dropped ones from re-opening (and re-pushing) every cycle. */
export const capOpenSignals = (signals: Signal[]) => signals.length > openSignalsCap ? sortSignals(signals).slice(0, openSignalsCap) : signals;
const idleMs = 7 * 86_400_000;
type Database = ReturnType<BbPluginApi["storage"]["database"]>;

// Large JSON columns are stored gzip-compressed (BLOB); legacy rows are still plain JSON text.
export const compress = (text: string): Buffer => gzipSync(text);
export const decompress = (stored: string | Uint8Array): string => typeof stored === "string" ? stored : gunzipSync(stored).toString("utf8");

// Cache keys that can never be read again: old metadata versions, and ranges ending at a long-gone "now".
const alignedEnd = /(T23:59:59\.999Z|\.000Z)$/;
export function purgeDeadResponses(database: Database, now = Date.now()) {
  const dead: number[] = [];
  for (const row of database.prepare("SELECT rowid, cache_key, checked_at FROM github_responses").all() as { rowid: number; cache_key: string; checked_at: number }[]) {
    try {
      const [scope, path] = JSON.parse(row.cache_key) as [string, string];
      if (path.includes("/actions/runs?") && !scope.endsWith(":ci-metadata-v3")) { dead.push(row.rowid); continue; }
      if (row.checked_at >= now - 3_600_000) continue;
      const url = new URL(path, "https://api.github.com");
      const until = url.searchParams.get("created")?.split("..")[1] ?? /created:\S+?\.\.(\S+)/.exec(url.searchParams.get("q") ?? "")?.[1];
      if (until && /\.\d{3}Z$/.test(until) && !alignedEnd.test(until)) dead.push(row.rowid);
    } catch { /* Unknown cache keys remain subject to idle and size limits. */ }
  }
  return dead.length ? database.prepare("DELETE FROM github_responses WHERE rowid IN (SELECT value FROM json_each(?))").run(JSON.stringify(dead)).changes : 0;
}

function responseRepository(key: string): string | undefined {
  try {
    const [, path] = JSON.parse(key);
    const url = new URL(path, "https://api.github.com");
    return (/^\/repos\/([^/]+\/[^/]+)\//.exec(url.pathname)?.[1] ?? /(?:^|\s)repo:([^\s]+)/.exec(url.searchParams.get("q") ?? "")?.[1])?.toLowerCase();
  } catch { return undefined; }
}

type StoredHistory = { coverage: { since: string; until: string }; metrics?: { range?: { since: string } }; records: unknown };
function trimHistory(history: StoredHistory, earliest: string) {
  const records = historicalRecordsSchema.parse(history.records);
  const start = Date.parse(earliest);
  history.records = { ...records,
    deployments: records.deployments.filter((item) => Date.parse(item.created_at) >= start),
    runs: records.runs.filter((item) => Date.parse(item.created_at) >= start),
    commits: records.commits.filter((item) => Date.parse(item.committedDate) >= start),
  };
  history.coverage.since = earliest;
}

/** Day-aligned start of the 90-day window: the floor history coverage is trimmed to when no deeper range was requested lately. */
export const shallowFloor = (now = Date.now()) => new Date(Math.floor((now - deepDays * 86_400_000) / 86_400_000) * 86_400_000).toISOString();

// `trimHistoryTo` only shortens stored coverage/records; it never deletes a row (unlike the one-year boundary).
export function cleanupCache(database: Database, activeRepositories?: string[], compact = false, trimHistoryTo?: string) {
  const cutoff = Date.now() - idleMs;
  const earliest = `${minimumDate()}T00:00:00.000Z`;
  const trimTo = trimHistoryTo && trimHistoryTo > earliest ? trimHistoryTo : earliest;
  const active = activeRepositories ? new Set(activeRepositories.map((name) => name.toLowerCase())) : null;
  let removed = 0;
  const bytes = database.transaction(() => {
    removed += database.prepare("DELETE FROM github_responses WHERE last_used_at < ?").run(cutoff).changes;
    removed += database.prepare("DELETE FROM repository_history WHERE last_used_at < ?").run(cutoff).changes;
    removed += database.prepare("DELETE FROM dashboard_snapshots WHERE refreshed_at < ?").run(cutoff).changes;
    // Aggregates and conditional HTTP pages cannot be partially trimmed without losing their meaning.
    removed += database.prepare(`DELETE FROM dashboard_snapshots WHERE CASE WHEN json_valid(data) THEN
      EXISTS (SELECT 1 FROM json_tree(data) WHERE key = 'since' AND julianday(value) < julianday(?)) ELSE 0 END`).run(earliest).changes;
    // SQL JSON functions only see legacy text rows; compressed rows are checked in JS below.
    removed += database.prepare(`DELETE FROM repository_history WHERE CASE WHEN typeof(data) = 'text' AND json_valid(data) THEN
      julianday(json_extract(data, '$.coverage.until')) < julianday(?) OR
      julianday(json_extract(data, '$.metrics.range.since')) < julianday(?) ELSE 0 END`).run(earliest, earliest).changes;
    const histories = database.prepare(`SELECT rowid, data FROM repository_history WHERE typeof(data) = 'blob' OR CASE WHEN typeof(data) = 'text' AND json_valid(data) THEN
      julianday(json_extract(data, '$.coverage.since')) < julianday(?) ELSE 0 END`).all(trimTo) as { rowid: number; data: string | Uint8Array }[];
    for (const row of histories) {
      try {
        const history = JSON.parse(decompress(row.data)) as StoredHistory;
        if (typeof row.data !== "string" && (Date.parse(history.coverage.until) < Date.parse(earliest) || Date.parse(history.metrics?.range?.since ?? earliest) < Date.parse(earliest))) {
          removed += database.prepare("DELETE FROM repository_history WHERE rowid = ?").run(row.rowid).changes;
        } else if (Date.parse(history.coverage.since) < Date.parse(trimTo)) {
          trimHistory(history, trimTo);
          const text = JSON.stringify(history);
          database.prepare("UPDATE repository_history SET data = ? WHERE rowid = ?").run(typeof row.data === "string" ? text : compress(text), row.rowid);
        }
      } catch { removed += database.prepare("DELETE FROM repository_history WHERE rowid = ?").run(row.rowid).changes; }
    }
    for (const row of database.prepare("SELECT rowid, cache_key FROM github_responses").all() as { rowid: number; cache_key: string }[]) {
      try {
        const [, path] = JSON.parse(row.cache_key);
        const url = new URL(path, "https://api.github.com");
        const from = url.searchParams.get("created")?.split("..")[0] ?? /(?:^|\s)created:(\d{4}-\d{2}-\d{2})/.exec(url.searchParams.get("q") ?? "")?.[1];
        const oldPage = /\/(actions\/runs|deployments)(\/|$)/.test(url.pathname) && database.prepare(`SELECT 1 FROM github_responses,
          json_tree(CASE WHEN json_valid(data) THEN data ELSE '{}' END) WHERE github_responses.rowid = ?
          AND json_tree.key = 'created_at' AND julianday(json_tree.value) < julianday(?) LIMIT 1`).get(row.rowid, earliest);
        if ((from && from.slice(0, 10) < earliest.slice(0, 10)) || oldPage) removed += database.prepare("DELETE FROM github_responses WHERE rowid = ?").run(row.rowid).changes;
      } catch { /* Unknown cache keys remain subject to idle and size limits. */ }
    }
    if (active) {
      for (const row of database.prepare("SELECT rowid, repository FROM repository_history").all() as { rowid: number; repository: string }[]) {
        if (!active.has(row.repository.toLowerCase())) removed += database.prepare("DELETE FROM repository_history WHERE rowid = ?").run(row.rowid).changes;
      }
      for (const row of database.prepare("SELECT rowid, data FROM dashboard_snapshots").all() as { rowid: number; data: string }[]) {
        try {
          const names = (JSON.parse(row.data).repositories as { repository: string }[]).map((repo) => repo.repository.toLowerCase());
          if (names.length !== active.size || names.some((name) => !active.has(name))) removed += database.prepare("DELETE FROM dashboard_snapshots WHERE rowid = ?").run(row.rowid).changes;
        } catch { removed += database.prepare("DELETE FROM dashboard_snapshots WHERE rowid = ?").run(row.rowid).changes; }
      }
      for (const row of database.prepare("SELECT rowid, cache_key FROM github_responses").all() as { rowid: number; cache_key: string }[]) {
        const repository = responseRepository(row.cache_key);
        if (repository && !active.has(repository)) removed += database.prepare("DELETE FROM github_responses WHERE rowid = ?").run(row.rowid).changes;
      }
    }
    removed += database.prepare("DELETE FROM github_responses WHERE rowid NOT IN (SELECT rowid FROM github_responses ORDER BY last_used_at DESC, rowid DESC LIMIT 512)").run().changes;
    removed += database.prepare("DELETE FROM dashboard_snapshots WHERE rowid NOT IN (SELECT rowid FROM dashboard_snapshots ORDER BY refreshed_at DESC, rowid DESC LIMIT 8)").run().changes;
    const rows = database.prepare(`
      SELECT 'github_responses' AS cache_table, rowid, length(CAST(data AS BLOB)) AS bytes, last_used_at AS used_at, 0 AS priority FROM github_responses
      UNION ALL SELECT 'dashboard_snapshots', rowid, length(CAST(data AS BLOB)) + coalesce(length(CAST(history AS BLOB)), 0), refreshed_at, 1 FROM dashboard_snapshots
      UNION ALL SELECT 'repository_history', rowid, length(CAST(data AS BLOB)), last_used_at, 2 FROM repository_history
      ORDER BY priority, used_at, rowid
    `).all() as { cache_table: "github_responses" | "dashboard_snapshots" | "repository_history"; rowid: number; bytes: number }[];
    let total = rows.reduce((sum, row) => sum + row.bytes, 0);
    for (const row of rows) {
      if (total <= cacheMaxBytes) break;
      removed += database.prepare(`DELETE FROM ${row.cache_table} WHERE rowid = ?`).run(row.rowid).changes;
      total -= row.bytes;
    }
    return total;
  })();
  if (compact && !database.inTransaction) {
    const free = database.pragma("freelist_count", { simple: true }) as number;
    const pages = database.pragma("page_count", { simple: true }) as number;
    const pageSize = database.pragma("page_size", { simple: true }) as number;
    if (free * pageSize >= 8 * 1024 * 1024 && free >= pages / 4) database.exec("VACUUM");
    database.pragma("wal_checkpoint(TRUNCATE)");
  }
  return { removed, bytes };
}


const sum = (database: Database, sql: string) => (database.prepare(sql).get() as { bytes: number }).bytes;
/** Payload bytes per storage area plus the database file and its free pages. */
export function storageStats(database: Database) {
  const pageSize = database.pragma("page_size", { simple: true }) as number;
  return {
    jobs: sum(database, "SELECT coalesce(sum(length(data)), 0) AS bytes FROM ci_jobs"),
    history: sum(database, "SELECT coalesce(sum(length(CAST(data AS BLOB))), 0) AS bytes FROM repository_history"),
    httpCache: sum(database, "SELECT coalesce(sum(length(CAST(data AS BLOB))), 0) AS bytes FROM github_responses"),
    snapshots: sum(database, "SELECT coalesce(sum(length(CAST(data AS BLOB)) + coalesce(length(CAST(history AS BLOB)), 0)), 0) AS bytes FROM dashboard_snapshots"),
    freePages: (database.pragma("freelist_count", { simple: true }) as number) * pageSize,
    dbFile: (database.pragma("page_count", { simple: true }) as number) * pageSize,
  };
}
