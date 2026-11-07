import { describe, expect, it } from "vitest";
import { classifyJobs, detectMassCancel } from "./ci-classify";
import type { CiInsights } from "./ci-insights";
import type { ClassifiedJob, Signal } from "./ci-jobs-types";
import { acceptEvents, attachPrHeads, confirmRemovals, defaultRedEvents, deployRunOutcome, deploymentEvents, dispatch, emptyGlobal, emptyRepoState, enabledEvents, fit, massCancelEvent, observerThreadsSchema, parseObserverThreads, queueRemovalEvents, repoStateSchema, runnerLossEvents, stallEvent, subscriptionNotice, syncGlobal, type ObserverConfig, type ObserverEvent, type ObserverType, type Rendered } from "./ci-observer";
import { at, classify, failed, failure, job, LOSS, REPO } from "./test-support";
import { parseRef } from "./ci-refs";

const queueJob = (over = {}, minute = 5) => failed({ event: "merge_group", headBranch: "gh-readonly-queue/main/pr-7-abc123", runId: 50, jobId: 500, ...over }, minute);
const text = (event: ObserverEvent, tests?: string[] | null) => event.render(tests);
const RUN_URL = `https://github.com/${REPO}/actions/runs/50`;

describe("observer settings", () => {
  it("accepts blank and BB thread ids, rejects anything else", () => {
    expect(observerThreadsSchema.safeParse("").success).toBe(true);
    expect(observerThreadsSchema.safeParse("thr_observer, thr_abc123").success).toBe(true);
    for (const bad of ["observer", "thr_", "thr_UPPER", "thr_a b!", "thr_ok, nope", Array.from({ length: 11 }, (_, i) => `thr_a${i}`).join(",")]) expect(observerThreadsSchema.safeParse(bad).success, bad).toBe(false);
    expect(parseObserverThreads("thr_a, thr_b thr_a,\n thr_c")).toEqual(["thr_a", "thr_b", "thr_c"]);
    expect(parseObserverThreads("  ")).toEqual([]);
  });
  it("defaults every event type on and honors an explicit off", () => {
    expect(enabledEvents({})).toEqual({ queue: true, loss: true, red: true, stall: true, mass: true, deploy: true });
    expect(enabledEvents({ observeDeployments: false, observeQueueRemoval: true })).toMatchObject({ deploy: false, queue: true });
  });
});

describe("merge queue removal", () => {
  it("names the PR, run attempt, job classes with signature labels and the failed tests", () => {
    const flake = { ...classify(queueJob({ jobName: "Integration", jobId: 501 }), "flake"), flakeLabel: "FLAKE-1" };
    const [event] = queueRemovalEvents(REPO, [classify(queueJob(), "real"), flake, classify(queueJob({ jobName: "CI summary", jobId: 502 }), "consequence"), classify(queueJob({ jobName: "Lint", jobId: 503 }), "runner_loss")]);
    expect(event).toMatchObject({ type: "queue", key: "queue:50:1", dedupe: "once", at: Date.parse(at(5)), tests: { run: { id: 50, attempt: 1 } } });
    expect(text(event!, ["a.One", "b.Two"])).toBe(`PR #7 removed from merge queue · Unit tests: real, Integration: flake FLAKE-1, CI summary: consequence, Lint: runner_loss (1 on this head) · failed tests: a.One, b.Two · inspect queue:50:1 ${RUN_URL}`);
    expect(text(event!)).not.toContain("failed tests");
    expect(text(event!, [])).not.toContain("failed tests");
  });
  it("shows at most three tests then +K, at most four jobs then +K, and keeps the link inside 400 characters", () => {
    const jobs = Array.from({ length: 6 }, (_, i) => classify(queueJob({ jobName: `Job ${i}`, jobId: 600 + i }), "real"));
    const [event] = queueRemovalEvents(REPO, jobs);
    const line = text(event!, Array.from({ length: 8 }, (_, i) => `test${i}`));
    expect(line).toContain("Job 0: real, Job 1: real, Job 2: real, Job 3: real, +2");
    expect(line).toContain("failed tests: test0, test1, test2, +5");
    const long = text(event!, [`${"x".repeat(300)}`, ...Array.from({ length: 4 }, (_, i) => "y".repeat(100 + i))]);
    expect(long.length).toBeLessThanOrEqual(400);
    expect(long.endsWith(RUN_URL)).toBe(true);
    expect(long).not.toContain("\n");
  });
  it("counts each attempt once, skips cancellations nobody caused, other events and attempts without a PR", () => {
    const events = queueRemovalEvents(REPO, [classify(queueJob(), "real"), classify(queueJob({ attempt: 2, jobId: 510 }), "flake"),
      classify(queueJob({ runId: 51, jobId: 520 }), "superseded"), classify(queueJob({ runId: 54, jobId: 550 }), "manual_cancel"), classify(failed({ runId: 52, jobId: 530 }), "real"), classify(queueJob({ runId: 53, jobId: 540, headBranch: "feature" }), "real")]);
    expect(events.map((event) => event.key)).toEqual(["queue:50:1", "queue:50:2", "queue:53:1"]);
    expect(text(events[2]!)).toMatch(/^Merge queue run failed · .* · inspect queue:53:1 /);
    // Runner losses carry no test report.
    expect(queueRemovalEvents(REPO, [classify(queueJob(), "runner_loss")])[0]!.tests).toBeUndefined();
  });
  it("carries the confirmation data: the PR and the earliest job start of the attempt", () => {
    const [event] = queueRemovalEvents(REPO, [classify(queueJob({ startedAt: at(2) }), "real"), classify(queueJob({ jobId: 501, startedAt: at(1) }), "flake")]);
    expect(event!.removal).toEqual({ pullRequest: 7, since: Date.parse(at(1)) });
    expect(queueRemovalEvents(REPO, [classify(queueJob({ headBranch: "feature" }), "real")])[0]!.removal).toBeUndefined();
  });
  it("produces nothing for a group that only failed through its aggregator", () => {
    expect(queueRemovalEvents(REPO, [classify(queueJob({ jobName: "CI summary" }), "consequence")])).toEqual([]);
    expect(queueRemovalEvents(REPO, [classify(queueJob({ jobName: "CI summary" }), "consequence"), classify(queueJob({ jobId: 501 }), "real")]).map((event) => event.key)).toEqual(["queue:50:1"]);
  });
  it("produces neither a removal nor a loss for a group the queue invalidated; fail-fast cancels next to an own failure are a removal", () => {
    for (const cancel of ["collateral_cancel", "superseded", "manual_cancel"] as const) {
      // Invalidated: only cancellations, no own failure.
      const rebuilt = [classify(queueJob({ jobId: 2, jobName: "Lint" }), cancel), classify(queueJob({ jobId: 3, jobName: "E2E" }), cancel)];
      expect(queueRemovalEvents(REPO, rebuilt, 3), cancel).toEqual([]);
      // An own failure with cancelled siblings ran to its own end: a removal; its loss never stands alone (the group had cancellations).
      const failed = [classify(queueJob({ jobId: 1 }), "real"), classify(queueJob({ jobId: 2, jobName: "Lint" }), "runner_loss"), classify(queueJob({ jobId: 3, jobName: "E2E" }), cancel)];
      expect(queueRemovalEvents(REPO, failed, 3).map((event) => event.key), cancel).toEqual(["queue:50:1"]);
      expect(runnerLossEvents(REPO, failed, "main", 3, () => true), cancel).toEqual([]);
    }
    // Another attempt of the same run is a different group and is not affected.
    expect(queueRemovalEvents(REPO, [classify(queueJob({ jobId: 1 }), "real"), classify(queueJob({ jobId: 3, attempt: 2 }), "collateral_cancel")]).map((event) => event.key)).toEqual(["queue:50:1"]);
  });
  it("folds a queue runner loss into the removal line with the count on the head and the limit", () => {
    const group = [classify(queueJob({ jobId: 1 }), "real"), classify(queueJob({ jobId: 2, jobName: "Lint" }), "runner_loss"), classify(queueJob({ jobId: 3, jobName: "E2E" }), "runner_loss")];
    expect(text(queueRemovalEvents(REPO, group, 3)[0]!)).toContain("Unit tests: real, Lint: runner_loss (2/3 on this head), E2E: runner_loss (2/3 on this head)");
    expect(text(queueRemovalEvents(REPO, group)[0]!)).toContain("Lint: runner_loss (2 on this head)");
    // The count covers the whole head, not only this attempt.
    expect(text(queueRemovalEvents(REPO, [...group, classify(queueJob({ runId: 60, jobId: 9 }), "runner_loss")], 3)[0]!)).toContain("Lint: runner_loss (3/3 on this head; suspected PR-induced (repeat on same head))");
  });
  it("counts a PR's losses across its groups (each group has its own merge commit), skipping groups whose removal was never confirmed", () => {
    const loss = (runId: number, head: string) => classify(queueJob({ runId, jobId: runId * 10, headSha: head.repeat(40), headBranch: `gh-readonly-queue/main/pr-7-${head.repeat(40)}` }), "runner_loss");
    const three = [loss(61, "a"), loss(62, "b"), loss(63, "c")];
    expect(text(queueRemovalEvents(REPO, three, 3).find((event) => event.key === "queue:63:1")!)).toContain("runner_loss (3/3 on this head; suspected PR-induced (repeat on same head))");
    // The middle group's removal was given up on (the PR stayed queued): it does not count.
    expect(text(queueRemovalEvents(REPO, three, 3, undefined, new Set(["queue:62:1"])).find((event) => event.key === "queue:63:1")!)).toContain("runner_loss (2/3 on this head)");
  });
  it("restarts the count when the PR gets a new head: retry budgets are per head", () => {
    const loss = (runId: number, minute: number) => classify(queueJob({ runId, jobId: runId * 10, headSha: String(runId).repeat(40).slice(0, 40), createdAt: at(minute), headBranch: `gh-readonly-queue/main/pr-7-${"b".repeat(40)}` }), "runner_loss");
    const prRun = (sha: string, minute: number) => job({ runId: 900 + minute, jobId: 9000 + minute, event: "pull_request", pullRequests: [7], headSha: sha.repeat(40), createdAt: at(minute) });
    const classified = [loss(61, 10), loss(62, 20), loss(63, 40)];
    // Head "a" was pushed before the first two groups, head "f" (the fix) before the third.
    attachPrHeads([prRun("a", 5), prRun("f", 30), ...classified.map((c) => c.job)], classified);
    expect(classified.map((c) => c.job.prHead?.[0])).toEqual(["a", "a", "f"]);
    const line = (key: string) => text(queueRemovalEvents(REPO, classified, 3).find((event) => event.key === key)!);
    expect(line("queue:62:1")).toContain("runner_loss (2/3 on this head)");
    expect(line("queue:63:1")).toContain("runner_loss (1/3 on this head)");
  });
  it("regression: a group cancelled because the PR ahead left the queue is not a removal", () => {
    // PR 7 (ahead) really failed and left; PR 8's group, built on it, only failed through its aggregator and cancellations.
    const classified = [classify(queueJob({ jobId: 1 }), "real"),
      classify(queueJob({ runId: 51, jobId: 10, headBranch: "gh-readonly-queue/main/pr-8-def456" }), "collateral_cancel"),
      classify(queueJob({ runId: 51, jobId: 11, jobName: "CI summary", headBranch: "gh-readonly-queue/main/pr-8-def456" }), "consequence")];
    expect(queueRemovalEvents(REPO, classified, 3).map((event) => text(event))).toEqual([expect.stringMatching(/^PR #7 removed from merge queue · .* · inspect queue:50:1 /)]);
    // Same when the PR behind only failed as consequence, without any cancellation.
    expect(queueRemovalEvents(REPO, [classified[0]!, classify(queueJob({ runId: 51, jobId: 11, headBranch: "gh-readonly-queue/main/pr-8-def456" }), "consequence")], 3).map((event) => event.key)).toEqual(["queue:50:1"]);
  });
  it("produces nothing for green runs", () => {
    const green = [job({ event: "merge_group", headBranch: "gh-readonly-queue/main/pr-7-abc123", jobId: 1 }), job({ jobId: 2 })];
    expect(classifyJobs(green)).toEqual([]);
    expect(queueRemovalEvents(REPO, classifyJobs(green))).toEqual([]);
    expect(runnerLossEvents(REPO, classifyJobs(green), "main", 0)).toEqual([]);
    expect(defaultRedEvents(REPO, classifyJobs(green), [])).toEqual([]);
  });
});

describe("confirming queue removals", () => {
  const MIN = 60_000, since = Date.parse(at(10)), now = Date.parse(at(12));
  const removal = (key: string, pullRequest: number, eventAt = now - MIN): ObserverEvent => ({ type: "queue", key, dedupe: "once", at: eventAt, render: () => key, removal: { pullRequest, since } });
  const plain: ObserverEvent = { type: "red", key: "red:1:1", dedupe: "once", at: now, render: () => "red" };
  const keys = (events: ObserverEvent[]) => events.map((event) => event.key);
  const lookup = (answers: Record<number, number | null | Error>) => { const asked: number[] = []; return { asked, fn: async (pr: number) => { asked.push(pr); const answer = answers[pr]; if (answer instanceof Error) throw answer; return answer ?? null; } }; };

  it("drops a removal recorded long after the group run ended: it belongs to a later group", async () => {
    const github = lookup({ 7: now - MIN + 16 * MIN });
    expect(await confirmRemovals([removal("queue:1:1", 7)], emptyRepoState(), github.fn, new Set(), now)).toEqual([]);
  });
  it("keeps a removal GitHub shows at or after the group started (a minute of slack), and asks once per PR", async () => {
    const github = lookup({ 7: since + MIN, 8: since - MIN, 9: since - MIN - 1 });
    const out = await confirmRemovals([plain, removal("queue:1:1", 7), removal("queue:1:2", 7), removal("queue:2:1", 8), removal("queue:3:1", 9)], emptyRepoState(), github.fn, new Set(), now);
    expect(keys(out)).toEqual(["red:1:1", "queue:1:1", "queue:1:2", "queue:2:1"]);
    expect(github.asked).toEqual([7, 8, 9]);
  });
  it("drops an unconfirmed removal (older removal or none) but keeps it for retry within the grace period", async () => {
    const github = lookup({ 7: since - 3 * MIN, 8: null });
    const rejected = new Set<string>();
    expect(await confirmRemovals([removal("queue:1:1", 7), removal("queue:2:1", 8)], emptyRepoState(), github.fn, rejected, now)).toEqual([]);
    expect([...rejected]).toEqual([]);
    // The next loop asks again and sends once GitHub shows the removal.
    github.asked.length = 0;
    const later = lookup({ 7: since + 2 * MIN, 8: null });
    expect(keys(await confirmRemovals([removal("queue:1:1", 7), removal("queue:2:1", 8)], emptyRepoState(), later.fn, rejected, now + MIN))).toEqual(["queue:1:1"]);
    expect(later.asked).toEqual([7, 8]);
  });
  it("gives up 15 minutes after the event, remembers it and never asks again", async () => {
    const github = lookup({ 7: null });
    const rejected = new Set<string>();
    const old = removal("queue:1:1", 7, now);
    expect(await confirmRemovals([old], emptyRepoState(), github.fn, rejected, now + 15 * MIN)).toEqual([]);
    expect([...rejected]).toEqual([]);
    expect(await confirmRemovals([old], emptyRepoState(), github.fn, rejected, now + 15 * MIN + 1)).toEqual([]);
    expect([...rejected]).toEqual(["queue:1:1"]);
    github.asked.length = 0;
    // Even a removal that would be confirmed now stays dropped once rejected.
    const confirming = lookup({ 7: now + 5 * MIN });
    expect(await confirmRemovals([old, removal("queue:2:1", 7)], emptyRepoState(), confirming.fn, rejected, now + 20 * MIN).then(keys)).toEqual(["queue:2:1"]);
    expect(github.asked).toEqual([]);
  });
  it("falls back to sending when the lookup fails", async () => {
    const github = lookup({ 7: new Error("No token"), 8: since + MIN });
    expect(keys(await confirmRemovals([removal("queue:1:1", 7), removal("queue:2:1", 8)], emptyRepoState(), github.fn, new Set(), now))).toEqual(["queue:1:1", "queue:2:1"]);
    const failing = async () => { throw new Error("GraphQL: rate limited"); };
    const rejected = new Set<string>();
    expect(keys(await confirmRemovals([removal("queue:3:1", 9, now - 60 * MIN)], emptyRepoState(), failing, rejected, now))).toEqual(["queue:3:1"]);
    expect([...rejected]).toEqual([]);
  });
  it("does not look up keys that were already sent, and passes other events through untouched", async () => {
    const github = lookup({});
    const state = emptyRepoState();
    state.sent["queue:1:1"] = now - MIN;
    expect(keys(await confirmRemovals([removal("queue:1:1", 7), plain], state, github.fn, new Set(["queue:1:1"]), now))).toEqual(["queue:1:1", "red:1:1"]);
    expect(github.asked).toEqual([]);
  });
  it("passes a removal without a PR (no confirmation data) through", async () => {
    const github = lookup({});
    const [event] = queueRemovalEvents(REPO, [classify(queueJob({ headBranch: "feature" }), "real")]);
    expect(keys(await confirmRemovals([event!], emptyRepoState(), github.fn, new Set(), now))).toEqual(["queue:50:1"]);
    expect(github.asked).toEqual([]);
  });
});

describe("runner loss", () => {
  const lost = (over = {}, minute = 5) => failed({ event: "merge_group", headBranch: "gh-readonly-queue/main/pr-7-abc123", runnerName: "runner-9", annotations: [failure(LOSS)], ...over }, minute);
  it("counts losses on the same head and shows N/limit only with a limit (default-branch push runs)", () => {
    const onMain = { event: "push", headBranch: "main" };
    const classified = [classify(lost({ jobId: 1, ...onMain }), "runner_loss"), classify(lost({ jobId: 2, jobName: "Lint", ...onMain }, 6), "runner_loss"), classify(lost({ jobId: 3, headSha: "f".repeat(40), ...onMain }), "runner_loss")];
    const [first] = runnerLossEvents(REPO, classified, "main", 0);
    expect(first).toMatchObject({ key: "loss:1", dedupe: "once" });
    expect(text(first!)).toBe(`Runner lost · Unit tests · runner runner-9 · 2 losses on head 0123456 · inspect job:1 https://github.com/${REPO}/actions/runs/1/job/1`);
    expect(text(runnerLossEvents(REPO, classified, "main", 3)[0]!)).toContain("· 2/3 losses on head 0123456");
    expect(text(runnerLossEvents(REPO, classified, "main", 3)[2]!)).toContain("· 1/3 losses on head fffffff");
  });
  it("a standalone merge queue loss counts on its head and is announced exactly once", () => {
    const classified = [classify(lost({ jobId: 1 }), "runner_loss"), classify(lost({ jobId: 2, jobName: "Lint" }), "runner_loss")];
    const events = runnerLossEvents(REPO, classified, "main", 3, (runId, attempt) => runId === 1 && attempt === 1);
    expect(events.map((event) => text(event))).toEqual([expect.stringContaining("· 2/3 losses on head 0123456"), expect.stringContaining("· 2/3 losses on head 0123456")]);
    const state = emptyRepoState(), global = emptyGlobal(), config = { enabled: enabledEvents({}), quietMs: 0, batchMs: 0, historyMs: 86_400_000, now: Date.parse(at(30)) };
    syncGlobal(global, ["thr_a"], enabledEvents({}), Date.parse(at(0)));
    expect(acceptEvents(state, global, events, config)).toHaveLength(2);
    expect(acceptEvents(state, global, runnerLossEvents(REPO, classified, "main", 3, () => true), config)).toEqual([]);
  });
  it("covers default-branch push runs, and merge queue runs only when the predicate allows the attempt", () => {
    const push = (over = {}) => classify(lost({ event: "push", headBranch: "main", ...over }), "runner_loss");
    const events = [push({ jobId: 1 }), push({ jobId: 2, headBranch: "release" }), classify(lost({ event: "pull_request", headBranch: "feature", jobId: 3 }), "runner_loss"), classify(lost({ jobId: 4 }), "runner_loss"),
      classify(lost({ jobId: 5 }), "real")];
    expect(runnerLossEvents(REPO, events, "main", 0).map((event) => event.key)).toEqual(["loss:1"]);
    expect(runnerLossEvents(REPO, events, "main", 0, () => true).map((event) => event.key)).toEqual(["loss:1", "loss:4"]);
    expect(runnerLossEvents(REPO, events, "main", 0, (runId, attempt) => runId === 99 && attempt === 1)).toHaveLength(1);
    expect(runnerLossEvents(REPO, [push({ jobId: 1 })], null, 0)).toEqual([]);
    expect(text(runnerLossEvents(REPO, [classify(lost({ jobId: 6, runnerName: null }), "runner_loss")], null, 0, () => true)[0]!)).toContain("runner unknown");
  });
});

describe("default branch red", () => {
  const alert = (over: Partial<CiInsights["alerts"][number]> = {}): CiInsights["alerts"][number] => ({ kind: "main", workflowId: 1, name: "CI", branch: "main", runId: 70, createdAt: at(0), consecutive: 1, ...over });
  const onMain = (over = {}, minute = 5) => failed({ event: "push", headBranch: "main", runId: 70, ...over }, minute);
  it("counts classes and gives the Investigate verdict", () => {
    const real = [classify(onMain({ jobId: 1 }), "real"), classify(onMain({ jobId: 2 }), "consequence"), classify(onMain({ jobId: 3 }), "consequence")];
    const [event] = defaultRedEvents(REPO, real, [alert()]);
    expect(event).toMatchObject({ key: "red:70:1", type: "red", at: Date.parse(at(5)) });
    expect(text(event!)).toBe(`CI red on main · jobs: 1 real, 2 consequence · Code looks broken: yes · inspect run:70:1 https://github.com/${REPO}/actions/runs/70`);
    expect(text(defaultRedEvents(REPO, [classify(onMain({ jobId: 1 }), "flake")], [alert()])[0]!)).toContain("jobs: 1 flake · Code looks broken: no (red on flakes only)");
    expect(text(defaultRedEvents(REPO, [classify(onMain({ jobId: 1 }), "unknown")], [alert()])[0]!)).toContain("Code looks broken: unknown");
  });
  it("uses the failure streak like Investigate, waits for stored jobs and ignores other alerts", () => {
    const classified = [classify(onMain({ jobId: 1, runId: 70 }), "flake"), classify(onMain({ jobId: 2, runId: 69 }), "real")];
    expect(text(defaultRedEvents(REPO, classified, [alert()], new Map([[70, [70, 69]]]))[0]!)).toContain("jobs: 1 flake · Code looks broken: yes");
    expect(text(defaultRedEvents(REPO, classified, [alert()], new Map([[70, [70, 68]]]))[0]!)).toContain("Code looks broken: unknown");
    expect(defaultRedEvents(REPO, [], [alert()])).toEqual([]);
    expect(defaultRedEvents(REPO, classified, [alert({ kind: "streak" })])).toEqual([]);
    expect(defaultRedEvents(REPO, [classify(onMain({ jobId: 1, attempt: 2 }), "real"), classify(onMain({ jobId: 2 }), "flake")], [alert()]).map((event) => event.key)).toEqual(["red:70:2"]);
  });
});

describe("pool stall and mass cancel", () => {
  const signal = (over: Partial<Signal> = {}): Signal => ({ id: "pool_stall:self-hosted", kind: "pool_stall", severity: "critical", title: "", what: "", where: { pool: "self-hosted" }, since: at(0), until: null, impact: "", actor: "owner_sre", open: true, ...over });
  it("describes a stall from the live pool state", () => {
    const event = stallEvent(signal(), [{ pool: "self-hosted", queued: 12, inProgress: 0, oldestQueuedAt: at(0), lastStartedAt: null, queuedRunIds: [1] }], Date.parse(at(14, 30)));
    expect(event).toMatchObject({ key: "pool_stall:self-hosted", type: "stall", dedupe: "quiet", at: Date.parse(at(14, 30)) });
    expect(text(event)).toBe("Pool self-hosted stalled · 12 queued, no job start for 14 min · inspect pool:self-hosted");
  });
  it("describes a mass cancel with its pool and runs, or nothing when the group is gone", () => {
    const jobs = [1, 2, 3].map((i) => classify(failed({ jobId: i, runId: 10 + i, runnerName: `runner-${i}`, annotations: [failure(LOSS)] }, 5), "runner_loss"));
    const groups = detectMassCancel(jobs);
    const opened = signal({ id: `mass_cancel:${groups[0]!.since}`, kind: "mass_cancel", where: { pool: "self-hosted" } });
    expect(text(massCancelEvent(opened, groups)!)).toBe("3 jobs lost/cancelled within 2 min in self-hosted · 3 runs · inspect run:13");
    expect(text(massCancelEvent({ ...opened, where: {} }, groups)!)).toBe("3 jobs lost/cancelled within 2 min · 3 runs · inspect run:13");
    expect(massCancelEvent(opened, [])).toBeNull();
  });
});

describe("deployments", () => {
  const now = Date.parse("2026-11-06T12:00:00Z"), since = now - 14 * 86_400_000;
  const api = (deployments: object[], statuses: Record<number, object[]>) => { const paths: string[] = []; return { paths, request: async (path: string) => { paths.push(path); const id = path.match(/deployments\/(\d+)\/statuses/)?.[1]; return { body: id ? statuses[Number(id)] ?? [] : deployments, hasNext: false }; } }; };
  const row = (id: number, created = "2026-11-06T11:00:00Z", environment: string | null = "production") => ({ id, environment, sha: "abcdef0123456789", created_at: created });
  it("labels a failed deployment whose run only refused on a gate step as refused, waits for unstored runs, and keeps real failures", async () => {
    const failing = (id: number, run: number) => ({ [id]: [{ state: "failure", created_at: "2026-11-06T11:55:00Z", log_url: `https://github.com/acme/widgets/actions/runs/${run}/job/1` }] });
    const github = api([row(1), row(2), row(3)], { ...failing(1, 41), ...failing(2, 42), ...failing(3, 43) });
    const classified = [{ ...classify(job({ runId: 41, jobId: 7, conclusion: "failure", failedSteps: ["Admit gate"] }), "refused"), evidence: "Admit gate" }, classify(job({ runId: 41, jobId: 8, jobName: "Summary", conclusion: "failure" }), "consequence"),
      classify(job({ runId: 42, jobId: 9, conclusion: "failure", failedSteps: ["Build"] }), "real")];
    const state = emptyRepoState();
    const events = await deploymentEvents({ request: github.request, repository: REPO, state, since, now, runOutcome: deployRunOutcome(classified) });
    expect(events.map((event) => text(event)).sort()).toEqual([
      "Deploy production failure · abcdef0 · deployment 2 https://github.com/acme/widgets/actions/runs/42/job/1",
      "Deploy production refused (Admit gate) · abcdef0 · deployment 1 https://github.com/acme/widgets/actions/runs/41/job/1"]);
    // Run 43 has no stored jobs yet: not sent and not remembered, so it is looked at again; after the wait it goes out as a failure.
    expect(state.deploys["3"]).toBeUndefined();
    const later = await deploymentEvents({ request: github.request, repository: REPO, state, since, now: now + 11 * 60_000, runOutcome: deployRunOutcome(classified) });
    expect(later.map((event) => text(event))).toEqual(["Deploy production failure · abcdef0 · deployment 3 https://github.com/acme/widgets/actions/runs/43/job/1"]);
  });
  it("reports a deployment once, when its newest status is final", async () => {
    const state = emptyRepoState();
    const github = api([row(1), row(2), row(3), row(4), row(5, "2026-10-01T00:00:00Z")], { 1: [{ state: "success", created_at: "2026-11-06T11:05:00Z", log_url: "https://github.com/acme/widgets/actions/runs/9" }], 2: [{ state: "in_progress", created_at: "2026-11-06T11:05:00Z" }], 3: [{ state: "failure", created_at: "2026-11-06T11:06:00Z" }], 4: [] });
    const events = await deploymentEvents({ request: github.request, repository: REPO, state, since, now });
    expect(events.map((event) => event.key).sort()).toEqual(["deploy:1:success", "deploy:3:failure"]);
    expect(text(events.find((event) => event.key === "deploy:1:success")!)).toBe("Deploy production success · abcdef0 · deployment 1 https://github.com/acme/widgets/actions/runs/9");
    expect(text(events.find((event) => event.key === "deploy:3:failure")!)).toBe("Deploy production failure · abcdef0 · deployment 3");
    expect(events.find((event) => event.key === "deploy:1:success")!.at).toBe(Date.parse("2026-11-06T11:05:00Z"));
    // The old deployment is outside the window: no status request for it.
    expect(github.paths.filter((path) => path.includes("/deployments/5/"))).toEqual([]);
    // Final ones are remembered and cost no further requests; the in-progress one is asked again.
    github.paths.length = 0;
    expect(await deploymentEvents({ request: github.request, repository: REPO, state, since, now })).toEqual([]);
    expect(github.paths.filter((path) => path.includes("/statuses"))).toEqual(["/repos/acme/widgets/deployments/2/statuses?per_page=1", "/repos/acme/widgets/deployments/4/statuses?per_page=1"]);
  });
  it("treats superseded deployments as settled, names a missing environment and stops when the budget is gone", async () => {
    const state = emptyRepoState();
    expect(await deploymentEvents({ request: api([row(1)], { 1: [{ state: "inactive", created_at: "2026-11-06T11:05:00Z" }] }).request, repository: REPO, state, since, now })).toEqual([]);
    expect(Object.keys(state.deploys)).toEqual(["1"]);
    const unnamed = await deploymentEvents({ request: api([row(2, undefined, null)], { 2: [{ state: "error", created_at: "2026-11-06T11:05:00Z" }] }).request, repository: REPO, state, since, now });
    expect(text(unnamed[0]!)).toContain("Deploy unknown error");
    let calls = 0;
    const starved = async (path: string) => { if (path.includes("/statuses")) { calls++; throw new Error("Budget exhausted"); } return { body: [row(3), row(4)], hasNext: false }; };
    expect(await deploymentEvents({ request: starved, repository: REPO, state, since, now })).toEqual([]);
    expect(calls).toBe(1);
    const capped = api(Array.from({ length: 30 }, (_, i) => row(100 + i)), {});
    await deploymentEvents({ request: capped.request, repository: REPO, state, since, now, maxStatuses: 3 });
    expect(capped.paths.filter((path) => path.includes("/statuses"))).toHaveLength(3);
  });
  it("forgets deployments older than the window", async () => {
    const state = { ...emptyRepoState(), deploys: { "1": since - 1, "2": since + 1 } };
    await deploymentEvents({ request: api([], {}).request, repository: REPO, state, since, now });
    expect(Object.keys(state.deploys)).toEqual(["2"]);
  });
});

describe("noise control", () => {
  const T0 = Date.parse("2026-11-06T12:00:00Z"), MIN = 60_000;
  const config = (over: Partial<ObserverConfig> = {}): ObserverConfig => ({ enabled: enabledEvents({}), quietMs: 30 * MIN, batchMs: 0, historyMs: 15 * 86_400_000, now: T0, ...over });
  const event = (key: string, over: Partial<ObserverEvent> = {}): ObserverEvent => ({ type: "queue", key, at: T0, dedupe: "once", render: () => `event ${key}`, ...over });
  const state = (threads: string[], types: ObserverType[] = ["queue", "stall"], now = T0 - 60 * MIN) => { const global = emptyGlobal(); syncGlobal(global, threads, Object.fromEntries(["queue", "loss", "red", "stall", "mass", "deploy"].map((t) => [t, types.includes(t as ObserverType)])) as Record<ObserverType, boolean>, now); return global; };
  const rendered = (events: ObserverEvent[]): Rendered[] => events.map((e) => ({ key: e.key, type: e.type, at: e.at, text: e.render() }));

  it("seeds: only events after the thread subscribed and the type was switched on are sent, and a type switched off and on starts again from now", () => {
    const global = emptyGlobal(), on = enabledEvents({}), off = { ...on, queue: false };
    expect(syncGlobal(global, ["thr_a"], on, T0)).toEqual(["thr_a"]);
    expect(global.types.queue).toBe(T0);
    const repo = emptyRepoState();
    const history = event("queue:1:1", { at: T0 - 1 }), fresh = event("queue:2:1", { at: T0 + 1 });
    expect(acceptEvents(repo, global, [history, fresh], config({ now: T0 + 10 })).map((e) => e.key)).toEqual(["queue:2:1"]);
    // Type off, then on again later: events from the gap are history.
    syncGlobal(global, ["thr_a"], off, T0 + 5 * MIN);
    expect(global.types.queue).toBeUndefined();
    expect(acceptEvents(emptyRepoState(), global, [fresh], config({ enabled: off, now: T0 + 6 * MIN }))).toEqual([]);
    expect(syncGlobal(global, ["thr_a"], on, T0 + 10 * MIN)).toEqual([]);
    expect(acceptEvents(emptyRepoState(), global, [event("queue:3:1", { at: T0 + 7 * MIN })], config({ now: T0 + 11 * MIN }))).toEqual([]);
    expect(acceptEvents(emptyRepoState(), global, [event("queue:4:1", { at: T0 + 12 * MIN })], config({ now: T0 + 12 * MIN })).map((e) => e.key)).toEqual(["queue:4:1"]);
    // Removing every thread switches the feature off; a new subscriber starts from its own time.
    syncGlobal(global, [], on, T0 + 20 * MIN);
    expect(global).toEqual({ threads: {}, types: {} });
  });
  it("sends a key once, also after a restart (state round-trips through JSON), and forgets keys after the history window", () => {
    const global = state(["thr_a"]), repo = emptyRepoState();
    expect(acceptEvents(repo, global, [event("queue:1:1"), event("queue:1:1")], config())).toHaveLength(1);
    const restarted = repoStateSchema.parse(JSON.parse(JSON.stringify(repo)));
    expect(acceptEvents(restarted, global, [event("queue:1:1")], config({ now: T0 + 5 * 24 * 60 * MIN }))).toEqual([]);
    expect(acceptEvents(restarted, global, [event("queue:1:1", { at: T0 + 20 * 24 * 60 * MIN })], config({ now: T0 + 20 * 24 * 60 * MIN })).map((e) => e.key)).toEqual(["queue:1:1"]);
  });
  it("repeats a reopening key only after the quiet window; quiet 0 repeats it at once", () => {
    const global = state(["thr_a"]), repo = emptyRepoState(), stall = (now: number) => event("pool_stall:p", { type: "stall", dedupe: "quiet", at: now });
    expect(acceptEvents(repo, global, [stall(T0)], config())).toHaveLength(1);
    expect(acceptEvents(repo, global, [stall(T0 + 10 * MIN)], config({ now: T0 + 10 * MIN }))).toEqual([]);
    expect(acceptEvents(repo, global, [stall(T0 + 31 * MIN)], config({ now: T0 + 31 * MIN }))).toHaveLength(1);
    expect(acceptEvents(repo, global, [stall(T0 + 32 * MIN)], config({ now: T0 + 32 * MIN, quietMs: 0 }))).toHaveLength(1);
  });
  it("drops events of disabled types", () => {
    const global = state(["thr_a"], ["queue", "stall"]);
    expect(acceptEvents(emptyRepoState(), global, [event("a"), event("b", { type: "stall" })], config({ enabled: { ...enabledEvents({}), stall: false } })).map((e) => e.key)).toEqual(["a"]);
    expect(acceptEvents(emptyRepoState(), global, [event("c", { type: "loss" })], config())).toEqual([]);
  });
  it("sends each event as its own message to every subscribed thread, but never history to a late subscriber", () => {
    const global = state(["thr_a"], ["queue"], T0 - 60 * MIN);
    global.threads.thr_late = T0 + 1;
    const repo = emptyRepoState(), items = rendered([event("old"), event("new", { at: T0 + 2 })]);
    expect(dispatch(repo, items, global, { batchMs: 0, now: T0 + 3 })).toEqual([
      { threadId: "thr_a", text: "[CI Dashboard] event old" }, { threadId: "thr_a", text: "[CI Dashboard] event new" }, { threadId: "thr_late", text: "[CI Dashboard] event new" }]);
  });
  it("batches into one digest every N minutes, one line per event, and flushes leftovers when batching is switched off", () => {
    const global = state(["thr_a"]), repo = emptyRepoState();
    expect(dispatch(repo, rendered([event("a")]), global, { batchMs: 10 * MIN, now: T0 })).toEqual([]);
    expect(repo.pending).toHaveLength(1);
    expect(dispatch(repo, rendered([event("b")]), global, { batchMs: 10 * MIN, now: T0 + 5 * MIN })).toEqual([]);
    const digest = dispatch(repo, [], global, { batchMs: 10 * MIN, now: T0 + 10 * MIN });
    expect(digest).toEqual([{ threadId: "thr_a", text: "[CI Dashboard] 2 CI events\n- event a\n- event b" }]);
    expect(repo).toMatchObject({ pending: [], pendingSince: null });
    expect(dispatch(repo, rendered([event("c")]), global, { batchMs: 10 * MIN, now: T0 + 11 * MIN })).toEqual([]);
    expect(dispatch(repo, [], global, { batchMs: 0, now: T0 + 12 * MIN })).toEqual([{ threadId: "thr_a", text: "[CI Dashboard] event c" }]);
    // A huge digest is capped.
    const many = Array.from({ length: 40 }, (_, i) => event(`e${i}`));
    const big = emptyRepoState();
    dispatch(big, rendered(many), global, { batchMs: MIN, now: T0 });
    const flushed = dispatch(big, [], global, { batchMs: MIN, now: T0 + MIN });
    expect(flushed[0]!.text.split("\n")).toHaveLength(1 + 30 + 1);
    expect(flushed[0]!.text).toContain("- … +10 more");
  });
  it("confirms a subscription in one line", () => {
    expect(subscriptionNotice(["acme/widgets"], { ...enabledEvents({}), deploy: false, mass: false }, 30, 0)).toBe("[CI Dashboard] Subscribed to CI events for acme/widgets: merge queue removals, runner losses, default-branch red, pool stalls; quiet window 30 min");
    expect(subscriptionNotice([], enabledEvents({ observeQueueRemoval: false, observeRunnerLoss: false, observeDefaultRed: false, observePoolStall: false, observeMassCancel: false, observeDeployments: false }), 0, 15)).toBe("[CI Dashboard] Subscribed to CI events for no repositories: no event types; quiet window 0 min; digest every 15 min");
  });
});

describe("safety", () => {
  const SECRET = "hunter2-super-secret";
  it("never puts log text, annotations, signature matches or env values into a line", () => {
    const hostile = queueJob({
      annotations: [failure(`env:\n  API_TOKEN: ${SECRET}\nProcess completed with exit code 1.`)],
      logExcerpt: `env:\n  API_TOKEN: ${SECRET}\n##[error]boom`,
      signature: { rules: "x", label: "FLAKE-1", match: `API_TOKEN=${SECRET}`, source: "log" },
    });
    const classified: ClassifiedJob[] = [{ job: hostile, class: "flake", reason: "matches a known flaky signature", evidence: `FLAKE-1: API_TOKEN=${SECRET}`, flakeLabel: "FLAKE-1" }];
    const lines = [...queueRemovalEvents(REPO, classified), ...runnerLossEvents(REPO, [{ ...classified[0]!, class: "runner_loss" }], "main", 5, () => true),
      ...defaultRedEvents(REPO, [{ ...classified[0]!, job: { ...hostile, runId: 70, event: "push", headBranch: "main" } }], [{ kind: "main", workflowId: 1, name: "CI", branch: "main", runId: 70, createdAt: at(0), consecutive: 1 }])].map((event) => text(event, ["suite.test"]));
    expect(lines).toHaveLength(3);
    for (const line of lines) { expect(line).not.toContain(SECRET); expect(line).not.toContain("env:"); expect(line).not.toContain("API_TOKEN"); expect(line).not.toContain("##[error]"); expect(line.length).toBeLessThanOrEqual(400); }
    expect(lines[0]).toContain("FLAKE-1");
  });
  it("collapses control characters and whitespace from names", () => {
    expect(fit("a\nb\t c  d")).toBe("a b c d");
    expect(fit("x".repeat(500), "https://example.test/u").length).toBe(400);
  });
});

describe("problem ids in event lines", () => {
  const stall = { id: "pool_stall:self-hosted", kind: "pool_stall", severity: "critical", title: "", what: "", where: { pool: "self-hosted" }, since: at(0), until: null, impact: "", actor: "owner_sre", open: true } satisfies Signal;
  it("candidate ids match the problem ids; the id is appended only when the caller passes it", () => {
    const event = stallEvent(stall, [], Date.parse(at(14)));
    expect(event.problem).toBe("pool_stall:self-hosted");
    expect(text(event)).toBe("Pool self-hosted stalled · 0 queued, no job start for 14 min · inspect pool:self-hosted");
    expect(event.render(null, event.problem)).toBe("Pool self-hosted stalled · 0 queued, no job start for 14 min · problem pool_stall:self-hosted · inspect pool:self-hosted");
    const loss = runnerLossEvents(REPO, [classify(failed({ event: "push", headBranch: "main", jobId: 9, annotations: [failure(LOSS)] }), "runner_loss")], "main", 0)[0]!;
    expect(loss.problem).toBe("runner_loss:9");
    expect(loss.render(null, loss.problem)).toMatch(/ · problem runner_loss:9 · inspect job:9 https:\/\/github\.com\/acme\/widgets\/actions\/runs\/1\/job\/9$/);
    const red = defaultRedEvents(REPO, [classify(failed({ event: "push", headBranch: "main", runId: 70 }), "real")], [{ kind: "main", workflowId: 1, name: "CI", branch: "main", runId: 70, createdAt: at(0), consecutive: 1 }])[0]!;
    expect(red.problem).toBe("run:main:70");
    expect(red.render(null, red.problem)).toMatch(/Code looks broken: yes · problem run:main:70 · inspect run:70:1 https:\/\/github\.com\/acme\/widgets\/actions\/runs\/70$/);
    // Queue removals are never problems.
    expect(queueRemovalEvents(REPO, [classify(failed({ event: "merge_group", headBranch: "gh-readonly-queue/main/pr-7-abc", runId: 50 }), "real")])[0]!.problem).toBeUndefined();
  });
  it("keeps the 400-character cap, the tag and the link when the body is long", () => {
    const line = fit("x".repeat(500), "https://example.test/u", " · problem run:main:70");
    expect(line.length).toBe(400);
    expect(line.endsWith(" · problem run:main:70 https://example.test/u")).toBe(true);
  });
});

describe("inspect refs in event lines", () => {
  it("every line ends its body with `inspect <ref>` (a ref ci_dashboard_metrics accepts), keeps one link and stays within 400 characters", () => {
    const long = "x".repeat(300), tests = [long, long, long, long];
    const queue = queueRemovalEvents(REPO, [classify(queueJob({ jobName: long }), "real")])[0]!;
    const loss = runnerLossEvents(REPO, [classify(failed({ event: "push", headBranch: "main", jobId: 9, jobName: long }), "runner_loss")], "main", 3)[0]!;
    const red = defaultRedEvents(REPO, [classify(failed({ event: "push", headBranch: "main", runId: 70 }), "real")], [{ kind: "main", workflowId: 1, name: long, branch: "main", runId: 70, createdAt: at(0), consecutive: 1 }])[0]!;
    const stall = stallEvent({ id: `pool_stall:${long}`, kind: "pool_stall", severity: "critical", title: "", what: "", where: { pool: "p" }, since: at(0), until: null, impact: "", actor: "owner_sre", open: true }, [], Date.parse(at(14)));
    const mass = massCancelEvent({ id: "mass_cancel:t", kind: "mass_cancel", severity: "critical", title: "", what: "", where: { pool: "p" }, since: "t", until: null, impact: "", actor: "owner_sre", open: true },
      [{ since: "t", until: at(1), runners: ["a"], runIds: [11, 12], jobs: [classify(failed(), "runner_loss")] }])!;
    for (const [event, ref] of [[queue, "queue:50:1"], [loss, "job:9"], [red, "run:70:1"], [stall, "pool:p"], [mass, "run:12"]] as const) {
      const line = event.render(tests, event.problem);
      expect(line, ref).toMatch(new RegExp(` · inspect ${ref}( https://\\S+)?$`));
      expect(parseRef(ref)).toBeTruthy();
      expect(line.length).toBeLessThanOrEqual(400);
      expect(line.match(/https:\/\//g)?.length ?? 0).toBeLessThanOrEqual(1);
    }
  });
});

describe("inherited merge queue failures", () => {
  const BUILD = "build or setup failed";
  const inherited = (over = {}) => ({ ...classify(queueJob({ inheritedFrom: { pullRequest: 6, runId: 49 }, ...over }), "real"), reason: `${BUILD}, inherited from #6` });
  it("headlines a removal whose every own failure is inherited, and tags each job", () => {
    const [event] = queueRemovalEvents(REPO, [inherited(), inherited({ jobName: "Lint", jobId: 501 }), classify(queueJob({ jobName: "CI summary", jobId: 502 }), "consequence")]);
    expect(text(event!)).toBe(`PR #7 removed (inherited from #6) · Unit tests: real (${BUILD}) inherited from #6, Lint: real (${BUILD}) inherited from #6, CI summary: consequence · inspect queue:50:1 ${RUN_URL}`);
  });
  it("keeps the plain headline when only some failures are inherited or the origins differ", () => {
    const own = { ...classify(queueJob({ jobName: "Lint", jobId: 501 }), "real"), reason: BUILD };
    expect(text(queueRemovalEvents(REPO, [inherited(), own])[0]!)).toContain("PR #7 removed from merge queue · Unit tests: real (build or setup failed) inherited from #6, Lint: real (build or setup failed) ·");
    expect(text(queueRemovalEvents(REPO, [inherited(), inherited({ jobName: "Lint", jobId: 501, inheritedFrom: { pullRequest: 5, runId: 48 } })])[0]!)).toContain("PR #7 removed from merge queue");
  });
  it("stays inside 400 characters", () => {
    const jobs = Array.from({ length: 6 }, (_, i) => inherited({ jobName: `A fairly long job name ${i}`, jobId: 600 + i }));
    const line = text(queueRemovalEvents(REPO, jobs)[0]!, ["x".repeat(300)]);
    expect(line.length).toBeLessThanOrEqual(400);
    expect(line.endsWith(RUN_URL)).toBe(true);
  });
});

