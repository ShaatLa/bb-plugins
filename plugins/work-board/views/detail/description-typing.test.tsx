// @vitest-environment jsdom
import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createFakePluginHost, type FakePluginHarness } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createStore, registerTasksApi } from "../../api";
import { tasksRpcContract } from "../../shared/contract";

const renders = vi.hoisted(() => ({ dependencies: 0 }));
vi.mock("./dependencies", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dependencies")>();
  return {
    ...actual,
    DependenciesSection: (props: Parameters<typeof actual.DependenciesSection>[0]) => {
      renders.dependencies++;
      return actual.DependenciesSection(props);
    },
  };
});

window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
Element.prototype.scrollIntoView ??= () => {};
const app = await loadPluginApp(() => import("../../app"));
const harnesses: FakePluginHarness[] = [];
afterEach(async () => { cleanup(); localStorage.clear(); await Promise.all(harnesses.splice(0).map(h => h.dispose())); });

it("typing in the description does not rerender sibling sections and saves the exact text", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  harnesses.push(harness);
  const store = createStore(bb);
  registerTasksApi(bb, store);
  const project = store.tasks.createProject({ name: "Typing", prefix: "TYP", color: "blue" });
  const task = store.tasks.createTask({ projectId: project.id, title: "Typed" });
  const rpc = Object.fromEntries(Object.keys(tasksRpcContract).map(method => [method, (input: unknown) => harness.callRpc(method, input)]));
  const slot = renderSlot(app.navPanels[0]!, { subPath: `task/${task.key}` }, { rpc });
  await slot.findByRole("region", { name: "Task dependencies" });
  const surface = slot.container.querySelector(".tiptap") as HTMLElement & { editor: import("@tiptap/core").Editor };
  await new Promise((resolve) => setTimeout(resolve, 200)); // let initial queries settle
  const before = renders.dependencies;
  const text = "TypedOneCharacterAtATime";
  for (const char of text) surface.editor.commands.insertContent(char);
  await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  expect(renders.dependencies).toBe(before);
  await waitFor(() => expect(store.tasks.getTask(task.id)?.description).toBe(text), { timeout: 3000 });
});
