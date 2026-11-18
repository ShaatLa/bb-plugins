import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createTasksStore } from "../db";
import { threadTasks } from ".";

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
