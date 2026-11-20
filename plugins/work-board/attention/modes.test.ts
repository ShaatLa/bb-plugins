import { afterEach, describe, expect, it, vi } from "vitest";
import { BB_PROJECT, goLive, setup, SWEEP } from "./fixtures";

const fixtures: ReturnType<typeof setup>[] = [];
const make = () => { const f = setup(); fixtures.push(f); return f; };
afterEach(async () => { await Promise.all(fixtures.splice(0).map((f) => f.dispose())); });

const ackInput = (f: ReturnType<typeof setup>, transition: { token: string; generation: number }, direction: "to_live" | "to_shadow", extra: Record<string, unknown> = {}) => ({
  projectId: BB_PROJECT, trackerId: f.tracker.id, kind: "stale-status", token: transition.token, generation: transition.generation, direction, fenceId: "fence-1", ...extra,
});
const modes = async (f: ReturnType<typeof setup>) => (await f.sweep("attention.modes", { projectId: BB_PROJECT })).kinds["stale-status"];

describe("binding", () => {
  it("answers not_linked without a tracker and ambiguous_link with two", async () => {
    const f = make();
    expect(await f.sweep("attention.modes", { projectId: "proj_unlinked" })).toMatchObject({ ok: false, code: "not_linked" });
    const second = f.store.tasks.createProject({ name: "Second", prefix: "SEC", color: "red", linkedBbProjectId: BB_PROJECT });
    const result = await f.sweep("attention.modes", { projectId: BB_PROJECT });
    expect(result).toMatchObject({ ok: false, code: "ambiguous_link" });
    expect(result.trackers.map((tracker: { id: string }) => tracker.id).sort()).toEqual([f.tracker.id, second.id].sort());
  });

  it("refuses a relink while bound and while a transition is pending, and a second link to a bound project", async () => {
    const f = make();
    const other = f.store.tasks.createProject({ name: "Other", prefix: "OTH", color: "red" });
    await f.setMode("shadow");
    expect(() => f.store.tasks.updateProject(f.tracker.id, { linkedBbProjectId: "proj_elsewhere" })).toThrow(/not off/);
    expect(() => f.store.tasks.updateProject(other.id, { linkedBbProjectId: BB_PROJECT })).toThrow(/bound/);
    expect(() => f.store.tasks.createProject({ name: "Third", prefix: "THR", color: "red", linkedBbProjectId: BB_PROJECT })).toThrow(/bound/);
    f.store.tasks.updateProject(f.tracker.id, { name: "Renamed" });
    await goLiveFromShadow(f);
    await f.setMode("shadow");
    expect(() => f.store.tasks.updateProject(f.tracker.id, { linkedBbProjectId: null })).toThrow(/not off/);
    // Off with nothing pending releases the binding.
    const fresh = make();
    await fresh.setMode("shadow");
    await fresh.setMode("off");
    expect(fresh.store.tasks.updateProject(fresh.tracker.id, { linkedBbProjectId: "proj_elsewhere" }).linkedBbProjectId).toBe("proj_elsewhere");
  });

  it("does not match a replayed ack of an earlier tracker after off, rebind and a new transition with the same generation", async () => {
    const f = make();
    await f.setMode("shadow");
    f.ageShadow(49);
    const first = (await f.setMode("live", true)).transition;
    const oldAck = ackInput(f, first, "to_live");
    expect((await f.sweep("attention.ack", oldAck)).ok).toBe(true);
    await f.setMode("shadow"); // pending to_shadow
    const rollback = (await modes(f)).transition;
    await f.sweep("attention.ack", ackInput(f, rollback, "to_shadow", { fenceId: "fence-2" }));
    await f.setMode("off");
    f.store.tasks.updateProject(f.tracker.id, { linkedBbProjectId: null });
    const replacement = f.store.tasks.createProject({ name: "Replacement", prefix: "REP", color: "red", linkedBbProjectId: BB_PROJECT });
    await f.call("updateAttentionMode", { projectId: replacement.id, mode: "shadow" });
    expect((await f.sweep("attention.modes", { projectId: BB_PROJECT })).trackerId).toBe(replacement.id);
    expect(await f.sweep("attention.ack", oldAck)).toMatchObject({ ok: false, code: "binding_changed", boundTrackerId: replacement.id });
    expect((await f.sweep("attention.ledger", { projectId: BB_PROJECT, kind: "stale-status" })).ok).not.toBe(false);
  });

  it("answers binding_changed when a call resolves to another tracker than the bound one", async () => {
    const f = make();
    await f.setMode("shadow");
    // Simulate a link that moved behind the guard: the bound tracker is no longer the one the project resolves to.
    const other = f.store.tasks.createProject({ name: "Other", prefix: "OTH", color: "red" });
    f.db.prepare("UPDATE projects SET linked_bb_project_id=NULL WHERE id=?").run(f.tracker.id);
    f.db.prepare("UPDATE projects SET linked_bb_project_id=? WHERE id=?").run(BB_PROJECT, other.id);
    expect(await f.sweep("attention.modes", { projectId: BB_PROJECT })).toMatchObject({ ok: false, code: "binding_changed", boundTrackerId: f.tracker.id });
  });
});

async function goLiveFromShadow(f: ReturnType<typeof setup>) {
  f.ageShadow(49);
  const { transition } = (await f.setMode("live", true)) as { transition: { token: string; generation: number } };
  await f.sweep("attention.ack", ackInput(f, transition, "to_live"));
}

describe("ack", () => {
  it("is refused from a non-Sweep plugin, from the app and from a direct rpc call", async () => {
    const f = make();
    await f.setMode("shadow");
    f.ageShadow(49);
    const { transition } = await f.setMode("live", true);
    const input = ackInput(f, transition, "to_live");
    expect(await f.call("attention.ack", input)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await f.call("attention.ack", input, { kind: "plugin", pluginId: "other-plugin" })).toMatchObject({ ok: false, code: "forbidden" });
    expect((await modes(f)).effective.mode).toBe("shadow");
    expect((await f.sweep("attention.ack", input)).ok).toBe(true);
  });

  it("returns the stored result for a replay after a later transition began, and changes nothing", async () => {
    const f = make();
    await f.setMode("shadow");
    f.ageShadow(49);
    const { transition } = await f.setMode("live", true);
    const input = ackInput(f, transition, "to_live", { acceptedOccurrenceIds: ["unknown-id"] });
    const first = await f.sweep("attention.ack", input);
    expect(first).toMatchObject({ ok: true, unmatched: [{ occurrenceId: "unknown-id", reason: "unknown" }] });
    await f.setMode("shadow");
    const pending = (await modes(f)).transition;
    const before = await modes(f);
    expect(await f.sweep("attention.ack", input)).toEqual(first);
    expect(await modes(f)).toEqual(before);
    expect(pending.direction).toBe("to_shadow");
  });

  it("answers ack_conflict for a changed replay, stale_ack for a finished generation and generation_mismatch for a wrong one", async () => {
    const f = make();
    await f.setMode("shadow");
    f.ageShadow(49);
    const { transition } = await f.setMode("live", true);
    const input = ackInput(f, transition, "to_live");
    expect((await f.sweep("attention.ack", input)).ok).toBe(true);
    // The same token with another fence, id set, generation or direction is a mutated replay.
    expect(await f.sweep("attention.ack", { ...input, fenceId: "another" })).toMatchObject({ ok: false, code: "ack_conflict" });
    expect(await f.sweep("attention.ack", { ...input, acceptedOccurrenceIds: ["x"] })).toMatchObject({ ok: false, code: "ack_conflict" });
    expect(await f.sweep("attention.ack", { ...input, generation: input.generation + 1 })).toMatchObject({ ok: false, code: "ack_conflict" });
    expect(await f.sweep("attention.ack", { ...input, direction: "to_shadow" })).toMatchObject({ ok: false, code: "ack_conflict" });
    // A token never issued, at a finished generation, is stale; a later one is a mismatch.
    expect(await f.sweep("attention.ack", { ...input, token: "never-issued" })).toMatchObject({ ok: false, code: "stale_ack", current: { effective: { mode: "live" } } });
    await f.setMode("shadow");
    const pending = (await modes(f)).transition;
    expect(await f.sweep("attention.ack", ackInput(f, { token: "other-token", generation: pending.generation + 1 }, "to_shadow"))).toMatchObject({ ok: false, code: "generation_mismatch" });
    expect(await f.sweep("attention.ack", ackInput(f, { token: pending.token, generation: pending.generation }, "to_live", { fenceId: "z" }))).toMatchObject({ ok: false, code: "generation_mismatch" });
  });

  it("does not accept a pending ack whose direction differs, and none while preparing", async () => {
    const f = make();
    const { transition } = await goLive(f);
    // An unresolved attempt keeps the fence in preparing.
    f.db.prepare("INSERT INTO attention_attempts(attempt_id, tracker_id, kind, generation, batch_id, recipient_thread_id, recipient_source, started_at, outcome, rev) VALUES ('a1', ?, 'stale-status', 2, 'b1', 'thr_manager', 'manager', ?, 'unknown', 1)").run(f.tracker.id, new Date().toISOString());
    const state = await f.setMode("shadow");
    expect(state.transition).toMatchObject({ direction: "to_shadow", state: "preparing", handback: null });
    expect(await f.sweep("attention.ack", ackInput(f, state.transition, "to_shadow"))).toMatchObject({ ok: false, code: "generation_mismatch" });
    f.db.prepare("UPDATE attention_attempts SET disposition='waived_loss' WHERE attempt_id='a1'").run();
    await f.service.reconcileFence(f.tracker.id);
    const ready = (await modes(f)).transition;
    expect(ready.state).toBe("ready");
    expect(await f.sweep("attention.ack", ackInput(f, ready, "to_live"))).toMatchObject({ ok: false, code: "generation_mismatch" });
    expect(transition.generation).toBeLessThan(ready.generation);
  });
});

describe("requests", () => {
  it("refuses off → live, live before 48 hours of shadow, live without the parity confirmation and live → off", async () => {
    const f = make();
    await expect(f.setMode("live", true)).rejects.toThrow(/from shadow/);
    await f.setMode("shadow");
    await expect(f.setMode("live", true)).rejects.toThrow(/48 hours/);
    f.ageShadow(47);
    await expect(f.setMode("live", true)).rejects.toThrow(/48 hours/);
    f.ageShadow(49);
    await expect(f.setMode("live")).rejects.toThrow(/parity/);
    await expect(f.setMode("live", false)).rejects.toThrow(/parity/);
    await goLiveFromShadow(f);
    await expect(f.setMode("off")).rejects.toThrow(/through shadow/);
  });

  it("refuses every request while a transition is pending, and logs the direct write", async () => {
    const f = make();
    const info = vi.spyOn(f.bb.log, "info");
    await f.setMode("shadow");
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/attention stale-status for .*: off → shadow/));
    f.ageShadow(49);
    await f.setMode("live", true);
    for (const mode of ["off", "shadow", "live"] as const) await expect(f.setMode(mode, true)).rejects.toThrow(/pending/);
  });

  it("is a plain read for attention.modes and leaves the CLI and config set without a write", async () => {
    const f = make();
    const before = f.db.prepare("SELECT COUNT(*) AS n FROM attention_modes").get() as { n: number };
    expect((await modes(f)).effective).toEqual({ mode: "off", generation: 0 });
    expect((f.db.prepare("SELECT COUNT(*) AS n FROM attention_modes").get() as { n: number }).n).toBe(before.n);
    await expect(f.call("config.set", { projectId: f.tracker.id, key: "attentionMode", value: "live" })).rejects.toThrow(/owner/);
    await expect(f.call("config.set", { projectId: f.tracker.id, key: "attentionManager", value: "thr_x" })).rejects.toThrow(/owner/);
    expect((await f.call("config.get", { projectId: f.tracker.id, key: "attentionMode" })).values).toEqual({ attentionMode: "off" });
  });
});

describe("off and shadow", () => {
  it("starts a fresh observation on off → shadow and retires ids from before the off interval", async () => {
    const f = make();
    await f.setMode("shadow");
    const task = f.card("Stale");
    const first = f.occurrences();
    expect(first).toHaveLength(1);
    await f.setMode("off");
    expect(f.occurrences()).toHaveLength(0);
    expect(f.occurrences(true)[0]).toMatchObject({ retired_reason: "mode off" });
    // The flag clears and recurs while off: nothing records it, so the next shadow starts from the board as it is.
    f.store.tasks.updateTask(task.id, { status: "todo" });
    f.store.tasks.updateTask(task.id, { status: "in_progress" });
    await f.setMode("shadow");
    const open = f.occurrences();
    expect(open).toHaveLength(1);
    expect(open[0].id).not.toBe(first[0].id);
    expect((await modes(f)).effective).toEqual({ mode: "shadow", generation: 3 });
    const row = f.db.prepare("SELECT shadow_started_at FROM attention_modes WHERE tracker_id=?").get(f.tracker.id) as { shadow_started_at: string };
    expect(Date.now() - Date.parse(row.shadow_started_at)).toBeLessThan(5000);
  });
});

describe("to_live baseline", () => {
  it("baselines accepted ids that survive a restart and a rollback, are never handed back, while a recurrence is new", async () => {
    const f = make();
    await f.setMode("shadow");
    const kept = f.card("Baselined");
    const cleared = f.card("Cleared before ack");
    const plain = f.card("Plain");
    const [keptId, clearedId] = [f.occurrences().find((o) => o.task_id === kept.id).id, f.occurrences().find((o) => o.task_id === cleared.id).id];
    f.ageShadow(49);
    const { transition } = await f.setMode("live", true);
    expect(transition).toMatchObject({ state: "ready", handback: [] });
    f.store.tasks.updateTask(cleared.id, { status: "todo" });
    const ack = await f.sweep("attention.ack", ackInput(f, transition, "to_live", { acceptedOccurrenceIds: [keptId, clearedId, "missing"] }));
    expect(ack.baselined).toEqual([keptId]);
    expect(ack.unmatched).toEqual(expect.arrayContaining([{ occurrenceId: clearedId, reason: expect.stringContaining("status_changed") }, { occurrenceId: "missing", reason: "unknown" }]));
    // A restart re-reads the same state.
    expect(f.db.prepare("SELECT sweep_baselined_generation FROM manager_attention WHERE id=?").get(keptId)).toEqual({ sweep_baselined_generation: transition.generation });
    f.makeEligible();
    await f.service.drain();
    const sent = f.threads.rows.map((row) => f.threads.text(row)).join("\n");
    f.threads.rows.length = 0;
    expect(sent).not.toContain(kept.key);
    expect(sent).toContain(plain.key);
    // Rollback hands back only the open, unbaselined and unaccepted: here nothing.
    await f.setMode("shadow");
    const state = await modes(f);
    expect(state.transition.handback).toEqual([]);
    await f.sweep("attention.ack", ackInput(f, state.transition, "to_shadow", { fenceId: "f2" }));
    // A recurrence of the baselined flag is a new id with no exemption.
    f.store.tasks.updateTask(kept.id, { status: "todo" });
    f.store.tasks.updateTask(kept.id, { status: "in_progress" });
    const recurrence = f.occurrences().find((o) => o.task_id === kept.id);
    expect(recurrence.id).not.toBe(keptId);
    expect(recurrence.sweep_baselined_generation).toBeNull();
  });

  it("sends a recurrence of a baselined flag once it is live", async () => {
    const f = make();
    await f.setMode("shadow");
    const task = f.card("Recurs");
    const original = f.occurrences()[0].id;
    f.ageShadow(49);
    const { transition } = await f.setMode("live", true);
    await f.sweep("attention.ack", ackInput(f, transition, "to_live", { acceptedOccurrenceIds: [original] }));
    f.store.tasks.updateTask(task.id, { status: "todo" });
    f.store.tasks.updateTask(task.id, { status: "in_progress" });
    f.makeEligible();
    await f.service.drain();
    expect(f.threads.rows.map((row) => f.threads.text(row)).join("\n")).toContain(task.key);
  });
});

describe("to_live", () => {
  it("is ready at request time, resumes after a restart and is refused without the parity confirmation", async () => {
    const f = make();
    await f.setMode("shadow");
    f.ageShadow(49);
    await expect(f.setMode("live")).rejects.toThrow(/parity/);
    const state = await f.setMode("live", true);
    expect(state.transition).toMatchObject({ direction: "to_live", state: "ready", handback: [], readyAt: expect.any(String), readyRev: expect.any(Number) });
    // A restart: the pending transition is read back from the database with the same token.
    const stored = await modes(f);
    expect(stored.transition.token).toBe(state.transition.token);
    expect(stored.requested).toEqual({ mode: "live", generation: state.transition.generation });
    const row = f.db.prepare("SELECT parity_reviewed FROM attention_modes WHERE tracker_id=?").get(f.tracker.id) as { parity_reviewed: number };
    expect(row.parity_reviewed).toBe(1);
  });
});

describe("to_shadow", () => {
  it("keeps a ready snapshot across a restart, and holds preparing while an attempt is unresolved", async () => {
    const f = make();
    await goLive(f);
    f.card("Open");
    f.db.prepare("INSERT INTO attention_attempts(attempt_id, tracker_id, kind, generation, batch_id, recipient_thread_id, recipient_source, started_at, outcome, rev) VALUES ('a1', ?, 'stale-status', 2, 'b1', 'thr_manager', 'manager', ?, 'sending', 1)").run(f.tracker.id, new Date().toISOString());
    const preparing = await f.setMode("shadow");
    expect(preparing.transition).toMatchObject({ state: "preparing", handback: null });
    // `sending` with no evidence and no process driving it becomes unknown, which still holds the fence.
    await f.service.reconcileFence(f.tracker.id);
    expect(f.attempts()[0].outcome).toBe("unknown");
    expect((await modes(f)).transition.state).toBe("preparing");
    await f.call("resolveAttentionAttempt", { attemptId: "a1", disposition: "waived_loss" });
    const ready = (await modes(f)).transition;
    expect(ready.state).toBe("ready");
    expect(ready.handback).toHaveLength(1);
    const again = (await modes(f)).transition;
    expect(again.handback).toEqual(ready.handback);
    expect(again.readyRev).toBe(ready.readyRev);
  });

  it("shows a flag that clears and recurs after ready but before the ack in the ledger after readyAt, not in the handback", async () => {
    const f = make();
    await goLive(f);
    const task = f.card("Flapping");
    const original = f.occurrences()[0];
    await f.setMode("shadow");
    const ready = (await modes(f)).transition;
    expect(ready.handback.map((entry: { occurrenceId: string }) => entry.occurrenceId)).toEqual([original.id]);
    f.store.tasks.updateTask(task.id, { status: "todo" });
    f.store.tasks.updateTask(task.id, { status: "in_progress" });
    const ledger = await f.sweep("attention.ledger", { projectId: BB_PROJECT, kind: "stale-status", sinceRev: ready.readyRev });
    const recurrence = ledger.occurrences.find((o: { taskId: string; clearedAt: string | null }) => o.taskId === task.id && !o.clearedAt);
    expect(recurrence.occurrenceId).not.toBe(original.id);
    expect(recurrence.createdRev).toBeGreaterThan(ready.readyRev);
    expect(ready.handback.map((entry: { occurrenceId: string }) => entry.occurrenceId)).not.toContain(recurrence.occurrenceId);
  });

  it("hands back an open, unaccepted occurrence carried from shadow into live and rolled back, and defines a catch-up range per transfer", async () => {
    const f = make();
    await f.setMode("shadow");
    const carried = f.card("Carried");
    f.ageShadow(49);
    const live = (await f.setMode("live", true)).transition;
    await f.sweep("attention.ack", ackInput(f, live, "to_live"));
    await f.setMode("shadow");
    const first = (await modes(f)).transition;
    expect(first.handback.map((entry: { taskId: string }) => entry.taskId)).toEqual([carried.id]);
    // An older id updated after publication is not caught up; a genuinely new id is.
    const late = f.card("Late");
    const old = f.occurrences().find((o) => o.task_id === carried.id);
    f.store.tasks.updateTask(carried.id, { title: "Renamed" });
    f.db.prepare("UPDATE manager_attention SET rev = (SELECT rev + 1 FROM attention_rev WHERE tracker_id=?) WHERE id=?").run(f.tracker.id, old.id);
    const ack = await f.sweep("attention.ack", ackInput(f, first, "to_shadow"));
    expect(ack.readyRev).toBe(first.readyRev);
    const ledger = await f.sweep("attention.ledger", { projectId: BB_PROJECT, kind: "stale-status" });
    const caughtUp = ledger.occurrences.filter((o: { createdRev: number }) => o.createdRev > ack.readyRev && o.createdRev <= ack.endRev).map((o: { taskId: string }) => o.taskId);
    expect(caughtUp).toEqual([late.id]);
    // The second promotion's range starts at its own readyRev, unaffected by the earlier rollback.
    f.ageShadow(49);
    const second = (await f.setMode("live", true)).transition;
    expect(second.readyRev).toBeGreaterThanOrEqual(ack.endRev);
    await f.sweep("attention.ack", ackInput(f, second, "to_live", { fenceId: "f3" }));
    await f.setMode("shadow");
    expect((await modes(f)).transition.readyRev).toBeGreaterThanOrEqual(second.readyRev);
  });

  it("gives an occurrence created in the same millisecond as readyAt a revision after readyRev, and survives a lost ack response", async () => {
    const f = make();
    await goLive(f);
    await f.setMode("shadow");
    const ready = (await modes(f)).transition;
    const task = f.card("Same millisecond");
    f.db.prepare("UPDATE manager_attention SET first_seen_at=? WHERE task_id=?").run(ready.readyAt, task.id);
    const created = f.occurrences().find((o) => o.task_id === task.id);
    expect(created.created_rev).toBeGreaterThan(ready.readyRev);
    const input = ackInput(f, ready, "to_shadow");
    await f.sweep("attention.ack", input); // the response is lost
    const retried = await f.sweep("attention.ack", input);
    expect(retried).toMatchObject({ ok: true, direction: "to_shadow", mode: "shadow" });
    expect(retried.endRev).toBeGreaterThanOrEqual(created.created_rev);
  });
});
