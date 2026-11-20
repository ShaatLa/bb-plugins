import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTasksStore } from "../db/store";
import { registerTasksCli } from "../cli";
import { createGitSyncStore } from "../git-sync/store";
import { prIdentity, prSnapshotSchema } from "../shared/git-sync";
import { HISTORY_PASS_PAGES, receiptPolling } from "../steer";
import { attentionMarker } from "./service";
import { accept, BB_PROJECT, goLive, MANAGER, setup } from "./fixtures";

const fixtures: ReturnType<typeof setup>[] = [];
const make = async (mode: "off" | "shadow" | "live" = "shadow") => {
  const f = setup();
  fixtures.push(f);
  if (mode === "live") await goLive(f);
  else if (mode === "shadow") await f.setMode("shadow");
  return f;
};
const modes = async (f: ReturnType<typeof setup>) => (await f.sweep("attention.modes", { projectId: BB_PROJECT })).kinds["stale-status"];
const unknownAttempt = (f: ReturnType<typeof setup>, id: string, started = new Date().toISOString(), extra = "unknown") =>
  f.db.prepare("INSERT INTO attention_attempts(attempt_id, tracker_id, kind, generation, batch_id, recipient_thread_id, recipient_source, started_at, transport_started_at, outcome, rev) VALUES (?, ?, 'stale-status', 1, ?, ?, 'manager', ?, ?, ?, 1)")
    .run(id, f.tracker.id, `batch-${id}`, MANAGER, started, started, extra);
beforeEach(() => { receiptPolling.tries = 1; receiptPolling.delayMs = 0; });
afterEach(async () => { await Promise.all(fixtures.splice(0).map((f) => f.dispose())); });

describe("C1.2 one tracker per BB project", () => {
  it("refuses to start shadow while another tracker is linked to the same BB project", async () => {
    const f = await make("off");
    f.store.tasks.createProject({ name: "Twin", prefix: "TWN", color: "red", linkedBbProjectId: BB_PROJECT });
    await expect(f.setMode("shadow")).rejects.toThrow(/same BB project/);
    expect((await f.call("getAttentionSettings", { projectId: f.tracker.id })).state.effective.mode).toBe("off");
  });
});

describe("C1.3 deleting a tracker", () => {
  it("is refused, forced deletion included, until the mode is off with nothing pending", async () => {
    const f = await make("live");
    expect(() => f.store.tasks.deleteProject(f.tracker.id)).toThrow(/Switch manager attention off/);
    await expect(f.call("deleteProject", { projectId: f.tracker.id, force: true })).rejects.toThrow(/Switch manager attention off/);
    await f.setMode("shadow");
    expect(() => f.store.tasks.deleteProject(f.tracker.id)).toThrow(/Switch manager attention off/);
    const transition = (await modes(f)).transition;
    await f.sweep("attention.ack", { projectId: BB_PROJECT, trackerId: f.tracker.id, kind: "stale-status", token: transition.token, generation: transition.generation, direction: "to_shadow", fenceId: "f" });
    await f.setMode("off");
    expect(f.store.tasks.deleteProject(f.tracker.id)).toBe(true);
  });
});

describe("C1.4 handback", () => {
  it("leaves a Done card's shadow-only no_merge_or_outcome out of a rollback", async () => {
    const f = await make("live");
    const done = f.card("Done without outcome", "done");
    const open = f.card("Open");
    expect(f.occurrences().map((o) => o.signal).sort()).toEqual(["no_active_thread", "no_merge_or_outcome"]);
    await f.setMode("shadow");
    const handback = (await modes(f)).transition.handback;
    expect(handback.map((entry: { taskId: string }) => entry.taskId)).toEqual([open.id]);
    expect(handback.map((entry: { taskId: string }) => entry.taskId)).not.toContain(done.id);
  });
});

describe("C1.5 a failed refresh is not a known answer", () => {
  const link = (f: ReturnType<typeof setup>, taskId: string, number: number) => {
    const git = createGitSyncStore(f.db);
    const now = new Date().toISOString();
    const saved = git.saveLink({ taskId, provider: "github", host: "github.com", repository: "org/repo", number, url: `https://github.com/org/repo/pull/${number}`, remoteId: String(number), role: "delivers", part: null, source: "manual", confirmed: true, excluded: false, createdAt: now, updatedAt: now });
    const snapshot = (state: "open" | "closed") => prSnapshotSchema.parse({ repository: "org/repo", number, remoteId: String(number), url: saved.url, title: "t", state, headSha: "a".repeat(40), mergeSha: null, mergedAt: null, baseBranch: "main", updatedAt: "2026-01-01", observedAt: now, checks: [], requirementsKnown: false, ci: "no_checks", mergeState: null, mergeable: null, review: null, unresolvedThreads: null, coverage: [] });
    return { save: (state: "open" | "closed") => git.saveSnapshot(f.tracker.id, saved, snapshot(state)), fail: () => git.fail(f.tracker.id, saved, "outage"), identity: prIdentity(saved) };
  };

  it("does not raise closed_unmerged_pr from a closed payload kept through an outage, nor let an open one hide pr_state_unavailable", async () => {
    const f = await make();
    const closed = f.card("Formerly closed", "todo");
    const closedPr = link(f, closed.id, 1);
    closedPr.save("closed");
    closedPr.fail();
    f.store.tasks.updateTask(closed.id, { status: "in_review" });
    expect(f.occurrences().filter((o) => o.task_id === closed.id).map((o) => o.signal)).not.toContain("closed_unmerged_pr");
    expect(f.occurrences().filter((o) => o.task_id === closed.id).map((o) => o.signal)).toContain("pr_state_unavailable");
    const open = f.card("Formerly open", "todo");
    const openPr = link(f, open.id, 2);
    openPr.save("open");
    openPr.fail();
    f.store.tasks.updateTask(open.id, { status: "in_review" });
    expect(f.occurrences().filter((o) => o.task_id === open.id).map((o) => o.signal)).toEqual(["pr_state_unavailable"]);
    // C2.3: the board's flags, which Sweep also reads, use the same known-PR rule as the ledger.
    expect(f.store.tasks.staleStatusFlags([open.id]).get(open.id)).toEqual(["pr_state_unavailable"]);
    expect(f.store.tasks.staleStatusFlags([closed.id]).get(closed.id)).toEqual(["pr_state_unavailable"]);
    // Once the refresh succeeds again the open PR is a known answer.
    openPr.save("open");
    expect(f.occurrences().filter((o) => o.task_id === open.id)).toHaveLength(0);
    expect(f.store.tasks.staleStatusFlags([open.id]).has(open.id)).toBe(false);
  });
});

describe("C1.6 moving a family", () => {
  it("recomputes every moved card in the move transaction", async () => {
    const f = await make();
    const other = f.store.tasks.createProject({ name: "Other", prefix: "OTH", color: "red", linkedBbProjectId: "proj_other" });
    await f.call("updateAttentionMode", { projectId: other.id, mode: "shadow" });
    const epic = f.card("Epic", "todo", { type: "epic" });
    const member = f.card("Member", "in_progress", { epicId: epic.id });
    expect(f.occurrences().map((o) => o.task_id)).toEqual([member.id]);
    const moved = f.store.tasks.moveTaskToProject(epic.id, other.id);
    expect(moved.moved.map((entry) => entry.task.id)).toContain(member.id);
    expect(f.occurrences()).toHaveLength(0);
    expect(f.occurrences(true).find((o) => o.task_id === member.id)).toMatchObject({ retired_reason: "moved" });
    const onNew = f.db.prepare("SELECT * FROM manager_attention WHERE tracker_id=? AND task_id=? AND cleared_at IS NULL").get(other.id, member.id) as { first_seen_at: string } | undefined;
    expect(onNew).toBeTruthy();
  });
});

describe("C1.7 the eligibility timer", () => {
  it("counts only occurrences that could actually be claimed", async () => {
    const f = await make("live");
    f.card("Accepted and still open");
    accept(f, f.occurrences()[0].id);
    f.makeEligible();
    expect(f.service.nextEligibleDelay()).toBeNull();
    f.card("Waiting for grace");
    const delay = f.service.nextEligibleDelay();
    expect(delay).toBeGreaterThan(60_000);
    expect(delay).toBeLessThanOrEqual(10 * 60_000);
    // A past-due occurrence that a drain can claim is the drain's work, not a timer's.
    f.makeEligible();
    expect(f.service.nextEligibleDelay()).toBeNull();
  });
});

describe("C1.8 late receipts", () => {
  it("searches more unknown attempts than one pass covers fairly across passes", async () => {
    const f = await make("live");
    const start = Date.now() - 3_600_000;
    for (let index = 1; index <= 22; index++) unknownAttempt(f, `a${String(index).padStart(2, "0")}`, new Date(start + index * 1000).toISOString());
    f.threads.addRow(MANAGER, `x ${attentionMarker("batch-a01")}`);
    f.threads.addRow(MANAGER, `y ${attentionMarker("batch-a22")}`);
    await f.service.recoverLate(f.tracker.id);
    await f.service.recoverLate(f.tracker.id);
    expect(f.attempts().filter((a) => a.outcome !== "unknown").map((a) => a.attempt_id).sort()).toEqual(["a01", "a22"]);
  });

  it("still records a receipt that arrives after a waiver and a rollback", async () => {
    const f = await make("live");
    f.card("Lost");
    f.makeEligible();
    f.threads.sendMode = "throw";
    await f.service.drain();
    const attempt = f.attempts()[0];
    await f.call("resolveAttentionAttempt", { attemptId: attempt.attempt_id, disposition: "waived_loss" });
    await f.setMode("shadow");
    const transition = (await modes(f)).transition;
    await f.sweep("attention.ack", { projectId: BB_PROJECT, trackerId: f.tracker.id, kind: "stale-status", token: transition.token, generation: transition.generation, direction: "to_shadow", fenceId: "f" });
    f.threads.addRow(MANAGER, `late ${attentionMarker(attempt.batch_id)}`);
    await f.service.reconcileAll();
    expect(f.attempts()[0]).toMatchObject({ outcome: "queued", disposition: "waived_loss" });
  });
});

describe("C1.9 receipt search depth", () => {
  it("finds an accepted event far behind later traffic on a busy thread", async () => {
    const f = await make("live");
    f.card("Busy");
    unknownAttempt(f, "busy", new Date(Date.now() - 3_600_000).toISOString(), "sending");
    f.db.prepare("INSERT INTO attention_attempt_items(attempt_id, occurrence_id) VALUES ('busy', ?)").run(f.occurrences()[0].id);
    f.threads.dispatch(`notice ${attentionMarker("batch-busy")}`);
    for (let index = 0; index < 120; index++) f.threads.dispatch(`unrelated ${index}`);
    await f.service.recover(f.tracker.id);
    expect(f.attempts()[0]).toMatchObject({ outcome: "inline", inline_event_ref: expect.any(String) });
    expect(f.threads.listCalls).toBeGreaterThan(2);
  });
});

describe("C2.2 receipt search across passes", () => {
  it("reaches an acceptance buried under more than one pass of newer requests, without calling the attempt unknown meanwhile", async () => {
    const f = await make("live");
    f.card("Very busy");
    unknownAttempt(f, "deep", new Date(Date.now() - 3_600_000).toISOString(), "sending");
    f.db.prepare("INSERT INTO attention_attempt_items(attempt_id, occurrence_id) VALUES ('deep', ?)").run(f.occurrences()[0].id);
    f.threads.dispatch(`notice ${attentionMarker("batch-deep")}`);
    for (let index = 0; index < 2100; index++) f.threads.dispatch(`unrelated ${index}`);
    await f.service.recover(f.tracker.id);
    expect(f.attempts()[0].outcome).toBe("sending");
    expect(f.attempts()[0].recovery_cursor).toBeTruthy();
    expect(f.threads.listCalls).toBeLessThanOrEqual(HISTORY_PASS_PAGES + 2);
    for (let pass = 0; pass < 3 && f.attempts()[0].outcome === "sending"; pass++) await f.service.recover(f.tracker.id);
    expect(f.attempts()[0]).toMatchObject({ outcome: "inline", inline_event_ref: expect.any(String) });
  });
});

describe("C3.1 an unreadable history", () => {
  const cursorOf = (f: ReturnType<typeof setup>, id: string) => JSON.parse((f.db.prepare("SELECT recovery_cursor FROM attention_attempts WHERE attempt_id=?").get(id) as { recovery_cursor: string }).recovery_cursor);
  const backdate = (f: ReturnType<typeof setup>, id: string, minutes: number) => {
    const cursor = cursorOf(f, id);
    cursor.errors.since = new Date(Date.now() - minutes * 60_000).toISOString();
    f.db.prepare("UPDATE attention_attempts SET recovery_cursor=? WHERE attempt_id=?").run(JSON.stringify(cursor), id);
  };

  it("gives a sending attempt up as unknown after five failed passes over thirty minutes, keeping the cursor for late evidence", async () => {
    const f = await make("live");
    f.card("Unreadable");
    unknownAttempt(f, "mute", new Date(Date.now() - 3_600_000).toISOString(), "sending");
    f.db.prepare("INSERT INTO attention_attempt_items(attempt_id, occurrence_id) VALUES ('mute', ?)").run(f.occurrences()[0].id);
    f.threads.eventsFail = true;
    const rollback = await f.setMode("shadow");
    expect(rollback.transition).toMatchObject({ state: "preparing" });
    expect(cursorOf(f, "mute").errors.count).toBe(1);
    backdate(f, "mute", 31);
    for (let pass = 0; pass < 3; pass++) await f.service.recover(f.tracker.id);
    // Four failed passes are not enough, however long they span.
    expect(f.attempts()[0].outcome).toBe("sending");
    await f.service.recover(f.tracker.id);
    expect(f.attempts()[0]).toMatchObject({ outcome: "unknown", error: expect.stringContaining("History unreadable") });
    expect((await modes(f)).transition.state).toBe("preparing");
    // The owner can now resolve it, and the rollback goes on.
    await f.call("resolveAttentionAttempt", { attemptId: "mute", disposition: "waived_loss" });
    expect((await modes(f)).transition.state).toBe("ready");
    // Later evidence still becomes the attempt's receipt.
    f.threads.eventsFail = false;
    f.threads.dispatch(`late ${attentionMarker("batch-mute")}`);
    await f.service.recoverLate(f.tracker.id);
    expect(f.attempts()[0]).toMatchObject({ outcome: "inline", disposition: "waived_loss" });
  });

  it("does not give up while the failed passes span less than thirty minutes", async () => {
    const f = await make("live");
    f.card("Briefly unreadable");
    unknownAttempt(f, "brief", new Date(Date.now() - 3_600_000).toISOString(), "sending");
    f.db.prepare("INSERT INTO attention_attempt_items(attempt_id, occurrence_id) VALUES ('brief', ?)").run(f.occurrences()[0].id);
    f.threads.eventsFail = true;
    for (let pass = 0; pass < 7; pass++) await f.service.recover(f.tracker.id);
    expect(cursorOf(f, "brief").errors.count).toBe(7);
    expect(f.attempts()[0].outcome).toBe("sending");
    f.threads.eventsFail = false;
    await f.service.recover(f.tracker.id);
    expect(f.attempts()[0].outcome).toBe("unknown");
    expect(cursorOf(f, "brief").errors).toBeUndefined();
  });
});

describe("C3.2 fresh traffic between passes", () => {
  it("still reaches an older acceptance when thousands of new requests arrive before every pass", async () => {
    const f = await make("live");
    f.card("Buried and busy");
    unknownAttempt(f, "buried", new Date(Date.now() - 3_600_000).toISOString(), "sending");
    f.db.prepare("INSERT INTO attention_attempt_items(attempt_id, occurrence_id) VALUES ('buried', ?)").run(f.occurrences()[0].id);
    f.threads.dispatch(`notice ${attentionMarker("batch-buried")}`);
    for (let index = 0; index < 4100; index++) f.threads.dispatch(`old ${index}`);
    let passes = 0;
    while (f.attempts()[0].outcome === "sending" && passes < 12) {
      await f.service.recover(f.tracker.id);
      passes++;
      for (let index = 0; index < 2100; index++) f.threads.dispatch(`fresh ${passes}-${index}`);
    }
    expect(f.attempts()[0]).toMatchObject({ outcome: "inline", inline_event_ref: expect.any(String) });
    expect(passes).toBeLessThanOrEqual(6);
  });
});

describe("C1.10 monotonic receipts", () => {
  it("does not let a stale empty search overwrite an acceptance another search recorded", async () => {
    const f = await make("live");
    f.card("Racing recovery");
    unknownAttempt(f, "race", new Date().toISOString(), "sending");
    f.threads.addRow(MANAGER, `notice ${attentionMarker("batch-race")}`);
    let release!: () => void;
    f.threads.listGateOnce = new Promise<void>((resolve) => { release = resolve; });
    const stale = f.service.recover(f.tracker.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await f.service.recover(f.tracker.id);
    expect(f.attempts()[0].outcome).toBe("queued");
    release();
    await stale;
    // The empty search's own write would leave its error text even if a later search restored the outcome.
    expect(f.attempts()[0].error).toBeNull();
    expect(f.attempts()[0].outcome).toBe("queued");
  });
});

describe("C1.11 mode changes through another handle", () => {
  it("lets a handle that cached all-off see a clear and a restore written right after shadow starts", async () => {
    const f = await make("off");
    const handle = new Proxy(f.db, { get: (target, key) => { const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value; } });
    const other = createTasksStore(handle);
    const task = other.createTask({ projectId: f.tracker.id, title: "Flapping", status: "in_progress" });
    // The cached handle has now answered "all off".
    other.updateTask(task.id, { title: "Still off" });
    await f.setMode("shadow");
    const original = f.occurrences()[0];
    other.updateTask(task.id, { status: "todo" });
    other.updateTask(task.id, { status: "in_progress" });
    const recurrence = f.occurrences()[0];
    expect(recurrence.id).not.toBe(original.id);
  });
});

describe("C1.13 task keys", () => {
  it("follows a prefix rename in the ledger and the delivered notice", async () => {
    const f = await make("live");
    const task = f.card("Renamed");
    f.store.tasks.updateProject(f.tracker.id, { prefix: "REN" });
    const key = f.store.tasks.getTask(task.id)!.key;
    expect(key.startsWith("REN-")).toBe(true);
    const ledger = await f.sweep("attention.ledger", { projectId: BB_PROJECT, kind: "stale-status" });
    expect(ledger.occurrences.map((o: { taskKey: string }) => o.taskKey)).toEqual([key]);
    f.makeEligible();
    await f.service.drain();
    expect(f.threads.rows.map((row) => f.threads.text(row)).join("\n")).toContain(`[${key}]`);
  });

  it("follows a prefix rename in the handback", async () => {
    const f = await make("live");
    const task = f.card("Renamed before rollback");
    f.store.tasks.updateProject(f.tracker.id, { prefix: "REN" });
    await f.setMode("shadow");
    const handback = (await modes(f)).transition.handback;
    expect(handback.map((entry: { taskKey: string }) => entry.taskKey)).toEqual([f.store.tasks.getTask(task.id)!.key]);
  });
});

describe("C2.1 a published handback", () => {
  it("keeps the keys it was published with when a prefix changes before the ack, while live reads follow the rename", async () => {
    const f = await make("live");
    const task = f.card("Renamed after ready");
    await f.setMode("shadow");
    const before = await modes(f);
    const published = before.transition.handback.map((entry: { taskKey: string }) => entry.taskKey);
    f.store.tasks.updateProject(f.tracker.id, { prefix: "REN" });
    const after = await modes(f);
    expect(after.transition).toEqual(before.transition);
    expect(after.transition.handback.map((entry: { taskKey: string }) => entry.taskKey)).toEqual(published);
    const ledger = await f.sweep("attention.ledger", { projectId: BB_PROJECT, kind: "stale-status" });
    expect(ledger.occurrences[0].taskKey).toBe(f.store.tasks.getTask(task.id)!.key);
    expect(ledger.occurrences[0].taskKey).not.toBe(published[0]);
  });
});

describe("C1.14 recipient eligibility", () => {
  it("claims nothing when the manager or its fallback parent is stopping", async () => {
    const f = await make("live");
    f.card("One");
    f.makeEligible();
    f.threads.threads.set(MANAGER, { status: "stopping" });
    await f.service.drain();
    expect(f.attempts()).toHaveLength(0);
    f.threads.threads.delete(MANAGER);
    f.db.prepare("UPDATE attention_manager SET manager=NULL").run();
    f.threads.sweepManager = "thr_sweep";
    f.threads.threads.set("thr_sweep", { archived: true, parent: "thr_parent" });
    f.threads.threads.set("thr_parent", { status: "stopping" });
    await f.service.drain();
    expect(f.attempts()).toHaveLength(0);
    expect(f.occurrences()).toHaveLength(1);
    f.threads.threads.delete("thr_parent");
    await f.service.drain();
    expect(f.attempts()).toHaveLength(1);
  });
});

describe("C1.15 the manager key", () => {
  it("is read as `manager` through the CLI and refused by config set", async () => {
    const f = await make("off");
    registerTasksCli(f.bb, f.store, { name: "Work Board", version: "test" });
    const read = await f.harness.runCli(["config", "get", "manager", "--project", "ATT", "--json"]);
    expect(read.exitCode, read.stderr).toBe(0);
    expect(JSON.parse(read.stdout).values).toEqual({ manager: MANAGER });
    const write = await f.harness.runCli(["config", "set", "manager", "thr_other", "--project", "ATT"]);
    expect(write.exitCode).not.toBe(0);
    expect(write.stderr + write.stdout).toMatch(/owner-only convention/);
  });
});
