// @vitest-environment jsdom
import { cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse, type FakePluginHarness } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createStore, registerTasksApi } from "../../api";
import { tasksRpcContract } from "../../shared/contract";
import { taskTab, navTab } from "../../test-fixtures.js";

window.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
window.matchMedia ??= (media: string) => ({
  matches: false,
  media,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => false,
});
const app = await loadPluginApp(() => import("../../app"));
const harnesses: FakePluginHarness[] = [];
afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  window.localStorage.clear();
  await Promise.all(harnesses.splice(0).map((h) => h.dispose()));
});

function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  harnesses.push(harness);
  const store = createStore(bb);
  registerTasksApi(bb, store);
  const project = store.tasks.createProject({ name: "Health", prefix: "HLT", color: "blue", linkedBbProjectId: "proj_health" });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-28T08:00:00.000Z"));
  const failedTask = store.tasks.createTask({ projectId: project.id, title: "Failed work", status: "in_progress" });
  const idleTask = store.tasks.createTask({ projectId: project.id, title: "Idle work", status: "in_progress" });
  const reviewTask = store.tasks.createTask({ projectId: project.id, title: "In review", status: "in_review" });
  store.tasks.upsertTaskThread({ taskId: failedTask.id, threadId: "thr_failed", presetName: "p", title: "Broken worker", liveStatus: "failed" });
  store.tasks.upsertTaskThread({ taskId: idleTask.id, threadId: "thr_idle", presetName: "p", title: "Quiet worker", liveStatus: "idle" });
  store.tasks.upsertTaskThread({ taskId: reviewTask.id, threadId: "thr_review", presetName: "p", title: "Reviewer", liveStatus: "idle" });
  vi.setSystemTime(new Date("2026-10-28T08:52:00.000Z"));
  const rpc = Object.fromEntries(
    Object.keys(tasksRpcContract).map((method) => [method, (input: unknown) => harness.callRpc(method, input)]),
  );
  const sdk = { threads: { get: async () => makeThreadResponse({ id: "thr_health", projectId: "proj_health" }) } };
  return { project, failedTask, idleTask, reviewTask, rpc, sdk };
}

it.each(["main", "side", "kanban"])("marks failed and stale-idle threads on the %s board", async (surface) => {
  const { project, failedTask, idleTask, reviewTask, rpc, sdk } = setup();
  const options = { rpc, sdk };
  const slot =
    surface === "side"
      ? renderSlot(taskTab(app), { threadId: "thr_health", environment: null }, options)
      : surface === "kanban"
        ? renderSlot({ component: navTab(app, "kanban").component }, { subPath: project.id }, options)
        : renderSlot(app.navPanels[0]!, { subPath: `${project.id}?view=board` }, options);
  const card = (key: string) => slot.container.querySelector(`[data-task-key="${key}"]`)!;
  const failed = await slot.findByRole("img", { name: /^Thread Broken worker failed/ });
  expect(card(failedTask.key).contains(failed)).toBe(true);
  const idle = await slot.findByRole("img", { name: "Thread idle 52 min, task not updated" });
  expect(card(idleTask.key).contains(idle)).toBe(true);
  expect(card(reviewTask.key).querySelector("[data-thread-health]")).toBeNull();
});
