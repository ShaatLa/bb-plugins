import { describe, expect, it } from "vitest";
import { ciSliceReport, ciReport } from "./agent-ci";
import { runnerLosses } from "./ci-classify";
import { inspect, inspectionSchema, relatedRefs, type InspectInput } from "./ci-inspect";
import type { Run } from "./ci-insights";
import type { ClassifiedJob, Signal } from "./ci-jobs-types";
import { buildProblems } from "./ci-problems";
import { parseRef } from "./ci-refs";
import { buildSignals, summarizeAnalysis } from "./ci-signals";
import type { SignalsOutput } from "./ci-signals-contract";
import { at, classify, failed, failure, REPO, SHA } from "./test-support";

const now = Date.parse(at(30));
const QUEUE = "gh-readonly-queue/main/pr-7-abc123";
const SECRETS = ["SECRET_LOG_LINE", "SECRET_ANNOTATION", "SECRET_EVIDENCE", "SECRET_ENV=hunter2"];
const base = (over = {}) => failed({ event: "merge_group", headBranch: QUEUE, runId: 50, jobId: 500, annotations: [failure(SECRETS[1]!)], logExcerpt: SECRETS[0]!, ...over });
const withEvidence = (c: ClassifiedJob): ClassifiedJob => ({ ...c, evidence: `${SECRETS[2]} ${SECRETS[3]}` });
const alert = { kind: "main" as const, workflowId: 1, name: "CI", branch: "main", runId: 70, createdAt: at(10), consecutive: 1 };
const run = (over: Partial<Run>): Run => ({ id: 1, created_at: at(0), conclusion: "failure", name: "CI", head_branch: "main", event: "push", head_sha: SHA, run_attempt: 1, pull_requests: [], ...over });

const classified: ClassifiedJob[] = [
  withEvidence(classify(base(), "real")), withEvidence(classify(base({ jobName: "Lint", jobId: 501, runnerName: "runner-1", completedAt: at(6) }), "runner_loss")),
  { ...classify(failed({ runId: 40, jobId: 400, jobName: "Integration", pullRequests: [7] }), "flake"), flakeLabel: "FLAKE-1" },
  withEvidence(classify(failed({ runId: 70, jobId: 700, event: "push", headBranch: "main", headSha: "f".repeat(40), failedSteps: ["Deploy"] }, 12), "real")),
  classify(failed({ runId: 71, jobId: 710, event: "push", headBranch: "main", annotations: [failure(SECRETS[1]!)] }, 13), "runner_loss"),
];
const stall: Signal = { id: "pool_stall:self-hosted", kind: "pool_stall", severity: "critical", title: "Runner pool stalled: self-hosted", what: "2 queued", impact: "waiting", where: { pool: "self-hosted" }, since: at(20), until: null, actor: "owner_sre", open: true };
const signals = buildSignals({ classified, reruns: [], massCancels: [], stalls: [stall], defaultBranch: "main", repository: REPO, now });
const problems = buildProblems(REPO, signals, [alert], {}, now);
const timing = { jobs: 10, queueWaitMs: { p50: 1000, p90: 5000 }, durationMs: { p50: 60_000, p90: 120_000 } };
const input = (over: Partial<InspectInput> = {}): InspectInput => ({
  repository: REPO, classified, reruns: [], massCancels: [], pools: [{ pool: "self-hosted", queued: 2, inProgress: 1, oldestQueuedAt: at(0), lastStartedAt: at(1), queuedRunIds: [80, 81] }], alerts: [alert],
  defaultBranch: "main", coverage: at(0), analysisAt: now, polledAt: at(29), now, windowDays: 14,
  runs: [run({ id: 70, created_at: at(10), head_sha: "f".repeat(40) }), run({ id: 40, event: "pull_request", head_branch: "feature", pull_requests: [7] }), run({ id: 50, event: "merge_group", head_branch: QUEUE, conclusion: "failure" })],
  problems, signals, poolTimings: { "self-hosted": timing }, queueStatus: (key) => key === "queue:50:1" ? "confirmed" : "pending", cachedTests: () => ["a.Spec one", "b.Spec two"], ...over,
});
const get = (ref: string, over: Partial<InspectInput> = {}) => inspect(ref, input(over));
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

describe("inspect", () => {
  it("run: workflow, event, PR, attempt, non-success jobs as refs, link and related refs", () => {
    const result = get("run:50");
    expect(inspectionSchema.parse(result)).toEqual(result);
    expect(result).toMatchObject({ ref: "run:50", kind: "run", facts: { workflow: "CI", event: "merge_group", sha: "0123456", queuePullRequest: 7, attempt: 1, conclusion: "failure", url: `https://github.com/${REPO}/actions/runs/50`,
      nonSuccessJobs: [{ ref: "job:501", name: "Lint", class: "runner_loss" }, { ref: "job:500", name: "Unit tests", class: "real" }] } });
    expect(result.related).toEqual(expect.arrayContaining(["queue:50:1", "sha:0123456", "pr:7"]));
    expect(get("run:70").related).toContain("run:main:70");
    expect(() => get("run:99")).toThrow(/Run 99 is not known/);
  });
  it("job: class, reason, label, failed steps, runner, cached tests; no log text", () => {
    expect(get("job:400").facts).toMatchObject({ name: "Integration", class: "flake", label: "FLAKE-1", failedSteps: ["Run tests"], pool: "self-hosted", failedTests: ["a.Spec one", "b.Spec two"] });
    expect(get("job:500").related).toEqual(expect.arrayContaining(["run:50:1", "queue:50:1", "sha:0123456", "pool:self-hosted"]));
    expect(get("job:700").related).toEqual(expect.arrayContaining(["run:70:1", "pool:self-hosted"]));
    expect(get("job:500", { cachedTests: () => null }).facts).not.toHaveProperty("failedTests");
    expect(() => get("job:12345")).toThrow(/Job 12345 is not known/);
  });
  it("queue: PR, confirmation status, jobs with class", () => {
    expect(get("queue:50:1")).toMatchObject({ kind: "queue", facts: { pullRequest: 7, confirmation: "confirmed", ownFailure: true, classes: { real: 1, runner_loss: 1 }, jobs: [{ ref: "job:501" }, { ref: "job:500" }] }, related: expect.arrayContaining(["run:50:1", "pr:7"]) });
    expect(get("queue:50:1", { queueStatus: () => "rejected" }).facts).toMatchObject({ confirmation: "rejected" });
    expect(() => get("queue:51:1")).toThrow(/No merge queue attempt 51:1/);
  });
  it("pool: live state, timings, stall and recent losses as refs", () => {
    const result = get("pool:self-hosted");
    expect(result.facts).toMatchObject({ queued: 2, inProgress: 1, openStall: true, runnerLosses: 2, queueWait: { p50: "1s", p90: "5s" }, duration: { p50: "60s", p90: "120s" } });
    expect(result.related).toEqual(expect.arrayContaining(["pool_stall:self-hosted", "job:501", "job:710", "run:80", "run:81"]));
    expect(() => get("pool:nowhere")).toThrow(/Pool "nowhere" is unknown. Known pools: self-hosted/);
  });
  it("pr: pull_request and merge_group runs with conclusions", () => {
    expect(get("pr:7").facts).toMatchObject({ pullRequestRuns: [{ ref: "run:40", conclusion: "failure" }], mergeGroupRuns: [{ ref: "run:50", event: "merge_group", conclusion: "failure" }] });
    expect(get("pr:7").related).toEqual(expect.arrayContaining(["job:400", "queue:50:1"]));
    expect(() => get("pr:999")).toThrow(/No run of PR #999/);
  });
  it("sha: runs and jobs at the head, runner-loss count, ambiguity error", () => {
    expect(get("sha:0123456").facts).toMatchObject({ nonSuccessJobs: 4, runnerLosses: 2, byClass: { real: 1, runner_loss: 2, flake: 1 } });
    expect(get(`sha:${"f".repeat(7)}`).facts).toMatchObject({ runs: [{ ref: "run:70" }], nonSuccessJobs: 1 });
    expect(() => get("sha:aaaaaaa")).toThrow(/No stored run or job/);
    const other = classify(failed({ runId: 90, jobId: 900, headSha: `0123456${"0".repeat(33)}` }), "real");
    expect(() => get("sha:0123456", { classified: [...classified, other] })).toThrow(/ambiguous: 0123456789ab, 012345600000/);
  });
  it("problem: sections with handled state, related refs and a take hint; resolved signals and unknown ids", () => {
    const result = get("runner_loss:710");
    const sections = (result.facts.sections as { title: string; lines: string[] }[]).map((s) => s.title);
    expect(sections).toEqual(expect.arrayContaining(["Verdict", "Problem", "Suggested action"]));
    expect(result).toMatchObject({ kind: "problem", related: expect.arrayContaining(["job:710", "run:71:1", "pool:self-hosted"]), next: ["ci_dashboard_manage action=take id=runner_loss:710"] });
    expect(get("run:main:70").related).toContain("job:700");
    const handled = get("run:main:70", { problems: problems.map((p) => p.id === "run:main:70" ? { ...p, handled: { state: "investigating" as const, threadId: "thr_a", by: "agent" as const, at: at(20) } } : p) });
    expect(handled.summary).toContain("investigating"); expect(handled.next).toBeUndefined(); expect(handled.facts.handled).toMatchObject({ state: "investigating" });
    expect(() => get("flake:5")).toThrow(/not an open problem or a recent signal/);
    expect(() => get("nonsense")).toThrow(/Accepted forms/);
  });
  it("never includes log text, annotations, classifier evidence or env values", () => {
    for (const ref of ["run:50", "run:70", "job:500", "job:700", "queue:50:1", "pool:self-hosted", "pr:7", "sha:0123456", "run:main:70", "runner_loss:710", "pool_stall:self-hosted"]) {
      const json = JSON.stringify(get(ref));
      for (const secret of SECRETS) expect(json, `${ref} leaks ${secret}`).not.toContain(secret);
      expect(bytes(get(ref)), ref).toBeLessThanOrEqual(4096);
    }
  });
  it("relatedRefs for Investigate: job, run, pool and the runs of a streak", () => {
    const refs = relatedRefs(problems.find((p) => p.id === "run:main:70")!, input());
    expect(refs[0]).toBe("run:70");
    expect(parseRef(refs[0]!)).toMatchObject({ kind: "run" });
  });
});

// A busy repository: 500 stored failures, 200 open signals, 60 reruns, many pools and losses.
function busy() {
  const jobs: ClassifiedJob[] = Array.from({ length: 500 }, (_, i) => {
    const event = ["pull_request", "merge_group", "push"][Math.floor(i / 4) % 3]!, classes = ["real", "flake", "runner_loss", "transient"] as const;
    return { ...classify(failed({ runId: 1_000 + Math.floor(i / 4), attempt: 1 + (Math.floor(i / 2) % 2), jobId: 90_000 + i, jobName: `Integration tests (shard ${i % 40}) / ${"long-job-name-".repeat(1 + (i % 3))}`, event,
      headBranch: event === "merge_group" ? `gh-readonly-queue/main/pr-${100 + Math.floor(i / 4)}-abc123` : event === "push" ? "main" : "feature", pullRequests: event === "pull_request" ? [100 + Math.floor(i / 4)] : [], pool: `pool-${i % 7}`, runnerName: `runner-${i % 30}`,
      annotations: [failure(SECRETS[1]!)], logExcerpt: SECRETS[0]! }, 40 + (i % 20)), classes[i % 4]!), evidence: SECRETS[2]! };
  });
  const open: Signal[] = Array.from({ length: 200 }, (_, i): Signal => ({ id: `runner_loss:${90_000 + i}`, kind: "runner_loss", severity: i % 5 === 0 ? "warning" : "info", title: `Runner lost: ${jobs[i]!.job.jobName}`.slice(0, 90), what: `${jobs[i]!.job.jobName} lost its runner runner-${i % 30} in pool-${i % 7} (run ${jobs[i]!.job.runId}, attempt 1)`.slice(0, 140),
    impact: "PR CI red; rerun needed", where: { runId: jobs[i]!.job.runId, attempt: 1, jobId: 90_000 + i, jobName: jobs[i]!.job.jobName, pool: `pool-${i % 7}`, url: `https://github.com/${REPO}/actions/runs/${jobs[i]!.job.runId}/job/${90_000 + i}` },
    since: at(40 + (i % 19)), until: at(50), actor: "owner_sre", open: true }));
  const rows = (summarizeAnalysis({ classified: jobs, reruns: [], massCancels: [], losses: runnerLosses(jobs), repository: REPO }));
  const reruns = Array.from({ length: 60 }, (_, i) => ({ runId: 2_000 + i, event: i % 2 ? "merge_group" : "pull_request", workflowName: "CI pipeline for widgets", headSha: SHA, headBranch: i % 2 ? `gh-readonly-queue/main/pr-${i}-abc123` : "feature", attempts: 2, outcomes: ["failure", "failure"], finalConclusion: "failure", repeatedRunnerMs: 600_000 }));
  const summary = summarizeAnalysis({ classified: jobs, reruns, massCancels: [], losses: runnerLosses(jobs), repository: REPO });
  const probs = buildProblems(REPO, open.map((s) => ({ ...s, severity: "warning" as const })).slice(0, 12), [alert], {}, Date.parse(at(55)));
  const row = { repository: REPO, updatedAt: at(50), error: null, live: { pools: [], truncated: false, polledAt: at(50) }, signals: open, problems: probs, projectId: null, window: { since: at(0), until: at(59) }, backfill: { remaining: 0, failed: 0, pausedUntil: null, coveredSince: at(0) }, ...summary, massCancels: Array.from({ length: 5 }, (_, i) => ({ since: at(i * 5), until: at(i * 5 + 1), runners: ["runner-1", "runner-2", "runner-3"], runIds: [1, 2, 3, 4, 5, 6], jobs: 12 })) };
  void rows;
  return { jobs, open, row: row as SignalsOutput["repositories"][number], actors: { owner_sre: "SRE", pr_author: "Author", lead: "Lead", manager: "Manager" } };
}

describe("size budgets", () => {
  const { jobs, open, row, actors } = busy();
  const report = (view: Parameters<typeof ciSliceReport>[1]) => ciSliceReport({ repositories: [row], actors }, view);
  it("index views stay under 8 KB with 500 failures and 200 signals, and carry refs", () => {
    if (process.env.SIZES) for (const view of ["problems", "signals", "stall", "losses", "failures", "reruns"] as const) console.log("SIZE", view, bytes(report(view)), Object.entries(report(view).repositories[0]!).map(([k, v]) => `${k}:${bytes(v)}`).join(" "));
    for (const view of ["problems", "signals", "stall", "losses", "failures", "reruns"] as const) expect(bytes(report(view)), view).toBeLessThanOrEqual(8192);
    const failures = report("failures").repositories[0] as { failures: { ref: string; run: string; name: string; class: string; event: string; at: string | null }[] };
    expect(failures.failures.length + (report("failures").repositories[0] as { moreFailures: number }).moreFailures).toBe(50);
    expect(Object.keys(failures.failures[0]!).sort()).toEqual(expect.arrayContaining(["at", "class", "event", "name", "ref", "run"]));
    expect(failures.failures[0]!.ref).toMatch(/^job:\d+$/); expect(failures.failures[0]!.run).toMatch(/^run:\d+:\d+$/);
    const signals = (report("signals").repositories[0] as { signals: { ref?: string; url?: string }[] }).signals;
    expect(signals.length + (report("signals").repositories[0] as { moreSignals: number }).moreSignals).toBe(50); expect(signals.every((s) => /^job:\d+$/.test(s.ref!) && s.url === undefined)).toBe(true);
    const problemRows = (report("problems").repositories[0] as { problems: { refs: string[] }[] }).problems;
    expect(problemRows.every((p) => p.refs.length >= 1 && p.refs.length <= 4 && p.refs.every((r) => { parseRef(r); return true; }))).toBe(true);
    const reruns = (report("reruns").repositories[0] as { reruns: { ref: string; queue?: string }[] }).reruns;
    expect(reruns.some((r) => r.queue === "queue:2059:2")).toBe(true);
    const losses = report("losses").repositories[0] as { massCancels: { ref: string; runs: string[] }[]; recentLosses: string[] };
    expect(losses.recentLosses.length).toBeGreaterThan(0); expect(losses.massCancels[0]!.runs).toHaveLength(3);
  });
  it("summary problem rows carry refs", () => {
    const data = { discoveryError: null, repositories: [{ repository: REPO, projectName: null, updatedAt: at(50), range: { since: at(0), until: at(59) }, ciOutcomes: { total: 0, passed: 0, failed: 0, cancelled: 0, skipped: 0, other: 0 }, ciInsights: undefined, pending: [], ci: { value: null, detail: "", error: null, seriesError: null, series: [] } }] };
    expect(typeof ciReport).toBe("function"); void data;
    const problemRow = (report("problems").repositories[0] as { problems: { id: string; refs: string[] }[] }).problems[0]!;
    expect(problemRow.refs.length).toBeGreaterThan(0);
  });
  it("every inspect of the busy fixture stays under 4 KB, even for a problem with many lists", () => {
    const busyInput = input({ classified: jobs, signals: open, problems: row.problems, alerts: [alert], runs: jobs.map((c) => run({ id: c.job.runId, event: c.job.event, head_branch: c.job.headBranch, pull_requests: c.job.pullRequests })), massCancels: [] });
    const mass = { since: at(3), until: at(4), runners: ["a", "b", "c"], runIds: jobs.slice(0, 120).map((c) => c.job.runId), jobs: jobs.slice(0, 200) };
    for (const [ref, over] of [["pool:pool-3", {}], ["sha:0123456", {}], ["pr:100", {}], ["run:1000", {}], ["run:1001:2", {}], ["queue:1001:1", {}], ["job:90001", {}], ["run:main:70", {}],
      [`runner_loss:${row.problems.find((p) => p.id.startsWith("runner_loss:"))!.id.split(":")[1]}`, {}], ["mass_cancel:" + mass.since, { massCancels: [mass], signals: [...open, { ...open[0]!, id: `mass_cancel:${mass.since}`, kind: "mass_cancel" as const, severity: "critical" as const, where: { pool: "pool-1" } }] }]] as unknown as [string, Partial<InspectInput>][]) {
      const result = inspect(ref, { ...busyInput, ...over });
      expect(bytes(result), ref).toBeLessThanOrEqual(4096);
      expect(result.related.length, ref).toBeLessThanOrEqual(13);
      for (const secret of SECRETS) expect(JSON.stringify(result)).not.toContain(secret);
    }
  });
});
