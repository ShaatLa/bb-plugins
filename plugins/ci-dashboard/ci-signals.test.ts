import { describe, expect, it } from "vitest";
import { classifyJobs, detectMassCancel, queueOnlyJobs, runnerLosses, summarizeReruns, timingSamples } from "./ci-classify";
import type { JobRecord, Signal } from "./ci-jobs-types";
import { ciSliceReport } from "./agent-ci";
import { buildSignals, shouldPush, sortSignals, summarizeAnalysis } from "./ci-signals";
import { at, failed, failure, job, LOSS, MANUAL, REPO, SUPERSEDED, TIMEOUT } from "./test-support";

const now = Date.parse("2026-11-05T11:00:00Z");
const main = { event: "push", headBranch: "main" };
const lost = (over: Partial<JobRecord>, minute: number, seconds = 0) => failed({ annotations: [failure(LOSS)], ...over, completedAt: at(minute, seconds) }, minute);
const jobs: JobRecord[] = [
  lost({ jobId: 1, runId: 100, ...main }, 30),                                                  // runner loss on the default branch
  lost({ jobId: 2, runId: 101, pullRequests: [7], runnerName: "runner-b" }, 40),                 // runner loss on a pull request
  failed({ jobId: 3, runId: 102, conclusion: "cancelled", failedSteps: [], annotations: [failure(TIMEOUT)] }, 55),
  failed({ jobId: 4, runId: 103, headSha: "a".repeat(40) }, 20), job({ jobId: 5, runId: 104, headSha: "a".repeat(40), headBranch: "feature" }), // flake
  failed({ jobId: 6, runId: 105, pullRequests: [8], logExcerpt: "curl: archive_download_http_504" }, 25), // transient
  failed({ jobId: 10, runId: 200, ...main }, 31), failed({ jobId: 11, runId: 200, attempt: 2, ...main }, 45),  // rerun still failing on main
  failed({ jobId: 12, runId: 300 }, 32), failed({ jobId: 13, runId: 300, attempt: 2 }, 46),                    // ... and on a branch
  failed({ jobId: 14, runId: 400, headSha: "c".repeat(40) }, 33), job({ jobId: 15, runId: 400, attempt: 2, headSha: "c".repeat(40), event: "pull_request", headBranch: "feature" }), // rerun that recovered
  lost({ jobId: 20, runId: 500, runnerName: "runner-a" }, 50), lost({ jobId: 21, runId: 500, runnerName: "runner-b" }, 50, 30), lost({ jobId: 22, runId: 500, runnerName: "runner-c" }, 51), // mass cancel
];
const classified = classifyJobs(jobs), reruns = summarizeReruns(jobs), massCancels = detectMassCancel(classified);
const stall: Signal = { id: "pool_stall:self-hosted", kind: "pool_stall", severity: "critical", title: "Runner pool stalled: self-hosted", what: "3 jobs queued", where: { pool: "self-hosted" }, since: "2026-11-05T10:40:00.000Z", until: null, impact: "waiting", actor: "owner_sre", open: true };
const build = (overrides: Partial<Parameters<typeof buildSignals>[0]> = {}) => buildSignals({ classified, reruns, massCancels, stalls: [stall], defaultBranch: "main", repository: REPO, now, ...overrides });

describe("buildSignals", () => {
  const signals = build();
  const byId = (id: string) => signals.find((s) => s.id === id);

  it("passes stalls through and gives every signal a stable unique id and a valid url", () => {
    expect(signals[0]).toBe(stall);
    expect(new Set(signals.map((s) => s.id)).size).toBe(signals.length);
    expect(build().map((s) => s.id)).toEqual(signals.map((s) => s.id));
    for (const s of signals.slice(1)) if (s.kind !== "mass_cancel") expect(s.where.url).toMatch(/^https:\/\/github\.com\/acme\/widgets\/actions\/runs\/\d+/);
  });

  it("rates runner loss by branch: warning on the default branch, info elsewhere", () => {
    expect(byId("runner_loss:1")).toMatchObject({ severity: "warning", actor: "owner_sre", where: { runId: 100, branch: "main", jobId: 1, pool: "self-hosted" }, impact: "CI red on main: deploy blocked until rerun" });
    expect(byId("runner_loss:2")).toMatchObject({ severity: "info", actor: "owner_sre", impact: "PR #7 CI red; rerun needed" });
  });

  it("emits timeout, flake and transient signals with the right actors", () => {
    expect(byId("timeout:3")).toMatchObject({ severity: "info", actor: "owner_sre", kind: "timeout" });
    expect(byId("flake:4")).toMatchObject({ severity: "info", actor: "lead", kind: "flake" });
    expect(byId("transient:6")).toMatchObject({ kind: "transient", actor: "pr_author", severity: "info" });
    const onMain = buildSignals({ classified: [{ ...classified.find((c) => c.class === "transient")!, job: failed({ jobId: 7, ...main, logExcerpt: "ECONNRESET" }, 25) }], reruns: [], massCancels: [], stalls: [], defaultBranch: "main", repository: REPO, now });
    expect(onMain[0]).toMatchObject({ kind: "transient", actor: "lead", severity: "info" });
  });

  it("does not signal real failures", () => {
    expect(signals.filter((s) => ["real", "unknown"].includes(s.kind))).toEqual([]);
    expect(classified.find((c) => c.job.jobId === 10)?.class).toBe("real");
    expect(signals.some((s) => s.id === "runner_loss:10")).toBe(false);
  });

  it("flags reruns that still fail, warning only on the default branch", () => {
    expect(byId("rerun_failed:200:2")).toMatchObject({ kind: "rerun_failed", actor: "lead", severity: "warning", where: { runId: 200, url: `https://github.com/${REPO}/actions/runs/200` } });
    expect(byId("rerun_failed:300:2")).toMatchObject({ severity: "info" });
    expect(byId("rerun_failed:400:2")).toBeUndefined();
  });

  it("turns a mass cancel into one critical signal keyed by its start", () => {
    const groups = signals.filter((s) => s.kind === "mass_cancel");
    expect(massCancels).toHaveLength(1);
    expect(groups).toEqual([expect.objectContaining({ id: `mass_cancel:${massCancels[0]!.since}`, severity: "critical", actor: "owner_sre", title: "Mass runner loss in self-hosted", what: "3 jobs on 3 runners lost/cancelled within 2 min" })]);
  });

  it("drops events that completed outside the window", () => {
    expect(build({ now: Date.parse("2026-11-07T00:00:00Z") })).toEqual([stall]);
    expect(build({ now: Date.parse("2026-11-07T00:00:00Z"), windowHours: 100 }).length).toBeGreaterThan(1);
  });

  it("never treats a missing default branch as matching a null head branch", () => {
    const loss = classified.find((c) => c.class === "runner_loss")!;
    const [signal] = buildSignals({ classified: [{ ...loss, job: { ...loss.job, headBranch: null } }], reruns: [], massCancels: [], stalls: [], defaultBranch: null, repository: "a/b", now });
    expect(signal!.severity).toBe("info");
  });
});

describe("shouldPush", () => {
  const sig = (severity: Signal["severity"], branch: string | null, since: string): Signal => ({ ...stall, severity, where: { branch }, since });
  it("pushes critical and default-branch warnings only while fresh", () => {
    expect(shouldPush(sig("critical", null, "2026-11-05T10:30:00Z"), "main", now)).toBe(true);
    expect(shouldPush(sig("warning", "main", "2026-11-05T10:45:00Z"), "main", now)).toBe(true);
    expect(shouldPush(sig("warning", "feature", "2026-11-05T10:45:00Z"), "main", now)).toBe(false);
    expect(shouldPush(sig("info", "main", "2026-11-05T10:45:00Z"), "main", now)).toBe(false);
    expect(shouldPush(sig("warning", null, "2026-11-05T10:45:00Z"), null, now)).toBe(false);
  });
  it("applies the 30 minute guard inclusively", () => {
    expect(shouldPush(sig("critical", null, "2026-11-05T10:30:00Z"), "main", now)).toBe(true);
    expect(shouldPush(sig("critical", null, "2026-11-05T10:29:59Z"), "main", now)).toBe(false);
  });
});

describe("summarizeAnalysis and sortSignals", () => {
  // 60 distinct real failures plus 25 two-attempt runs, a CI summary consequence, a superseded and a manually cancelled job.
  const many: JobRecord[] = [
    ...Array.from({ length: 60 }, (_, i) => failed({ jobId: 1000 + i, runId: 1000 + i, headSha: String(i).padStart(40, "0") }, 1 + (i % 50))),
    ...Array.from({ length: 25 }, (_, i) => [failed({ jobId: 2000 + i, runId: 2000 + i, headSha: "b".repeat(40) }), failed({ jobId: 3000 + i, runId: 2000 + i, attempt: 2, headSha: "b".repeat(40) })]).flat(),
    failed({ jobId: 4001, runId: 4001, jobName: "CI summary" }), failed({ jobId: 4002, runId: 4002, conclusion: "cancelled", failedSteps: [], annotations: [failure(SUPERSEDED)] }),
    failed({ jobId: 4003, runId: 4003, conclusion: "cancelled", failedSteps: [], annotations: [failure(MANUAL)] }),
  ];
  const all = classifyJobs(many, { aggregatorJobs: ["CI summary"] }), allReruns = summarizeReruns(many), allMass = detectMassCancel(all);
  const view = summarizeAnalysis({ classified: all, reruns: allReruns, massCancels: allMass, losses: runnerLosses(all), repository: REPO });

  it("counts every class but lists only actionable failures, newest first", () => {
    expect(Object.keys(view.failureCounts)).toHaveLength(11);
    expect(view.failureCounts).toMatchObject({ consequence: 1, superseded: 1, manual_cancel: 1 });
    expect(view.failures.some((f) => ["consequence", "superseded", "manual_cancel"].includes(f.class))).toBe(false);
    const times = view.failures.map((f) => Date.parse(f.completedAt ?? ""));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(view.failures).toHaveLength(50);
    expect(view.failures[0]!.url).toMatch(/^https:\/\/github\.com\/acme\/widgets\/actions\/runs\/\d+\/job\/\d+$/);
  });
  describe("merge queue", () => {
    const queue = "gh-readonly-queue/main/pr-12-0123abc";
    // A merge-queue run tests a new merge commit, never the PR head sha.
    const pr = "b".repeat(40);
    const set = [
      failed({ jobId: 1, runId: 10, event: "merge_group", headBranch: queue }), failed({ jobId: 2, runId: 11, event: "merge_group", headBranch: queue, jobName: "Lint" }),
      failed({ jobId: 3, runId: 12, event: "merge_group", headBranch: queue, jobName: "Integration tests", annotations: [failure(LOSS)] }),
      job({ jobId: 4, runId: 5, event: "pull_request", pullRequests: [12], headBranch: "feature", headSha: pr }),
      failed({ jobId: 5, runId: 5, pullRequests: [12], jobName: "Lint", headSha: pr }),
      failed({ jobId: 6, runId: 13, pullRequests: [12], jobName: "E2E", headSha: pr }),
    ];
    const classified = classifyJobs(set), queueOnly = queueOnlyJobs(set, classified);
    const summary = summarizeAnalysis({ classified, reruns: [], massCancels: [], losses: runnerLosses(classified), repository: REPO, queueOnly });
    const row = (jobId: number) => summary.failures.find((f) => f.jobId === jobId)!;
    it("tags rows with the event, the queue PR and queueOnly", () => {
      expect(row(1)).toMatchObject({ event: "merge_group", queuePullRequest: 12, queueOnly: true });
      expect(row(2)).toMatchObject({ event: "merge_group", queuePullRequest: 12, queueOnly: false });
      expect(row(3)).toMatchObject({ class: "runner_loss", queueOnly: false });
      expect(row(6)).toMatchObject({ event: "pull_request", queuePullRequest: null, queueOnly: false });
    });
    it("splits the failure counts by event", () => {
      expect(Object.keys(summary.failureCountsByEvent).sort()).toEqual(["merge_group", "pull_request"]);
      expect(Object.keys(summary.failureCountsByEvent.merge_group!)).toHaveLength(11);
      expect(summary.failureCountsByEvent.merge_group).toMatchObject({ runner_loss: 1, real: 2 });
      expect(summary.failureCountsByEvent.pull_request).toMatchObject({ real: 2, runner_loss: 0 });
    });
    it("tags reruns with the event and queue PR", () => {
      const reruns = summarizeReruns([failed({ runId: 20, event: "merge_group", headBranch: queue }), failed({ runId: 20, attempt: 2, jobId: 9, event: "merge_group", headBranch: queue })]);
      expect(summarizeAnalysis({ classified: [], reruns, massCancels: [], losses: runnerLosses([]), repository: REPO }).reruns[0]).toMatchObject({ event: "merge_group", queuePullRequest: 12 });
    });
    it("puts the timings, overall and by event, into the stall view", () => {
      const samples = timingSamples(set);
      const output = { repositories: [{ repository: REPO, updatedAt: null, error: null, live: { pools: [], truncated: false, polledAt: null }, signals: [], problems: [], projectId: null,
        window: { since: at(0), until: at(10) }, backfill: { remaining: 0, failed: 0, pausedUntil: null, coveredSince: null }, ...summarizeAnalysis({ classified, reruns: [], massCancels: [], losses: runnerLosses(classified), repository: REPO, samples }) }], actors: {} } as never;
      const [pools] = ciSliceReport(output, "stall").repositories as Record<string, unknown>[];
      expect(pools).toMatchObject({ poolTimings: { "self-hosted": { jobs: 6 } }, poolTimingsByEvent: { merge_group: { "self-hosted": { jobs: 3 } }, pull_request: { "self-hosted": { jobs: 3 } } } });
    });
    it("serves problems alone, and puts problems before a compact open-signals list", () => {
      const signal = (n: number, open: boolean) => ({ id: `s${n}`, kind: "flake", severity: "info", title: `t${n}`, what: "w", impact: "i", actor: "lead", where: {}, since: at(0), until: null, open });
      const problem = { id: "p1", kind: "signal", severity: "warning", title: "p", what: "w", impact: "i", where: {}, since: at(0), handled: null };
      const base = { repository: REPO, updatedAt: null, error: null, live: { pools: [], truncated: false, polledAt: null }, projectId: null,
        window: { since: at(0), until: at(10) }, backfill: { remaining: 0, failed: 0, pausedUntil: null, coveredSince: null },
        signals: [...Array.from({ length: 3 }, (_, n) => signal(n, true)), ...Array.from({ length: 30 }, (_, n) => signal(100 + n, false))], problems: [problem] };
      const output = { repositories: [{ ...base, ...summarizeAnalysis({ classified: [], reruns: [], massCancels: [], losses: runnerLosses([]), repository: REPO }) }], actors: {} } as never;
      const only = ciSliceReport(output, "problems").repositories[0] as Record<string, unknown>;
      expect(only.problems).toHaveLength(1); expect(only).not.toHaveProperty("signals");
      const row = ciSliceReport(output, "signals").repositories[0] as Record<string, unknown>;
      const keys = Object.keys(row);
      expect(keys.indexOf("problems")).toBeLessThan(keys.indexOf("signals"));
      // Open signals only, compact rows without the where block.
      expect(row.signals).toHaveLength(3);
      expect((row.signals as Record<string, unknown>[])[0]).toEqual({ id: "s0", kind: "flake", severity: "info", title: "t0", what: "w", since: at(0), actor: "lead" });
    });
  });
  it("lists the newest 20 reruns first", () => {
    expect(allReruns).toHaveLength(25);
    expect(view.reruns).toHaveLength(20);
    expect(view.reruns.map((r) => r.runId)).toEqual([...view.reruns.map((r) => r.runId)].sort((a, b) => b - a));
  });
  it("sorts open before resolved, then by severity and recency", () => {
    const make = (id: string, severity: Signal["severity"], since: string, open = true): Signal => ({ ...stall, id, severity, since, open });
    expect(sortSignals([make("r", "critical", "2026-11-05T10:00:00Z", false), make("i", "info", "2026-11-05T10:00:00Z"), make("w-old", "warning", "2026-11-05T09:00:00Z"), make("w-new", "warning", "2026-11-05T10:00:00Z"), make("c", "critical", "2026-11-05T08:00:00Z")]).map((s) => s.id))
      .toEqual(["c", "w-new", "w-old", "i", "r"]);
  });
});

describe("lane view", () => {
  it("selects pipelines, bounds lanes, and accepts old rows", () => {
    const stat = { p50: 1, p90: 2, n: 1, days: [] };
    const pipeline = (event: string) => ({ workflow: "CI", event, runs: 1, wall: stat, lanes: Array.from({ length: 200 }, (_, i) => ({ name: `Unit tests ${i}`, ...stat })) });
    const base = { repository: REPO, updatedAt: null, error: null, window: { since: at(0), until: at(10) }, backfill: { remaining: 0, failed: 0, pausedUntil: null, coveredSince: null } };
    const output = (laneTimings?: object) => ({ repositories: [{ ...base, laneTimings }], actors: {} }) as never;
    const row = (data: never, event?: string) => ciSliceReport(data, "lanes", event).repositories[0] as Record<string, unknown>;
    const data = output({ pipelines: [pipeline("merge_group"), pipeline("pull_request")] });
    expect(row(data).pipeline).toMatchObject({ event: "merge_group" });
    expect(row(data, "pull_request").pipeline).toMatchObject({ event: "pull_request" });
    expect(row(data).moreLanes).toBeGreaterThan(0);
    expect(JSON.stringify(row(data)).length).toBeLessThan(7600);
    expect(row(output()).pipeline).toBeNull();
  });
});
