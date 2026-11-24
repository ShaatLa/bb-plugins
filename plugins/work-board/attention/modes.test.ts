import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { receiptPolling } from "../steer";
import { attentionMarker } from "./service";
import { normalizeLegacyModes, requestMode } from "./modes";
import { BB_PROJECT, goLive, legacyRow, MANAGER, setup } from "./fixtures";

const fixtures: ReturnType<typeof setup>[] = [];
const make = (options?: { start?: boolean }) => { const f = setup(undefined, options); fixtures.push(f); return f; };
beforeEach(() => { receiptPolling.tries = 1; receiptPolling.delayMs = 0; });
afterEach(async () => { await Promise.all(fixtures.splice(0).map((f) => f.dispose())); });

const settings = (f: ReturnType<typeof setup>) => f.call("getAttentionSettings", { projectId: f.tracker.id });
const modeRow = (f: ReturnType<typeof setup>) => f.db.prepare("SELECT * FROM attention_modes WHERE tracker_id=?").get(f.tracker.id) as Record<string, unknown>;
const acks = (f: ReturnType<typeof setup>) => f.db.prepare("SELECT generation, direction, fence_id FROM attention_acks WHERE tracker_id=? ORDER BY generation").all(f.tracker.id);
const sent = (f: ReturnType<typeof setup>) => f.threads.rows.map((row) => f.threads.text(row)).join("\n");
const insertAttempt = (f: ReturnType<typeof setup>, id: string, outcome: string, occurrenceId?: string, batch = `batch-${id}`) => {
  f.db.prepare("INSERT INTO attention_attempts(attempt_id, tracker_id, kind, generation, batch_id, recipient_thread_id, recipient_source, started_at, transport_started_at, outcome, rev) VALUES (?, ?, 'stale-status', 1, ?, ?, 'manager', ?, ?, ?, 90)")
    .run(id, f.tracker.id, batch, MANAGER, new Date().toISOString(), new Date().toISOString(), outcome);
  if (occurrenceId) f.db.prepare("INSERT INTO attention_attempt_items(attempt_id, occurrence_id) VALUES (?, ?)").run(id, occurrenceId);
};

describe("binding", () => {
  it("refuses a relink while notices are on or switching off, and a second link to a bound project; off releases it", async () => {
    const f = make();
    const other = f.store.tasks.createProject({ name: "Other", prefix: "OTH", color: "red" });
    await goLive(f);
    expect(() => f.store.tasks.updateProject(f.tracker.id, { linkedBbProjectId: "proj_elsewhere" })).toThrow(/notices are on/);
    expect(() => f.store.tasks.updateProject(other.id, { linkedBbProjectId: BB_PROJECT })).toThrow(/sends stale-status notices/);
    f.store.tasks.updateProject(f.tracker.id, { name: "Renamed" });
    insertAttempt(f, "a1", "sending");
    expect(requestMode(f.db, { trackerId: f.tracker.id, mode: "off" }).switchingOff).toBe(true);
    expect(() => f.store.tasks.updateProject(f.tracker.id, { linkedBbProjectId: null })).toThrow(/notices are on/);
    f.db.prepare("UPDATE attention_attempts SET outcome='failed'").run();
    await f.service.settleSwitchOff(f.tracker.id);
    expect(f.store.tasks.updateProject(f.tracker.id, { linkedBbProjectId: "proj_elsewhere" }).linkedBbProjectId).toBe("proj_elsewhere");
  });
});

describe("turning on", () => {
  it("needs a linked BB project, the only Work Board project on that link and a usable manager", async () => {
    const unlinked = make();
    unlinked.store.tasks.updateProject(unlinked.tracker.id, { linkedBbProjectId: null });
    await expect(unlinked.setMode("live")).rejects.toThrow("Link this project to a BB project to turn notices on.");

    const shared = make();
    shared.store.tasks.createProject({ name: "Second", prefix: "SEC", color: "red", linkedBbProjectId: BB_PROJECT });
    await expect(shared.setMode("live")).rejects.toThrow("Another Work Board project is linked to the same BB project; only one of them can send notices.");

    const unmanaged = make();
    unmanaged.db.prepare("UPDATE attention_manager SET manager=NULL").run();
    await expect(unmanaged.setMode("live")).rejects.toThrow("No manager chosen; choose one before turning notices on");
    unmanaged.threads.threads.set("thr_archived", { archived: true });
    unmanaged.db.prepare("UPDATE attention_manager SET manager='thr_archived'").run();
    await expect(unmanaged.setMode("live")).rejects.toThrow("The manager session is archived; choose another before turning notices on");
    expect((await settings(unmanaged)).state).toEqual({ effective: { mode: "off", generation: 0 }, switchingOff: false });
  });

  it("is immediate: no gate, no transition and no acknowledgement, and it starts a fresh observation with its grace", async () => {
    const f = make();
    const info = vi.spyOn(f.bb.log, "info");
    expect(await goLive(f)).toEqual({ effective: { mode: "live", generation: 1 }, switchingOff: false });
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/attention stale-status for .*: off → live/));
    expect(acks(f)).toEqual([]);
    expect(modeRow(f)).toMatchObject({ requested_mode: null, transition_token: null, bound_tracker_id: f.tracker.id, bound_bb_project_id: BB_PROJECT });
    const task = f.card("Stale");
    const first = f.occurrences();
    expect(Date.parse(first[0].eligible_at)).toBeGreaterThan(Date.now() + 9 * 60_000);
    await f.setMode("off");
    expect(f.occurrences(true)[0]).toMatchObject({ retired_reason: "mode off" });
    // The flag clears and recurs while off: nothing records it, so turning on again starts from the board as it is.
    f.store.tasks.updateTask(task.id, { status: "todo" });
    f.store.tasks.updateTask(task.id, { status: "in_progress" });
    await goLive(f);
    const open = f.occurrences();
    expect(open).toHaveLength(1);
    expect(open[0].id).not.toBe(first[0].id);
    expect(Date.parse(open[0].eligible_at)).toBeGreaterThan(Date.now() + 9 * 60_000);
    expect((await settings(f)).state.effective).toEqual({ mode: "live", generation: 3 });
  });

  it("refuses the removed shadow mode, a repeated request and any request while switching off", async () => {
    const f = make();
    await expect(f.call("updateAttentionMode", { projectId: f.tracker.id, mode: "shadow" })).rejects.toThrow(/Shadow mode was removed/);
    await expect(f.setMode("off")).rejects.toThrow(/already off/);
    await goLive(f);
    await expect(f.setMode("live")).rejects.toThrow(/already on/);
    insertAttempt(f, "a1", "claimed");
    requestMode(f.db, { trackerId: f.tracker.id, mode: "off" });
    for (const mode of ["off", "live"] as const) await expect(f.setMode(mode)).rejects.toThrow(/switching off/);
  });

  it("reads off or live through config get and leaves the CLI and config set without a write", async () => {
    const f = make();
    await expect(f.call("config.set", { projectId: f.tracker.id, key: "attentionMode", value: "live" })).rejects.toThrow(/owner/);
    await expect(f.call("config.set", { projectId: f.tracker.id, key: "manager", value: "thr_x" })).rejects.toThrow(/owner/);
    expect((await f.call("config.get", { projectId: f.tracker.id, key: "attentionMode" })).values).toEqual({ attentionMode: "off" });
    await goLive(f);
    expect((await f.call("config.get", { projectId: f.tracker.id, key: "attentionMode" })).values).toEqual({ attentionMode: "live" });
  });
});

describe("turning off", () => {
  it("completes at once with nothing in flight: off, unbound, open occurrences retired and exactly one to_shadow ack", async () => {
    const f = make();
    await goLive(f);
    f.card("Open");
    const state = await f.setMode("off");
    expect(state).toEqual({ effective: { mode: "off", generation: 2 }, switchingOff: false });
    expect(modeRow(f)).toMatchObject({ effective_mode: "off", previous_mode: "live", requested_mode: null, transition_direction: null, bound_tracker_id: null, bound_bb_project_id: null });
    expect(f.occurrences()).toHaveLength(0);
    expect(f.occurrences(true)[0]).toMatchObject({ retired_reason: "mode off" });
    expect(acks(f)).toEqual([{ generation: 2, direction: "to_shadow", fence_id: "work-board" }]);
  });

  it("returns Switching off at once while a send is in flight and completes once it settles; an unknown attempt neither holds it nor disappears", async () => {
    const f = make();
    await goLive(f);
    const task = f.card("Undecided");
    f.makeEligible();
    insertAttempt(f, "undecided", "unknown", f.occurrences().find((o) => o.task_id === task.id).id);
    f.card("In flight");
    f.makeEligible();
    let release!: () => void;
    f.threads.sendGate = new Promise<void>((resolve) => { release = resolve; });
    const draining = f.service.drain();
    await vi.waitFor(() => expect(f.attempts().map((a) => a.outcome)).toContain("sending"));
    // The call returns at once with the committed state, while the send is still held.
    expect(await f.setMode("off")).toEqual({ effective: { mode: "live", generation: 1 }, switchingOff: true });
    expect((await settings(f)).state).toEqual({ effective: { mode: "live", generation: 1 }, switchingOff: true });
    expect(acks(f)).toEqual([]);
    f.card("Fresh");
    f.makeEligible();
    const signals = () => f.harness.realtimeSignals.filter((signal: { channel: string }) => signal.channel === "projects:changed").length;
    const before = signals();
    release();
    await draining;
    // The background completion writes the ack row and tells open views.
    await vi.waitFor(() => expect(acks(f)).toHaveLength(1));
    expect((await settings(f)).state).toEqual({ effective: { mode: "off", generation: 2 }, switchingOff: false });
    expect(signals()).toBeGreaterThan(before);
    await f.service.drain();
    // The one send in flight finished; nothing new was claimed after the switch began.
    expect(f.threads.sends).toBe(1);
    expect(f.attempts().map((a) => a.outcome).sort()).toEqual(["queued", "unknown"]);
    expect(acks(f)).toHaveLength(1);
    expect((await settings(f)).unresolvedAttempts.map((a: { attemptId: string }) => a.attemptId)).toEqual(["undecided"]);
  });
});

describe("legacy Shadow rows", () => {
  it("turns a Shadow row, with or without a pending switch to live, into Off that sends nothing", async () => {
    for (const pending of [false, true]) {
      const f = make({ start: false });
      const task = f.card("Seen in shadow");
      legacyRow(f, {
        effective_mode: "shadow", effective_generation: 3, bound_tracker_id: f.tracker.id, bound_bb_project_id: BB_PROJECT, shadow_started_at: "2000-01-01T00:00:00.000Z", parity_reviewed: pending ? 1 : 0,
        ...(pending ? { requested_mode: "live", requested_generation: 4, transition_token: "tok", transition_direction: "to_live", transition_state: "ready", ready_at: "2000-01-01T00:00:00.000Z", ready_rev: 1 } : {}),
      });
      f.db.prepare("INSERT INTO manager_attention(id, tracker_id, task_id, task_key, kind, signal, first_seen_at, eligible_at, created_rev, rev) VALUES ('occ', ?, ?, ?, 'stale-status', 'no_active_thread', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z', 1, 1)")
        .run(f.tracker.id, task.id, task.key);
      f.start();
      expect(modeRow(f)).toMatchObject({
        effective_mode: "off", effective_generation: 4, previous_mode: "shadow", requested_mode: null, transition_token: null, transition_direction: null,
        bound_tracker_id: null, bound_bb_project_id: null, shadow_started_at: null,
      });
      expect(f.occurrences(true)).toEqual([expect.objectContaining({ id: "occ", retired_reason: "shadow mode removed" })]);
      await f.service.reconcileAll();
      expect(f.threads.sends).toBe(0);
      expect(f.attempts()).toEqual([]);
      expect(acks(f)).toEqual([]);
      // Idempotent: a second pass changes nothing.
      const before = modeRow(f);
      normalizeLegacyModes(f.db);
      expect(modeRow(f)).toEqual(before);
    }
  });

  it("completes a switch-off that waited for an acknowledgement at startup, and one still preparing once its attempt settles", async () => {
    const ready = make({ start: false });
    legacyRow(ready, { effective_mode: "live", effective_generation: 2, bound_tracker_id: ready.tracker.id, bound_bb_project_id: BB_PROJECT, requested_mode: "shadow", requested_generation: 3, transition_token: "tok-ready", transition_direction: "to_shadow", transition_state: "ready" });
    ready.start();
    expect(modeRow(ready)).toMatchObject({ effective_mode: "off", effective_generation: 3, transition_direction: null, bound_tracker_id: null });
    expect(acks(ready)).toEqual([{ generation: 3, direction: "to_shadow", fence_id: "work-board" }]);

    const preparing = make({ start: false });
    legacyRow(preparing, { effective_mode: "live", effective_generation: 2, bound_tracker_id: preparing.tracker.id, bound_bb_project_id: BB_PROJECT, requested_mode: "shadow", requested_generation: 3, transition_token: "tok-prep", transition_direction: "to_shadow", transition_state: "preparing" });
    insertAttempt(preparing, "a1", "sending");
    normalizeLegacyModes(preparing.db);
    expect(modeRow(preparing)).toMatchObject({ effective_mode: "live", transition_direction: "to_shadow" });
    expect((await settings(preparing)).state).toEqual({ effective: { mode: "live", generation: 2 }, switchingOff: true });
    preparing.threads.addRow(MANAGER, `notice\n\n${attentionMarker("batch-a1")}`);
    await preparing.service.settleSwitchOff(preparing.tracker.id);
    expect(preparing.attempts()[0].outcome).toBe("queued");
    expect(modeRow(preparing)).toMatchObject({ effective_mode: "off", effective_generation: 3 });
    expect(acks(preparing)).toEqual([{ generation: 3, direction: "to_shadow", fence_id: "work-board" }]);
  });

  it("normalizes before the startup reconciliation, which still recovers receipts, registers its pass and listens to manager events", async () => {
    const f = make({ start: false });
    legacyRow(f, { effective_mode: "live", effective_generation: 5, bound_tracker_id: f.tracker.id, bound_bb_project_id: BB_PROJECT });
    const task = f.card("Sent before the restart");
    const id = f.occurrences().find((o) => o.task_id === task.id).id;
    insertAttempt(f, "a1", "sending", id);
    f.threads.addRow(MANAGER, `notice\n\n${attentionMarker("batch-a1")}`);
    const other = f.store.tasks.createProject({ name: "Legacy", prefix: "LEG", color: "red" });
    f.db.prepare("INSERT INTO attention_modes(tracker_id, kind, effective_mode, effective_generation) VALUES (?, 'stale-status', 'shadow', 1)").run(other.id);
    f.start();
    // Synchronous: done before any awaited reconciliation or drain.
    expect(f.db.prepare("SELECT effective_mode FROM attention_modes WHERE tracker_id=?").get(other.id)).toEqual({ effective_mode: "off" });
    // A live project is left as it was and its receipt is recovered by the startup reconciliation.
    expect(modeRow(f)).toMatchObject({ effective_mode: "live", effective_generation: 5, bound_tracker_id: f.tracker.id });
    await vi.waitFor(() => expect(f.attempts()[0]).toMatchObject({ attempt_id: "a1", outcome: "queued" }));
    expect(f.harness.registrations.schedules.map((schedule: { name: string }) => schedule.name)).toContain("attention-reconcile");
    // Delivery goes on with the same manager.
    const fresh = f.card("New");
    f.makeEligible();
    await f.harness.runSchedule("attention-reconcile");
    expect(sent(f)).toContain(fresh.key);
    expect(f.attempts().at(-1)).toMatchObject({ recipient_thread_id: MANAGER, generation: 5, outcome: "appended" });
    // Manager events are still observed.
    await f.harness.emitThreadEvent("thread.deleted", { thread: { id: MANAGER } } as never);
    expect((await settings(f)).managerWarning).toBe("The manager session was deleted; notices are not being sent");
  });
});
