import { z } from "zod";
import { rangeInputSchema } from "./date-range";
import { metricsSchema, repositorySchema } from "./metrics";
import { actorSchema, poolStateSchema, problemSchema, repositorySignalsSchema, signalSchema, type SignalsOutput } from "./ci-signals-contract";
import { inspectionSchema } from "./ci-inspect";
import { jobRef, problemRefs, queueRef, runRef, REF_FORMS, whereRef } from "./ci-refs";
import type { DashboardData } from "./server";

export const ciQuerySchema = z.object({
  repository: repositorySchema.optional().describe("Configured owner/repo; omit for all dashboard repositories."),
  selection: rangeInputSchema.default({ days: 7 }).describe("Preset days 1, 3, 7, 14, 30 or 90, or inclusive UTC start/end dates within the past year. One day means today from 00:00 UTC."),
  refresh: z.boolean().default(false).describe("False returns a local snapshot when available, including stale data with its timestamp. True forces a GitHub refresh; cold/large ranges may take time. Ignored by views other than summary."),
  view: z.enum(["summary", "problems", "signals", "stall", "losses", "failures", "reruns"]).default("summary").describe("summary: run-level metrics plus open signals and runner pools. problems: only the open CI health problems with ids, handled state and refs (smallest; use it to find something to take with ci_dashboard_manage). Other views return only compact job-level rows from the local store, each with a ref for ref=...: signals (open signals: id, kind, severity, title, what, since, actor, ref), stall (live runner pool queues plus per pool queue wait and duration p50/p90, overall and by event), losses (runner loss tallies, mass cancels with run refs, recent loss job refs), failures (failed jobs: ref, run, name, class, event, at, queuePullRequest, plus counts by event), reruns (rows with run and queue refs). They ignore selection."),
  ref: z.string().trim().min(1).max(300).optional().describe(`Drill down: pass a ref taken from any view or observer line to get one small inspection (summary, facts, related refs, next steps) built from the local store only. view, selection and refresh are then ignored. Refs: ${REF_FORMS.join("; ")}.`),
}).strict();
const openSignalSchema = signalSchema.pick({ id: true, kind: true, severity: true, title: true, since: true }).extend({ actor: actorSchema });
// One line per signal for agents: the where block (runner, sha, ids) made up half of view=signals. `ref` replaces the url (ref=... returns the link and the details).
const compactSignalSchema = openSignalSchema.extend({ what: z.string(), ref: z.string().optional() });
const compact = (s: z.infer<typeof signalSchema>) => ({ id: s.id, kind: s.kind, severity: s.severity, title: s.title, what: s.what, since: s.since, actor: s.actor, ...(whereRef(s.where) ? { ref: whereRef(s.where) } : {}) });
type SignalsRow = SignalsOutput["repositories"][number];
const withRefs = <T extends { id: string; where: z.infer<typeof signalSchema>["where"] }>(problem: T, row: SignalsRow) => ({ ...problem, refs: problemRefs(problem, { failures: row.failures, massCancels: row.massCancels }) });
// Problem rows for agents: what is needed to pick and claim one; impact and the where block come with ref=<problem id>. The url stays: it is what a person is sent to.
const agentProblemSchema = problemSchema.pick({ id: true, severity: true, title: true, what: true, since: true, handled: true }).extend({ refs: z.array(z.string()), url: z.url().optional() });
const agentProblem = (problem: SignalsRow["problems"][number], row: SignalsRow) => ({ id: problem.id, severity: problem.severity, title: problem.title, what: problem.what, since: problem.since, handled: problem.handled,
  refs: withRefs(problem, row).refs, ...(problem.where.url ? { url: problem.where.url } : {}) });
/** Index rows must stay far below an agent's tool-output cap (~25 KB) whatever the data volume: rows are cut by serialized size, newest/most severe first, and the cut is counted. */
const within = <T>(list: T[], max: number) => { let used = 0; const kept = list.filter((item) => (used += JSON.stringify(item).length + 1) <= max); return { kept, more: list.length - kept.length }; };
const bounded = <K extends string>(key: K, list: unknown[], max: number) => { const { kept, more } = within(list, max); return { [key]: kept, ...(more ? { [`more${key[0]!.toUpperCase()}${key.slice(1)}`]: more } : {}) }; };
// Index rows for agents: refs instead of annotations, excerpts and urls; ref=... returns the details.
const failureClass = repositorySignalsSchema.shape.failures.element.shape.class;
const agentFailureRow = z.object({ ref: z.string(), run: z.string(), name: z.string(), class: failureClass, event: z.string(), at: z.iso.datetime({ offset: true }).nullable(), queuePullRequest: z.number().optional(), queueOnly: z.literal(true).optional() });
const agentRerunRow = z.object({ ref: z.string(), queue: z.string().optional(), workflow: z.string(), event: z.string(), queuePullRequest: z.number().optional(), attempts: z.number(), outcomes: z.array(z.string().nullable()), final: z.string().nullable(), repeatedRunnerMs: z.number() });
const agentMassCancel = z.object({ ref: z.string(), since: z.string(), until: z.string(), jobs: z.number(), runners: z.number(), runs: z.array(z.string()) });
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
const failureRows = (row: SignalsRow) => row.failures.map((f) => ({ ref: jobRef(f.jobId), run: runRef(f.runId, f.attempt), name: clip(f.jobName, 80), class: f.class, event: f.event, at: f.completedAt ?? f.startedAt,
  ...(f.queuePullRequest === null ? {} : { queuePullRequest: f.queuePullRequest }), ...(f.queueOnly ? { queueOnly: true as const } : {}) }));
const rerunRows = (row: SignalsRow) => row.reruns.map((r) => ({ ref: runRef(r.runId), ...(r.event === "merge_group" ? { queue: queueRef(r.runId, r.attempts) } : {}), workflow: clip(r.workflowName, 80), event: r.event,
  ...(r.queuePullRequest === null ? {} : { queuePullRequest: r.queuePullRequest }), attempts: r.attempts, outcomes: r.outcomes, final: r.finalConclusion, repeatedRunnerMs: r.repeatedRunnerMs }));
const massCancelRows = (row: SignalsRow) => row.massCancels.map((m) => ({ ref: `mass_cancel:${m.since}`, since: m.since, until: m.until, jobs: m.jobs, runners: m.runners.length, runs: [...m.runIds].sort((a, b) => b - a).slice(0, 3).map((id) => runRef(id)) }));
const summaryRow = metricsSchema.pick({ repository: true, updatedAt: true, range: true, ciOutcomes: true, ciInsights: true }).extend({
  projectName: z.string().nullable(), ageSeconds: z.number().nonnegative(), stale: z.boolean(), pending: z.array(z.string()),
  passRate: metricsSchema.shape.ci.omit({ series: true, seriesError: true }).extend({ historyError: z.string().nullable() }),
  signals: z.object({ open: z.array(openSignalSchema), pools: z.array(poolStateSchema), backfill: repositorySignalsSchema.shape.backfill,
    /** Open problems with their handled state: dismissed, investigating in a BB thread, or fix_pending (a fix PR/card ref). */
    problems: z.array(problemSchema.pick({ id: true, severity: true, title: true, since: true, handled: true }).extend({ refs: z.array(z.string()) })) }),
});
// Non-summary views carry exactly one slice of the signals RPC data next to these identity fields.
// Problems come first: a long signals list must never push them past an agent's tool-output cap.
const sliceRow = repositorySignalsSchema.pick({ repository: true, updatedAt: true, error: true, window: true, backfill: true })
  .extend({ problems: z.array(agentProblemSchema).optional(), signals: z.array(compactSignalSchema).optional(), massCancels: z.array(agentMassCancel).optional(), recentLosses: z.array(z.string()).optional(),
    failures: z.array(agentFailureRow).optional(), reruns: z.array(agentRerunRow).optional(),
    moreProblems: z.number().optional(), moreSignals: z.number().optional(), moreFailures: z.number().optional(), moreReruns: z.number().optional() })
  .extend(repositorySignalsSchema.pick({ live: true, runnerLosses: true, failureCounts: true, failureCountsByEvent: true, poolTimings: true, poolTimingsByEvent: true }).partial().shape);
export const ciReportSchema = z.object({
  source: z.enum(["cache", "collection"]), discoveryError: z.string().nullable(),
  repositories: z.array(z.union([summaryRow, sliceRow])),
});
/** The `ci` RPC and ci_dashboard_metrics return a report, or one inspection when `ref` is given. */
export const ciOutputSchema = z.union([ciReportSchema, inspectionSchema]);
export type CiQuery = z.infer<typeof ciQuerySchema>;

const noBackfill = { remaining: 0, failed: 0, pausedUntil: null, coveredSince: null };
export function ciSliceReport(signals: SignalsOutput, view: Exclude<CiQuery["view"], "summary">) {
  const slice = {
    stall: (r) => ({ live: r.live, signals: r.signals.filter((s) => s.kind === "pool_stall").map(compact), poolTimings: r.poolTimings, poolTimingsByEvent: r.poolTimingsByEvent }),
    problems: (r) => bounded("problems", r.problems.map((p) => agentProblem(p, r)), 7000),
    // Bounded: open signals only, one compact row each; resolved history is in losses/failures.
    signals: (r) => ({ ...bounded("problems", r.problems.map((p) => agentProblem(p, r)), 2800), ...bounded("signals", r.signals.filter((s) => s.open).slice(0, 50).map(compact), 4000) }),
    losses: (r) => ({ runnerLosses: r.runnerLosses, massCancels: massCancelRows(r), recentLosses: r.failures.filter((f) => f.class === "runner_loss").slice(0, 10).map((f) => jobRef(f.jobId)) }),
    failures: (r) => ({ failureCounts: r.failureCounts, failureCountsByEvent: r.failureCountsByEvent, ...bounded("failures", failureRows(r), 6500) }),
    reruns: (r) => bounded("reruns", rerunRows(r), 7000),
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
            problems: (found?.problems ?? []).map((problem) => ({ id: problem.id, severity: problem.severity, title: problem.title, since: problem.since, handled: problem.handled, refs: found ? withRefs(problem, found).refs : [] })) };
        })(),
      };
    }),
  });
}
