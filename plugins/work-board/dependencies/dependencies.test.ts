import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it } from "vitest";
import { createStore, registerHandlers, registerTasksApi } from "../api";
import { registerTasksCli } from "../cli";
import { createDependencyStore } from "./store";
import { captureProject, restoreProject } from "../archive/storage";
import { archiveTaskSchema, validateArchive } from "../archive/contract";
import { buildSeedPrompt } from "../delegate";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { await Promise.all(hosts.splice(0).map(host => host.harness.dispose())); });
function setup() {
  const host = createFakePluginHost({ pluginId: "work-board" });
  hosts.push(host);
  const store = createStore(host.bb);
  const project = store.tasks.createProject({ name: "Dependencies", prefix: "DEP", color: "blue" });
  const [a, b, c] = ["Prerequisite", "Dependent", "Third"].map(title => store.tasks.createTask({ projectId: project.id, title }));
  const dependencies = createDependencyStore(host.bb.storage.database(), store.tasks);
  return { ...host, store, project, a: a!, b: b!, c: c!, dependencies };
}

it("shows both directions, updates blockers only on Done, and never prevents status changes", async () => {
  const h = setup(), api = registerHandlers(h.bb, h.store);
  const input = { taskId: h.b.id, blockingTaskId: h.a.id, authorName: "Owner" };
  expect(await api.addTaskDependency(input)).toEqual({ changed: true });
  expect(await api.addTaskDependency(input)).toEqual({ changed: false });
  expect(h.dependencies.list(h.a.id).blocks.map(task => task.id)).toEqual([h.b.id]);
  expect(h.dependencies.list(h.b.id).blockedBy.map(task => task.id)).toEqual([h.a.id]);
  expect(h.store.tasks.listComments(h.b.id)).toHaveLength(1);
  expect(h.dependencies.blockers([h.b.id]).get(h.b.id)).toHaveLength(1);
  await api.updateTask({ taskId: h.b.id, status: "in_progress", authorName: "Owner" });
  await api.boardMove({ taskId: h.b.id, status: "done", authorName: "Owner" });
  expect(h.store.tasks.getTask(h.b.id)?.status).toBe("done");
  h.store.tasks.updateTask(h.a.id, { status: "canceled" });
  expect(h.dependencies.blockers([h.b.id]).get(h.b.id)).toHaveLength(1);
  await api.updateTask({ taskId: h.a.id, status: "done", authorName: "Owner" });
  expect(h.dependencies.blockers([h.b.id]).get(h.b.id)).toBeUndefined();
  expect(h.dependencies.list(h.b.id).blockedBy).toHaveLength(1);
  expect(h.harness.realtimeSignals).toContainEqual({ channel: "tasks:changed", payload: { taskId: h.b.id, projectId: h.project.id } });
  h.store.tasks.updateTask(h.a.id, { status: "todo" });
  expect(h.dependencies.blockers([h.b.id]).get(h.b.id)).toHaveLength(1);
  expect(await api.removeTaskDependency(input)).toEqual({ changed: true });
  expect(h.dependencies.list(h.a.id).blocks).toEqual([]);
  expect(h.dependencies.blockers([h.b.id]).size).toBe(0);
});

it("rejects self links, missing tasks, cycles and cross-project links atomically", () => {
  const h = setup();
  expect(() => h.dependencies.add(h.a.id, h.a.id)).toThrow(/itself/);
  expect(() => h.dependencies.add(h.a.id, "missing")).toThrow(/not found/);
  h.dependencies.add(h.b.id, h.a.id);
  h.dependencies.add(h.c.id, h.b.id);
  expect(() => h.dependencies.add(h.a.id, h.c.id)).toThrow(/cycle/);
  expect(h.dependencies.list(h.a.id).blockedBy).toEqual([]);
  const project = h.store.tasks.createProject({ name: "Other", prefix: "OTH", color: "blue" });
  const other = h.store.tasks.createTask({ projectId: project.id, title: "Other" });
  expect(() => h.dependencies.add(h.a.id, other.id)).toThrow(/same project/);
});

it("preserves dependencies on a whole-family move and refuses a partial move without losing data", async () => {
  const h = setup(), api = registerHandlers(h.bb, h.store);
  const project = h.store.tasks.createProject({ name: "Target", prefix: "TGT", color: "blue" });
  h.dependencies.add(h.b.id, h.a.id);
  expect(() => api.moveTaskToProject({ taskId: h.b.id, projectId: project.id, authorName: "Owner" })).toThrow(/dependencies/);
  expect(h.store.tasks.getTask(h.b.id)?.projectId).toBe(h.project.id);
  expect(h.dependencies.list(h.b.id).blockedBy[0]?.key).toBe(h.a.key);
  h.store.tasks.updateTask(h.b.id, { parentTaskId: h.a.id });
  await api.moveTaskToProject({ taskId: h.a.id, projectId: project.id, authorName: "Owner" });
  expect(h.dependencies.list(h.b.id).blockedBy[0]?.key).toMatch(/^TGT-/);
  await api.deleteTask({ taskId: h.a.id });
  expect(h.bb.storage.database().prepare("SELECT * FROM task_dependencies").all()).toEqual([]);
});

it("round-trips archive v12, rejects bad graphs, and preserves links on legacy import", () => {
  const source = setup();
  source.dependencies.add(source.b.id, source.a.id);
  const capture = captureProject(source.bb, source.store, source.project.id);
  const archive = { manifest: capture.manifest, records: capture.records.map(record => archiveTaskSchema.parse(record)) };
  expect(archive.manifest.version).toBe(16);
  const targetHost = createFakePluginHost({ pluginId: "work-board" });
  hosts.push(targetHost);
  const targetStore = createStore(targetHost.bb);
  const target = { ...targetHost, store: targetStore, dependencies: createDependencyStore(targetHost.bb.storage.database(), targetStore.tasks) };
  restoreProject(target.bb, target.store, archive, new Map(), false);
  expect(target.dependencies.list(source.b.id).blockedBy[0]?.id).toBe(source.a.id);
  const legacy = structuredClone(archive);
  legacy.manifest.version = 11;
  for (const record of legacy.records) { delete record.dependencies; delete record.related; }
  restoreProject(target.bb, target.store, legacy, new Map(), true);
  expect(target.dependencies.list(source.b.id).blockedBy).toHaveLength(1);
  const changed = structuredClone(archive);
  changed.records.find(record => record.task.id === source.b.id)!.dependencies = [];
  expect(() => restoreProject(target.bb, target.store, changed, new Map(), false)).toThrow(/Import conflict: dependencies/);
  const cycle = structuredClone(archive);
  cycle.records.find(record => record.task.id === source.a.id)!.dependencies = [source.b.id];
  expect(() => validateArchive(cycle)).toThrow(/cycle/);
  const missing = structuredClone(archive);
  missing.records[0]!.dependencies = ["01HZZZZZZZZZZZZZZZZZZZZZZZ"];
  expect(() => validateArchive(missing)).toThrow(/Invalid task dependency/);
});

it("exposes CLI dependency management and warnings in show/list JSON and dispatch context", async () => {
  const h = setup();
  registerTasksApi(h.bb, h.store);
  registerTasksCli(h.bb, h.store, { name: "Work Board", version: "test" });
  const run = async (args: string[]) => {
    const result = await h.harness.runCli(args);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout);
  };
  await run(["dependency", "add", h.b.key, "--blocked-by", h.a.key, "--json"]);
  expect((await run(["dependency", "list", h.b.key, "--json"])).blockedBy[0].key).toBe(h.a.key);
  const detail = await run(["show", h.b.key, "--json"]);
  expect(detail.blocked).toBe(true);
  expect(detail.dependencies.blockedBy[0].key).toBe(h.a.key);
  const list = await run(["list", "--project", "DEP", "--json"]);
  expect(list.tasks.find((task: { id: string }) => task.id === h.b.id).blockedBy[0].key).toBe(h.a.key);
  const prompt = buildSeedPrompt({ task: h.b, project: h.project, subtasks: [], attachments: [], recentComments: [], presetInstructions: "", blockedBy: h.dependencies.blockers([h.b.id]).get(h.b.id) });
  expect(prompt).toContain("Dependency warning");
  expect(prompt).toContain(h.a.key);
  expect(prompt).toContain("Work and status changes are allowed");
  await run(["dependency", "remove", h.b.key, "--blocked-by", h.a.key, "--json"]);
  expect(h.dependencies.blockers([h.b.id]).size).toBe(0);
});

it("links related tasks symmetrically without blocking, and round-trips them in archive v15", async () => {
  const h = setup(), api = registerHandlers(h.bb, h.store);
  expect(await api.addTaskRelation({ taskId: h.b.id, relatedTaskId: h.a.id, authorName: "Owner" })).toEqual({ changed: true });
  expect(await api.addTaskRelation({ taskId: h.a.id, relatedTaskId: h.b.id, authorName: "Owner" })).toEqual({ changed: false });
  expect(h.dependencies.list(h.a.id)).toMatchObject({ blockedBy: [], blocks: [], related: [{ id: h.b.id }] });
  expect(h.dependencies.list(h.b.id).related.map(task => task.id)).toEqual([h.a.id]);
  expect(h.dependencies.blockers([h.a.id, h.b.id]).size).toBe(0);
  expect(h.store.tasks.listComments(h.a.id).at(-1)?.body).toContain("Related task added");
  expect(h.dependencies.related(h.a.id).map(task => task.id)).toEqual([h.b.id]);
  expect(() => h.dependencies.relate(h.a.id, h.a.id)).toThrow(/itself/);
  const other = h.store.tasks.createProject({ name: "Other", prefix: "OTH", color: "red" });
  const foreign = h.store.tasks.createTask({ projectId: other.id, title: "Elsewhere" });
  expect(() => h.dependencies.relate(h.a.id, foreign.id)).toThrow(/same project/);
  h.dependencies.relate(h.c.id, h.b.id);

  const capture = captureProject(h.bb, h.store, h.project.id);
  const archive = { manifest: capture.manifest, records: capture.records.map(record => archiveTaskSchema.parse(record)) };
  validateArchive(archive);
  const targetHost = createFakePluginHost({ pluginId: "work-board" });
  hosts.push(targetHost);
  const targetStore = createStore(targetHost.bb);
  restoreProject(targetHost.bb, targetStore, archive, new Map(), false);
  const target = createDependencyStore(targetHost.bb.storage.database(), targetStore.tasks);
  expect(target.list(h.b.id).related.map(task => task.id).sort()).toEqual([h.a.id, h.c.id].sort());

  expect(await api.removeTaskRelation({ taskId: h.a.id, relatedTaskId: h.b.id, authorName: "Owner" })).toEqual({ changed: true });
  expect(h.dependencies.list(h.b.id).related.map(task => task.id)).toEqual([h.c.id]);
  const reversed = structuredClone(archive);
  const lower = [h.a.id, h.b.id].sort()[0]!, higher = [h.a.id, h.b.id].sort()[1]!;
  reversed.records.find(record => record.task.id === higher)!.related = [lower];
  expect(() => validateArchive(reversed)).toThrow(/Invalid related task/);
});

it("announces a subtask change on its parent and epic so their pages refresh", async () => {
  const h = setup(), api = registerHandlers(h.bb, h.store);
  const epic = h.store.tasks.createTask({ projectId: h.project.id, title: "Epic", type: "epic" });
  const subtask = h.store.tasks.createTask({ projectId: h.project.id, title: "Child", parentTaskId: h.a.id });
  const epicChild = h.store.tasks.createTask({ projectId: h.project.id, title: "Epic child", epicId: epic.id });
  h.harness.realtimeSignals.length = 0;
  await api.updateTask({ taskId: subtask.id, status: "in_progress", authorName: "Owner" });
  await api.updateTask({ taskId: epicChild.id, status: "in_progress", authorName: "Owner" });
  const changed = h.harness.realtimeSignals.filter(signal => signal.channel === "tasks:changed").map(signal => (signal.payload as { taskId: string }).taskId);
  expect(changed).toEqual(expect.arrayContaining([subtask.id, h.a.id, epicChild.id, epic.id]));
});
