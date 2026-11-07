import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it, vi } from "vitest";
import { createStore } from "./api";
import { BOARD_PREFERENCES_KEY } from "./shared/project-settings";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { for (const h of hosts.splice(0)) await h.harness.dispose(); });
async function fixture(mode = "all", fail = false) {
  const send = vi.fn(async (_input: unknown) => { if (fail) throw new Error("Unavailable"); return { ok: true, channels: ["desktop"] }; });
  const host = createFakePluginHost({ pluginId: "work-board", sdk: { plugins: { callRpc: send } } });
  hosts.push(host);
  const store = createStore(host.bb);
  await host.bb.storage.kv.set(BOARD_PREFERENCES_KEY, { defaultScreen: "all", statusNotifications: mode });
  const project = store.tasks.createProject({ name: "Push test", prefix: "PUSH", color: "blue" });
  const task = store.tasks.createTask({ projectId: project.id, title: "Ship it", status: "todo" });
  return { ...host, store, project, task, send };
}
it("notifies shared edits and drag/drop, using status names without duplicate saves", async () => {
  const f = await fixture();
  f.store.tasks.updateTask(f.task.id, { status: "in_progress" });
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
  expect(f.send.mock.calls[0]?.[0]).toMatchObject({ pluginId: "push-notifications", method: "notifications.send", input: { title: "PUSH-1 · In Progress", body: "Ship it · Todo → In Progress" } });
  f.store.tasks.updateTask(f.task.id, { title: "Renamed", status: "in_progress" });
  f.store.tasks.updatePosition(f.task.id, { status: "in_progress" });
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(f.send).toHaveBeenCalledTimes(1);
  f.store.tasks.updatePosition(f.task.id, { status: "done" });
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
});
it("Done only ignores intermediate changes, and Off suppresses all pushes", async () => {
  const f = await fixture("done");
  f.store.tasks.updateTask(f.task.id, { status: "in_progress" });
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(f.send).not.toHaveBeenCalled();
  f.store.tasks.updateTask(f.task.id, { status: "done" });
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
  await f.bb.storage.kv.set(BOARD_PREFERENCES_KEY, { defaultScreen: "all", statusNotifications: "off" });
  f.store.tasks.updateTask(f.task.id, { status: "todo" });
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(f.send).toHaveBeenCalledTimes(1);
});
it("does not notify rolled-back transactions or status-neutral edits", async () => {
  const f = await fixture();
  expect(() => f.store.transaction(() => { f.store.tasks.updateTask(f.task.id, { status: "done" }); throw new Error("Rollback"); })).toThrow();
  f.store.tasks.updateTask(f.task.id, { title: "Only title" });
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(f.send).not.toHaveBeenCalled();
});
it("push failure cannot roll back the card and is not automatically resent", async () => {
  const f = await fixture("all", true);
  f.store.tasks.updateTask(f.task.id, { status: "done" });
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
  expect(f.store.tasks.getTask(f.task.id)?.status).toBe("done");
  f.store.tasks.updateTask(f.task.id, { status: "done" });
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(f.send).toHaveBeenCalledTimes(1);
});
