import { classifyDraft } from "./draft-deferrals";
import { expect, test, vi } from "vitest";
import { metricsSchema } from "./metrics";
import { ciInsightsSchema, ciRunSchema, defaultWorkflow, summarizeCi, summarizeTrends } from "./ci-insights";

function run(id: number, overrides: Partial<ReturnType<typeof ciRunSchema.parse>> = {}) {
  return ciRunSchema.parse({ id, created_at: `2026-10-20T${String(id).padStart(2, "0")}:00:00Z`, conclusion: "failure",
    workflow_id: 1, name: "Tests", head_branch: "trunk", event: "push", ...overrides });
}

test("latest failure on the actual default branch clears on a later success across trigger types", () => {
  const rows = [run(1), run(2, { event: "workflow_dispatch", conclusion: "success" }),
    run(3, { workflow_id: 2, name: "Deploy" }), run(4, { workflow_id: 2, conclusion: "cancelled" }),
    run(5, { workflow_id: 2, conclusion: "skipped" }), run(6, { event: "pull_request", workflow_id: 1 })];
  const result = ciInsightsSchema.parse(summarizeCi(rows, "trunk"));
  expect(result.alerts).toEqual([expect.objectContaining({ kind: "main", workflowId: 2, runId: 3, consecutive: 1 })]);
  expect(result.main).toEqual({ total: 5, eligible: 3, passed: 1, failed: 2 });
  expect(result.pullRequests).toEqual({ total: 1, eligible: 1, passed: 0, failed: 1 });
  expect(result.workflows[0]).toMatchObject({ id: 1, failed: 2, failureId: 6 });
});

test("consecutive failures stay within workflow and branch, ignoring skipped and cancelled runs", () => {
  const rows = [run(1, { head_branch: "feature" }), run(2, { head_branch: "feature", conclusion: "timed_out" }),
    run(3, { head_branch: "feature", conclusion: "skipped" }), run(4, { head_branch: "feature" }),
    run(5, { head_branch: "other", conclusion: "success" }), run(6, { head_branch: "feature", workflow_id: 2 })];
  expect(summarizeCi(rows, "trunk").alerts).toEqual([expect.objectContaining({ kind: "streak", workflowId: 1, branch: "feature", consecutive: 3, runId: 4 })]);
  expect(summarizeCi([...rows, run(7, { head_branch: "feature", conclusion: "success" })], "trunk").alerts).toEqual([]);
  expect(summarizeCi([...rows, run(7, { head_branch: "feature", conclusion: null })], "trunk").alerts).toEqual([]);
});

test("timings exclude all non-successful runs, preserve zeroes, omit missing or invalid intervals and compute median and nearest-rank P95", () => {
  const started = "2026-10-20T12:00:00Z";
  const rows = [0, 60, 120, 600].map((seconds, index) => run(index + 1, {
    conclusion: index === 3 ? "cancelled" : "success", run_started_at: started,
    updated_at: new Date(Date.parse(started) + seconds * 1000).toISOString(),
  }));
  rows.push(run(5, { conclusion: "success" }), run(6, { conclusion: "success", run_started_at: started, updated_at: "2026-10-20T11:00:00Z" }));
  for (const [index, conclusion] of ["failure", "skipped", "timed_out", "neutral", null].entries()) rows.push(run(index + 7, {
    conclusion, run_started_at: started, updated_at: "2026-10-20T20:00:00Z",
  }));
  const result = summarizeCi(rows, null);
  expect(result.timing).toEqual({ basis: "success", count: 3, totalMs: 180_000, averageMs: 60_000, medianMs: 60_000, p95Ms: 120_000 });
  expect(result.workflows[0].timing).toEqual(result.timing);
  expect(result.slowRuns.map((row) => row.id)).toEqual([3, 2, 1]);
  expect(result.main).toBeNull();
  expect(summarizeCi(rows.filter((row) => row.conclusion !== "success"), null)).toMatchObject({ timing: { count: 0, averageMs: null, medianMs: null, p95Ms: null }, slowRuns: [] });
});

test("legacy metadata and empty histories never fabricate workflow identity or duration", () => {
  const legacy = ciRunSchema.parse({ id: 1, created_at: "2026-10-20T00:00:00Z", conclusion: "success" });
  const result = summarizeCi([legacy], "main");
  expect(result).toMatchObject({ total: 1, identified: 0, alerts: [], workflows: [], timing: { count: 0, averageMs: null, medianMs: null, p95Ms: null } });
  expect(summarizeCi([run(1, { head_branch: null }), run(2, { head_branch: null }), run(3, { head_branch: null })], null).alerts).toEqual([]);
  expect(summarizeCi([], "main")).toMatchObject({ total: 0, identified: 0, alerts: [], timing: { count: 0 } });
});


test("only complete job evidence for an isolated draft rejection is deferred", async () => {
  const candidate = run(1, { name: "CI", event: "pull_request", run_attempt: 2 }), rules = { workflow: "CI", job: "CI summary", step: "Draft gate" };
  const gate = { id: 1, name: "CI summary", conclusion: "failure", steps: [{ name: "Draft gate", conclusion: "failure" }] };
  const request = vi.fn(async () => ({ body: { total_count: 1, jobs: [gate] }, hasNext: false }));
  expect(await classifyDraft(candidate, "acme/widgets", request, rules)).toBe(true);
  expect(request.mock.calls[0]).toEqual(["/repos/acme/widgets/actions/runs/1/attempts/2/jobs?filter=latest&per_page=100&page=1"]);
  for (const jobs of [[{ ...gate, steps: [{ name: "Verify", conclusion: "failure" }] }], [gate, { ...gate, id: 2, name: "Tests" }]]) {
    expect(await classifyDraft(candidate, "acme/widgets", async () => ({ body: { total_count: jobs.length, jobs }, hasNext: false }), rules)).toBe(false);
  }
  expect(await classifyDraft(candidate, "acme/widgets", request, { ...rules, step: "" })).toBe(false); // a blank name disables the rule
  expect(request).toHaveBeenCalledTimes(1);
  await expect(classifyDraft(candidate, "acme/widgets", async () => ({ body: { total_count: 2, jobs: [gate] }, hasNext: false }), rules)).rejects.toThrow("Incomplete");
  expect(await classifyDraft({ ...candidate, event: "push" }, "acme/widgets", request, rules)).toBe(false);
  const rows = [run(1, { conclusion: "success" }), run(2, { draftDeferred: true }), run(3), run(4, { draftDeferred: true })];
  expect(summarizeCi(rows, "trunk")).toMatchObject({ main: { eligible: 2, failed: 1 }, workflows: [{ failed: 1, failureId: 3 }], alerts: [{ consecutive: 1, runId: 3 }] });
});

test("trends summarize durations, counts, start delay and commits per bucket", () => {
  const start = Date.parse("2026-10-20T00:00:00Z");
  const empty = () => [0, 1, 2].map((i) => ({ date: new Date(start + (i + 1) * 3_600_000).toISOString(), value: 0 }));
  const bucket = (timestamp: string) => { const t = Date.parse(timestamp) - start; return t < 0 || t > 3 * 3_600_000 ? -1 : Math.min(2, Math.floor(t / 3_600_000)); };
  const at = (minutes: number) => new Date(start + minutes * 60_000).toISOString();
  const timed = (id: number, created: number, begun: number, finished: number, overrides = {}) =>
    run(id, { created_at: at(created), run_started_at: at(begun), updated_at: at(finished), conclusion: "success", ...overrides });
  const runs = [
    timed(1, 0, 1, 11), timed(2, 5, 5, 35), timed(3, 10, 12, 22), timed(4, 15, 16, 20, { conclusion: "failure" }),
    timed(5, 20, 20, 21, { conclusion: "cancelled" }), timed(6, 25, 26, 27, { draftDeferred: true, conclusion: "failure" }),
    // A rerun keeps the original created_at, so its start delay must not count.
    timed(7, 30, 50, 55, { run_attempt: 2 }),
    timed(8, 61, 61, 62, { conclusion: null }),
    timed(9, 200, 201, 202), // outside every bucket
  ];
  const commits = [{ committedDate: at(5), additions: 10, deletions: 2 }, { committedDate: at(10), additions: 5, deletions: 0 }, { committedDate: at(130), additions: 0, deletions: 7 }, { committedDate: at(500), additions: 99, deletions: 99 }];
  const trends = summarizeTrends(runs, commits, bucket, empty);
  const values = (name: Exclude<keyof typeof trends, "workflows">) => trends[name]!.map((point) => point.value);
  // Bucket 0 successful durations (min): 10, 30, 10 and the rerun's 5 → median 10, nearest-rank p90 30.
  expect(values("durationMedian")).toEqual([10 * 60_000, null, null]);
  expect(values("durationP90")).toEqual([30 * 60_000, null, null]);
  // Cancelled and deferred-draft runs are not counted; a null conclusion counts as a failure.
  expect(values("runs")).toEqual([5, 1, 0]);
  expect(values("failedRuns")).toEqual([1, 1, 0]);
  // First attempts only (0,0,1,1,1,2 min in bucket 0); a zero wait is a real value.
  expect(values("startDelay")).toEqual([60_000, 0, null]);
  expect(values("commits")).toEqual([2, 0, 1]);
  expect(values("lines")).toEqual([17, 0, 7]);
  expect(trends.lines![0]!.parts).toEqual([{ key: "additions", value: 15 }, { key: "deletions", value: 2 }]);
  expect(trends.durationMedian!.map((point) => point.date)).toEqual(empty().map((point) => point.date));
  // A source that has not loaded yet is omitted, not zero-filled.
  expect(Object.keys(summarizeTrends(null, commits, bucket, empty)).sort()).toEqual(["commits", "lines"]);
  expect(Object.keys(summarizeTrends(runs, null, bucket, empty)).sort()).toEqual(["durationMedian", "durationP90", "failedRuns", "runs", "startDelay", "workflows"]);
});

test("trends are also kept per workflow and the longest-running workflow is the default", () => {
  const start = Date.parse("2026-10-20T00:00:00Z");
  const empty = () => [0, 1].map((i) => ({ date: new Date(start + (i + 1) * 3_600_000).toISOString(), value: 0 }));
  const bucket = (timestamp: string) => { const t = Date.parse(timestamp) - start; return t < 0 || t > 2 * 3_600_000 ? -1 : Math.min(1, Math.floor(t / 3_600_000)); };
  const at = (minutes: number) => new Date(start + minutes * 60_000).toISOString();
  const timed = (id: number, workflow: number, name: string, created: number, minutes: number, overrides = {}) =>
    run(id, { workflow_id: workflow, name, created_at: at(created), run_started_at: at(created), updated_at: at(created + minutes), conclusion: "success", ...overrides });
  const runs = [
    // Workflow 7: many tiny runs. Workflow 3: few long runs, so it has the most successful-run time.
    ...[1, 2, 3, 4, 5].map((id) => timed(id, 7, "Bookkeeping", id, 0.1)),
    timed(10, 3, "Pipeline", 10, 30), timed(11, 3, "Pipeline", 20, 20, { conclusion: "failure" }), timed(12, 3, "Pipeline", 70, 40),
    timed(13, 9, "Outside", 500, 5), { ...timed(14, 3, "Pipeline", 5, 5), workflow_id: undefined },
  ];
  const trends = summarizeTrends(runs, null, bucket, empty);
  expect(trends.workflows!.map(({ id, name, total }) => [id, name, total])).toEqual([[3, "Pipeline", 3], [7, "Bookkeeping", 5]]);
  const [pipeline, bookkeeping] = trends.workflows!;
  expect(pipeline!.durationMedian.map((point) => point.value)).toEqual([30 * 60_000, 40 * 60_000]);
  expect(pipeline!.runs.map((point) => point.value)).toEqual([2, 1]);
  expect(pipeline!.failedRuns.map((point) => point.value)).toEqual([1, 0]);
  expect(bookkeeping!.durationMedian.map((point) => point.value)).toEqual([6000, null]);
  // The pooled series still covers every run (including the one without a workflow id), so it is dominated by the tiny runs.
  expect(trends.runs!.map((point) => point.value)).toEqual([8, 1]);
  expect(trends.durationMedian![0]!.value).toBe(6000);
  expect(defaultWorkflow(trends.workflows!)!.id).toBe(3);
  expect(defaultWorkflow([])).toBeUndefined();
  // Ties on successful time fall back to the busier workflow, then the lower id.
  expect(defaultWorkflow([{ id: 2, total: 1, successMs: 0 }, { id: 5, total: 4, successMs: 0 }, { id: 4, total: 4, successMs: 0 }])!.id).toBe(4);
});

test("one workflow is split per event: trends and timings are kept apart, the busiest event leads and points carry their sample size", () => {
  const start = Date.parse("2026-10-20T00:00:00Z");
  const empty = () => [0, 1].map((i) => ({ date: new Date(start + (i + 1) * 86_400_000).toISOString(), value: 0 }));
  const bucket = (timestamp: string) => { const t = Date.parse(timestamp) - start; return t < 0 || t >= 2 * 86_400_000 ? -1 : Math.floor(t / 86_400_000); };
  const at = (minutes: number) => new Date(start + minutes * 60_000).toISOString();
  const timed = (id: number, event: string | undefined, created: number, minutes: number, overrides = {}) =>
    run(id, { event, name: "CI", created_at: at(created), run_started_at: at(created), updated_at: at(created + minutes), conclusion: "success", ...overrides });
  const runs = [
    // pull_request: light runs; merge_group: fewer full runs, the slowest per run, so it leads.
    ...[1, 2, 3, 4].map((id) => timed(id, "pull_request", id, 7)), timed(5, "pull_request", 10, 7, { conclusion: "failure" }),
    timed(6, "merge_group", 20, 30), timed(7, "merge_group", 30, 32), timed(8, "merge_group", 1500, 28),
    timed(9, "push", 40, 2), timed(10, undefined, 50, 99),
  ];
  const trends = summarizeTrends(runs, null, bucket, empty);
  const [workflow] = trends.workflows!;
  expect(workflow!.events.map(({ event, total, successMs }) => [event, total, successMs / 60_000])).toEqual([["merge_group", 3, 90], ["pull_request", 5, 28], ["push", 1, 2]]);
  const [queue, preflight] = workflow!.events;
  expect(queue!.durationMedian.map((point) => [point.value, point.count])).toEqual([[31 * 60_000, 2], [28 * 60_000, 1]]);
  expect(preflight!.durationMedian.map((point) => [point.value, point.count])).toEqual([[7 * 60_000, 4], [null, undefined]]);
  expect(preflight!.runs.map((point) => point.value)).toEqual([5, 0]);
  expect(preflight!.failedRuns.map((point) => point.value)).toEqual([1, 0]);
  // The workflow series pools the events, runs without an event included; counts follow the sample.
  expect(workflow!.durationMedian[0]).toMatchObject({ value: 7 * 60_000, count: 8 });
  expect(workflow!.durationP90[0]!.count).toBe(8);
  expect(workflow!.startDelay[0]).toMatchObject({ value: 0, count: 9 });
  expect(workflow!.runs[0]!.count).toBeUndefined();
  // Many light pull_request runs outweigh the queue in total time, yet the full check still leads;
  // a rare long schedule run (under a tenth of the timed runs) never does. Equal means: the event name.
  const mix = [...Array.from({ length: 30 }, (_, i) => timed(100 + i, "pull_request", i, 7)), ...[200, 201, 202, 203, 204].map((id) => timed(id, "merge_group", id - 160, 30)),
    timed(205, "schedule", 46, 120), timed(206, "a", 47, 7)];
  expect(summarizeTrends(mix, null, bucket, empty).workflows![0]!.events.map((entry) => entry.event)).toEqual(["merge_group", "pull_request", "schedule", "a"]);
  expect(summarizeCi(mix, "trunk").workflows[0]!.events!.map((entry) => entry.event)).toEqual(["merge_group", "pull_request", "schedule", "a"]);

  const insights = ciInsightsSchema.parse(summarizeCi(runs, "trunk"));
  expect(insights.workflows[0]!.events!.map(({ event, total, passed, timing }) => [event, total, passed, timing.count, timing.medianMs! / 60_000])).toEqual([
    ["merge_group", 3, 3, 3, 30], ["pull_request", 5, 4, 4, 7], ["push", 1, 1, 1, 2]]);
  expect(insights.workflows[0]!.timing.count).toBe(8); // a run without an event is not identified, so it is not summarized
});

test("snapshots stored before per-event series and sample counts still parse", () => {
  const point = { date: "2026-10-21T00:00:00.000Z", value: 60_000 };
  const series = [point, { ...point, value: null }];
  const trends = metricsSchema.shape.trends.parse({ durationMedian: series, workflows: [{ id: 1, name: "CI", total: 2, successMs: 60_000, durationMedian: series, durationP90: series, runs: series, failedRuns: series, startDelay: series }] });
  expect(trends!.workflows![0]!.events).toBeUndefined();
  expect(trends!.durationMedian![0]).not.toHaveProperty("count");
  expect(metricsSchema.shape.trends.parse({ durationMedian: [{ ...point, count: 3 }] })!.durationMedian![0]!.count).toBe(3);
  const timing = { basis: "success", count: 1, totalMs: 1, averageMs: 1, medianMs: 1, p95Ms: 1 };
  const counts = { total: 1, passed: 1, failed: 0, eligible: 1 };
  const legacy = { total: 1, identified: 1, defaultBranch: null, main: null, pullRequests: counts, alerts: [], timing, slowRuns: [], workflows: [{ ...counts, id: 1, name: "CI", timing, failureId: null }] };
  expect(ciInsightsSchema.parse(legacy).workflows[0]!.events).toBeUndefined();
});
