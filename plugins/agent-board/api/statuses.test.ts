import { afterEach, expect, it } from "vitest";
import {
  createFakePluginHost,
  type FakePluginHarness,
} from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from ".";
import { registerTasksCli } from "../cli";
import { createTasksStore } from "../db";
import { DEFAULT_TASK_STATUSES, taskStatusesSchema } from "../shared/statuses";
import { tasksRpcContract } from "../shared/contract";
import { listTasksOpenFirst } from "../shell/data";

const harnesses: FakePluginHarness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.dispose()));
});
function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "agent-board" });
  harnesses.push(harness);
  const store = createStore(bb);
  registerTasksApi(bb, store);
  registerTasksCli(bb, store, { name: "Agent Board", version: "test" });
  const project = store.tasks.createProject({
    name: "Workflow",
    prefix: "WF",
    color: "blue",
  });
  const other = store.tasks.createProject({
    name: "Other",
    prefix: "OTH",
    color: "blue",
  });
  const statuses = [...DEFAULT_TASK_STATUSES];
  statuses.splice(4, 0, { id: "in_testing", name: "In testing" });
  return { bb, harness, store, project, other, statuses };
}

it("uses project status IDs across API, board moves, CLI filters and open-first reads", async () => {
  const { harness, store, project, other, statuses } = setup();
  await harness.callRpc("updateProject", { projectId: project.id, statuses });
  const created = tasksRpcContract.createTask.output.parse(
    await harness.callRpc("createTask", {
      projectId: project.id,
      title: "Test in QA",
      status: "in_testing",
    }),
  );
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error("Task was not created");
  const task = created.task;
  store.tasks.createTask({
    projectId: project.id,
    title: "Closed",
    status: "done",
  });
  expect(store.tasks.getProject(other.id)?.statuses).toEqual(
    DEFAULT_TASK_STATUSES,
  );
  expect(() =>
    store.tasks.createTask({
      projectId: other.id,
      title: "Invalid",
      status: "in_testing",
    }),
  ).toThrow(/Unknown task status/);
  const included = await harness.runCli([
    "list",
    "--project",
    "WF",
    "--status",
    "in_testing",
    "--json",
  ]);
  expect(included.exitCode, included.stderr).toBe(0);
  expect(
    JSON.parse(included.stdout).tasks.map((entry: { id: string }) => entry.id),
  ).toEqual([task.id]);
  const excluded = await harness.runCli([
    "list",
    "--project",
    "WF",
    "--exclude-status",
    "done",
    "--json",
  ]);
  expect(excluded.exitCode, excluded.stderr).toBe(0);
  expect(
    JSON.parse(excluded.stdout).tasks.map((entry: { id: string }) => entry.id),
  ).toEqual([task.id]);
  const newTask = await harness.runCli([
    "create",
    "--project",
    "WF",
    "--title",
    "CLI testing",
    "--status",
    "in_testing",
    "--json",
  ]);
  expect(newTask.exitCode, newTask.stderr).toBe(0);
  expect(JSON.parse(newTask.stdout).task.status).toBe("in_testing");
  const rpc = {
    call: (method: string, input: unknown) => harness.callRpc(method, input),
  } as Parameters<typeof listTasksOpenFirst>[0];
  let first: string[] = [];
  const all = await listTasksOpenFirst(
    rpc,
    { projectId: project.id },
    (tasks) => {
      first = tasks.map((entry) => entry.status);
    },
  );
  expect(first).toEqual(["in_testing", "in_testing"]);
  expect(all).toHaveLength(3);
  const moved = tasksRpcContract.boardMove.output.parse(
    await harness.callRpc("boardMove", { taskId: task.id, status: "todo" }),
  );
  expect(moved.ok).toBe(true);
  await harness.callRpc("boardMove", { taskId: task.id, status: "in_testing" });
  expect(store.tasks.getTask(task.id)?.status).toBe("in_testing");
});

it("guards status removal, immutable IDs, pagination and cross-project moves without partial writes", async () => {
  const { store, project, other, statuses } = setup();
  store.tasks.updateProject(project.id, { statuses });
  const epic = store.tasks.createTask({
    projectId: project.id,
    title: "Epic",
    type: "epic",
  });
  const child = store.tasks.createTask({
    projectId: project.id,
    title: "Testing",
    epicId: epic.id,
    status: "in_testing",
  });
  expect(() =>
    store.tasks.updateProject(project.id, { statuses: DEFAULT_TASK_STATUSES }),
  ).toThrow(/used by tasks/);
  const before = store.tasks.getProject(other.id);
  expect(() => store.tasks.moveTaskToProject(epic.id, other.id)).toThrow(
    /Unknown task status/,
  );
  expect(store.tasks.getProject(other.id)).toEqual(before);
  expect(store.tasks.getTask(epic.id)?.projectId).toBe(project.id);
  expect(store.tasks.getTask(child.id)?.projectId).toBe(project.id);
  const renamed = statuses
    .map((status) =>
      status.id === "in_testing"
        ? { ...status, name: "QA validation" }
        : status,
    )
    .reverse();
  store.tasks.updateProject(project.id, { statuses: renamed });
  expect(store.tasks.getTask(child.id)?.status).toBe("in_testing");
  expect(
    taskStatusesSchema.safeParse(
      statuses.filter((status) => status.id !== "done"),
    ).success,
  ).toBe(false);
  expect(
    taskStatusesSchema.safeParse([
      ...statuses,
      { id: "in_testing", name: "Duplicate" },
    ]).success,
  ).toBe(false);
  expect(
    taskStatusesSchema.safeParse([
      ...statuses,
      { id: "INVALID", name: "Invalid" },
    ]).success,
  ).toBe(false);
  const page = store.tasks.listTasksPage({
    projectId: project.id,
    excludeStatuses: ["done"],
    limit: 1,
  });
  expect(page.nextCursor).toBeTruthy();
  expect(() =>
    store.tasks.listTasksPage({
      projectId: project.id,
      excludeStatuses: ["done", "canceled"],
      limit: 1,
      cursor: page.nextCursor!,
    }),
  ).toThrow(/cursor/i);
  store.tasks.updateTask(child.id, { status: "todo" });
  store.tasks.updateProject(project.id, { statuses: DEFAULT_TASK_STATUSES });
  expect(() =>
    store.tasks.updateTask(child.id, { status: "in_testing" }),
  ).toThrow(/Unknown task status/);
});

it("rebuilds the legacy status constraint without dropping task relationships, indexes or triggers", () => {
  const { bb, store, project } = setup();
  const parent = store.tasks.createTask({
    projectId: project.id,
    title: "Existing",
  });
  const child = store.tasks.createTask({
    projectId: project.id,
    title: "Child",
    parentTaskId: parent.id,
  });
  const comment = store.tasks.createComment({
    taskId: parent.id,
    kind: "user",
    authorName: "Owner",
    body: "Keep this",
  });
  store.tasks.upsertTaskThread({
    taskId: parent.id,
    threadId: "thr_keep",
    presetName: "Manual",
    title: "Keep",
    liveStatus: "idle",
  });
  const db = bb.storage.database();
  const objects = db
    .prepare<
      [],
      { name: string; sql: string }
    >("SELECT name, sql FROM sqlite_master WHERE tbl_name = 'tasks' AND type IN ('index', 'trigger') AND sql IS NOT NULL")
    .all();
  const table = db
    .prepare<
      [],
      { sql: string }
    >("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'")
    .get()!.sql;
  db.pragma("foreign_keys = OFF");
  db.exec(
    "CREATE TEMP TABLE old_tasks AS SELECT * FROM tasks; DROP TABLE tasks",
  );
  db.exec(
    table.replace(
      "CHECK (length(status) BETWEEN 1 AND 64)",
      "CHECK (status IN ('backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled'))",
    ),
  );
  db.exec("INSERT INTO tasks SELECT * FROM old_tasks; DROP TABLE old_tasks");
  for (const object of objects) db.exec(object.sql);
  db.exec(
    "ALTER TABLE projects DROP COLUMN statuses; DELETE FROM schema_version WHERE version = 12",
  );
  db.pragma("foreign_keys = ON");
  const migrated = createTasksStore(db);
  expect(migrated.getTask(child.id)?.parentTaskId).toBe(parent.id);
  expect(migrated.getComment(comment.id)?.body).toBe("Keep this");
  expect(migrated.listTaskThreads(parent.id)[0]?.threadId).toBe("thr_keep");
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(
    db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE tbl_name = 'tasks' AND type IN ('index', 'trigger') AND sql IS NOT NULL",
      )
      .all()
      .map((row) => row.name)
      .sort(),
  ).toEqual(objects.map((row) => row.name).sort());
  const before = db
    .prepare<
      [],
      { revision: number }
    >("SELECT revision FROM task_list_revision")
    .get()!.revision;
  migrated.updateTask(parent.id, { title: "Still editable" });
  expect(
    db
      .prepare<
        [],
        { revision: number }
      >("SELECT revision FROM task_list_revision")
      .get()!.revision,
  ).toBeGreaterThan(before);
});
