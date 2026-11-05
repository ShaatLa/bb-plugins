// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { createFakePluginHost, type FakePluginHarness } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createStore, registerTasksApi } from "../../api";
import { tasksRpcContract } from "../../shared/contract";
import { createDependencyStore } from "../../dependencies/store";

window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
Element.prototype.scrollIntoView ??= () => {};
const app = await loadPluginApp(() => import("../../app"));
const harnesses: FakePluginHarness[] = [];
afterEach(async () => { cleanup(); localStorage.clear(); await Promise.all(harnesses.splice(0).map(h => h.dispose())); });
function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  harnesses.push(harness);
  const store = createStore(bb);
  registerTasksApi(bb, store);
  const project = store.tasks.createProject({ name: "Dependencies", prefix: "DEP", color: "blue" });
  const a = store.tasks.createTask({ projectId: project.id, title: "Predecessor" });
  const b = store.tasks.createTask({ projectId: project.id, title: "Dependent" });
  const dependencies = createDependencyStore(bb.storage.database(), store.tasks);
  const rpc = Object.fromEntries(Object.keys(tasksRpcContract).map(method => [method, (input: unknown) => harness.callRpc(method, input)]));
  return { bb, harness, store, project, a, b, dependencies, rpc };
}

it("lets the owner add, inspect, open and remove dependencies inside the task", async () => {
  const h = setup();
  const slot = renderSlot(app.navPanels[0]!, { subPath: `task/${h.b.key}` }, { rpc: h.rpc });
  const section = await slot.findByRole("region", { name: "Task dependencies" });
  fireEvent.click(within(section).getByRole("button", { name: "+ Blocked by" }));
  fireEvent.click(await slot.findByRole("option", { name: new RegExp(h.a.key) }));
  await within(section).findByText("Blocked");
  expect(h.dependencies.list(h.b.id).blockedBy[0]?.id).toBe(h.a.id);
  expect(within(section).getByText("Waiting for predecessors to reach Done. Work is still allowed.")).toBeTruthy();
  fireEvent.click(within(section).getByRole("button", { name: `Remove dependency on ${h.a.key}` }));
  await waitFor(() => expect(h.dependencies.list(h.b.id).blockedBy).toHaveLength(0));
  await waitFor(() => expect(within(section).queryByText("Blocked")).toBeNull());
  fireEvent.click(within(section).getByRole("button", { name: "+ Blocks" }));
  fireEvent.click(await slot.findByRole("option", { name: new RegExp(h.a.key) }));
  await waitFor(() => expect(h.dependencies.list(h.a.id).blockedBy[0]?.id).toBe(h.b.id));
  fireEvent.click(within(section).getByRole("button", { name: new RegExp(`${h.a.key} · Predecessor`) }));
  expect(slot.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "work-board", options: { subPath: `task/${h.a.key}` } });
});

it.each(["board", "list"])("shows blockers on the %s and refreshes after a predecessor reaches Done", async view => {
  const h = setup();
  h.dependencies.add(h.b.id, h.a.id);
  const slot = renderSlot(app.navPanels[0]!, { subPath: `${h.project.id}?view=${view}` }, { rpc: h.rpc });
  const badge = await slot.findByText("Blocked");
  expect(slot.container.querySelector(`[data-task-key="${h.b.key}"]`)?.contains(badge)).toBe(true);
  expect(badge.getAttribute("aria-label")).toContain(h.a.key);
  h.store.tasks.updateTask(h.a.id, { status: "done" });
  // The real backend fans out tasks:changed to dependency neighbours; the UI runtime consumes that signal.
  await slot.behavior.emitRealtime("tasks:changed", { taskId: h.b.id, projectId: h.project.id });
  await waitFor(() => expect(slot.queryByText("Blocked")).toBeNull());
});
