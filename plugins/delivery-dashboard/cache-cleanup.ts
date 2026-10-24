import type { BbPluginApi } from "@get-bb/plugin-sdk";

export const cacheMaxBytes = 64 * 1024 * 1024;
const idleMs = 7 * 86_400_000;
type Database = ReturnType<BbPluginApi["storage"]["database"]>;

function responseRepository(key: string): string | undefined {
  try {
    const [, path] = JSON.parse(key);
    const url = new URL(path, "https://api.github.com");
    return (/^\/repos\/([^/]+\/[^/]+)\//.exec(url.pathname)?.[1] ?? /(?:^|\s)repo:([^\s]+)/.exec(url.searchParams.get("q") ?? "")?.[1])?.toLowerCase();
  } catch { return undefined; }
}

export function cleanupCache(database: Database, activeRepositories?: string[], compact = false) {
  const cutoff = Date.now() - idleMs;
  const active = activeRepositories ? new Set(activeRepositories.map((name) => name.toLowerCase())) : null;
  let removed = 0;
  const bytes = database.transaction(() => {
    removed += database.prepare("DELETE FROM github_responses WHERE last_used_at < ?").run(cutoff).changes;
    removed += database.prepare("DELETE FROM repository_history WHERE last_used_at < ?").run(cutoff).changes;
    removed += database.prepare("DELETE FROM dashboard_snapshots WHERE refreshed_at < ?").run(cutoff).changes;
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
