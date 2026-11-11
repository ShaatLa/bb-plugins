import { z } from "zod";
import { percentile } from "./ci-classify";

const timestamp = z.iso.datetime({ offset: true });
export const ciRunSchema = z.object({
  id: z.number().int().positive(), created_at: timestamp, conclusion: z.string().nullable(),
  workflow_id: z.number().int().positive().optional(), name: z.string().nullable().optional(),
  head_branch: z.string().nullable().optional(), event: z.string().optional(),
  run_attempt: z.number().int().positive().optional(), draftDeferred: z.boolean().optional(),
  run_started_at: timestamp.nullable().optional(), updated_at: timestamp.optional(),
  // Optional so snapshots stored before 0.2.0 still parse; raw GitHub rows carry PR objects, the cache stores plain numbers.
  head_sha: z.string().optional(), display_title: z.string().optional(),
  pull_requests: z.array(z.union([z.number(), z.object({ number: z.number() }).transform((pr) => pr.number)])).optional(),
});
export type Run = z.infer<typeof ciRunSchema>;
const timingSchema = z.object({
  // Missing basis identifies legacy aggregates that must be rebuilt from raw records.
  basis: z.literal("success").optional(),
  count: z.number(), totalMs: z.number(), averageMs: z.number().nullable(),
  medianMs: z.number().nullable(), p95Ms: z.number().nullable(),
});
const countsSchema = z.object({ total: z.number(), passed: z.number(), failed: z.number(), eligible: z.number() });
const alertSchema = z.object({
  kind: z.enum(["main", "streak"]), workflowId: z.number(), name: z.string(), branch: z.string(),
  runId: z.number(), createdAt: timestamp, consecutive: z.number(),
});
export const ciInsightsSchema = z.object({
  draftPolicy: z.literal("job-evidence-v1").optional(),
  total: z.number(), identified: z.number(), defaultBranch: z.string().nullable(),
  main: countsSchema.nullable(), pullRequests: countsSchema,
  alerts: z.array(alertSchema), timing: timingSchema,
  workflows: z.array(countsSchema.extend({ id: z.number(), name: z.string(), timing: timingSchema, failureId: z.number().nullable(),
    /** Per event (pull_request, merge_group, push…), main event first (see rankEvents); optional so stored snapshots still parse. */
    events: z.array(z.object({ event: z.string(), total: z.number(), passed: z.number(), timing: timingSchema })).optional() })),
  slowRuns: z.array(z.object({ id: z.number(), name: z.string(), branch: z.string().nullable(), durationMs: z.number() })),
});
export type CiInsights = z.infer<typeof ciInsightsSchema>;
const excluded = new Set(["cancelled", "skipped"]);
const failures = new Set(["failure", "timed_out", "startup_failure", "action_required", "stale"]);
const isPr = (run: Run) => ["pull_request", "pull_request_target", "pull_request_review"].includes(run.event ?? "");
const identified = (run: Run) => run.workflow_id !== undefined && run.name !== undefined && run.head_branch !== undefined && run.event !== undefined;
function counts(runs: Run[]) {
  return { total: runs.length, passed: runs.filter((run) => run.conclusion === "success").length,
    failed: runs.filter((run) => !run.draftDeferred && failures.has(run.conclusion ?? "")).length,
    eligible: runs.filter((run) => !run.draftDeferred && !excluded.has(run.conclusion ?? "")).length };
}
function duration(run: Run): number | null {
  if (!run.run_started_at || !run.updated_at) return null;
  const start = Date.parse(run.run_started_at), finish = Date.parse(run.updated_at);
  return finish >= start && start >= Date.parse(run.created_at) ? finish - start : null;
}
function timings(runs: Run[]) {
  const values = runs.filter((run) => run.conclusion === "success").map(duration).filter((value): value is number => value !== null).sort((a, b) => a - b);
  const count = values.length, totalMs = values.reduce((sum, value) => sum + value, 0);
  return { basis: "success" as const, count, totalMs, averageMs: count ? totalMs / count : null,
    medianMs: count ? (values[Math.floor((count - 1) / 2)] + values[Math.floor(count / 2)]) / 2 : null,
    p95Ms: count ? values[Math.ceil(count * 0.95) - 1] : null };
}

/**
 * Main event first: the slowest per successful run (the full check) among events holding at least a tenth of the workflow's
 * timed successful runs, so a rare long job (a nightly schedule) never leads; then the rest by the same mean.
 */
const rankEvents = <T extends { event: string }>(list: T[], timed: (item: T) => [count: number, totalMs: number]) => {
  const all = list.reduce((sum, item) => sum + timed(item)[0], 0), mean = (item: T) => { const [count, ms] = timed(item); return count ? ms / count : 0; };
  const major = (item: T) => Number(timed(item)[0] * 10 >= all);
  return list.sort((a, b) => major(b) - major(a) || mean(b) - mean(a) || a.event.localeCompare(b.event));
};
/** Runs grouped by `event`; runs without one are skipped. */
const byEvent = (runs: Run[]) => {
  const groups = new Map<string, Run[]>();
  for (const run of runs) if (run.event) { const list = groups.get(run.event); if (list) list.push(run); else groups.set(run.event, [run]); }
  return [...groups];
};

/** The consecutive failed runs an alert counts, newest first (same grouping and filtering as summarizeCi). */
export function alertStreak(runs: Run[], alert: Pick<CiInsights["alerts"][number], "workflowId" | "branch" | "runId">): Run[] {
  const latest = runs.find((run) => run.id === alert.runId);
  const rows = runs.filter((run) => identified(run) && run.workflow_id === alert.workflowId && run.head_branch === alert.branch && run.id <= alert.runId && (!latest || isPr(run) === isPr(latest)) && !run.draftDeferred && !excluded.has(run.conclusion ?? ""))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
  const streak: Run[] = [];
  for (const run of rows) { if (!failures.has(run.conclusion ?? "")) break; streak.push(run); }
  return streak;
}

export function summarizeCi(runs: Run[], defaultBranch: string | null): CiInsights {
  const known = runs.filter(identified);
  const groups = new Map<number, Run[]>(), branches = new Map<string, Run[]>();
  const ordered = [...known].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
  for (const run of ordered) {
    const workflow = groups.get(run.workflow_id!) ?? [];
    workflow.push(run); groups.set(run.workflow_id!, workflow);
    const key = JSON.stringify([run.workflow_id, run.head_branch, isPr(run)]);
    const branch = branches.get(key) ?? [];
    branch.push(run); branches.set(key, branch);
  }
  const alerts: CiInsights["alerts"] = [];
  for (const rows of branches.values()) {
    const relevant = rows.filter((run) => !run.draftDeferred && !excluded.has(run.conclusion ?? ""));
    const latest = relevant[0];
    if (!latest || !latest.head_branch || !failures.has(latest.conclusion ?? "")) continue;
    let consecutive = 0;
    for (const run of relevant) { if (!failures.has(run.conclusion ?? "")) break; consecutive++; }
    const main = latest.head_branch === defaultBranch && !isPr(latest);
    if (main || consecutive >= 3) alerts.push({
      kind: main ? "main" : "streak", workflowId: latest.workflow_id!, name: latest.name ?? `Workflow ${latest.workflow_id}`,
      branch: latest.head_branch ?? "Unknown branch", runId: latest.id, createdAt: latest.created_at, consecutive,
    });
  }
  alerts.sort((a, b) => Number(b.kind === "main") - Number(a.kind === "main") || b.consecutive - a.consecutive || b.runId - a.runId);
  const workflows = [...groups].map(([id, rows]) => ({ id, name: rows[0].name ?? `Workflow ${id}`,
    ...counts(rows), timing: timings(rows), events: rankEvents(byEvent(rows).map(([event, list]) => ({ event, total: list.length, passed: counts(list).passed, timing: timings(list) })), (row) => [row.timing.count, row.timing.totalMs]), failureId: rows.find((run) => !run.draftDeferred && failures.has(run.conclusion ?? ""))?.id ?? null,
  })).sort((a, b) => b.failed - a.failed || b.total - a.total || a.id - b.id);
  return {
    draftPolicy: "job-evidence-v1", total: runs.length, identified: known.length, defaultBranch,
    main: defaultBranch ? counts(known.filter((run) => run.head_branch === defaultBranch && !isPr(run))) : null,
    pullRequests: counts(known.filter(isPr)), alerts, workflows, timing: timings(runs),
    slowRuns: runs.filter((run) => run.conclusion === "success").flatMap((run) => {
      const durationMs = duration(run);
      return durationMs === null ? [] : [{ id: run.id, name: run.name ?? `Run #${run.id}`, branch: run.head_branch ?? null, durationMs }];
    }).sort((a, b) => b.durationMs - a.durationMs || b.id - a.id).slice(0, 5),
  };
}

/** One bucket of a history chart; `parts` (e.g. additions/deletions) must sum to `value`; `count` is the sample size behind a sample-based value. */
export type TrendPoint = { date: string; value: number | null; parts?: { key: string; value: number }[]; count?: number };
export const RUN_TREND_KEYS = ["durationMedian", "durationP90", "runs", "failedRuns", "startDelay"] as const;
export type RunTrends = Record<typeof RUN_TREND_KEYS[number], TrendPoint[]>;
/** Run-based series of one event within a workflow. */
export type EventTrend = RunTrends & { event: string; total: number; successMs: number };
/** Run-based series of one workflow; `successMs` (total successful-run time) and `total` rank workflows. `events[0]` is the main event. */
export type WorkflowTrend = RunTrends & { id: number; name: string; total: number; successMs: number; events: EventTrend[] };
export type Trends = Partial<RunTrends & Record<"commits" | "lines", TrendPoint[]>> & { workflows?: WorkflowTrend[] };
/** Most workflows kept in a snapshot; the rest are tiny by the ranking below. */
const MAX_TREND_WORKFLOWS = 20;
/** The "main pipeline": the workflow with the most successful-run time (ties: more runs, then lower id). */
export const defaultWorkflow = <T extends { id: number; total: number; successMs: number }>(list: T[]): T | undefined =>
  list.reduce<T | undefined>((best, item) => !best || item.successMs > best.successMs || (item.successMs === best.successMs && (item.total > best.total || (item.total === best.total && item.id < best.id))) ? item : best, undefined);
const middle = (sorted: number[]) => (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.floor(sorted.length / 2)]!) / 2;

/**
 * Per-bucket history series for the switchable charts. Pass `null` for a source that is not loaded yet:
 * its series are then omitted so the client can show a loading state. Counts are real zeros; samples-based
 * series are null (no data) for empty buckets.
 */
export function summarizeTrends(
  runs: Run[] | null, commits: { committedDate: string; additions: number; deletions: number }[] | null,
  bucket: (timestamp: string) => number, emptySeries: () => { date: string }[],
): Trends {
  const dates = emptySeries().map((point) => point.date);
  const cells = <T,>(make: () => T) => dates.map(make);
  const series = (values: (number | null)[]): TrendPoint[] => dates.map((date, index) => ({ date, value: values[index]! }));
  const stat = (lists: number[][], pick: (sorted: number[]) => number): TrendPoint[] => dates.map((date, index) => {
    const list = lists[index]!;
    return list.length ? { date, value: pick([...list].sort((a, b) => a - b)), count: list.length } : { date, value: null };
  });
  const out: Trends = {};
  const runTrends = (list: Run[]): RunTrends => {
    const durations = cells(() => [] as number[]), delays = cells(() => [] as number[]);
    const eligible = cells(() => 0), failed = cells(() => 0);
    for (const run of list) {
      const index = bucket(run.created_at);
      if (index < 0) continue;
      const took = run.conclusion === "success" ? duration(run) : null;
      if (took !== null) durations[index]!.push(took);
      if (!run.draftDeferred && !excluded.has(run.conclusion ?? "")) {
        eligible[index]!++;
        if (run.conclusion !== "success") failed[index]!++;
      }
      // Only the first attempt: a rerun's created_at is the original creation, which would inflate the wait.
      if ((run.run_attempt ?? 1) === 1 && run.run_started_at) {
        const wait = Date.parse(run.run_started_at) - Date.parse(run.created_at);
        if (wait >= 0) delays[index]!.push(wait);
      }
    }
    return { durationMedian: stat(durations, middle), durationP90: stat(durations, (sorted) => percentile(sorted, 90)),
      runs: series(eligible), failedRuns: series(failed), startDelay: stat(delays, middle) };
  };
  if (runs) {
    Object.assign(out, runTrends(runs));
    // Pooled runs are dominated by whichever workflow runs most often, so also keep each workflow apart.
    const byWorkflow = new Map<number, Run[]>();
    for (const run of runs) if (run.workflow_id !== undefined && bucket(run.created_at) >= 0) { const list = byWorkflow.get(run.workflow_id); if (list) list.push(run); else byWorkflow.set(run.workflow_id, [run]); }
    const successMs = (list: Run[]) => list.reduce((sum, run) => sum + (run.conclusion === "success" ? duration(run) ?? 0 : 0), 0);
    out.workflows = [...byWorkflow].map(([id, list]) => ({ id, name: list.find((run) => run.name)?.name ?? `Workflow ${id}`, total: list.length,
      successMs: successMs(list), ...runTrends(list),
      // A workflow can run different things per event (light PR preflight, full merge-queue check): never mix them silently.
      events: rankEvents(byEvent(list).map(([event, rows]): EventTrend => ({ event, total: rows.length, successMs: successMs(rows), ...runTrends(rows) })),
        (row) => [row.durationMedian.reduce((sum, point) => sum + (point.count ?? 0), 0), row.successMs]) }))
      .sort((x, y) => y.successMs - x.successMs || y.total - x.total || x.id - y.id).slice(0, MAX_TREND_WORKFLOWS);
  }
  if (commits) {
    const count = cells(() => 0), added = cells(() => 0), deleted = cells(() => 0);
    for (const commit of commits) {
      const index = bucket(commit.committedDate);
      if (index < 0) continue;
      count[index]!++; added[index]! += commit.additions; deleted[index]! += commit.deletions;
    }
    out.commits = series(count);
    out.lines = dates.map((date, index) => ({ date, value: added[index]! + deleted[index]!, parts: [{ key: "additions", value: added[index]! }, { key: "deletions", value: deleted[index]! }] }));
  }
  return out;
}
