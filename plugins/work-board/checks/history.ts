import type { BbPluginApi } from "@get-bb/plugin-sdk";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

export const HISTORY_DAYS = 30;
const dayMs = 86_400_000;

export interface ChecksStats {
  trackerId: string;
  days: number;
  since: number;
  /** Scheduled passes of the runner, including those that only backed off or only retried a pending delivery. */
  ticks: number;
  /** Passes that ran the script (a failed refresh counts: it has a result). */
  executed: number;
  /** Accepted deliveries, counted at the tick that delivered them (a retry's tick, not the staged one). */
  deliveries: number;
  repeats: number;
  suppressedReports: number;
  refreshFailures: number;
  scriptFailures: number;
  /** Failed deliveries, counted at the tick that staged the report. */
  deliveryFailures: number;
  /** Items first seen inside the window, by kind. */
  newItems: Record<string, number>;
}

/** Scheduled-run statistics. Manual runs never reach this store. */
export function checksHistory(db: Database) {
  const start = db.prepare<[string, string, number]>("INSERT INTO checks_ticks (tick, tracker_id, at) VALUES (?, ?, ?)");
  const pruneTicks = db.prepare<[number]>("DELETE FROM checks_ticks WHERE at < ?");
  const pruneItems = db.prepare<[number]>("DELETE FROM checks_items WHERE last_at < ?");
  const seen = db.prepare<[string, string, string, number, number]>("INSERT OR IGNORE INTO checks_items VALUES (?, ?, ?, ?, ?)");
  const repeat = db.prepare<[number, string, string]>("UPDATE checks_items SET last_at = ? WHERE tracker_id = ? AND fingerprint = ?");
  const result = db.prepare<[number, number, number, string]>("UPDATE checks_ticks SET executed = 1, repeated = ?, refresh_failed = ?, script_failed = ? WHERE tick = ?");
  const suppress = db.prepare<[string]>("UPDATE checks_ticks SET suppressed = 1 WHERE tick = ?");
  const delivery = db.prepare<[string]>("UPDATE checks_ticks SET delivered = delivered + 1 WHERE tick = ?");
  const failed = db.prepare<[string]>("UPDATE checks_ticks SET delivery_failed = 1 WHERE tick = ?");
  const counts = db.prepare<[string, number], Omit<ChecksStats, "trackerId" | "days" | "since" | "newItems">>(`SELECT count(*) AS ticks, coalesce(sum(executed),0) AS executed,
    coalesce(sum(delivered),0) AS deliveries, coalesce(sum(repeated),0) AS repeats, coalesce(sum(suppressed),0) AS suppressedReports,
    coalesce(sum(refresh_failed),0) AS refreshFailures, coalesce(sum(script_failed),0) AS scriptFailures,
    coalesce(sum(delivery_failed),0) AS deliveryFailures FROM checks_ticks WHERE tracker_id = ? AND at >= ?`);
  const newItems = db.prepare<[string, number], { kind: string; count: number }>("SELECT kind, count(*) AS count FROM checks_items WHERE tracker_id = ? AND first_at >= ? GROUP BY kind ORDER BY kind");
  return {
    start(tracker: string, tick: string, now: number) {
      start.run(tick, tracker, now);
      const cutoff = now - HISTORY_DAYS * dayMs;
      pruneTicks.run(cutoff);
      pruneItems.run(cutoff);
    },
    /** One item counts once per normalized fingerprint per tick: the map is keyed by it. */
    result: db.transaction((tracker: string, tick: string, now: number, items: Map<string, string>, failure?: "refresh" | "script") => {
      let repeats = 0;
      for (const [fingerprint, kind] of items) {
        if (seen.run(tracker, fingerprint, kind, now, now).changes) continue;
        repeat.run(now, tracker, fingerprint);
        repeats++;
      }
      result.run(repeats, Number(failure === "refresh"), Number(failure === "script"), tick);
    }),
    suppress(tick: string) { suppress.run(tick); },
    delivered(tick: string) { delivery.run(tick); },
    deliveryFailed(tick: string) { failed.run(tick); },
    stats(trackerId: string, days: number): ChecksStats {
      const since = Date.now() - days * dayMs;
      return { trackerId, days, since, ...counts.get(trackerId, since)!, newItems: Object.fromEntries(newItems.all(trackerId, since).map(({ kind, count }) => [kind, count])) };
    },
  };
}
