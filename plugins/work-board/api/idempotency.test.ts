import { afterEach, expect, it, vi } from "vitest";
import { createFakePluginHost, type FakePluginHarness } from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from ".";
import { tasksRpcContract } from "../shared/contract";

const hosts: FakePluginHarness[] = [];
afterEach(async () => { await Promise.all(hosts.splice(0).map(h => h.dispose())); });
function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  hosts.push(harness);
  const store = createStore(bb); registerTasksApi(bb, store);
  const project = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue" });
  const other = store.tasks.createProject({ name: "Other", prefix: "OTH", color: "blue" });
  const create = async (extra: Record<string, unknown> = {}) => tasksRpcContract.createTask.output.parse(await harness.callRpc("createTask", { projectId: project.id, title: "First", idempotencyKey: "entry-1", ...extra }));
  const update = async (taskId: string, extra: Record<string, unknown>) => tasksRpcContract.updateTask.output.parse(await harness.callRpc("updateTask", { taskId, ...extra }));
  return { bb, harness, store, project, other, create, update };
}
it("replays a key per project, including archived tasks, and retains tombstones", async () => {
  const f = setup();
  const [a, b] = await Promise.all([f.create(), f.create({ title: "Different" })]);
  expect(a.ok && b.ok && a.task.id === b.task.id).toBe(true);
  if (!a.ok) throw Error();
  expect(f.store.tasks.listTasks({ projectId: f.project.id })).toHaveLength(1);
  const other = await f.create({ projectId: f.other.id });
  expect(other.ok && other.task.id).not.toBe(a.task.id);
  await f.update(a.task.id, { status: "done" });
  await f.harness.callRpc("archiveTask", { taskId: a.task.id, archived: true });
  expect(await f.create()).toMatchObject({ ok: true, task: { id: a.task.id } });
  f.store.tasks.moveTaskToProject(a.task.id, f.other.id);
  const db = f.bb.storage.database();
  const counts = (projectId: string) => ({ tasks: f.store.tasks.listTasks({ projectId }).length, keys: db.prepare("SELECT * FROM task_idempotency WHERE project_id=?").all(projectId).length });
  const beforeMoved = counts(f.project.id);
  expect(await f.create()).toMatchObject({ ok: false, error: { code: "idempotency_target_gone" } });
  expect(counts(f.project.id)).toEqual(beforeMoved);
  if (!other.ok) throw Error();
  await f.harness.callRpc("deleteTask", { taskId: other.task.id });
  const beforeDeleted = counts(f.other.id);
  expect(await f.create({ projectId: f.other.id })).toMatchObject({ ok: false, error: { code: "idempotency_target_gone" } });
  expect(counts(f.other.id)).toEqual(beforeDeleted);
});
it("rolls back a failed create and validates keys", async () => {
  const f = setup();
  const foreign = f.store.tasks.createTask({ projectId: f.other.id, title: "Parent" });
  expect(await f.create({ parentTaskId: foreign.id })).toMatchObject({ ok: false });
  expect(await f.create()).toMatchObject({ ok: true });
  await expect(f.create({ idempotencyKey: "" })).rejects.toThrow();
  expect(await f.create({ idempotencyKey: "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFG" })).toMatchObject({ ok: false, error: { code: "secret_detected" } });
});
it("rolls back the task when recording its key fails", async () => {
  const f = setup();
  const db = f.bb.storage.database();
  db.exec("CREATE TRIGGER fail_idempotency BEFORE INSERT ON task_idempotency BEGIN SELECT RAISE(ABORT, 'forced failure'); END");
  await expect(f.create()).rejects.toThrow("forced failure");
  expect(f.store.tasks.listTasks({ projectId: f.project.id })).toHaveLength(0);
  expect(db.prepare("SELECT * FROM task_idempotency").all()).toHaveLength(0);
  db.exec("DROP TRIGGER fail_idempotency");
  expect(await f.create()).toMatchObject({ ok: true });
  expect(f.store.tasks.listTasks({ projectId: f.project.id })).toHaveLength(1);
});
it("compares only due dates atomically and leaves the entire patch untouched on conflict", async () => {
  const f = setup(); const created = await f.create(); if (!created.ok) throw Error(); const id = created.task.id;
  expect(await f.update(id, { dueDate: "2026-12-01", expectedDueDate: null })).toMatchObject({ ok: true });
  const [a, b] = await Promise.all([f.update(id, { dueDate: "2026-12-02", expectedDueDate: "2026-12-01", title: "First change" }), f.update(id, { dueDate: "2026-12-03", expectedDueDate: "2026-12-01", title: "Second change" })]);
  expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  const winner = a.ok ? a : b; const loser = a.ok ? b : a;
  if (!winner.ok || loser.ok) throw Error();
  expect(loser.error).toMatchObject({ code: "due_date_conflict", currentDueDate: winner.task.dueDate });
  expect(f.store.tasks.getTask(id)?.title).toBe(winner.task.title);
  expect(f.store.tasks.getTask(id)?.title).not.toBe(a.ok ? "Second change" : "First change");
  await expect(f.update(id, { title: "x", expectedDueDate: null })).rejects.toThrow();
  expect(await f.update(id, { dueDate: null })).toMatchObject({ ok: true, task: { dueDate: null } });
});

it("recovers an existing task after a primary-key clash", async () => {
  const f = setup();
  const first = await f.create(); if (!first.ok) throw Error();
  const db = f.bb.storage.database();
  const prepare = db.prepare.bind(db);
  let missed = false;
  const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
    const statement = prepare(sql);
    if (sql.startsWith("SELECT task_id FROM task_idempotency") && !missed) {
      missed = true;
      return { ...statement, get: () => undefined };
    }
    return statement;
  }) as typeof db.prepare);
  try {
    expect(await f.create()).toMatchObject({ ok: true, task: { id: first.task.id } });
    expect(f.store.tasks.listTasks({ projectId: f.project.id })).toHaveLength(1);
  } finally { spy.mockRestore(); }
});
