import { expect, test } from "vitest";
import { ciInsightsSchema, ciRunSchema, summarizeCi } from "./ci-insights";

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

test("timings include cancelled runs, preserve zeroes, omit missing or invalid intervals and compute median and nearest-rank P95", () => {
  const started = "2026-10-20T12:00:00Z";
  const rows = [0, 60, 120, 600].map((seconds, index) => run(index + 1, {
    conclusion: index === 3 ? "cancelled" : "success", run_started_at: started,
    updated_at: new Date(Date.parse(started) + seconds * 1000).toISOString(),
  }));
  rows.push(run(5), run(6, { run_started_at: started, updated_at: "2026-10-20T11:00:00Z" }));
  const result = summarizeCi(rows, null);
  expect(result.timing).toEqual({ count: 4, totalMs: 780_000, averageMs: 195_000, medianMs: 90_000, p95Ms: 600_000 });
  expect(result.workflows[0].timing).toEqual(result.timing);
  expect(result.slowRuns.map((row) => row.id)).toEqual([4, 3, 2, 1]);
  expect(result.main).toBeNull();
});

test("legacy metadata and empty histories never fabricate workflow identity or duration", () => {
  const legacy = ciRunSchema.parse({ id: 1, created_at: "2026-10-20T00:00:00Z", conclusion: "success" });
  const result = summarizeCi([legacy], "main");
  expect(result).toMatchObject({ total: 1, identified: 0, alerts: [], workflows: [], timing: { count: 0, averageMs: null, medianMs: null, p95Ms: null } });
  expect(summarizeCi([run(1, { head_branch: null }), run(2, { head_branch: null }), run(3, { head_branch: null })], null).alerts).toEqual([]);
  expect(summarizeCi([], "main")).toMatchObject({ total: 0, identified: 0, alerts: [], timing: { count: 0 } });
});
