import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it } from "vitest";
import { createStore, registerTasksApi } from ".";
import { registerTasksCli } from "../cli";
import { handlers } from "../delegate";
import {
  captureProject,
  archiveRecords,
  restoreProject,
} from "../archive/storage";
import { validateArchive } from "../archive/contract";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.harness.dispose()));
});
function setup() {
  const host = createFakePluginHost({ pluginId: "tasks-plus" });
  hosts.push(host);
  const store = createStore(host.bb);
  registerTasksApi(host.bb, store);
  const project = store.tasks.createProject({
    name: "Archive",
    prefix: "ARC",
    color: "blue",
  });
  const done = store.tasks.createTask({
    projectId: project.id,
    title: "Completed work",
    status: "done",
  });
  const open = store.tasks.createTask({
    projectId: project.id,
    title: "Still working",
    status: "in_progress",
  });
  return { ...host, store, project, done, open };
}

it("archives completed families atomically, hides them by default and restores their data", async () => {
  const f = setup();
  const child = f.store.tasks.createTask({
    projectId: f.project.id,
    parentTaskId: f.done.id,
    title: "Completed child",
    status: "canceled",
  });
  f.store.tasks.createComment({
    taskId: child.id,
    kind: "user",
    authorName: "Owner",
    body: "Keep this history",
  });
  await f.harness.callRpc("archiveTask", { taskId: f.done.id, archived: true });
  expect(f.store.tasks.getTask(child.id)?.archivedAt).toBe(
    f.store.tasks.getTask(f.done.id)?.archivedAt,
  );
  expect(
    await f.harness.callRpc("listTasks", { projectId: f.project.id }),
  ).toMatchObject({ tasks: [{ id: f.open.id }] });
  const archived = (await f.harness.callRpc("listTasks", {
    projectId: f.project.id,
    archive: "archived",
  })) as { tasks: { id: string }[] };
  expect(archived.tasks.map((task) => task.id)).toEqual(
    expect.arrayContaining([f.done.id, child.id]),
  );
  expect(f.store.sidebarSummary()[0]?.taskCount).toBe(1);
  await expect(
    f.harness.callRpc("archiveTask", { taskId: child.id, archived: false }),
  ).rejects.toThrow("parent");
  await expect(
    handlers(f.bb, f.store).delegateToThread({
      taskId: f.done.id,
      threadId: "thr_worker",
    }),
  ).rejects.toThrow("Restore");
  await f.harness.callRpc("archiveTask", {
    taskId: f.done.id,
    archived: false,
  });
  expect(f.store.tasks.getTask(f.done.id)).toMatchObject({
    archivedAt: null,
    status: "done",
  });
  expect(f.store.tasks.getTask(child.id)?.archivedAt).toBeNull();
  expect(
    f.store.tasks
      .listComments(child.id)
      .some((c) => c.body === "Keep this history"),
  ).toBe(true);
});

it("bulk archives only completed families in the selected project", async () => {
  const f = setup();
  const blocked = f.store.tasks.createTask({
    projectId: f.project.id,
    title: "Closed parent with open child",
    status: "done",
  });
  f.store.tasks.createTask({
    projectId: f.project.id,
    title: "Open child",
    parentTaskId: blocked.id,
  });
  const other = f.store.tasks.createProject({
    name: "Other",
    prefix: "OTH",
    color: "blue",
  });
  const otherTask = f.store.tasks.createTask({
    projectId: other.id,
    title: "Other completed work",
    status: "done",
  });
  await expect(
    f.harness.callRpc("archiveTask", { taskId: blocked.id, archived: true }),
  ).rejects.toThrow("children");
  expect(f.store.tasks.getTask(blocked.id)?.archivedAt).toBeNull();
  expect(
    await f.harness.callRpc("archiveCompleted", { projectId: f.project.id }),
  ).toEqual({ archivedCount: 1 });
  expect(f.store.tasks.getTask(otherTask.id)?.archivedAt).toBeNull();
  expect(f.store.tasks.getTask(f.open.id)?.archivedAt).toBeNull();
  expect(
    await f.harness.callRpc("archiveCompleted", { projectId: f.project.id }),
  ).toEqual({ archivedCount: 0 });
});

it("filters archived records before pagination and rejects a cursor from another archive scope", async () => {
  const f = setup();
  f.store.tasks.setTaskArchived(f.done.id, true);
  f.store.tasks.createTask({
    projectId: f.project.id,
    title: "Another live task",
  });
  const page = (await f.harness.callRpc("listTasks", {
    projectId: f.project.id,
    limit: 1,
  })) as { tasks: { id: string }[]; nextCursor: string };
  expect(page.tasks[0]?.id).not.toBe(f.done.id);
  expect(page.nextCursor).toBeTruthy();
  await expect(
    f.harness.callRpc("listTasks", {
      projectId: f.project.id,
      archive: "all",
      cursor: page.nextCursor,
    }),
  ).rejects.toThrow("cursor");
});

it("exports both scopes in v7 and restores archive timestamps while importing old versions as unarchived", async () => {
  const f = setup();
  f.store.tasks.setTaskArchived(f.done.id, true);
  const capture = captureProject(f.bb, f.store, f.project.id);
  const records = await archiveRecords(f.store, capture, async () => {});
  expect(capture.manifest.version).toBe(7);
  expect(records).toHaveLength(2);
  const dest = createFakePluginHost({ pluginId: "tasks-plus" });
  hosts.push(dest);
  const restored = createStore(dest.bb);
  restoreProject(
    dest.bb,
    restored,
    { manifest: capture.manifest, records },
    new Map(),
    false,
  );
  expect(restored.tasks.getTask(f.done.id)?.archivedAt).toBe(
    f.store.tasks.getTask(f.done.id)?.archivedAt,
  );
  expect(() =>
    validateArchive({ manifest: { ...capture.manifest, version: 6 }, records }),
  ).toThrow("v7");
  const old = records.map((record) => {
    const { archivedAt, ...task } = record.task;
    return { ...record, task };
  });
  expect(() =>
    validateArchive({ manifest: capture.manifest, records: old }),
  ).toThrow("archivedAt");
  restoreProject(
    dest.bb,
    restored,
    { manifest: { ...capture.manifest, version: 6 }, records: old },
    new Map(),
    true,
  );
  expect(restored.tasks.getTask(f.done.id)?.archivedAt).toBeNull();
});

it("lets agents archive, find and restore tasks through the CLI", async () => {
  const f = setup();
  registerTasksCli(f.bb, f.store, { name: "Tasks Plus", version: "0.8.0" });
  expect(
    (await f.harness.runCli(["archive", f.done.key, "--json"])).exitCode,
  ).toBe(0);
  const listed = await f.harness.runCli([
    "list",
    "--project",
    "ARC",
    "--archived",
    "--json",
  ]);
  expect(listed.exitCode).toBe(0);
  expect(JSON.stringify(listed.stdout)).toContain(f.done.key);
  expect(
    (await f.harness.runCli(["show", f.done.key, "--json"])).exitCode,
  ).toBe(0);
  expect((await f.harness.runCli(["restore", f.done.key])).exitCode).toBe(0);
  expect(f.store.tasks.getTask(f.done.id)?.archivedAt).toBeNull();
});

it("archives and restores an epic, its member task and that task's sub-task", async () => {
  const f = setup();
  const epic = f.store.tasks.createTask({ projectId: f.project.id, title: "Completed epic", type: "epic", status: "done" });
  const member = f.store.tasks.createTask({ projectId: f.project.id, title: "Member", epicId: epic.id, status: "done" });
  const child = f.store.tasks.createTask({ projectId: f.project.id, title: "Nested sub-task", parentTaskId: member.id, status: "done" });
  await f.harness.callRpc("archiveTask", { taskId: epic.id, archived: true });
  for (const task of [epic, member, child]) expect(f.store.tasks.getTask(task.id)?.archivedAt).toBeTruthy();
  const comments = f.store.tasks.listComments(epic.id).length;
  await f.harness.callRpc("archiveTask", { taskId: epic.id, archived: true });
  expect(f.store.tasks.listComments(epic.id)).toHaveLength(comments);
  await expect(f.harness.callRpc("archiveTask", { taskId: member.id, archived: false })).rejects.toThrow("parent");
  await f.harness.callRpc("archiveTask", { taskId: epic.id, archived: false });
  for (const task of [epic, member, child]) expect(f.store.tasks.getTask(task.id)?.archivedAt).toBeNull();
});
