import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { receiptPolling } from "../steer";
import { goLive, MANAGER, setup } from "./fixtures";
import { requestMode } from "./modes";

type Fixture = ReturnType<typeof setup>;
const fixtures: Fixture[] = [];
const make = async (mode: "off" | "live" = "live") => {
  const f = setup();
  fixtures.push(f);
  if (mode === "live") await goLive(f);
  return f;
};
const settings = (f: Fixture) => f.call("getAttentionSettings", { projectId: f.tracker.id });
const modes = async (f: Fixture) => (await settings(f)).state;
const setManager = (f: Fixture, manager: string | null) => f.call("updateAttentionManager", { projectId: f.tracker.id, manager });
const event = (f: Fixture, type: "thread.archived" | "thread.unarchived" | "thread.deleted", id = MANAGER) =>
  f.harness.emitThreadEvent(type, { thread: makeThreadResponse({ id }) as never });
const notFound = () => Object.assign(new Error("no such thread"), { code: "thread_not_found" });
const signals = (f: Fixture, channel = "settings:changed") => f.harness.realtimeSignals.filter((signal: { channel: string }) => signal.channel === channel).length;
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const gate = () => { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; };
const eligibleCard = (f: Fixture, title = "Stale") => { const task = f.card(title); f.makeEligible(); return task; };

beforeEach(() => { receiptPolling.tries = 1; receiptPolling.delayMs = 0; });
afterEach(async () => { await Promise.all(fixtures.splice(0).map((f) => f.dispose())); });

describe("turning notices on", () => {
  it("is refused with no manager, an archived manager and a deleted manager, and allowed once a usable one is set", async () => {
    const f = await make("off");
    await f.call("updateAttentionManager", { projectId: f.tracker.id, manager: null });
    await expect(f.setMode("live")).rejects.toThrow("No manager chosen; choose one before turning notices on");
    await setManager(f, MANAGER);
    f.threads.threads.set(MANAGER, { archived: true });
    await expect(f.setMode("live")).rejects.toThrow("The manager session is archived; choose another before turning notices on");
    f.threads.threads.set(MANAGER, { archived: true, deleted: true });
    await expect(f.setMode("live")).rejects.toThrow("The manager session was deleted; choose another before turning notices on");
    expect((await modes(f)).effective.mode).toBe("off");
    f.threads.threads.set("thr_next", {});
    await setManager(f, "thr_next");
    expect((await f.setMode("live")).effective.mode).toBe("live");
  });

  it("is refused while the manager cannot be verified, and allowed after a read verifies it", async () => {
    const f = await make("off");
    f.threads.getError = new Error("backend unavailable");
    await expect(f.setMode("live")).rejects.toThrow("Could not verify the manager session");
    f.threads.getError = undefined;
    expect((await f.setMode("live")).effective.mode).toBe("live");
  });

  it("turns nothing on when the owner clears manager A while its lookup is pending and A then reads usable", async () => {
    const f = await make("off");
    const held = gate();
    f.threads.getGateOnce = held.promise;
    const request = f.setMode("live");
    const refused = expect(request).rejects.toThrow(/manager changed/);
    while (f.threads.getGateOnce) await tick();
    await setManager(f, null);
    held.release();
    await refused;
    expect(await modes(f)).toEqual({ effective: { mode: "off", generation: 0 }, switchingOff: false });
  });
});

describe("stale reads", () => {
  it("turns nothing on when a deletion event arrives while the lookup is out and the read then returns an older usable snapshot", async () => {
    const f = await make("off");
    const held = gate();
    f.threads.getGateOnce = held.promise;
    const request = f.setMode("live");
    const refused = expect(request).rejects.toThrow("The manager session was deleted; choose another before turning notices on");
    while (f.threads.getGateOnce) await tick();
    f.threads.threads.set(MANAGER, { deleted: true });
    await event(f, "thread.deleted");
    held.release();
    await refused;
    expect((await modes(f)).effective.mode).toBe("off");
    expect(await modes(f)).toEqual({ effective: { mode: "off", generation: 0 }, switchingOff: false });
  });

  it("claims nothing when an archive event arrives while the drain's lookup is out and the read then returns an older usable snapshot", async () => {
    const f = await make();
    eligibleCard(f);
    const held = gate();
    f.threads.getGateOnce = held.promise;
    const drain = f.service.drain();
    while (f.threads.getGateOnce) await tick();
    f.threads.threads.set(MANAGER, { archived: true });
    await event(f, "thread.archived");
    held.release();
    await drain;
    expect(f.attempts()).toHaveLength(0);
    expect(f.threads.sends).toBe(0);
  });

  it("claims nothing when the manager goes A → B → A and A is archived, with the archive event arriving while B is selected (the setting written without a settings call)", async () => {
    const f = await make();
    eligibleCard(f);
    f.threads.threads.set("thr_b", {});
    const held = gate();
    f.threads.getGateOnce = held.promise;
    const drain = f.service.drain();
    while (f.threads.getGateOnce) await tick();
    f.db.prepare("UPDATE attention_manager SET manager=?").run("thr_b");
    f.threads.threads.set(MANAGER, { archived: true });
    await event(f, "thread.archived");
    f.db.prepare("UPDATE attention_manager SET manager=?").run(MANAGER);
    held.release();
    await drain;
    expect(f.attempts()).toHaveLength(0);
    expect(f.threads.sends).toBe(0);
  });

  it("re-reads after the manager setting went A → B → A even with no event", async () => {
    const f = await make();
    eligibleCard(f);
    f.threads.threads.set("thr_b", {});
    const held = gate();
    f.threads.getGateOnce = held.promise;
    const drain = f.service.drain();
    while (f.threads.getGateOnce) await tick();
    await setManager(f, "thr_b");
    f.threads.threads.set(MANAGER, { archived: true });
    await setManager(f, MANAGER);
    held.release();
    await drain;
    expect(f.attempts()).toHaveLength(0);
  });

  it("claims nothing when a settings read records the deletion while the drain's read of A is held", async () => {
    const f = await make();
    eligibleCard(f);
    const held = gate();
    f.threads.getGateOnce = held.promise;
    const drain = f.service.drain();
    while (f.threads.getGateOnce) await tick();
    // The held read keeps its older usable snapshot; a settings load now sees the deletion.
    f.threads.threads.set(MANAGER, { deleted: true });
    expect((await settings(f)).managerLookup).toMatchObject({ status: "unusable", cause: "deleted" });
    held.release();
    await drain;
    expect(f.attempts()).toHaveLength(0);
    expect(f.threads.sends).toBe(0);
  });

  it("records a deletion seen by a successful read like an event's, once, with its time", async () => {
    const f = await make("off");
    f.threads.threads.set(MANAGER, { deleted: true });
    const first = (await settings(f)).managerLookup;
    expect(first).toMatchObject({ status: "unusable", cause: "deleted", detectedAt: expect.any(String) });
    await new Promise((resolve) => setTimeout(resolve, 10));
    f.threads.threads.delete(MANAGER);
    f.threads.getError = new Error("backend unavailable");
    expect((await settings(f)).managerLookup).toEqual(first);
  });

  it("keeps the time a deletion was established across settings reads", async () => {
    const f = await make("off");
    await event(f, "thread.deleted");
    const first = (await settings(f)).managerLookup;
    await new Promise((resolve) => setTimeout(resolve, 10));
    f.threads.getError = new Error("backend unavailable");
    const second = (await settings(f)).managerLookup;
    expect(first).toMatchObject({ status: "unusable", cause: "deleted", detectedAt: expect.any(String) });
    expect(second).toEqual(first);
    await event(f, "thread.deleted");
    expect((await settings(f)).managerLookup).toEqual(first);
  });
});

describe("lookup", () => {
  it("defers claims on a transient read failure without rolling back, then proceeds after a recovery read", async () => {
    const f = await make();
    eligibleCard(f);
    const generation = (await modes(f)).effective.generation;
    f.threads.getError = new Error("backend unavailable");
    await f.service.drain();
    expect(f.attempts()).toHaveLength(0);
    expect((await settings(f)).managerLookup).toEqual({ status: "unavailable" });
    expect((await settings(f)).managerWarning).toBe("Could not verify the manager session; notices are not being sent");
    expect(await modes(f)).toMatchObject({ effective: { mode: "live", generation }, switchingOff: false });
    f.threads.getError = undefined;
    await f.service.drain();
    expect(f.attempts()).toHaveLength(1);
    expect(f.threads.sends).toBe(1);
  });

  it("does not treat an ambiguous send error as proof of archival", async () => {
    const f = await make();
    eligibleCard(f);
    f.threads.sendMode = "throw";
    await f.service.drain();
    expect(f.attempts().map((attempt) => attempt.outcome)).toEqual(["unknown"]);
    expect(await modes(f)).toMatchObject({ effective: { mode: "live" }, switchingOff: false });
    expect((await settings(f)).managerLookup).toEqual({ status: "usable" });
  });

  it("reports deleted after a deletion event even when a later read throws, and unavailable for a transient failure alone", async () => {
    const f = await make("off");
    f.threads.getError = new Error("backend unavailable");
    expect((await settings(f)).managerLookup).toEqual({ status: "unavailable" });
    await event(f, "thread.deleted");
    expect((await settings(f)).managerLookup).toMatchObject({ status: "unusable", cause: "deleted" });
  });

  it("reports deleted when the deletion event arrives while a read that then throws is outstanding", async () => {
    const f = await make("off");
    const held = gate();
    f.threads.getGateOnce = held.promise;
    f.threads.getError = new Error("backend unavailable");
    const lookup = f.service.lookupManager(MANAGER);
    while (f.threads.getGateOnce) await tick();
    await event(f, "thread.deleted");
    held.release();
    expect(await lookup).toMatchObject({ status: "unusable", cause: "deleted" });
  });

  it("names a not-found answer as such, never as archived", async () => {
    const f = await make("off");
    f.threads.getError = notFound();
    expect((await settings(f)).managerLookup).toMatchObject({ status: "unusable", cause: "not_found" });
  });

  it.each([{ deleted: true }, { deleted: true, archived: true }])("reports a manager the read shows as deleted (%j) after a startup with an empty live tracker, and changes nothing", async (info) => {
    const f = await make();
    const before = await modes(f);
    f.threads.threads.set(MANAGER, info);
    await f.service.reconcileAll();
    expect((await settings(f)).managerLookup).toMatchObject({ status: "unusable", cause: "deleted" });
    expect(await modes(f)).toEqual(before);
    expect(f.attempts()).toHaveLength(0);
  });

  it("words stopping, side-chat and unverified managers separately", async () => {
    const f = await make("off");
    f.threads.threads.set(MANAGER, { status: "stopping" });
    expect((await settings(f)).managerWarning).toBe("The manager session is stopping; choose another before turning notices on");
    f.threads.threads.set(MANAGER, { sideChat: true });
    expect((await settings(f)).managerWarning).toBe("The manager is a side chat; choose another before turning notices on");
    f.threads.threads.set(MANAGER, { archived: true });
    expect((await settings(f)).managerWarning).toBe("The manager session is archived; choose another before turning notices on");
    f.threads.threads.delete(MANAGER);
    f.threads.getError = new Error("backend unavailable");
    expect((await settings(f)).managerWarning).toBe("Could not verify the manager session");
    f.threads.getError = undefined;
    expect((await settings(f)).managerWarning).toBeNull();
    await setManager(f, null);
    expect((await settings(f)).managerWarning).toBe("No manager chosen; choose one before turning notices on");
  });
});

describe("live with an unusable manager", () => {
  it("claims nothing, keeps the occurrences pending and names the cause, then resumes with a usable manager", async () => {
    const f = await make();
    eligibleCard(f);
    f.threads.threads.set(MANAGER, { archived: true });
    await f.service.drain();
    expect(f.attempts()).toHaveLength(0);
    expect(f.threads.sends).toBe(0);
    expect(f.occurrences()).toHaveLength(1);
    expect((await settings(f)).managerWarning).toBe("The manager session is archived; notices are not being sent");
    expect(await modes(f)).toMatchObject({ effective: { mode: "live" }, switchingOff: false });
    f.threads.threads.set("thr_next", {});
    await setManager(f, "thr_next");
    await f.service.drain();
    expect(f.attempts()).toMatchObject([{ recipient_thread_id: "thr_next", recipient_source: "manager" }]);
  });
});

describe("drain guard", () => {
  it.each([["cleared", null], ["replaced by B", "thr_b"]])("claims nothing for A when the manager is %s while the lookup of A is in flight", async (_name, next) => {
    const f = await make();
    eligibleCard(f);
    const held = gate();
    f.threads.getGateOnce = held.promise;
    const drain = f.service.drain();
    while (f.threads.getGateOnce) await tick();
    f.db.prepare("UPDATE attention_manager SET manager=?").run(next);
    held.release();
    await drain;
    expect(f.attempts()).toHaveLength(0);
    expect(f.threads.sends).toBe(0);
  });

  it("lets a deletion recorded during the lookup override a usable read", async () => {
    const f = await make();
    eligibleCard(f);
    const held = gate();
    f.threads.getGateOnce = held.promise;
    const drain = f.service.drain();
    while (f.threads.getGateOnce) await tick();
    await event(f, "thread.deleted");
    held.release();
    await drain;
    expect(f.attempts()).toHaveLength(0);
  });
});

describe("in-flight attempts", () => {
  it("keeps reconciling a shared queue append against A when A becomes unusable during it, and never replays it to B", async () => {
    const f = await make();
    eligibleCard(f, "First");
    await f.service.drain();
    eligibleCard(f, "Second");
    const held = gate();
    const update = f.threads.sdk.threads.queuedMessages.update;
    f.threads.sdk.threads.queuedMessages.update = async (input: Parameters<typeof update>[0]) => { await held.promise; return update(input); };
    const drain = f.service.drain();
    while (f.attempts().length < 2) await tick();
    f.threads.threads.set(MANAGER, { archived: true });
    f.threads.threads.set("thr_b", {});
    await setManager(f, "thr_b");
    held.release();
    await drain;
    f.threads.sdk.threads.queuedMessages.update = update;
    expect(f.attempts().map((attempt) => [attempt.recipient_thread_id, attempt.outcome])).toEqual([[MANAGER, "queued"], [MANAGER, "appended"]]);
    await f.service.drain();
    expect(f.attempts()).toHaveLength(2);
    expect(f.threads.sends).toBe(1);
    expect(f.threads.rows.every((row: { threadId: string }) => row.threadId === MANAGER)).toBe(true);
  });

  it("records a late receipt from A after the replacement and triggers no replay to B", async () => {
    const f = await make();
    eligibleCard(f);
    f.threads.sendMode = "inline";
    f.threads.acceptInline = false;
    await f.service.drain();
    expect(f.attempts().map((attempt) => attempt.outcome)).toEqual(["sending"]);
    f.threads.threads.set(MANAGER, { archived: true });
    f.threads.threads.set("thr_b", {});
    await setManager(f, "thr_b");
    await f.service.drain();
    expect(f.attempts().map((attempt) => attempt.outcome)).toEqual(["sending"]);
    // The same text recorded in B's history is no receipt for an attempt made to A.
    f.threads.dispatch(f.threads.lastBody, "thr_b");
    await f.service.drain();
    expect(f.attempts().map((attempt) => attempt.outcome)).toEqual(["sending"]);
    f.threads.dispatch(f.threads.lastBody);
    await f.service.drain();
    expect(f.attempts()).toMatchObject([{ recipient_thread_id: MANAGER, outcome: "inline" }]);
    expect(f.threads.sends).toBe(1);
    expect(f.threads.eventReads).toContain(MANAGER);
    expect(f.threads.eventReads).not.toContain("thr_b");
  });
});

describe("settings refresh", () => {
  it("publishes when an unlinked manager is deleted, and the warning follows even if a later read fails", async () => {
    const f = await make("off");
    expect((await settings(f)).managerWarning).toBeNull();
    const before = signals(f);
    await event(f, "thread.deleted");
    f.threads.getError = new Error("backend unavailable");
    expect(signals(f)).toBeGreaterThan(before);
    expect((await settings(f)).managerWarning).toBe("The manager session was deleted; choose another before turning notices on");
  });

  it("ignores an event for A after the switch to B", async () => {
    const f = await make("off");
    f.threads.threads.set("thr_b", {});
    await setManager(f, "thr_b");
    const before = signals(f);
    await event(f, "thread.deleted");
    await event(f, "thread.archived");
    expect(signals(f)).toBe(before);
    expect((await settings(f)).managerWarning).toBeNull();
  });

  it("clears the warning when the selected manager is unarchived", async () => {
    const f = await make("off");
    f.threads.threads.set(MANAGER, { archived: true });
    await event(f, "thread.archived");
    expect((await settings(f)).managerWarning).toContain("archived");
    f.threads.threads.set(MANAGER, {});
    const before = signals(f);
    await event(f, "thread.unarchived");
    expect(signals(f)).toBeGreaterThan(before);
    expect((await settings(f)).managerWarning).toBeNull();
  });

  it("publishes on every reconciliation pass, so a view that diverged from another view's load is corrected", async () => {
    const f = await make("off");
    await f.service.reconcileAll();
    const first = signals(f);
    await f.service.reconcileAll();
    const second = signals(f);
    expect(second).toBeGreaterThan(first);
    await f.service.reconcileAll();
    expect(signals(f)).toBeGreaterThan(second);
    // The background pass and the manager-thread events never reach the board's wide channel; the owner's own edit still does.
    const wide = signals(f, "projects:changed");
    await f.service.reconcileAll();
    await event(f, "thread.archived");
    expect(signals(f, "projects:changed")).toBe(wide);
    await setManager(f, null);
    expect(signals(f, "projects:changed")).toBe(wide + 1);
  });

  it("publishes nothing for a pass whose manager was replaced while its read was outstanding", async () => {
    const f = await make("off");
    const held = gate();
    f.threads.getGateOnce = held.promise;
    const pass = f.service.reconcileAll();
    while (f.threads.getGateOnce) await tick();
    f.threads.threads.set("thr_b", {});
    await setManager(f, "thr_b");
    const before = signals(f);
    held.release();
    await pass;
    expect(signals(f)).toBe(before);
  });
});

describe("switching", () => {
  it("turns notices on and keeps claims paused when the manager disappears after the request", async () => {
    const f = await make("off");
    expect((await f.setMode("live")).effective.mode).toBe("live");
    f.threads.threads.set(MANAGER, { archived: true });
    eligibleCard(f);
    await f.service.drain();
    expect(f.attempts()).toHaveLength(0);
    f.threads.threads.set(MANAGER, {});
    await f.service.drain();
    expect(f.attempts()).toHaveLength(1);
  });

  it("builds the settings response from one snapshot when notices turn on during the manager lookup", async () => {
    const f = await make("off");
    f.threads.threads.set(MANAGER, { archived: true });
    const held = gate();
    f.threads.getGateOnce = held.promise;
    const load = settings(f);
    while (f.threads.getGateOnce) await tick();
    requestMode(f.db, { trackerId: f.tracker.id, mode: "live" });
    held.release();
    const result = await load;
    expect(result.state.effective.mode).toBe("live");
    expect(result.managerWarning).toBe("The manager session is archived; notices are not being sent");
  });

  it("reads the manager again once when it changed during the lookup", async () => {
    const f = await make("off");
    f.threads.threads.set("thr_b", { archived: true });
    const held = gate();
    f.threads.getGateOnce = held.promise;
    const load = settings(f);
    while (f.threads.getGateOnce) await tick();
    f.db.prepare("UPDATE attention_manager SET manager='thr_b'").run();
    held.release();
    const result = await load;
    expect(result.manager).toBe("thr_b");
    expect(result.managerLookup).toMatchObject({ status: "unusable", cause: "archived" });
  });

  it("reports no manager when the setting is empty after the retry, not an unverified one", async () => {
    const f = await make("off");
    f.threads.threads.set("thr_b", {});
    const first = gate();
    f.threads.getGateOnce = first.promise;
    const load = settings(f);
    while (f.threads.getGateOnce) await tick();
    f.db.prepare("UPDATE attention_manager SET manager='thr_b'").run();
    const second = gate();
    f.threads.getGateOnce = second.promise;
    first.release();
    while (f.threads.getGateOnce) await tick();
    f.db.prepare("UPDATE attention_manager SET manager=NULL").run();
    second.release();
    const result = await load;
    expect(result.manager).toBeNull();
    expect(result.managerLookup).toMatchObject({ status: "unusable", cause: "none" });
    expect(result.managerWarning).toBe("No manager chosen; choose one before turning notices on");
  });

  it("turns notices off unchanged while the manager is unusable", async () => {
    const f = await make();
    eligibleCard(f);
    f.threads.threads.set(MANAGER, { archived: true });
    expect(await f.setMode("off")).toEqual({ effective: { mode: "off", generation: 2 }, switchingOff: false });
    expect(f.occurrences()).toHaveLength(0);
  });
});

describe("old attempts", () => {
  it("lists unknown attempts recorded with the removed recipient sources in the settings", async () => {
    const f = await make();
    const insert = db_insert(f);
    insert("a-fallback", "sweep_fallback", "thr_fallback");
    insert("a-parent", "parent", "thr_parent");
    expect((await settings(f)).unresolvedAttempts.map((attempt: { attemptId: string; recipientThreadId: string }) => [attempt.attemptId, attempt.recipientThreadId])).toEqual([["a-fallback", "thr_fallback"], ["a-parent", "thr_parent"]]);
  });
});

function db_insert(f: Fixture) {
  let rev = 100;
  return (id: string, source: string, thread: string) => f.db.prepare("INSERT INTO attention_attempts(attempt_id, tracker_id, kind, generation, batch_id, recipient_thread_id, recipient_source, started_at, transport_started_at, outcome, accepted_at, rev) VALUES (?, ?, 'stale-status', 1, ?, ?, ?, ?, ?, 'unknown', ?, ?)")
    .run(id, f.tracker.id, `batch-${id}`, thread, source, new Date().toISOString(), new Date().toISOString(), new Date().toISOString(), rev++);
}
