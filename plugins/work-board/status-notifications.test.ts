import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it, vi } from "vitest";
import { createStore, registerTasksApi } from "./api";
import { registerTasksCli } from "./cli";
import { migrateSettings } from "./settings";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { for (const h of hosts.splice(0)) await h.harness.dispose(); });
async function fixture(mode = "all", fail = false) {
  const send = vi.fn(async (_input: unknown) => { if (fail) throw new Error("Unavailable"); return { ok: true, channels: ["desktop"] }; });
  const host = createFakePluginHost({ pluginId: "work-board", sdk: { plugins: { callRpc: send } } });
  hosts.push(host);
  const store = createStore(host.bb);
  const project = store.tasks.createProject({ name: "Push test", prefix: "PUSH", color: "blue" });
  store.tasks.updateProject(project.id, { statusNotifications: mode as "all" | "done" | "off" });
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
  f.store.tasks.updateProject(f.project.id, { statusNotifications: "off" });
  f.store.tasks.updateTask(f.task.id, { status: "todo" });
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(f.send).toHaveBeenCalledTimes(1);
});
it("Done only compares the committed status across transient and rolled-back edits", async () => {
  const f = await fixture("done");
  f.store.tasks.updateTask(f.task.id, { status: "done" });
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
  f.send.mockClear();
  f.store.transaction(() => {
    f.store.tasks.updateTask(f.task.id, { status: "todo" });
    f.store.tasks.updateTask(f.task.id, { status: "done" });
  });
  expect(() => f.store.transaction(() => {
    f.store.tasks.updateTask(f.task.id, { status: "todo" });
    f.store.tasks.updateTask(f.task.id, { status: "done" });
    throw new Error("Rollback");
  })).toThrow();
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(f.send).not.toHaveBeenCalled();
});
it("keeps later queued cards coalesced while an earlier push is pending", async () => {
  const f = await fixture();
  const second = f.store.tasks.createTask({ projectId: f.project.id, title: "Second", status: "todo" });
  let release!: (value: { ok: true; channels: ["desktop"] }) => void;
  f.send.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  f.store.tasks.updateTask(f.task.id, { status: "in_progress" });
  f.store.tasks.updateTask(second.id, { status: "in_progress" });
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
  f.store.tasks.updateTask(second.id, { status: "done" });
  release({ ok: true, channels: ["desktop"] });
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
  expect(f.send.mock.calls[1]?.[0]).toMatchObject({ input: { body: "Second · Todo → Done" } });
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
it("keeps another project's notifications off", async () => {
  const f = await fixture("all");
  const other = f.store.tasks.createProject({ name: "Silent", prefix: "SIL", color: "red" });
  const task = f.store.tasks.createTask({ projectId: other.id, title: "Private", status: "todo" });
  f.store.tasks.updateTask(task.id, { status: "done" });
  f.store.tasks.updateTask(f.task.id, { status: "done" });
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
  expect(f.send.mock.calls[0]?.[0]).toMatchObject({ input: { title: "PUSH-1 · Done" } });
});
it("migrates the old global mode once, preserves explicit choices and defaults new projects to Off", async () => {
  const f = await fixture("done");
  f.bb.storage.database().prepare("UPDATE projects SET status_notifications=NULL WHERE id=?").run(f.project.id);
  await f.bb.storage.kv.set("board:preferences", { defaultScreen: "active", statusNotifications: "all" });
  await migrateSettings(f.bb);
  expect(f.store.tasks.getProject(f.project.id)?.statusNotifications).toBe("all");
  expect(await f.bb.storage.kv.get("board:preferences")).toEqual({ defaultScreen: "active" });
  f.store.tasks.updateProject(f.project.id, { statusNotifications: "done" });
  await migrateSettings(f.bb);
  expect(f.store.tasks.getProject(f.project.id)?.statusNotifications).toBe("done");
  expect(f.store.tasks.createProject({ name: "New", prefix: "NEW", color: "blue" }).statusNotifications).toBe("off");
});

it("suppresses owner edits and board moves, and sends agent changes", async () => {
  const f = await fixture();
  registerTasksApi(f.bb, f.store);
  await f.harness.callRpc("updateTask", { taskId: f.task.id, status: "in_progress" });
  await f.harness.callRpc("boardMove", { taskId: f.task.id, status: "in_review" });
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(f.send).not.toHaveBeenCalled();
  await f.harness.callRpc("updateTask", { taskId: f.task.id, status: "done", agentThreadId: "thr_agent" });
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
  await f.harness.callRpc("boardMove", { taskId: f.task.id, status: "todo", agentThreadId: "thr_agent" });
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
});

it("suppresses CLI owner status changes and sends CLI agent status changes", async () => {
  const f = await fixture();
  registerTasksApi(f.bb, f.store);
  registerTasksCli(f.bb, f.store, { name: "Work Board", version: "test" });
  const owner = await f.harness.runCli(["update", f.task.key, "--status", "done"]);
  expect(owner.exitCode, owner.stderr).toBe(0);
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(f.send).not.toHaveBeenCalled();
  const agent = await f.harness.runCli(["update", f.task.key, "--status", "todo"], { threadId: "thr_agent" });
  expect(agent.exitCode, agent.stderr).toBe(0);
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
});
