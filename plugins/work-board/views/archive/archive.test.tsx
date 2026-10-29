// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from "../../api";
import { tasksRpcContract } from "../../shared/contract";
import { taskTab } from "../../test-fixtures.js";

window.matchMedia ??= (media) => ({
  matches: false,
  media,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => false,
});
window.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView ??= () => {};
const app = await loadPluginApp(() => import("../../app"));
const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  cleanup();
  window.localStorage.clear();
  await Promise.all(hosts.splice(0).map((h) => h.harness.dispose()));
});
function setup() {
  const host = createFakePluginHost({ pluginId: "work-board" });
  hosts.push(host);
  const store = createStore(host.bb);
  registerTasksApi(host.bb, store);
  const project = store.tasks.createProject({
    name: "Archive project",
    prefix: "ARC",
    color: "blue",
    linkedBbProjectId: "proj_archive",
  });
  const task = store.tasks.createTask({
    projectId: project.id,
    title: "A completed task",
    status: "done",
  });
  const rpc = Object.fromEntries(
    Object.keys(tasksRpcContract).map((method) => [
      method,
      (input: unknown) => host.harness.callRpc(method, input),
    ]),
  );
  return { ...host, store, project, task, rpc };
}

it("archives from a task card and exposes the restore action", async () => {
  const f = setup();
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: `task/${f.task.key}` },
    { rpc: f.rpc },
  );
  fireEvent.click(await slot.findByRole("button", { name: "Archive task" }));
  await waitFor(() =>
    expect(f.store.tasks.getTask(f.task.id)?.archivedAt).toBeTruthy(),
  );
  await slot.behavior.emitRealtime("tasks:changed", {
    taskId: f.task.id,
    projectId: f.project.id,
  });
  expect(
    await slot.findByRole("button", { name: "Restore task" }),
  ).toBeTruthy();
  expect(slot.queryByRole("button", { name: "Existing thread…" })).toBeNull();
});

it("provides a separate searchable archive with project bulk archive and restore", async () => {
  const f = setup();
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "archive" },
    { rpc: f.rpc },
  );
  expect(
    await slot.findByRole("textbox", { name: "Search archived tasks" }),
  ).toBeTruthy();
  fireEvent.keyDown(slot.getByRole("combobox", { name: "Archive project" }), {
    key: "ArrowDown",
  });
  fireEvent.click(await slot.findByRole("option", { name: f.project.name }));
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  fireEvent.click(slot.getByRole("button", { name: "Archive completed" }));
  await slot.findByRole("button", { name: `Restore ${f.task.key}` });
  fireEvent.change(
    slot.getByRole("textbox", { name: "Search archived tasks" }),
    { target: { value: "not-found" } },
  );
  await waitFor(() =>
    expect(
      slot.queryByRole("button", { name: `Restore ${f.task.key}` }),
    ).toBeNull(),
  );
  fireEvent.change(
    slot.getByRole("textbox", { name: "Search archived tasks" }),
    { target: { value: f.task.key } },
  );
  fireEvent.click(
    await slot.findByRole("button", { name: `Restore ${f.task.key}` }),
  );
  await waitFor(() =>
    expect(f.store.tasks.getTask(f.task.id)?.archivedAt).toBeNull(),
  );
});

it.each(["board", "list", "side"])(
  "removes an archived card from the %s on a realtime update",
  async (surface) => {
    const f = setup();
    const slot =
      surface === "side"
        ? renderSlot(taskTab(app), { threadId: "thr_archive", environment: null }, {
              rpc: f.rpc,
              sdk: {
                threads: {
                  get: async () =>
                    makeThreadResponse({
                      id: "thr_archive",
                      projectId: "proj_archive",
                    }),
                },
              },
            })
        : renderSlot(
            app.navPanels[0]!,
            { subPath: `${f.project.id}?view=${surface}` },
            { rpc: f.rpc },
          );
    await slot.findByText(f.task.title);
    await f.harness.callRpc("archiveTask", {
      taskId: f.task.id,
      archived: true,
    });
    await slot.behavior.emitRealtime("tasks:changed", {
      taskId: f.task.id,
      projectId: f.project.id,
    });
    await waitFor(() => expect(slot.queryByText(f.task.title)).toBeNull());
  },
);

it("browses newest pages and resets pagination when searching or filtering a UTC day", async () => {
  const f = setup();
  for (let i = 0; i < 25; i++)
    f.store.tasks.createTask({
      projectId: f.project.id,
      title: `Work ${i}`,
      status: "done",
    });
  f.store.tasks.archiveCompletedTasks(f.project.id);
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "archive" },
    { rpc: f.rpc },
  );
  await slot.findByRole("button", { name: `Restore ${f.task.key}` });
  fireEvent.keyDown(
    slot.getByRole("combobox", { name: "Archive latest count" }),
    { key: "ArrowDown" },
  );
  fireEvent.click(await slot.findByRole("option", { name: "25" }));
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() =>
    expect(
      slot.queryByRole("button", { name: `Restore ${f.task.key}` }),
    ).toBeNull(),
  );
  fireEvent.click(slot.getByRole("button", { name: "Next" }));
  await slot.findByRole("button", { name: `Restore ${f.task.key}` });
  fireEvent.change(
    slot.getByRole("textbox", { name: "Search archived tasks" }),
    { target: { value: f.task.key } },
  );
  await waitFor(() =>
    expect(
      slot.getByRole("button", { name: "Previous" }).hasAttribute("disabled"),
    ).toBe(true),
  );
  fireEvent.change(slot.getByLabelText("Archive from date"), {
    target: { value: "2099-01-01" },
  });
  fireEvent.change(slot.getByLabelText("Archive to date"), {
    target: { value: "2099-01-01" },
  });
  await slot.findByText("No archived tasks.");
});
