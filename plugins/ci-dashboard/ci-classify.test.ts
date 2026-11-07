import { describe, expect, it } from "vitest";
import { classifyJobs, detectMassCancel, percentile, queueOnlyJobs, queuePullRequest, runnerLosses, summarizeReruns, summarizeTimings, timingSamples } from "./ci-classify";
import type { FailureClass, JobRecord } from "./ci-jobs-types";
import { at, classify, failed, failure, job, LOSS, MANUAL, SUPERSEDED, TIMEOUT } from "./test-support";

const one = (j: JobRecord, opts?: Parameters<typeof classifyJobs>[1]) => classifyJobs([j], opts)[0];
const cancelled = (message?: string, over: Partial<JobRecord> = {}) => failed({ conclusion: "cancelled", failedSteps: [], annotations: message ? [failure(message)] : [], ...over });

describe("classifyJobs", () => {
  it.each<[string, JobRecord, FailureClass]>([
    ["runner shutdown annotation", failed({ annotations: [failure(LOSS)] }), "runner_loss"],
    ["lost communication annotation", failed({ annotations: [failure("The self-hosted runner lost communication with the server.")] }), "runner_loss"],
    ["failure without a failed step or annotation", failed({ failedSteps: [], annotations: [] }), "runner_loss"],
    ["maximum execution time", cancelled(TIMEOUT), "timeout"],
    ["concurrency cancel", cancelled(SUPERSEDED), "superseded"],
    ["cancel by a user", cancelled(MANUAL), "manual_cancel"],
    ["cancel with noise annotations only", cancelled("No files were found with the provided path"), "collateral_cancel"],
    ["cancel that never started (no annotations)", cancelled(), "collateral_cancel"],
    ["failure with an unrecognised annotation but no failed step", failed({ failedSteps: [], annotations: [failure("Something odd")] }), "unknown"],
    ["failed step that never passed later", failed(), "real"],
  ])("%s -> %s", (_name, j, expected) => {
    expect(one(j)?.class).toBe(expected);
  });

  describe("refusal steps", () => {
    const gate = failed({ failedSteps: ["Admit release candidate"], runId: 5 });
    const opts = { refusalSteps: ["Admit release candidate"] };
    it("classifies a failed refusal step as refused with the step as evidence, even if a later attempt passed", () => {
      expect(one(gate, opts)).toMatchObject({ class: "refused", reason: "intentional refusal by a gate step", evidence: "Admit release candidate" });
      expect(classifyJobs([gate, job({ runId: 6, jobName: gate.jobName })], opts)[0]!.class).toBe("refused");
    });
    it("leaves other failed steps and an unset setting unchanged", () => {
      expect(one(failed(), opts)?.class).toBe("real");
      expect(one(gate)?.class).toBe("real");
      expect(classifyJobs([gate, job({ runId: 6, jobName: gate.jobName })])[0]!.class).toBe("flake");
    });
    it("lets runner loss, cancel and aggregator rules win over a refusal step", () => {
      expect(one({ ...gate, annotations: [failure(LOSS)] }, opts)?.class).toBe("runner_loss");
      expect(one({ ...gate, jobName: "Summary" }, { ...opts, aggregatorJobs: ["Summary"] })?.class).toBe("consequence");
    });
  });

  it("keeps evidence, without log timestamps", () => {
    expect(one(failed({ annotations: [failure(LOSS)] }))?.evidence).toBe(LOSS);
    expect(one(cancelled(MANUAL))?.evidence).toMatch(/canceled by @\S+/);
    const transient = one(failed({ logExcerpt: "setup\n2026-11-05T10:01:00.1234567Z curl: archive_download_http_504" }));
    expect(transient).toMatchObject({ class: "transient", evidence: "curl: archive_download_http_504" });
  });

  it("prefers runner loss over timeout and treats a log without a transient line as an ordinary failure", () => {
    expect(one(failed({ annotations: [failure(LOSS), failure(TIMEOUT)] }))?.class).toBe("runner_loss");
    expect(one(failed({ logExcerpt: "before\n##[error] assertion failed" }))?.class).toBe("real");
  });

  it("marks aggregator jobs as consequences only when configured", () => {
    const summary = failed({ jobName: "CI summary", failedSteps: ["Check needs"] });
    expect(one(summary, { aggregatorJobs: ["CI summary"] })?.class).toBe("consequence");
    expect(one(summary)?.class).toBe("real");
    expect(one(summary, { aggregatorJobs: ["Another job"] })?.class).toBe("real");
    expect(one(cancelled(SUPERSEDED, { jobName: "CI summary" }), { aggregatorJobs: ["CI summary"] })?.class).toBe("consequence");
  });

  it("a shutdown notice that only reached the log is a runner loss, above everything else", () => {
    const excerpt = "line\n2026-11-07T15:46:42.70Z ##[error]Process completed with exit code 130.\n2026-11-07T15:46:42.71Z ##[error]The runner has received a shutdown signal.";
    expect(one(failed({ logExcerpt: excerpt }))).toMatchObject({ class: "runner_loss", evidence: "##[error]The runner has received a shutdown signal." });
  });
  describe("flake versus real at the same sha", () => {
    const base = failed({ runId: 10 });
    const pass = (over: Partial<JobRecord> = {}) => job({ runId: 11, jobId: 2, event: "pull_request", headBranch: "feature", ...over });
    it("a success of the same job at the same sha in any run makes a flake", () => {
      expect(one(base)?.class).toBe("real");
      expect(classifyJobs([base, pass()])[0]).toMatchObject({ class: "flake", evidence: `${pass().workflowName} run 11` });
      expect(classifyJobs([base, pass({ runId: 9 })])[0].class).toBe("flake");
      expect(classifyJobs([base, pass({ workflowName: "Docs" })])[0].class).toBe("flake");
      expect(classifyJobs([base, pass({ runId: 10, attempt: 2 })])[0].class).toBe("flake");
    });
    it.each<[string, Partial<JobRecord>]>([
      ["a success at another sha", { headSha: "f".repeat(40) }],
      ["a success of another job", { jobName: "Integration tests" }],
      ["a carried success", { carried: true }],
      ["a failed rerun", { conclusion: "failure" }],
    ])("is not a flake with %s", (_name, over) => {
      expect(classifyJobs([base, pass(over)])[0].class).toBe("real");
    });
    it("pairs a reusable-workflow job with the same job called directly", () => {
      // A push run calls the suite as "Checks / X"; its merge-queue run at the same sha ran "X".
      expect(classifyJobs([{ ...base, jobName: "Checks / Unit tests" }, pass({ jobName: "Unit tests", workflowName: "CI", event: "merge_group" })])[0].class).toBe("flake");
      expect(classifyJobs([{ ...base, jobName: "Checks / Unit tests" }, pass({ jobName: "Checks / Lint" })])[0].class).toBe("real");
    });
    it("never pairs jobs with an unknown sha", () => {
      expect(classifyJobs([{ ...base, headSha: "" }, pass({ headSha: "" })])[0].class).toBe("real");
    });
    it("treats policy jobs as real even when a rerun passed", () => {
      const policy = failed({ jobName: "Policy check", runId: 10 });
      expect(classifyJobs([policy, pass({ jobName: "Policy check" })], { policyJobs: ["Policy check"] })[0].class).toBe("real");
      expect(classifyJobs([policy, pass({ jobName: "Policy check" })])[0].class).toBe("flake");
    });
    it("lets a transient log line win over a later pass", () => {
      expect(classifyJobs([{ ...base, logExcerpt: "read tcp: connection reset by peer" }, pass()])[0].class).toBe("transient");
    });
  });

  it("only classifies completed, non-carried, bad outcomes", () => {
    const result = classifyJobs([job(), failed({ jobId: 2 }), failed({ jobId: 3, carried: true }), failed({ jobId: 4, status: "in_progress", conclusion: null }),
      job({ jobId: 5, conclusion: "skipped" }), job({ jobId: 6, conclusion: "timed_out", failedSteps: ["Run tests"] }), job({ jobId: 7, conclusion: "startup_failure" })]);
    expect(result.map((c) => c.job.jobId)).toEqual([2, 6, 7]);
  });
});

describe("summarizeReruns", () => {
  const runJob = (over: Partial<JobRecord>) => job({ runId: 5, headBranch: "feature", event: "pull_request", ...over });
  const attempts = [
    runJob({ jobId: 1, jobName: "Unit tests", startedAt: at(0), completedAt: at(3) }),
    runJob({ jobId: 2, jobName: "Integration tests", conclusion: "failure", startedAt: at(0), completedAt: at(10) }),
    runJob({ jobId: 3, attempt: 2, jobName: "Unit tests", startedAt: at(0), completedAt: at(3), carried: true }),
    runJob({ jobId: 4, attempt: 2, jobName: "Integration tests", conclusion: "failure", startedAt: at(20), completedAt: at(26) }),
    runJob({ jobId: 5, attempt: 3, jobName: "Unit tests", startedAt: at(0), completedAt: at(3), carried: true }),
    runJob({ jobId: 6, attempt: 3, jobName: "Integration tests", startedAt: at(40), completedAt: at(44) }),
    runJob({ jobId: 7, attempt: 3, jobName: "Lint", conclusion: "skipped", startedAt: at(40), completedAt: at(40) }),
  ];
  const [rerun] = summarizeReruns(attempts);
  it("reports the outcome of every attempt and the final conclusion", () => {
    expect(rerun).toMatchObject({ runId: 5, attempts: 3, outcomes: ["failure", "failure", "success"], finalConclusion: "success", headBranch: "feature" });
  });
  it("counts only non-carried, non-skipped runner time from attempt 2 on", () => {
    expect(rerun.repeatedRunnerMs).toBe((6 + 4) * 60_000);
  });
  it("ignores single-attempt runs and leaves unfinished attempts unknown", () => {
    expect(summarizeReruns([runJob({ runId: 6 })])).toEqual([]);
    const running = summarizeReruns([runJob({ runId: 7, conclusion: "failure" }), runJob({ runId: 7, attempt: 2, jobId: 2, status: "in_progress", conclusion: null })])[0];
    expect(running).toMatchObject({ outcomes: ["failure", null], finalConclusion: null });
  });
  it("ranks the worst job conclusion per attempt", () => {
    const [mixed] = summarizeReruns([runJob({ runId: 8, conclusion: "cancelled" }), runJob({ runId: 8, jobId: 2, jobName: "Lint", conclusion: "timed_out" }), runJob({ runId: 8, attempt: 2, jobId: 3 })]);
    expect(mixed.outcomes).toEqual(["timed_out", "success"]);
  });
});

describe("runnerLosses and detectMassCancel", () => {
  const lost = (jobId: number, over: Partial<JobRecord>) => classify(failed({ jobId, annotations: [failure(LOSS)], ...over }), "runner_loss");
  it("tallies runner losses by pool, job and day", () => {
    const tally = runnerLosses([lost(1, { startedAt: at(0), completedAt: at(10) }), lost(2, { pool: "other-pool", jobName: "Lint", startedAt: at(0), completedAt: at(5) }),
      lost(3, { startedAt: at(0), completedAt: at(2) }), classify(failed({ jobId: 4 }), "real")]);
    expect(tally.byPool).toEqual({ "self-hosted": { count: 2, runnerMs: 12 * 60_000 }, "other-pool": { count: 1, runnerMs: 5 * 60_000 } });
    expect(tally.byJob).toEqual({ "Unit tests": { count: 2, runnerMs: 12 * 60_000 }, Lint: { count: 1, runnerMs: 5 * 60_000 } });
    expect(Object.keys(tally.byDay)).toEqual(["2026-11-05"]);
  });
  const mk = (runner: string, minute: number, seconds: number, cls: FailureClass = "runner_loss") => classify(failed({ runId: 1, runnerName: runner, completedAt: at(minute, seconds) }), cls);
  const hits = [mk("runner-a", 0, 0), mk("runner-b", 0, 30, "collateral_cancel"), mk("runner-c", 1, 0, "timeout"), mk("runner-d", 300, 0)];
  it("groups simultaneous losses across at least three runners", () => {
    const groups = detectMassCancel(hits);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ since: at(0), until: at(1), runners: ["runner-a", "runner-b", "runner-c"], runIds: [1] });
    expect(detectMassCancel(hits, { minRunners: 4 })).toHaveLength(0);
    expect(detectMassCancel(hits, { windowMs: 20_000 })).toHaveLength(0);
  });
  it("ignores a merge queue rebuild that cancels in-flight group jobs, but not lost runners in the queue", () => {
    const queue = (runner: string, cls: FailureClass) => classify(failed({ runId: 2, event: "merge_group", runnerName: runner, completedAt: at(0, 0) }), cls);
    expect(detectMassCancel(["q-a", "q-b", "q-c", "q-d"].map((r) => queue(r, "collateral_cancel")))).toEqual([]);
    expect(detectMassCancel(["q-a", "q-b", "q-c"].map((r) => queue(r, "runner_loss")))).toHaveLength(1);
  });
  it("ignores other failure classes and repeated losses on one runner", () => {
    expect(detectMassCancel([mk("runner-a", 0, 0), mk("runner-a", 0, 10), mk("runner-b", 0, 20), mk("runner-c", 0, 30, "real")])).toEqual([]);
  });
});

describe("queuePullRequest", () => {
  it.each<[string | null, number | null]>([
    ["gh-readonly-queue/main/pr-123-0123abc", 123], ["gh-readonly-queue/release/1.x/pr-7-deadbeef", 7],
    ["feature", null], ["main", null], [null, null], ["gh-readonly-queue/main/pr-x-0123abc", null],
  ])("%s -> %s", (branch, expected) => expect(queuePullRequest(branch)).toBe(expected));
});

describe("queueOnlyJobs", () => {
  const queued = (over: Partial<JobRecord> = {}) => failed({ event: "merge_group", headBranch: "gh-readonly-queue/main/pr-12-0123abc", jobId: 900, runId: 90, ...over });
  const pr = (over: Partial<JobRecord> = {}) => job({ event: "pull_request", headBranch: "feature", pullRequests: [12], runId: 50, ...over });
  const flagged = (jobs: JobRecord[]) => [...queueOnlyJobs(jobs, classifyJobs(jobs))];
  it("is true when the same job passed on the PR", () => expect(flagged([queued(), pr()])).toEqual([900]));
  it("is false when the PR run failed, is absent, or belongs to another PR or job", () => {
    expect(flagged([queued(), pr({ conclusion: "failure" })])).toEqual([]);
    expect(flagged([queued()])).toEqual([]);
    expect(flagged([queued(), pr({ pullRequests: [13] })])).toEqual([]);
    expect(flagged([queued(), pr({ jobName: "Lint" })])).toEqual([]);
    expect(flagged([queued(), pr({ workflowName: "Other" })])).toEqual([]);
  });
  it("uses the newest PR run", () => {
    expect(flagged([queued(), pr(), pr({ runId: 60, conclusion: "failure" })])).toEqual([]);
    expect(flagged([queued(), pr({ conclusion: "failure" }), pr({ runId: 60 })])).toEqual([900]);
  });
  it("ignores non-queue events and classes that need no action", () => {
    expect(flagged([failed({ jobId: 901 }), pr()])).toEqual([]);
    expect(flagged([queued({ annotations: [failure(LOSS)] }), pr()])).toEqual([]);
  });
});

describe("percentile and pool timings", () => {
  it("uses nearest rank", () => {
    const list = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect([percentile(list, 50), percentile(list, 90), percentile(list, 100), percentile([7], 90), percentile([], 50)]).toEqual([5, 9, 10, 7, 0]);
  });
  const timed = (waitSeconds: number, durationSeconds: number, over: Partial<JobRecord> = {}) =>
    job({ createdAt: at(0), startedAt: at(0, waitSeconds), completedAt: at(0, waitSeconds + durationSeconds), ...over });
  it("summarizes executed jobs per pool and event, skipping carried, skipped, incomplete and untimed jobs", () => {
    const jobs = [timed(10, 100), timed(20, 200), timed(30, 300), timed(40, 400, { event: "merge_group", pool: null }),
      timed(5, 5, { carried: true }), timed(5, 5, { conclusion: "skipped" }), timed(5, 5, { status: "in_progress" }), timed(5, 5, { startedAt: null }), timed(5, 5, { completedAt: null }),
      job({ createdAt: at(1), startedAt: at(0), completedAt: at(0, 30) })];
    const { poolTimings, poolTimingsByEvent } = summarizeTimings(timingSamples(jobs));
    expect(poolTimings["self-hosted"]).toEqual({ jobs: 4, queueWaitMs: { p50: 10_000, p90: 30_000 }, durationMs: { p50: 100_000, p90: 300_000 } });
    expect(poolTimings.unknown).toEqual({ jobs: 1, queueWaitMs: { p50: 40_000, p90: 40_000 }, durationMs: { p50: 400_000, p90: 400_000 } });
    expect(Object.keys(poolTimingsByEvent).sort()).toEqual(["merge_group", "push"]);
    expect(poolTimingsByEvent.merge_group!.unknown!.jobs).toBe(1);
    expect(poolTimingsByEvent.push!["self-hosted"]!.jobs).toBe(4);
  });
});

describe("inherited failures", () => {
  const group = (over: Partial<JobRecord> = {}) => failed({ event: "merge_group", headBranch: "gh-readonly-queue/main/pr-8-abc123", buildFailure: { match: "pkg/core: build failed" }, inheritedFrom: { pullRequest: 7, runId: 50 }, ...over });
  it("keeps the class and evidence and names the origin in the reason", () => {
    expect(one(group())).toMatchObject({ class: "real", reason: "build or setup failed, inherited from #7", evidence: "pkg/core: build failed" });
    expect(one(group({ inheritedFrom: null }))?.reason).toBe("build or setup failed");
  });
  it("never tags runner losses, timeouts, transient or refused failures", () => {
    for (const j of [group({ annotations: [failure(LOSS)] }), group({ annotations: [failure(TIMEOUT)] }), group({ logExcerpt: "##[error] ECONNRESET" })]) expect(one(j)!.reason).not.toContain("inherited");
    expect(one(group(), { refusalSteps: ["Run tests"] })).toMatchObject({ class: "refused", reason: "intentional refusal by a gate step" });
  });
});
