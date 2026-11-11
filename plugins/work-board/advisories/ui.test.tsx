// @vitest-environment jsdom
import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse, type FakePluginHarness } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createStore, registerTasksApi } from "../api";
import { tasksRpcContract } from "../shared/contract";
window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
Element.prototype.scrollIntoView ??= () => {};
const app = await loadPluginApp(() => import("../app"));
const harnesses: FakePluginHarness[] = [];
afterEach(async () => { cleanup(); localStorage.clear(); await Promise.all(harnesses.splice(0).map(h => h.dispose())); });
it.each(["board", "list", "task"])("surfaces session advice in the %s and clears it when a live session attaches", async surface => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" }); harnesses.push(harness);
  const store = createStore(bb); registerTasksApi(bb, store);
  const project = store.tasks.createProject({ name: "Advice", prefix: "ADV", color: "blue" });
  const task = store.tasks.createTask({ projectId: project.id, title: "Unassigned work", status: "in_progress" });
  const rpc = Object.fromEntries(Object.keys(tasksRpcContract).map(method => [method, (input: unknown) => harness.callRpc(method, input)]));
  const slot = renderSlot(app.navPanels[0]!, { subPath: surface === "task" ? `task/${task.key}` : `${project.id}?view=${surface}` }, { rpc });
  await slot.findAllByText("Needs attention · 1");
  if (surface === "task") expect(slot.getAllByText(/In Progress without a live attached session/).length).toBeGreaterThan(0);
  store.tasks.upsertTaskThread({ taskId: task.id, threadId: "thr_attached", title: "New worker", presetName: "Attached", liveStatus: "idle" });
  const thread = makeThreadResponse({ id: "thr_attached", status: "idle", runtime: { displayStatus: "idle" } });
  harness.sdk.stub("threads.list", async () => [thread] as never);
  harness.sdk.stub("threads.get", async () => thread);
  await slot.behavior.emitRealtime("threads:changed", { taskId: task.id, projectId: project.id });
  await waitFor(() => expect(slot.queryAllByText("Needs attention · 1")).toHaveLength(0));
  expect(store.tasks.getTask(task.id)?.status).toBe("in_progress");
});
