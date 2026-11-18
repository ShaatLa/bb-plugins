import type { Database } from "better-sqlite3";

const DAY_MS = 86_400_000;
const SHORT_LIVED_MS = 24 * 3_600_000;

export type PruneOptions = { rawRetentionDays: number; rollupRetentionDays: number; now: number };

/** Deletes expired rows (raw, hourly, short-lived join tables), returns space to the file, and reports the row count. */
export function prune(db: Database, { rawRetentionDays, rollupRetentionDays, now }: PruneOptions): number {
  const shortCutoff = now - SHORT_LIVED_MS;
  const run = (sql: string, cutoff: number) => db.prepare(sql).run(cutoff).changes;
  const deleted = db.transaction(() =>
    run(`DELETE FROM usage_raw WHERE ts < ?`, now - rawRetentionDays * DAY_MS) +
    run(`DELETE FROM usage_hourly WHERE hour < ?`, now - rollupRetentionDays * DAY_MS) +
    run(`DELETE FROM requests WHERE at < ?`, shortCutoff) +
    // ext_pending is not pruned here: ingest/ext.ts deletes an entry only after its row is durable.
    run(`DELETE FROM bb_candidate WHERE ts < ?`, shortCutoff),
  )();
  db.pragma("incremental_vacuum");
  return deleted;
}

const COUNTED_TABLES = [
  "usage_raw", "usage_hourly", "thread_tokens", "threads", "turns", "requests", "compactions", "compaction_effect",
  "file_cursor", "ext_pending", "bb_candidate",
] as const;

export type DiskStats = { bytes: number; pages: number; freePages: number; rows: Record<string, number> };

export function diskStats(db: Database): DiskStats {
  const pages = db.pragma("page_count", { simple: true }) as number;
  const pageSize = db.pragma("page_size", { simple: true }) as number;
  const freePages = db.pragma("freelist_count", { simple: true }) as number;
  const rows: Record<string, number> = {};
  for (const table of COUNTED_TABLES) {
    rows[table] = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }
  return { bytes: pages * pageSize, pages, freePages, rows };
}
