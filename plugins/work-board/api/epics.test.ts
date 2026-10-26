import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createStore, registerTasksApi } from ".";
import { createTasksStore, TaskEpicError } from "../db";
import { tasksRpcContract } from "../shared/contract";
import { registerDelegation } from "../delegate";
import { registerTasksCli } from "../cli";

function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board", sdk: {
    threads: { get: async () => makeThreadResponse({ id: "thr_epic_worker" }), send: async () => {} },
  } });
  const store = createStore(bb);
  registerTasksApi(bb, store);
  const project = store.tasks.createProject({ name: "Epics", prefix: "EP", color: "purple" });
  const epic = store.tasks.createTask({ projectId: project.id, title: "Large initiative", description: "Shared acceptance criteria", type: "epic" });
  return { bb, harness, store, project, epic };
}

describe("epics", () => {
  it("migrates existing tasks without changing their data or parent links", async () => {
    const { bb, harness, store, project } = setup();
    try {
      const parent = store.tasks.createTask({ projectId: project.id, title: "Existing task" });
      const child = store.tasks.createTask({ projectId: project.id, title: "Existing sub-task", parentTaskId: parent.id });
      const db = bb.storage.database();
      db.exec(`DROP INDEX idx_tasks_epic; ALTER TABLE tasks DROP COLUMN epic_id; ALTER TABLE tasks DROP COLUMN type; DELETE FROM schema_version WHERE version = 9;`);
      const migrated = createTasksStore(db);
      expect(migrated.getTask(parent.id)).toEqual(parent);
      expect(migrated.getTask(child.id)).toEqual(child);
      createTasksStore(db);
      expect(migrated.listTasks()).toHaveLength(3);
    } finally { await harness.dispose(); }
  });

  it("creates and filters epics and member tasks through RPC, with independent sub-tasks", async () => {
    const { harness, store, project, epic } = setup();
    try {
      const result = tasksRpcContract.createTask.output.parse(await harness.callRpc("createTask", {
        projectId: project.id, title: "Member", epicId: epic.id,
      }));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.message);
      const child = store.tasks.createTask({ projectId: project.id, title: "Sub-task", parentTaskId: result.task.id });
      expect(child.epicId).toBeNull();
      const epics = tasksRpcContract.listTasks.output.parse(await harness.callRpc("listTasks", { type: "epic" }));
      expect(epics.tasks.map((t) => t.id)).toEqual([epic.id]);
      const members = tasksRpcContract.listTasks.output.parse(await harness.callRpc("listTasks", { epicId: epic.id }));
      expect(members.tasks.map((t) => t.id)).toEqual([result.task.id]);
      expect(store.tasks.listSubtasks(result.task.id).map((t) => t.id)).toEqual([child.id]);
      const page = store.tasks.listTasksPage({ limit: 1 });
      expect(() => store.tasks.listTasksPage({ cursor: page.nextCursor!, type: "epic", limit: 1 })).toThrow("current filters");
    } finally { await harness.dispose(); }
  });

  it("assigns and reassigns an existing task without losing its fields, labels or sub-tasks", async () => {
    const { bb, harness, store, project, epic } = setup();
    try {
      const nextEpic = store.tasks.createTask({ projectId: project.id, title: "Next initiative", type: "epic" });
      const task = store.tasks.createTask({ projectId: project.id, title: "Existing task", description: "Keep the description", priority: "high" });
      const child = store.tasks.createTask({ projectId: project.id, title: "Existing sub-task", parentTaskId: task.id });
      const label = store.tasks.createLabel({ projectId: project.id, name: "Keep label", color: "blue" });
      store.tasks.addTaskLabel(task.id, label.id);
      for (const epicId of [epic.id, nextEpic.id, null]) {
        const result = tasksRpcContract.updateTask.output.parse(await harness.callRpc("updateTask", { taskId: task.id, epicId }));
        expect(result).toMatchObject({ ok: true, task: { key: task.key, description: task.description, priority: "high", epicId, parentTaskId: null, labelIds: [label.id] } });
        const reopened = createTasksStore(bb.storage.database());
        expect(reopened.getTask(task.id)?.epicId).toBe(epicId);
        expect(reopened.getTask(child.id)).toEqual(child);
        expect(reopened.listTasks({ epicId: epic.id })).toHaveLength(epicId === epic.id ? 1 : 0);
        expect(reopened.listTasks({ epicId: nextEpic.id })).toHaveLength(epicId === nextEpic.id ? 1 : 0);
      }
      expect(store.tasks.listComments(task.id).map((comment) => comment.body)).toEqual([
        `Added to epic ${epic.key} by You`,
        `Added to epic ${nextEpic.key} by You`,
        "Removed from epic by You",
      ]);
    } finally { await harness.dispose(); }
  });

  it("rejects invalid epic links and conversions atomically with a domain error", async () => {
    const { harness, store, project, epic } = setup();
    try {
      const otherProject = store.tasks.createProject({ name: "Other", prefix: "OTHER", color: "blue" });
      const foreignEpic = store.tasks.createTask({ projectId: otherProject.id, title: "Other epic", type: "epic" });
      const member = store.tasks.createTask({ projectId: project.id, title: "Member", epicId: epic.id });
      const child = store.tasks.createTask({ projectId: project.id, title: "Sub-task", parentTaskId: member.id });
      for (const update of [
        { taskId: member.id, epicId: member.id },
        { taskId: member.id, epicId: foreignEpic.id },
        { taskId: epic.id, epicId: foreignEpic.id },
        { taskId: epic.id, parentTaskId: member.id },
        { taskId: epic.id, type: "task" },
        { taskId: member.id, epicId: null, type: "epic" },
        { taskId: child.id, epicId: epic.id },
        { taskId: member.id, parentTaskId: epic.id, epicId: null },
      ]) {
        const before = store.tasks.listTasks();
        expect(await harness.callRpc("updateTask", update)).toMatchObject({ ok: false, error: { code: "task_epic_invalid" } });
        expect(store.tasks.listTasks()).toEqual(before);
      }
      expect(() => store.tasks.createTask({ projectId: project.id, title: "Nested", type: "epic", epicId: epic.id })).toThrow(TaskEpicError);
      expect(await harness.callRpc("updateTask", { taskId: child.id, parentTaskId: null, type: "epic" })).toMatchObject({ ok: true, task: { type: "epic", parentTaskId: null } });
    } finally { await harness.dispose(); }
  });

  it("moves an epic with its member tasks and sub-tasks, preserving links and old keys", async () => {
    const { harness, store, project, epic } = setup();
    try {
      const member = store.tasks.createTask({ projectId: project.id, title: "Member", epicId: epic.id });
      const child = store.tasks.createTask({ projectId: project.id, title: "Sub-task", parentTaskId: member.id });
      const target = store.tasks.createProject({ name: "Target", prefix: "NEXT", color: "green" });
      expect(await harness.callRpc("moveTaskToProject", { taskId: epic.id, projectId: target.id })).toMatchObject({ ok: true });
      expect(store.tasks.getTask(member.id)).toMatchObject({ projectId: target.id, epicId: epic.id });
      expect(store.tasks.getTask(child.id)).toMatchObject({ projectId: target.id, parentTaskId: member.id });
      for (const task of [epic, member, child]) {
        expect(store.tasks.getTaskByKey(task.key)?.id).toBe(task.id);
        expect(harness.realtimeSignals).toContainEqual({ channel: "tasks:changed", payload: { taskId: task.id, projectId: project.id } });
        expect(harness.realtimeSignals).toContainEqual({ channel: "tasks:changed", payload: { taskId: task.id, projectId: target.id } });
      }
      expect(store.tasks.listTasks({ projectId: project.id })).toEqual([]);
      store.tasks.moveTaskToProject(member.id, project.id);
      expect(store.tasks.getTask(member.id)?.epicId).toBeNull();
      expect(store.tasks.getTask(child.id)?.parentTaskId).toBe(member.id);
    } finally { await harness.dispose(); }
  });

  it("deletes only the epic, retains tasks and sub-tasks, and signals changed memberships", async () => {
    const { harness, store, project, epic } = setup();
    try {
      const member = store.tasks.createTask({ projectId: project.id, title: "Keep me", epicId: epic.id });
      const child = store.tasks.createTask({ projectId: project.id, title: "Sub-task", parentTaskId: member.id });
      expect(await harness.callRpc("deleteTask", { taskId: epic.id })).toEqual({ deleted: true });
      expect(store.tasks.getTask(member.id)).toMatchObject({ epicId: null, title: "Keep me" });
      expect(store.tasks.getTask(child.id)).toEqual(child);
      expect(harness.realtimeSignals).toContainEqual({ channel: "tasks:changed", payload: { taskId: member.id, projectId: project.id } });
    } finally { await harness.dispose(); }
  });

  it("includes epic goals for tasks and their sub-tasks and members when dispatching an epic", async () => {
    const { bb, harness, store, project, epic } = setup();
    try {
      registerDelegation(bb, store);
      const member = store.tasks.createTask({ projectId: project.id, title: "Member", epicId: epic.id });
      const child = store.tasks.createTask({ projectId: project.id, title: "Sub-task", parentTaskId: member.id });
      for (const task of [member, child, epic]) await harness.callRpc("delegateToThread", { taskId: task.id, threadId: "thr_epic_worker" });
      const sent = harness.sdk.callsTo("threads.send");
      for (const args of sent.slice(0, 2)) expect(JSON.stringify(args)).toContain("Shared acceptance criteria");
      expect(JSON.stringify(sent[2])).toContain("Tasks in epic");
      expect(JSON.stringify(sent[2])).toContain("Member");
    } finally { await harness.dispose(); }
  });

  it("supports epic creation, assignment, filtering, inspection and removal through CLI", async () => {
    const { bb, harness, store, project, epic } = setup();
    try {
      registerTasksCli(bb, store, { name: "Work Board", version: "test" });
      const run = async (...args: string[]) => {
        const result = await harness.runCli(args);
        expect(result, result.stderr).toMatchObject({ exitCode: 0, stderr: "" });
        return JSON.parse(result.stdout);
      };
      const created = await run("create", "--project", "EP", "--title", "CLI epic", "--type", "epic", "--json");
      expect(created.task.type).toBe("epic");
      const newMember = await run("create", "--project", "EP", "--title", "New CLI member", "--epic", created.task.key, "--json");
      expect(newMember.task).toMatchObject({ type: "task", epicId: created.task.id, parentTaskId: null });
      expect((await run("show", created.task.key, "--json")).epicTasks[0].id).toBe(newMember.task.id);
      const member = store.tasks.createTask({ projectId: project.id, title: "Member" });
      await run("update", member.key, "--epic", epic.key, "--json");
      expect((await run("list", "--epic", epic.key, "--json")).tasks.map((t: { id: string }) => t.id)).toEqual([member.id]);
      expect((await run("show", epic.key, "--json")).epicTasks[0].id).toBe(member.id);
      expect((await run("list", "--type", "epic", "--json")).tasks).toHaveLength(2);
      await run("update", member.key, "--no-epic", "--json");
      expect(store.tasks.getTask(member.id)?.epicId).toBeNull();
      await run("update", member.key, "--type", "epic", "--json");
      expect(store.tasks.getTask(member.id)?.type).toBe("epic");
    } finally { await harness.dispose(); }
  });
});
