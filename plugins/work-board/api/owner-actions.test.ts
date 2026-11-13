import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  type FakePluginHarness,
} from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from ".";
import { createTasksStore } from "../db";
import { registerDelegation } from "../delegate";
import { registerTasksCli } from "../cli";
import { tasksRpcContract } from "../shared/contract";

const harnesses: FakePluginHarness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.dispose()));
});
function setup(failSend = false, archived = false) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "work-board",
    sdk: {
      threads: {
        get: async ({ threadId }) =>
          makeThreadResponse({
            id: threadId,
            status: "active",
            archivedAt: archived ? 1 : null,
          }),
        send: async () => {
          if (failSend) throw new Error("Offline");
        },
      },
    },
  });
  harnesses.push(harness);
  const store = createStore(bb);
  registerTasksApi(bb, store);
  registerDelegation(bb, store);
  registerTasksCli(bb, store, { name: "Work Board", version: "test" });
  const project = store.tasks.createProject({
    name: "Owner work",
    prefix: "OWN",
    color: "blue",
    linkedBbProjectId: "proj_owner",
  });
  const task = store.tasks.createTask({
    projectId: project.id,
    title: "Grant registry access",
    description: "Owner must grant access. Done when a test pull succeeds.",
    });
  return { bb, harness, store, project, task };
}

describe("executor removal", () => {
  it("migrates the previous schema with data and does not create questions", () => {
    const { bb, store, task } = setup();
    const db = bb.storage.database();
    const child = store.tasks.createTask({ projectId: task.projectId, title: "Preserve child", parentTaskId: task.id });
    const comment = store.tasks.createComment({ taskId: task.id, body: "Keep context", kind: "agent", authorName: "Agent" });
    db.exec("ALTER TABLE tasks ADD COLUMN execution_target TEXT NOT NULL DEFAULT 'agent' CHECK (execution_target IN ('agent','owner')); ALTER TABLE tasks ADD COLUMN requester_thread_id TEXT CHECK (requester_thread_id IS NULL OR requester_thread_id GLOB 'thr_*'); DELETE FROM schema_version WHERE version=30;");
    db.prepare("UPDATE tasks SET execution_target='owner', requester_thread_id='thr_old' WHERE id=?").run(task.id);
    const migrated = createTasksStore(db);
    expect(migrated.getTask(task.id)).toEqual(task);
    expect(migrated.getTask(child.id)).toEqual(child);
    expect(migrated.getComment(comment.id)).toEqual(comment);
    expect(db.prepare("PRAGMA table_info(tasks)").all().map((row: any) => row.name)).not.toContain("execution_target");
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM task_questions").all()).toEqual([]);
    createTasksStore(db);
  });
  it.each([["create", "--title", "Old", "--project", "OWN", "--executor", "owner"], ["update", "OWN-1", "--executor", "agent"], ["list", "--executor", "owner"], ["create", "--title", "Old", "--project", "OWN", "--requester-thread", "thr_old"], ["update", "OWN-1", "--requester-thread", "thr_old"]])("rejects removed flags: %s", async (...args) => {
    const { harness } = setup();
    const result = await harness.runCli(args);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Work Board no longer has executors");
  });
});
