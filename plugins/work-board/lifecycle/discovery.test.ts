import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it, vi } from "vitest";
import { createStore, registerTasksApi } from "../api";
import { handlers } from "../delegate";
import { tasksRpcContract } from "../shared/contract";
import { registerTasksCli } from "../cli";
import { registerLifecycle } from ".";
import { attachNamedTaskThread, discoverRunningTaskThreads } from "./discovery";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(hosts.splice(0).map((host) => host.harness.dispose()));
});

function setup() {
  const host = createFakePluginHost({ pluginId: "work-board" });
  hosts.push(host);
  const store = createStore(host.bb);
  registerTasksApi(host.bb, store);
  const project = store.tasks.createProject({ name: "Discovery", prefix: "DISC", color: "blue", linkedBbProjectId: "proj_discovery" });
  const task = store.tasks.createTask({ projectId: project.id, title: "Research", status: "in_progress" });
  const thread = makeThreadResponse({ id: "thr_scout", title: `${task.key} CI research scout`, projectId: "proj_discovery", status: "active", runtime: { displayStatus: "active" }, parentThreadId: "thr_manager" });
  const threads = [thread];
  host.harness.sdk.stub("threads.get", async () => thread);
  host.harness.sdk.stub("threads.listRunning", async () => threads.filter((thread) => thread.status === "active").map((thread) => ({ id: thread.id, hostId: null })));
  host.harness.sdk.stub("threads.list", async ({ threadIds }: { threadIds?: readonly string[] }) => threads.filter((thread) => threadIds?.includes(thread.id)).map((thread) => ({
    ...thread,
    activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activeGoalCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 },
  })));
  host.harness.sdk.stub("threads.events.list", async () => []);
  host.harness.sdk.stub("threads.interactions.list", async () => []);
  const meta = async () => tasksRpcContract.listTaskCardMeta.output.parse(await host.harness.callRpc("listTaskCardMeta", { taskIds: [task.id] })).metadata[0]!;
  return { ...host, store, project, task, thread, threads, meta };
}

it("discovers a directly spawned worker in card metadata, then shows Attached when it becomes idle", async () => {
  const f = setup();
  expect((await f.meta()).activity).toMatchObject({ state: "working", workingCount: 1 });
  expect(f.store.tasks.listTaskThreads(f.task.id)).toMatchObject([{ threadId: f.thread.id, presetName: "Auto attached" }]);
  expect(f.store.tasks.listComments(f.task.id)).toMatchObject([{ body: expect.stringContaining(`automatic: title references ${f.task.key}`) }]);
  f.thread.status = "idle";
  f.thread.runtime.displayStatus = "idle";
  expect((await f.meta()).activity?.state).toBe("attached");
  expect(f.harness.sdk.callsTo("threads.listRunning")).toHaveLength(1);
  expect(f.store.tasks.listTaskThreadsByThreadId("thr_manager")).toEqual([]);
});

it("attaches immediately on lifecycle events and records the reason only once", async () => {
  const f = setup();
  await registerLifecycle(f.bb, f.store);
  await f.harness.emitThreadEvent("thread.created", { thread: f.thread });
  await f.harness.emitThreadEvent("thread.active", { thread: f.thread });
  expect(f.store.tasks.listTaskThreads(f.task.id)).toHaveLength(1);
  expect(f.store.tasks.listComments(f.task.id)).toHaveLength(1);
  expect(f.harness.realtimeSignals).toContainEqual(expect.objectContaining({ channel: "threads:changed", payload: { taskId: f.task.id } }));
});

it.each([
  "Designer (Codex): DISC-1, DISC-2 research",
  "Lead: DISC-1+2 research",
  "Lead: DISC-1 + 2 and DISC-1",
  "Owner bugs: disc-1 and DISC-2",
  "Review (DISC-1), (DISC-2)",
])("attaches every named task and respects a per-card manual detachment: %s", async (title) => {
  const f = setup();
  const second = f.store.tasks.createTask({ projectId: f.project.id, title: "Second card", status: "in_progress" });
  f.thread.title = title;
  attachNamedTaskThread(f.bb, f.store, f.thread);
  attachNamedTaskThread(f.bb, f.store, f.thread);
  expect(f.store.tasks.listTaskThreadsByThreadId(f.thread.id).map((link) => link.taskId).sort()).toEqual([f.task.id, second.id].sort());
  expect(f.store.tasks.listComments(second.id)).toHaveLength(1);
  await handlers(f.bb, f.store).taskThreadsDetach({ taskId: f.task.id, threadId: f.thread.id });
  attachNamedTaskThread(f.bb, f.store, f.thread);
  expect(f.store.tasks.listTaskThreads(f.task.id)).toEqual([]);
  expect(f.store.tasks.listTaskThreads(second.id)).toHaveLength(1);
});

it.each([
  { title: null },
  { title: "DISC1 missing separator" },
  { projectId: "proj_elsewhere" },
  { archivedAt: 1 },
  { deletedAt: 1 },
  { status: "idle" as const },
  { status: "stopping" as const },
  { originKind: "fork" as const, originPluginId: "side-chat", visibility: "hidden" as const },
])("does not infer an assignment from unrelated or unavailable threads: %j", (overrides) => {
  const f = setup();
  attachNamedTaskThread(f.bb, f.store, { ...f.thread, ...overrides });
  expect(f.store.tasks.listTaskThreads(f.task.id)).toEqual([]);
});

it("preserves existing assignments, manual detachments and explicit reattachment", async () => {
  const f = setup();
  const other = f.store.tasks.createTask({ projectId: f.project.id, title: "Other" });
  f.store.tasks.upsertTaskThread({ taskId: other.id, threadId: f.thread.id, title: "Explicit", presetName: "Attached", liveStatus: "working" });
  attachNamedTaskThread(f.bb, f.store, f.thread);
  expect(f.store.tasks.listTaskThreads(f.task.id)).toHaveLength(1);
  expect(f.store.tasks.listTaskThreads(other.id)).toHaveLength(1);
  await handlers(f.bb, f.store).taskThreadsDetach({ taskId: f.task.id, threadId: f.thread.id });
  attachNamedTaskThread(f.bb, createStore(f.bb), f.thread);
  expect(f.store.tasks.listTaskThreads(f.task.id)).toHaveLength(0);
  await handlers(f.bb, f.store).taskThreadsAttach({ taskId: f.task.id, threadId: f.thread.id });
  expect(f.store.tasks.listTaskThreads(f.task.id)).toHaveLength(1);
});

it.each(["done", "canceled", "archived", "unlinked"])("skips %s cards", (kind) => {
  const f = setup();
  if (kind === "done" || kind === "canceled") f.store.tasks.updateTask(f.task.id, { status: kind });
  if (kind === "archived") { f.store.tasks.updateTask(f.task.id, { status: "done" }); f.store.tasks.setTaskArchived(f.task.id, true); }
  if (kind === "unlinked") f.store.tasks.updateProject(f.project.id, { linkedBbProjectId: null });
  attachNamedTaskThread(f.bb, f.store, f.thread);
  expect(f.store.tasks.listTaskThreads(f.task.id)).toEqual([]);
});

it("shares in-flight discovery and refreshes a title that appeared after the turn started", async () => {
  const f = setup();
  vi.useFakeTimers({ toFake: ["Date"] });
  const title = f.thread.title;
  f.thread.title = "New thread";
  let release!: (value: { id: string; hostId: null }[]) => void;
  f.harness.sdk.stub("threads.listRunning", () => new Promise((resolve) => { release = resolve; }));
  const first = discoverRunningTaskThreads(f.bb, f.store);
  vi.setSystemTime(Date.now() + 15_000);
  expect(discoverRunningTaskThreads(f.bb, f.store)).toBe(first);
  release([{ id: f.thread.id, hostId: null }]);
  await first;
  expect(f.store.tasks.listTaskThreads(f.task.id)).toEqual([]);
  f.thread.title = title;
  f.harness.sdk.stub("threads.listRunning", async () => [{ id: f.thread.id, hostId: null }]);
  // No event: the snapshot is reused until the safety interval, then refreshed without blocking the caller.
  vi.setSystemTime(Date.now() + 59_000);
  await discoverRunningTaskThreads(f.bb, f.store);
  expect(f.store.tasks.listTaskThreads(f.task.id)).toEqual([]);
  vi.setSystemTime(Date.now() + 1_001);
  await discoverRunningTaskThreads(f.bb, f.store);
  await vi.waitFor(() => expect(f.store.tasks.listTaskThreads(f.task.id)).toHaveLength(1));
});

it("reuses the snapshot until a lifecycle event, serving it while the refresh runs", async () => {
  const f = setup();
  vi.useFakeTimers({ toFake: ["Date"] });
  const running = () => f.harness.sdk.callsTo("threads.listRunning").length;
  await discoverRunningTaskThreads(f.bb, f.store);
  vi.setSystemTime(Date.now() + 30_000);
  await discoverRunningTaskThreads(f.bb, f.store);
  expect(running()).toBe(1);
  await f.harness.emitThreadEvent("thread.created", { thread: f.thread });
  await discoverRunningTaskThreads(f.bb, f.store);
  expect(running()).toBe(2);
  await new Promise((resolve) => setTimeout(resolve, 10)); // let the background refresh settle
  let release!: (value: { id: string; hostId: null }[]) => void;
  f.harness.sdk.stub("threads.listRunning", () => new Promise((resolve) => { release = resolve; }));
  vi.setSystemTime(Date.now() + 61_000);
  await expect(discoverRunningTaskThreads(f.bb, f.store)).resolves.toBe(true); // not blocked on the pending refresh
  release([]);
});

it("retries a failed discovery after 10 s instead of serving it for a minute", async () => {
  const f = setup();
  vi.useFakeTimers({ toFake: ["Date"] });
  f.harness.sdk.stub("threads.listRunning", async () => { throw new Error("offline"); });
  expect(await discoverRunningTaskThreads(f.bb, f.store)).toBe(false);
  expect(await discoverRunningTaskThreads(f.bb, f.store)).toBe(false);
  expect(f.harness.sdk.callsTo("threads.listRunning")).toHaveLength(1);
  f.harness.sdk.stub("threads.listRunning", async () => []);
  vi.setSystemTime(Date.now() + 10_001);
  expect(await discoverRunningTaskThreads(f.bb, f.store)).toBe(true);
});

it("measures SDK calls for 60 card-meta polls spaced 5 s apart", async () => {
  const f = setup();
  vi.useFakeTimers({ toFake: ["Date"] });
  for (let i = 0; i < 60; i++) { await f.meta(); vi.setSystemTime(Date.now() + 5_000); }
  await vi.waitFor(() => expect(f.harness.sdk.callsTo("threads.listRunning").length).toBeGreaterThan(0));
  const scans = f.harness.sdk.callsTo("threads.listRunning").length;
  expect(scans).toBe(5); // was 30 with the 10 s window

});

it("batches running ids in groups of 200 without scanning project history", async () => {
  const f = setup();
  const ids = Array.from({ length: 201 }, (_, i) => `thr_${i}`);
  f.thread.id = ids[200]!;
  f.harness.sdk.stub("threads.listRunning", async () => ids.map((id) => ({ id, hostId: null })));
  await discoverRunningTaskThreads(f.bb, f.store);
  expect(f.harness.sdk.callsTo("threads.list")).toHaveLength(2);
  expect(f.harness.sdk.callsTo("threads.list")[1]).toMatchObject([{ threadIds: [f.thread.id], limit: 1 }]);
  expect(f.store.tasks.listTaskThreads(f.task.id)).toHaveLength(1);
});

it("keeps existing activity available when discovery is offline", async () => {
  const f = setup();
  attachNamedTaskThread(f.bb, f.store, f.thread);
  f.harness.sdk.stub("threads.listRunning", async () => { throw new Error("offline"); });
  expect((await f.meta()).activity?.state).toBe("working");
});

it("does not report an orphaned task as Abandoned when discovery is unavailable", async () => {
  const f = setup();
  f.store.tasks.createComment({ taskId: f.task.id, kind: "agent", threadId: f.thread.id, authorName: "Scout", body: "Research in progress" });
  f.harness.sdk.stub("threads.listRunning", async () => { throw new Error("offline"); });
  expect((await f.meta()).activity).toMatchObject({ state: null, diagnostics: { complete: false, hasWorked: true } });
});

it("includes the discovered link and its explanation on the first CLI show", async () => {
  const f = setup();
  registerTasksCli(f.bb, f.store, { name: "Work Board", version: "test" });
  const result = await f.harness.runCli(["show", f.task.key, "--json"]);
  expect(result, result.stderr).toMatchObject({ exitCode: 0 });
  expect(JSON.parse(result.stdout)).toMatchObject({
    activity: { state: "working" },
    taskThreads: [{ threadId: f.thread.id }],
    comments: [{ body: expect.stringContaining("automatic: title references") }],
  });
});
