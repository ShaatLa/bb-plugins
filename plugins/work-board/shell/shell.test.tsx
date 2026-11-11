// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { ExperimentalPanelTabs } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { makeTask, navTab } from "../test-fixtures.js";
import type { Task } from "../shared/contract.js";

const app = await loadPluginApp(() => import("../app"));
const { parseTasksRoute, tasksRouteToSubPath } = await import("./routes.js");
const { pagerPosition } = await import("./topbar.js");
const { loadViewMode, loadLastProjectId } = await import("./view-preference.js");
const { querySnapshotStorageKey, resetQuerySnapshotStateForTest, writeQuerySnapshot } =
  await import("./query-snapshot.js");

const tasksRegistration = app.navPanels[0]!;
const navigationView = navTab(app, "navigation");
const navigationRegistration = {
  ...tasksRegistration,
  component: navigationView.component,
};

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ownTab = (id: "navigation" | "kanban") => ({
  key: `tab-${id}`,
  title: id,
  status: null,
  closable: false,
  detail: {
    kind: "plugin" as const,
    pluginId: "test-plugin",
    tab: { id, context: { kind: "nav-panel" as const, panelId: "work-board" }, availability: "fixed" as const },
    params: null,
  },
});
const browserTab = { key: "tab-browser", title: "Docs", status: null, closable: true, detail: { kind: "browser" as const, url: "https://example.com" } };
const KANBAN_OPEN_CALL = { method: "openTab", options: { tab: { id: "kanban", context: { kind: "nav-panel", panelId: "work-board" }, availability: "fixed" } } };
/** A mutable native panel: mutate it and rerender to simulate host-side tab changes. */
function nativePanel(selectedKey: string | null, open = true, withNavigation = true) {
  const state = {
    open,
    selectedKey,
    tabs: [...(withNavigation ? [ownTab("navigation")] : []), ownTab("kanban"), browserTab],
  };
  return state as ExperimentalPanelTabs & { open: boolean; selectedKey: string | null };
}
const panelOptions = (panel: ExperimentalPanelTabs, overrides: Record<string, unknown> = {}) => ({
  experimental_panelTabs: panel,
  experimental_panel: { openTab: () => true, selectTab: () => true, close: () => true, ...overrides },
});
const pressed = async (slot: { findByRole: (role: "button", options: { name: string }) => Promise<HTMLElement> }, name: "List" | "Board") =>
  (await slot.findByRole("button", { name })).getAttribute("aria-pressed");

const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const OTHER_PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP2";
const FOLDER_ID = "01HZZZZZZZZZZZZZZZZZZZZZF1";

const project = {
  id: PROJECT_ID,
  name: "Tasks Plugin",
  prefix: "TSK",
  nextTaskNumber: 5,
  color: "blue",
  folderId: FOLDER_ID,
  linkedBbProjectId: null,
  createdAt: "2026-07-15T00:00:00.000Z",
};

const folder = {
  id: FOLDER_ID,
  name: "bb",
  parentFolderId: null,
  createdAt: "2026-07-15T00:00:00.000Z",
};

function seededRpc(overrides: Record<string, unknown> = {}) {
  return {
    listProjects: () => ({ projects: [project] }),
    listFolders: () => ({ folders: [folder] }),
    listPresets: () => ({ presets: [] }),
    sidebarSummary: () => ({
      projects: [{ projectId: PROJECT_ID, taskCount: 3, activeAgentCount: 1 }],
    }),
    listTasks: () => ({ tasks: [] }),
    getTaskByKey: () => ({ task: null }),
    ...overrides,
  };
}

const emptyRpc = seededRpc({
  listProjects: () => ({ projects: [] }),
  listFolders: () => ({ folders: [] }),
  sidebarSummary: () => ({ projects: [] }),
});

describe("tasks route grammar", () => {
  it("round-trips every route kind and decodes host-encoded subPaths", () => {
    const routes = [
      { kind: "all" },
      { kind: "active" },
      { kind: "manage" },
      { kind: "task", taskKey: "TSK-4" },
      { kind: "project", projectId: PROJECT_ID, view: "list" },
      { kind: "project", projectId: PROJECT_ID, view: "board" },
      { kind: "project", projectId: PROJECT_ID, view: null },
    ] as const;
    for (const route of routes) {
      expect(parseTasksRoute(tasksRouteToSubPath(route))).toEqual(route);
    }
    expect(parseTasksRoute(`${PROJECT_ID}%3Fview%3Dboard`)).toEqual({
      kind: "project",
      projectId: PROJECT_ID,
      view: "board",
    });
    expect(parseTasksRoute("")).toEqual({ kind: "all" });
    expect(parseTasksRoute(`${PROJECT_ID}?view=kanban`)).toEqual({
      kind: "project",
      projectId: PROJECT_ID,
      view: null,
    });
  });
});

describe("project view preference", () => {
  const openProject = (subPath: string, options: Record<string, unknown> = {}) =>
    renderSlot(
      app.navPanels[0]!,
      { subPath },
      { rpc: seededRpc({ listLabels: () => ({ labels: [] }) }), ...options },
    );

  it("restores the remembered view when the URL names none and opens the native board for it", async () => {
    const listed = openProject(`${PROJECT_ID}?view=list`, panelOptions(nativePanel("tab-navigation")));
    expect(listed.getByRole("button", { name: "Work Board settings" })).toBeTruthy();
    fireEvent.click(await listed.findByRole("button", { name: "Board" }));
    expect(listed.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "work-board",
      options: { subPath: `${PROJECT_ID}?view=board`, replace: true },
    });
    listed.lifecycle.unmount();

    const panel = nativePanel("tab-navigation");
    const reopened = openProject(PROJECT_ID, panelOptions(panel));
    await waitFor(() => expect(reopened.inspection.experimental_panelCalls).toContainEqual(KANBAN_OPEN_CALL));
    expect(reopened.queryByText("In Review")).toBeNull();
  });

  it("keeps per-project choices apart and defaults unseen projects to the last one used", async () => {
    const slot = openProject(`${PROJECT_ID}?view=list`, panelOptions(nativePanel("tab-navigation")));
    fireEvent.click(await slot.findByRole("button", { name: "Board" }));
    slot.lifecycle.unmount();

    expect(loadViewMode(PROJECT_ID)).toBe("board");
    expect(loadViewMode(OTHER_PROJECT_ID)).toBe("board");

    const other = renderSlot(
      app.navPanels[0]!,
      { subPath: `${OTHER_PROJECT_ID}?view=list` },
      { rpc: seededRpc({ listProjects: () => ({ projects: [project, { ...project, id: OTHER_PROJECT_ID, prefix: "OTH" }] }) }), ...panelOptions(nativePanel("tab-navigation")) },
    );
    fireEvent.click(await other.findByRole("button", { name: "List" }));
    expect(loadViewMode(OTHER_PROJECT_ID)).toBe("list");
    expect(loadViewMode(PROJECT_ID)).toBe("board");
  });

  it("navigates from the sidebar without pinning a view", async () => {
    const slot = renderSlot(
      navigationRegistration,
      { subPath: "all" },
      { rpc: seededRpc({ listLabels: () => ({ labels: [] }) }) },
    );
    fireEvent.click(await slot.findByText("Tasks Plugin"));
    expect(loadLastProjectId()).toBe(PROJECT_ID);
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "work-board",
      options: { subPath: PROJECT_ID },
    });
  });

  it("still toggles when client storage rejects writes", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage is disabled", "SecurityError");
    });
    const slot = openProject(`${PROJECT_ID}?view=list`, panelOptions(nativePanel("tab-navigation")));
    fireEvent.click(await slot.findByRole("button", { name: "Board" }));
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "work-board",
      options: { subPath: `${PROJECT_ID}?view=board`, replace: true },
    });
  });
});

describe("startup screen", () => {
  const rpc = seededRpc({
    listProjects: () => ({ projects: [project, { ...project, id: OTHER_PROJECT_ID, name: "Other project", prefix: "OTH" }] }),
    listLabels: () => ({ labels: [] }),
  });

  it("reopens the last visited project with the native board even if it was viewed as a list", async () => {
    const visited = renderSlot(tasksRegistration, { subPath: `${OTHER_PROJECT_ID}?view=list` }, { rpc });
    await waitFor(() => expect(loadLastProjectId()).toBe(OTHER_PROJECT_ID));
    visited.lifecycle.unmount();
    const reopened = renderSlot(tasksRegistration, { subPath: "" }, { rpc, ...panelOptions(nativePanel("tab-navigation")) });
    await waitFor(() => expect(reopened.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "work-board", options: { subPath: `${OTHER_PROJECT_ID}?view=board`, replace: true } }));
    expect(reopened.inspection.experimental_panelCalls).toEqual([]);
  });

  it.each(["all", "active", "last-project-list"])("uses the %s setting on the root route", async (defaultScreen) => {
    const slot = renderSlot(tasksRegistration, { subPath: "" }, { rpc: { ...rpc, getBoardPreferences: () => ({ defaultScreen }) } });
    const subPath = defaultScreen === "last-project-list" ? `${PROJECT_ID}?view=list` : defaultScreen;
    await waitFor(() => expect(slot.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "work-board", options: { subPath, replace: true } }));
  });

  it("keeps an explicit all-tasks link and a task deep link unchanged", async () => {
    for (const subPath of ["all", "task/TSK-4"]) {
      const slot = renderSlot(tasksRegistration, { subPath }, { rpc });
      await waitFor(() => expect(slot.rpcCalls.some(({ method }) => method === "listProjects")).toBe(true));
      expect(slot.navigateCalls).toEqual([]);
      slot.lifecycle.unmount();
    }
  });
});

describe("resource lock chips", () => {
  const kanbanTab = navTab(app, "kanban");
  const lock = {
    name: "dev",
    holderThreadId: "thr_holder",
    holderTitle: "Dev QA run",
    taskKey: "TSK-1",
    reason: "dev QA TSK-1",
    acquiredAt: new Date(Date.now() - 25 * 60_000).toISOString(),
    expiresAt: null,
    stale: null,
  };

  it("shows a chip per held lock in the project header and the side panel", async () => {
    const rpc = seededRpc({ listLocks: () => ({ locks: [lock] }) });
    const main = renderSlot(tasksRegistration, { subPath: `${PROJECT_ID}?view=list` }, { rpc });
    const chip = await main.findByRole("button", { name: /dev · Dev QA run · dev QA TSK-1 · 25 min/ });
    expect(chip.className).not.toContain("text-warning");
    main.lifecycle.unmount();

    const panel = renderSlot({ component: kanbanTab.component }, { subPath: PROJECT_ID }, { rpc });
    await panel.findByRole("button", { name: /dev · Dev QA run/ });
  });

  it("renders nothing without locks and flags a stale lock", async () => {
    const empty = renderSlot(tasksRegistration, { subPath: `${PROJECT_ID}?view=list` }, {
      rpc: seededRpc({ listLocks: () => ({ locks: [] }) }),
    });
    await waitFor(() => expect(empty.rpcCalls.some(({ method }) => method === "listLocks")).toBe(true));
    expect(empty.queryByText(/dev ·/)).toBeNull();
    empty.lifecycle.unmount();

    const stale = renderSlot(tasksRegistration, { subPath: `${PROJECT_ID}?view=list` }, {
      rpc: seededRpc({ listLocks: () => ({ locks: [{ ...lock, stale: "thread_failed" }] }) }),
    });
    expect((await stale.findByRole("button", { name: /dev · Dev QA run/ })).className).toContain("text-warning");
  });

  it("opens details with the holder thread link and force-releases with a reason", async () => {
    const releaseLock = vi.fn(() => ({ ok: true, lock: null }));
    const slot = renderSlot(tasksRegistration, { subPath: `${PROJECT_ID}?view=list` }, {
      rpc: seededRpc({ listLocks: () => ({ locks: [lock] }), releaseLock }),
    });
    fireEvent.click(await slot.findByRole("button", { name: /dev · Dev QA run/ }));
    const release = await slot.findByRole("button", { name: "Release (force)" });
    expect(release).toHaveProperty("disabled", true);
    fireEvent.change(slot.getByLabelText("Release reason"), { target: { value: "holder is gone" } });
    fireEvent.click(slot.getByRole("button", { name: "Dev QA run" }));
    expect(slot.navigateCalls).toContainEqual({ method: "toThread", threadId: "thr_holder" });
    fireEvent.click(release);
    await waitFor(() => expect(releaseLock).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      name: "dev",
      threadId: null,
      force: true,
      reason: "holder is gone",
    }));
  });
});

describe("kanban side panel", () => {
  const kanbanTab = navTab(app, "kanban");

  const openMain = (subPath: string, panel: ExperimentalPanelTabs, overrides: Record<string, unknown> = {}, rpc = seededRpc()) =>
    renderSlot(tasksRegistration, { subPath }, { rpc, ...panelOptions(panel, overrides) });
  const rerenderMain = (slot: ReturnType<typeof openMain>, subPath: string) =>
    slot.lifecycle.rerender(<tasksRegistration.component subPath={subPath} />);
  const panelCalls = (slot: ReturnType<typeof openMain>) => slot.inspection.experimental_panelCalls;

  it("Board opens the native kanban tab and the main area keeps the list", async () => {
    const panel = nativePanel("tab-navigation");
    const slot = openMain(`${PROJECT_ID}?view=list`, panel);
    expect(await pressed(slot, "List")).toBe("true");
    expect(slot.queryByRole("button", { name: "Open kanban in side panel" })).toBeNull();
    fireEvent.click(await slot.findByRole("button", { name: "Board" }));
    expect(panelCalls(slot)).toEqual([KANBAN_OPEN_CALL]);
    // The toggle follows the host, not the click.
    expect(await pressed(slot, "Board")).toBe("false");
    panel.selectedKey = "tab-kanban";
    rerenderMain(slot, `${PROJECT_ID}?view=board`);
    expect(await pressed(slot, "Board")).toBe("true");
    expect(slot.queryByText("In Review")).toBeNull();
  });

  it("a declined open leaves List truthful, shows an error and stores nothing", async () => {
    const error = vi.spyOn(toast, "error").mockImplementation(() => "");
    const slot = openMain(`${PROJECT_ID}?view=list`, nativePanel("tab-navigation"), { openTab: () => false });
    fireEvent.click(await slot.findByRole("button", { name: "Board" }));
    expect(error).toHaveBeenCalledWith("Could not open the kanban panel");
    expect(await pressed(slot, "List")).toBe("true");
    expect(slot.navigateCalls).toEqual([]);
    expect(window.localStorage.getItem("bb-work-board:view-preferences")).toBeNull();
  });

  it("List selects the Navigation tab without closing other tabs or the panel", async () => {
    const slot = openMain(`${PROJECT_ID}?view=board`, nativePanel("tab-kanban"));
    expect(await pressed(slot, "Board")).toBe("true");
    panelCalls(slot).length = 0;
    fireEvent.click(await slot.findByRole("button", { name: "List" }));
    expect(panelCalls(slot)).toEqual([{ method: "selectTab", key: "tab-navigation" }]);
    expect(slot.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "work-board", options: { subPath: `${PROJECT_ID}?view=list`, replace: true } });
    expect(loadViewMode(PROJECT_ID)).toBe("list");
  });

  it("List hides the panel only when no Navigation tab exists, and reports a failed leave", async () => {
    const hidden = openMain(`${PROJECT_ID}?view=board`, nativePanel("tab-kanban", true, false));
    panelCalls(hidden).length = 0;
    fireEvent.click(await hidden.findByRole("button", { name: "List" }));
    expect(panelCalls(hidden)).toEqual([{ method: "close" }]);
    cleanup();
    window.localStorage.clear();

    const error = vi.spyOn(toast, "error").mockImplementation(() => "");
    const stuck = openMain(`${PROJECT_ID}?view=board`, nativePanel("tab-kanban"), { selectTab: () => false });
    fireEvent.click(await stuck.findByRole("button", { name: "List" }));
    expect(error).toHaveBeenCalledWith("Could not leave the kanban panel");
    expect(await pressed(stuck, "Board")).toBe("true");
    expect(stuck.navigateCalls).toEqual([]);
    expect(window.localStorage.getItem("bb-work-board:view-preferences")).toBeNull();
  });

  it("follows native tab changes: another tab or a hidden panel means List", async () => {
    const states: Array<[string, ExperimentalPanelTabs, "List" | "Board"]> = [
      ["kanban selected", nativePanel("tab-kanban"), "Board"],
      ["other tab selected", nativePanel("tab-browser"), "List"],
      ["navigation selected", nativePanel("tab-navigation"), "List"],
      ["panel hidden", nativePanel("tab-kanban", false), "List"],
      ["no tabs reported", { open: true, selectedKey: null, tabs: [] }, "List"],
    ];
    for (const [, panel, expected] of states) {
      const slot = openMain(`${PROJECT_ID}?view=list`, panel);
      expect(await pressed(slot, expected)).toBe("true");
      slot.lifecycle.unmount();
    }
  });

  it("an external tab switch or hide updates the toggle at once and a stale ?view=board never reopens it", async () => {
    const panel = nativePanel("tab-kanban");
    const slot = openMain(`${PROJECT_ID}?view=board`, panel);
    expect(await pressed(slot, "Board")).toBe("true");
    expect(panelCalls(slot)).toEqual([]);

    panel.selectedKey = "tab-browser";
    rerenderMain(slot, `${PROJECT_ID}?view=board`);
    expect(await pressed(slot, "List")).toBe("true");
    expect(slot.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "work-board", options: { subPath: `${PROJECT_ID}?view=list`, replace: true } });
    expect(loadViewMode(PROJECT_ID)).toBe("list");
    rerenderMain(slot, `${PROJECT_ID}?view=board`);
    panel.open = false;
    panel.selectedKey = "tab-kanban";
    rerenderMain(slot, `${PROJECT_ID}?view=board`);
    expect(await pressed(slot, "List")).toBe("true");
    expect(panelCalls(slot)).toEqual([]);
  });

  it("opens the native board once for an explicit board deep link but not when it already shows", async () => {
    const slot = openMain(`${PROJECT_ID}?view=board`, nativePanel("tab-navigation"));
    await waitFor(() => expect(panelCalls(slot)).toEqual([KANBAN_OPEN_CALL]));
    rerenderMain(slot, `${PROJECT_ID}?view=board`);
    expect(panelCalls(slot)).toHaveLength(1);
    cleanup();

    const showing = openMain(`${PROJECT_ID}?view=board`, nativePanel("tab-kanban"));
    await showing.findByRole("button", { name: "Board" });
    expect(panelCalls(showing)).toEqual([]);
  });

  it("keeps the board beside a task and switching projects does not reopen an active board", async () => {
    const panel = nativePanel("tab-kanban");
    const slot = openMain("task/TSK-4", panel);
    expect(await pressed(slot, "Board")).toBe("true");
    expect(slot.getAllByText(/TSK-4/).length).toBeGreaterThan(0);
    cleanup();

    const switched = openMain(`${PROJECT_ID}?view=board`, panel);
    await pressed(switched, "Board");
    rerenderMain(switched, `${OTHER_PROJECT_ID}?view=board`);
    expect(panelCalls(switched)).toEqual([]);
  });

  it("a task route keeps a usable toggle for its project and does not navigate", async () => {
    const slot = openMain("task/TSK-4", nativePanel("tab-navigation"));
    fireEvent.click(await slot.findByRole("button", { name: "Board" }));
    expect(panelCalls(slot)).toEqual([KANBAN_OPEN_CALL]);
    expect(slot.navigateCalls).toEqual([]);
    expect(loadViewMode(PROJECT_ID)).toBe("board");
  });

  it("renders no board in the main area, so the board view adds no dataset read", async () => {
    const slot = openMain(`${PROJECT_ID}?view=board`, nativePanel("tab-kanban"));
    await waitFor(() => expect(slot.rpcCalls.some(({ method }) => method === "listTasks")).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(slot.queryByText("In Review")).toBeNull();
    // Only the central list reads tasks; a second BoardView would add another read.
    expect(slot.rpcCalls.filter(({ method }) => method === "listTasks")).toHaveLength(1);
  });

  it("keeps the right-board creation dialog in its pane", async () => {
    const slot = renderSlot({ component: kanbanTab.component }, { subPath: PROJECT_ID }, { rpc: seededRpc() });
    fireEvent.click(await slot.findByRole("button", { name: "New Todo task" }));
    const dialog = await slot.findByRole("dialog");
    expect(dialog.closest("[data-dialog-scope]")).toBeTruthy();
  });

  it("the right-board Scheduled action opens Scheduled in the main surface without touching tabs", async () => {
    const slot = renderSlot({ component: kanbanTab.component }, { subPath: PROJECT_ID }, { rpc: seededRpc(), ...panelOptions(nativePanel("tab-kanban")) });
    const region = await slot.findByRole("region", { name: "Project kanban" });
    const scheduled = within(region).getByRole("button", { name: "Scheduled" });
    expect(scheduled.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(scheduled);
    expect(slot.navigateCalls).toEqual([{ method: "toPluginPanel", path: "work-board", options: { subPath: "scheduled" } }]);
    expect(slot.inspection.experimental_panelCalls).toEqual([]);
    expect(within(region).getAllByText("In Review")).toHaveLength(1);
  });

  it("renders a live board and follows the project while the main page shows a task", async () => {
    const task = makeTask({ title: "Visible on both views" });
    const slot = renderSlot({ component: kanbanTab.component }, { subPath: "task/TSK-1" }, {
      rpc: seededRpc({
        listTasks: () => ({ tasks: [task] }),
        getTask: () => ({ task }),
        listLabels: () => ({ labels: [] }),
        listAttachments: () => ({ attachments: [] }),
        listTaskThreads: () => ({ taskThreads: [] }),
      }),
    });
    const region = await slot.findByRole("region", { name: "Project kanban" });
    expect(within(region).getByText(project.name)).toBeTruthy();
    await slot.findByText("Visible on both views");
    task.title = "Updated on the board";
    await slot.behavior.emitRealtime("tasks:changed", { taskId: task.id, projectId: PROJECT_ID });
    await slot.findByText("Updated on the board");
  });

  it("shows a useful empty state without projects", async () => {
    const slot = renderSlot({ component: kanbanTab.component }, { subPath: "all" }, { rpc: emptyRpc });
    await slot.findByText("Create a project to open its kanban board.");
  });
});

function pagerTask(key: string, status: Task["status"], position: number) {
  return makeTask({
    id: `01HZZZZZZZZZZZZZZZZZZZZ${key.replace("-", "")}`,
    projectId: PROJECT_ID,
    number: position,
    key,
    title: key,
    status,
    position,
  });
}

describe("task pager", () => {
  const tasks = [
    pagerTask("TSK-3", "done", 1),
    pagerTask("TSK-1", "in_progress", 1),
    pagerTask("TSK-2", "todo", 1),
    pagerTask("TSK-4", "todo", 2),
  ];

  it("orders siblings like the list view and exposes neighbors", () => {
    expect(pagerPosition(tasks, "TSK-4")).toEqual({
      index: 2,
      total: 4,
      prevKey: "TSK-2",
      nextKey: "TSK-1",
    });
    expect(pagerPosition(tasks, "tsk-2")).toMatchObject({
      index: 1,
      prevKey: null,
    });
    expect(pagerPosition(tasks, "TSK-3")).toMatchObject({
      index: 4,
      nextKey: null,
    });
  });

  it("has no position for unknown keys", () => {
    expect(pagerPosition(tasks, "TSK-99")).toBeNull();
    expect(pagerPosition([], "TSK-1")).toBeNull();
  });

  it("renders n / m on the task route and steps to the next sibling", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-4" },
      {
        rpc: seededRpc({
          listTasks: () => ({ tasks }),
          listLabels: () => ({ labels: [] }),
          listAttachments: () => ({ attachments: [] }),
          listTaskThreads: () => ({ taskThreads: [] }),
          listQuestions: () => ({ questions: [] }),
          listComments: () => ({ comments: [] }),
        }),
      },
    );
    await slot.findByText("2 / 4");
    fireEvent.click(slot.getByRole("button", { name: "Next task" }));
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "work-board",
      options: { subPath: "task/TSK-1" },
    });
  });
});

describe("tasks app shell", () => {
  it("does not treat the first connection as a reconnect", async () => {
    let requests = 0;
    let title = "Initial connection title";
    const task = {
      ...pagerTask("TSK-4", "todo", 1),
      description: "",
      labelIds: [],
    };
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "all" },
      {
        realtimeConnectionState: "connecting",
        rpc: seededRpc({
          listTasks: () => {
            requests += 1;
            return { tasks: [{ ...task, title }] };
          },
          listLabels: () => ({ labels: [] }),
          listAttachments: () => ({ attachments: [] }),
          listTaskThreads: () => ({ taskThreads: [] }),
          listQuestions: () => ({ questions: [] }),
          listComments: () => ({ comments: [] }),
        }),
      },
    );
    await slot.findByText("Initial connection title");
    const initialRequests = requests;
    expect(initialRequests).toBeGreaterThan(0);

    await slot.behavior.setRealtimeConnectionState("connected");
    expect(requests).toBe(initialRequests);

    title = "Recovered from connecting state";
    await slot.behavior.setRealtimeConnectionState("connecting");
    await slot.behavior.setRealtimeConnectionState("connected");
    await slot.findByText("Recovered from connecting state");
    expect(requests).toBeGreaterThan(initialRequests);
  });

  it("recovers when the shell mounts during an existing outage", async () => {
    let serverAvailable = false;
    const task = {
      ...pagerTask("TSK-4", "todo", 1),
      title: "Loaded after existing outage",
      description: "",
      labelIds: [],
    };
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "all" },
      {
        realtimeConnectionState: "reconnecting",
        rpc: seededRpc({
          listTasks: async () => {
            if (!serverAvailable) throw new Error("server unavailable");
            return { tasks: [task] };
          },
          listLabels: () => ({ labels: [] }),
          listAttachments: () => ({ attachments: [] }),
          listTaskThreads: () => ({ taskThreads: [] }),
          listQuestions: () => ({ questions: [] }),
          listComments: () => ({ comments: [] }),
        }),
      },
    );
    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.some((call) => call.method === "listTasks"),
      ).toBe(true),
    );
    expect(slot.queryByText("Loaded after existing outage")).toBeNull();

    serverAvailable = true;
    await slot.behavior.setRealtimeConnectionState("connected");
    await slot.findByText("Loaded after existing outage");
  });

  it("resyncs the task list after reconnect and supports manual refresh", async () => {
    let title = "Stale list title";
    const task = {
      ...pagerTask("TSK-4", "todo", 1),
      title,
      description: "",
      labelIds: [],
    };
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "all" },
      {
        rpc: seededRpc({
          listTasks: () => ({ tasks: [{ ...task, title }] }),
          listLabels: () => ({ labels: [] }),
          listAttachments: () => ({ attachments: [] }),
          listTaskThreads: () => ({ taskThreads: [] }),
          listQuestions: () => ({ questions: [] }),
          listComments: () => ({ comments: [] }),
        }),
      },
    );
    await slot.findByText("Stale list title");

    title = "Recovered list title";
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    expect(slot.queryByText("Recovered list title")).toBeNull();
    await slot.behavior.setRealtimeConnectionState("connected");
    await slot.findByText("Recovered list title");

    title = "Manually refreshed list title";
    fireEvent.click(slot.getByRole("button", { name: "Refresh tasks" }));
    await slot.findByText("Manually refreshed list title");
  });

  it("shares manual refresh across the page and right-panel queries", async () => {
    let listTaskCalls = 0;
    let listProjectCalls = 0;
    let holdProjects = false;
    let releaseProjects: (() => void) | undefined;
    const page = renderSlot(
      app.navPanels[0]!,
      { subPath: "all" },
      {
        rpc: seededRpc({
          listTasks: () => {
            listTaskCalls += 1;
            return { tasks: [] };
          },
        }),
      },
    );
    const panel = renderSlot(
      navigationRegistration,
      { subPath: "all" },
      {
        rpc: seededRpc({
          listProjects: async () => {
            listProjectCalls += 1;
            if (holdProjects) {
              await new Promise<void>((resolve) => {
                releaseProjects = resolve;
              });
            }
            return { projects: [project] };
          },
        }),
      },
    );
    await page.findByRole("button", { name: "Refresh tasks" });
    await panel.findByText("Tasks Plugin");
    const initialTaskCalls = listTaskCalls;
    const initialProjectCalls = listProjectCalls;

    holdProjects = true;
    const refresh = page.getByRole("button", {
      name: "Refresh tasks",
    }) as HTMLButtonElement;
    fireEvent.click(refresh);

    await waitFor(() =>
      expect(listTaskCalls).toBeGreaterThan(initialTaskCalls),
    );
    await waitFor(() =>
      expect(listProjectCalls).toBeGreaterThan(initialProjectCalls),
    );
    expect(refresh.disabled).toBe(true);
    const taskCallsWhilePanelPending = listTaskCalls;
    fireEvent.click(refresh);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listTaskCalls).toBe(taskCallsWhilePanelPending);

    releaseProjects?.();
    await waitFor(() => expect(refresh.disabled).toBe(false));
  });

  it("single-flights manual refresh against deferred RPCs and keeps geometry stable", async () => {
    let listTasksCalls = 0;
    let title = "Flight title A";
    let holdListTasks = false;
    const pendingResolvers: Array<() => void> = [];
    const releaseAllPending = () => {
      const resolvers = pendingResolvers.splice(0, pendingResolvers.length);
      for (const resolve of resolvers) resolve();
    };
    const task = {
      ...pagerTask("TSK-4", "todo", 1),
      title,
      description: "",
      labelIds: [],
    };
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "all" },
      {
        rpc: seededRpc({
          listTasks: () => {
            listTasksCalls += 1;
            if (!holdListTasks) {
              return { tasks: [{ ...task, title }] };
            }
            return new Promise((resolve) => {
              pendingResolvers.push(() =>
                resolve({ tasks: [{ ...task, title }] }),
              );
            });
          },
          listLabels: () => ({ labels: [] }),
          listAttachments: () => ({ attachments: [] }),
          listTaskThreads: () => ({ taskThreads: [] }),
          listQuestions: () => ({ questions: [] }),
          listComments: () => ({ comments: [] }),
        }),
      },
    );
    await slot.findByText("Flight title A");
    const baselineCalls = listTasksCalls;
    expect(baselineCalls).toBeGreaterThan(0);

    const refresh = slot.getByRole("button", {
      name: "Refresh tasks",
    }) as HTMLButtonElement;
    const idleClassName = refresh.className;
    expect(idleClassName).toMatch(/size-7/);
    expect(refresh.getAttribute("aria-busy")).not.toBe("true");
    expect(refresh.disabled).toBe(false);
    expect(idleClassName).toMatch(/active:bg-state-active/);

    holdListTasks = true;
    title = "Flight title B";
    fireEvent.click(refresh);
    await waitFor(() => expect(listTasksCalls).toBeGreaterThan(baselineCalls));
    expect(refresh.disabled).toBe(true);
    expect(refresh.getAttribute("aria-busy")).toBe("true");
    expect(refresh.className).toBe(idleClassName);

    const callsWhilePending = listTasksCalls;
    fireEvent.click(refresh);
    fireEvent.click(refresh);
    refresh.focus();
    fireEvent.click(refresh);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(listTasksCalls).toBe(callsWhilePending);

    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(refresh.disabled).toBe(true);
    expect(listTasksCalls).toBe(callsWhilePending);

    releaseAllPending();
    await slot.findByText("Flight title B");
    await waitFor(() => {
      expect(
        (
          slot.getByRole("button", {
            name: "Refresh tasks",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
    });

    title = "Flight title C";
    fireEvent.click(slot.getByRole("button", { name: "Refresh tasks" }));
    await waitFor(() =>
      expect(listTasksCalls).toBeGreaterThan(callsWhilePending),
    );
    releaseAllPending();
    await slot.findByText("Flight title C");
    await waitFor(() => {
      const button = slot.getByRole("button", {
        name: "Refresh tasks",
      }) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      expect(button.getAttribute("aria-busy")).not.toBe("true");
    });
  });

  it("retains stale list data when a manual refresh fails, then recovers", async () => {
    let shouldFail = false;
    let title = "Stable title";
    const task = {
      ...pagerTask("TSK-4", "todo", 1),
      title,
      description: "",
      labelIds: [],
    };
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "all" },
      {
        rpc: seededRpc({
          listTasks: () => {
            if (shouldFail) throw new Error("refresh failed");
            return { tasks: [{ ...task, title }] };
          },
          listLabels: () => ({ labels: [] }),
          listAttachments: () => ({ attachments: [] }),
          listTaskThreads: () => ({ taskThreads: [] }),
          listQuestions: () => ({ questions: [] }),
          listComments: () => ({ comments: [] }),
        }),
      },
    );
    await slot.findByText("Stable title");

    shouldFail = true;
    fireEvent.click(slot.getByRole("button", { name: "Refresh tasks" }));
    await waitFor(() => expect(slot.getByText("Stable title")).toBeDefined());
    await waitFor(() => {
      expect(
        (
          slot.getByRole("button", {
            name: "Refresh tasks",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
    });
    expect(slot.getByText("Stable title")).toBeDefined();

    shouldFail = false;
    title = "Recovered after failure";
    fireEvent.click(slot.getByRole("button", { name: "Refresh tasks" }));
    await slot.findByText("Recovered after failure");
  });

  it("resyncs an open task detail after reconnect", async () => {
    let title = "Stale detail title";
    const task = {
      ...pagerTask("TSK-4", "todo", 1),
      title,
      description: "",
      labelIds: [],
    };
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-4" },
      {
        rpc: seededRpc({
          getTaskByKey: () => ({ task: { ...task, title } }),
          listTasks: () => ({ tasks: [{ ...task, title }] }),
          listLabels: () => ({ labels: [] }),
          listAttachments: () => ({ attachments: [] }),
          listTaskThreads: () => ({ taskThreads: [] }),
          listQuestions: () => ({ questions: [] }),
          listComments: () => ({ comments: [] }),
        }),
      },
    );
    await slot.findByRole("textbox", { name: "Task title" });
    expect(slot.getByRole("textbox", { name: "Task title" }).textContent).toBe(
      "Stale detail title",
    );

    title = "Recovered detail title";
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    expect(slot.getByRole("textbox", { name: "Task title" }).textContent).toBe(
      "Stale detail title",
    );
    await slot.behavior.setRealtimeConnectionState("connected");
    await waitFor(() =>
      expect(
        slot.getByRole("textbox", { name: "Task title" }).textContent,
      ).toBe("Recovered detail title"),
    );
  });

  describe("last-known snapshot", () => {
    const projectsKey = querySnapshotStorageKey("projects");
    const foldersKey = querySnapshotStorageKey("folders");
    const summaryKey = querySnapshotStorageKey("sidebar-summary");
    const summary = {
      projectId: PROJECT_ID,
      taskCount: 3,
      activeAgentCount: 1,
    };

    it("coalesces snapshot writes and rejects older revisions", () => {
      vi.useFakeTimers();
      const key = querySnapshotStorageKey("burst");
      writeQuerySnapshot("burst", { value: "first" }, 1);
      writeQuerySnapshot("burst", { value: "latest" }, 2);
      writeQuerySnapshot("burst", { value: "stale" }, 1);
      expect(window.localStorage.getItem(key)).toBeNull();
      act(() => vi.advanceTimersByTime(25));
      expect(JSON.parse(window.localStorage.getItem(key)!)).toEqual({ value: "latest" });
      vi.useRealTimers();
    });

    it("cancels pending snapshot writes on reset", () => {
      vi.useFakeTimers();
      const key = querySnapshotStorageKey("reset");
      writeQuerySnapshot("reset", { value: 1 }, 1);
      resetQuerySnapshotStateForTest();
      act(() => vi.advanceTimersByTime(25));
      expect(window.localStorage.getItem(key)).toBeNull();
      vi.useRealTimers();
    });
    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    }

    it("never paints the empty state while projects are unknown", async () => {
      const projects = deferred<{ projects: never[] }>();
      const slot = renderSlot(
        app.navPanels[0]!,
        { subPath: "" },
        {
          rpc: seededRpc({
            listProjects: () => projects.promise,
            sidebarSummary: () => ({ projects: [] }),
          }),
        },
      );
      expect(slot.queryByText("No projects yet")).toBeNull();
      projects.resolve({ projects: [] });
      await slot.findByText("No projects yet");
    });

    it("paints the last-known empty state before listProjects resolves", () => {
      window.localStorage.setItem(projectsKey, JSON.stringify([]));
      window.localStorage.setItem(foldersKey, JSON.stringify([]));
      window.localStorage.setItem(summaryKey, JSON.stringify([]));
      const projects = deferred<{ projects: never[] }>();
      const slot = renderSlot(
        app.navPanels[0]!,
        { subPath: "" },
        {
          rpc: seededRpc({
            listProjects: () => projects.promise,
            sidebarSummary: () => ({ projects: [] }),
          }),
        },
      );
      expect(slot.getByText("No projects yet")).toBeTruthy();
    });

    it("paints last-known projects before listProjects resolves and never flashes empty", async () => {
      window.localStorage.setItem(projectsKey, JSON.stringify([project]));
      window.localStorage.setItem(foldersKey, JSON.stringify([folder]));
      window.localStorage.setItem(summaryKey, JSON.stringify([summary]));
      const projects = deferred<{ projects: (typeof project)[] }>();
      const rpc = seededRpc({ listProjects: () => projects.promise });
      const panel = renderSlot(
        navigationRegistration,
        { subPath: "" },
        { rpc },
      );
      const page = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc });
      expect(within(panel.container).getByText(project.name)).toBeTruthy();
      expect(page.queryByText("No projects yet")).toBeNull();
      projects.resolve({ projects: [project] });
      await waitFor(() => expect(within(panel.container).getByText(project.name)).toBeTruthy());
      expect(page.queryByText("No projects yet")).toBeNull();
    });

    it("ignores a malformed snapshot and loads normally", async () => {
      window.localStorage.setItem(projectsKey, "{not json");
      window.localStorage.setItem(
        summaryKey,
        JSON.stringify([{ projectId: 1 }]),
      );
      const slot = renderSlot(
        app.navPanels[0]!,
        { subPath: "" },
        { rpc: emptyRpc },
      );
      expect(slot.queryByText("No projects yet")).toBeNull();
      await slot.findByText("No projects yet");
    });

    it("prunes snapshots written under an older storage version", async () => {
      resetQuerySnapshotStateForTest();
      window.localStorage.setItem(
        "bb-work-board:query-snapshot:v0:projects",
        JSON.stringify([]),
      );
      const slot = renderSlot(
        navigationRegistration,
        { subPath: "" },
        { rpc: seededRpc() },
      );
      await slot.findByText(project.name);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
      expect(
        window.localStorage.getItem("bb-work-board:query-snapshot:v0:projects"),
      ).toBeNull();
      expect(window.localStorage.getItem(projectsKey)).not.toBeNull();
    });

    it("records the fetched projects and counts for the next mount", async () => {
      const slot = renderSlot(
        navigationRegistration,
        { subPath: "" },
        { rpc: seededRpc() },
      );
      await slot.findByText(project.name);
      await waitFor(() => {
        expect(
          JSON.parse(window.localStorage.getItem(projectsKey) ?? "null"),
        ).toEqual([project]);
        expect(
          JSON.parse(window.localStorage.getItem(foldersKey) ?? "null"),
        ).toEqual([folder]);
        expect(
          JSON.parse(window.localStorage.getItem(summaryKey) ?? "null"),
        ).toEqual([summary]);
      });
    });

    it("keeps the newer projects snapshot when an older request resolves later", async () => {
      const olderProject = { ...project, name: "Older truth" };
      const newerProject = { ...project, name: "Newer truth" };
      const older = deferred<{ projects: (typeof project)[] }>();
      let calls = 0;
      const rpc = seededRpc({
        listProjects: () => {
          calls += 1;
          return calls === 1 ? older.promise : { projects: [newerProject] };
        },
      });
      renderSlot(navigationRegistration, { subPath: "" }, { rpc });
      const second = renderSlot(
        navigationRegistration,
        { subPath: "" },
        { rpc },
      );
      await second.findByText("Newer truth");
      await waitFor(() =>
        expect(
          JSON.parse(window.localStorage.getItem(projectsKey) ?? "null"),
        ).toEqual([newerProject]),
      );
      older.resolve({ projects: [olderProject] });
      await act(async () => {
        await older.promise;
      });
      expect(
        JSON.parse(window.localStorage.getItem(projectsKey) ?? "null"),
      ).toEqual([newerProject]);
    });

    it.each(["listFolders", "sidebarSummary"])(
      "keeps loaded projects navigable when %s fails",
      async (method) => {
        const slot = renderSlot(
          navigationRegistration,
          { subPath: "all" },
          {
            rpc: seededRpc({
              [method]: () => Promise.reject(new Error("boom")),
            }),
          },
        );
        fireEvent.click(await slot.findByText(project.name));
        expect(slot.navigateCalls).toContainEqual({
          method: "toPluginPanel",
          path: "work-board",
          options: { subPath: PROJECT_ID },
        });
      },
    );
  });

  it("shows the error, not the previous route's rows, when a route change fails", async () => {
    const tasks = [
      {
        ...pagerTask("TSK-4", "todo", 1),
        title: "Scope truth",
        description: "",
        labelIds: [],
      },
    ];
    const rpc = seededRpc({
      listLabels: () => ({ labels: [] }),
      listTasks: (input: { activeOnly?: boolean }) =>
        input.activeOnly === true
          ? Promise.reject(new Error("active fetch failed"))
          : { tasks },
    });
    const Panel = app.navPanels[0]!.component;
    const slot = renderSlot(app.navPanels[0]!, { subPath: "all" }, { rpc });
    await slot.findByText("Scope truth");

    slot.lifecycle.rerender(<Panel subPath="active" />);
    await slot.findByText("Couldn't load tasks");
    expect(slot.queryByText("Scope truth")).toBeNull();
    expect(slot.queryByText("No agents working right now")).toBeNull();
  });

  it("shows the empty state and opens the New project dialog", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: emptyRpc,
      },
    );
    await slot.findByText("No projects yet");
    fireEvent.click(slot.getByRole("button", { name: /New project/ }));
    await slot.findByText("Projects group tasks under a shared key prefix.");
    expect(slot.getByRole("dialog").closest("[data-dialog-scope]")).not.toBeNull();
  });

  it("keeps the new task modal inside the Work Board pane", async () => {
    const slot = renderSlot(tasksRegistration, { subPath: `${PROJECT_ID}?view=list` }, {
      rpc: seededRpc(),
    });
    await slot.findByText("Tasks Plugin");
    fireEvent.keyDown(window, { key: "c" });
    const dialog = await slot.findByRole("dialog");
    const scope = dialog.closest("[data-dialog-scope]");
    expect(scope).not.toBeNull();
    expect(scope?.className).toContain("[contain:layout]");
    expect(dialog.className).toContain("w-[calc(100%-2rem)]");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
  });

  it("does not paint another scope's empty state while its own rows load", async () => {
    const tasks = [
      {
        ...pagerTask("TSK-4", "todo", 1),
        title: "Scope truth",
        description: "",
        labelIds: [],
      },
    ];
    let deferAll = false;
    const pendingAll: Array<() => void> = [];
    const rpc = seededRpc({
      listLabels: () => ({ labels: [] }),
      listTasks: (input: { activeOnly?: boolean; statuses?: string[] }) => {
        if (input.activeOnly === true) return { tasks: [] };
        const matching = tasks.filter(
          (task) =>
            input.statuses === undefined ||
            input.statuses.includes(task.status),
        );
        if (!deferAll) return { tasks: matching };
        return new Promise((resolve) => {
          pendingAll.push(() => resolve({ tasks: matching }));
        });
      },
    });
    const Panel = app.navPanels[0]!.component;
    const slot = renderSlot(app.navPanels[0]!, { subPath: "all" }, { rpc });
    await slot.findByText("Scope truth");

    slot.lifecycle.rerender(<Panel subPath="active" />);
    await slot.findByText("No agents working right now");

    deferAll = true;
    slot.lifecycle.rerender(<Panel subPath="all" />);
    await slot.findByText("Scope truth");
    expect(slot.queryByText("No tasks yet")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Refresh tasks" }));
    await waitFor(() => expect(pendingAll.length).toBeGreaterThan(0));
    expect(slot.queryByText("No tasks yet")).toBeNull();
    expect(slot.getByText("Scope truth")).toBeDefined();
    act(() => {
      for (const release of pendingAll.splice(0)) release();
    });
    await slot.findByText("Scope truth");
  });

  it("renders board and task subPaths without plugin-owned sidebar chrome", async () => {
    const boardSlot = renderSlot(
      app.navPanels[0]!,
      { subPath: `${PROJECT_ID}?view=board` },
      { rpc: seededRpc(), ...panelOptions(nativePanel("tab-kanban")) },
    );
    await boardSlot.findByRole("button", { name: "Board" });
    expect(boardSlot.queryByText("In Review")).toBeNull();
    expect(boardSlot.getByText("Tasks Plugin")).toBeDefined();
    expect(boardSlot.queryByRole("button", { name: /sidebar/i })).toBeNull();
    cleanup();

    const taskSlot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-4" },
      { rpc: seededRpc() },
    );
    await taskSlot.findByText(/Task TSK-4 was not found/);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(taskSlot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "work-board",
      options: { subPath: "all" },
    });
  });

  it("replaces an old task key with its canonical key on the full Tasks page", async () => {
    const slot = renderSlot(
      tasksRegistration,
      { subPath: "task/OLD-4" },
      {
        rpc: seededRpc({
          getTaskByKey: () => ({ task: makeTask({ key: "TSK-4" }) }),
          listLabels: () => ({ labels: [] }),
          listAttachments: () => ({ attachments: [] }),
          listTaskThreads: () => ({ taskThreads: [] }),
          listQuestions: () => ({ questions: [] }),
          listComments: () => ({ comments: [] }),
        }),
      },
    );
    await slot.findByRole("textbox", { name: "Task title" });
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "work-board",
      options: { subPath: "task/TSK-4", replace: true },
    });
  });

  it("renders right-panel navigation and routes through the plugin panel", async () => {
    const slot = renderSlot(
      navigationRegistration,
      { subPath: "all" },
      {
        rpc: seededRpc(),
      },
    );
    await slot.findByText("Tasks Plugin");
    expect(slot.getByRole("button", { name: /^All tasks/ })).toBeDefined();
    expect(slot.getByRole("button", { name: "Manage" })).toBeDefined();

    fireEvent.click(slot.getByTitle("Tasks Plugin"));
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "work-board",
      options: { subPath: PROJECT_ID },
    });
  });

  it("does not mount New project queries until the dialog opens", async () => {
    let bbProjectCalls = 0;
    const slot = renderSlot(
      navigationRegistration,
      { subPath: "all" },
      {
        rpc: seededRpc({
          listBbProjects: () => {
            bbProjectCalls += 1;
            return { bbProjects: [] };
          },
        }),
      },
    );
    await slot.findByRole("button", { name: "New project" });
    expect(bbProjectCalls).toBe(0);

    fireEvent.click(slot.getByRole("button", { name: "New project" }));

    await slot.findByText("Projects group tasks under a shared key prefix.");
    expect(bbProjectCalls).toBeGreaterThan(0);
  });

  it("routes 'manage' to the manage panel from right-panel navigation", async () => {
    const panel = renderSlot(
      navigationRegistration,
      { subPath: "all" },
      {
        rpc: seededRpc(),
      },
    );
    await panel.findByRole("button", { name: "Manage" });
    fireEvent.click(panel.getByRole("button", { name: "Manage" }));
    expect(panel.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "work-board",
      options: { subPath: "manage" },
    });
    cleanup();

    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "manage" },
      {
        rpc: seededRpc({ listLabels: () => ({ labels: [] }) }),
      },
    );
    await slot.findByText("Projects, labels, agent presets, and folders.");
  });

  it("opens quick-create on bare 'c' but not from editable targets or dialogs", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "all" },
      {
        rpc: seededRpc(),
      },
    );
    await slot.findByText("All tasks");
    fireEvent.keyDown(window, { key: "c" });
    await slot.findByRole("dialog");
    fireEvent.keyDown(window, { key: "c" });
    expect(slot.getAllByRole("dialog")).toHaveLength(1);
  });

  it("marks only new-worktree presets with the worktree hint", async () => {
    const basePreset = {
      id: "01HZZZZZZZZZZZZZZZZZZZZZE1",
      name: "Default env",
      providerId: "claude-code",
      modelId: "claude-sonnet-5",
      reasoningLevel: "medium",
      serviceTier: null,
      permissionMode: "accept-edits",
      environmentKind: "project-default",
      baseBranch: null,
      machineId: null,
      instructions: "",
      builtin: false,
      createdAt: "2026-07-15T00:00:00.000Z",
    };
    const slot = renderSlot(
      navigationRegistration,
      { subPath: "all" },
      {
        rpc: seededRpc({
          listPresets: () => ({
            presets: [
              basePreset,
              {
                ...basePreset,
                id: "01HZZZZZZZZZZZZZZZZZZZZZE2",
                name: "Worktree env",
                environmentKind: "new-worktree",
                baseBranch: "main",
              },
            ],
          }),
        }),
      },
    );
    await slot.findByText("Worktree env");
    expect(slot.getByText("Default env")).toBeDefined();
    expect(slot.getAllByLabelText("Spawns a new worktree")).toHaveLength(1);
  });

  it("refetches sidebar data when invalidation channels fire", async () => {
    let projectCalls = 0;
    const slot = renderSlot(
      navigationRegistration,
      { subPath: "all" },
      {
        rpc: seededRpc({
          listProjects: () => {
            projectCalls += 1;
            return { projects: [project] };
          },
        }),
      },
    );
    await slot.findByText("Tasks Plugin");
    const before = projectCalls;
    await slot.emitRealtime("projects:changed", { projectId: null });
    await waitFor(() => expect(projectCalls).toBeGreaterThan(before));
    const settled = projectCalls;
    await slot.emitRealtime("comments:changed", { taskId: "x" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(projectCalls).toBe(settled);
  });
});


it("opens label management from the main toolbar settings menu", async () => {
  const slot = renderSlot(app.navPanels[0]!, { subPath: PROJECT_ID }, {
    rpc: seededRpc({ listLabels: () => ({ labels: [] }) }),
  });
  fireEvent.keyDown(await slot.findByRole("button", { name: "Work Board settings" }), { key: "ArrowDown" });
  const settings = await slot.findByRole("menuitem", { name: "Plugin settings" });
  expect(settings.getAttribute("href")).toBe("/settings/plugins/work-board");
  fireEvent.click(slot.getByRole("menuitem", { name: "Manage labels and presets" }));
  expect(slot.navigateCalls).toContainEqual({
    method: "toPluginPanel", path: "work-board", options: { subPath: "manage" },
  });
  slot.lifecycle.rerender(<tasksRegistration.component subPath="manage" />);
  await slot.findByText("Projects, labels, agent presets, and folders.");
  expect(slot.getByRole("tab", { name: "Labels" }).getAttribute("data-state")).toBe("active");
  expect(await slot.findByText("No labels yet.")).toBeTruthy();
});
