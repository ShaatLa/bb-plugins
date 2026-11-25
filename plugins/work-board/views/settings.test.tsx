// @vitest-environment jsdom
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from "../api";
import { registerAttention } from "../attention/rpc";
import { registerChecks } from "../checks/rpc";
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
const editStatuses = async (settings: ReturnType<typeof renderSlot>) => {
  fireEvent.click(await settings.findByRole("button", { name: "Edit statuses" }));
};
it("loads shared storage statistics in General without maintenance, and performs maintenance on request", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  try {
    registerTasksApi(bb, createStore(bb));
    const settings = renderSlot(app.settingsSections[0]!, {}, { rpc: Object.fromEntries(Object.keys(tasksRpcContract).map(method => [method, (input: unknown) => harness.callRpc(method, input)])) });
    // Storage is a General card, open from the start: its usage loads at once, with no project at all.
    const general = settings.getByRole("region", { name: "General" });
    const storage = within(general).getByRole("region", { name: "Storage" });
    await within(storage).findByText("Missing attachment files");
    expect(settings.rpcCalls.filter(call => call.method === "getStorageStatus")).toHaveLength(1);
    expect(settings.rpcCalls.some(call => call.method === "maintainStorage")).toBe(false);
    // Database details sit in a nested, closed disclosure.
    const database = within(storage).getByText("Database details").closest("details")!;
    expect(database.open).toBe(false);
    expect(database.textContent).toContain("Database / WAL");
    fireEvent.click(within(storage).getByRole("button", { name: "Optimize storage" }));
    await within(storage).findByText(/Cleanup complete\./);
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
    const archiveSelect = () => settings.getByRole("combobox", { name: "Archive completed tasks after" });
    const idleSelect = () => settings.getByRole("combobox", { name: "Flag idle threads after" });
    await waitFor(() => expect(archiveSelect().textContent).toContain("7 days"));
    expect(idleSelect().textContent).toContain("30 minutes");
    fireEvent.click(settings.getByRole("combobox", { name: "Settings project" }));
    fireEvent.click(await settings.findByRole("option", { name: "Beta" }));
    await waitFor(() => expect(archiveSelect().textContent).toContain("14 days"));
    expect(idleSelect().textContent).toContain("2 hours");
    await waitFor(() => expect(settings.rpcCalls).toContainEqual(expect.objectContaining({ method: "getGitSyncConfig", input: { projectId: second.id } })));
    fireEvent.click(archiveSelect());
    fireEvent.click(await settings.findByRole("option", { name: "Off" }));
    await waitFor(() => expect(store.tasks.getProject(second.id)?.autoArchiveAfterDays).toBe("off"));
    expect(store.tasks.getProject(first.id)).toMatchObject({ autoArchiveAfterDays: "7", staleIdleMinutes: "30" });
    fireEvent.click(settings.getByRole("combobox", { name: "Settings project" }));
    fireEvent.click(await settings.findByRole("option", { name: "Alpha" }));
    await waitFor(() => expect(archiveSelect().textContent).toContain("7 days"));
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
    // The footer no longer repeats it.
    expect(settings.getAllByRole("button", { name: "Manage labels and presets" })).toHaveLength(1);
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
    await editStatuses(settings);
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

it("keeps names and new statuses as drafts until Save, writes removals at once, hides system removal, and keeps rejected drafts editable", async () => {
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
          ["getBoardPreferences", "getGitSyncConfig", "getStorageStatus", "listProjects", "updateProject"].map((method) => [
            method,
            (input: unknown) => harness.callRpc(method, input),
          ]),
        ),
      },
    );
    await editStatuses(settings);
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
      within(settings.getByRole("region", { name: "Statuses" })).getAllByRole("textbox")[0]?.getAttribute("aria-label"),
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
    // Leaving the field writes nothing: a name is a draft until the Workflow card's Save.
    fireEvent.blur(renamedBacklog);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settings.rpcCalls.filter((call) => call.method === "updateProject")).toHaveLength(1);
    expect(settings.getByText("Unsaved names")).toBeTruthy();
    fireEvent.click(settings.getByRole("button", { name: "Add status" }));
    fireEvent.change(
      settings.getByRole("textbox", { name: "New status name" }),
      { target: { value: "Проверка" } },
    );
    fireEvent.blur(settings.getByRole("textbox", { name: "New status name" }));
    expect(store.tasks.getProject(project.id)?.statuses?.some((s) => s.id === "status")).toBe(false);
    fireEvent.click(within(settings.getByRole("region", { name: "Statuses" })).getByRole("button", { name: "Save" }));
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
        store.tasks
          .getProject(project.id)
          ?.statuses?.find((s) => s.id === "status"),
      ).toEqual({ id: "status", name: "Проверка" }),
    );
    // The new status goes before Done.
    expect(store.tasks.getProject(project.id)?.statuses?.map((status) => status.id)).toEqual(["todo", "backlog", "in_progress", "in_review", "status", "done", "canceled"]);
    expect(settings.queryByText("Unsaved names")).toBeNull();
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
    fireEvent.click(within(settings.getByRole("region", { name: "Statuses" })).getByRole("button", { name: "Save" }));
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

it("lets the owner pick each planning mode for the selected project, and the choice survives a reload", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  try {
    const store = createStore(bb);
    const alpha = store.tasks.createProject({ name: "Alpha", prefix: "A", color: "blue" });
    const beta = store.tasks.createProject({ name: "Beta", prefix: "B", color: "red" });
    registerTasksApi(bb, store);
    const rpc = Object.fromEntries(Object.keys(tasksRpcContract).map(method => [method, (input: unknown) => harness.callRpc(method, input)]));
    const settings = renderSlot(app.settingsSections[0]!, {}, { rpc });
    const region = () => within(settings.getByRole("region", { name: "Planning" }));
    const mode = () => region().getByRole("combobox", { name: "Mode" });
    await settings.findByRole("combobox", { name: "Mode" });
    // The project cards come in this order, inside the Project group.
    const cards = (group: string) => within(settings.getByRole("region", { name: group })).getAllByRole("heading", { level: 3 }).map(node => node.textContent);
    expect(cards("Project")).toEqual(["Workflow", "Archiving", "Activity and notifications", "Manager", "Git and pull requests", "Repository checks"]);
    expect(region().getByRole("heading", { name: "Planning" })).toBeTruthy();
    // The owner-only hint covers the mode and the gated statuses, not the reviewer switch.
    expect(region().getByText("Only you change the planning mode and the statuses that need an approved plan; agents cannot.")).toBeTruthy();
    expect(region().getByText(/^Off hides plans/).textContent).not.toContain("agents cannot");
    expect(within(settings.getByRole("region", { name: "Archiving" })).getAllByRole("combobox").map(box => box.getAttribute("aria-label"))).toEqual(["Archive completed tasks after"]);
    expect(within(settings.getByRole("region", { name: "Activity and notifications" })).getAllByRole("combobox").map(box => box.getAttribute("aria-label"))).toEqual(["Flag idle threads after", "Notify me of status changes"]);
    expect(mode().textContent).toContain("Off");
    fireEvent.click(region().getByRole("switch", { name: "Check readiness" }));
    await waitFor(() => expect(store.tasks.getProject(alpha.id)?.checkReadiness).toBe("on"));
    fireEvent.click(region().getByRole("switch", { name: "Done after review" }));
    await waitFor(() => expect(store.tasks.getProject(alpha.id)?.doneRequiresReview).toBe("on"));
    // The reviewer switch is shown only while planning is not Off.
    expect(region().queryByRole("switch", { name: "Archive the plan reviewer after approval" })).toBeNull();
    for (const [label, value] of [["Optional", "optional"], ["Required", "required"], ["Off", "off"], ["Required", "required"]] as const) {
      fireEvent.click(mode());
      fireEvent.click(await settings.findByRole("option", { name: label }));
      await waitFor(() => expect(store.tasks.getProject(alpha.id)?.planning).toBe(value));
      await waitFor(() => expect(region().queryByRole("switch", { name: "Archive the plan reviewer after approval" }) !== null).toBe(value !== "off"));
    }
    expect(store.tasks.getProject(beta.id)?.planning).toBe("off");
    // The control shows when planning last changed and what it was before.
    const changed = await region().findByTestId("planning-changed");
    expect(changed.textContent).toMatch(/^Changed .*, was off$/);
    expect(changed.querySelector("time")!.getAttribute("datetime")).toBe(store.tasks.getProject(alpha.id)!.planningChangedAt);
    // A fresh render (a reload) reads the saved mode back.
    cleanup();
    const reloaded = renderSlot(app.settingsSections[0]!, {}, { rpc });
    await waitFor(() => expect(reloaded.getByRole("combobox", { name: "Mode" }).textContent).toContain("Required"));
  } finally { cleanup(); await harness.dispose(); }
});

it("lets the owner switch the two thread-archive settings, each in its own section", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  try {
    const store = createStore(bb);
    const alpha = store.tasks.createProject({ name: "Alpha", prefix: "A", color: "blue" });
    store.tasks.updateProject(alpha.id, { planning: "optional" });
    registerTasksApi(bb, store);
    const rpc = Object.fromEntries(Object.keys(tasksRpcContract).map(method => [method, (input: unknown) => harness.callRpc(method, input)]));
    const settings = renderSlot(app.settingsSections[0]!, {}, { rpc });
    const archiveThreads = () => within(settings.getByRole("region", { name: "Archiving" })).getByRole("switch", { name: "Archive threads of closed tasks" });
    const archiveReviewer = () => within(settings.getByRole("region", { name: "Planning" })).getByRole("switch", { name: "Archive the plan reviewer after approval" });
    await settings.findByRole("combobox", { name: "Mode" });
    expect(archiveThreads().getAttribute("aria-checked")).toBe("true");
    expect(archiveReviewer().getAttribute("aria-checked")).toBe("true");
    fireEvent.click(archiveThreads());
    await waitFor(() => expect(store.tasks.getProject(alpha.id)?.archiveThreadsOnClose).toBe("off"));
    fireEvent.click(archiveReviewer());
    await waitFor(() => expect(store.tasks.getProject(alpha.id)?.archiveReviewerOnApproval).toBe("off"));
    expect(store.tasks.getProject(alpha.id)?.archiveThreadsOnClose).toBe("off");
    fireEvent.click(archiveReviewer());
    await waitFor(() => expect(store.tasks.getProject(alpha.id)?.archiveReviewerOnApproval).toBe("on"));
  } finally { cleanup(); await harness.dispose(); }
});

it("keeps the status editor open over a rejected draft and lets Done close it once corrected", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  try {
    const store = createStore(bb);
    const alpha = store.tasks.createProject({ name: "Alpha", prefix: "A", color: "blue" });
    registerTasksApi(bb, store);
    const settings = renderSlot(app.settingsSections[0]!, {}, { rpc: Object.fromEntries(Object.keys(tasksRpcContract).map(method => [method, (input: unknown) => harness.callRpc(method, input)])) });
    await editStatuses(settings);
    const name = await settings.findByRole("textbox", { name: "Status name backlog" }) as HTMLInputElement;
    const save = () => fireEvent.click(within(settings.getByRole("region", { name: "Statuses" })).getByRole("button", { name: "Save" }));
    // An empty name is rejected on Save; Done must not discard the draft or the error.
    fireEvent.change(name, { target: { value: "" } });
    save();
    await settings.findByRole("alert");
    const done = settings.getByRole("button", { name: "Done editing statuses" });
    expect(done.hasAttribute("disabled")).toBe(true);
    fireEvent.click(done);
    expect((settings.getByRole("textbox", { name: "Status name backlog" }) as HTMLInputElement).value).toBe("");
    expect(settings.getByRole("alert")).toBeTruthy();
    expect(store.tasks.getProject(alpha.id)?.statuses?.[0]?.name ?? "Backlog").toBe("Backlog");
    // Correcting the name saves it and releases Done.
    fireEvent.change(settings.getByRole("textbox", { name: "Status name backlog" }), { target: { value: "Incoming" } });
    save();
    await waitFor(() => expect(settings.queryByRole("alert")).toBeNull());
    await waitFor(() => expect(settings.getByRole("button", { name: "Done editing statuses" }).hasAttribute("disabled")).toBe(false));
    expect(store.tasks.getProject(alpha.id)?.statuses?.[0]?.name).toBe("Incoming");
    fireEvent.click(settings.getByRole("button", { name: "Done editing statuses" }));
    expect(settings.getByRole("list", { name: "Status order" })).toBeTruthy();
  } finally { cleanup(); await harness.dispose(); }
});

it("keeps a rename draft across an immediate planning change, and Save stores both", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  try {
    const store = createStore(bb);
    const alpha = store.tasks.createProject({ name: "Alpha", prefix: "A", color: "blue" });
    store.tasks.updateProject(alpha.id, { planning: "required" });
    registerTasksApi(bb, store);
    const settings = renderSlot(app.settingsSections[0]!, {}, { rpc: Object.fromEntries(Object.keys(tasksRpcContract).map(method => [method, (input: unknown) => harness.callRpc(method, input)])) });
    await editStatuses(settings);
    fireEvent.change(await settings.findByRole("textbox", { name: "Status name todo" }), { target: { value: "Ready" } });
    // The Planning chips write the flag at once and never carry the name draft.
    fireEvent.click(settings.getByRole("combobox", { name: "Add status" }));
    fireEvent.click(await settings.findByRole("option", { name: "Backlog" }));
    await waitFor(() => expect(store.tasks.getProject(alpha.id)?.statuses?.find(status => status.id === "backlog")?.requiresApprovedPlan).toBe(true));
    expect(store.tasks.getProject(alpha.id)?.statuses?.find(status => status.id === "todo")?.name).toBe("Todo");
    await waitFor(() => expect((settings.getByRole("textbox", { name: "Status name todo" }) as HTMLInputElement).value).toBe("Ready"));
    fireEvent.click(within(settings.getByRole("region", { name: "Statuses" })).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(store.tasks.getProject(alpha.id)?.statuses?.find(status => status.id === "todo")?.name).toBe("Ready"));
    expect(store.tasks.getProject(alpha.id)?.statuses?.find(status => status.id === "backlog")?.requiresApprovedPlan).toBe(true);
  } finally { cleanup(); await harness.dispose(); }
});

it("never undoes a planning flag whose refresh has not reached the editor when the names are saved", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  try {
    const store = createStore(bb);
    const alpha = store.tasks.createProject({ name: "Alpha", prefix: "A", color: "blue" });
    store.tasks.updateProject(alpha.id, { planning: "required" });
    registerTasksApi(bb, store);
    const rpc: Record<string, (input: unknown) => unknown> = Object.fromEntries(Object.keys(tasksRpcContract).map(method => [method, (input: unknown) => harness.callRpc(method, input)]));
    // The project refresh after the planning change is held until the editor's Save has been refused once.
    let holding = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let refused = 0;
    rpc.listProjects = async (input) => { if (holding) await held; return harness.callRpc("listProjects", input); };
    rpc.updateProject = async (input) => {
      try { return await harness.callRpc("updateProject", input); } catch (error) { refused++; release(); throw error; }
    };
    const settings = renderSlot(app.settingsSections[0]!, {}, { rpc });
    await editStatuses(settings);
    fireEvent.change(await settings.findByRole("textbox", { name: "Status name todo" }), { target: { value: "Ready" } });
    holding = true;
    fireEvent.click(settings.getByRole("combobox", { name: "Add status" }));
    fireEvent.click(await settings.findByRole("option", { name: "Backlog" }));
    await waitFor(() => expect(store.tasks.getProject(alpha.id)?.statuses?.find(status => status.id === "backlog")?.requiresApprovedPlan).toBe(true));
    fireEvent.click(within(settings.getByRole("region", { name: "Statuses" })).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(store.tasks.getProject(alpha.id)?.statuses?.find(status => status.id === "todo")?.name).toBe("Ready"));
    expect(refused).toBe(1);
    expect(store.tasks.getProject(alpha.id)?.statuses?.find(status => status.id === "backlog")?.requiresApprovedPlan).toBe(true);
    await waitFor(() => expect(settings.queryByText("Unsaved names")).toBeNull());
  } finally { cleanup(); await harness.dispose(); }
});

it("shows a compact status order and opens the full editor only on Edit", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  try {
    const store = createStore(bb);
    store.tasks.createProject({ name: "Alpha", prefix: "A", color: "blue" });
    registerTasksApi(bb, store);
    const settings = renderSlot(app.settingsSections[0]!, {}, { rpc: Object.fromEntries(Object.keys(tasksRpcContract).map(method => [method, (input: unknown) => harness.callRpc(method, input)])) });
    const edit = await settings.findByRole("button", { name: "Edit statuses" });
    const order = within(settings.getByRole("list", { name: "Status order" }));
    expect(order.getAllByRole("listitem").map(item => item.textContent)).toEqual(["Backlog", "Todo", "In Progress", "In Review", "Done", "Canceled"]);
    expect(settings.container.querySelectorAll('[aria-label="Status order"] [data-status-icon]')).toHaveLength(6);
    expect(edit.getAttribute("aria-expanded")).toBe("false");
    expect(settings.queryByRole("textbox", { name: "Status name backlog" })).toBeNull();
    fireEvent.click(edit);
    expect(settings.getByRole("button", { name: "Done editing statuses" }).getAttribute("aria-expanded")).toBe("true");
    expect(settings.getByRole("textbox", { name: "Status name backlog" })).toBeTruthy();
    expect(settings.queryByRole("list", { name: "Status order" })).toBeNull();
    fireEvent.click(settings.getByRole("button", { name: "Done editing statuses" }));
    expect(settings.queryByRole("textbox", { name: "Status name backlog" })).toBeNull();
    expect(settings.getByRole("list", { name: "Status order" })).toBeTruthy();
  } finally { cleanup(); await harness.dispose(); }
});

it.each([false, true])("offers Manage labels and presets above the project sections (existing project: %s)", async (hasProject) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  try {
    const store = createStore(bb);
    if (hasProject) store.tasks.createProject({ name: "Alpha", prefix: "A", color: "blue" });
    registerTasksApi(bb, store);
    const settings = renderSlot(app.settingsSections[0]!, {}, { rpc: Object.fromEntries(Object.keys(tasksRpcContract).map(method => [method, (input: unknown) => harness.callRpc(method, input)])) });
    const manage = await settings.findByRole("button", { name: "Manage labels and presets" });
    if (hasProject) await settings.findByRole("region", { name: "Planning" });
    else await settings.findByText("Create a project to configure its workflow.");
    const sections = settings.queryByTestId("project-settings");
    expect(sections ? within(sections).getAllByRole("heading", { level: 3 }) : []).toHaveLength(hasProject ? 6 : 0);
    if (sections) expect(manage.compareDocumentPosition(sections) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(manage);
    expect(settings.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "work-board", options: { subPath: "manage" } });
  } finally { cleanup(); await harness.dispose(); }
});

it("shows the plan-gated statuses only when planning is required, and the status editor has no plan checkbox or auto-save sentence", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  try {
    const store = createStore(bb);
    const alpha = store.tasks.createProject({ name: "Alpha", prefix: "A", color: "blue" });
    registerTasksApi(bb, store);
    const settings = renderSlot(app.settingsSections[0]!, {}, { rpc: Object.fromEntries(Object.keys(tasksRpcContract).map(method => [method, (input: unknown) => harness.callRpc(method, input)])) });
    await settings.findByRole("combobox", { name: "Mode" });
    const block = () => within(settings.getByRole("region", { name: "Planning" })).queryByTestId("plan-gated-statuses");
    expect(block()).toBeNull();
    expect(settings.queryByText(/Changes save automatically/)).toBeNull();
    expect(settings.queryByText(/System statuses stay; statuses used by tasks cannot be deleted\./)).toBeNull();
    await editStatuses(settings);
    expect(settings.queryByText(/System statuses stay; statuses used by tasks cannot be deleted\./)).not.toBeNull();
    expect(settings.queryAllByRole("checkbox", { name: /approved plan/ })).toHaveLength(0);
    expect(settings.queryByText("Plan", { selector: "label" })).toBeNull();
    for (const [label, value] of [["Optional", "optional"], ["Required", "required"], ["Optional", "optional"]] as const) {
      fireEvent.click(settings.getByRole("combobox", { name: "Mode" }));
      fireEvent.click(await settings.findByRole("option", { name: label }));
      await waitFor(() => expect(store.tasks.getProject(alpha.id)?.planning).toBe(value));
      await waitFor(() => (value === "required" ? expect(block()).not.toBeNull() : expect(block()).toBeNull()));
    }
  } finally { cleanup(); await harness.dispose(); }
});

it("edits the plan-gated statuses as chips: add and remove save the flag, canceled is never offered, the complement line follows", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  try {
    const store = createStore(bb);
    const alpha = store.tasks.createProject({ name: "Alpha", prefix: "A", color: "blue" });
    store.tasks.updateProject(alpha.id, { planning: "required" });
    registerTasksApi(bb, store);
    const settings = renderSlot(app.settingsSections[0]!, {}, { rpc: Object.fromEntries(Object.keys(tasksRpcContract).map(method => [method, (input: unknown) => harness.callRpc(method, input)])) });
    const flag = (id: string) => store.tasks.getProject(alpha.id)?.statuses?.find(status => status.id === id)?.requiresApprovedPlan === true;
    const chips = () => within(settings.getByTestId("plan-gated-statuses")).queryAllByRole("button", { name: /^Remove / }).map(button => button.getAttribute("aria-label"));
    const free = () => settings.getByTestId("plan-free-statuses").textContent;
    await within(await settings.findByRole("region", { name: "Planning" })).findByTestId("plan-gated-statuses");
    expect(within(settings.getByRole("region", { name: "Archiving" })).queryByTestId("plan-gated-statuses")).toBeNull();
    // The first switch to required marked In progress and every later status; chips follow the project status order.
    expect(settings.getByRole("heading", { name: "Statuses that need an approved plan" })).toBeTruthy();
    expect(chips()).toEqual(["Remove In Progress", "Remove In Review", "Remove Done"]);
    expect(free()).toBe("Without an approved plan a task stays in: Backlog, Todo, Planning, Canceled");
    expect(settings.getByTestId("plan-gated-statuses").querySelectorAll("[data-status-icon]")).toHaveLength(3);
    // Adding offers the unmarked statuses except canceled.
    fireEvent.click(settings.getByRole("combobox", { name: "Add status" }));
    expect((await settings.findAllByRole("option")).map(option => option.textContent)).toEqual(["Backlog", "Todo", "Planning"]);
    fireEvent.click(settings.getByRole("option", { name: "Todo" }));
    await waitFor(() => expect(flag("todo")).toBe(true));
    await waitFor(() => expect(free()).toBe("Without an approved plan a task stays in: Backlog, Planning, Canceled"));
    expect(chips()).toEqual(["Remove Todo", "Remove In Progress", "Remove In Review", "Remove Done"]);
    // Removing clears the flag and the status leaves the chips.
    fireEvent.click(settings.getByRole("button", { name: "Remove Done" }));
    await waitFor(() => expect(flag("done")).toBe(false));
    await waitFor(() => expect(free()).toBe("Without an approved plan a task stays in: Backlog, Planning, Done, Canceled"));
    expect(chips()).toEqual(["Remove Todo", "Remove In Progress", "Remove In Review"]);
    expect(flag("canceled")).toBe(false);
  } finally { cleanup(); await harness.dispose(); }
});

it("shows a failed plan-gated status save like the other settings", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  try {
    const store = createStore(bb);
    const alpha = store.tasks.createProject({ name: "Alpha", prefix: "A", color: "blue" });
    store.tasks.updateProject(alpha.id, { planning: "required" });
    registerTasksApi(bb, store);
    const rpc = Object.fromEntries(Object.keys(tasksRpcContract).map(method => [method, (input: unknown) => harness.callRpc(method, input)]));
    rpc.updateProject = async () => { throw new Error("Statuses are locked"); };
    const settings = renderSlot(app.settingsSections[0]!, {}, { rpc });
    fireEvent.click(await settings.findByRole("button", { name: "Remove Done" }));
    expect((await settings.findByRole("alert")).textContent).toMatch(/^Failed: Statuses are locked/);
    expect(store.tasks.getProject(alpha.id)?.statuses?.find(status => status.id === "done")?.requiresApprovedPlan).toBe(true);
  } finally { cleanup(); await harness.dispose(); }
});

it("saves notification modes independently for each selected project", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  try {
    const store = createStore(bb);
    const alpha = store.tasks.createProject({ name: "Alpha", prefix: "A", color: "blue" });
    const beta = store.tasks.createProject({ name: "Beta", prefix: "B", color: "red" });
    registerTasksApi(bb, store);
    const settings = renderSlot(app.settingsSections[0]!, {}, { rpc: Object.fromEntries(Object.keys(tasksRpcContract).map(method => [method, (input: unknown) => harness.callRpc(method, input)])) });
    const mode = () => settings.getByRole("combobox", { name: "Notify me of status changes" });
    await settings.findByRole("combobox", { name: "Notify me of status changes" });
    expect(settings.getByText(/Status changes you make yourself in the board are not notified\./)).toBeTruthy();
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

it("refreshes only the checks and attention getters on a settings signal, whichever tracker it names, and the wider set on projects:changed", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  try {
    const store = createStore(bb);
    registerTasksApi(bb, store); registerAttention(bb); registerChecks(bb);
    store.tasks.createProject({ name: "Alpha", prefix: "ALP", color: "blue", linkedBbProjectId: "proj_example" });
    const settings = renderSlot(app.settingsSections[0]!, {}, {
      rpc: Object.fromEntries(Object.keys(tasksRpcContract).map((method) => [method, (input: unknown) => harness.callRpc(method, input)])),
      sdk: { threads: { list: async () => [] } },
    });
    await settings.findByTestId("attention-sender");
    await settings.findByTestId("checks-status");
    const burst = async (channel: "settings:changed" | "projects:changed", projectId: string | null) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const from = settings.rpcCalls.length;
      await settings.behavior.emitRealtime(channel, { projectId });
      await new Promise((resolve) => setTimeout(resolve, 600));
      return settings.rpcCalls.slice(from).map((call) => call.method).sort();
    };
    expect(await burst("settings:changed", store.tasks.listProjects()[0]!.id)).toEqual(["getAttentionSettings", "getChecksStatus"]);
    // A signal naming another tracker still refreshes both: a shared runner can change this tracker's status.
    expect(await burst("settings:changed", "tracker_other")).toEqual(["getAttentionSettings", "getChecksStatus"]);
    expect(await burst("projects:changed", null)).toEqual(["config.get", "getAttentionSettings", "getChecksStatus", "getGitSyncConfig", "listProjects"]);
  } finally { cleanup(); await harness.dispose(); }
});

it("reopens every receipt policy field saved for the project", async () => {
  const {bb,harness}=createFakePluginHost({pluginId:"work-board"});
  const dir = mkdtempSync(join(os.tmpdir(), "receipt-settings-"));
  const home = vi.spyOn(os, "homedir").mockReturnValue(dir);
  try {
    mkdirSync(join(dir, ".bb"));
    writeFileSync(join(dir, ".bb", "work-board-receipt-validators.json"), JSON.stringify({
      preview: { argv: ["/opt/validation/check"], cwd: "/opt/validation" },
    }));
    const store=createStore(bb);
    const project=store.tasks.createProject({name:"Example",prefix:"EXA",color:"blue"});
    registerTasksApi(bb,store);
    const rpc=Object.fromEntries(Object.keys(tasksRpcContract).map(method=>[method,(input:unknown)=>harness.callRpc(method,input)]));
    const show=()=>renderSlot(app.settingsSections[0]!,{},{rpc});
    const fields={"Registered validator ID":"preview","Receipt timeout (seconds)":"45","Receipt production hint":"make receipt","Link path pattern":"^/canvas/","Link wrappers (one per line)":"/_frame?src\n/view?url"};
    const panel=show();
    fireEvent.click(await panel.findByRole("switch",{name:"Check receipt"}));
    for(const [name,value] of Object.entries(fields)) fireEvent.change(panel.getByLabelText(name),{target:{value}});
    fireEvent.click(panel.getByRole("button",{name:"Save check receipt"}));
    await waitFor(()=>expect(store.tasks.getProject(project.id)?.checkReceipt?.linkWrappers).toEqual(["/_frame?src","/view?url"]));
    cleanup();
    const reloaded=show();
    for(const [name,value] of Object.entries(fields)) expect(((await reloaded.findByLabelText(name)) as HTMLInputElement).value).toBe(value);
  } finally {
    home.mockRestore();
    rmSync(dir, { recursive: true, force: true });
    cleanup();
    await harness.dispose();
  }
});
