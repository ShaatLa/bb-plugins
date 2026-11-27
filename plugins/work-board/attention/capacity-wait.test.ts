import { expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createStore } from "../api";
import { capacityWait, syncCapacityWaits } from "./capacity-wait";
import { goLive, setup } from "./fixtures";

it("recognizes only queued concurrency-limit waits", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  try {
    const ids = ["slot", "time", "interaction", "host", "other", "pending"];
    harness.sdk.stub("threads.list", async () => ids.map(id => makeThreadResponse({ id, status: "pending", queuedWork: id === "pending" ? "none" : "waiting" } as never)) as never);
    harness.sdk.stub("threads.queuedMessages.list", async ({ threadId }: { threadId: string }) => [{ state: "waiting", waitingOn: threadId === "slot" ? { kind: "plugin", pluginId: "concurrency-limit", reason: "full" } : threadId === "other" ? { kind: "plugin", pluginId: "other", reason: "other" } : { kind: threadId === "host" ? "host-offline" : threadId } }] as never);
    expect([...await capacityWait(bb, ids)]).toEqual([["slot", "full"]]);
    expect(harness.sdk.callsTo("threads.queuedMessages.list")).toHaveLength(5);
  } finally { await harness.dispose(); }
});

it("clears and reopens the ledger occurrence without recording work", async () => {
  const f = setup();
  try {
    await goLive(f);
    const task = f.card("Task");
    const link = f.store.tasks.upsertTaskThread({ taskId: task.id, threadId: "thr_worker", title: "Worker", presetName: "Agent", liveStatus: "idle" });
    const occurrence = f.occurrences().find(o => o.signal === "no_active_thread");
    expect(occurrence).toBeDefined();
    expect(f.store.tasks.staleStatusFlags([task.id]).get(task.id)).toContain("no_active_thread");
    let waiting = true;
    f.harness.sdk.stub("threads.list", async () => [makeThreadResponse({ id: "thr_worker", status: "idle", queuedWork: waiting ? "waiting" : "none" } as never)] as never);
    f.harness.sdk.stub("threads.queuedMessages.list", async () => [{ state: "waiting", waitingOn: { kind: "plugin", pluginId: "concurrency-limit", reason: "full" } }] as never);
    const before = f.db.prepare("SELECT last_working_at FROM task_threads WHERE id=?").get(link.id);
    await syncCapacityWaits(f.bb, f.store.tasks);
    expect(f.store.tasks.getTaskThread(link.id)?.liveStatus).toBe("starting");
    expect(f.store.tasks.staleStatusFlags([task.id]).get(task.id) ?? []).not.toContain("no_active_thread");
    expect(f.occurrences(true).find(o => o.id === occurrence.id).cleared_at).not.toBeNull();
    expect(f.db.prepare("SELECT last_working_at FROM task_threads WHERE id=?").get(link.id)).toEqual(before);
    waiting = false;
    await syncCapacityWaits(f.bb, f.store.tasks);
    expect(f.store.tasks.staleStatusFlags([task.id]).get(task.id)).toContain("no_active_thread");
    expect(f.occurrences().some(o => o.signal === "no_active_thread")).toBe(true);
    f.harness.sdk.stub("threads.list", async () => { throw new Error("offline"); });
    await syncCapacityWaits(f.bb, f.store.tasks);
    expect(f.store.tasks.getTaskThread(link.id)?.liveStatus).toBe("idle");
  } finally { await f.dispose(); }
});

it("reruns an overlapping pass with fresh SDK results", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  try {
    const store = createStore(bb);
    const project = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue" });
    const task = store.tasks.createTask({ projectId: project.id, title: "Task", status: "in_progress" });
    const link = store.tasks.upsertTaskThread({ taskId: task.id, threadId: "thr_worker", title: "Worker", presetName: "Agent", liveStatus: "idle" });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    harness.sdk.stub("threads.list", async () => { const n = ++calls; if (n === 1) await gate; return [makeThreadResponse({ id: "thr_worker", status: "idle", queuedWork: n === 1 ? "none" : "waiting" } as never)] as never; });
    harness.sdk.stub("threads.queuedMessages.list", async () => [{ state: "waiting", waitingOn: { kind: "plugin", pluginId: "concurrency-limit", reason: "full" } }] as never);
    const first = syncCapacityWaits(bb, store.tasks);
    const second = syncCapacityWaits(bb, store.tasks);
    release();
    await Promise.all([first, second]);
    expect(calls).toBe(2);
    expect(store.tasks.getTaskThread(link.id)?.liveStatus).toBe("starting");
  } finally { await harness.dispose(); }
});

it("does not overwrite a lifecycle event while the SDK read is pending and reruns overlapping calls", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  try {
    const store = createStore(bb);
    const project = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue" });
    const task = store.tasks.createTask({ projectId: project.id, title: "Task", status: "in_progress" });
    const link = store.tasks.upsertTaskThread({ taskId: task.id, threadId: "thr_worker", title: "Worker", presetName: "Attached", liveStatus: "idle" });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    harness.sdk.stub("threads.list", async () => { calls++; if (calls === 1) await gate; return [makeThreadResponse({ id: "thr_worker", status: "idle", queuedWork: "waiting" } as never)] as never; });
    harness.sdk.stub("threads.queuedMessages.list", async () => [{ state: "waiting", waitingOn: { kind: "plugin", pluginId: "concurrency-limit", reason: "full" } }] as never);
    const first = syncCapacityWaits(bb, store.tasks);
    const second = syncCapacityWaits(bb, store.tasks);
    store.tasks.updateTaskThreadStatus(link.id, "working");
    release();
    await Promise.all([first, second]);
    expect(store.tasks.getTaskThread(link.id)?.liveStatus).toBe("working");
    expect(calls).toBe(1); // the rerun has no eligible links
  } finally { await harness.dispose(); }
});

it.each(["failed", "detached", "restarted"] as const)("does not overwrite a %s link during a read", async change => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  try {
    const store = createStore(bb);
    const project = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue" });
    const task = store.tasks.createTask({ projectId: project.id, title: "Task", status: "in_progress" });
    const link = store.tasks.upsertTaskThread({ taskId: task.id, threadId: "thr_worker", title: "Worker", presetName: "Attached", liveStatus: change === "restarted" ? "starting" : "idle" });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    harness.sdk.stub("threads.list", async () => { await gate; return [makeThreadResponse({ id: "thr_worker", status: "idle", queuedWork: change === "restarted" ? "none" : "waiting" } as never)] as never; });
    harness.sdk.stub("threads.queuedMessages.list", async () => [{ state: "waiting", waitingOn: { kind: "plugin", pluginId: "concurrency-limit", reason: "full" } }] as never);
    const pass = syncCapacityWaits(bb, store.tasks);
    if (change === "detached") store.tasks.deleteTaskThread(link.id);
    else if (change === "restarted") { store.tasks.updateTaskThreadStatus(link.id, "working"); store.tasks.updateTaskThreadStatus(link.id, "starting"); }
    else store.tasks.updateTaskThreadStatus(link.id, "failed");
    release();
    await pass;
    expect(store.tasks.getTaskThread(link.id)?.liveStatus).toBe(change === "detached" ? undefined : change === "failed" ? "failed" : "starting");
  } finally { await harness.dispose(); }
});
