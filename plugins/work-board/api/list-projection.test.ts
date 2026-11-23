import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it } from "vitest";
import { createStore, registerHandlers } from "../api";
import { tasksRpcContract } from "../shared/contract";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { await Promise.all(hosts.splice(0).map((host) => host.harness.dispose())); });

function setup() {
  const host = createFakePluginHost({ pluginId: "work-board" });
  hosts.push(host);
  const store = createStore(host.bb);
  const project = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue" });
  for (let index = 0; index < 5; index++) {
    const task = store.tasks.createTask({ projectId: project.id, title: `Card ${index}`, description: `Body ${index}` });
    store.tasks.updateTask(task.id, { progressNote: `Note ${index}` });
  }
  const api = registerHandlers(host.bb, store);
  const list = (input: Record<string, unknown>) => api.listTasks(tasksRpcContract.listTasks.input.parse({ projectId: project.id, ...input }));
  return { list };
}

it("omitBodies empties description and progressNote and keeps everything else", async () => {
  const { list } = setup();
  const full = await list({});
  const light = await list({ omitBodies: true });
  expect(full.tasks.every((task) => task.description !== "" && task.progressNote !== null)).toBe(true);
  expect(light.tasks.every((task) => task.description === "" && task.progressNote === null)).toBe(true);
  expect(light.tasks.map(({ description: _d, progressNote: _p, ...rest }) => rest))
    .toEqual(full.tasks.map(({ description: _d, progressNote: _p, ...rest }) => rest));
  expect(light.staleStatusFlags).toEqual(full.staleStatusFlags);
  expect(light.nextCursor).toBe(full.nextCursor);
});

it("a cursor from an omitBodies page continues a full read", async () => {
  const { list } = setup();
  const first = await list({ omitBodies: true, limit: 2, allowStaleCursor: true });
  expect(first.nextCursor).not.toBeNull();
  const rest = await list({ cursor: first.nextCursor!, limit: 10, allowStaleCursor: true });
  expect(rest.tasks).toHaveLength(3);
  expect(rest.tasks.every((task) => task.description !== "")).toBe(true);
});
