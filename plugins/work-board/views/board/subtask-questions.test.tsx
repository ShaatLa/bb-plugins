// @vitest-environment jsdom
import { appendFileSync } from "node:fs";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  type FakePluginHarness,
} from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createStore, registerTasksApi } from "../../api";
import { tasksRpcContract } from "../../shared/contract";
import { createStructuredStore } from "../../structured/store";
import { taskTab, navTab } from "../../test-fixtures.js";

window.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
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
const app = await loadPluginApp(() => import("../../app"));
const harnesses: FakePluginHarness[] = [];
afterEach(async () => {
  cleanup();
  window.localStorage.clear();
  await Promise.all(harnesses.splice(0).map((h) => h.dispose()));
});

async function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  harnesses.push(harness);
  const store = createStore(bb);
  registerTasksApi(bb, store);
  const project = store.tasks.createProject({
    name: "Sub-task decisions",
    prefix: "SUB",
    color: "blue",
    linkedBbProjectId: "proj_subtasks",
  });
  const parent = store.tasks.createTask({
    projectId: project.id,
    title: "Parent task",
    status: "todo",
  });
  const child = store.tasks.createTask({
    projectId: project.id,
    title: "Completed child with a decision",
    parentTaskId: parent.id,
    status: "done",
  });
  const quietChild = store.tasks.createTask({
    projectId: project.id,
    title: "Quiet child",
    parentTaskId: parent.id,
  });
  const unrelated = store.tasks.createTask({
    projectId: project.id,
    title: "Unrelated task",
  });
  const structured = createStructuredStore(bb, store);
  const { question } = await structured.handlers.createQuestion({
    taskId: child.id,
    prompt: "Which option should we ship?",
    mode: "single",
    options: ["A", "B"],
  });
  const rpc = Object.fromEntries(
    Object.keys(tasksRpcContract).map((method) => [
      method,
      (input: unknown) => harness.callRpc(method, input),
    ]),
  );
  const sdk = {
    threads: {
      get: async () =>
        makeThreadResponse({ id: "thr_subtasks", projectId: "proj_subtasks" }),
    },
  };
  return {
    store,
    harness,
    project,
    parent,
    child,
    quietChild,
    unrelated,
    structured,
    question,
    rpc,
    sdk,
  };
}

it.each(["main", "side", "kanban"])(
  "finds sub-task questions from the parent on the %s board and opens the child",
  async (surface) => {
    const {
      project,
      parent,
      child,
      quietChild,
      unrelated,
      rpc,
      sdk,
      structured,
      question,
    } = await setup();
    const slot =
      surface === "side"
        ? renderSlot(taskTab(app), { threadId: "thr_subtasks", environment: null }, { rpc, sdk })
        : surface === "kanban"
          ? renderSlot(
              {
                component: navTab(app, "kanban").component,
              },
              { subPath: project.id },
              { rpc, sdk },
            )
          : renderSlot(
              app.navPanels[0]!,
              { subPath: `${project.id}?view=board` },
              { rpc },
            );
    const badge = await slot.findByRole("img", {
      name: "1 unanswered question",
    });
    expect(badge.getAttribute("title")).toBe("0 in this task; 1 in sub-tasks");
    expect(
      slot.container.querySelector(`[data-task-key="${child.key}"]`),
    ).toBeNull();
    expect(slot.queryByText(child.title)).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Needs answer" }));
    await waitFor(() => expect(slot.queryByText(unrelated.title)).toBeNull());
    expect(slot.getByText(parent.title)).toBeTruthy();
    const childList = await slot.findByRole("list", {
      name: `Sub-tasks of ${parent.key}`,
    });
    expect(
      within(childList).getByRole("button", {
        name: `Open sub-task ${child.key}: ${child.title}`,
      }),
    ).toBeTruthy();
    expect(within(childList).queryByText(quietChild.title)).toBeNull();
    expect(
      slot.container.querySelector(`[data-task-key="${child.key}"]`),
    ).toBeNull();
    fireEvent.click(
      within(childList).getByRole("button", {
        name: `Open sub-task ${child.key}: ${child.title}`,
      }),
    );
    if (surface === "side") {
      await slot.findByRole("group", { name: question.prompt });
      expect(slot.navigateCalls).toEqual([]);
      fireEvent.click(
        slot.getByRole("button", { name: "Back to project board" }),
      );
      await slot.findByRole("list", { name: `Sub-tasks of ${parent.key}` });
    } else {
      expect(slot.navigateCalls).toContainEqual({
        method: "toPluginPanel",
        path: "work-board",
        options: { subPath: `task/${child.key}` },
      });
    }
    await structured.handlers.answerQuestion({
      questionId: question.id,
      revision: question.revision,
      selectedOptionIds: [question.options[0]!.id],
      authorName: "Owner",
    });
    await slot.behavior.emitRealtime("tasks:changed", {
      taskId: child.id,
      projectId: project.id,
    });
    await waitFor(() => expect(slot.queryByText(parent.title)).toBeNull());
  },
);

it("adds own and child question counts, prioritizes children needing answers and keeps disclosure clicks off parent navigation", async () => {
  const { project, parent, child, quietChild, store, structured, rpc } =
    await setup();
  const { question: own } = await structured.handlers.createQuestion({
    taskId: parent.id,
    prompt: "Parent decision?",
    mode: "single",
    options: ["Yes", "No"],
  });
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: `${project.id}?view=board` },
    { rpc },
  );
  const badge = await slot.findByRole("img", {
    name: "2 unanswered questions",
  });
  expect(badge.getAttribute("title")).toBe("1 in this task; 1 in sub-tasks");
  fireEvent.click(
    slot.getByRole("button", {
      name: `Show sub-task questions for ${parent.key}`,
    }),
  );
  const list = await slot.findByRole("list", {
    name: `Sub-tasks of ${parent.key}`,
  });
  expect(
    within(list)
      .getAllByRole("listitem")
      .map((row) => row.getAttribute("data-subtask-key")),
  ).toEqual([child.key, quietChild.key]);
  expect(slot.navigateCalls).toEqual([]);
  const toggle = slot.getByRole("button", {
    name: `Sub-tasks of ${parent.key}`,
  });
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(
    slot.queryByRole("list", { name: `Sub-tasks of ${parent.key}` }),
  ).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Needs answer" }));
  await slot.findByRole("list", { name: `Sub-tasks of ${parent.key}` });
  store.tasks.updateTask(child.id, { parentTaskId: null });
  await slot.behavior.emitRealtime("tasks:changed", {
    taskId: child.id,
    projectId: project.id,
  });
  await waitFor(() =>
    expect(
      slot.queryByRole("button", {
        name: `Show sub-task questions for ${parent.key}`,
      }),
    ).toBeNull(),
  );
  expect(
    slot.container.querySelector(`[data-task-key="${parent.key}"]`),
  ).toBeTruthy();
  await waitFor(() =>
    expect(
      slot.container.querySelector(`[data-task-key="${child.key}"]`),
    ).toBeTruthy(),
  );
  expect(own.selectedOptionIds).toEqual([]);
});

it.each(["main", "side"])(
  "marks the exact sub-task needing an answer inside the %s task detail",
  async (surface) => {
    const {
      parent,
      child,
      quietChild,
      rpc,
      sdk,
      structured,
      question,
      project,
    } = await setup();
    const slot =
      surface === "side"
        ? renderSlot(taskTab(app), { threadId: "thr_subtasks", environment: null }, { rpc, sdk, experimental_fixedTabTarget: { tabId: "task", target: { taskKey: parent.key } } })
        : renderSlot(
            app.navPanels[0]!,
            { subPath: `task/${parent.key}` },
            { rpc },
          );
    const childRow = (await slot.findByText(child.title)).closest("button")!;
    await within(childRow).findByRole("img", { name: "1 unanswered question" });
    const quietRow = slot.getByText(quietChild.title).closest("button")!;
    expect(
      within(quietRow).queryByRole("img", { name: /unanswered/ }),
    ).toBeNull();
    await structured.handlers.answerQuestion({
      questionId: question.id,
      revision: question.revision,
      selectedOptionIds: [question.options[0]!.id],
      authorName: "Owner",
    });
    await slot.behavior.emitRealtime("tasks:changed", {
      taskId: child.id,
      projectId: project.id,
    });
    await waitFor(() =>
      expect(
        within(childRow).queryByRole("img", { name: /unanswered/ }),
      ).toBeNull(),
    );
    const { question: next } = await structured.handlers.createQuestion({
      taskId: child.id,
      prompt: "One more decision?",
      mode: "single",
      options: ["Yes", "No"],
    });
    await slot.behavior.emitRealtime("tasks:changed", {
      taskId: child.id,
      projectId: project.id,
    });
    await within(childRow).findByRole("img", { name: "1 unanswered question" });
    fireEvent.click(childRow);
    if (surface === "side") {
      await slot.findByRole("group", { name: next.prompt });
      expect(slot.navigateCalls).toEqual([]);
    } else {
      expect(slot.navigateCalls).toContainEqual({
        method: "toPluginPanel",
        path: "work-board",
        options: { subPath: `task/${child.key}` },
      });
    }
  },
);

it.each([{ count: 250, surface: "main" }, { count: 250, surface: "side" }, { count: 2500, surface: "main" }, { count: 2500, surface: "side" }])("shows $count cards before metadata, bounds DOM, scrolls and reopens ($surface)", async ({ count, surface }) => {
  const f = await setup();
  const statuses = ["backlog", "todo", "in_progress", "in_review", "done"] as const;
  let lastBacklog = f.unrelated;
  f.store.transaction(() => {
    for (let index = 0; index < count - 2; index++) {
      const task = f.store.tasks.createTask({ projectId: f.project.id, title: `Bulk card ${index}`, status: statuses[index % 5] });
      if (task.status === "backlog") lastBacklog = task;
    }
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const pending = new Promise<never>(() => {});
  const list = f.rpc.listTasks!;
  f.rpc.listTasks = async (input) => {
    if ((input as { cursor?: string }).cursor) await gate;
    return list(input);
  };
  for (const method of ["listTaskCardMeta", "listLabels", "questionCounts", "prSummaries"]) f.rpc[method] = () => pending;
  const options = { rpc: f.rpc, sdk: f.sdk };
  const mount = () => surface === "main"
    ? renderSlot(app.navPanels[0]!, { subPath: `${f.project.id}?view=board` }, options)
    : renderSlot(taskTab(app), { threadId: "thr_subtasks", environment: null }, options);
  const started = performance.now();
  const slot = mount();
  await waitFor(() => expect(slot.container.querySelectorAll("[data-task-key]").length).toBeGreaterThan(0), { timeout: 500 });
  const coldReadyMs = performance.now() - started;
  expect(coldReadyMs).toBeLessThan(500);
  expect(slot.container.querySelectorAll("[data-task-key]").length).toBeLessThan(120);
  release();
  await slot.findByText(`${count} tasks`);
  expect(slot.container.querySelectorAll("[data-task-key]").length).toBeLessThan(120);
  const backlog = slot.container.querySelector('[data-board-column="backlog"]')!;
  fireEvent.scroll(backlog, { target: { scrollTop: 1_000_000 } });
  await waitFor(() => expect(slot.container.querySelector(`[data-task-key="${lastBacklog.key}"]`)).not.toBeNull());
  expect(slot.container.querySelectorAll("[data-task-key]").length).toBeLessThan(120);
  if (count === 250 && surface === "main") {
    f.store.tasks.updateTask(lastBacklog.id, { title: "Changed while metadata is blocked" });
    await slot.behavior.emitRealtime("tasks:changed", { taskId: lastBacklog.id, projectId: f.project.id });
    await slot.findByText("Changed while metadata is blocked", {}, { timeout: 500 });
    const todo = slot.container.querySelector('[data-board-column="todo"]')!;
    fireEvent.click(slot.getByRole("button", { name: `Sub-tasks of ${f.parent.key}` }));
    await slot.findByRole("list", { name: `Sub-tasks of ${f.parent.key}` });
    fireEvent.scroll(todo, { target: { scrollTop: 1_000_000 } });
    await waitFor(() => expect(slot.queryByRole("button", { name: `Sub-tasks of ${f.parent.key}` })).toBeNull());
    fireEvent.scroll(todo, { target: { scrollTop: 0 } });
    expect((await slot.findByRole("button", { name: `Sub-tasks of ${f.parent.key}` })).getAttribute("aria-expanded")).toBe("true");
  }
  slot.lifecycle.unmount();
  f.rpc.listTasks = () => pending;
  const reopenedAt = performance.now();
  const reopened = mount();
  await reopened.findByText(`${count} tasks`, {}, { timeout: 500 });
  const warmReadyMs = performance.now() - reopenedAt;
  expect(warmReadyMs).toBeLessThan(500);
  const measurement = { count, surface, coldReadyMs, warmReadyMs, mountedCards: reopened.container.querySelectorAll("[data-task-key]").length };
  if (process.env.WORK_BOARD_PERF_OUT) appendFileSync(process.env.WORK_BOARD_PERF_OUT, JSON.stringify(measurement) + "\n");
  expect(reopened.container.querySelectorAll("[data-task-key]").length).toBeLessThan(120);
});
