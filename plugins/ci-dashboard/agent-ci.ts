import { z } from "zod";
import { rangeInputSchema } from "./date-range";
import { metricsSchema, repositorySchema } from "./metrics";
import { actorSchema, poolStateSchema, problemSchema, repositorySignalsSchema, signalSchema, type SignalsOutput } from "./ci-signals-contract";
import type { DashboardData } from "./server";

export const ciQuerySchema = z.object({
  repository: repositorySchema.optional().describe("Configured owner/repo; omit for all dashboard repositories."),
  selection: rangeInputSchema.default({ days: 7 }).describe("Preset days 1, 3, 7, 14, 30 or 90, or inclusive UTC start/end dates within the past year. One day means today from 00:00 UTC."),
  refresh: z.boolean().default(false).describe("False returns a local snapshot when available, including stale data with its timestamp. True forces a GitHub refresh; cold/large ranges may take time. Ignored by views other than summary."),
  view: z.enum(["summary", "signals", "stall", "pools", "losses", "failures", "reruns"]).default("summary").describe("summary: run-level metrics plus open signals and runner pools. Other views return only job-level data from the local store: signals (all, open first), stall (runner pool queues and timings), pools (per pool queue wait and duration p50/p90, by event too), losses (runner loss tallies, mass cancels), failures (classified failed jobs with run event, merge queue PR and queueOnly, plus counts by event), reruns (with run event). They ignore selection."),
}).strict();
const openSignalSchema = signalSchema.pick({ id: true, kind: true, severity: true, title: true, since: true }).extend({ actor: actorSchema });
const summaryRow = metricsSchema.pick({ repository: true, updatedAt: true, range: true, ciOutcomes: true, ciInsights: true }).extend({
  projectName: z.string().nullable(), ageSeconds: z.number().nonnegative(), stale: z.boolean(), pending: z.array(z.string()),
  passRate: metricsSchema.shape.ci.omit({ series: true, seriesError: true }).extend({ historyError: z.string().nullable() }),
  signals: z.object({ open: z.array(openSignalSchema), pools: z.array(poolStateSchema), backfill: repositorySignalsSchema.shape.backfill,
    /** Open problems with their handled state: dismissed, or investigating in a BB thread. */
    problems: z.array(problemSchema.pick({ id: true, severity: true, title: true, since: true, handled: true })) }),
});
// Non-summary views carry exactly one slice of the signals RPC data next to these identity fields.
const sliceRow = repositorySignalsSchema.pick({ repository: true, updatedAt: true, error: true, window: true, backfill: true })
  .extend(repositorySignalsSchema.pick({ live: true, signals: true, problems: true, runnerLosses: true, massCancels: true, failureCounts: true, failureCountsByEvent: true, poolTimings: true, poolTimingsByEvent: true, failures: true, reruns: true }).partial().shape);
export const ciReportSchema = z.object({
  source: z.enum(["cache", "collection"]), discoveryError: z.string().nullable(),
  repositories: z.array(z.union([summaryRow, sliceRow])),
});
export type CiQuery = z.infer<typeof ciQuerySchema>;

const noBackfill = { remaining: 0, failed: 0, pausedUntil: null, coveredSince: null };
export function ciSliceReport(signals: SignalsOutput, view: Exclude<CiQuery["view"], "summary">) {
  const slice = {
    stall: (r) => ({ live: r.live, signals: r.signals.filter((s) => s.kind === "pool_stall"), poolTimings: r.poolTimings }),
    pools: (r) => ({ poolTimings: r.poolTimings, poolTimingsByEvent: r.poolTimingsByEvent }),
    signals: (r) => ({ signals: r.signals, problems: r.problems }),
    losses: (r) => ({ runnerLosses: r.runnerLosses, massCancels: r.massCancels }),
    failures: (r) => ({ failureCounts: r.failureCounts, failureCountsByEvent: r.failureCountsByEvent, failures: r.failures }),
    reruns: (r) => ({ reruns: r.reruns }),
  } satisfies Record<typeof view, (row: SignalsOutput["repositories"][number]) => object>;
  return ciReportSchema.parse({ source: "cache", discoveryError: null, repositories: signals.repositories.map((row) => ({
    repository: row.repository, updatedAt: row.updatedAt, error: row.error, window: row.window, backfill: row.backfill, ...slice[view](row),
  })) });
}

export function ciReport(data: DashboardData, query: CiQuery, refreshSeconds: number, fromCache: boolean, signals: SignalsOutput) {
  const repositories = data.repositories.filter((row) => !query.repository || row.repository.toLowerCase() === query.repository.toLowerCase());
  if (query.repository && repositories.length === 0) throw new Error("Repository is not configured in CI Dashboard or could not be discovered.");
  return ciReportSchema.parse({
    source: fromCache ? "cache" : "collection", discoveryError: data.discoveryError,
    repositories: repositories.map((row) => {
      const age = (Date.now() - Date.parse(row.updatedAt)) / 1000;
      return { repository: row.repository, projectName: row.projectName, updatedAt: row.updatedAt, range: row.range,
        ageSeconds: Math.max(0, Math.floor(age)), stale: age < 0 || age >= refreshSeconds,
        pending: row.pending?.filter((key) => key === "ci" || key === "commitActivity") ?? [],
        passRate: { value: row.ci.value, detail: row.ci.detail, error: row.ci.error, historyError: row.ci.seriesError },
        ciOutcomes: row.ciOutcomes, ciInsights: row.ciInsights,
        signals: (() => {
          const found = signals.repositories.find((item) => item.repository.toLowerCase() === row.repository.toLowerCase());
          return { open: (found?.signals ?? []).filter((signal) => signal.open).slice(0, 50).map(({ id, kind, severity, title, since, actor }) => ({ id, kind, severity, title, since, actor })),
            pools: found?.live.pools ?? [], backfill: found?.backfill ?? noBackfill,
            problems: (found?.problems ?? []).map(({ id, severity, title, since, handled }) => ({ id, severity, title, since, handled })) };
        })(),
      };
    }),
  });
}
