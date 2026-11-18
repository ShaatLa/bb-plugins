import type Database from 'better-sqlite3';

export const dayMs = 86400000;
export const historyDays = 30;

export function sweepHistory(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS sweep_ticks (
    tick TEXT PRIMARY KEY, project TEXT NOT NULL, at INTEGER NOT NULL,
    executed INTEGER NOT NULL DEFAULT 0, manager INTEGER NOT NULL DEFAULT 0, answers INTEGER NOT NULL DEFAULT 0,
    repeated INTEGER NOT NULL DEFAULT 0, suppressed INTEGER NOT NULL DEFAULT 0, reminder INTEGER NOT NULL DEFAULT 0,
    refresh_failed INTEGER NOT NULL DEFAULT 0, script_failed INTEGER NOT NULL DEFAULT 0, delivery_failed INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS sweep_ticks_at ON sweep_ticks (at);
  CREATE INDEX IF NOT EXISTS sweep_ticks_project_at ON sweep_ticks (project, at);
  CREATE TABLE IF NOT EXISTS sweep_items (
    project TEXT NOT NULL, fingerprint TEXT NOT NULL, kind TEXT NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
    PRIMARY KEY (project, fingerprint)
  );
  CREATE INDEX IF NOT EXISTS sweep_items_last_at ON sweep_items (last_at);
  CREATE INDEX IF NOT EXISTS sweep_items_project_first_at ON sweep_items (project, first_at);`);
  const start = db.prepare('INSERT INTO sweep_ticks (tick, project, at) VALUES (?, ?, ?)');
  const pruneTicks = db.prepare('DELETE FROM sweep_ticks WHERE at < ?');
  const pruneItems = db.prepare('DELETE FROM sweep_items WHERE last_at < ?');
  const seen = db.prepare('INSERT OR IGNORE INTO sweep_items VALUES (?, ?, ?, ?, ?)');
  const repeat = db.prepare('UPDATE sweep_items SET last_at = ? WHERE project = ? AND fingerprint = ?');
  const result = db.prepare('UPDATE sweep_ticks SET executed = 1, repeated = ?, refresh_failed = ?, script_failed = ? WHERE tick = ?');
  const disposition = db.prepare('UPDATE sweep_ticks SET suppressed = ?, reminder = ? WHERE tick = ?');
  const delivery = db.prepare('UPDATE sweep_ticks SET manager = manager + ?, answers = answers + ? WHERE tick = ?');
  const failed = db.prepare('UPDATE sweep_ticks SET delivery_failed = 1 WHERE tick = ?');
  const counts = db.prepare(`SELECT count(*) AS ticks, coalesce(sum(executed),0) AS executed,
    coalesce(sum(manager + answers),0) AS deliveries, coalesce(sum(manager),0) AS manager, coalesce(sum(answers),0) AS answers,
    coalesce(sum(repeated),0) AS repeats, coalesce(sum(suppressed),0) AS suppressedReports, coalesce(sum(reminder),0) AS reminderReports,
    coalesce(sum(refresh_failed),0) AS refreshFailures, coalesce(sum(script_failed),0) AS scriptFailures,
    coalesce(sum(delivery_failed),0) AS deliveryFailures FROM sweep_ticks WHERE project = ? AND at >= ?`);
  const newItems = db.prepare('SELECT kind, count(*) AS count FROM sweep_items WHERE project = ? AND first_at >= ? GROUP BY kind ORDER BY kind');
  return {
    start(project: string, tick: string, now: number) {
      start.run(tick, project, now);
      const cutoff = now - historyDays * dayMs;
      pruneTicks.run(cutoff);
      pruneItems.run(cutoff);
    },
    result: db.transaction((project: string, tick: string, now: number, items: Map<string, string>, failure?: 'refresh' | 'script') => {
      let repeats = 0;
      for (const [fingerprint, kind] of items) {
        if (seen.run(project, fingerprint, kind, now, now).changes) continue;
        repeat.run(now, project, fingerprint);
        repeats++;
      }
      result.run(repeats, Number(failure === 'refresh'), Number(failure === 'script'), tick);
    }),
    disposition(tick: string, kind: 'suppress' | 'remind') {
      disposition.run(Number(kind === 'suppress'), Number(kind === 'remind'), tick);
    },
    delivered(tick: string, answers: boolean) { delivery.run(Number(!answers), Number(answers), tick); },
    deliveryFailed(tick: string) { failed.run(tick); },
    stats(projectId: string, days: number) {
      const since = Date.now() - days * dayMs;
      const byKind = newItems.all(projectId, since) as { kind: string; count: number }[];
      return { projectId, days, since, ...counts.get(projectId, since) as Record<string, number>, newItems: Object.fromEntries(byKind.map(({ kind, count }) => [kind, count])) };
    },
  };
}
