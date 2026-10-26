// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  type FakePluginHarness,
} from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createStore, registerTasksApi } from "../api";
import { tasksRpcContract } from "../shared/contract";
import { rpcInput } from "../test-fixtures";
import { storeListPreference } from "../views/list/list-preference";

window.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
const app = await loadPluginApp(() => import("../app"));
const harnesses: FakePluginHarness[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
});

function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  harnesses.push(harness);
  const store = createStore(bb);
  registerTasksApi(bb, store);
  const project = store.tasks.createProject({
    name: "Anvil",
    prefix: "ANV",
    color: "purple",
    linkedBbProjectId: "proj_anvil",
  });
  for (let index = 1; index < 7; index++)
    store.tasks.createTask({
      projectId: project.id,
      title: `Other work ${index}`,
    });
  const parent = store.tasks.createTask({
    projectId: project.id,
    title: "Parent task",
  });
  const child = store.tasks.createTask({
    projectId: project.id,
    parentTaskId: parent.id,
    title: "Find nested needle",
    description: "Acceptance criteria",
    status: "in_review",
  });
  store.tasks.createTask({
    projectId: project.id,
    title: "Large milestone",
    type: "epic",
  });
  const rpc: Record<string, (input: unknown) => Promise<unknown>> =
    Object.fromEntries(
      Object.keys(tasksRpcContract).map((method) => [
        method,
        (input: unknown) => harness.callRpc(method, input),
      ]),
    );
  return { store, project, child, rpc };
}

describe("task search", () => {
  it("finds ANV-8 despite board filters and opens the sub-task in the same thread panel with Enter", async () => {
    const { project, child, rpc } = setup();
    storeListPreference(`project:${project.id}`, {
      filters: {
        type: "epic",
        statuses: ["todo"],
        priorities: [],
        labelNames: [],
      },
      sort: "manual",
    });
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_search", params: null },
      {
        sdk: {
          threads: {
            get: async () =>
              makeThreadResponse({ id: "thr_search", projectId: "proj_anvil" }),
          },
        },
        rpc,
      },
    );
    fireEvent.click(await slot.findByRole("button", { name: "Search tasks" }));
    const input = await slot.findByRole("combobox", { name: "Search tasks" });
    fireEvent.change(input, { target: { value: "  anv-8  " } });
    await slot.findByRole("option", { name: /ANV-8.*Find nested needle/ });
    expect(slot.rpcCalls).toContainEqual({
      method: "getTaskByKey",
      input: { taskKey: "anv-8" },
    });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(
        slot.getByRole("textbox", { name: "Task title" }).textContent,
      ).toBe(child.title),
    );
    expect(slot.navigateCalls).toEqual([]);
  });

  it("searches descriptions and epics from the main list and scopes results to the project", async () => {
    const { store, project, rpc } = setup();
    const foreign = store.tasks.createProject({
      name: "Other",
      prefix: "OTH",
      color: "blue",
    });
    store.tasks.createTask({
      projectId: foreign.id,
      title: "Acceptance criteria",
    });
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: project.id },
      { rpc },
    );
    fireEvent.click(await slot.findByRole("button", { name: "Search tasks" }));
    const input = await slot.findByRole("combobox", { name: "Search tasks" });
    fireEvent.change(input, { target: { value: "Acceptance criteria" } });
    await slot.findByRole("option", { name: /ANV-8.*Find nested needle/ });
    expect(slot.queryByRole("option", { name: /OTH-/ })).toBeNull();
    const searchCalls = slot.rpcCalls.filter(
      (call) => call.method === "listTasks" && rpcInput(call.input).search,
    );
    expect(
      searchCalls.every(
        (call) =>
          rpcInput(call.input).projectId === project.id &&
          rpcInput(call.input).parentTaskId === undefined &&
          rpcInput(call.input).type === undefined,
      ),
    ).toBe(true);
    fireEvent.change(input, { target: { value: "Large milestone" } });
    fireEvent.click(
      await slot.findByRole("option", { name: /ANV-9.*Large milestone/ }),
    );
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "work-board",
      options: { subPath: "task/ANV-9" },
    });
  });

  it("shows empty results, retries a failed search and clears the query on close", async () => {
    const { project, child, rpc } = setup();
    const list = rpc.listTasks!;
    let failed = true;
    rpc.listTasks = async (input) => {
      if (rpcInput(input).search && failed)
        throw new Error("Search temporarily unavailable");
      return list(input);
    };
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: project.id },
      { rpc },
    );
    fireEvent.click(await slot.findByRole("button", { name: "Search tasks" }));
    const input = await slot.findByRole("combobox", { name: "Search tasks" });
    fireEvent.change(input, { target: { value: "needle" } });
    await slot.findByRole("alert");
    failed = false;
    fireEvent.click(slot.getByRole("button", { name: "Retry" }));
    await slot.findByRole("option", { name: new RegExp(child.key) });
    fireEvent.change(input, { target: { value: "no such task exists" } });
    await slot.findByText("No matching tasks.");
    expect(slot.queryByRole("option")).toBeNull();
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.click(slot.getByRole("button", { name: "Search tasks" }));
    expect(
      await slot.findByRole("combobox", { name: "Search tasks" }),
    ).toHaveProperty("value", "");
  });
});
