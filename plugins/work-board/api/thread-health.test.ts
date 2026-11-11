import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it, vi } from "vitest";
import { createStore } from ".";
import { tasksRpcContract } from "../shared/contract";
import { staleIdleMinutes } from "../shared/thread-health";
import plugin from "../server";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(hosts.splice(0).map((host) => host.harness.dispose()));
});
function clock(iso: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
}

async function setup() {
  const host = createFakePluginHost({ pluginId: "work-board" });
  hosts.push(host);
  await plugin(host.bb);
  const store = createStore(host.bb);
  const project = store.tasks.createProject({ name: "Health", prefix: "HLT", color: "blue" });
  const meta = async (taskId: string) =>
    tasksRpcContract.listTaskCardMeta.output.parse(await host.harness.callRpc("listTaskCardMeta", { taskIds: [taskId] })).metadata[0]!;
  return { ...host, store, project, meta };
}

it("derives idle and failed state from stored links, task activity and the setting", async () => {
  const f = await setup();
  clock("2026-10-28T08:00:00.000Z");
  const task = f.store.tasks.createTask({ projectId: f.project.id, title: "Work", status: "in_progress" });
  const link = f.store.tasks.upsertTaskThread({ taskId: task.id, threadId: "thr_worker", presetName: "p", title: "Worker", liveStatus: "idle" });

  clock("2026-10-28T08:44:00.000Z");
  expect((await f.meta(task.id)).threadHealth.idle?.since).toBe("2026-10-28T08:00:00.000Z");
  expect(staleIdleMinutes((await f.meta(task.id)).threadHealth.idle, Date.now())).toBeNull();
  clock("2026-10-28T08:45:00.000Z");
  expect(staleIdleMinutes((await f.meta(task.id)).threadHealth.idle, Date.now())).toBe(45);

  // A human/agent comment counts as task activity; a system comment does not.
  f.store.tasks.createComment({ taskId: task.id, kind: "system", authorName: "Work Board", body: "Thread attached" });
  expect((await f.meta(task.id)).threadHealth.idle?.since).toBe("2026-10-28T08:00:00.000Z");
  f.store.tasks.createComment({ taskId: task.id, kind: "agent", authorName: "Worker", body: "Progress" });
  expect((await f.meta(task.id)).threadHealth.idle?.since).toBe("2026-10-28T08:45:00.000Z");

  f.store.tasks.updateProject(f.project.id, { staleIdleMinutes: "off" });
  expect((await f.meta(task.id)).threadHealth.idle).toBeNull();
  f.store.tasks.updateProject(f.project.id, { staleIdleMinutes: "30" });
  expect((await f.meta(task.id)).threadHealth.idle?.thresholdMinutes).toBe(30);

  f.store.tasks.updateTaskThreadStatus(link.id, "failed");
  const failed = (await f.meta(task.id)).threadHealth;
  expect(failed).toEqual({ failed: [{ threadId: "thr_worker", title: "Worker", failedAt: "2026-10-28T08:45:00.000Z" }], idle: null });
  f.store.tasks.updateTaskThreadStatus(link.id, "working");
  expect((await f.meta(task.id)).threadHealth.failed).toEqual([]);
  f.store.tasks.deleteTaskThread(link.id);
  expect((await f.meta(task.id)).threadHealth).toEqual({ failed: [], idle: null });
});

it("defaults the threshold to 45 minutes", async () => {
  const f = await setup();
  const task = f.store.tasks.createTask({ projectId: f.project.id, title: "Work" });
  f.store.tasks.upsertTaskThread({ taskId: task.id, threadId: "thr_worker", presetName: "p", title: "Worker", liveStatus: "idle" });
  expect((await f.meta(task.id)).threadHealth.idle?.thresholdMinutes).toBe(45);
});

it("uses each project's idle threshold in card metadata and the navigation badge", async () => {
  const f = await setup();
  clock("2026-10-28T08:00:00.000Z");
  const projects = [f.project,
    f.store.tasks.createProject({ name: "Slow", prefix: "SLOW", color: "blue" }),
    f.store.tasks.createProject({ name: "Off", prefix: "OFF", color: "blue" })];
  const thresholds = ["30", "120", "off"] as const;
  const tasks = projects.map((project, index) => {
    f.store.tasks.updateProject(project.id, { staleIdleMinutes: thresholds[index]! });
    const task = f.store.tasks.createTask({ projectId: project.id, title: "Idle", status: "in_progress" });
    f.store.tasks.upsertTaskThread({ taskId: task.id, threadId: `thr_worker_${index}`, title: "Worker", presetName: "p", liveStatus: "idle" });
    return task;
  });
  clock("2026-10-28T09:00:00.000Z");
  expect((await f.meta(tasks[0]!.id)).threadHealth.idle?.thresholdMinutes).toBe(30);
  expect((await f.meta(tasks[1]!.id)).threadHealth.idle?.thresholdMinutes).toBe(120);
  expect((await f.meta(tasks[2]!.id)).threadHealth.idle).toBeNull();
  await f.harness.callRpc("setNavigationBadgeCriteria", { criteria: ["stale_idle"] });
  expect(await f.harness.callRpc("navigationBadge", null)).toMatchObject({ count: 1, counts: { stale_idle: 1 }, timeBased: true });
});
