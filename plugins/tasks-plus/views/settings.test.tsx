// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from "../api";

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
const app = await loadPluginApp(() => import("../app"));
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

it("saves a project workflow in compact settings and uses it in the list, board and task picker", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "tasks-plus" });
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
      settings.getByRole("button", { name: "Open Tasks" }).className,
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
    expect(store.tasks.getProject(other.id)?.statuses).toHaveLength(6);
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
    list.lifecycle.unmount();
    const board = renderSlot(
      app.navPanels[0]!,
      { subPath: `${project.id}?view=board` },
      { rpc },
    );
    await board.findByText(task.title);
    expect(
      board.getByRole("button", { name: "New In testing task" }),
    ).toBeTruthy();
    fireEvent.click(board.getByText(task.title));
    expect(board.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "tasks",
      options: { subPath: `task/${task.key}` },
    });
    board.lifecycle.unmount();
    const detail = renderSlot(
      app.navPanels[0]!,
      { subPath: `task/${task.key}` },
      { rpc },
    );
    await detail.findByRole("textbox", { name: "Task title" });
    const status = await detail.findAllByRole("button", { name: "In testing" });
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
  const { bb, harness } = createFakePluginHost({ pluginId: "tasks-plus" });
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
          ["listProjects", "updateProject"].map((method) => [
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
    expect(settings.queryByRole("button", { name: /Move .+ up/ })).toBeNull();
    backlog.focus();
    fireEvent.change(backlog, { target: { value: "Incoming" } });
    fireEvent.keyDown(backlog, { key: "Enter" });
    await waitFor(() =>
      expect(store.tasks.getProject(project.id)?.statuses?.[0]).toEqual({
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
