import { classifyDraft } from "./draft-deferrals";
import { expect, test, vi } from "vitest";
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
  const candidate = run(1, { name: "CI", event: "pull_request", run_attempt: 2 });
  const gate = { id: 1, name: "CI complete", conclusion: "failure", steps: [{ name: "Reject draft pull request", conclusion: "failure" }] };
  const request = vi.fn(async () => ({ body: { total_count: 1, jobs: [gate] }, hasNext: false }));
  expect(await classifyDraft(candidate, "acme/widgets", request)).toBe(true);
  expect(request.mock.calls[0]).toEqual(["/repos/acme/widgets/actions/runs/1/attempts/2/jobs?filter=latest&per_page=100&page=1"]);
  for (const jobs of [[{ ...gate, steps: [{ name: "Verify", conclusion: "failure" }] }], [gate, { ...gate, id: 2, name: "Tests" }]]) {
    expect(await classifyDraft(candidate, "acme/widgets", async () => ({ body: { total_count: jobs.length, jobs }, hasNext: false }))).toBe(false);
  }
  await expect(classifyDraft(candidate, "acme/widgets", async () => ({ body: { total_count: 2, jobs: [gate] }, hasNext: false }))).rejects.toThrow("Incomplete");
  expect(await classifyDraft({ ...candidate, event: "push" }, "acme/widgets", request)).toBe(false);
  const rows = [run(1, { conclusion: "success" }), run(2, { draftDeferred: true }), run(3), run(4, { draftDeferred: true })];
  expect(summarizeCi(rows, "trunk")).toMatchObject({ main: { eligible: 2, failed: 1 }, workflows: [{ failed: 1, failureId: 3 }], alerts: [{ consecutive: 1, runId: 3 }] });
});
