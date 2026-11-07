// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from "../api";
import { navTab } from "../test-fixtures";
import { tasksRpcContract } from "../shared/contract";

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
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView ??= () => {};
window.PointerEvent ??= window.MouseEvent as typeof PointerEvent;
Element.prototype.setPointerCapture ??= () => {};

const app = await loadPluginApp(() => import("../app"));
it("loads shared storage statistics only when opened and performs maintenance", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  try {
    registerTasksApi(bb, createStore(bb));
    const settings = renderSlot(app.settingsSections[0]!, {}, { rpc: Object.fromEntries(Object.keys(tasksRpcContract).map(method => [method, (input: unknown) => harness.callRpc(method, input)])) });
    expect(settings.rpcCalls.some(call => call.method === "getStorageStatus")).toBe(false);
    fireEvent.click(settings.getByText("Storage"));
    await settings.findByText("Database / WAL");
    fireEvent.click(settings.getByRole("button", { name: "Optimize storage" }));
    await settings.findByText(/Cleanup complete\./);
    expect(settings.rpcCalls.filter(call => call.method === "getStorageStatus")).toHaveLength(1);
    expect(settings.rpcCalls).toContainEqual({ method: "maintainStorage", input: { optimize: true } });
  } finally { cleanup(); await harness.dispose(); }
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

it("switches automation, statuses and Git settings together without changing the other project", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  try {
    const store = createStore(bb);
    registerTasksApi(bb, store);
    const first = store.tasks.createProject({ name: "Alpha", prefix: "A", color: "blue" });
    const second = store.tasks.createProject({ name: "Beta", prefix: "B", color: "red" });
    store.tasks.updateProject(first.id, { autoArchiveAfterDays: "7", staleIdleMinutes: "30" });
    store.tasks.updateProject(second.id, { autoArchiveAfterDays: "14", staleIdleMinutes: "120" });
    const methods = ["getBoardPreferences", "listProjects", "updateProject", "getGitSyncConfig"];
    const settings = renderSlot(app.settingsSections[0]!, {}, { rpc: Object.fromEntries(
      methods.map((method) => [method, (input: unknown) => harness.callRpc(method, input)]),
    ) });
    const archiveSelect = () => settings.getByRole("combobox", { name: "Automatically archive completed tasks" });
    const idleSelect = () => settings.getByRole("combobox", { name: "Flag idle threads without task updates" });
    await waitFor(() => expect(archiveSelect().textContent).toContain("After 7 days"));
    expect(idleSelect().textContent).toContain("After 30 minutes");
    fireEvent.click(settings.getByRole("combobox", { name: "Settings project" }));
    fireEvent.click(await settings.findByRole("option", { name: "Beta" }));
    await waitFor(() => expect(archiveSelect().textContent).toContain("After 14 days"));
    expect(idleSelect().textContent).toContain("After 2 hours");
    await waitFor(() => expect(settings.rpcCalls).toContainEqual(expect.objectContaining({ method: "getGitSyncConfig", input: { projectId: second.id } })));
    fireEvent.click(archiveSelect());
    fireEvent.click(await settings.findByRole("option", { name: "Off" }));
    await waitFor(() => expect(store.tasks.getProject(second.id)?.autoArchiveAfterDays).toBe("off"));
    expect(store.tasks.getProject(first.id)).toMatchObject({ autoArchiveAfterDays: "7", staleIdleMinutes: "30" });
    fireEvent.click(settings.getByRole("combobox", { name: "Settings project" }));
    fireEvent.click(await settings.findByRole("option", { name: "Alpha" }));
    await waitFor(() => expect(archiveSelect().textContent).toContain("After 7 days"));
    expect(settings.getAllByRole("combobox", { name: "Settings project" })).toHaveLength(1);
    expect(settings.queryByRole("combobox", { name: "Statuses project" })).toBeNull();
  } finally {
    cleanup();
    await harness.dispose();
  }
});

it.each([false, true])("creates a project directly in settings (existing project: %s)", async (hasProject) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  try {
    const store = createStore(bb);
    registerTasksApi(bb, store);
    if (hasProject) {
      store.tasks.createProject({ name: "Existing", prefix: "EX", color: "blue" });
    }
    const methods = ["listProjects", "listFolders", "createProject", "getGitSyncConfig", "getBoardPreferences"];
    const settings = renderSlot(app.settingsSections[0]!, {}, {
      rpc: {
        ...Object.fromEntries(methods.map((method) => [
          method, (input: unknown) => harness.callRpc(method, input),
        ])),
        listBbProjects: () => ({ bbProjects: [] }),
      },
    });
    fireEvent.click(await settings.findByRole("button", { name: "New project" }));
    await settings.findByRole("dialog", { name: "New project" });
    expect(settings.navigateCalls).toHaveLength(0);
    fireEvent.change(settings.getByPlaceholderText("e.g. Tasks Plugin"), {
      target: { value: "Home Lab" },
    });
    fireEvent.click(settings.getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(store.tasks.listProjects().some(
      (project) => project.name === "Home Lab" && project.prefix === "HL",
    )).toBe(true));
    const project = store.tasks.listProjects().find((entry) => entry.prefix === "HL")!;
    await waitFor(() => expect(settings.getByRole("combobox", { name: "Settings project" }).textContent).toContain(project.name));
    expect(settings.navigateCalls).toHaveLength(0);
    expect(settings.queryByRole("dialog")).toBeNull();
    fireEvent.click(settings.getByRole("button", { name: "Manage labels and presets" }));
    expect(settings.navigateCalls).toContainEqual({
      method: "toPluginPanel", path: "work-board", options: { subPath: "manage" },
    });
  } finally {
    cleanup();
    await harness.dispose();
  }
});

it("saves a project workflow in compact settings and uses it in the list, board and task picker", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  try {
    const store = createStore(bb);
    registerTasksApi(bb, store);
    const project = store.tasks.createProject({
      name: "Workflow",
      prefix: "WF",
      color: "blue",
    });
    const other = store.tasks.createProject({
      name: "Z Other",
      prefix: "OTH",
      color: "blue",
    });
    const methods = [
      "getBoardPreferences",
      "getGitSyncConfig",
      "listProjects",
      "updateProject",
      "listFolders",
      "listPresets",
      "sidebarSummary",
      "listTasks",
      "listLabels",
      "getTask",
      "getTaskByKey",
      "listAttachments",
      "listTaskThreads",
      "listQuestions",
      "questionCounts",
      "listComments",
      "updateTask",
      "listTaskPullRequests",
    ];
    const rpc = Object.fromEntries(
      methods.map((method) => [
        method,
        (input: unknown) => harness.callRpc(method, input),
      ]),
    );
    const settings = renderSlot(app.settingsSections[0]!, {}, { rpc });
    await settings.findByRole("textbox", { name: "Status name backlog" });
    expect(
      settings.getByRole("button", { name: "Open Work Board" }).className,
    ).toContain("h-7");
    expect(
      settings.queryByRole("textbox", { name: "New status ID" }),
    ).toBeNull();
    expect(
      settings.queryByRole("button", { name: "Save statuses" }),
    ).toBeNull();
    expect(
      settings.queryByRole("button", { name: "Reset changes" }),
    ).toBeNull();
    fireEvent.click(settings.getByRole("button", { name: "Add status" }));
    const newStatus = settings.getByRole("textbox", {
      name: "New status name",
    });
    fireEvent.change(newStatus, { target: { value: "In testing" } });
    fireEvent.keyDown(newStatus, { key: "Enter" });
    await waitFor(() =>
      expect(
        store.tasks
          .getProject(project.id)
          ?.statuses?.map((status) => status.id),
      ).toEqual([
        "backlog",
        "todo",
        "in_progress",
        "in_review",
        "in_testing",
        "done",
        "canceled",
      ]),
    );
    await waitFor(() =>
      expect(
        settings
          .getByRole("button", { name: "Move In testing" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    const handle = settings.getByRole("button", { name: "Move In testing" });
    const fieldset = handle.closest("fieldset")!;
    for (const [index, row] of Array.from(
      fieldset.querySelectorAll<HTMLElement>("[data-status-id]"),
    ).entries()) {
      vi.spyOn(row, "getBoundingClientRect").mockImplementation(() => {
        const currentIndex = Array.from(
          fieldset.querySelectorAll("[data-status-id]"),
        ).indexOf(row);
        return { top: currentIndex * 40, height: 28 } as DOMRect;
      });
    }
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1 });
    fireEvent.pointerMove(fieldset, { clientY: 134, pointerId: 1 });
    expect(store.tasks.getProject(project.id)?.statuses?.[3]?.id).toBe(
      "in_review",
    );
    fireEvent.pointerUp(fieldset, { pointerId: 1 });
    await waitFor(() =>
      expect(
        store.tasks
          .getProject(project.id)
          ?.statuses?.map((status) => status.id),
      ).toEqual([
        "backlog",
        "todo",
        "in_progress",
        "in_testing",
        "in_review",
        "done",
        "canceled",
      ]),
    );
    expect(store.tasks.getProject(other.id)?.statuses).toHaveLength(6);
    fireEvent.keyDown(settings.getByRole("combobox", { name: "Icon for In testing" }), { key: "ArrowDown" });
    fireEvent.click(await settings.findByRole("option", { name: "Testing" }));
    await waitFor(() => expect(
      store.tasks.getProject(project.id)?.statuses?.find((status) => status.id === "in_testing")?.icon,
    ).toBe("testing"));
    fireEvent.click(settings.getByRole("button", { name: "Color for In testing" }));
    expect(settings.queryByRole("button", { name: "Default" })).toBeNull();
    expect(settings.queryByRole("button", { name: "Teal" })).toBeNull();
    expect(settings.getByRole("dialog").querySelectorAll("button")).toHaveLength(10);
    fireEvent.click(await settings.findByRole("button", { name: "Red" }));
    await waitFor(() => expect(
      store.tasks.getProject(project.id)?.statuses?.find((status) => status.id === "in_testing"),
    ).toMatchObject({ icon: "testing", color: "indianred" }));
    settings.lifecycle.unmount();
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Check the build",
      status: "in_testing",
    });
    const list = renderSlot(
      app.navPanels[0]!,
      { subPath: `${project.id}?view=list` },
      { rpc },
    );
    await list.findByText(task.title);
    expect(list.getByText("In testing")).toBeTruthy();
    expect(list.container.querySelector('[data-status-icon="in_testing"][data-status-glyph="testing"]')).toBeTruthy();
    expect((list.container.querySelector('[data-status-icon="in_testing"]') as SVGElement).style.color).toBe("indianred");
    list.lifecycle.unmount();
    // The board lives only in the native right-panel Kanban tab.
    const board = renderSlot(
      { component: navTab(app, "kanban").component },
      { subPath: project.id },
      { rpc },
    );
    await board.findByText(task.title);
    expect(board.container.querySelector('[data-status-icon="in_testing"][data-status-glyph="testing"]')).toBeTruthy();
    expect((board.container.querySelector('[data-status-icon="in_testing"]') as SVGElement).style.color).toBe("indianred");
    expect(
      board.getByRole("button", { name: "New In testing task" }),
    ).toBeTruthy();
    expect(
      board
        .getAllByRole("button", { name: /^New .+ task$/ })
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual([
      "New Backlog task",
      "New Todo task",
      "New In Progress task",
      "New In testing task",
      "New In Review task",
      "New Done task",
    ]);
    fireEvent.click(board.getByText(task.title));
    expect(board.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "work-board",
      options: { subPath: `task/${task.key}` },
    });
    board.lifecycle.unmount();
    const detail = renderSlot(
      app.navPanels[0]!,
      { subPath: `task/${task.key}` },
      { rpc },
    );
    await detail.findByRole("textbox", { name: "Task title" });
    expect(detail.container.querySelector('[data-status-icon="in_testing"][data-status-glyph="testing"]')).toBeTruthy();
    expect((detail.container.querySelector('[data-status-icon="in_testing"]') as SVGElement).style.color).toBe("indianred");
    const status = await detail.findAllByRole("button", { name: "Change task status" });
    expect(status).toHaveLength(2);
    for (const trigger of status) expect(trigger.textContent).toContain("In testing");
    fireEvent.keyDown(status[0]!, { key: "ArrowDown" });
    expect(
      await detail.findByRole("menuitem", { name: "In testing" }),
    ).toBeTruthy();
  } finally {
    cleanup();
    await harness.dispose();
  }
});

it("autosaves names and removals, hides system removal, and keeps rejected changes editable", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  try {
    const store = createStore(bb);
    registerTasksApi(bb, store);
    const project = store.tasks.createProject({
      name: "Workflow",
      prefix: "WF",
      color: "blue",
    });
    const settings = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: Object.fromEntries(
          ["getBoardPreferences", "getGitSyncConfig", "listProjects", "updateProject"].map((method) => [
            method,
            (input: unknown) => harness.callRpc(method, input),
          ]),
        ),
      },
    );
    const backlog = await settings.findByRole("textbox", {
      name: "Status name backlog",
    });
    expect(
      settings.queryByRole("button", { name: "Remove Backlog" }),
    ).toBeNull();
    const moveBacklog = settings.getByRole("button", { name: "Move Backlog" });
    moveBacklog.focus();
    fireEvent.keyDown(moveBacklog, { key: " " });
    fireEvent.keyDown(moveBacklog, { key: "ArrowUp" });
    fireEvent.keyDown(moveBacklog, { key: "ArrowDown" });
    expect(store.tasks.getProject(project.id)?.statuses?.[0]?.id).toBe(
      "backlog",
    );
    fireEvent.keyDown(moveBacklog, { key: "Escape" });
    expect(
      settings.getAllByRole("textbox")[0]?.getAttribute("aria-label"),
    ).toBe("Status name backlog");
    fireEvent.keyDown(moveBacklog, { key: " " });
    fireEvent.keyDown(moveBacklog, { key: "ArrowDown" });
    fireEvent.keyDown(moveBacklog, { key: "Enter" });
    await waitFor(() =>
      expect(store.tasks.getProject(project.id)?.statuses?.[0]?.id).toBe(
        "todo",
      ),
    );
    const renamedBacklog = settings.getByRole("textbox", {
      name: "Status name backlog",
    });
    renamedBacklog.focus();
    fireEvent.change(renamedBacklog, { target: { value: "Incoming" } });
    fireEvent.keyDown(renamedBacklog, { key: "Enter" });
    await waitFor(() =>
      expect(
        store.tasks
          .getProject(project.id)
          ?.statuses?.find((status) => status.id === "backlog"),
      ).toEqual({
        id: "backlog",
        name: "Incoming",
      }),
    );
    await waitFor(() =>
      expect(
        settings
          .getByRole("button", { name: "Add status" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );

    fireEvent.click(settings.getByRole("button", { name: "Add status" }));
    fireEvent.change(
      settings.getByRole("textbox", { name: "New status name" }),
      { target: { value: "Проверка" } },
    );
    fireEvent.keyDown(
      settings.getByRole("textbox", { name: "New status name" }),
      { key: "Enter" },
    );
    await waitFor(() =>
      expect(
        store.tasks
          .getProject(project.id)
          ?.statuses?.find((s) => s.id === "status"),
      ).toEqual({ id: "status", name: "Проверка" }),
    );
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Used status",
      status: "status",
    });
    fireEvent.click(
      await settings.findByRole("button", { name: "Remove Проверка" }),
    );
    await settings.findByRole("alert");
    expect(
      settings.getByRole("textbox", { name: "Status name status" }),
    ).toBeTruthy();
    expect(store.tasks.getTask(task.id)?.status).toBe("status");
    store.tasks.updateTask(task.id, { status: "todo" });
    fireEvent.click(settings.getByRole("button", { name: "Remove Проверка" }));
    await waitFor(() =>
      expect(store.tasks.getProject(project.id)?.statuses).toHaveLength(6),
    );
    await waitFor(() =>
      expect(
        settings.queryByRole("textbox", { name: "Status name status" }),
      ).toBeNull(),
    );

    fireEvent.click(settings.getByRole("button", { name: "Add status" }));
    fireEvent.change(
      settings.getByRole("textbox", { name: "New status name" }),
      { target: { value: "Todo" } },
    );
    fireEvent.keyDown(
      settings.getByRole("textbox", { name: "New status name" }),
      { key: "Enter" },
    );
    await settings.findByRole("alert");
    expect(store.tasks.getProject(project.id)?.statuses).toHaveLength(6);
    expect(
      (
        settings.getByRole("textbox", {
          name: "New status name",
        }) as HTMLInputElement
      ).value,
    ).toBe("Todo");
    fireEvent.click(
      settings.getByRole("button", { name: "Cancel new status" }),
    );
    expect(
      settings.queryByRole("textbox", { name: "New status name" }),
    ).toBeNull();
  } finally {
    cleanup();
    await harness.dispose();
  }
});

it("saves notification modes independently for each selected project", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  try {
    const store = createStore(bb);
    const alpha = store.tasks.createProject({ name: "Alpha", prefix: "A", color: "blue" });
    const beta = store.tasks.createProject({ name: "Beta", prefix: "B", color: "red" });
    registerTasksApi(bb, store);
    const settings = renderSlot(app.settingsSections[0]!, {}, { rpc: Object.fromEntries(Object.keys(tasksRpcContract).map(method => [method, (input: unknown) => harness.callRpc(method, input)])) });
    const mode = () => settings.getByRole("combobox", { name: "Task status notifications" });
    await settings.findByRole("combobox", { name: "Task status notifications" });
    fireEvent.click(mode());
    fireEvent.click(await settings.findByRole("option", { name: "Done only" }));
    await waitFor(() => expect(store.tasks.getProject(alpha.id)?.statusNotifications).toBe("done"));
    expect(store.tasks.getProject(beta.id)?.statusNotifications).toBe("off");
    fireEvent.click(settings.getByRole("combobox", { name: "Settings project" }));
    fireEvent.click(await settings.findByRole("option", { name: "Beta" }));
    await waitFor(() => expect(mode().textContent).toContain("Off"));
    fireEvent.click(mode());
    fireEvent.click(await settings.findByRole("option", { name: "All status changes" }));
    await waitFor(() => expect(store.tasks.getProject(beta.id)?.statusNotifications).toBe("all"));
    expect(store.tasks.getProject(alpha.id)?.statusNotifications).toBe("done");
  } finally { cleanup(); await harness.dispose(); }
});
