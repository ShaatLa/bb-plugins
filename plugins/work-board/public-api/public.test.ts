import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createTasksStore } from "../db";
import { THREAD_BOARD_COLUMN_CARDS, threadBoard, threadTasks } from ".";

describe("public threadTasks", () => {
  it("lists tasks linked to the thread with status names and links", () => {
    const { bb } = createFakePluginHost({ pluginId: "work-board" });
    const store = createTasksStore(bb.storage.database());
    const project = store.createProject({ name: "Plugin", prefix: "PLUG", color: "blue" });
    const a = store.createTask({ projectId: project.id, title: "First" });
    const b = store.createTask({ projectId: project.id, title: "Second" });
    store.createTask({ projectId: project.id, title: "Unlinked" });
    store.upsertTaskThread({ taskId: a.id, threadId: "thr_x", presetName: "Attached", title: "X", liveStatus: "idle" });
    store.upsertTaskThread({ taskId: b.id, threadId: "thr_x", presetName: "Parent thread", title: "X", liveStatus: "idle" });
    store.upsertTaskThread({ taskId: b.id, threadId: "thr_other", presetName: "Attached", title: "O", liveStatus: "idle" });

    const { tasks } = threadTasks(store, "thr_x");
    expect(tasks.map((t) => t.key).sort()).toEqual([a.key, b.key].sort());
    expect(tasks.find((t) => t.key === a.key)).toMatchObject({
      title: "First", status: { id: a.status, name: expect.any(String), iconName: `work-board/status-${a.status}`, cssColor: "var(--subtle-foreground)" }, projectName: "Plugin",
      archived: false, linkName: "Attached", url: `/plugins/work-board/work-board/task/${a.key}`,
    });
    expect(threadTasks(store, "thr_none").tasks).toEqual([]);
  });

  it("follows workflow icon and color overrides", () => {
    const { bb } = createFakePluginHost({ pluginId: "work-board" });
    const store = createTasksStore(bb.storage.database());
    const project = store.createProject({ name: "P", prefix: "PP", color: "blue" });
    const statuses = [
      { id: "backlog", name: "Backlog" }, { id: "todo", name: "Todo", icon: "clock" as const, color: "indianred" as const },
      { id: "in_progress", name: "In Progress" }, { id: "in_review", name: "In Review" },
      { id: "done", name: "Done" }, { id: "canceled", name: "Canceled" },
    ];
    store.updateProject(project.id, { statuses });
    const task = store.createTask({ projectId: project.id, title: "T", status: "todo" });
    store.upsertTaskThread({ taskId: task.id, threadId: "thr_y", presetName: "Attached", title: "Y", liveStatus: "idle" });
    expect(threadTasks(store, "thr_y").tasks[0]?.status).toMatchObject({ iconName: "work-board/status-clock", cssColor: "indianred" });
  });
});

describe("public threadBoard", () => {
  it("returns the linked project's columns in workflow order and marks the thread's own cards", () => {
    const { bb } = createFakePluginHost({ pluginId: "work-board" });
    const store = createTasksStore(bb.storage.database());
    const project = store.createProject({ name: "Board", prefix: "BRD", color: "blue" });
    store.updateProject(project.id, { linkedBbProjectId: "proj_example" });
    store.createProject({ name: "Other", prefix: "OTH", color: "blue" });
    const first = store.createTask({ projectId: project.id, title: "First", status: "todo" });
    const mine = store.createTask({ projectId: project.id, title: "Mine", status: "todo" });
    store.createTask({ projectId: project.id, title: "Child", status: "todo", parentTaskId: first.id });
    const archived = store.createTask({ projectId: project.id, title: "Archived", status: "done" });
    store.setTaskArchived(archived.id, true);
    store.upsertTaskThread({ taskId: mine.id, threadId: "thr_example", presetName: "Attached", title: "X", liveStatus: "idle" });

    const board = threadBoard(store, "thr_example", "proj_example");
    expect(board.project).toEqual({ id: project.id, name: "Board", url: `/plugins/work-board/work-board/${project.id}?view=board` });
    expect(board.columns.map((column) => column.status.id)).toEqual(["backlog", "todo", "in_progress", "in_review", "done", "canceled"]);
    const todo = board.columns[1]!;
    expect(todo.total).toBe(2);
    expect(todo.status).toMatchObject({ name: "Todo", iconName: expect.stringMatching(/^work-board\/status-/), cssColor: expect.any(String) });
    expect(todo.cards).toEqual([
      expect.objectContaining({ key: first.key, title: "First", mine: false, url: `/plugins/work-board/work-board/task/${first.key}` }),
      expect.objectContaining({ key: mine.key, mine: true }),
    ]);
    expect(board.columns[4]!.total).toBe(0);
    expect(threadBoard(store, "thr_example", "proj_unlinked")).toEqual({ project: null, columns: [] });
    expect(threadBoard(store, "thr_example", null)).toEqual({ project: null, columns: [] });
  });

  it("caps each column but keeps the thread's own cards", () => {
    const { bb } = createFakePluginHost({ pluginId: "work-board" });
    const store = createTasksStore(bb.storage.database());
    const project = store.createProject({ name: "Big", prefix: "BIG", color: "blue" });
    store.updateProject(project.id, { linkedBbProjectId: "proj_example" });
    const tasks = Array.from({ length: THREAD_BOARD_COLUMN_CARDS + 5 }, (_, i) => store.createTask({ projectId: project.id, title: `T${i}`, status: "backlog" }));
    store.upsertTaskThread({ taskId: tasks.at(-1)!.id, threadId: "thr_example", presetName: "Attached", title: "X", liveStatus: "idle" });
    const backlog = threadBoard(store, "thr_example", "proj_example").columns[0]!;
    expect(backlog.total).toBe(THREAD_BOARD_COLUMN_CARDS + 5);
    expect(backlog.cards).toHaveLength(THREAD_BOARD_COLUMN_CARDS + 1);
    expect(backlog.cards.at(-1)).toMatchObject({ key: tasks.at(-1)!.key, mine: true });
  });
});
