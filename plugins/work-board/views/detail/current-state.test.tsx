// @vitest-environment jsdom
import { cleanup, fireEvent, within, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { createFakePluginHost, type FakePluginHarness } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createStore, registerTasksApi } from "../../api";
import { tasksRpcContract } from "../../shared/contract";

window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
const app = await loadPluginApp(() => import("../../app"));
const harnesses: FakePluginHarness[] = [];
afterEach(async () => { cleanup(); await Promise.all(harnesses.splice(0).map(h => h.dispose())); });

it("renders current state and edits it through updateTask", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  harnesses.push(harness);
  const store = createStore(bb);
  registerTasksApi(bb, store);
  const project = store.tasks.createProject({ name: "State", prefix: "STA", color: "blue" });
  const task = store.tasks.createTask({ projectId: project.id, title: "Current state" });
  const rpc = Object.fromEntries(Object.keys(tasksRpcContract).map(method => [method, (input: unknown) => harness.callRpc(method, input)]));
  const slot = renderSlot(app.navPanels[0]!, { subPath: `task/${task.key}` }, { rpc });
  const section = within(await slot.findByRole("region", { name: "Current state" }));
  expect(section.getByText("No current state yet")).toBeTruthy();
  fireEvent.click(section.getByRole("button", { name: "Edit" }));
  fireEvent.change(section.getByRole("textbox", { name: "Current state note" }), { target: { value: "Ready for review" } });
  fireEvent.click(section.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(store.tasks.getTask(task.id)?.progressNote).toBe("Ready for review"));
  await slot.behavior.emitRealtime("tasks:changed", { taskId: task.id, projectId: project.id });
  await section.findByText("Ready for review");
  expect(section.getByText(/updated .* by You/)).toBeTruthy();
  expect(slot.inspection.rpcCalls).toContainEqual(expect.objectContaining({ method: "updateTask", input: expect.objectContaining({ taskId: task.id, progressNote: "Ready for review" }) }));
  fireEvent.click(section.getByRole("button", { name: "Edit" }));
  fireEvent.change(section.getByRole("textbox"), { target: { value: "Discard" } });
  fireEvent.click(section.getByRole("button", { name: "Cancel" }));
  expect(section.getByText("Ready for review")).toBeTruthy();
});
