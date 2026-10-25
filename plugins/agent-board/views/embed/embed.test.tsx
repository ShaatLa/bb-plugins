// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { makeTask, rpcInput } from "../../test-fixtures.js";
import { loadListPreference, storeListPreference } from "../list/list-preference.js";

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
    dispatchEvent: () => false,
  });
}

const app = await loadPluginApp(() => import("../../app"));

afterEach(() => { cleanup(); window.localStorage.clear(); });

const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const TASK_ID = "01HZZZZZZZZZZZZZZZZZZZZZT1";

const task = makeTask({
  id: TASK_ID,
  projectId: PROJECT_ID,
  number: 4,
  key: "TSK-4",
  title: "Ship task embeds",
  status: "in_progress",
  priority: "high",
  position: 100,
});

function directiveProps(attributes: Record<string, string>) {
  return {
    attributes,
    source: `::task{key="${attributes.key ?? ""}"}`,
    message: {
      id: "msg_1",
      threadId: "thr_1",
      turnId: "turn_1",
      projectId: null,
    },
    openWorkspaceFile: null,
  };
}

function taskDetailRpc(getTaskByKey: () => { task: typeof task }) {
  return {
    getTaskByKey,
    listProjects: () => ({ projects: [] }),
    getTask: () => ({ task: null }),
    listTasks: () => ({ tasks: [] }),
    listLabels: () => ({ labels: [] }),
    listAttachments: () => ({ attachments: [] }),
    listTaskThreads: () => ({ taskThreads: [] }),
    listPresets: () => ({ presets: [] }),
    listQuestions: () => ({ questions: [] }),
    listComments: () => ({ comments: [] }),
    searchThreads: () => ({ threads: [] }),
  };
}

describe("Task directive card", () => {
  it("renders live task data with a complete accessible name", async () => {
    const slot = renderSlot(
      app.messageDirectives[0]!,
      directiveProps({ key: "TSK-4" }),
      {
        rpc: { getTaskByKey: () => ({ task }) },
      },
    );

    const main = await slot.findByRole("button", {
      name: "TSK-4 — Ship task embeds, in progress, high priority — open in side panel",
    });
    expect(main).toBeTruthy();
    expect(slot.rpcCalls).toContainEqual({
      method: "getTaskByKey",
      input: { taskKey: "TSK-4" },
    });
    expect(slot.getByText("TSK-4").closest("[aria-hidden]")).toBeTruthy();
  });

  it("omits the priority glyph and spoken priority when priority is none", async () => {
    const slot = renderSlot(
      app.messageDirectives[0]!,
      directiveProps({ key: "TSK-4" }),
      {
        rpc: { getTaskByKey: () => ({ task: { ...task, priority: "none" } }) },
      },
    );
    const main = await slot.findByRole("button", {
      name: "TSK-4 — Ship task embeds, in progress — open in side panel",
    });
    expect(main.querySelectorAll("svg")).toHaveLength(1);
  });

  it("opens the side panel on primary click and the Tasks app from the arrow", async () => {
    const openThreadPanel = vi.fn(() => true);
    const slot = renderSlot(
      app.messageDirectives[0]!,
      directiveProps({ key: "TSK-4" }),
      { openThreadPanel, rpc: { getTaskByKey: () => ({ task }) } },
    );

    fireEvent.click(await slot.findByText("Ship task embeds"));
    expect(openThreadPanel).toHaveBeenCalledWith({
      actionId: "task",
      title: "TSK-4",
      params: { taskKey: "TSK-4" },
    });

    fireEvent.click(slot.getByRole("button", { name: "Open TSK-4 in Tasks" }));
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "agent-board",
      options: { subPath: "task/TSK-4" },
    });
  });

  it("falls back to the Tasks app when no side panel is available", async () => {
    const slot = renderSlot(
      app.messageDirectives[0]!,
      directiveProps({ key: "TSK-4" }),
      {
        rpc: { getTaskByKey: () => ({ task }) },
      },
    );
    fireEvent.click(await slot.findByText("Ship task embeds"));
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "agent-board",
      options: { subPath: "task/TSK-4" },
    });
  });

  it("shows the title fallback while loading and keeps it when not found", async () => {
    let resolveFetch: (value: { task: null }) => void;
    const pending = new Promise<{ task: null }>((resolve) => {
      resolveFetch = resolve;
    });
    const slot = renderSlot(
      app.messageDirectives[0]!,
      directiveProps({ key: "TSK-9", title: "Old embed work" }),
      { rpc: { getTaskByKey: () => pending } },
    );

    const loading = slot.getByRole("status", { name: "Loading task TSK-9" });
    expect(loading.textContent).toContain("Old embed work");

    resolveFetch!({ task: null });
    await slot.findByText("Old embed work · not found");
    fireEvent.click(slot.getByRole("button", { name: "Open Agent Board" }));
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "agent-board",
      options: {},
    });
  });

  it("renders the generic not-found copy without a title fallback", async () => {
    const slot = renderSlot(
      app.messageDirectives[0]!,
      directiveProps({ key: "TSK-9" }),
      {
        rpc: { getTaskByKey: () => ({ task: null }) },
      },
    );
    await slot.findByText("Task not found — deleted, or its key changed");
  });

  it("rejects malformed keys without calling the backend", () => {
    const malformed: Record<string, string>[] = [
      {},
      { key: "  " },
      { key: "not a key" },
    ];
    for (const attributes of malformed) {
      const slot = renderSlot(
        app.messageDirectives[0]!,
        directiveProps(attributes),
        {
          rpc: {},
        },
      );
      slot.getByText("Invalid task link. Expected a task key like TSK-4.");
      expect(slot.rpcCalls).toHaveLength(0);
      cleanup();
    }
  });

  it("offers a retry that refetches after a transport error", async () => {
    let fail = true;
    const slot = renderSlot(
      app.messageDirectives[0]!,
      directiveProps({ key: "TSK-4" }),
      {
        rpc: {
          getTaskByKey: () => {
            if (fail) throw new Error("boom");
            return { task };
          },
        },
      },
    );
    const retry = await slot.findByRole("button", { name: "Retry" });
    fail = false;
    fireEvent.click(retry);
    await slot.findByText("Ship task embeds");
  });

  it("refetches on matching realtime payloads and ignores unrelated ones", async () => {
    const slot = renderSlot(
      app.messageDirectives[0]!,
      directiveProps({ key: "TSK-4" }),
      {
        rpc: { getTaskByKey: () => ({ task }) },
      },
    );
    await slot.findByText("Ship task embeds");
    const calls = () =>
      slot.rpcCalls.filter((call) => call.method === "getTaskByKey").length;
    const baseline = calls();

    await slot.emitRealtime("tasks:changed", {
      taskId: "01HZZZZZZZZZZZZZZZZZZZZZT9",
      projectId: PROJECT_ID,
    });
    await slot.emitRealtime("projects:changed", {
      projectId: "01HZZZZZZZZZZZZZZZZZZZZZP9",
    });
    expect(calls()).toBe(baseline);

    await slot.emitRealtime("tasks:changed", {
      taskId: TASK_ID,
      projectId: PROJECT_ID,
    });
    await waitFor(() => expect(calls()).toBe(baseline + 1));

    await slot.emitRealtime("projects:changed", { projectId: PROJECT_ID });
    await waitFor(() => expect(calls()).toBe(baseline + 2));
  });

  it("refetches an unresolved card on any tasks event so new tasks appear", async () => {
    let created = false;
    const slot = renderSlot(
      app.messageDirectives[0]!,
      directiveProps({ key: "TSK-4" }),
      {
        rpc: { getTaskByKey: () => ({ task: created ? task : null }) },
      },
    );
    await slot.findByText("Task not found — deleted, or its key changed");
    created = true;
    await slot.emitRealtime("tasks:changed", {
      taskId: TASK_ID,
      projectId: PROJECT_ID,
    });
    await slot.findByText("Ship task embeds");
  });
});

describe("Task embed panel", () => {
  it("keeps an aliased task in the side panel until the user opens Tasks", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_1", params: { taskKey: "OLD-4" } },
      { rpc: taskDetailRpc(() => ({ task })) },
    );
    await slot.findByRole("textbox", { name: "Task title" });
    expect(slot.navigateCalls).toEqual([]);
    fireEvent.click(slot.getByRole("button", { name: "Open OLD-4 in Tasks" }));
    expect(slot.navigateCalls).toEqual([
      {
        method: "toPluginPanel",
        path: "agent-board",
        options: { subPath: "task/OLD-4" },
      },
    ]);
  });

  it("resyncs the embedded task detail after reconnect", async () => {
    let title = "Stale embedded detail";
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_1", params: { taskKey: "TSK-4" } },
      {
        realtimeConnectionState: "connected",
        rpc: taskDetailRpc(() => ({ task: { ...task, title } })),
      },
    );
    await slot.findByText("Stale embedded detail");

    title = "Recovered embedded detail";
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    expect(slot.queryByText("Recovered embedded detail")).toBeNull();
    await slot.behavior.setRealtimeConnectionState("connected");
    await slot.findByText("Recovered embedded detail");
  });

  it("shows the board linked to the panel's thread, regardless of the current route or last project", async () => {
    const getThread = vi.fn(async () => makeThreadResponse({ id: "thr_1", projectId: "proj_thread" }));
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thr_1", params: null }, {
      context: { projectId: "proj_unrelated", threadId: "thr_unrelated" },
      sdk: { threads: { get: getThread } },
      rpc: boardRpc(),
    });
    await slot.findByText("Linked project board");
    await slot.findByRole("button", { name: "New Todo task" });
    expect(getThread).toHaveBeenCalledWith({ threadId: "thr_1" });
    expect(slot.rpcCalls.filter((call) => call.method === "listTasks").every((call) => rpcInput(call.input).projectId === PROJECT_ID)).toBe(true);
    expect(slot.navigateCalls).toEqual([]);
    expect(app.threadPanelActions[0]!.layout).toBe("flush");
  });

  it("opens a board card in this panel and returns to its board", async () => {
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thr_1", params: null }, {
      sdk: { threads: { get: async () => makeThreadResponse({ id: "thr_1", projectId: "proj_thread" }) } },
      rpc: boardRpc(),
    });
    fireEvent.click(await slot.findByText(task.title));
    await slot.findByRole("textbox", { name: "Task title" });
    expect(slot.navigateCalls).toEqual([]);
    const heading = slot
      .getByRole("button", { name: "Back to project board" })
      .closest("header")!;
    expect(heading.getAttribute("aria-label")).toBe("Task heading");
    expect(
      heading.parentElement!.contains(
        slot.getByRole("button", { name: "Copy task key" }),
      ),
    ).toBe(true);
    expect(slot.getAllByText(task.key)).toHaveLength(1);
    fireEvent.click(slot.getByRole("button", { name: "Back to project board" }));
    await slot.findByRole("button", { name: "New Todo task" });
    expect(slot.navigateCalls).toEqual([]);
    fireEvent.click(slot.getByRole("button", { name: "Open board in Tasks" }));
    expect(slot.navigateCalls).toEqual([{ method: "toPluginPanel", path: "agent-board", options: { subPath: `${PROJECT_ID}?view=board` } }]);
  });

  it("filters the thread board by type, status, priority and label, preserving filters after opening a task", async () => {
    const label = { id: "01HZZZZZZZZZZZZZZZZZZZZZL1", projectId: PROJECT_ID, name: "Bug", color: "red" };
    const selected = { ...task, labelIds: [label.id] };
    const epic = makeTask({ id: "01HZZZZZZZZZZZZZZZZZZZZZT2", key: "TSK-2", projectId: PROJECT_ID, title: "Epic milestone", type: "epic", status: "todo", priority: "low" });
    const other = makeTask({ id: "01HZZZZZZZZZZZZZZZZZZZZZT3", key: "TSK-3", projectId: PROJECT_ID, title: "Other work", status: "todo", priority: "low" });
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thr_1", params: null }, {
      sdk: { threads: { get: async () => makeThreadResponse({ id: "thr_1", projectId: "proj_thread" }) } },
      rpc: {
        ...boardRpc(),
        listLabels: () => ({ labels: [label] }),
        listTasks: (raw: unknown) => ({ tasks: rpcInput(raw).activeOnly ? [] : [selected, epic, other], nextCursor: null }),
      },
    });
    await slot.findByText(epic.title);
    const choose = async (name: string, option: string) => {
      fireEvent.keyDown(slot.getByRole("button", { name: new RegExp(`^${name}`) }), { key: "ArrowDown" });
      fireEvent.click(await slot.findByRole("menuitemcheckbox", { name: option }));
      fireEvent.keyDown(slot.container.ownerDocument, { key: "Escape" });
    };
    await choose("Type", "Epic");
    expect(slot.queryByText(selected.title)).toBeNull();
    expect(slot.queryByText(other.title)).toBeNull();
    await choose("Type", "All");
    expect(slot.getByText(selected.title)).toBeTruthy();
    expect(slot.getByText(other.title)).toBeTruthy();
    expect(slot.getByText(epic.title)).toBeTruthy();
    expect(loadListPreference(`project:${PROJECT_ID}`).filters.type).toBeUndefined();
    await choose("Status", "In Progress");
    expect(slot.queryByText(other.title)).toBeNull();
    await choose("Type", "Epic");
    expect(slot.queryByText(selected.title)).toBeNull();
    await choose("Type", "All");
    expect(slot.getByText(selected.title)).toBeTruthy();
    expect(slot.queryByText(other.title)).toBeNull();
    expect(loadListPreference(`project:${PROJECT_ID}`).filters.statuses).toEqual(["in_progress"]);
    fireEvent.click(slot.getByRole("button", { name: "Clear" }));
    await choose("Priority", "High");
    expect(slot.queryByText(epic.title)).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Clear" }));
    await choose("Label", "Bug");
    expect(slot.queryByText(other.title)).toBeNull();
    expect(slot.queryByText(epic.title)).toBeNull();
    expect(slot.getByText("1 task")).toBeTruthy();
    fireEvent.click(slot.getByText(selected.title));
    await slot.findByRole("textbox", { name: "Task title" });
    fireEvent.click(slot.getByRole("button", { name: "Back to project board" }));
    await slot.findByRole("button", { name: /^Label.*Bug/ });
    await slot.findByText(selected.title);
    expect(slot.queryByText(other.title)).toBeNull();
    expect(loadListPreference(`project:${PROJECT_ID}`).filters.labelNames).toEqual(["Bug"]);
    fireEvent.click(slot.getByRole("button", { name: "Clear" }));
    await slot.findByText(other.title);
    await slot.findByText(epic.title);
    expect(slot.navigateCalls).toEqual([]);
  });

  it("hides every card for a saved label that is no longer available", async () => {
    storeListPreference(`project:${PROJECT_ID}`, {
      filters: { statuses: [], priorities: [], labelNames: ["Removed label"] }, sort: "manual",
    });
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thr_1", params: null }, {
      sdk: { threads: { get: async () => makeThreadResponse({ id: "thr_1", projectId: "proj_thread" }) } },
      rpc: boardRpc(),
    });
    await slot.findByRole("button", { name: /^Label.*Removed label/ });
    expect(slot.queryByText(task.title)).toBeNull();
    expect(slot.getByText("0 tasks")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Clear" }));
    await slot.findByText(task.title);
  });

  it("uses visible neighbors for a filtered drag and retains hidden cards", async () => {
    storeListPreference(`project:${PROJECT_ID}`, {
      filters: { statuses: [], priorities: ["high"], labelNames: [] }, sort: "manual",
    });
    const hidden = makeTask({ id: "01HZZZZZZZZZZZZZZZZZZZZZT2", projectId: PROJECT_ID, key: "TSK-2", title: "Hidden low priority", status: "todo", priority: "low", position: 100 });
    const target = makeTask({ id: "01HZZZZZZZZZZZZZZZZZZZZZT3", projectId: PROJECT_ID, key: "TSK-3", title: "Visible high priority", status: "todo", priority: "high", position: 200 });
    const boardMove = vi.fn(() => ({ ok: true, task: { ...task, status: "todo" } }));
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thr_1", params: null }, {
      sdk: { threads: { get: async () => makeThreadResponse({ id: "thr_1", projectId: "proj_thread" }) } },
      rpc: {
        ...boardRpc(), boardMove,
        listTasks: (raw: unknown) => ({ tasks: rpcInput(raw).activeOnly ? [] : [hidden, target, task], nextCursor: null }),
      },
    });
    const dragged = (await slot.findByText(task.title)).closest<HTMLElement>("[data-task-key]")!;
    const targetCard = slot.getByText(target.title).closest<HTMLElement>("[data-task-key]")!;
    const column = slot.container.querySelector<HTMLElement>('[data-board-column="todo"]')!;
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 230, bottom: 300, width: 230, height: 300, toJSON() {} };
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute("data-board-column") && this !== column) return { ...rect, left: 300, right: 530 };
      return this === targetCard ? { ...rect, top: 80, bottom: 120, height: 40 } : rect;
    });
    try {
      fireEvent.pointerDown(dragged, { button: 0, clientX: 10, clientY: 150 });
      fireEvent.pointerMove(window, { clientX: 10, clientY: 40 });
      fireEvent.pointerUp(window, { clientX: 10, clientY: 40 });
      await waitFor(() => expect(boardMove).toHaveBeenCalledTimes(1));
      expect(boardMove.mock.calls[0]).toEqual([{
        taskId: task.id, status: "todo", beforeTaskId: null, afterTaskId: target.id, authorName: "You",
      }]);
      expect(Array.from(column.querySelectorAll("[data-task-key]"), (card) => card.getAttribute("data-task-key"))).toEqual([task.key, target.key]);
      fireEvent.click(slot.getByRole("button", { name: "Clear" }));
      expect(Array.from(column.querySelectorAll("[data-task-key]"), (card) => card.getAttribute("data-task-key"))).toEqual([hidden.key, task.key, target.key]);
    } finally {
      rectSpy.mockRestore();
    }
  });

  it("keeps task links from messages working and offers a return to the thread's board", async () => {
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thr_1", params: { taskKey: task.key } }, {
      sdk: { threads: { get: async () => makeThreadResponse({ id: "thr_1", projectId: "proj_thread" }) } },
      rpc: boardRpc(),
    });
    await slot.findByRole("textbox", { name: "Task title" });
    fireEvent.click(slot.getByRole("button", { name: "Back to project board" }));
    await slot.findByRole("button", { name: "New Todo task" });
    expect(slot.navigateCalls).toEqual([]);
  });

  it("opens newly created tasks in this panel", async () => {
    const creates: Record<string, unknown>[] = [];
    const created = makeTask({ id: "01HZZZZZZZZZZZZZZZZZZZZZT9", key: "TSK-9", title: "Created in the thread board" });
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thr_1", params: null }, {
      sdk: { threads: { get: async () => makeThreadResponse({ id: "thr_1", projectId: "proj_thread" }) } },
      rpc: {
        ...boardRpc(),
        createTask: (raw: unknown) => { creates.push(rpcInput(raw)); return { ok: true, task: created }; },
        getTaskByKey: () => ({ task: created }),
      },
    });
    fireEvent.click(await slot.findByRole("button", { name: "New Todo task" }));
    fireEvent.change(await slot.findByLabelText("Task title"), { target: { value: created.title } });
    const submit = slot.getByRole("button", { name: "Create task" });
    await waitFor(() => expect(submit).toHaveProperty("disabled", false));
    fireEvent.click(submit);
    await waitFor(() => expect(creates).toHaveLength(1));
    expect(creates[0]).toMatchObject({ projectId: PROJECT_ID, title: created.title });
    await slot.findByRole("button", { name: "Open TSK-9 in Tasks" });
    expect(slot.navigateCalls).toEqual([]);
  });

  it("explains a missing project link instead of showing another project's board", async () => {
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thr_1", params: null }, {
      sdk: { threads: { get: async () => makeThreadResponse({ id: "thr_1", projectId: "proj_unlinked" }) } },
      rpc: boardRpc(),
    });
    await slot.findByText("No Tasks project is linked to this thread's bb project.");
    expect(slot.rpcCalls.filter((call) => call.method === "listTasks")).toHaveLength(0);
    fireEvent.click(slot.getByRole("button", { name: "Manage projects" }));
    expect(slot.navigateCalls).toEqual([{ method: "toPluginPanel", path: "agent-board", options: { subPath: "manage" } }]);
  });

  it("retries a failed thread lookup without blocking task links", async () => {
    let failed = true;
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thr_1", params: null }, {
      sdk: { threads: { get: async () => {
        if (failed) throw new Error("Thread temporarily unavailable");
        return makeThreadResponse({ id: "thr_1", projectId: "proj_thread" });
      } } },
      rpc: boardRpc(),
    });
    expect((await slot.findByRole("alert")).textContent).toBe("Thread temporarily unavailable");
    failed = false;
    fireEvent.click(slot.getByRole("button", { name: "Retry" }));
    await slot.findByRole("button", { name: "New Todo task" });
  });
});


function boardRpc() {
  const project = {
    id: PROJECT_ID, name: "Linked project board", prefix: "TSK", nextTaskNumber: 5,
    color: "purple", folderId: null, linkedBbProjectId: "proj_thread", createdAt: task.createdAt,
  };
  return {
    ...taskDetailRpc(() => ({ task })),
    listProjects: () => ({ projects: [
      { ...project, id: "01HZZZZZZZZZZZZZZZZZZZZZP2", name: "Unrelated project", prefix: "OTHER", linkedBbProjectId: "proj_other" },
      project,
    ] }),
    listTasks: (raw: unknown) => {
      const input = rpcInput(raw);
      return { tasks: input.activeOnly || input.parentTaskId || input.type === "epic" ? [] : [task], nextCursor: null };
    },
    listTaskPullRequests: () => ({ pullRequests: [], unavailableThreadIds: [] }),
    listBbProjects: () => ({ bbProjects: [] }),
  };
}
