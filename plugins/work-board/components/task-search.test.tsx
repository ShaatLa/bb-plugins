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
import { rpcInput, taskTab } from "../test-fixtures";
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
    name: "Example",
    prefix: "EXA",
    color: "purple",
    linkedBbProjectId: "proj_example",
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
  it.each(["main", "side"])("searches 250 tasks immediately with all subsequent RPCs blocked (%s)", async (surface) => {
    const { store, project, rpc } = setup();
    for (let index = 9; index < 250; index++) store.tasks.createTask({
      projectId: project.id, title: `Bulk card ${index}`, description: `Performance needle ${"Saved acceptance criteria. ".repeat(30)}`,
    });
    const options = { rpc, sdk: { threads: { get: async () => makeThreadResponse({ id: "thr_search", projectId: "proj_example" }) } } };
    const slot = surface === "main"
      ? renderSlot(app.navPanels[0]!, { subPath: `${project.id}?view=list` }, options)
      : renderSlot(taskTab(app), { threadId: "thr_search", environment: null }, options);
    const input = await slot.findByRole("combobox", { name: "Search tasks" });
    // Readiness: a body-only term can match only after the full description read has landed.
    fireEvent.change(input, { target: { value: "Performance needle" } });
    await slot.findAllByRole("option", { name: /Bulk card/ });
    await waitFor(() => expect(slot.queryByText("Searching descriptions…")).toBeNull());
    const pending = new Promise<never>(() => {});
    for (const method of Object.keys(rpc)) rpc[method] = () => pending;
    const before = slot.rpcCalls.length;
    // A loose wall-clock budget: the suite runs files in parallel workers sharing the CPU; the blocked RPCs prove nothing waits on them.
    for (const term of ["176", "Bulk card 12", "8", "Performance needle", "176"]) {
      const started = performance.now();
      fireEvent.change(input, { target: { value: term } });
      expect(slot.getAllByRole("option").length).toBeGreaterThan(0);
      expect(slot.queryByText("Searching tasks…")).toBeNull();
      expect(performance.now() - started).toBeLessThan(1000);
    }
    expect(slot.rpcCalls).toHaveLength(before);
  });

  it("resolves historical task keys after moving a task to another project", async () => {
    const { store, child, rpc } = setup();
    const other = store.tasks.createProject({ name: "Other", prefix: "OTH", color: "blue" });
    await rpc.moveTaskToProject!({ taskId: child.id, projectId: other.id });
    const slot = renderSlot(app.navPanels[0]!, { subPath: "all" }, { rpc });
    fireEvent.change(await slot.findByRole("combobox", { name: "Search tasks" }), { target: { value: "EXA-8" } });
    await slot.findByRole("option", { name: /OTH-1.*Find nested needle/ });
    expect(slot.rpcCalls).toContainEqual({ method: "getTaskByKey", input: { taskKey: "EXA-8" } });
  });

  it.each(["main", "side"])("looks up a task number directly in the %s project view", async (surface) => {
    const { project, rpc } = setup();
    const options = { rpc, sdk: { threads: { get: async () => makeThreadResponse({ id: "thr_search", projectId: "proj_example" }) } } };
    const slot = surface === "main"
      ? renderSlot(app.navPanels[0]!, { subPath: `${project.id}?view=list` }, options)
      : renderSlot(taskTab(app), { threadId: "thr_search", environment: null }, options);
    const input = await slot.findByRole("combobox", { name: "Search tasks" });
    input.focus();
    fireEvent.change(input, { target: { value: "8" } });
    await slot.findByRole("option", { name: /EXA-8.*Find nested needle/ });
    expect(slot.rpcCalls.filter((call) => call.method === "getTaskByKey")).toHaveLength(0);
    expect(slot.rpcCalls.filter((call) => call.method === "listTasks" && rpcInput(call.input).search)).toHaveLength(0);
    expect(input.parentElement?.classList.contains("focus-within:ring-inset")).toBe(true);
  });

  it("keeps results visible during realtime refresh and reuses recent searches while revalidating", async () => {
    const { project, child, rpc } = setup();
    const get = rpc.getTask!;
    let blocked = false;
    let waiting = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    rpc.getTask = async (input) => {
      if (blocked && rpcInput(input).taskId === child.id) {
        waiting++;
        await gate;
      }
      return get(input);
    };
    const slot = renderSlot(app.navPanels[0]!, { subPath: `${project.id}?view=list` }, { rpc });
    const input = await slot.findByRole("combobox", { name: "Search tasks" });
    fireEvent.change(input, { target: { value: "needle" } });
    await slot.findByRole("option", { name: /EXA-8/ });
    blocked = true;
    try {
      await slot.behavior.emitRealtime("tasks:changed", { taskId: child.id });
      await waitFor(() => expect(waiting).toBeGreaterThan(0));
      expect(slot.getByRole("option", { name: /EXA-8/ })).toBeDefined();
      expect(slot.queryByText("Searching tasks…")).toBeNull();
      fireEvent.change(input, { target: { value: "Other work" } });
      await slot.findByRole("option", { name: /EXA-1/ });
      fireEvent.keyDown(input, { key: "Escape" });
      await waitFor(() => expect(slot.queryByRole("listbox")).toBeNull());
      fireEvent.focus(input);
      expect(slot.getByRole("option", { name: /EXA-1/ })).toBeDefined();
      fireEvent.change(input, { target: { value: "needle" } });
      expect(slot.getByRole("option", { name: /EXA-8/ })).toBeDefined();
      expect(slot.queryByText("Searching tasks…")).toBeNull();
    } finally { release(); }
  });

  it("shows only 25 matches without a server request for each search", async () => {
    const { store, project, rpc } = setup();
    for (let index = 0; index < 30; index++) store.tasks.createTask({ projectId: project.id, title: `Broad match ${index}` });
    const slot = renderSlot(app.navPanels[0]!, { subPath: `${project.id}?view=list` }, { rpc });
    fireEvent.change(await slot.findByRole("combobox", { name: "Search tasks" }), { target: { value: "Broad match" } });
    await slot.findByText("Showing the first 25 matches. Refine your search to find more.");
    expect(slot.getAllByRole("option")).toHaveLength(25);
    expect(slot.rpcCalls.filter((call) => call.method === "listTasks" && rpcInput(call.input).search)).toHaveLength(0);
  });

  it("finds EXA-8 despite board filters and opens the sub-task in the same thread panel with Enter", async () => {
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
    const slot = renderSlot(taskTab(app), { threadId: "thr_search", environment: null }, {
        sdk: {
          threads: {
            get: async () =>
              makeThreadResponse({ id: "thr_search", projectId: "proj_example" }),
          },
        },
        rpc,
      });
    const input = await slot.findByRole("combobox", { name: "Search tasks" });
    expect(input.tagName).toBe("INPUT");
    expect(slot.queryByRole("button", { name: "Search tasks" })).toBeNull();
    expect(slot.queryByRole("listbox")).toBeNull();
    input.focus();
    expect(slot.queryByRole("listbox")).toBeNull();
    fireEvent.change(input, { target: { value: "  exa-8  " } });
    await slot.findByRole("option", { name: /EXA-8.*Find nested needle/ });
    expect(document.activeElement).toBe(input);
    expect(slot.rpcCalls.filter((call) => call.method === "getTaskByKey")).toHaveLength(0);
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
      { subPath: `${project.id}?view=list` },
      { rpc },
    );
    const input = await slot.findByRole("combobox", { name: "Search tasks" });
    input.focus();
    expect(slot.queryByRole("listbox")).toBeNull();
    fireEvent.change(input, { target: { value: "Acceptance criteria" } });
    await slot.findByRole("option", { name: /EXA-8.*Find nested needle/ });
    expect(document.activeElement).toBe(input);
    expect(slot.queryByRole("option", { name: /OTH-/ })).toBeNull();
    const searchCalls = slot.rpcCalls.filter(
      (call) => call.method === "listTasks" && rpcInput(call.input).archive === "active",
    );
    // One light read (no bodies) for the list and one lazily loaded body read for the description term.
    expect(searchCalls).toHaveLength(2);
    expect(searchCalls.filter((call) => rpcInput(call.input).omitBodies === true)).toHaveLength(1);
    expect(
      searchCalls.every(
        (call) =>
          rpcInput(call.input).projectId === project.id &&
          rpcInput(call.input).parentTaskId === undefined &&
          rpcInput(call.input).type === undefined,
      ),
    ).toBe(true);
    fireEvent.change(input, { target: { value: "Large milestone" } });
    expect(slot.queryByRole("option", { name: /EXA-8/ })).toBeNull();
    fireEvent.click(
      await slot.findByRole("option", { name: /EXA-9.*Large milestone/ }),
    );
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "work-board",
      options: { subPath: "task/EXA-9" },
    });
  });

  it("shows empty results, retries a failed search and dismisses results without losing input", async () => {
    const { project, child, rpc } = setup();
    const list = rpc.listTasks!;
    let failed = true;
    rpc.listTasks = async (input) => {
      if (rpcInput(input).archive === "active" && failed)
        throw new Error("Search temporarily unavailable");
      return list(input);
    };
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: `${project.id}?view=list` },
      { rpc },
    );
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
    expect(slot.queryByRole("listbox")).toBeNull();
    expect(
      await slot.findByRole("combobox", { name: "Search tasks" }),
    ).toHaveProperty("value", "no such task exists");
    fireEvent.change(input, { target: { value: "" } });
    expect(slot.queryByRole("listbox")).toBeNull();
  });

  describe("description reads", () => {
    const fullCalls = (slot: { rpcCalls: Array<{ method: string; input: unknown }> }) =>
      slot.rpcCalls.filter((call) => call.method === "listTasks" && rpcInput(call.input).archive === "active" && rpcInput(call.input).omitBodies !== true);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 450));
    const openMain = (project: { id: string }, rpc: Record<string, (input: unknown) => Promise<unknown>>) =>
      renderSlot(app.navPanels[0]!, { subPath: `${project.id}?view=list` }, { rpc });

    it("makes no body read on mount or for an exact key, and exactly one for a description term", async () => {
      const { project, rpc } = setup();
      const slot = openMain(project, rpc);
      const input = await slot.findByRole("combobox", { name: "Search tasks" });
      await settle();
      expect(fullCalls(slot)).toHaveLength(0);
      fireEvent.change(input, { target: { value: "8" } });
      await slot.findByRole("option", { name: /EXA-8/ });
      await settle();
      expect(fullCalls(slot)).toHaveLength(0);
      fireEvent.change(input, { target: { value: "Acceptance criteria" } });
      await slot.findByRole("option", { name: /EXA-8/ });
      fireEvent.change(input, { target: { value: "Acceptance criteria nested" } });
      await settle();
      expect(fullCalls(slot)).toHaveLength(1);
      // Cleared: no reads on realtime signals; reopening reads once more.
      fireEvent.change(input, { target: { value: "" } });
      await slot.behavior.emitRealtime("tasks:changed", { taskId: project.id });
      await slot.behavior.emitRealtime("projects:changed", {});
      await settle();
      expect(fullCalls(slot)).toHaveLength(1);
      fireEvent.change(input, { target: { value: "Acceptance" } });
      await slot.findByRole("option", { name: /EXA-8/ });
      expect(fullCalls(slot)).toHaveLength(2);
    });

    it("resolves a task number from the project scope before listProjects supplies the prefix", async () => {
      const { project, rpc } = setup();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const listProjects = rpc.listProjects!;
      rpc.listProjects = async (input) => { await gate; return listProjects(input); };
      const slot = openMain(project, rpc);
      const input = await slot.findByRole("combobox", { name: "Search tasks" });
      await waitFor(() => expect(slot.rpcCalls.some((call) => call.method === "listTasks")).toBe(true));
      await settle();
      fireEvent.change(input, { target: { value: "8" } });
      await settle();
      expect(slot.getByRole("option", { name: /EXA-8/ })).toBeDefined();
      expect(fullCalls(slot)).toHaveLength(0);
      release();
    });

    it("matches Cyrillic descriptions case-insensitively", async () => {
      const { store, project, rpc } = setup();
      store.tasks.createTask({ projectId: project.id, title: "Localized card", description: "Привет Мир" });
      const slot = openMain(project, rpc);
      fireEvent.change(await slot.findByRole("combobox", { name: "Search tasks" }), { target: { value: "привет мир" } });
      await slot.findByRole("option", { name: /Localized card/ });
    });

    it("keeps light rows searchable while a held second page of the body read loads", async () => {
      const { store, project, rpc } = setup();
      const keys: string[] = [];
      store.transaction(() => { for (let index = 0; index < 520; index++) keys.push(store.tasks.createTask({ projectId: project.id, title: `Bulk ${index}`, description: index === 3 ? "Unique zebra mention" : "" }).key); });
      const lastKey = keys[keys.length - 1]!;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let secondFullPage = 0;
      const listTasks = rpc.listTasks!;
      rpc.listTasks = async (input) => {
        const parsed = rpcInput(input);
        if (parsed.cursor && parsed.omitBodies !== true) { secondFullPage++; await gate; }
        return listTasks(input);
      };
      const slot = openMain(project, rpc);
      const input = await slot.findByRole("combobox", { name: "Search tasks" });
      // The complete light index (both pages) is loaded before the body read starts.
      await waitFor(() => expect(slot.rpcCalls.filter((call) => call.method === "listTasks" && rpcInput(call.input).omitBodies === true && rpcInput(call.input).cursor)).toHaveLength(1));
      await settle();
      fireEvent.change(input, { target: { value: "zebra" } });
      await waitFor(() => expect(secondFullPage).toBe(1));
      // Page two of the body read is held: a key that exists only on light page two still resolves, with no alias lookup.
      fireEvent.change(input, { target: { value: lastKey } });
      await slot.findByRole("option", { name: new RegExp(lastKey) });
      expect(slot.rpcCalls.filter((call) => call.method === "getTaskByKey")).toHaveLength(0);
      fireEvent.change(input, { target: { value: "zebra" } });
      await slot.findByText("Searching descriptions…");
      expect(slot.queryByText("No matching tasks.")).toBeNull();
      release();
      await slot.findByRole("option", { name: /Bulk 3/ });
    });

    it("waits for a held light page before reading bodies for a key on that page", async () => {
      const { store, project, rpc } = setup();
      const keys: string[] = [];
      store.transaction(() => { for (let index = 0; index < 520; index++) keys.push(store.tasks.createTask({ projectId: project.id, title: `Bulk ${index}` }).key); });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const listTasks = rpc.listTasks!;
      rpc.listTasks = async (input) => {
        if (rpcInput(input).cursor && rpcInput(input).omitBodies === true) await gate;
        return listTasks(input);
      };
      const slot = openMain(project, rpc);
      const input = await slot.findByRole("combobox", { name: "Search tasks" });
      await waitFor(() => expect(slot.rpcCalls.filter((call) => call.method === "listTasks").length).toBeGreaterThan(0));
      const lastKey = keys[keys.length - 1]!;
      fireEvent.change(input, { target: { value: lastKey } });
      await settle();
      expect(fullCalls(slot)).toHaveLength(0);
      release();
      await slot.findByRole("option", { name: new RegExp(lastKey) });
      await settle();
      expect(fullCalls(slot)).toHaveLength(0);
    });

    it("reads bodies once for a key that is absent after the light index settled", async () => {
      const { store, project, rpc } = setup();
      store.tasks.createTask({ projectId: project.id, title: "Mentions", description: "see ZZZ-999 for context" });
      const slot = openMain(project, rpc);
      const input = await slot.findByRole("combobox", { name: "Search tasks" });
      await waitFor(() => expect(slot.rpcCalls.some((call) => call.method === "listTasks")).toBe(true));
      await settle();
      fireEvent.change(input, { target: { value: "ZZZ-999" } });
      await waitFor(() => expect(slot.rpcCalls.some((call) => call.method === "getTaskByKey")).toBe(true));
      // The alias miss is fast; the scheduled body read keeps the result pending instead of an empty one.
      expect(slot.queryByText("No matching tasks.")).toBeNull();
      expect(slot.queryByText("Searching tasks…")).not.toBeNull();
      await slot.findByRole("option", { name: /Mentions/ });
      expect(fullCalls(slot)).toHaveLength(1);
    });

    it("types a key character by character without a body read", async () => {
      const { project, rpc } = setup();
      const slot = openMain(project, rpc);
      const input = await slot.findByRole("combobox", { name: "Search tasks" });
      await settle();
      for (const value of ["E", "EX", "EXA", "EXA-", "EXA-8"]) fireEvent.change(input, { target: { value } });
      await slot.findByRole("option", { name: /EXA-8/ });
      await settle();
      expect(fullCalls(slot)).toHaveLength(0);
    });

    it("shows a body read failure with Retry, recovers on Retry and does not leak into a later exact lookup", async () => {
      const { project, rpc } = setup();
      const listTasks = rpc.listTasks!;
      let failing = true;
      rpc.listTasks = async (input) => {
        if (failing && rpcInput(input).omitBodies !== true) throw new Error("body read failed");
        return listTasks(input);
      };
      const slot = openMain(project, rpc);
      const input = await slot.findByRole("combobox", { name: "Search tasks" });
      fireEvent.change(input, { target: { value: "Acceptance criteria" } });
      await slot.findByText("body read failed");
      expect(slot.queryByText("No matching tasks.")).toBeNull();
      fireEvent.change(input, { target: { value: "" } });
      fireEvent.change(input, { target: { value: "EXA-8" } });
      await slot.findByRole("option", { name: /EXA-8/ });
      expect(slot.queryByText("body read failed")).toBeNull();
      expect(slot.queryByRole("button", { name: "Retry" })).toBeNull();
      fireEvent.change(input, { target: { value: "Acceptance criteria" } });
      await slot.findByText("body read failed");
      failing = false;
      fireEvent.click(slot.getByRole("button", { name: "Retry" }));
      await slot.findByRole("option", { name: /EXA-8/ });
    });

    it("starts its own body read after the box was cleared and ignores the abandoned read's failure", async () => {
      const { project, rpc } = setup();
      const listTasks = rpc.listTasks!;
      const held: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
      rpc.listTasks = (input) => rpcInput(input).omitBodies === true ? listTasks(input)
        : new Promise((resolve, reject) => { held.push({ resolve: () => void listTasks(input).then(resolve), reject }); });
      const slot = openMain(project, rpc);
      const input = await slot.findByRole("combobox", { name: "Search tasks" });
      fireEvent.change(input, { target: { value: "Acceptance criteria" } });
      await waitFor(() => expect(held).toHaveLength(1));
      fireEvent.change(input, { target: { value: "" } });
      fireEvent.change(input, { target: { value: "Acceptance" } });
      // The new lookup must not join the abandoned read.
      await waitFor(() => expect(held).toHaveLength(2));
      held[1]!.resolve();
      await slot.findByRole("option", { name: /EXA-8/ });
      held[0]!.reject(new Error("stale failure"));
      await settle();
      expect(slot.queryByText("stale failure")).toBeNull();
      expect(slot.getByRole("option", { name: /EXA-8/ })).toBeDefined();
    });

    it("keeps a new multi-page body read independent of an abandoned one that fails on page two", async () => {
      const { store, project, rpc } = setup();
      store.transaction(() => { for (let index = 0; index < 520; index++) store.tasks.createTask({ projectId: project.id, title: `Bulk ${index}` }); });
      const listTasks = rpc.listTasks!;
      const held: Array<{ cursor: unknown; resolve: () => void; reject: (error: Error) => void }> = [];
      rpc.listTasks = (input) => rpcInput(input).omitBodies === true ? listTasks(input)
        : new Promise((resolve, reject) => { held.push({ cursor: rpcInput(input).cursor, resolve: () => void listTasks(input).then(resolve), reject }); });
      const slot = openMain(project, rpc);
      const input = await slot.findByRole("combobox", { name: "Search tasks" });
      await waitFor(() => expect(slot.rpcCalls.some((call) => call.method === "listTasks" && rpcInput(call.input).cursor)).toBe(true));
      await settle();
      fireEvent.change(input, { target: { value: "Acceptance criteria" } });
      await waitFor(() => expect(held).toHaveLength(1));              // A page 1
      fireEvent.change(input, { target: { value: "" } });
      fireEvent.change(input, { target: { value: "Acceptance" } });
      await waitFor(() => expect(held).toHaveLength(2));              // B page 1 is its own request
      held[0]!.resolve();
      await waitFor(() => expect(held).toHaveLength(3));              // A page 2
      held[1]!.resolve();
      await waitFor(() => expect(held).toHaveLength(4));              // B page 2 does not join A's page 2
      held[2]!.reject(new Error("abandoned failure"));
      await settle();
      expect(slot.queryByText("abandoned failure")).toBeNull();
      expect(slot.queryByText("Searching descriptions…") ?? slot.queryByText("Searching tasks…")).not.toBeNull();
      held[3]!.resolve();
      await slot.findByRole("option", { name: /EXA-8/ });
    });

    it("never shows an abandoned read's failure that arrived while the search was cleared", async () => {
      const { project, rpc } = setup();
      const listTasks = rpc.listTasks!;
      const held: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
      rpc.listTasks = (input) => rpcInput(input).omitBodies === true ? listTasks(input)
        : new Promise((resolve, reject) => { held.push({ resolve: () => void listTasks(input).then(resolve), reject }); });
      const slot = openMain(project, rpc);
      const input = await slot.findByRole("combobox", { name: "Search tasks" });
      // Record every node the page ever renders: a stale error can flash between a render and its effects.
      let leaked = false;
      const observer = new MutationObserver((records) => {
        for (const record of records) for (const node of record.addedNodes) if (node.textContent?.includes("stale failure")) leaked = true;
      });
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
      fireEvent.change(input, { target: { value: "Acceptance criteria" } });
      await waitFor(() => expect(held).toHaveLength(1));
      fireEvent.change(input, { target: { value: "" } });
      held[0]!.reject(new Error("stale failure"));
      await settle();
      fireEvent.change(input, { target: { value: "Acceptance" } });
      await waitFor(() => expect(held).toHaveLength(2));
      expect(slot.queryByText("stale failure")).toBeNull();
      expect(slot.queryByRole("button", { name: "Retry" })).toBeNull();
      expect(slot.queryByText("Searching descriptions…") ?? slot.queryByText("Searching tasks…")).not.toBeNull();
      held[1]!.resolve();
      await slot.findByRole("option", { name: /EXA-8/ });
      observer.takeRecords().forEach((record) => record.addedNodes.forEach((node) => { if (node.textContent?.includes("stale failure")) leaked = true; }));
      observer.disconnect();
      expect(leaked).toBe(false);
    });

    it.each(["A rejects after B resolved", "B rejects before A resolves"])("only the latest of two body reads reports its outcome (%s)", async (order) => {
      const { project, rpc } = setup();
      const listTasks = rpc.listTasks!;
      const held: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
      rpc.listTasks = (input) => rpcInput(input).omitBodies === true ? listTasks(input)
        : new Promise((resolve, reject) => { held.push({ resolve: () => void listTasks(input).then(resolve), reject }); });
      const slot = openMain(project, rpc);
      const input = await slot.findByRole("combobox", { name: "Search tasks" });
      fireEvent.change(input, { target: { value: "Acceptance criteria" } });
      await waitFor(() => expect(held).toHaveLength(1));
      // The topbar Refresh drops existing flights (shell/refresh.tsx), so the second read is a new request.
      fireEvent.click(slot.getByRole("button", { name: "Refresh tasks" }));
      await waitFor(() => expect(held).toHaveLength(2));
      if (order === "A rejects after B resolved") {
        held[1]!.resolve();
        await slot.findByRole("option", { name: /EXA-8/ });
        held[0]!.reject(new Error("older failure"));
        await settle();
        expect(slot.queryByText("older failure")).toBeNull();
        expect(slot.getByRole("option", { name: /EXA-8/ })).toBeDefined();
      } else {
        held[1]!.reject(new Error("latest failure"));
        await slot.findByText("latest failure");
        held[0]!.resolve();
        await settle();
        expect(slot.getByText("latest failure")).toBeDefined();
      }
    });

    it("retries a failed historical key lookup", async () => {
      const { store, child, rpc } = setup();
      const other = store.tasks.createProject({ name: "Other", prefix: "OTH", color: "blue" });
      await rpc.moveTaskToProject!({ taskId: child.id, projectId: other.id });
      const getTaskByKey = rpc.getTaskByKey!;
      let failing = true;
      rpc.getTaskByKey = async (input) => {
        if (failing) throw new Error("key lookup failed");
        return getTaskByKey(input);
      };
      const slot = renderSlot(app.navPanels[0]!, { subPath: "all" }, { rpc });
      fireEvent.change(await slot.findByRole("combobox", { name: "Search tasks" }), { target: { value: "EXA-8" } });
      await slot.findByText("key lookup failed");
      failing = false;
      fireEvent.click(slot.getByRole("button", { name: "Retry" }));
      await slot.findByRole("option", { name: /OTH-1/ });
    });
  });
});
