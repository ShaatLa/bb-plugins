import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from "../api";
import { transfers } from "../checks/transfer";
import { createFakeThreads, BB_PROJECT, MANAGER, setup } from "./fixtures";
import { getModeRow, kindState, requestMode } from "./modes";
import { registerAttention } from "./rpc";

type Fixture = ReturnType<typeof setup>;
const fixtures: Fixture[] = [];
const disposers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  transfers.clear();
  await Promise.all([...fixtures.splice(0).map((f) => f.dispose()), ...disposers.splice(0).map((dispose) => dispose())]);
});

const ownRunner = (db: Fixture["db"], trackerId: string, extra: { owner?: string; sentId?: string | null; receivedId?: string | null } = {}) =>
  db.prepare("INSERT INTO checks_runner_owner (bb_project_id, owner, tracker_id, sent_id, sent_confirmed, received_id, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)")
    .run(BB_PROJECT, extra.owner ?? "work-board", extra.owner === "sweep" ? null : trackerId, extra.sentId ?? null, extra.receivedId ?? null, new Date().toISOString());
const acks = (db: Fixture["db"], trackerId: string) => db.prepare<[string], { token: string; generation: number; direction: string; fence_id: string }>("SELECT token, generation, direction, fence_id FROM attention_acks WHERE tracker_id=? ORDER BY generation").all(trackerId);

/** Shadow aged past the gate, then a live request: a ready to_live that only an acknowledgement completes. */
async function readyLive(f: Fixture) {
  await f.setMode("shadow");
  f.ageShadow(49);
  return (await f.setMode("live", true)).transition as { token: string; generation: number; state: string };
}

describe("Work Board acknowledges a transition when it runs the checks", () => {
  it("completes a ready to_live persisted before the upgrade at startup, with Sweep absent: one batch for due occurrences, grace kept for a newer one", async () => {
    const threads = createFakeThreads();
    const host = createFakePluginHost({ pluginId: "work-board", sdk: threads.sdk as never });
    disposers.push(() => host.harness.dispose());
    const { bb, harness } = host;
    const store = createStore(bb);
    registerTasksApi(bb, store);
    const db = bb.storage.database();
    const tracker = store.tasks.createProject({ name: "Attention", prefix: "ATT", color: "blue", linkedBbProjectId: BB_PROJECT });
    db.prepare("INSERT INTO attention_manager(tracker_id, manager, changed_at, previous) VALUES (?, ?, ?, NULL)").run(tracker.id, MANAGER, new Date().toISOString());
    // A migrated runner: the import lineage stays on the row.
    ownRunner(db, tracker.id, { receivedId: "handoff_example" });
    const due = store.tasks.createTask({ projectId: tracker.id, title: "Due", status: "in_progress" });
    const fresh = store.tasks.createTask({ projectId: tracker.id, title: "Fresh", status: "in_progress" });
    requestMode(db, { trackerId: tracker.id, mode: "shadow" });
    db.prepare("UPDATE manager_attention SET eligible_at='2000-01-01T00:00:00.000Z' WHERE task_id=?").run(due.id);
    db.prepare("UPDATE attention_modes SET shadow_started_at=? WHERE tracker_id=?").run(new Date(Date.now() - 49 * 3_600_000).toISOString(), tracker.id);
    const requested = requestMode(db, { trackerId: tracker.id, mode: "live", parityReviewed: true }).transition!;
    expect(requested.state).toBe("ready");
    const signalsBefore = harness.realtimeSignals.filter((signal: { channel: string }) => signal.channel === "projects:changed").length;

    registerAttention(bb, store);
    await vi.waitFor(() => expect(threads.rows).toHaveLength(1));
    expect(kindState(db, tracker.id)).toMatchObject({ effective: { mode: "live", generation: requested.generation }, requested: null, transition: null });
    expect(acks(db, tracker.id)).toEqual([{ token: requested.token, generation: requested.generation, direction: "to_live", fence_id: "work-board" }]);
    expect(harness.realtimeSignals.filter((signal: { channel: string }) => signal.channel === "projects:changed").length).toBeGreaterThan(signalsBefore);
    const text = threads.text(threads.rows[0]!);
    expect(text).toContain(due.key);
    expect(text).not.toContain(fresh.key);
    // Nothing was baselined: the newer occurrence keeps its grace and stays claimable later.
    expect(db.prepare("SELECT COUNT(*) AS n FROM manager_attention WHERE sweep_baselined_generation IS NOT NULL").get()).toEqual({ n: 0 });
  });

  it("leaves the transition pending for a Sweep-owned or unowned runner, an unconfirmed send, an import paused at confirmation and an export in preflight", async () => {
    const f = setup(); fixtures.push(f);
    const transition = await readyLive(f);
    const stillPending = async () => {
      await f.service.drainTracker(f.tracker.id);
      expect(getModeRow(f.db, f.tracker.id)).toMatchObject({ effective_mode: "shadow", transition_token: transition.token, transition_state: "ready" });
      expect(acks(f.db, f.tracker.id)).toEqual([]);
    };
    await stillPending(); // no runner row
    ownRunner(f.db, f.tracker.id, { owner: "sweep" });
    await stillPending();
    f.db.prepare("DELETE FROM checks_runner_owner").run();
    ownRunner(f.db, f.tracker.id, { sentId: "handoff_example" });
    await stillPending();
    f.db.prepare("UPDATE checks_runner_owner SET sent_id=NULL").run();
    for (const command of ["import-from-sweep", "export-to-sweep"]) {
      transfers.set(BB_PROJECT, command);
      await stillPending();
      transfers.clear();
    }
    await f.service.drainTracker(f.tracker.id);
    expect(getModeRow(f.db, f.tracker.id).effective_mode).toBe("live");
    expect(acks(f.db, f.tracker.id)).toEqual([{ token: transition.token, generation: transition.generation, direction: "to_live", fence_id: "work-board" }]);
  });

  it("keeps a return to shadow preparing while an attempt is unresolved, and completes it once the attempt is resolved", async () => {
    const f = setup(); fixtures.push(f);
    ownRunner(f.db, f.tracker.id);
    await readyLive(f);
    await f.service.drainTracker(f.tracker.id);
    expect(getModeRow(f.db, f.tracker.id).effective_mode).toBe("live");
    f.db.prepare("INSERT INTO attention_attempts(attempt_id, tracker_id, kind, generation, batch_id, recipient_thread_id, recipient_source, started_at, outcome, rev) VALUES ('att_example', ?, 'stale-status', ?, 'batch_example', ?, 'manager', ?, 'unknown', 0)")
      .run(f.tracker.id, getModeRow(f.db, f.tracker.id).effective_generation, MANAGER, new Date().toISOString());
    const back = await f.setMode("shadow");
    expect(back.transition).toMatchObject({ direction: "to_shadow", state: "preparing" });
    await f.service.drainTracker(f.tracker.id);
    expect(getModeRow(f.db, f.tracker.id)).toMatchObject({ effective_mode: "live", transition_state: "preparing" });
    await f.call("resolveAttentionAttempt", { attemptId: "att_example", disposition: "waived_loss" });
    expect(kindState(f.db, f.tracker.id)).toMatchObject({ effective: { mode: "shadow", generation: back.transition.generation }, transition: null });
    expect(acks(f.db, f.tracker.id).map((ack) => [ack.direction, ack.generation, ack.token, ack.fence_id])).toEqual([
      ["to_live", back.transition.generation - 1, expect.any(String), "work-board"],
      ["to_shadow", back.transition.generation, back.transition.token, "work-board"],
    ]);
  });
});
