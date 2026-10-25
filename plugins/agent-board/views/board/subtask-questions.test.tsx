// @vitest-environment jsdom
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
  const { bb, harness } = createFakePluginHost({ pluginId: "agent-board" });
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
        ? renderSlot(
            app.threadPanelActions[0]!,
            { threadId: "thr_subtasks", params: null },
            { rpc, sdk },
          )
        : surface === "kanban"
          ? renderSlot(
              {
                component: app.navPanels[0]!.fixedTabs!.find(
                  (tab) => tab.id === "kanban",
                )!.component,
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
        path: "agent-board",
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
        ? renderSlot(
            app.threadPanelActions[0]!,
            { threadId: "thr_subtasks", params: { taskKey: parent.key } },
            { rpc, sdk },
          )
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
        path: "agent-board",
        options: { subPath: `task/${child.key}` },
      });
    }
  },
);
