import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  type FakePluginHarness,
} from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from "../api";
import { tasksRpcContract } from "../shared/contract";
import { rpcInput } from "../test-fixtures.js";
import { fetchBoard, patchBoard, pollBoardMetadata, syncBoardMetadata } from "../views/board/board-data.js";
import { listTasksQuery } from "../views/list/data.js";
import { listAllTasks, patchTasks, type TasksRpc } from "./data.js";
import { signalTaskIds, type TaskSignal } from "./signal-scheduler.js";

const harnesses: FakePluginHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
});

function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  harnesses.push(harness);
  const store = createStore(bb);
  registerTasksApi(bb, store);
  const project = store.tasks.createProject({
    name: "Review",
    prefix: "REV",
    color: "blue",
  });
  const calls: { method: string; input: unknown }[] = [];
  const rpc: TasksRpc = {
    async call(method, ...args) {
      const input = args[0];
      calls.push({ method, input });
      return tasksRpcContract[method].output.parse(
        await harness.callRpc(method, input),
      );
    },
  };
  const callsTo = (method: string) =>
    calls
      .filter((call) => call.method === method)
      .map((call) => rpcInput(call.input).taskIds ?? rpcInput(call.input).taskId);
  const resetCalls = () => {
    calls.length = 0;
  };
  const taskSignals = (): TaskSignal[] =>
    harness.realtimeSignals.map((signal) => ({
      channel: "tasks:changed",
      taskId: String(rpcInput(signal.payload).taskId),
    }));
  return { harness, store, project, rpc, callsTo, resetCalls, taskSignals };
}

describe("patchTasks", () => {
  it("re-reads only the changed row instead of refetching the list", async () => {
    const { store, project, rpc, callsTo, resetCalls } = setup();
    const first = store.tasks.createTask({
      projectId: project.id,
      title: "First",
    });
    const second = store.tasks.createTask({
      projectId: project.id,
      title: "Second",
    });
    const current = await listAllTasks(rpc, { projectId: project.id });
    resetCalls();

    store.tasks.updateTask(first.id, { title: "First renamed" });
    const next = await patchTasks(rpc, current, [first.id], () => true);

    expect(next!.map((task) => [task.id, task.title])).toEqual([
      [first.id, "First renamed"],
      [second.id, "Second"],
    ]);
    expect(callsTo("getTask")).toEqual([first.id]);
    expect(callsTo("listTasks")).toEqual([]);
  });

  it("drops a deleted task without a refetch", async () => {
    const { store, project, rpc, callsTo, resetCalls } = setup();
    const first = store.tasks.createTask({
      projectId: project.id,
      title: "First",
    });
    const second = store.tasks.createTask({
      projectId: project.id,
      title: "Second",
    });
    const current = await listAllTasks(rpc, { projectId: project.id });
    resetCalls();

    store.tasks.deleteTask(second.id);
    const next = await patchTasks(rpc, current, [second.id], () => true);

    expect(next!.map((task) => task.id)).toEqual([first.id]);
    expect(callsTo("listTasks")).toEqual([]);
  });

  it("adds subtasks promoted by deleting their parent", async () => {
    const { harness, store, project, rpc, taskSignals } = setup();
    const parent = store.tasks.createTask({
      projectId: project.id,
      title: "Parent task",
    });
    const child = store.tasks.createTask({
      projectId: project.id,
      title: "Former child",
      parentTaskId: parent.id,
    });
    const current = await listAllTasks(rpc, {
      projectId: project.id,
      parentTaskId: null,
    });

    await harness.callRpc("deleteTask", { taskId: parent.id });
    const next = await patchTasks(
      rpc,
      current,
      signalTaskIds(taskSignals(), "tasks:changed"),
      (task) => task.parentTaskId === null,
    );

    expect(next!.map((task) => task.id)).toEqual([child.id]);
  });

  it("falls back to one dataset refetch for a 150-task event", async () => {
    const { rpc, callsTo } = setup();
    const ids = Array.from({ length: 150 }, (_, index) => `task-${index}`);
    expect(await patchTasks(rpc, [], ids, () => true)).toBeNull();
    expect(callsTo("getTask")).toHaveLength(0);
  });

  it("shares an in-flight task read across two patches", async () => {
    const { store, project, rpc, callsTo } = setup();
    const task = store.tasks.createTask({ projectId: project.id, title: "Shared" });
    const [first, second] = await Promise.all([
      patchTasks(rpc, [], [task.id], () => true),
      patchTasks(rpc, [], [task.id], () => true),
    ]);
    expect(first).toEqual(second);
    expect(callsTo("getTask")).toHaveLength(1);
  });
});

describe("patchBoard", () => {
  it("loads 250 cards with three RPCs and one shared thread list", async () => {
    const { store, project, rpc, callsTo, harness } = setup();
    const tasks = Array.from({ length: 250 }, (_, index) => store.tasks.createTask({ projectId: project.id, title: `Card ${index}` }));
    store.tasks.upsertTaskThread({ taskId: tasks[0]!.id, threadId: "thr_cached", presetName: "Attached", title: "Cached worker", liveStatus: "working" });
    store.tasks.createAttachment({ taskId: tasks[0]!.id, fileName: "note.txt", mime: "text/plain", sizeBytes: 1, blobPath: "blobs/note.txt", isImage: false });
    const board = await fetchBoard(rpc, project.id);
    expect(board.tasks).toHaveLength(250);
    expect(board.metaByTaskId.get(tasks[0]!.id)).toMatchObject({ attachmentCount: 1, workingThreads: [{ title: "Cached worker" }] });
    expect(board.metaByTaskId.get(tasks[1]!.id)).toMatchObject({ attachmentCount: 0, workingThreads: [] });
    expect(callsTo("listTasks")).toHaveLength(1);
    expect(callsTo("listLabels")).toHaveLength(1);
    expect(callsTo("listTaskCardMeta")).toHaveLength(1);
    expect(callsTo("listAttachments")).toHaveLength(0);
    expect(callsTo("listTaskThreads")).toHaveLength(0);
    expect(harness.sdk.calls.map((call) => call.path)).toEqual(["threads.list"]);
  });

  it("shows subtasks promoted by deleting their parent as cards", async () => {
    const { harness, store, project, rpc, taskSignals } = setup();
    const parent = store.tasks.createTask({
      projectId: project.id,
      title: "Parent task",
    });
    const child = store.tasks.createTask({
      projectId: project.id,
      title: "Former child",
      parentTaskId: parent.id,
    });
    const current = await fetchBoard(rpc, project.id);
    expect(current.tasks.map((task) => task.id)).toEqual([parent.id]);

    await harness.callRpc("deleteTask", { taskId: parent.id });
    const next = await patchBoard(rpc, project.id, current, taskSignals());

    expect(next?.tasks.map((task) => task.id)).toEqual([child.id]);
    expect(next?.subtasks).toEqual([]);
  });

  it("re-reads only the changed card", async () => {
    const { store, project, rpc, callsTo, resetCalls } = setup();
    const first = store.tasks.createTask({
      projectId: project.id,
      title: "First",
      status: "todo",
    });
    store.tasks.createTask({
      projectId: project.id,
      title: "Second",
      status: "done",
    });
    const current = await fetchBoard(rpc, project.id);
    resetCalls();

    store.tasks.updateTask(first.id, { status: "in_review" });
    const next = await patchBoard(rpc, project.id, current, [
      { channel: "tasks:changed", taskId: first.id },
    ]);

    expect(next?.tasks.find((task) => task.id === first.id)?.status).toBe(
      "in_review",
    );
    expect(callsTo("getTask")).toEqual([first.id]);
    expect(callsTo("listTaskCardMeta")).toEqual([[first.id]]);
    expect(callsTo("listAttachments")).toEqual([]);
    expect(callsTo("listTasks")).toEqual([]);
  });

  it("ignores thread signals for tasks outside the board", async () => {
    const { store, project, rpc, callsTo, resetCalls } = setup();
    store.tasks.createTask({ projectId: project.id, title: "First" });
    const current = await fetchBoard(rpc, project.id);
    resetCalls();

    const next = await patchBoard(rpc, project.id, current, [
      { channel: "threads:changed", taskId: "01HZZZZZZZZZZZZZZZZZZZZOTHER" },
    ]);

    expect(next?.tasks).toEqual(current.tasks);
    expect(callsTo("getTask")).toEqual([]);
    expect(callsTo("listTaskThreads")).toEqual([]);
    expect(callsTo("listTasks")).toEqual([]);
  });

  it("keeps the board object for thread-only signals handled by metadata", async () => {
    const { store, project, rpc, callsTo, resetCalls } = setup();
    const task = store.tasks.createTask({ projectId: project.id, title: "Worker" });
    const current = await fetchBoard(rpc, project.id);
    resetCalls();
    expect(await patchBoard(rpc, project.id, current, [{ channel: "threads:changed", taskId: task.id }], false)).toBe(current);
    expect(callsTo("getTask")).toHaveLength(0);
    expect(callsTo("listTaskCardMeta")).toHaveLength(0);
  });

  it("falls back for a 150-card event without per-card reads", async () => {
    const { project, rpc, callsTo } = setup();
    const current = await fetchBoard(rpc, project.id);
    const signals = Array.from({ length: 150 }, (_, index) => ({ channel: "tasks:changed" as const, taskId: `task-${index}` }));
    expect(await patchBoard(rpc, project.id, current, signals)).toBeNull();
    expect(callsTo("getTask")).toHaveLength(0);
  });

  it("polls only the live card and keeps unchanged metadata by reference", async () => {
    const { store, project, rpc, callsTo, resetCalls } = setup();
    const active = store.tasks.createTask({ projectId: project.id, title: "Active" });
    const idle = store.tasks.createTask({ projectId: project.id, title: "Idle" });
    store.tasks.upsertTaskThread({ taskId: active.id, threadId: "thr_active", title: "Worker", presetName: "Attached", liveStatus: "working" });
    const initial = (await rpc.call("listTaskCardMeta", { taskIds: [active.id, idle.id] })).metadata;
    resetCalls();
    const quiet = initial.filter((row) => row.taskId === idle.id);
    expect(await pollBoardMetadata(rpc, quiet)).toBe(quiet);
    expect(callsTo("listTaskCardMeta")).toHaveLength(0);
    for (let tick = 0; tick < 3; tick++) expect(await pollBoardMetadata(rpc, initial)).toBe(initial);
    expect(callsTo("listTaskCardMeta")).toEqual([[active.id], [active.id], [active.id]]);
    store.tasks.upsertTaskThread({ taskId: active.id, threadId: "thr_active", title: "Worker", presetName: "Attached", liveStatus: "idle" });
    resetCalls();
    const changed = await pollBoardMetadata(rpc, initial);
    expect(changed).not.toBe(initial);
    expect(changed.find((row) => row.taskId === idle.id)).toBe(initial.find((row) => row.taskId === idle.id));
    resetCalls();
    expect(await pollBoardMetadata(rpc, changed)).toBe(changed);
    expect(callsTo("listTaskCardMeta")).toEqual([[active.id]]);
  });

  it("reads only a newly added card and removes archived metadata", async () => {
    const { store, project, rpc, callsTo, resetCalls } = setup();
    const existing = store.tasks.createTask({ projectId: project.id, title: "Existing" });
    const current = (await rpc.call("listTaskCardMeta", { taskIds: [existing.id] })).metadata;
    const added = store.tasks.createTask({ projectId: project.id, title: "Added" });
    resetCalls();
    const next = await syncBoardMetadata(rpc, current, [existing.id, added.id]);
    expect(next.map((row) => row.taskId)).toEqual([existing.id, added.id]);
    expect(callsTo("listTaskCardMeta")).toEqual([[added.id]]);
    resetCalls();
    expect((await syncBoardMetadata(rpc, next, [added.id])).map((row) => row.taskId)).toEqual([added.id]);
    expect(callsTo("listTaskCardMeta")).toHaveLength(0);
  });
});

describe("listTasksQuery", () => {
  it("finds a working task in Active without an explicit status filter", async () => {
    const { store, project, rpc } = setup();
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Currently working",
      status: "todo",
    });
    store.tasks.upsertTaskThread({
      taskId: task.id,
      threadId: "thr_review",
      presetName: "Default",
      title: "Worker",
      liveStatus: "working",
    });

    const tasks = await listAllTasks(
      rpc,
      listTasksQuery(null, true, {
        statuses: [],
        priorities: [],
        labelIds: null,
      }),
    );

    expect(tasks.map((entry) => entry.title)).toEqual(["Currently working"]);
  });
});

it("counts epic tasks separately from their sub-tasks and updates progress incrementally", async () => {
  const { store, project, rpc } = setup();
  const epic = store.tasks.createTask({ projectId: project.id, title: "Epic", type: "epic" });
  const member = store.tasks.createTask({ projectId: project.id, title: "Member", epicId: epic.id });
  store.tasks.createTask({ projectId: project.id, title: "Sub-task", parentTaskId: member.id, status: "done" });
  const board = await fetchBoard(rpc, project.id);
  expect(board.metaByTaskId.get(epic.id)).toMatchObject({ subDone: 0, subTotal: 1 });
  expect(board.metaByTaskId.get(member.id)).toMatchObject({ subDone: 1, subTotal: 1 });
  store.tasks.updateTask(member.id, { status: "done" });
  const updated = await patchBoard(rpc, project.id, board, [{ channel: "tasks:changed", taskId: member.id }]);
  expect(updated?.metaByTaskId.get(epic.id)).toMatchObject({ subDone: 1, subTotal: 1 });
  store.tasks.updateTask(member.id, { epicId: null });
  const removed = await patchBoard(rpc, project.id, updated!, [{ channel: "tasks:changed", taskId: member.id }]);
  expect(removed?.metaByTaskId.get(epic.id)).toMatchObject({ subDone: 0, subTotal: 0 });
});

it("continues a live UI dataset across worker revision changes while default cursors remain strict", async () => {
  const { loadTaskDataset } = await import("./task-dataset");
  const { store, project, rpc } = setup();
  const tasks = store.transaction(() => Array.from({ length: 600 }, (_, index) => store.tasks.createTask({ projectId: project.id, title: `Row ${index}` })));
  let changed = false;
  const changingRpc: TasksRpc = { async call(method, ...args) {
    const result = await rpc.call(method, ...args);
    if (method === "listTasks" && !changed) {
      changed = true;
      store.tasks.upsertTaskThread({ taskId: tasks[0]!.id, threadId: "thr_busy", title: "Busy", presetName: "Attached", liveStatus: "working" });
    }
    return result;
  } };
  const data = await loadTaskDataset(changingRpc, project.id);
  expect(data).toHaveLength(600);
  expect(new Set(data.map((task) => task.id)).size).toBe(600);
  const page = store.tasks.listTasksPage({ projectId: project.id, limit: 1 });
  store.tasks.updateTask(tasks[0]!.id, { title: "Changed again" });
  expect(() => store.tasks.listTasksPage({ projectId: project.id, limit: 1, cursor: page.nextCursor! })).toThrow(/changed after this cursor/);
});

it("clears previous activity when refreshed metadata has no activity", async () => {
  const { store, project, rpc } = setup();
  const task = store.tasks.createTask({ projectId: project.id, title: "Refresh activity" });
  const current = await fetchBoard(rpc, project.id);
  current.metaByTaskId.set(task.id, { ...current.metaByTaskId.get(task.id)!, activity: {
    state: "working", workingCount: 1, attachedCount: 1, sessions: [], terminalWarning: false, hasFailure: false,
  } });
  const next = await patchBoard(rpc, project.id, current, [{ channel: "threads:changed", taskId: task.id }]);
  expect(next?.metaByTaskId.get(task.id)?.activity?.state).not.toBe("working");
});
