import { afterEach, expect, it } from "vitest";
import { createFakePluginHost, type FakePluginHarness } from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from ".";
import { tasksRpcContract } from "../shared/contract";

const harnesses: FakePluginHarness[] = [];
afterEach(async () => { await Promise.all(harnesses.splice(0).map((h) => h.dispose())); });

function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  harnesses.push(harness);
  const store = createStore(bb);
  registerTasksApi(bb, store);
  const exa = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue" });
  const oth = store.tasks.createProject({ name: "Other", prefix: "OTH", color: "blue" });
  const resolve = async (keys: string[]) => tasksRpcContract.resolveTaskKeys.output.parse(await harness.callRpc("resolveTaskKeys", { keys })).tasks;
  return { store, harness, exa, oth, resolve };
}

it("resolves current keys of any project with title, status and archived flag", async () => {
  const { store, exa, oth, resolve, harness } = setup();
  const one = store.tasks.createTask({ projectId: exa.id, title: "First card", status: "in_progress" });
  const two = store.tasks.createTask({ projectId: oth.id, title: "Second card", status: "done" });
  await harness.callRpc("archiveTask", { taskId: two.id, archived: true });
  expect(await resolve([one.key, two.key, one.key])).toEqual([
    { key: one.key, currentKey: one.key, title: "First card", status: "in_progress", statusName: "In Progress", archived: false },
    { key: two.key, currentKey: two.key, title: "Second card", status: "done", statusName: "Done", archived: true },
  ]);
});

it("omits a deleted card and a key whose prefix belongs to no project or alias", async () => {
  const { store, exa, resolve, harness } = setup();
  const gone = store.tasks.createTask({ projectId: exa.id, title: "Gone", status: "todo" });
  await harness.callRpc("deleteTask", { taskId: gone.id });
  expect(await resolve([gone.key, "ISO-9001", "EXA-999"])).toEqual([]);
});

it("resolves an old key to its card's current key, even after the old project is deleted", async () => {
  const { store, exa, oth, resolve } = setup();
  const task = store.tasks.createTask({ projectId: exa.id, title: "Moving", status: "todo" });
  const oldKey = task.key;
  const moved = store.tasks.moveTaskToProject(task.id, oth.id).task;
  expect(await resolve([oldKey, moved.key])).toEqual([
    expect.objectContaining({ key: oldKey, currentKey: moved.key, title: "Moving" }),
    expect.objectContaining({ key: moved.key, currentKey: moved.key }),
  ]);
  store.tasks.deleteProject(exa.id);
  expect((await resolve([oldKey]))[0]).toMatchObject({ currentKey: moved.key });
});

it("refuses more than 500 keys", async () => {
  const { harness } = setup();
  const keys = Array.from({ length: 501 }, (_, index) => `EXA-${index + 1}`);
  await expect(harness.callRpc("resolveTaskKeys", { keys })).rejects.toThrow();
});
