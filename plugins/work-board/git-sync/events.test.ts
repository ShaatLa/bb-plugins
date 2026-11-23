import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MANAGER, setup as attentionSetup } from "../attention/fixtures";
import { registerTasksCli } from "../cli";
import { historyLimits, receiptPolling } from "../steer";
import { prSnapshotSchema, type PrSnapshot } from "../shared/git-sync";
import { createGitSyncService } from "./service";
import { createGithubClient, GithubError, type DeployRun } from "./github";
import { claimLease, ciVerdict, createPrEventService, deployBudgets, prEventService, recordPrEvents, setPrEventSetting } from "./events";
import { createGitSyncStore } from "./store";

const URL = "https://github.com/owner/repo/pull/7";
const DAY = 86_400_000;
const a = "a".repeat(40), b = "b".repeat(40), c = "c".repeat(40), m = "d".repeat(40), x = "e".repeat(40);
const fixtures: { dispose: () => unknown }[] = [];
const budgets = structuredClone(deployBudgets);
const limits = { ...historyLimits };
const lease = { ...claimLease };
beforeEach(() => { receiptPolling.tries = 1; receiptPolling.delayMs = 0; });
afterEach(async () => {
  Object.assign(deployBudgets, structuredClone(budgets));
  Object.assign(historyLimits, limits);
  Object.assign(claimLease, lease);
  vi.useRealTimers();
  await Promise.all(fixtures.splice(0).map((f) => f.dispose()));
});

type Check = PrSnapshot["checks"][number];
const check = (name: string, state: Check["state"], extra: Partial<Check> = {}): Check => ({ name, app: "actions", appId: 1, sha: a, url: null, state, required: true, ...extra });
const snap = (extra: Partial<PrSnapshot> = {}): PrSnapshot => prSnapshotSchema.parse({
  repository: "owner/repo", number: 7, remoteId: "PR_7", url: URL, title: "EXA work", state: "open", headSha: a, mergeSha: null, mergedAt: null,
  baseBranch: "main", updatedAt: new Date().toISOString(), observedAt: new Date().toISOString(), checks: [], requirementsKnown: true, ci: "no_checks",
  mergeState: null, mergeable: true, review: null, unresolvedThreads: null, coverage: [], queueEntryId: null, ...extra,
});
const run = (id: number, extra: Partial<DeployRun> = {}): DeployRun => ({
  id, workflowId: 11, name: "deploy", headSha: m, headBranch: "main", event: "push", status: "completed", conclusion: "success",
  createdAt: new Date(Date.now() - DAY / 2).toISOString(), updatedAt: new Date(Date.now() - DAY / 2 + 60_000).toISOString(), attempt: 1, ...extra,
});

function setup(config: Record<string, unknown> = {}) {
  const f = attentionSetup();
  registerTasksCli(f.bb, f.store, { name: "Work Board", version: "test" });
  f.threads.sendMode = "inline";
  let next = snap();
  const runs: DeployRun[] = [];
  const client = {
    discover: vi.fn(async () => []),
    referenceText: vi.fn(async () => ""),
    snapshot: vi.fn(async () => structuredClone(next)),
    queueRemovals: vi.fn(async (_repository: string, _number: number, _after: string | null, _before: string): Promise<{ id: string; createdAt: string; reason: string | null }[]> => []),
    // GitHub lists runs created in an inclusive range newest first, with the total count, and serves at most 1,000 of them.
    pushRuns: vi.fn(async (_repository: string, _branch: string, range: string, page: number) => {
      const [lo, hi] = range.split("..").map((value) => Date.parse(value));
      const all = runs.filter((value) => Date.parse(value.createdAt) >= lo! && Date.parse(value.createdAt) < hi! + 1000).sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || right.id - left.id);
      return { total: all.length, runs: page > 10 ? [] : all.slice((page - 1) * 100, page * 100) };
    }),
    workflowRunById: vi.fn(async (_repository: string, id: number) => runs.find((value) => value.id === id)!),
    compareStatus: vi.fn(async (_repository: string, _base: string, head: string) => (head === x ? "diverged" : "ahead")),
  };
  const service = createGitSyncService(f.bb, f.store, client);
  const events = prEventService(f.bb, f.store.tasks);
  service.handlers.setGitSyncConfig({ projectId: f.tracker.id, config: { enabled: true, repositories: ["owner/repo"], titleDiscovery: false, pollMinutes: 5, lookbackDays: 30, requiredChecks: [], prWaitIgnoredChecks: [], postMergeWorkflows: ["deploy"], postMergeDays: 7, ...config } as never });
  const card = (title = "Work", status: "in_progress" | "in_review" | "done" = "in_review", worker = "thr_worker") => {
    const task = f.card(title, status);
    service.remember(task.id, URL, "manual", { role: "related", part: null });
    if (worker) {
      f.store.tasks.upsertTaskThread({ taskId: task.id, threadId: worker, presetName: "Worker", title: "W", liveStatus: "working" });
      f.threads.threads.set(worker, { status: "active" });
    }
    return f.store.tasks.getTask(task.id)!;
  };
  const sync = async (value: Partial<PrSnapshot> = {}) => {
    next = snap({ ...next, ...value, observedAt: new Date().toISOString() });
    await service.syncProject(f.tracker.id, true);
    await events.drain();
  };
  const to = (threadId: string) => f.threads.requests.filter((request) => request.threadId === threadId).map((request) => request.text.split("\n\n")[1]!);
  const deliveries = () => f.db.prepare<[], { kind: string; role: string; state: string; task_id: string; attempts: number; thread_id: string | null }>(
    "SELECT e.kind, d.role, d.state, d.task_id, d.attempts, d.thread_id FROM pr_event_deliveries d JOIN pr_events e ON e.id=d.event_id ORDER BY d.created_at, d.role DESC").all();
  const waits = () => f.db.prepare<[], { state: string; deadline: string; kept: string; final_passes: number; found: string | null; baseline_at: string | null }>("SELECT * FROM pr_deploy_waits").all();
  /** Move the wait's deadline, as if the clock had passed it. */
  const deadline = (at: number) => f.db.prepare("UPDATE pr_deploy_waits SET deadline=?").run(new Date(at).toISOString());
  /** A sweep with every wait due, as if its own poll interval had passed. */
  const sweep = async () => {
    f.db.prepare("UPDATE pr_deploy_waits SET next_sweep_at=NULL").run();
    await service.sweep(f.tracker.id);
    await events.drain();
  };
  const result = { ...f, client, service, events, card, sync, to, deliveries, waits, runs, deadline, sweep, set: (value: PrSnapshot) => { next = value; } };
  fixtures.push(result);
  return result;
}
const green = (head = a) => ({ headSha: head, checks: [check("lint", "passed", { sha: head }), check("unit-tests", "passed", { sha: head })] });
const red = (head = a) => ({ headSha: head, checks: [check("lint", "failed", { sha: head }), check("unit-tests", "failed", { sha: head })] });

describe("CI verdict", () => {
  const config = { prWaitIgnoredChecks: ["gate"] };
  it("needs known requirements, a required set and terminal results", () => {
    expect(ciVerdict(snap({ checks: [check("ci", "passed")], requirementsKnown: false }), config)).toBeNull();
    expect(ciVerdict(snap({ checks: [check("ci", "passed", { required: false })] }), config)).toBeNull();
    expect(ciVerdict(snap({ checks: [check("gate", "pending")] }), config)).toBeNull();
    // A required app that has not reported shows as a synthetic pending check.
    expect(ciVerdict(snap({ checks: [check("ci", "passed"), check("ci", "pending", { app: "required", appId: 9 })] }), config)).toBeNull();
    expect(ciVerdict(snap({ checks: [check("lint", "failed"), check("ci", "pending")] }), config)).toBeNull();
    expect(ciVerdict(snap({ checks: [check("ci", "unknown")] }), config)).toBeNull();
  });
  it("counts neutral and skipped as passed, cancelled as failed, and leaves ignored gates out", () => {
    expect(ciVerdict(snap({ checks: [check("ci", "neutral"), check("e2e", "skipped"), check("gate", "pending")] }), config)).toEqual({ verdict: "green", failed: [] });
    expect(ciVerdict(snap({ checks: [check("ci", "cancelled"), check("lint", "passed")] }), config)).toEqual({ verdict: "red", failed: ["ci"] });
  });
});

describe("transitions", () => {
  it("baselines the first sight, then sends each head's verdict once", async () => {
    const f = setup();
    const task = f.card();
    await f.sync(green());
    await f.sync();
    expect(f.to("thr_worker")).toEqual([]);
    await f.sync(red(b));
    expect(f.to("thr_worker")).toEqual([`${task.key} · PR #7 CI red on bbbbbbb: failed lint, unit-tests.`]);
    await f.sync(green(b));
    await f.sync(red(b));
    // Green on a new head is its own event even though the last verdict was green too.
    await f.sync(green(c));
    expect(f.to("thr_worker").slice(1)).toEqual([`${task.key} · PR #7 CI green on bbbbbbb (required checks passed).`, `${task.key} · PR #7 CI green on ccccccc (required checks passed).`]);
    // Pruned delivery history does not free a once-key: a same-head rerun that repeats a verdict stays quiet.
    f.events.prune(Date.now() + 31 * DAY);
    expect(f.deliveries()).toEqual([]);
    await f.sync(red(c));
    await f.sync(green(c));
    expect(f.to("thr_worker")).toHaveLength(4);
  });

  it("sends nothing for a failed refresh, and a rolled-back snapshot leaves no rows", async () => {
    const f = setup();
    f.card();
    await f.sync(green());
    f.client.snapshot.mockRejectedValueOnce(new GithubError(502, "down"));
    await f.sync(red(b));
    expect(f.to("thr_worker")).toEqual([]);
    f.db.exec("CREATE TEMP TRIGGER boom AFTER INSERT ON pr_events BEGIN SELECT RAISE(ABORT, 'boom'); END;");
    await f.sync(red(b));
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM pr_events").get()).toEqual({ n: 0 });
    expect(createGitSyncStore(f.db).snapshot(f.tracker.id, { repository: "owner/repo", number: 7 }).snapshot?.headSha).toBe(a);
    f.db.exec("DROP TRIGGER boom");
    await f.sync();
    expect(f.to("thr_worker")).toHaveLength(1);
  });

  it("keeps event state across a repository rename", async () => {
    const f = setup();
    f.card();
    await f.sync(red());
    await f.sync({ ...red(), repository: "owner/renamed", url: "https://github.com/owner/renamed/pull/7" });
    expect(f.to("thr_worker")).toEqual([]);
    await f.sync(green());
    expect(f.to("thr_worker")).toHaveLength(1);
  });

  it("sends merged once the merge SHA is known", async () => {
    const f = setup({ postMergeWorkflows: [] });
    const task = f.card();
    await f.sync();
    await f.sync({ state: "merged", mergedAt: "2026-01-01T12:00:00Z", mergeSha: null });
    expect(f.to("thr_worker")).toEqual([]);
    await f.sync({ mergeSha: m });
    await f.sync();
    expect(f.to("thr_worker")).toEqual([`${task.key} · PR #7 merged as ddddddd at 2026-01-01 12:00 UTC.`]);
    // An empty workflow list arms no wait.
    expect(f.waits()).toEqual([]);
  });
});

describe("merge queue", () => {
  // Inside the interval and clear of both observations' seconds.
  const removal = (id: string, reason: string | null = "CI_FAILED", createdAt = new Date(Math.floor((Date.now() - 1_800_000) / 1000) * 1000).toISOString()) => ({ id, createdAt, reason });
  /** Date the last queued sighting an hour back, as a poll interval apart would. */
  const ageSighting = (f: ReturnType<typeof setup>) => {
    const at = new Date(Date.now() - 3_600_000).toISOString();
    f.db.prepare("UPDATE pr_event_state SET queue_seen_at=?").run(at);
    return at;
  };
  it("reads the removal reason only on a departure, once per PR, and names each removal", async () => {
    const f = setup();
    const first = f.card("One"), second = f.card("Two", "in_review", "thr_other");
    await f.sync({ queueEntryId: "MQE_1" });
    await f.sync();
    await f.sync({ queueEntryId: undefined });
    const seenAt = ageSighting(f);
    expect(f.client.queueRemovals).not.toHaveBeenCalled();
    f.client.queueRemovals.mockResolvedValueOnce([removal("RE_1")]);
    await f.sync({ queueEntryId: null });
    expect(f.client.queueRemovals).toHaveBeenCalledTimes(1);
    // Bounded by the last queued sighting and this observation.
    expect(f.client.queueRemovals).toHaveBeenCalledWith("owner/repo", 7, seenAt, expect.any(String));
    const [, , after, before] = f.client.queueRemovals.mock.calls[0]!;
    expect(Date.parse(before)).toBeGreaterThan(Date.parse(after!));
    expect(f.to("thr_worker")).toEqual([`${first.key} · PR #7 was removed from the merge queue (reason: CI_FAILED). Head aaaaaaa.`]);
    expect(f.to("thr_other")).toEqual([`${second.key} · PR #7 was removed from the merge queue (reason: CI_FAILED). Head aaaaaaa.`]);
    // The same head queued again, then replaced and gone with an unreadable reason: a second, separate event.
    await f.sync({ queueEntryId: "MQE_2" });
    f.client.queueRemovals.mockRejectedValueOnce(new Error("timeline unavailable"));
    await f.sync({ queueEntryId: "MQE_3" });
    expect(f.to("thr_worker")[1]).toBe(`${first.key} · PR #7 was removed from the merge queue (reason: reason unavailable). Head aaaaaaa.`);
    expect(f.client.queueRemovals).toHaveBeenCalledTimes(2);
  });

  it("falls back to the departed entry when the timeline does not single out one removal", async () => {
    const f = setup();
    const task = f.card();
    await f.sync({ queueEntryId: "MQE_1" });
    f.client.queueRemovals.mockResolvedValueOnce([removal("RE_1"), removal("RE_2", "MANUAL")]);
    await f.sync({ queueEntryId: null });
    expect(f.to("thr_worker")).toEqual([`${task.key} · PR #7 was removed from the merge queue (reason: reason unavailable). Head aaaaaaa.`]);
    expect(f.db.prepare("SELECT once_key FROM pr_events").all()).toEqual([{ once_key: "entry:MQE_1" }]);
    // The removals' own ids stay free for the departures they belong to.
    await f.sync({ queueEntryId: "MQE_2" });
    ageSighting(f);
    f.client.queueRemovals.mockResolvedValueOnce([removal("RE_2", "MANUAL")]);
    await f.sync({ queueEntryId: null });
    expect(f.to("thr_worker")[1]).toBe(`${task.key} · PR #7 was removed from the merge queue (reason: MANUAL). Head aaaaaaa.`);
  });

  it("treats a sole removal in either observation's second as ambiguous", async () => {
    const f = setup();
    const task = f.card();
    await f.sync({ queueEntryId: "MQE_1" });
    // The timeline's whole second matches the last queued sighting: it may be this entry's removal or a later one's.
    const seenAt = ageSighting(f);
    f.client.queueRemovals.mockResolvedValueOnce([removal("RE_B", "MANUAL", new Date(Math.floor(Date.parse(seenAt) / 1000) * 1000).toISOString())]);
    await f.sync({ queueEntryId: null });
    expect(f.to("thr_worker")).toEqual([`${task.key} · PR #7 was removed from the merge queue (reason: reason unavailable). Head aaaaaaa.`]);
    expect(f.db.prepare("SELECT once_key FROM pr_events").all()).toEqual([{ once_key: "entry:MQE_1" }]);
  });

  it("returns removals between both observations' seconds and drops merge-generated ones", async () => {
    const body = { data: { repository: { pullRequest: { timelineItems: { nodes: [
      { id: "RE_old", createdAt: "2026-01-01T00:00:00Z", reason: "CI_FAILED" },
      { id: "RE_new", createdAt: "2026-01-03T00:00:00Z", reason: "MANUAL" },
      { id: "RE_merge", createdAt: "2026-01-03T12:00:00Z", reason: "MERGED" },
      { id: "RE_later", createdAt: "2026-01-04T00:00:00Z", reason: "MANUAL" },
      {},
    ] } } } } };
    const fetcher = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    const client = createGithubClient({ token: async () => "token", signal: new AbortController().signal, fetcher: fetcher as never });
    expect(await client.queueRemovals("owner/repo", 7, "2026-01-02T00:00:00.000Z", "2026-01-03T23:00:00.000Z")).toEqual([{ id: "RE_new", createdAt: "2026-01-03T00:00:00Z", reason: "MANUAL" }]);
    expect(await client.queueRemovals("owner/repo", 7, "2026-01-02T00:00:00.000Z", "2026-01-04T00:00:00.000Z")).toHaveLength(2);
    // A removal in the first observation's second is returned too, for the caller to treat as ambiguous.
    expect(await client.queueRemovals("owner/repo", 7, "2026-01-04T00:00:00.400Z", "2026-01-05T00:00:00.000Z")).toEqual([{ id: "RE_later", createdAt: "2026-01-04T00:00:00Z", reason: "MANUAL" }]);
    expect(await client.queueRemovals("owner/repo", 7, "2026-01-04T00:00:01.000Z", "2026-01-05T00:00:00.000Z")).toEqual([]);
  });
});

describe("post-merge deployment", () => {
  const merged = () => ({ state: "merged" as const, mergeSha: m, mergedAt: new Date(Date.now() - DAY).toISOString() });
  it("sends deployed for a successful descendant after a failed direct run", async () => {
    const f = setup();
    const task = f.card();
    await f.sync();
    await f.sync(merged());
    expect(f.waits()).toMatchObject([{ state: "waiting" }]);
    f.runs.push(run(1, { conclusion: "failure" }), run(2, { headSha: x, createdAt: new Date(Date.now() - DAY / 3).toISOString() }), run(3, { headSha: b, createdAt: new Date(Date.now() - DAY / 4).toISOString(), updatedAt: new Date(Date.now() - DAY / 5).toISOString() }));
    await f.sweep();
    await f.events.drain();
    expect(f.to("thr_worker").at(-1)).toBe(`${task.key} · PR #7: deploy run 3 succeeded with merge ddddddd. Collect the deployment evidence, run the final check and close the card; Work Board does not close it.`);
    expect(f.waits()).toMatchObject([{ state: "deployed" }]);
  });

  it("keeps an older success that a newer failed descendant would mask", async () => {
    const f = setup();
    f.card();
    await f.sync();
    await f.sync(merged());
    f.runs.push(run(1), run(2, { headSha: b, conclusion: "failure", createdAt: new Date(Date.now() - DAY / 4).toISOString() }));
    await f.sweep();
    expect(JSON.parse(f.waits()[0]!.found!)).toMatchObject({ runId: 1 });
  });

  it("counts a success only when it completed by the deadline, also on a delayed final pass", async () => {
    const f = setup();
    const task = f.card();
    await f.sync();
    await f.sync(merged());
    const cutoff = Date.now() - DAY / 4;
    f.runs.push(run(1, { status: "in_progress", conclusion: null }));
    await f.sweep();
    expect(JSON.parse(f.waits()[0]!.kept).map((entry: { id: number }) => entry.id)).toEqual([1]);
    // It succeeded after the cutoff; the sweep runs late, after downtime.
    Object.assign(f.runs[0]!, { status: "completed", conclusion: "success", updatedAt: new Date(cutoff + 60_000).toISOString() });
    f.deadline(cutoff);
    await f.sweep();
    await f.events.drain();
    expect(f.to("thr_worker").at(-1)).toBe(`${task.key} · PR #7: Work Board saw no successful deploy run with merge ddddddd within 7 days; it stopped waiting.`);
    await f.sweep();
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM pr_events WHERE kind='deploy_wait_ended'").get()).toEqual({ n: 1 });
  });

  it("finds a rerun that succeeded in the last minute before the deadline, after a restart", async () => {
    const f = setup();
    f.card();
    await f.sync();
    await f.sync(merged());
    f.runs.push(run(1, { conclusion: "failure" }));
    await f.sweep();
    const cutoff = Date.now() - 60_000;
    Object.assign(f.runs[0]!, { conclusion: "success", attempt: 2, updatedAt: new Date(cutoff - 30_000).toISOString() });
    f.deadline(cutoff);
    await f.sweep();
    expect(f.waits()).toMatchObject([{ state: "deployed" }]);
  });

  it("rechecks every kept run at the final pass: 51 runs where only the oldest succeeds on a rerun", async () => {
    const f = setup();
    f.card();
    await f.sync();
    await f.sync(merged());
    for (let id = 1; id <= 51; id++) f.runs.push(run(id, { conclusion: "failure", createdAt: new Date(Date.now() - DAY / 2 + id * 1000).toISOString() }));
    await f.sweep();
    expect(JSON.parse(f.waits()[0]!.kept)).toHaveLength(51);
    const cutoff = Date.now() - 1000;
    Object.assign(f.runs[0]!, { conclusion: "success", attempt: 2, updatedAt: new Date(cutoff - 10_000).toISOString() });
    f.deadline(cutoff);
    await f.sweep();
    expect(JSON.parse(f.waits()[0]!.found!)).toMatchObject({ runId: 1 });
  });

  it("splits a busy window into frozen ranges and finds a success beyond the first pass's budget while new runs keep arriving", async () => {
    deployBudgets.pass.pages = 3;
    const f = setup();
    f.card();
    await f.sync();
    await f.sync(merged());
    const start = Date.now() - DAY / 2;
    for (let id = 1; id <= 450; id++) f.runs.push(run(id, { name: "other", workflowId: 12, createdAt: new Date(start + id * 1000).toISOString() }));
    f.runs.push(run(500, { createdAt: new Date(start + 500_000).toISOString() }));
    await f.sweep();
    expect(f.waits()).toMatchObject([{ state: "waiting" }]);
    for (let pass = 0; pass < 40 && f.waits()[0]!.state === "waiting"; pass++) {
      f.runs.push(run(9000 + pass, { name: "other", workflowId: 12, createdAt: new Date(Date.now() - pass).toISOString() }));
      await f.sweep();
    }
    expect(JSON.parse(f.waits()[0]!.found!)).toMatchObject({ runId: 500 });
    // Every listing that was examined fit one page, and none reached past the frozen bound into the new arrivals.
    for (const call of f.client.pushRuns.mock.calls) expect(Date.parse(call[2].split("..")[1]!)).toBeLessThan(Date.now() - 50_000);
  });

  it("settles only once every run created before the candidate's completion was examined", async () => {
    deployBudgets.pass.compares = 0;
    const f = setup();
    f.card();
    await f.sync();
    await f.sync(merged());
    const start = Date.now() - DAY / 2;
    // The direct run finished late; a descendant created after it finished earlier and needs a compare to count.
    f.runs.push(run(1, { createdAt: new Date(start).toISOString(), updatedAt: new Date(start + 5 * 3_600_000).toISOString() }),
      run(2, { headSha: b, createdAt: new Date(start + 3_600_000).toISOString(), updatedAt: new Date(start + 2 * 3_600_000).toISOString() }));
    await f.sweep();
    expect(f.waits()).toMatchObject([{ state: "waiting" }]);
    expect(JSON.parse(f.waits()[0]!.found!)).toMatchObject({ runId: 1 });
    deployBudgets.pass.compares = 10;
    await f.sweep();
    expect(f.waits()).toMatchObject([{ state: "deployed" }]);
    expect(JSON.parse(f.waits()[0]!.found!)).toMatchObject({ runId: 2 });
  });

  it("compares completion and deadline as instants, and leaves a success without a completion time unresolved", async () => {
    const f = setup();
    f.card();
    await f.sync();
    await f.sync(merged());
    const deadline = new Date(Math.floor((Date.now() - 3_600_000) / 1000) * 1000);
    f.deadline(deadline.getTime());
    f.runs.push(run(1, { updatedAt: deadline.toISOString().replace(".000Z", "Z") }));
    await f.sweep();
    expect(f.waits()).toMatchObject([{ state: "deployed" }]);
    const other = setup();
    other.card();
    await other.sync();
    await other.sync(merged());
    other.runs.push(run(1, { updatedAt: null }));
    await other.sweep();
    expect(other.waits()).toMatchObject([{ state: "waiting" }]);
    expect(JSON.parse(other.waits()[0]!.kept)).toMatchObject([{ id: 1, unresolved: true }]);
    other.deadline(Date.now() - 120_000);
    for (let pass = 0; pass < 3; pass++) await other.sweep();
    expect(other.waits()).toMatchObject([{ state: "unverifiable" }]);
  });

  it("moves past an unreadable kept run to the next one", async () => {
    deployBudgets.pass.rechecks = 1;
    const f = setup();
    f.card();
    await f.sync();
    await f.sync(merged());
    f.runs.push(run(1, { conclusion: "failure" }), run(2, { conclusion: "failure", createdAt: new Date(Date.now() - DAY / 3).toISOString() }));
    await f.sweep();
    f.client.workflowRunById.mockImplementation(async (_repository: string, id: number) => {
      if (id === 1) throw new GithubError(404, "gone");
      return f.runs.find((value) => value.id === id)!;
    });
    Object.assign(f.runs[1]!, { conclusion: "success", attempt: 2, updatedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() });
    for (let pass = 0; pass < 3 && f.waits()[0]!.state === "waiting"; pass++) await f.sweep();
    expect(f.waits()).toMatchObject([{ state: "deployed" }]);
    expect(JSON.parse(f.waits()[0]!.found!)).toMatchObject({ runId: 2 });
  });

  it("gives waits their own due time, so forced syncs never hold them", async () => {
    const f = setup();
    f.card();
    await f.sync();
    await f.sync(merged());
    f.runs.push(run(1));
    // A forced sync just ran, so the project is not due; the wait still is.
    await f.service.runDue();
    await f.events.drain();
    expect(f.waits()).toMatchObject([{ state: "deployed" }]);
  });

  it("costs no request for a wait without an eligible link, and moves a wait with a renamed repository", async () => {
    const f = setup();
    const task = f.card();
    await f.sync();
    await f.sync({ ...merged(), repository: "owner/renamed", url: "https://github.com/owner/renamed/pull/7" });
    expect(f.db.prepare("SELECT repository, identity FROM pr_deploy_waits").get()).toEqual({ repository: "owner/renamed", identity: "github:github.com:owner/renamed#7" });
    await f.service.handlers.unlinkPr({ taskId: task.id, url: "https://github.com/owner/renamed/pull/7" });
    await f.sweep();
    expect(f.client.pushRuns).not.toHaveBeenCalled();
    expect(f.waits()).toMatchObject([{ state: "waiting" }]);
  });

  it("expires as unverifiable after three failed or unfinished final passes", async () => {
    const f = setup();
    const task = f.card();
    await f.sync();
    await f.sync(merged());
    f.deadline(Date.now() - 120_000);
    f.client.pushRuns.mockRejectedValue(new GithubError(502, "down"));
    await f.sweep();
    await f.sweep();
    expect(f.waits()).toMatchObject([{ state: "waiting", final_passes: 2 }]);
    await f.sweep();
    await f.events.drain();
    expect(f.to("thr_worker").at(-1)).toBe(`${task.key} · PR #7: Work Board could not verify a successful deploy run with merge ddddddd within 7 days; it stopped waiting.`);
  });

  it("records an exhausted final recheck budget as unverifiable", async () => {
    deployBudgets.final.rechecks = 2;
    const f = setup();
    f.card();
    await f.sync();
    await f.sync(merged());
    for (let id = 1; id <= 10; id++) f.runs.push(run(id, { status: "in_progress", conclusion: null, createdAt: new Date(Date.now() - DAY / 2 + id * 1000).toISOString() }));
    await f.sweep();
    f.deadline(Date.now() - 120_000);
    for (let pass = 0; pass < 2; pass++) await f.sweep();
    expect(f.waits()).toMatchObject([{ state: "waiting", final_passes: 2 }]);
    deployBudgets.final.rechecks = 1;
    await f.sweep();
    expect(f.waits()).toMatchObject([{ state: "unverifiable" }]);
  });

  it("baselines a merge: an old one gets nothing, one already deployed before the baseline is satisfied silently, a waiting one is armed", async () => {
    const f = setup();
    f.card();
    await f.sync({ state: "merged", mergeSha: m, mergedAt: new Date(Date.now() - 8 * DAY).toISOString() });
    expect(f.waits()).toEqual([]);
    const other = setup();
    other.card();
    // Display coverage shows the failed direct run, although a descendant already succeeded before Work Board first saw the merge.
    await other.sync({ ...merged(), coverage: [{ workflow: "deploy", state: "failed", runId: 1, sha: m, url: null, superseded: false, originalRunId: null, completedAt: null, attempt: 1 }] });
    expect(other.waits()).toMatchObject([{ state: "waiting", baseline_at: expect.any(String) }]);
    other.runs.push(run(1, { conclusion: "failure" }), run(2, { headSha: b, createdAt: new Date(Date.now() - DAY / 3).toISOString(), updatedAt: new Date(Date.now() - DAY / 4).toISOString() }));
    await other.sweep();
    expect(other.waits()).toMatchObject([{ state: "satisfied" }]);
    const third = setup();
    third.card();
    await third.sync(merged());
    await third.sync();
    expect(third.waits()).toMatchObject([{ state: "waiting" }]);
    for (const value of [f, other, third]) expect(value.to("thr_worker")).toEqual([]);
  });
});

describe("recipients", () => {
  it("follows an archived worker to its parent and records a card without a session", async () => {
    const f = setup();
    const task = f.card();
    const lonely = f.card("Lonely", "in_review", "");
    await f.sync(green());
    f.threads.threads.set("thr_worker", { archived: true, parent: "thr_parent" });
    await f.sync(red(b));
    expect(f.to("thr_parent")).toEqual([`${task.key} · PR #7 CI red on bbbbbbb: failed lint, unit-tests.`]);
    expect(f.deliveries().find((row) => row.task_id === lonely.id)).toMatchObject({ state: "no_recipient" });
  });

  it("sends a done card only merge and post-merge events", async () => {
    const f = setup();
    f.card("Done", "done");
    await f.sync(green());
    await f.sync(red(b));
    await f.sync({ state: "merged", mergeSha: m, mergedAt: new Date().toISOString() });
    expect(f.deliveries().map((row) => row.kind)).toEqual(["merged"]);
  });

  it("copies to the manager when on, once per thread, and skips an unusable manager", async () => {
    const f = setup();
    setPrEventSetting(f.db, f.tracker.id, "prEventsManager", "on");
    const task = f.card();
    const shared = f.card("Managed", "in_review", MANAGER);
    await f.sync(green());
    await f.sync(red(b));
    expect(f.to(MANAGER).sort()).toEqual([`${shared.key} · PR #7 CI red on bbbbbbb: failed lint, unit-tests.`, `${task.key} · PR #7 CI red on bbbbbbb: failed lint, unit-tests.`].sort());
    expect(f.deliveries().filter((row) => row.task_id === shared.id).map((row) => row.state)).toEqual(["sent", "skipped:same_thread"]);
    f.threads.threads.set(MANAGER, { archived: true });
    await f.sync(green(b));
    expect(f.to("thr_worker")).toHaveLength(2);
    expect(f.deliveries().filter((row) => row.role === "manager").map((row) => row.state)).toContain("skipped:archived");
    setPrEventSetting(f.db, f.tracker.id, "prEventsManager", "off");
    await f.sync(red(c));
    expect(f.deliveries().filter((row) => row.role === "manager")).toHaveLength(4);
  });

  it("gives each card on a shared worker its own message, and skips excluded and unlinked links", async () => {
    const f = setup();
    const one = f.card("One"), two = f.card("Two"), excluded = f.card("Excluded", "in_review", "thr_x"), racing = f.card("Racing", "in_review", "thr_y");
    await f.service.handlers.unlinkPr({ taskId: excluded.id, url: URL });
    await f.sync(green());
    f.client.snapshot.mockImplementationOnce(async () => {
      await f.service.handlers.unlinkPr({ taskId: racing.id, url: URL });
      return snap({ ...red(b) });
    });
    await f.sync();
    expect(f.to("thr_worker").sort()).toEqual([`${one.key} · PR #7 CI red on bbbbbbb: failed lint, unit-tests.`, `${two.key} · PR #7 CI red on bbbbbbb: failed lint, unit-tests.`].sort());
    expect(f.deliveries().map((row) => row.task_id).sort()).toEqual([one.id, two.id].sort());
  });

  it("sends nothing while prEvents is off and drops rows switched off before transport", async () => {
    const f = setup();
    f.card();
    setPrEventSetting(f.db, f.tracker.id, "prEvents", "off");
    await f.sync(green());
    await f.sync(red(b));
    expect(f.deliveries()).toEqual([]);
    setPrEventSetting(f.db, f.tracker.id, "prEvents", "on");
    f.db.transaction(() => recordPrEvents(f.db, f.store.tasks, { projectId: f.tracker.id, config: createGitSyncStore(f.db).config(f.tracker.id), snapshot: snap(green(b)) }))();
    setPrEventSetting(f.db, f.tracker.id, "prEvents", "off");
    await f.events.drain();
    expect(f.deliveries().map((row) => row.state)).toEqual(["skipped:off"]);
    expect(f.to("thr_worker")).toEqual([]);
  });
});

describe("delivery", () => {
  /** Record an event without the sync's own drain, as a crash right after the commit would leave it. */
  const record = (f: ReturnType<typeof setup>, value: Partial<PrSnapshot>) =>
    f.db.transaction(() => recordPrEvents(f.db, f.store.tasks, { projectId: f.tracker.id, config: createGitSyncStore(f.db).config(f.tracker.id), snapshot: snap(value) }))();

  it("drains rows a crash left after the commit, once, also with competing drainers", async () => {
    const f = setup();
    f.card();
    await f.sync(green());
    record(f, red(b));
    await Promise.all([f.events.drain(), f.events.drain(), f.events.drain()]);
    expect(f.threads.sends).toBe(1);
    expect(f.deliveries()).toMatchObject([{ state: "sent", attempts: 1 }]);
  });

  it("retries a definite rejection up to three attempts", async () => {
    const f = setup();
    f.card();
    await f.sync(green());
    f.threads.sendMode = "throw";
    f.threads.sendError = Object.assign(new Error("rejected"), { status: 422 });
    record(f, red(b));
    for (let pass = 0; pass < 4; pass++) await f.events.drain();
    expect(f.threads.sends).toBe(3);
    expect(f.deliveries()).toMatchObject([{ state: "failed", attempts: 3 }]);
  });

  it("keeps a lost acknowledgement unknown, never resends it, and settles a late acceptance", async () => {
    const f = setup();
    f.card();
    await f.sync(green());
    f.threads.sendMode = "throw";
    f.threads.sendError = undefined;
    record(f, red(b));
    await f.events.drain();
    await f.events.drain();
    expect(f.threads.sends).toBe(1);
    expect(f.deliveries()).toMatchObject([{ state: "unknown" }]);
    const marker = f.db.prepare<[], { marker: string }>("SELECT marker FROM pr_event_deliveries").get()!.marker;
    f.threads.dispatch(`[bb message from plugin:work-board]\n\ntext\n\n${marker}`, "thr_worker");
    await f.events.drain();
    expect(f.deliveries()).toMatchObject([{ state: "sent" }]);
    expect(f.threads.sends).toBe(1);
  });

  it("reconciles a restart: a claim is offered again, a send found by its marker is finished, an unreadable lookup stays unknown", async () => {
    const f = setup();
    f.card();
    await f.sync(green());
    record(f, red(b));
    // A live claim of another drainer is left alone until its lease runs out.
    f.db.prepare("UPDATE pr_event_deliveries SET state='claimed', claim_owner='previous-instance', claimed_at=?").run(new Date().toISOString());
    await f.events.drain();
    expect(f.deliveries()).toMatchObject([{ state: "claimed" }]);
    const expired = new Date(Date.now() - claimLease.ms - 1000).toISOString();
    f.db.prepare("UPDATE pr_event_deliveries SET claimed_at=?").run(expired);
    await f.events.drain();
    expect(f.threads.sends).toBe(1);
    expect(f.deliveries()).toMatchObject([{ state: "sent" }]);
    // Accepted, then the process stopped before recording it.
    f.db.prepare("UPDATE pr_event_deliveries SET state='sending', claim_owner='previous-instance', claimed_at=?").run(expired);
    await f.events.drain();
    expect(f.deliveries()).toMatchObject([{ state: "sent" }]);
    f.db.prepare("UPDATE pr_event_deliveries SET state='sending', claimed_at=?").run(expired);
    f.threads.eventsFail = true;
    f.threads.queueFail = true;
    await f.events.drain();
    expect(f.deliveries()).toMatchObject([{ state: "unknown" }]);
    expect(f.threads.sends).toBe(1);
  });
});

describe("fencing and recovery", () => {
  const record = (f: ReturnType<typeof setup>, value: Partial<PrSnapshot>) =>
    f.db.transaction(() => recordPrEvents(f.db, f.store.tasks, { projectId: f.tracker.id, config: createGitSyncStore(f.db).config(f.tracker.id), snapshot: snap(value) }))();

  it("keeps a second, independent drainer off a live attempt past the lease, so its definite rejection is still retried", async () => {
    Object.assign(claimLease, { ms: 300, renewMs: 50 });
    const f = setup();
    f.card();
    await f.sync(green());
    record(f, red(b));
    const other = createPrEventService(f.bb, f.store.tasks);
    let release!: () => void;
    f.threads.sendGate = new Promise<void>((resolve) => { release = resolve; });
    const first = f.events.drain();
    await vi.waitFor(() => expect(f.threads.sends).toBe(1));
    // Twice the lease passes while the send is held; the renewed claim keeps the other drainer away.
    await new Promise((resolve) => setTimeout(resolve, 700));
    await other.drain();
    expect(f.deliveries()).toMatchObject([{ state: "sending", attempts: 1 }]);
    // Even a provisional unknown, as a reconciler would leave it, yields to this attempt's own definite result.
    f.db.prepare("UPDATE pr_event_deliveries SET state='unknown'").run();
    f.threads.sendMode = "throw";
    f.threads.sendError = Object.assign(new Error("rejected"), { status: 422 });
    release();
    await first;
    expect(f.deliveries()).toMatchObject([{ state: "pending", attempts: 1 }]);
    f.threads.sendGate = undefined;
    f.threads.sendMode = "inline";
    await other.drain();
    expect(f.deliveries()).toMatchObject([{ state: "sent", attempts: 2 }]);
    expect(f.threads.sends).toBe(2);
  });

  it("searches unproven sends least recently searched first, so a busy batch cannot starve the last one", async () => {
    const f = setup();
    const task = f.card();
    await f.sync(green());
    record(f, red(b));
    f.db.prepare("DELETE FROM pr_event_deliveries").run();
    const base = Date.now() - 60_000;
    for (let index = 1; index <= 21; index++) {
      f.db.prepare("INSERT INTO pr_events(id, project_id, remote_id, identity, kind, once_key, payload, created_at) SELECT ?, project_id, remote_id, identity, kind, ?, payload, created_at FROM pr_events LIMIT 1").run(`e${index}`, `key${index}`);
      f.db.prepare("INSERT INTO pr_event_deliveries(id, event_id, task_id, role, state, thread_id, attempts, transport_started_at, marker, created_at, updated_at) VALUES (?, ?, ?, 'session', 'unknown', 'thr_worker', 1, ?, ?, ?, ?)")
        .run(`d${index}`, `e${index}`, task.id, new Date(base + index).toISOString(), `<!-- work-board-pr-event:d${index}:1 -->`, new Date(base).toISOString(), new Date(base).toISOString());
    }
    f.threads.dispatch("[bb message from plugin:work-board]\n\ntext\n\n<!-- work-board-pr-event:d21:1 -->", "thr_worker");
    await f.events.drain();
    await f.events.drain();
    expect(f.db.prepare("SELECT state FROM pr_event_deliveries WHERE id='d21'").get()).toEqual({ state: "sent" });
  });

  it("drops a missing session as no recipient and backs off a transient lookup failure", async () => {
    const f = setup();
    const gone = f.card("Gone", "in_review", ""), flaky = f.card("Flaky", "in_review", "");
    f.store.tasks.createComment({ taskId: gone.id, kind: "agent", authorName: "agent", threadId: "thr_gone", body: "Working" });
    f.store.tasks.createComment({ taskId: flaky.id, kind: "agent", authorName: "agent", threadId: "thr_flaky", body: "Working" });
    const get = f.threads.sdk.threads.get;
    f.harness.sdk.stub("threads.get", async (args: { threadId: string }) => {
      if (args.threadId === "thr_gone") throw Object.assign(new Error("not found"), { code: "thread_not_found" });
      if (args.threadId === "thr_flaky") throw new Error("host unreachable");
      return get(args as never);
    });
    await f.sync(green());
    await f.sync(red(b));
    const rows = () => f.db.prepare<[], { task_id: string; state: string; lookup_failures: number; next_attempt_at: string | null }>("SELECT task_id, state, lookup_failures, next_attempt_at FROM pr_event_deliveries").all();
    expect(rows().find((row) => row.task_id === gone.id)).toMatchObject({ state: "no_recipient" });
    expect(rows().find((row) => row.task_id === flaky.id)).toMatchObject({ state: "pending", lookup_failures: 1, next_attempt_at: expect.any(String) });
    await f.events.drain();
    expect(rows().find((row) => row.task_id === flaky.id)).toMatchObject({ state: "pending", lookup_failures: 1 });
  });

  it("does not hand a PR's message to a link that names another PR at the same path", async () => {
    const f = setup();
    const own = f.card("Own"), other = f.card("Other", "in_review", "thr_other");
    await f.sync(green());
    record(f, red(b));
    // Before delivery, the old path came to hold a different PR, and the other card's link learned that PR's remote id.
    f.db.prepare("UPDATE task_pr_links SET payload=json_set(payload, '$.remoteId', 'PR_other') WHERE task_id=?").run(other.id);
    await f.events.drain();
    expect(f.deliveries().map((row) => [row.task_id, row.state]).sort()).toEqual([[own.id, "sent"], [other.id, "skipped:not_eligible"]].sort());
    expect(f.to("thr_other")).toEqual([]);
    record(f, green(b));
    expect(f.deliveries().filter((row) => row.task_id === other.id)).toHaveLength(1);
  });
});

describe("final reconciliation and progress", () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  const merged = () => ({ state: "merged" as const, mergeSha: m, mergedAt: iso(Date.now() - DAY) });
  const record = (f: ReturnType<typeof setup>, value: Partial<PrSnapshot>) =>
    f.db.transaction(() => recordPrEvents(f.db, f.store.tasks, { projectId: f.tracker.id, config: createGitSyncStore(f.db).config(f.tracker.id), snapshot: snap(value) }))();

  it("waits out the listing lag before the final pass, so a run listed late is not missed", async () => {
    const f = setup();
    const task = f.card();
    await f.sync();
    await f.sync(merged());
    const cutoff = Date.now() - 30_000;
    f.deadline(cutoff);
    // Created and finished just before the cutoff, but GitHub does not list it yet.
    await f.sweep();
    expect(f.waits()).toMatchObject([{ state: "waiting", final_passes: 0 }]);
    f.runs.push(run(1, { createdAt: iso(cutoff - 2000), updatedAt: iso(cutoff - 1000) }));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 120_000);
    await f.sweep();
    expect(f.waits()).toMatchObject([{ state: "deployed" }]);
    expect(f.to("thr_worker").at(-1)).toContain(`${task.key} · PR #7: deploy run 1 succeeded`);
  });

  it("keeps the first sighting of a merge as its baseline when the SHA arrives late, also after the deadline", async () => {
    const f = setup();
    const task = f.card();
    await f.sync({ state: "merged", mergeSha: null, mergedAt: iso(Date.now() - DAY) });
    f.db.prepare("UPDATE pr_event_state SET merge_seen_at=?").run(iso(Date.now() - 2 * 3_600_000));
    // Deployed after Work Board first saw the merge, before the SHA showed up: that is news, not history.
    f.runs.push(run(1, { createdAt: iso(Date.now() - 3 * 3_600_000 / 2), updatedAt: iso(Date.now() - 3_600_000) }));
    await f.sync({ mergeSha: m });
    expect(f.waits()).toMatchObject([{ state: "waiting", baseline_at: expect.any(String) }]);
    await f.sweep();
    expect(f.to("thr_worker")).toEqual([`${task.key} · PR #7: deploy run 1 succeeded with merge ddddddd. Collect the deployment evidence, run the final check and close the card; Work Board does not close it.`]);
    const late = setup();
    const other = late.card();
    const mergedAt = Date.now() - 8 * DAY;
    await late.sync({ state: "merged", mergeSha: null, mergedAt: iso(mergedAt) });
    // First seen inside the window; the SHA only arrives after the deadline.
    late.db.prepare("UPDATE pr_event_state SET merge_seen_at=?").run(iso(mergedAt + 3_600_000));
    await late.sync({ mergeSha: m });
    await late.sweep();
    expect(late.to("thr_worker")).toEqual([`${other.key} · PR #7: Work Board saw no successful deploy run with merge ddddddd within 7 days; it stopped waiting.`]);
  });

  it("rechecks kept runs even when discovery keeps failing", async () => {
    const f = setup();
    f.card();
    await f.sync();
    await f.sync(merged());
    const start = Date.now() - DAY / 2;
    f.runs.push(run(1, { conclusion: "failure", createdAt: iso(start) }), run(2, { headSha: b, conclusion: "failure", createdAt: iso(start + 3_600_000) }));
    f.client.compareStatus.mockRejectedValue(new GithubError(502, "down"));
    await f.sweep();
    expect(JSON.parse(f.waits()[0]!.kept).map((entry: { id: number }) => entry.id)).toEqual([1]);
    Object.assign(f.runs[0]!, { conclusion: "success", attempt: 2, updatedAt: iso(start + 1_800_000) });
    await f.sweep();
    expect(f.waits()).toMatchObject([{ state: "deployed" }]);
    expect(JSON.parse(f.waits()[0]!.found!)).toMatchObject({ runId: 1 });
  });

  it("numbers an attempt from the claimed row, not from a stale listing", async () => {
    const f = setup();
    f.card("One");
    const two = f.card("Two", "in_review", "thr_two");
    await f.sync(green());
    record(f, red(b));
    const other = createPrEventService(f.bb, f.store.tasks);
    const send = f.threads.sdk.threads.send;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reject = true;
    f.harness.sdk.stub("threads.send", async (args: { threadId: string }) => {
      if (args.threadId === "thr_worker") await gate;
      if (args.threadId === "thr_two" && reject) { reject = false; throw Object.assign(new Error("rejected"), { status: 422 }); }
      return send(args as never);
    });
    // The other drainer lists both rows, then waits on the first send.
    const slow = other.drain();
    await vi.waitFor(() => expect(f.deliveries().some((row) => row.state === "sending")).toBe(true));
    await f.events.drain();
    expect(f.deliveries().find((row) => row.task_id === two.id)).toMatchObject({ state: "pending", attempts: 1 });
    release();
    await slow;
    expect(f.deliveries().find((row) => row.task_id === two.id)).toMatchObject({ state: "sent", attempts: 2 });
    expect(f.db.prepare<[string], { marker: string }>("SELECT marker FROM pr_event_deliveries WHERE task_id=?").get(two.id)!.marker).toMatch(/:2 -->$/);
  });
});

describe("late evidence and attempt checks", () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  const record = (f: ReturnType<typeof setup>, value: Partial<PrSnapshot>) =>
    f.db.transaction(() => recordPrEvents(f.db, f.store.tasks, { projectId: f.tracker.id, config: createGitSyncStore(f.db).config(f.tracker.id), snapshot: snap(value) }))();

  it("keeps reading a merge first seen in its window until its SHA arrives, after the cutoff and a restart", async () => {
    const f = setup();
    const task = f.card();
    const mergedAt = Date.now() - 7 * DAY - 3_600_000;
    await f.sync({ state: "merged", mergeSha: null, mergedAt: iso(mergedAt) });
    // A restart after the cutoff: a fresh service, and the project due again.
    const restarted = createGitSyncService(f.bb, f.store, f.client);
    const due = () => f.db.prepare("UPDATE git_sync_projects SET last_attempt_at=NULL").run();
    due();
    await restarted.runDue();
    // First seen after its window closed: nothing to arm, so the scheduler leaves it alone.
    expect(f.client.snapshot).toHaveBeenCalledTimes(1);
    f.db.prepare("UPDATE pr_event_state SET merge_seen_at=?").run(iso(mergedAt + 3_600_000));
    f.set(snap({ state: "merged", mergeSha: m, mergedAt: iso(mergedAt) }));
    due();
    await restarted.runDue();
    expect(f.client.snapshot).toHaveBeenCalledTimes(2);
    expect(f.waits()).toMatchObject([{ state: "waiting" }]);
    await f.sweep();
    expect(f.to("thr_worker")).toEqual([`${task.key} · PR #7: Work Board saw no successful deploy run with merge ddddddd within 7 days; it stopped waiting.`]);
  });

  it("keeps a run read during the listing lag after the cutoff until a readable recheck", async () => {
    const f = setup();
    f.card();
    await f.sync();
    await f.sync({ state: "merged", mergeSha: m, mergedAt: iso(Date.now() - DAY) });
    f.runs.push(run(1, { status: "in_progress", conclusion: null }));
    await f.sweep();
    const cutoff = Date.now() - 30_000;
    f.deadline(cutoff);
    await f.sweep();
    expect(f.waits()).toMatchObject([{ state: "waiting", final_passes: 0 }]);
    expect(JSON.parse(f.waits()[0]!.kept).map((entry: { id: number }) => entry.id)).toEqual([1]);
    // It had finished just before the cutoff; GitHub shows that only now.
    Object.assign(f.runs[0]!, { status: "completed", conclusion: "success", updatedAt: iso(cutoff - 1000) });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 120_000);
    await f.sweep();
    expect(f.waits()).toMatchObject([{ state: "deployed" }]);
  });

  it("lets a late marker search write only while the row still carries the attempt it searched for", async () => {
    const f = setup();
    f.card();
    await f.sync(green());
    record(f, red(b));
    const expired = iso(Date.now() - claimLease.ms - 1000);
    f.db.prepare("UPDATE pr_event_deliveries SET state='sending', claim_owner='previous-instance', claimed_at=?, attempts=1, marker='<!-- work-board-pr-event:x:1 -->', thread_id='thr_worker', transport_started_at=?")
      .run(expired, iso(Date.now()));
    let release!: () => void;
    f.threads.listGateOnce = new Promise<void>((resolve) => { release = resolve; });
    const calls = f.threads.queueCalls;
    const draining = f.events.drain();
    await vi.waitFor(() => expect(f.threads.queueCalls).toBeGreaterThan(calls));
    // Meanwhile a newer attempt of another drainer took the row.
    f.db.prepare("UPDATE pr_event_deliveries SET claim_owner='newer-instance', claimed_at=?, attempts=2, marker='<!-- work-board-pr-event:x:2 -->'").run(iso(Date.now()));
    release();
    await draining;
    expect(f.db.prepare("SELECT state, marker, cursor FROM pr_event_deliveries").get()).toEqual({ state: "sending", marker: "<!-- work-board-pr-event:x:2 -->", cursor: null });
  });

  it("resolves a provisional unknown with the attempt's own proven skip", async () => {
    const f = setup();
    const first = f.card("One");
    const second = f.card("Two");
    await f.sync(green());
    record(f, red(b));
    const other = createPrEventService(f.bb, f.store.tasks);
    let release!: () => void;
    f.threads.sendGate = new Promise<void>((resolve) => { release = resolve; });
    const held = f.events.drain();
    await vi.waitFor(() => expect(f.threads.sends).toBe(1));
    const sending = f.deliveries().find((row) => row.state === "sending")!;
    const queued = sending.task_id === first.id ? second : first;
    // The other drainer's send to the same thread waits behind the held one.
    const behind = other.drain();
    await vi.waitFor(() => expect(f.deliveries().find((row) => row.task_id === queued.id)).toMatchObject({ state: "sending" }));
    f.db.prepare("UPDATE pr_event_deliveries SET state='unknown' WHERE task_id=?").run(queued.id);
    setPrEventSetting(f.db, f.tracker.id, "prEvents", "off");
    release();
    await Promise.all([held, behind]);
    expect(f.deliveries().find((row) => row.task_id === queued.id)).toMatchObject({ state: "skipped:off" });
    expect(f.threads.sends).toBe(1);
  });
});

describe("SHA recovery and status lag", () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  const due = (f: ReturnType<typeof setup>) => f.db.prepare("UPDATE git_sync_projects SET last_attempt_at=NULL").run();

  it("recovers the SHA of a merge Work Board saw happen, after the cutoff and a restart, and sends both messages", async () => {
    const f = setup();
    const task = f.card();
    const mergedAt = Date.now() - 7 * DAY - 3_600_000;
    await f.sync();
    await f.sync({ state: "merged", mergeSha: null, mergedAt: iso(mergedAt) });
    expect(f.db.prepare("SELECT merge_sha, merge_seen_at IS NOT NULL AS seen FROM pr_event_state").get()).toEqual({ merge_sha: "!", seen: 1 });
    const restarted = createGitSyncService(f.bb, f.store, f.client);
    f.set(snap({ state: "merged", mergeSha: m, mergedAt: iso(mergedAt) }));
    due(f);
    await restarted.runDue();
    expect(f.client.snapshot).toHaveBeenCalledTimes(3);
    expect(f.waits()).toMatchObject([{ state: "waiting", baseline_at: null }]);
    await f.sweep();
    expect(f.to("thr_worker")).toEqual([
      `${task.key} · PR #7 merged as ddddddd at ${iso(mergedAt).slice(0, 10)} ${iso(mergedAt).slice(11, 16)} UTC.`,
      `${task.key} · PR #7: Work Board saw no successful deploy run with merge ddddddd within 7 days; it stopped waiting.`,
    ]);
  });

  it("does not keep polling for a SHA when no message can follow", async () => {
    const mergedAt = Date.now() - 7 * DAY - 3_600_000;
    // A baselined merge with no deployment workflows: the SHA would arm nothing.
    const f = setup({ postMergeWorkflows: [] });
    f.card();
    await f.sync({ state: "merged", mergeSha: null, mergedAt: iso(mergedAt) });
    f.db.prepare("UPDATE pr_event_state SET merge_seen_at=?").run(iso(mergedAt + 3_600_000));
    due(f);
    await createGitSyncService(f.bb, f.store, f.client).runDue();
    expect(f.client.snapshot).toHaveBeenCalledTimes(1);
    // A merge Work Board saw happen, with PR events switched off.
    const off = setup();
    off.card();
    await off.sync();
    await off.sync({ state: "merged", mergeSha: null, mergedAt: iso(mergedAt) });
    setPrEventSetting(off.db, off.tracker.id, "prEvents", "off");
    due(off);
    await createGitSyncService(off.bb, off.store, off.client).runDue();
    expect(off.client.snapshot).toHaveBeenCalledTimes(2);
  });

  it("keeps a later candidate pending while a kept run read during the status lag may have finished first", async () => {
    const f = setup();
    f.card();
    await f.sync();
    await f.sync({ state: "merged", mergeSha: m, mergedAt: iso(Date.now() - DAY) });
    // A still shows in progress although it may already have finished; B finished ten seconds before that read.
    f.runs.push(run(1, { status: "in_progress", conclusion: null }), run(2, { headSha: b, createdAt: iso(Date.now() - DAY / 3), updatedAt: iso(Date.now() - 10_000) }));
    await f.sweep();
    expect(JSON.parse(f.waits()[0]!.found!)).toMatchObject({ runId: 2 });
    // Later passes cannot read A again.
    f.client.workflowRunById.mockRejectedValue(new GithubError(502, "down"));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 5 * 60_000);
    await f.sweep();
    expect(f.waits()).toMatchObject([{ state: "waiting" }]);
  });
});

describe("lifecycle", () => {
  it("prunes delivery history after 30 days and unlinked state after 90, and project deletion removes the rest", async () => {
    const f = setup();
    const task = f.card();
    await f.sync(green());
    await f.sync(red(b));
    expect(f.deliveries()).toHaveLength(1);
    f.events.prune(Date.now() + 31 * DAY);
    expect(f.deliveries()).toEqual([]);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM pr_events").get()).toEqual({ n: 1 });
    await f.service.handlers.unlinkPr({ taskId: task.id, url: URL });
    f.events.prune(Date.now());
    f.events.prune(Date.now() + 89 * DAY);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM pr_event_state").get()).toEqual({ n: 1 });
    f.events.prune(Date.now() + 91 * DAY);
    expect(f.db.prepare("SELECT (SELECT COUNT(*) FROM pr_event_state) + (SELECT COUNT(*) FROM pr_events) AS n").get()).toEqual({ n: 0 });
    f.service.remember(task.id, URL, "manual", { role: "related", part: null });
    await f.sync(green(c));
    setPrEventSetting(f.db, f.tracker.id, "prEventsManager", "on");
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM pr_event_state").get()).toEqual({ n: 1 });
    f.store.tasks.deleteProject(f.tracker.id);
    expect(f.db.prepare("SELECT (SELECT COUNT(*) FROM pr_event_state) + (SELECT COUNT(*) FROM pr_event_settings) + (SELECT COUNT(*) FROM pr_events) AS n").get()).toEqual({ n: 0 });
  });

  it("lists a card's events in the CLI and reads and sets the two keys one at a time", async () => {
    const f = setup();
    const task = f.card();
    await f.sync(green());
    await f.sync(red(b));
    const listed = JSON.parse((await f.harness.runCli(["pr", "events", task.key, "--json"])).stdout);
    expect(listed.events).toMatchObject([{ kind: "ci", role: "session", state: "sent", threadId: "thr_worker", pr: "owner/repo#7" }]);
    const get = async (key: string) => JSON.parse((await f.harness.runCli(["config", "get", key, "--project", "ATT", "--json"])).stdout).values[key];
    expect([await get("prEvents"), await get("prEventsManager")]).toEqual(["on", "off"]);
    await f.harness.runCli(["config", "set", "prEventsManager", "on", "--project", "ATT"]);
    expect(await get("prEventsManager")).toBe("on");
  });
});
