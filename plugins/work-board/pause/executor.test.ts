import { expect, it, vi } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { goLive, setup } from "../attention/fixtures";
import { setPauseMode } from "./store";

it("delivers to the executor before allowing a manager claim", async () => {
  const f = setup();
  await goLive(f);
  const task = f.card("Example");
  f.store.tasks.upsertTaskThread({ taskId: task.id, threadId: "thr_example", title: "Worker", presetName: "Agent", liveStatus: "idle" });
  f.harness.sdk.stub("threads.list", async () => [{ ...makeThreadResponse({ id: "thr_example", status: "idle" }), activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 } }]);
  setPauseMode(f.db, f.tracker.id, "on");
  f.makeEligible();
  expect(f.occurrences()[0].executor_state).toBe("pending");
  await f.service.drain();
  expect(f.attempts()).toHaveLength(0);
  expect(f.occurrences()[0]).toMatchObject({ executor_state: "sent" });
  expect(Date.parse(f.occurrences()[0].eligible_at) - Date.now()).toBeGreaterThan(590_000);
  expect(f.threads.rows.some(row => row.threadId === "thr_example")).toBe(true);
  setPauseMode(f.db, f.tracker.id, "off");
  await f.dispose();
});

it("clears pending on mode exit and protects sending from a late result", async () => {
  const f = setup();
  await goLive(f);
  const task = f.card("Example");
  setPauseMode(f.db, f.tracker.id, "on");
  expect(f.occurrences()[0].executor_state).toBe("pending");
  setPauseMode(f.db, f.tracker.id, "off");
  expect(f.occurrences()[0].executor_state).toBe(null);
  setPauseMode(f.db, f.tracker.id, "on");
  f.db.prepare("UPDATE manager_attention SET executor_state='sending' WHERE task_id=?").run(task.id);
  setPauseMode(f.db, f.tracker.id, "off");
  expect(f.occurrences()[0].executor_state).toBe("unknown");
  expect(Date.parse(f.occurrences()[0].eligible_at) - Date.now()).toBeGreaterThan(590_000);
  await f.dispose();
});

it("keeps an uncertain send after switching off during delivery", async () => {
  const f = setup();
  await goLive(f);
  const task = f.card("Example");
  f.store.tasks.upsertTaskThread({ taskId: task.id, threadId: "thr_example", title: "Worker", presetName: "Agent", liveStatus: "idle" });
  f.harness.sdk.stub("threads.list", async () => [{ ...makeThreadResponse({ id: "thr_example", status: "idle" }), activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 } }]);
  setPauseMode(f.db, f.tracker.id, "on");
  let release!: () => void;
  f.threads.sendGate = new Promise<void>(resolve => { release = resolve; });
  const pending = f.service.drain();
  await vi.waitFor(() => expect(f.occurrences()[0].executor_state).toBe("sending"));
  setPauseMode(f.db, f.tracker.id, "off");
  expect(f.occurrences()[0].executor_state).toBe("unknown");
  release();
  await pending;
  expect(f.occurrences()[0].executor_state).toBe("unknown");
  expect(f.attempts()).toHaveLength(0);
  await f.dispose();
});

it("recovers an interrupted executor send without resending", async () => {
  const f = setup(undefined, { start: false });
  await goLive(f);
  f.card("Example");
  setPauseMode(f.db, f.tracker.id, "on");
  f.db.prepare("UPDATE manager_attention SET executor_state='sending'").run();
  f.start();
  expect(f.occurrences()[0].executor_state).toBe("unknown");
  expect(Date.parse(f.occurrences()[0].eligible_at) - Date.now()).toBeGreaterThan(590_000);
  await f.dispose();
});

it("retires pending occurrences when attention leaves live mode", async () => {
  const f = setup();
  await goLive(f);
  f.card("Example");
  setPauseMode(f.db, f.tracker.id, "on");
  expect(f.occurrences()[0].executor_state).toBe("pending");
  await f.setMode("off");
  expect(f.occurrences()).toHaveLength(0);
  expect(f.occurrences(true)[0].retired_reason).toBe("mode off");
  await f.dispose();
});
