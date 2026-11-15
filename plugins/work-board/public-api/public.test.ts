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
      title: "First", status: { id: a.status, name: expect.any(String) }, projectName: "Plugin",
      archived: false, linkName: "Attached", url: `/plugins/work-board/work-board/task/${a.key}`,
    });
    expect(threadTasks(store, "thr_none").tasks).toEqual([]);
  });
});
