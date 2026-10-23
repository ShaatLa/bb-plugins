// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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
const app = await loadPluginApp(() => import("../../app"));
const harnesses: FakePluginHarness[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
});
function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "tasks-plus" });
  harnesses.push(harness);
  const store = createStore(bb);
  registerTasksApi(bb, store);
  const project = store.tasks.createProject({
    name: "Questions",
    prefix: "Q",
    color: "blue",
    linkedBbProjectId: "proj_questions",
  });
  const task = store.tasks.createTask({
    projectId: project.id,
    title: "Make a decision",
  });
  const rpc: Record<string, (input: unknown) => Promise<unknown>> =
    Object.fromEntries(
      Object.keys(tasksRpcContract).map((method) => [
        method,
        (input: unknown) => harness.callRpc(method, input),
      ]),
    );
  return {
    bb,
    store,
    project,
    task,
    rpc,
    structured: createStructuredStore(bb, store),
  };
}

describe("question and evidence UI", () => {
  it.each(["board", "list", "side"])(
    "filters unanswered questions on the %s surface and retains the preference",
    async (surface) => {
      window.localStorage.clear();
      const { store, project, task, rpc, structured } = setup();
      store.tasks.createTask({
        projectId: project.id,
        title: "No decision needed",
      });
      const { question } = await structured.handlers.createQuestion({
        taskId: task.id,
        prompt: "Proceed?",
        mode: "single",
        options: ["Yes", "No"],
      });
      const mount = () =>
        surface === "side"
          ? renderSlot(
              app.threadPanelActions[0]!,
              { threadId: "thr_questions", params: null },
              {
                rpc,
                sdk: {
                  threads: {
                    get: async () =>
                      makeThreadResponse({
                        id: "thr_questions",
                        projectId: "proj_questions",
                      }),
                  },
                },
              },
            )
          : renderSlot(
              app.navPanels[0]!,
              { subPath: `${project.id}?view=${surface}` },
              { rpc },
            );
      const slot = mount();
      await slot.findByText("Needs answer · 1");
      await slot.findByText("No decision needed");
      fireEvent.click(slot.getByRole("button", { name: "Needs answer" }));
      await waitFor(() =>
        expect(slot.queryByText("No decision needed")).toBeNull(),
      );
      expect(slot.getByText(task.title)).toBeTruthy();
      await structured.handlers.answerQuestion({
        questionId: question.id,
        revision: question.revision,
        selectedOptionIds: [question.options[0]!.id],
        authorName: "Owner",
      });
      slot.lifecycle.unmount();
      const restored = mount();
      const filter = await restored.findByRole("button", {
        name: "Needs answer",
      });
      expect(filter.getAttribute("aria-pressed")).toBe("true");
      await waitFor(() => expect(restored.queryByText(task.title)).toBeNull());
      fireEvent.click(filter);
      await restored.findByText(task.title);
      expect(restored.queryByText("Needs answer · 1")).toBeNull();
    },
  );

  it.each(["single", "multiple"] as const)(
    "creates a %s question centrally, saves the selection and restores it in the side panel",
    async (mode) => {
      const { task, rpc, structured } = setup();
      const slot = renderSlot(
        app.navPanels[0]!,
        { subPath: `task/${task.key}` },
        { rpc },
      );
      await slot.findByRole("textbox", { name: "Task title" });
      expect(slot.queryByRole("region", { name: "Questions" })).toBeNull();
      const addQuestion =
        mode === "single"
          ? within(slot.getByRole("complementary")).getByRole("button", {
              name: "Add question",
            })
          : slot
              .getAllByRole("button", { name: "Add question" })
              .find((button) => !button.closest("aside"))!;
      fireEvent.click(addQuestion);
      fireEvent.click(slot.getByRole("button", { name: "Cancel question" }));
      expect(slot.queryByRole("region", { name: "Questions" })).toBeNull();
      fireEvent.click(addQuestion);
      fireEvent.change(slot.getByRole("textbox", { name: "Question" }), {
        target: { value: "Choose platforms" },
      });
      fireEvent.change(slot.getByRole("textbox", { name: "Option 1" }), {
        target: { value: "macOS" },
      });
      fireEvent.change(slot.getByRole("textbox", { name: "Option 2" }), {
        target: { value: "Linux" },
      });
      if (mode === "multiple")
        fireEvent.click(
          slot.getByRole("checkbox", { name: "Allow multiple answers" }),
        );
      fireEvent.click(slot.getByRole("button", { name: "Create question" }));
      const group = await slot.findByRole("group", {
        name: "Choose platforms",
      });
      const section = slot.getByRole("region", { name: "Questions" });
      expect(
        within(section).queryByRole("button", { name: "Add question" }),
      ).toBeNull();
      expect(slot.queryByRole("textbox", { name: "Question" })).toBeNull();
      fireEvent.click(within(group).getByLabelText("macOS"));
      fireEvent.click(within(group).getByLabelText("Linux"));
      fireEvent.click(
        within(group).getByRole("button", { name: "Save answer" }),
      );
      await waitFor(() =>
        expect(
          structured.listQuestions(task.id)[0]?.selectedOptionIds,
        ).toHaveLength(mode === "single" ? 1 : 2),
      );
      const question = structured.listQuestions(task.id)[0]!;
      expect(question.selectedOptionIds).toEqual(
        mode === "single"
          ? [question.options[1]!.id]
          : question.options.map((option) => option.id),
      );
      slot.lifecycle.unmount();
      const side = renderSlot(
        app.threadPanelActions[0]!,
        { threadId: "thr_questions", params: { taskKey: task.key } },
        {
          rpc,
          sdk: {
            threads: {
              get: async () =>
                makeThreadResponse({
                  id: "thr_questions",
                  projectId: "proj_questions",
                }),
            },
          },
        },
      );
      const restored = await side.findByRole("group", {
        name: "Choose platforms",
      });
      expect(within(restored).getByLabelText("Linux")).toHaveProperty(
        "checked",
        true,
      );
      expect(within(restored).getByLabelText("macOS")).toHaveProperty(
        "checked",
        mode === "multiple",
      );
      expect(side.navigateCalls).toEqual([]);
    },
  );

  it("renders the evidence index above activity, preserves full hashes and opens its thread", async () => {
    const { task, store, rpc } = setup();
    store.tasks.createComment({
      taskId: task.id,
      kind: "user",
      authorName: "Reviewer",
      body: "Review verdict remark",
      evidence: {
        kind: "review",
        pr: 12,
        head: "a".repeat(40),
        verdict: "approve",
        thread: "thr_review",
      },
    });
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: `task/${task.key}` },
      { rpc },
    );
    const section = await slot.findByRole("region", { name: "Evidence" });
    expect(within(section).getByText("approve")).toBeTruthy();
    expect(within(section).getByText("a".repeat(9)).getAttribute("title")).toBe(
      "a".repeat(40),
    );
    fireEvent.click(
      within(section).getByRole("button", { name: "thr_review" }),
    );
    expect(slot.navigateCalls).toContainEqual({
      method: "toThread",
      threadId: "thr_review",
    });
    const headings = Array.from(
      slot.container.querySelectorAll("h2"),
      (element) => element.textContent,
    );
    expect(headings.indexOf("Evidence")).toBeLessThan(
      headings.indexOf("Activity"),
    );
  });
});
