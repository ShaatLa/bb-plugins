import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MANAGER, setup as attentionSetup } from "../attention/fixtures";
import { registerTasksCli } from "../cli";
import { historyLimits, receiptPolling } from "../steer";
import { prSnapshotSchema, type PrSnapshot } from "../shared/git-sync";
import { createGitSyncService } from "./service";
import { createGithubClient, GithubError, type DeployRun, type FailedChecks, type QueueEvent, type QueueTimeline } from "./github";
import { claimLease, ciVerdict, createPrEventService, deployBudgets, environmentLookup, pairRemoval, prEventService, prEventText, recordPrEvents, setPrEventSetting } from "./events";
import { createGitSyncStore } from "./store";

const URL = "https://github.com/owner/repo/pull/7";
const DAY = 86_400_000;
const a = "a".repeat(40), b = "b".repeat(40), c = "c".repeat(40), m = "d".repeat(40), x = "e".repeat(40);
const fixtures: { dispose: () => unknown }[] = [];
const budgets = structuredClone(deployBudgets);
const limits = { ...historyLimits };
const lease = { ...claimLease };
const lookupDefaults = { ...environmentLookup };
beforeEach(() => { receiptPolling.tries = 1; receiptPolling.delayMs = 0; });
afterEach(async () => {
  Object.assign(deployBudgets, structuredClone(budgets));
  Object.assign(historyLimits, limits);
  Object.assign(claimLease, lease);
  Object.assign(environmentLookup, lookupDefaults);
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
    queueTimeline: vi.fn(async (_repository: string, _number: number): Promise<QueueTimeline> => ({ events: [], truncated: false })),
    failedChecks: vi.fn(async (_repository: string, _oid: string): Promise<FailedChecks | null> => null),
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
    await service.sweep([f.tracker.id]);
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
  const T = Math.floor((Date.now() - 3_600_000) / 1000) * 1000;
  /** A timeline time `minutes` after T, in whole seconds as GitHub gives them; the matching enqueue time carries milliseconds. */
  const at = (minutes: number) => new Date(T + Math.round(minutes * 60_000)).toISOString();
  const enqueued = (minutes: number) => new Date(T + minutes * 60_000 + 250).toISOString();
  const add = (id: string, minutes: number): QueueEvent => ({ kind: "added", id, createdAt: at(minutes), reason: null, beforeCommit: null });
  const remove = (id: string, minutes: number, reason: string | null = "MANUAL", beforeCommit: string | null = null): QueueEvent => ({ kind: "removed", id, createdAt: at(minutes), reason, beforeCommit });
  const timeline = (...events: (QueueEvent | null)[]): QueueTimeline => ({ events, truncated: false });
  const hhmm = (minutes: number) => at(minutes).slice(11, 16);
  const onceKeys = (f: ReturnType<typeof setup>) => f.db.prepare<[], { once_key: string }>("SELECT once_key FROM pr_events WHERE kind='queue_removed' ORDER BY created_at").all().map((row) => row.once_key);

  it("reads the timeline only on a departure, once per PR, and names each removal", async () => {
    const f = setup();
    const warn = vi.spyOn(f.bb.log, "warn");
    const first = f.card("One"), second = f.card("Two", "in_review", "thr_other");
    await f.sync({ queueEntryId: "MQE_1", queueEnqueuedAt: enqueued(0) });
    await f.sync();
    await f.sync({ queueEntryId: undefined });
    expect(f.client.queueTimeline).not.toHaveBeenCalled();
    f.client.queueTimeline.mockResolvedValueOnce(timeline(add("AE_1", 0), remove("RE_1", 10)));
    await f.sync({ queueEntryId: null });
    expect(f.client.queueTimeline).toHaveBeenCalledWith("owner/repo", 7);
    const text = `PR #7 was removed from the merge queue at ${hhmm(10)} UTC (reason: MANUAL). Head aaaaaaa. At the next poll, the PR was out of the merge queue.`;
    expect(f.to("thr_worker")).toEqual([`${first.key} · ${text}`]);
    expect(f.to("thr_other")).toEqual([`${second.key} · ${text}`]);
    // A non-failed-checks removal reads no rollup.
    expect(f.client.failedChecks).not.toHaveBeenCalled();
    // Queued again, then replaced with an unreadable timeline: a separate event under the entry id, with a warning.
    await f.sync({ queueEntryId: "MQE_2", queueEnqueuedAt: enqueued(20) });
    f.client.queueTimeline.mockRejectedValueOnce(new Error("timeline unavailable"));
    await f.sync({ queueEntryId: "MQE_3", queueEnqueuedAt: enqueued(30) });
    expect(f.to("thr_worker")[1]).toBe(`${first.key} · PR #7 was removed from the merge queue (reason: reason unavailable). Head aaaaaaa. At the next poll, the PR was back in the merge queue.`);
    expect(onceKeys(f)).toEqual(["RE_1", "entry:MQE_2"]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/owner\/repo#7 failed: timeline unavailable/));
  });

  it("pairs the departed entry's add and removal even when the last sighting came after the removal", async () => {
    const f = setup();
    const task = f.card();
    await f.sync({ queueEntryId: "MQE_1", queueEnqueuedAt: enqueued(0) });
    // A lagging read saw the old entry a second after its removal; the old time window missed such a removal.
    f.db.prepare("UPDATE pr_event_state SET queue_seen_at=?").run(new Date(Date.parse(at(10)) + 1_000).toISOString());
    f.client.queueTimeline.mockResolvedValueOnce(timeline(add("AE_1", 0), remove("RE_1", 10, "FAILED_CHECKS"), add("AE_2", 11)));
    await f.sync({ queueEntryId: "MQE_2", queueEnqueuedAt: enqueued(11) });
    expect(f.to("thr_worker")).toEqual([`${task.key} · PR #7 was removed from the merge queue at ${hhmm(10)} UTC (reason: FAILED CHECKS). Head aaaaaaa. At the next poll, the PR was back in the merge queue.`]);
  });

  it("chooses the departed entry's removal over an earlier and a later entry's, leaving the later one free", async () => {
    const f = setup();
    const task = f.card();
    const events = [add("AE_0", 0), remove("RE_0", 1), add("AE_A", 2), remove("RE_A", 3, "CI_TIMEOUT"), add("AE_B", 4), remove("RE_B", 5, "MANUAL")];
    // The snapshot still shows A after B was added.
    await f.sync({ queueEntryId: "MQE_A", queueEnqueuedAt: enqueued(2) });
    f.client.queueTimeline.mockResolvedValueOnce(timeline(...events));
    await f.sync({ queueEntryId: null });
    expect(onceKeys(f)).toEqual(["RE_A"]);
    expect(f.to("thr_worker")[0]).toContain("(reason: CI TIMEOUT)");
    await f.sync({ queueEntryId: "MQE_B", queueEnqueuedAt: enqueued(4) });
    f.client.queueTimeline.mockResolvedValueOnce(timeline(...events));
    await f.sync({ queueEntryId: null });
    expect(onceKeys(f)).toEqual(["RE_A", "RE_B"]);
    expect(f.to("thr_worker")[1]).toBe(`${task.key} · PR #7 was removed from the merge queue at ${hhmm(5)} UTC (reason: MANUAL). Head aaaaaaa. At the next poll, the PR was out of the merge queue.`);
  });

  it("falls back to the entry id when a cut page may hide another add in the enqueue second, keeping the removal id free", async () => {
    const f = setup();
    const task = f.card();
    await f.sync({ queueEntryId: "MQE_A", queueEnqueuedAt: enqueued(0) });
    f.client.queueTimeline.mockResolvedValueOnce({ events: [add("AE_B", 0), remove("RE_B", 1)], truncated: true });
    await f.sync({ queueEntryId: null });
    expect(f.to("thr_worker")).toEqual([`${task.key} · PR #7 was removed from the merge queue (reason: reason unavailable). Head aaaaaaa. At the next poll, the PR was out of the merge queue.`]);
    expect(onceKeys(f)).toEqual(["entry:MQE_A"]);
    await f.sync({ queueEntryId: "MQE_B", queueEnqueuedAt: enqueued(0) });
    f.client.queueTimeline.mockResolvedValueOnce(timeline(add("AE_B", 0), remove("RE_B", 1)));
    await f.sync({ queueEntryId: null });
    expect(onceKeys(f)).toEqual(["entry:MQE_A", "RE_B"]);
  });

  it("falls back to the entry id across an unreadable item after the add, keeping the next removal id free", async () => {
    const f = setup();
    f.card();
    await f.sync({ queueEntryId: "MQE_A", queueEnqueuedAt: enqueued(0) });
    // The gap may hide A's removal and B's add, so the readable removal after it may be B's.
    f.client.queueTimeline.mockResolvedValueOnce(timeline(add("AE_A", 0), null, remove("RE_B", 2)));
    await f.sync({ queueEntryId: null });
    expect(onceKeys(f)).toEqual(["entry:MQE_A"]);
    await f.sync({ queueEntryId: "MQE_B", queueEnqueuedAt: enqueued(1) });
    // The gap now lies well before B's window: A's removal, read after it, bounds it.
    f.client.queueTimeline.mockResolvedValueOnce(timeline(add("AE_A", 0), null, remove("RE_A", 0.5), add("AE_B", 1), remove("RE_B", 2)));
    await f.sync({ queueEntryId: null });
    expect(onceKeys(f)).toEqual(["entry:MQE_A", "RE_B"]);
  });

  it("matches a merged reason exactly", async () => {
    const f = setup();
    f.card();
    await f.sync({ queueEntryId: "MQE_1", queueEnqueuedAt: enqueued(0) });
    f.client.queueTimeline.mockResolvedValueOnce(timeline(add("AE_1", 0), remove("RE_1", 5, "not_merged")));
    await f.sync({ queueEntryId: null });
    expect(onceKeys(f)).toEqual(["RE_1"]);
  });

  it("keeps a known enqueue time through repeat sightings without one, and clears it on a change", async () => {
    const f = setup();
    f.card();
    const stored = () => f.db.prepare<[], { queue_enqueued_at: string | null }>("SELECT queue_enqueued_at FROM pr_event_state").get()!.queue_enqueued_at;
    await f.sync({ queueEntryId: "MQE_1", queueEnqueuedAt: enqueued(0) });
    await f.sync({ queueEnqueuedAt: null });
    expect(stored()).toBe(enqueued(0));
    await f.sync({ queueEntryId: undefined });
    expect(stored()).toBe(enqueued(0));
    await f.sync({ queueEntryId: "MQE_2", queueEnqueuedAt: null });
    expect(stored()).toBeNull();
    await f.sync({ queueEntryId: "MQE_3", queueEnqueuedAt: enqueued(5) });
    expect(stored()).toBe(enqueued(5));
    await f.sync({ queueEntryId: null });
    expect(stored()).toBeNull();
  });

  it("sends nothing for a paired merge-generated removal but still advances the queue state", async () => {
    const f = setup();
    f.card();
    await f.sync({ queueEntryId: "MQE_1", queueEnqueuedAt: enqueued(0) });
    f.client.queueTimeline.mockResolvedValueOnce(timeline(add("AE_1", 0), remove("RE_1", 5, "MERGED")));
    await f.sync({ queueEntryId: null });
    expect(onceKeys(f)).toEqual([]);
    expect(f.to("thr_worker")).toEqual([]);
    expect(f.db.prepare("SELECT queue_entry, queue_enqueued_at FROM pr_event_state").get()).toEqual({ queue_entry: null, queue_enqueued_at: null });
  });

  it("pairs only when the add is certain and the removal visible", () => {
    const observed = new Date(T + 60 * 60_000).toISOString();
    const events = [add("AE_1", 0), remove("RE_1", 10)];
    expect(pairRemoval(timeline(...events), enqueued(0), observed)?.id).toBe("RE_1");
    expect(pairRemoval(timeline(...events), null, observed)).toBeNull();
    // GitHub may date the add a second after the enqueue time.
    expect(pairRemoval(timeline(add("AE_1", 1 / 60), remove("RE_1", 10)), enqueued(0), observed)?.id).toBe("RE_1");
    // The add is not on the page, or two adds fall within 2 s of the enqueue time.
    expect(pairRemoval(timeline(remove("RE_1", 10)), enqueued(0), observed)).toBeNull();
    expect(pairRemoval(timeline(add("AE_0", 0), ...events), enqueued(0), observed)).toBeNull();
    expect(pairRemoval(timeline(add("AE_0", -2 / 60), remove("RE_0", -1 / 60), add("AE_1", 1 / 60), remove("RE_1", 10)), enqueued(0), observed)).toBeNull();
    expect(pairRemoval(timeline(add("AE_0", -3 / 60), remove("RE_0", -1 / 60), add("AE_1", 1 / 60), remove("RE_1", 10)), enqueued(0), observed)?.id).toBe("RE_1");
    // Not removed yet, or removed after this observation's second.
    expect(pairRemoval(timeline(add("AE_1", 0)), enqueued(0), observed)).toBeNull();
    expect(pairRemoval(timeline(add("AE_1", 0), add("AE_2", 5)), enqueued(0), observed)).toBeNull();
    expect(pairRemoval(timeline(add("AE_1", 0), remove("RE_1", 61)), enqueued(0), observed)).toBeNull();
    expect(pairRemoval(timeline(add("AE_1", 0), remove("RE_1", 60)), enqueued(0), new Date(T + 60 * 60_000 + 900).toISOString())?.id).toBe("RE_1");
    // An unreadable item right after the add, or as the oldest of a cut page, leaves the pairing uncertain.
    expect(pairRemoval(timeline(add("AE_1", 0), null, remove("RE_1", 10)), enqueued(0), observed)).toBeNull();
    // A gap between events that bracket the window may hide an add in it; one with both neighbors well before it does not.
    expect(pairRemoval(timeline(null, ...events), enqueued(0), observed)).toBeNull();
    expect(pairRemoval(timeline(add("AE_0", -10), remove("RE_0", -5), null, ...events), enqueued(0), observed)).toBeNull();
    expect(pairRemoval(timeline(add("AE_0", -10), null, remove("RE_0", -5), ...events), enqueued(0), observed)?.id).toBe("RE_1");
    expect(pairRemoval(timeline(...events, null), enqueued(0), observed)?.id).toBe("RE_1");
    expect(pairRemoval({ events: [null, ...events], truncated: true }, enqueued(0), observed)).toBeNull();
    // A leading gap on a cut page before an event far older than the window does not block.
    expect(pairRemoval({ events: [null, remove("RE_0", -24 * 60), ...events], truncated: true }, enqueued(0), observed)?.id).toBe("RE_1");
    // A cut page matters only when its oldest event is within 2 s of the enqueue time.
    expect(pairRemoval({ events, truncated: true }, enqueued(0), observed)).toBeNull();
    expect(pairRemoval({ events: [add("AE_1", 1 / 60), remove("RE_1", 10)], truncated: true }, enqueued(0), observed)).toBeNull();
    expect(pairRemoval({ events: [add("AE_0", -3 / 60), remove("RE_0", -2.5 / 60), add("AE_1", 1 / 60), remove("RE_1", 10)], truncated: true }, enqueued(0), observed)?.id).toBe("RE_1");
    expect(pairRemoval({ events: [add("AE_0", -1), ...events], truncated: true }, enqueued(0), observed)?.id).toBe("RE_1");
  });

  it("names the failed checks of the tested commit for a failed-checks removal only", async () => {
    const f = setup();
    const warn = vi.spyOn(f.bb.log, "warn");
    const task = f.card();
    const cycle = async (entry: number, reason: string, failed: FailedChecks | null | Error) => {
      await f.sync({ queueEntryId: `MQE_${entry}`, queueEnqueuedAt: enqueued(entry) });
      f.client.queueTimeline.mockResolvedValueOnce(timeline(add(`AE_${entry}`, entry), remove(`RE_${entry}`, entry + 0.5, reason, `oid${entry}`)));
      if (failed instanceof Error) f.client.failedChecks.mockRejectedValueOnce(failed);
      else f.client.failedChecks.mockResolvedValueOnce(failed);
      await f.sync({ queueEntryId: null });
      return f.to("thr_worker").at(-1)!.replace(`${task.key} · PR #7 was removed from the merge queue at ${hhmm(entry + 0.5)} UTC `, "").replace(" Head aaaaaaa. At the next poll, the PR was out of the merge queue.", "");
    };
    const seven = ["A", "B", "C", "D", "E", "F", "G"];
    expect(await cycle(1, "FAILED_CHECKS", { names: seven, hasNextPage: false })).toBe("(reason: FAILED CHECKS; failed: A, B, C, D, E, +2 more).");
    expect(f.client.failedChecks).toHaveBeenLastCalledWith("owner/repo", "oid1");
    expect(await cycle(2, "failed_checks", { names: seven, hasNextPage: true })).toBe("(reason: failed checks; failed: A, B, C, D, E and more).");
    expect(await cycle(3, "FAILED_CHECKS", { names: ["lint"], hasNextPage: true })).toBe("(reason: FAILED CHECKS; failed: lint (first 100 checks inspected)).");
    expect(await cycle(7, "FAILED_CHECKS", { names: [], hasNextPage: true })).toBe("(reason: FAILED CHECKS; failed: none found (first 100 checks inspected)).");
    expect(await cycle(8, "FAILED_CHECKS", { names: [], hasNextPage: false })).toBe("(reason: FAILED CHECKS).");
    expect(f.db.prepare("SELECT payload FROM pr_events WHERE once_key='RE_1'").get()).toEqual({ payload: expect.stringContaining('"failedChecks":["A","B","C","D","E"],"failedMore":2,"checksTruncated":false') });
    // An unreadable or missing rollup keeps the reason and the time, with a warning.
    expect(await cycle(4, "FAILED_CHECKS", new Error("rollup unavailable"))).toBe("(reason: FAILED CHECKS).");
    expect(await cycle(5, "FAILED_CHECKS", null)).toBe("(reason: FAILED CHECKS).");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("failed checks unreadable: rollup unavailable"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("commit oid5 has no check rollup"));
    expect(f.client.failedChecks).toHaveBeenCalledTimes(7);
    await cycle(6, "MANUAL", null);
    expect(f.client.failedChecks).toHaveBeenCalledTimes(7);
  });

  it("renders the removal text, keeping old payloads as they were", () => {
    const base = { number: 7, head: a, reason: "FAILED_CHECKS" };
    expect(prEventText("queue_removed", base, "EXA-1")).toBe("EXA-1 · PR #7 was removed from the merge queue (reason: FAILED_CHECKS). Head aaaaaaa.");
    expect(prEventText("queue_removed", { ...base, reason: null }, "EXA-1")).toBe("EXA-1 · PR #7 was removed from the merge queue (reason: reason unavailable). Head aaaaaaa.");
    expect(prEventText("queue_removed", { ...base, reason: null, requeued: true }, "EXA-1"))
      .toBe("EXA-1 · PR #7 was removed from the merge queue (reason: reason unavailable). Head aaaaaaa. At the next poll, the PR was back in the merge queue.");
    expect(prEventText("queue_removed", { ...base, removedAt: "2026-01-02T03:04:05Z", failedChecks: ["Check A", "Check B"], failedMore: 0, checksTruncated: false, requeued: false }, "EXA-1"))
      .toBe("EXA-1 · PR #7 was removed from the merge queue at 03:04 UTC (reason: FAILED CHECKS; failed: Check A, Check B). Head aaaaaaa. At the next poll, the PR was out of the merge queue.");
  });

  it("reads queue adds and removals oldest first, and the failed contexts of a commit", async () => {
    const responses: unknown[] = [];
    const fetcher = vi.fn(async () => new Response(JSON.stringify(responses.shift()), { status: 200 }));
    const client = createGithubClient({ token: async () => "token", signal: new AbortController().signal, fetcher: fetcher as never });
    responses.push({ data: { repository: { pullRequest: { timelineItems: { pageInfo: { hasPreviousPage: true }, nodes: [
      { __typename: "AddedToMergeQueueEvent", id: "AE_1", createdAt: "2026-01-01T00:00:00Z" },
      { __typename: "RemovedFromMergeQueueEvent", id: "RE_1", createdAt: "2026-01-02T00:00:00Z", reason: "MANUAL", beforeCommit: { oid: "c1" } },
      {},
      { __typename: "RemovedFromMergeQueueEvent", id: "RE_2", createdAt: "2026-01-03T00:00:00Z", reason: null, beforeCommit: null },
      null,
    ] } } } } });
    // Unreadable items stay in place as gaps.
    expect(await client.queueTimeline("owner/repo", 7)).toEqual({ truncated: true, events: [
      { kind: "added", id: "AE_1", createdAt: "2026-01-01T00:00:00Z", reason: null, beforeCommit: null },
      { kind: "removed", id: "RE_1", createdAt: "2026-01-02T00:00:00Z", reason: "MANUAL", beforeCommit: "c1" },
      null,
      { kind: "removed", id: "RE_2", createdAt: "2026-01-03T00:00:00Z", reason: null, beforeCommit: null },
      null,
    ] });
    const run = (name: string, conclusion: string | null) => ({ __typename: "CheckRun", name, conclusion });
    const status = (context: string, state: string) => ({ __typename: "StatusContext", context, state });
    responses.push({ data: { repository: { object: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: true }, nodes: [
      run("unit", "FAILURE"), run("unit", "FAILURE"), run("e2e", "TIMED_OUT"), run("lint", "CANCELLED"), run("deploy", "ACTION_REQUIRED"), run("boot", "STARTUP_FAILURE"),
      run("ok", "SUCCESS"), run("skip", "SKIPPED"), run("neutral", "NEUTRAL"), run("running", null),
      status("ci/legacy", "FAILURE"), status("ci/error", "ERROR"), status("ci/pending", "PENDING"), status("ci/ok", "SUCCESS"), null,
    ] } } } } } });
    expect(await client.failedChecks("owner/repo", "c1")).toEqual({ names: ["unit", "e2e", "lint", "deploy", "boot", "ci/legacy", "ci/error"], hasNextPage: true });
    expect(JSON.parse((fetcher.mock.calls.at(-1) as unknown as [string, RequestInit])[1].body as string).variables).toEqual({ owner: "owner", repo: "repo", oid: "c1" });
    responses.push({ data: { repository: { object: { statusCheckRollup: null } } } });
    expect(await client.failedChecks("owner/repo", "c1")).toBeNull();
    // Top-level GraphQL errors throw even beside partial data, so the caller falls back and warns.
    responses.push({ data: { repository: { pullRequest: { timelineItems: { pageInfo: { hasPreviousPage: false }, nodes: [] } } } }, errors: [{ message: "timeline field failed" }] });
    await expect(client.queueTimeline("owner/repo", 7)).rejects.toThrow("timeline field failed");
    responses.push({ data: null, errors: [{ message: "rollup field failed" }] });
    await expect(client.failedChecks("owner/repo", "c1")).rejects.toThrow("rollup field failed");
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

describe("refresh first, capped sweep and early delivery", () => {
  const merged = () => ({ state: "merged" as const, mergeSha: m, mergedAt: new Date(Date.now() - DAY).toISOString() });
  const config = { enabled: true, repositories: ["owner/repo"], titleDiscovery: false, pollMinutes: 5, lookbackDays: 30, requiredChecks: [], prWaitIgnoredChecks: [], postMergeWorkflows: ["deploy"], postMergeDays: 7 };
  /** Another project whose card links `url`. */
  const project = async (f: ReturnType<typeof setup>, url: string, prefix = "OTH") => {
    const other = f.store.tasks.createProject({ name: "Other", prefix, color: "blue" });
    await f.service.handlers.setGitSyncConfig({ projectId: other.id, config: config as never });
    const task = f.store.tasks.createTask({ projectId: other.id, title: "Other work" });
    f.service.remember(task.id, url, "manual", { role: "related", part: null });
    return other;
  };
  const pr = (number: number, extra: Partial<PrSnapshot> = {}) => snap({ number, remoteId: `PR_${number}`, url: `https://github.com/owner/repo/pull/${number}`, observedAt: new Date().toISOString(), ...extra });
  const due = (f: ReturnType<typeof setup>) => f.db.prepare("UPDATE git_sync_projects SET last_attempt_at=NULL").run();
  const sweptAt = (f: ReturnType<typeof setup>, projectId: string) =>
    f.db.prepare<[string], { swept_at: string | null; final_passes: number; state: string }>("SELECT swept_at, final_passes, state FROM pr_deploy_waits WHERE project_id=?").get(projectId)!;

  it("refreshes a due PR of another project while a sweep is blocked on GitHub", async () => {
    const f = setup();
    f.card();
    await f.sync();
    await f.sync(merged());
    const other = await project(f, "https://github.com/owner/repo/pull/8");
    const read = f.client.snapshot.getMockImplementation()!;
    f.client.snapshot.mockImplementation((async (_repository: string, number: number) => (number === 8 ? pr(8) : read())) as never);
    let release!: () => void;
    f.client.pushRuns.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ total: 0, runs: [] }); }));
    const startup = f.service.startEvents();
    await vi.waitFor(() => expect(f.client.pushRuns).toHaveBeenCalledTimes(1));
    due(f);
    const tick = f.service.runDue();
    await vi.waitFor(() => expect((f.client.snapshot.mock.calls as unknown[][]).some((call) => call[1] === 8)).toBe(true));
    expect(createGitSyncStore(f.db).linksForProject(other.id)).toHaveLength(1);
    release();
    await Promise.all([startup, tick]);
    expect(f.client.pushRuns).toHaveBeenCalledTimes(1);
  });

  it("stops a slow wait at the sweep deadline without a final pass, refreshes first on the next run and sends one deployment", async () => {
    const f = setup();
    const task = f.card();
    await f.sync();
    await f.sync(merged());
    f.deadline(Date.now() - 120_000);
    // Three successes on descendants: each needs a compare, and each compare takes 20 s.
    f.runs.push(run(1, { headSha: b }), run(2, { headSha: b, createdAt: new Date(Date.now() - DAY / 3).toISOString() }), run(3, { headSha: b, createdAt: new Date(Date.now() - DAY / 4).toISOString() }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const refreshedBeforeCompare: number[] = [];
    f.client.compareStatus.mockImplementation(async () => {
      refreshedBeforeCompare.push(f.client.snapshot.mock.calls.length);
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      return "ahead";
    });
    f.client.snapshot.mockClear();
    due(f);
    const first = f.service.runDue();
    await vi.advanceTimersByTimeAsync(45_000);
    await first;
    expect(refreshedBeforeCompare).toEqual([1, 1, 1]);
    expect(f.waits()).toMatchObject([{ state: "waiting", final_passes: 0 }]);
    expect(JSON.parse(f.waits()[0]!.found!)).toMatchObject({ runId: 1 });
    expect(f.harness.logEntries).toContainEqual(expect.objectContaining({ level: "info", message: "PR event sweep advanced 1 deployment waits and stopped at its budget with 1 left for the next run" }));
    due(f);
    const second = f.service.runDue();
    await vi.advanceTimersByTimeAsync(20_000);
    await second;
    // The next run refreshed the PR before the sweep resumed with the third compare.
    expect(refreshedBeforeCompare).toEqual([1, 1, 1, 2]);
    expect(f.waits()).toMatchObject([{ state: "deployed" }]);
    await f.sweep();
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM pr_events WHERE kind='deployed'").get()).toEqual({ n: 1 });
    expect(f.to("thr_worker").filter((text) => text.startsWith(`${task.key} · PR #7: deploy run`))).toEqual([`${task.key} · PR #7: deploy run 1 succeeded with merge ddddddd. Collect the deployment evidence, run the final check and close the card; Work Board does not close it.`]);
  });

  it("takes waits least recently swept first across projects, so a capped sweep starves none and a cut final pass is not counted", async () => {
    const f = setup();
    const task = f.card();
    await f.sync();
    const other = await project(f, URL);
    await f.service.syncProject(other.id, true);
    await f.sync(merged());
    await f.service.syncProject(other.id, true);
    // The tracker's wait has the earlier deadline, so ordering by deadline alone would always take it first.
    f.db.prepare("UPDATE pr_deploy_waits SET deadline=? WHERE project_id=?").run(new Date(Date.now() + 10 * DAY).toISOString(), other.id);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    // Each listing takes 30 s, so a 45 s sweep finishes one wait and is cut in the next.
    const list = f.client.pushRuns.getMockImplementation()!;
    f.client.pushRuns.mockImplementation(async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 30_000));
      return list(...args);
    });
    const capped = async () => {
      f.db.prepare("UPDATE pr_deploy_waits SET next_sweep_at=NULL").run();
      const running = f.service.sweep([f.tracker.id, other.id]);
      await vi.advanceTimersByTimeAsync(45_000);
      await running;
      await f.events.drain();
    };
    await capped();
    const trackerTurn = sweptAt(f, f.tracker.id).swept_at;
    expect(trackerTurn).not.toBeNull();
    expect(sweptAt(f, other.id)).toEqual({ swept_at: null, final_passes: 0, state: "waiting" });
    // The tracker's wait crosses its deadline before its next turn; its final pass still has a range to read.
    f.deadline(Date.now() - 50_000);
    f.db.prepare("UPDATE pr_deploy_waits SET deadline=? WHERE project_id=?").run(new Date(Date.now() + 10 * DAY).toISOString(), other.id);
    await capped();
    expect(sweptAt(f, other.id).swept_at).not.toBeNull();
    expect(sweptAt(f, f.tracker.id)).toEqual({ swept_at: trackerTurn, final_passes: 0, state: "waiting" });
    await capped();
    expect(sweptAt(f, f.tracker.id).state).toBe("expired");
    expect(f.to("thr_worker").filter((text) => text.includes("stopped waiting"))).toEqual([`${task.key} · PR #7: Work Board saw no successful deploy run with merge ddddddd within 7 days; it stopped waiting.`]);
  });

  it("records the turn of a slow wait cut on a fresh budget, so it cannot take every sweep", async () => {
    const f = setup();
    f.card();
    await f.sync();
    const other = await project(f, URL);
    await f.service.syncProject(other.id, true);
    await f.sync(merged());
    await f.service.syncProject(other.id, true);
    f.db.prepare("UPDATE pr_deploy_waits SET deadline=? WHERE project_id=?").run(new Date(Date.now() + 10 * DAY).toISOString(), other.id);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    // Every listing takes 50 s, longer than the whole budget.
    const list = f.client.pushRuns.getMockImplementation()!;
    f.client.pushRuns.mockImplementation(async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 50_000));
      return list(...args);
    });
    const capped = async () => {
      f.db.prepare("UPDATE pr_deploy_waits SET next_sweep_at=NULL").run();
      const running = f.service.sweep([f.tracker.id, other.id]);
      await vi.advanceTimersByTimeAsync(45_000);
      await running;
    };
    await capped();
    expect(sweptAt(f, f.tracker.id).swept_at).not.toBeNull();
    expect(sweptAt(f, other.id).swept_at).toBeNull();
    await capped();
    expect(sweptAt(f, other.id)).toMatchObject({ final_passes: 0, state: "waiting" });
    expect(sweptAt(f, other.id).swept_at).not.toBeNull();
  });

  it("gives a wait cut on a fresh budget the first slot of the next sweep, so its listing and compare finish", async () => {
    const f = setup();
    f.card();
    await f.sync();
    const other = await project(f, URL);
    await f.service.syncProject(other.id, true);
    await f.sync(merged());
    await f.service.syncProject(other.id, true);
    // The tracker's wait (A) merged later than the run, so only the other wait (B) sees it and needs a compare; A goes first.
    f.db.prepare("UPDATE pr_deploy_waits SET merged_at=? WHERE project_id=?").run(new Date(Date.now() - DAY / 4).toISOString(), f.tracker.id);
    f.db.prepare("UPDATE pr_deploy_waits SET deadline=? WHERE project_id=?").run(new Date(Date.now() + 10 * DAY).toISOString(), other.id);
    f.runs.push(run(1, { headSha: b }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const list = f.client.pushRuns.getMockImplementation()!;
    // A's listing takes 12 s; B's takes 18 s and its compare another 18 s.
    f.client.pushRuns.mockImplementation(async (...args) => {
      const page = await list(...args);
      await new Promise((resolve) => setTimeout(resolve, page.total ? 18_000 : 12_000));
      return page;
    });
    f.client.compareStatus.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 18_000));
      return "ahead";
    });
    const tick = async () => {
      const running = f.service.sweep([f.tracker.id, other.id]);
      await vi.advanceTimersByTimeAsync(45_000);
      await running;
      vi.setSystemTime(Date.now() + 6 * 60_000);
    };
    await tick();
    expect(sweptAt(f, other.id)).toMatchObject({ final_passes: 0, state: "waiting" });
    expect(sweptAt(f, other.id).swept_at).toBe(sweptAt(f, f.tracker.id).swept_at);
    await tick();
    expect(sweptAt(f, other.id).state).toBe("deployed");
    expect(f.client.compareStatus).toHaveBeenCalledTimes(2);
  });

  it("treats a last read that ends past the deadline as cut, so it charges no final pass", async () => {
    const f = setup();
    f.card();
    await f.sync();
    await f.sync(merged());
    f.deadline(Date.now() - 120_000);
    f.db.prepare("UPDATE pr_deploy_waits SET final_passes=2").run();
    // A success with no completion time stays kept, so this pass would be the third unfinished final pass.
    f.runs.push(run(1, { updatedAt: null }));
    vi.useFakeTimers({ toFake: ["Date"] });
    f.client.workflowRunById.mockImplementation(async (_repository, id) => {
      vi.setSystemTime(Date.now() + 50_000);
      return f.runs.find((value) => value.id === id)!;
    });
    await f.service.sweep([f.tracker.id]);
    expect(f.client.workflowRunById).toHaveBeenCalledTimes(1);
    expect(f.waits()).toMatchObject([{ state: "waiting", final_passes: 2 }]);
  });

  it("checks the sweep deadline before each read and between waits, even before its timer fires", async () => {
    const f = setup();
    f.card();
    await f.sync();
    await f.sync(merged());
    f.deadline(Date.now() - 120_000);
    f.runs.push(...[2, 3, 4, 5].map((part, index) => run(index + 1, { headSha: b, createdAt: new Date(Date.now() - DAY / part).toISOString() })));
    // Only the clock moves: each compare takes 20 s of it, and the budget timer never fires during the sweep.
    vi.useFakeTimers({ toFake: ["Date"] });
    f.client.compareStatus.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 20_000);
      return "ahead";
    });
    await f.service.sweep([f.tracker.id]);
    expect(f.client.compareStatus).toHaveBeenCalledTimes(3);
    expect(f.waits()).toMatchObject([{ state: "waiting", final_passes: 0 }]);
    expect(JSON.parse(f.waits()[0]!.found!)).toMatchObject({ runId: 1 });
  });

  it("rechecks enabled before each scheduled refresh and collects enabled projects again for the sweep", async () => {
    const f = setup();
    f.card();
    await f.sync();
    const swept = await project(f, URL);
    await f.service.syncProject(swept.id, true);
    await f.sync(merged());
    await f.service.syncProject(swept.id, true);
    await f.service.handlers.setGitSyncConfig({ projectId: swept.id, config: { ...config, enabled: false } as never });
    const skipped = await project(f, "https://github.com/owner/repo/pull/8", "SKP");
    const read = f.client.snapshot.getMockImplementation()!;
    // The tracker's refresh turns one project off and the other back on.
    f.client.snapshot.mockImplementation((async (_repository: string, number: number) => {
      if (number === 8) return pr(8);
      await f.service.handlers.setGitSyncConfig({ projectId: skipped.id, config: { ...config, enabled: false } as never });
      await f.service.handlers.setGitSyncConfig({ projectId: swept.id, config: config as never });
      return read();
    }) as never);
    f.client.snapshot.mockClear();
    f.db.prepare("UPDATE pr_deploy_waits SET next_sweep_at=NULL").run();
    due(f);
    await f.service.runDue();
    expect((f.client.snapshot.mock.calls as unknown[][]).map((call) => call[1])).toEqual([7]);
    expect(sweptAt(f, swept.id).swept_at).not.toBeNull();
  });

  it("sends a PR event while the pass still reads the next PR, once", async () => {
    const f = setup();
    const task = f.card();
    f.service.remember(task.id, "https://github.com/owner/repo/pull/8", "manual", { role: "related", part: null });
    f.client.snapshot.mockImplementation((async (_repository: string, number: number) => pr(number, green())) as never);
    await f.service.syncProject(f.tracker.id, true);
    let release!: () => void, calls = 0;
    f.client.snapshot.mockImplementation((async (_repository: string, number: number) => {
      if (++calls === 1) return pr(number, red());
      await new Promise<void>((resolve) => { release = resolve; });
      return pr(number, green());
    }) as never);
    const pass = f.service.syncProject(f.tracker.id, true);
    await vi.waitFor(() => expect(f.to("thr_worker")).toHaveLength(1));
    expect(calls).toBe(2);
    release();
    await pass;
    await f.events.drain();
    expect(f.to("thr_worker")).toHaveLength(1);
    expect(f.to("thr_worker")[0]).toContain("CI red");
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
    const gone = f.card("Gone", "in_review", "thr_gone"), flaky = f.card("Flaky", "in_review", "thr_flaky");
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
    // The run refreshes first, so its own sweep settles the wait it just armed.
    expect(f.waits()).toMatchObject([{ state: "expired" }]);
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
    expect(f.waits()).toMatchObject([{ state: "expired", baseline_at: null }]);
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

describe("PR message recipient", () => {
  const record = (f: ReturnType<typeof setup>, value: Partial<PrSnapshot>) =>
    f.db.transaction(() => recordPrEvents(f.db, f.store.tasks, { projectId: f.tracker.id, config: createGitSyncStore(f.db).config(f.tracker.id), snapshot: snap(value) }))();
  /** Each session's environment and the PR each environment is on, as GitHub PR Status reports it; `gate` holds the PR read. */
  const world = (f: ReturnType<typeof setup>) => {
    const state = { env: {} as Record<string, string>, onPr: new Set<string>(), urlOf: {} as Record<string, string>, gate: undefined as Promise<void> | undefined, fail: false, reads: 0 };
    const callRpc = f.threads.sdk.plugins.callRpc;
    f.harness.sdk.stub("threads.list", async ({ threadIds }: { threadIds: string[] }) => threadIds.map((id) => ({ id, environmentId: state.env[id] ?? null })) as never);
    f.harness.sdk.stub("plugins.callRpc", async (args: { pluginId: string; method: string; input: { keys: string[] } }) => {
      if (args.pluginId !== "bb--github-pr-status") return callRpc(args as never);
      state.reads++;
      if (state.gate) await state.gate;
      if (state.fail) throw new Error("plugin unavailable");
      return Object.fromEntries(args.input.keys.map((key) => [key, state.onPr.has(key)
        ? { outcome: "available", pullRequest: { number: 7, title: "EXA work", state: "open", url: state.urlOf[key] ?? URL, updatedAt: new Date().toISOString() } }
        : { outcome: "absent" }]));
    });
    return state;
  };
  const attach = (f: ReturnType<typeof setup>, taskId: string, threadId: string) => {
    f.store.tasks.upsertTaskThread({ taskId, threadId, presetName: "Reader", title: "R", liveStatus: "working" });
    f.threads.threads.set(threadId, { status: "active" });
  };
  const rows = (f: ReturnType<typeof setup>) => f.db.prepare<[], { task_id: string; state: string; thread_id: string | null; next_attempt_at: string | null; error: string | null }>(
    "SELECT task_id, state, thread_id, next_attempt_at, error FROM pr_event_deliveries WHERE role='session' ORDER BY created_at").all();
  const text = (key: string, head = "bbbbbbb") => `${key} · PR #7 CI red on ${head}: failed lint, unit-tests.`;

  it("goes to the one session on the PR after a complete lookup, or to a card's only session, with one lookup per drain", async () => {
    const f = setup(), w = world(f);
    const shared = f.card("Shared", "in_review", "thr_author"), solo = f.card("Solo", "in_review", "thr_solo"), idle = f.card("Idle", "in_review", "thr_idle_a");
    attach(f, shared.id, "thr_reader");
    attach(f, idle.id, "thr_idle_b");
    Object.assign(w.env, { thr_author: "env_author", thr_reader: "env_reader", thr_solo: "env_solo", thr_idle_a: "env_idle_a", thr_idle_b: "env_idle_b" });
    w.onPr.add("env_author");
    await f.sync(green());
    w.reads = 0;
    record(f, red(b));
    await f.events.drain();
    expect(w.reads).toBe(1);
    expect(f.to("thr_author")).toEqual([text(shared.key)]);
    expect(f.to("thr_reader")).toEqual([]);
    expect(f.to("thr_solo")).toEqual([text(solo.key)]);
    expect(rows(f).find((row) => row.task_id === idle.id)).toMatchObject({ state: "awaiting_owner" });
  });

  it("holds when the sessions cannot be told apart, and never remembers an earlier match", async () => {
    const f = setup(), w = world(f);
    const separate = f.card("Separate", "in_review", "thr_s1"), checkout = f.card("Checkout", "in_review", "thr_c1"), none = f.card("None", "in_review", "thr_n1");
    const later = f.card("Later", "in_review", "thr_author");
    for (const [task, thread] of [[separate, "thr_s2"], [checkout, "thr_c2"], [none, "thr_n2"], [later, "thr_reviewer"]] as const) attach(f, task.id, thread);
    // Separate checkouts both on the PR, one checkout shared by two sessions, and two sessions on no PR.
    Object.assign(w.env, { thr_s1: "env_s1", thr_s2: "env_s2", thr_c1: "env_c", thr_c2: "env_c", thr_n1: "env_n1", thr_n2: "env_n2", thr_author: "env_author", thr_reviewer: "env_reviewer" });
    for (const env of ["env_s1", "env_s2", "env_c", "env_reviewer"]) w.onPr.add(env);
    await f.sync(green());
    record(f, red(b));
    await f.events.drain();
    // The reviewer is the only session on the branch, so this message is its by the rule.
    expect(f.to("thr_reviewer")).toEqual([text(later.key)]);
    const held = rows(f).filter((row) => row.state === "awaiting_owner");
    expect(held.map((row) => row.task_id).sort()).toEqual([separate.id, checkout.id, none.id].sort());
    for (const row of held) expect(Date.parse(row.next_attempt_at!) - Date.now()).toBeGreaterThan(29 * 60_000);
    // Once the author checks out the branch too, the next message waits instead of following the reviewer's earlier match.
    w.onPr.add("env_author");
    record(f, red(c));
    await f.events.drain();
    expect(f.to("thr_reviewer")).toHaveLength(1);
    expect(f.to("thr_author")).toEqual([]);
    expect(rows(f).filter((row) => row.task_id === later.id).map((row) => row.state)).toEqual(["sent", "awaiting_owner"]);
    for (const id of ["thr_s1", "thr_s2", "thr_c1", "thr_c2", "thr_n1", "thr_n2"]) expect(f.to(id)).toEqual([]);
  });

  it("delivers held rows at once to an owner named with --owner, keeps the owner on relinks and rediscovery, and follows an archived owner to its parent", async () => {
    const f = setup(), w = world(f);
    const task = f.card("Owned", "in_review", "thr_author");
    attach(f, task.id, "thr_reviewer");
    w.env.thr_reviewer = "env_reviewer";
    await f.sync(green());
    record(f, red(b));
    await f.events.drain();
    expect(rows(f)[0]).toMatchObject({ state: "awaiting_owner", error: expect.stringContaining("--owner") });
    expect(await f.harness.runCli(["pr", "link", task.key, "--url", URL, "--owner", "self"], { threadId: "thr_author" })).toMatchObject({ exitCode: 0 });
    await f.events.drain();
    expect(f.to("thr_author")).toEqual([text(task.key)]);
    expect(rows(f)[0]).toMatchObject({ state: "sent", thread_id: "thr_author" });
    // A reviewer's plain relink, environment rediscovery and a refresh all keep the designated owner.
    expect(await f.harness.runCli(["pr", "link", task.key, "--url", URL], { threadId: "thr_reviewer" })).toMatchObject({ exitCode: 0 });
    f.service.remember(task.id, URL, "environment");
    await f.sync(red(b));
    const owner = () => createGitSyncStore(f.db).links(task.id)[0]!.ownerThreadId;
    expect(owner()).toBe("thr_author");
    // The reviewer is now the only session on the branch, yet the owner gets the message.
    w.onPr.add("env_reviewer");
    record(f, red(c));
    await f.events.drain();
    expect(f.to("thr_author")).toEqual([text(task.key), text(task.key, "ccccccc")]);
    f.threads.threads.set("thr_author", { archived: true, parent: "thr_lead" });
    record(f, red(x));
    await f.events.drain();
    expect(f.to("thr_lead")).toEqual([text(task.key, "eeeeeee")]);
    expect(f.to("thr_reviewer")).toEqual([]);
    expect(owner()).toBe("thr_author");
  });

  it("never waits on a lookup that stays pending or fails, and a held row stays held", async () => {
    const f = setup(), w = world(f);
    environmentLookup.deadlineMs = 20;
    const solo = f.card("Solo", "in_review", "thr_solo"), pair = f.card("Pair", "in_review", "thr_a");
    attach(f, pair.id, "thr_b");
    Object.assign(w.env, { thr_a: "env_a", thr_b: "env_b" });
    w.onPr.add("env_a");
    await f.sync(green());
    w.gate = new Promise(() => {});
    record(f, red(b));
    await f.events.drain();
    expect(f.to("thr_solo")).toEqual([text(solo.key)]);
    expect(rows(f).find((row) => row.task_id === pair.id)).toMatchObject({ state: "awaiting_owner" });
    w.gate = undefined;
    w.fail = true;
    f.db.prepare("UPDATE pr_event_deliveries SET next_attempt_at=NULL").run();
    record(f, red(c));
    await f.events.drain();
    expect(f.to("thr_solo")).toHaveLength(2);
    expect(rows(f).filter((row) => row.task_id === pair.id).map((row) => row.state)).toEqual(["awaiting_owner", "awaiting_owner"]);
    expect(f.to("thr_a")).toEqual([]);
  });

  it("ends a held row after a day, and held rows never crowd out a newer ready one", async () => {
    const f = setup();
    world(f);
    const pair = f.card("Pair", "in_review", "thr_a");
    attach(f, pair.id, "thr_b");
    await f.sync(green());
    record(f, red(b));
    await f.events.drain();
    expect(rows(f)[0]).toMatchObject({ state: "awaiting_owner" });
    expect(f.db.prepare<[], { held_until: string; created_at: string }>("SELECT held_until, created_at FROM pr_event_deliveries").get()).toSatisfy(
      (row: { held_until: string; created_at: string }) => Date.parse(row.held_until) === Date.parse(row.created_at) + DAY);
    // A recheck never lands past the deadline.
    const until = new Date(Date.now() + 10 * 60_000).toISOString();
    f.db.prepare("UPDATE pr_event_deliveries SET next_attempt_at=NULL, held_until=?").run(until);
    await f.events.drain();
    expect(rows(f)[0]).toMatchObject({ state: "awaiting_owner", next_attempt_at: until });
    // An owner named after the deadline does not revive the message.
    f.db.prepare("UPDATE pr_event_deliveries SET held_until=?").run(new Date(Date.now() - 1000).toISOString());
    expect(await f.harness.runCli(["pr", "link", pair.key, "--url", URL, "--owner", "thr_a"])).toMatchObject({ exitCode: 0 });
    await f.events.drain();
    expect(rows(f)[0]).toMatchObject({ state: "no_recipient:ambiguous" });
    expect(f.to("thr_a")).toEqual([]);
    // 200 older held rows whose rechecks are all due still leave room for a newer row in the same drain.
    const old = new Date(Date.now() - 60_000).toISOString();
    for (let index = 0; index < 200; index++) {
      f.db.prepare("INSERT INTO pr_events(id, project_id, remote_id, identity, kind, once_key, payload, created_at) VALUES (?, ?, 'PR_7', 'github:github.com:owner/repo#7', 'ci', ?, '{\"number\":7}', ?)").run(`evt_${index}`, f.tracker.id, `held_${index}`, old);
      f.db.prepare("INSERT INTO pr_event_deliveries(id, event_id, task_id, role, state, next_attempt_at, held_until, created_at, updated_at) VALUES (?, ?, ?, 'session', 'awaiting_owner', ?, ?, ?, ?)").run(`held_${index}`, `evt_${index}`, pair.id, old, new Date(Date.now() + DAY).toISOString(), old, old);
    }
    f.db.prepare("UPDATE task_pr_links SET payload=json_remove(payload, '$.ownerThreadId')").run();
    const solo = f.card("Solo", "in_review", "thr_solo");
    record(f, red(c));
    await f.events.drain();
    expect(f.to("thr_solo")).toEqual([text(solo.key, "ccccccc")]);
  });

  it("sends rows that need no lookup while the lookup is still blocked", async () => {
    const f = setup(), w = world(f);
    environmentLookup.deadlineMs = 2_000;
    const pair = f.card("Pair", "in_review", "thr_a");
    attach(f, pair.id, "thr_b");
    Object.assign(w.env, { thr_a: "env_a", thr_b: "env_b" });
    await f.sync(green());
    record(f, red(b));
    f.db.prepare("UPDATE pr_event_deliveries SET created_at=?").run(new Date(Date.now() - 60_000).toISOString());
    const solo = f.card("Solo", "in_review", "thr_solo");
    let release!: () => void;
    w.gate = new Promise((resolve) => { release = resolve; });
    record(f, red(c));
    const drained = f.events.drain();
    await vi.waitFor(() => expect(f.to("thr_solo")).toEqual([text(solo.key, "ccccccc")]));
    expect(w.reads).toBeGreaterThan(0);
    release();
    await drained;
    expect(rows(f).filter((row) => row.task_id === pair.id).map((row) => row.state)).toEqual(["awaiting_owner", "awaiting_owner"]);
  });

  it("takes an owner named while the row was being resolved", async () => {
    const f = setup(), w = world(f);
    const pair = f.card("Pair", "in_review", "thr_a");
    attach(f, pair.id, "thr_b");
    Object.assign(w.env, { thr_a: "env_a", thr_b: "env_b" });
    await f.sync(green());
    w.reads = 0;
    let release!: () => void;
    w.gate = new Promise((resolve) => { release = resolve; });
    record(f, red(b));
    const drained = f.events.drain();
    await vi.waitFor(() => expect(w.reads).toBe(1));
    expect(await f.harness.runCli(["pr", "link", pair.key, "--url", URL, "--owner", "thr_b"])).toMatchObject({ exitCode: 0 });
    release();
    await drained;
    expect(f.to("thr_b")).toEqual([text(pair.key)]);
    expect(rows(f)[0]).toMatchObject({ state: "sent", thread_id: "thr_b" });
  });

  it("matches environments against the renamed repository only", async () => {
    const renamed = "https://github.com/owner/renamed/pull/7";
    const f = setup({ repositories: ["owner/repo", "owner/renamed"] }), w = world(f);
    const pair = f.card("Pair", "in_review", "thr_a");
    attach(f, pair.id, "thr_b");
    Object.assign(w.env, { thr_a: "env_a", thr_b: "env_b" });
    await f.sync(green());
    record(f, red(b));
    createGitSyncStore(f.db).saveSnapshot(f.tracker.id, { repository: "owner/repo", number: 7 }, snap({ repository: "owner/renamed", url: renamed }));
    // Another repository now owns the old path, and one session is on its PR #7.
    w.onPr.add("env_a");
    await f.events.drain();
    expect(f.to("thr_a")).toEqual([]);
    expect(rows(f)[0]).toMatchObject({ state: "awaiting_owner" });
    w.urlOf.env_b = renamed;
    w.onPr.add("env_b");
    f.db.prepare("UPDATE pr_event_deliveries SET next_attempt_at=NULL").run();
    await f.events.drain();
    expect(f.to("thr_b")).toEqual([text(pair.key)]);
  });

  it("resolves again when the repository is renamed during resolution", async () => {
    const renamed = "https://github.com/owner/renamed/pull/7";
    const f = setup({ repositories: ["owner/repo", "owner/renamed"] }), w = world(f);
    const pair = f.card("Pair", "in_review", "thr_a");
    attach(f, pair.id, "thr_b");
    Object.assign(w.env, { thr_a: "env_a", thr_b: "env_b" });
    // The old path's PR #7, which after the rename belongs to another repository.
    w.onPr.add("env_a");
    await f.sync(green());
    w.reads = 0;
    let release!: () => void;
    w.gate = new Promise((resolve) => { release = resolve; });
    record(f, red(b));
    const drained = f.events.drain();
    await vi.waitFor(() => expect(w.reads).toBe(1));
    createGitSyncStore(f.db).saveSnapshot(f.tracker.id, { repository: "owner/repo", number: 7 }, snap({ repository: "owner/renamed", url: renamed }));
    release();
    await drained;
    expect(f.to("thr_a")).toEqual([]);
    expect(rows(f)[0]).toMatchObject({ state: "awaiting_owner" });
  });

  it("keeps a held row's deadline and wake through a return to pending", async () => {
    const f = setup(), w = world(f);
    const pair = f.card("Pair", "in_review", "thr_a");
    attach(f, pair.id, "thr_b");
    Object.assign(w.env, { thr_a: "env_a", thr_b: "env_b" });
    await f.sync(green());
    record(f, red(b));
    await f.events.drain();
    expect(rows(f)[0]).toMatchObject({ state: "awaiting_owner" });
    // A retry or a recovered claim puts the held row back in pending; past its deadline it ends even with a sole match now.
    f.db.prepare("UPDATE pr_event_deliveries SET state='pending', next_attempt_at=NULL, held_until=?").run(new Date(Date.now() - 1000).toISOString());
    w.onPr.add("env_a");
    await f.events.drain();
    expect(rows(f)[0]).toMatchObject({ state: "no_recipient:ambiguous" });
    expect(f.to("thr_a")).toEqual([]);
    // Within its deadline, a held row in backoff is still woken by a designation.
    w.onPr.add("env_b");
    record(f, red(c));
    await f.events.drain();
    expect(rows(f)[1]).toMatchObject({ state: "awaiting_owner" });
    f.db.prepare("UPDATE pr_event_deliveries SET state='pending', lookup_failures=1, next_attempt_at=? WHERE state='awaiting_owner'").run(new Date(Date.now() + 3_600_000).toISOString());
    expect(await f.harness.runCli(["pr", "link", pair.key, "--url", URL, "--owner", "thr_b"])).toMatchObject({ exitCode: 0 });
    await f.events.drain();
    expect(f.to("thr_b")).toEqual([text(pair.key, "ccccccc")]);
  });

  it("ends a row whose resolution crossed its deadline instead of sending it", async () => {
    const f = setup(), w = world(f);
    const pair = f.card("Pair", "in_review", "thr_a");
    attach(f, pair.id, "thr_b");
    Object.assign(w.env, { thr_a: "env_a", thr_b: "env_b" });
    await f.sync(green());
    record(f, red(b));
    await f.events.drain();
    const until = Date.now() + 100;
    f.db.prepare("UPDATE pr_event_deliveries SET next_attempt_at=NULL, held_until=?").run(new Date(until).toISOString());
    w.reads = 0;
    let release!: () => void;
    w.gate = new Promise((resolve) => { release = resolve; });
    const drained = f.events.drain();
    await vi.waitFor(() => expect(w.reads).toBe(1));
    await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(until));
    w.onPr.add("env_a");
    release();
    await drained;
    expect(f.to("thr_a")).toEqual([]);
    expect(rows(f)[0]).toMatchObject({ state: "no_recipient:ambiguous" });
  });

  it("puts a woken row ahead of 200 older due rechecks", async () => {
    const f = setup(), w = world(f);
    const crowd = f.card("Crowd", "in_review", "thr_c1"), pair = f.card("Pair", "in_review", "thr_a");
    attach(f, crowd.id, "thr_c2");
    attach(f, pair.id, "thr_b");
    Object.assign(w.env, { thr_a: "env_a", thr_b: "env_b" });
    await f.sync(green());
    const old = new Date(Date.now() - 60_000).toISOString(), until = new Date(Date.now() + DAY).toISOString();
    for (let index = 0; index < 200; index++) {
      f.db.prepare("INSERT INTO pr_events(id, project_id, remote_id, identity, kind, once_key, payload, created_at) VALUES (?, ?, 'PR_7', 'github:github.com:owner/repo#7', 'ci', ?, '{\"number\":7}', ?)").run(`evt_${index}`, f.tracker.id, `held_${index}`, old);
      f.db.prepare("INSERT INTO pr_event_deliveries(id, event_id, task_id, role, state, next_attempt_at, held_until, created_at, updated_at) VALUES (?, ?, ?, 'session', 'awaiting_owner', ?, ?, ?, ?)").run(`held_${index}`, `evt_${index}`, crowd.id, old, until, old, old);
    }
    record(f, red(b));
    f.db.prepare("UPDATE pr_event_deliveries SET state='awaiting_owner', next_attempt_at=?, held_until=? WHERE task_id=? AND role='session'").run(new Date(Date.now() + 1_800_000).toISOString(), until, pair.id);
    f.db.prepare("UPDATE pr_event_deliveries SET state='skipped:test' WHERE task_id=? AND event_id NOT LIKE 'evt_%'").run(crowd.id);
    // The owner is named and the held row woken; one drain must deliver it.
    f.db.prepare("UPDATE task_pr_links SET payload=json_set(payload, '$.ownerThreadId', 'thr_a') WHERE task_id=?").run(pair.id);
    expect(f.events.wake(createGitSyncStore(f.db).links(pair.id)[0]!)).toBe(true);
    const reads: string[] = [], get = f.threads.sdk.threads.get;
    f.harness.sdk.stub("threads.get", async (args: { threadId: string }) => { reads.push(args.threadId); return get(args as never); });
    await f.events.drain();
    expect(f.to("thr_a")).toEqual([text(pair.key)]);
    // It is resolved before any of the older rechecks.
    expect(reads.indexOf("thr_a")).toBeLessThan(reads.indexOf("thr_c1"));
    expect(reads.indexOf("thr_c1")).toBeGreaterThan(-1);
  });

  it("claims only the state it listed, with the hold deadline as it is now", async () => {
    const f = setup(), w = world(f);
    const other = createPrEventService(f.bb, f.store.tasks);
    const first = f.card("First", "in_review", "thr_first"), back = f.card("Back", "in_review", "thr_a"), held = f.card("Held", "in_review", "thr_c");
    attach(f, back.id, "thr_b");
    attach(f, held.id, "thr_d");
    Object.assign(w.env, { thr_a: "env_a", thr_b: "env_b", thr_c: "env_c", thr_d: "env_d" });
    await f.sync(green());
    record(f, red(b));
    f.db.prepare("UPDATE pr_event_deliveries SET created_at=? WHERE task_id=?").run(new Date(Date.now() - 60_000).toISOString(), first.id);
    // This drainer lists every row as pending, then stalls on the first one while another drainer holds the others.
    let release!: () => void;
    f.threads.getGateOnce = new Promise((resolve) => { release = resolve; });
    const stalled = f.events.drain();
    await vi.waitFor(() => expect(f.threads.getGateOnce).toBeUndefined());
    await other.drain();
    expect(rows(f).filter((row) => row.state === "awaiting_owner").map((row) => row.task_id).sort()).toEqual([back.id, held.id].sort());
    // One went back to pending past its deadline (a retry), with a sole match now; the other is a due recheck.
    f.db.prepare("UPDATE pr_event_deliveries SET state='pending', next_attempt_at=NULL, held_until=? WHERE task_id=?").run(new Date(Date.now() - 1000).toISOString(), back.id);
    f.db.prepare("UPDATE pr_event_deliveries SET next_attempt_at=NULL WHERE task_id=?").run(held.id);
    w.onPr.add("env_a");
    release();
    await stalled;
    expect(f.to("thr_first")).toEqual([text(first.key)]);
    expect(f.to("thr_a")).toEqual([]);
    expect(rows(f).find((row) => row.task_id === back.id)).toMatchObject({ state: "no_recipient:ambiguous" });
    expect(rows(f).find((row) => row.task_id === held.id)).toMatchObject({ state: "awaiting_owner", next_attempt_at: null });
  });

  it("resolves against an owner named while the previous owner's read was failing", async () => {
    const f = setup(), w = world(f);
    const task = f.card("Owned", "in_review", "thr_a");
    attach(f, task.id, "thr_b");
    Object.assign(w.env, { thr_a: "env_a", thr_b: "env_b" });
    await f.sync(green());
    f.db.prepare("UPDATE task_pr_links SET payload=json_set(payload, '$.ownerThreadId', 'thr_old')").run();
    let fail!: () => void, reading = false;
    const gate = new Promise<void>((resolve) => { fail = resolve; }), get = f.threads.sdk.threads.get;
    f.harness.sdk.stub("threads.get", async (args: { threadId: string }) => {
      if (args.threadId !== "thr_old") return get(args as never);
      reading = true;
      await gate;
      throw new Error("host unreachable");
    });
    record(f, red(b));
    const drained = f.events.drain();
    await vi.waitFor(() => expect(reading).toBe(true));
    expect(await f.harness.runCli(["pr", "link", task.key, "--url", URL, "--owner", "thr_b"])).toMatchObject({ exitCode: 0 });
    fail();
    await drained;
    expect(f.to("thr_b")).toEqual([text(task.key)]);
  });

  it("caps a held row's retry at its deadline and ends it when a failed read crossed the deadline", async () => {
    const f = setup(), w = world(f);
    const task = f.card("Pair", "in_review", "thr_a");
    attach(f, task.id, "thr_b");
    Object.assign(w.env, { thr_a: "env_a", thr_b: "env_b" });
    await f.sync(green());
    record(f, red(b));
    await f.events.drain();
    expect(rows(f)[0]).toMatchObject({ state: "awaiting_owner" });
    f.db.prepare("UPDATE task_pr_links SET payload=json_set(payload, '$.ownerThreadId', 'thr_old')").run();
    let gate: Promise<void> | undefined;
    const get = f.threads.sdk.threads.get;
    f.harness.sdk.stub("threads.get", async (args: { threadId: string }) => {
      if (args.threadId !== "thr_old") return get(args as never);
      if (gate) await gate;
      throw new Error("host unreachable");
    });
    const soon = new Date(Date.now() + 10_000).toISOString();
    f.db.prepare("UPDATE pr_event_deliveries SET next_attempt_at=NULL, held_until=?").run(soon);
    await f.events.drain();
    expect(rows(f)[0]).toMatchObject({ state: "pending", next_attempt_at: soon });
    const until = Date.now() + 100;
    let release!: () => void;
    gate = new Promise((resolve) => { release = resolve; });
    f.db.prepare("UPDATE pr_event_deliveries SET next_attempt_at=NULL, held_until=?").run(new Date(until).toISOString());
    const drained = f.events.drain();
    await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(until));
    release();
    await drained;
    expect(rows(f)[0]).toMatchObject({ state: "no_recipient:ambiguous" });
  });

  /** Links `threadId` to the card (when `taskId` is given) as a child of `parent`; without `taskId` it is an unlinked helper. */
  const child = (f: ReturnType<typeof setup>, taskId: string | undefined, threadId: string, parent: string) => {
    if (taskId) attach(f, taskId, threadId);
    f.threads.threads.set(threadId, { status: "active", parent });
  };

  it("goes to the one root of the card's session tree before the session on the PR, through unlinked helpers and long chains", async () => {
    const f = setup(), w = world(f);
    const fan = f.card("Fan", "in_review", "thr_fan"), onPr = f.card("OnPr", "in_review", "thr_pr"), helper = f.card("Helper", "in_review", "thr_h");
    const long = f.card("Long", "in_review", "thr_l"), roots = f.card("Roots", "in_review", "thr_ra");
    for (const id of ["thr_fan_1", "thr_fan_2", "thr_fan_3"]) child(f, fan.id, id, "thr_fan");
    child(f, onPr.id, "thr_pr_child", "thr_pr");
    child(f, undefined, "thr_h_helper", "thr_h");
    child(f, helper.id, "thr_h_reader", "thr_h_helper");
    // Nine hops: the reader, eight unlinked helpers, then the lead.
    for (let hop = 1; hop <= 8; hop++) child(f, undefined, `thr_l_${hop}`, hop === 1 ? "thr_l" : `thr_l_${hop - 1}`);
    child(f, long.id, "thr_l_reader", "thr_l_8");
    // Two roots: the on-PR rule picks between them as before.
    attach(f, roots.id, "thr_rb");
    child(f, roots.id, "thr_ra_child", "thr_ra");
    Object.assign(w.env, { thr_pr_child: "env_pr_child", thr_l_reader: "env_l_reader", thr_rb: "env_rb" });
    for (const env of ["env_pr_child", "env_l_reader", "env_rb"]) w.onPr.add(env);
    await f.sync(green());
    record(f, red(b));
    await f.events.drain();
    expect(f.to("thr_fan")).toEqual([text(fan.key)]);
    expect(f.to("thr_pr")).toEqual([text(onPr.key)]);
    expect(f.to("thr_h")).toEqual([text(helper.key)]);
    expect(f.to("thr_l")).toEqual([text(long.key)]);
    expect(f.to("thr_rb")).toEqual([text(roots.key)]);
    for (const id of ["thr_fan_1", "thr_fan_2", "thr_fan_3", "thr_pr_child", "thr_h_helper", "thr_h_reader", "thr_l_reader", "thr_ra", "thr_ra_child"]) expect(f.to(id)).toEqual([]);
  });

  it("lets a designated owner win over the root", async () => {
    const f = setup();
    world(f);
    const task = f.card("Owned", "in_review", "thr_lead");
    child(f, task.id, "thr_child", "thr_lead");
    await f.sync(green());
    expect(await f.harness.runCli(["pr", "link", task.key, "--url", URL, "--owner", "thr_child"])).toMatchObject({ exitCode: 0 });
    record(f, red(b));
    await f.events.drain();
    expect(f.to("thr_child")).toEqual([text(task.key)]);
    expect(f.to("thr_lead")).toEqual([]);
  });

  it("retries a failed ancestor read instead of sending elsewhere, and reads no ancestor of a sole link", async () => {
    const f = setup();
    world(f);
    const pair = f.card("Pair", "in_review", "thr_lead"), solo = f.card("Solo", "in_review", "thr_solo");
    child(f, undefined, "thr_helper", "thr_lead");
    child(f, pair.id, "thr_reader", "thr_helper");
    f.threads.threads.set("thr_solo", { status: "active", parent: "thr_broken" });
    await f.sync(green());
    const get = f.threads.sdk.threads.get;
    f.harness.sdk.stub("threads.get", async (args: { threadId: string }) => {
      if (args.threadId === "thr_helper" || args.threadId === "thr_broken") throw new Error("host unreachable");
      return get(args as never);
    });
    record(f, red(b));
    await f.events.drain();
    expect(f.to("thr_solo")).toEqual([text(solo.key)]);
    expect(rows(f).find((row) => row.task_id === pair.id)).toMatchObject({ state: "pending", next_attempt_at: expect.any(String), error: "host unreachable" });
    expect(f.to("thr_lead")).toEqual([]);
    expect(f.to("thr_reader")).toEqual([]);
  });

  it("backs off a failed reconcile instead of routing by stale links, and sends to the worker once it finishes", async () => {
    const f = setup();
    world(f);
    const task = f.card("Inherited", "in_review", "thr_manager");
    await f.sync(green());
    // The manager was linked as a parent fallback; a worker it started was attached since.
    f.store.tasks.createComment({ taskId: task.id, threadId: "thr_manager", kind: "system", authorName: "Work Board", body: "Thread attached (parent fallback): @thread:thr_manager" });
    child(f, task.id, "thr_new", "thr_manager");
    let failures = 1;
    const get = f.threads.sdk.threads.get;
    f.harness.sdk.stub("threads.get", async (args: { threadId: string }) => {
      if (failures > 0) { failures--; throw new Error("host unreachable"); }
      return get(args as never);
    });
    record(f, red(b));
    await f.events.drain();
    expect(f.threads.requests).toEqual([]);
    expect(rows(f)[0]).toMatchObject({ state: "pending", next_attempt_at: expect.any(String) });
    f.db.prepare("UPDATE pr_event_deliveries SET next_attempt_at=NULL").run();
    await f.events.drain();
    expect(f.store.tasks.listTaskThreads(task.id).map((link) => link.threadId)).toEqual(["thr_new"]);
    expect(f.to("thr_new")).toEqual([text(task.key)]);
    expect(f.to("thr_manager")).toEqual([]);
  });

  it("backs off when a worker is attached while the reconcile reads the inherited manager, then sends to the worker only", async () => {
    const f = setup();
    world(f);
    const task = f.card("Racing", "in_review", "thr_manager");
    await f.sync(green());
    f.store.tasks.createComment({ taskId: task.id, threadId: "thr_manager", kind: "system", authorName: "Work Board", body: "Thread attached (parent fallback): @thread:thr_manager" });
    let attached = false;
    const get = f.threads.sdk.threads.get;
    f.harness.sdk.stub("threads.get", async (args: { threadId: string }) => {
      const thread = await get(args as never);
      if (args.threadId === "thr_manager" && !attached) { attached = true; child(f, task.id, "thr_new", "thr_manager"); }
      return thread;
    });
    record(f, red(b));
    await f.events.drain();
    expect(f.threads.requests).toEqual([]);
    expect(rows(f)[0]).toMatchObject({ state: "pending", next_attempt_at: expect.any(String) });
    f.db.prepare("UPDATE pr_event_deliveries SET next_attempt_at=NULL").run();
    await f.events.drain();
    expect(f.to("thr_new")).toEqual([text(task.key)]);
    expect(f.to("thr_manager")).toEqual([]);
  });

  /** A card whose manager link is a parent fallback, with a worker the manager started attached since; `during` runs on the manager's first read. */
  const inherited = async (f: ReturnType<typeof setup>, during: (taskId: string, linkOf: (threadId: string) => string) => void) => {
    const task = f.card("Inherited", "in_review", "thr_manager");
    await f.sync(green());
    f.store.tasks.createComment({ taskId: task.id, threadId: "thr_manager", kind: "system", authorName: "Work Board", body: "Thread attached (parent fallback): @thread:thr_manager" });
    child(f, task.id, "thr_new", "thr_manager");
    const linkOf = (threadId: string) => f.store.tasks.listTaskThreads(task.id).find((link) => link.threadId === threadId)!.id;
    let done = false;
    const get = f.threads.sdk.threads.get;
    f.harness.sdk.stub("threads.get", async (args: { threadId: string }) => {
      const thread = await get(args as never);
      if (args.threadId === "thr_manager" && !done) { done = true; during(task.id, linkOf); }
      return thread;
    });
    record(f, red(b));
    await f.events.drain();
    expect(f.threads.requests).toEqual([]);
    expect(rows(f)[0]).toMatchObject({ state: "pending", next_attempt_at: expect.any(String) });
    f.db.prepare("UPDATE pr_event_deliveries SET next_attempt_at=NULL").run();
    await f.events.drain();
    return task;
  };

  it("backs off when the worker is detached while the reconcile reads, and keeps the manager fallback", async () => {
    const f = setup();
    world(f);
    const task = await inherited(f, (_taskId, linkOf) => f.store.tasks.deleteTaskThread(linkOf("thr_new")));
    expect(f.store.tasks.listTaskThreads(task.id).map((link) => link.threadId)).toEqual(["thr_manager"]);
    expect(f.to("thr_manager")).toEqual([text(task.key)]);
  });

  it("backs off when the manager link's status changes while the reconcile reads, then sends to the worker", async () => {
    const f = setup();
    world(f);
    const task = await inherited(f, (_taskId, linkOf) =>
      f.db.prepare("UPDATE task_threads SET live_status='idle', updated_at=? WHERE id=?").run("2099-01-01T00:00:00.000Z", linkOf("thr_manager")));
    expect(f.to("thr_new")).toEqual([text(task.key)]);
    expect(f.to("thr_manager")).toEqual([]);
  });

  it("resolves again when the lead is detached during the tree walk, and sends to the reader left", async () => {
    const f = setup();
    world(f);
    const task = f.card("Detached", "in_review", "thr_lead");
    child(f, undefined, "thr_helper", "thr_lead");
    child(f, task.id, "thr_reader", "thr_helper");
    await f.sync(green());
    let detached = false;
    const get = f.threads.sdk.threads.get;
    f.harness.sdk.stub("threads.get", async (args: { threadId: string }) => {
      if (args.threadId === "thr_helper" && !detached) {
        detached = true;
        f.store.tasks.deleteTaskThread(f.store.tasks.listTaskThreads(task.id).find((link) => link.threadId === "thr_lead")!.id);
      }
      return get(args as never);
    });
    record(f, red(b));
    await f.events.drain();
    expect(detached).toBe(true);
    expect(f.to("thr_reader")).toEqual([text(task.key)]);
    expect(f.to("thr_lead")).toEqual([]);
  });

  it("backs off when a linked lead is archived during resolution, then sends to the sole reader left", async () => {
    const f = setup();
    world(f);
    const task = f.card("Archiving", "in_review", "thr_lead");
    child(f, task.id, "thr_reader", "thr_lead");
    await f.sync(green());
    // The reconcile reads a live lead; every later read sees it archived.
    const get = f.threads.sdk.threads.get;
    f.harness.sdk.stub("threads.get", async (args: { threadId: string }) => {
      const thread = await get(args as never);
      if (args.threadId === "thr_lead") f.threads.threads.set("thr_lead", { archived: true });
      return thread;
    });
    record(f, red(b));
    await f.events.drain();
    expect(f.threads.requests).toEqual([]);
    expect(rows(f)[0]).toMatchObject({ state: "pending", next_attempt_at: expect.any(String) });
    f.db.prepare("UPDATE pr_event_deliveries SET next_attempt_at=NULL").run();
    await f.events.drain();
    expect(f.to("thr_reader")).toEqual([text(task.key)]);
  });

  it("holds when an archived lead leaves two live readers and neither is on the PR", async () => {
    const f = setup();
    world(f);
    const task = f.card("Orphans", "in_review", "thr_lead");
    child(f, task.id, "thr_r1", "thr_lead");
    child(f, task.id, "thr_r2", "thr_lead");
    await f.sync(green());
    f.threads.threads.set("thr_lead", { archived: true, parent: "thr_pm" });
    record(f, red(b));
    await f.events.drain();
    expect(f.store.tasks.listTaskThreads(task.id).map((link) => link.threadId).sort()).toEqual(["thr_r1", "thr_r2"]);
    expect(rows(f)[0]).toMatchObject({ state: "awaiting_owner" });
    expect(f.threads.requests).toEqual([]);
  });
});
