// @vitest-environment jsdom
import { registerAttachments, saveAttachmentFromBytes } from "../../attachments";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  type FakePluginHarness,
} from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createStore, registerTasksApi } from "../../api";
import { tasksRpcContract, type TaskQuestion } from "../../shared/contract";
import { createStructuredStore } from "../../structured/store";
import { refreshCheckFlow } from "../../db/check-flow";
import { taskTab } from "../../test-fixtures.js";
import { stubDetailWidth } from "./test-width.js";

window.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
const app = await loadPluginApp(() => import("../../app"));
const harnesses: FakePluginHarness[] = [];
const setDetailWidth = stubDetailWidth(1000);
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
});
function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  harnesses.push(harness);
  const store = createStore(bb);
  registerAttachments(bb, store.tasks);
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

/** Opens Earlier and the answer form of its only confirmed or answered check. */
async function changeAnswer(slot: ReturnType<typeof renderSlot>) {
  fireEvent.click(await slot.findByText(/^Earlier \(/));
  fireEvent.click(await slot.findByRole("button", { name: "Change answer" }));
}

describe("question and evidence UI", () => {
  it.each([false, true])("uploads selected/pasted/dropped files before answering and cleans up on failure=%s", async fails => {
    const { task, rpc, structured, store } = setup();
    const { question } = await structured.handlers.createQuestion({ taskId: task.id, kind: "decision", askedByThread: null, prompt: "Approve files?", mode: "single", options: ["Yes"] });
    const uploaded: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/token")) return { ok: true, json: async () => ({ token: "test" }) };
      if (url.includes("/attachments/upload")) {
        const file = init!.body as File;
        const attachment = await saveAttachmentFromBytes(store.tasks, new Uint8Array(file.size), { taskId: task.id, fileName: file.name, mime: file.type });
        uploaded.push(attachment.id);
        return { ok: true, json: async () => ({ attachmentId: attachment.id, url: "/download" }) };
      }
      throw new Error(`Unexpected fetch ${url}`);
    }));
    const save = rpc.answerQuestion!;
    rpc.answerQuestion = async input => {
      expect(uploaded).toHaveLength(3);
      if (fails) throw new Error("Answer failed");
      return save(input);
    };
    const slot = renderSlot(app.navPanels[0]!, { subPath: `task/${task.key}` }, { rpc });
    const answer = await slot.findByRole("textbox", { name: "Your answer" });
    const image = new File(["png"], "screen.png", { type: "image/png" });
    fireEvent.change(slot.getByLabelText("Answer files"), { target: { files: [image] } });
    expect(slot.getByRole("button", { name: "Attach files" })).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Preview screen.png" }));
    // The SDK lightbox renders the full image next to the thumbnail.
    expect(slot.getAllByRole("img", { name: "screen.png" })).toHaveLength(2);
    fireEvent.paste(answer, { clipboardData: { files: [new File(["log"], "log.txt", { type: "text/plain" })] } });
    fireEvent.drop(answer, { dataTransfer: { files: [new File(["drop"], "drop.txt", { type: "text/plain" })] } });
    expect(slot.getByRole("button", { name: "Save answer" })).toHaveProperty("disabled", true);
    fireEvent.click(slot.getByRole("radio", { name: "Yes" }));
    fireEvent.click(slot.getByRole("button", { name: "Save answer" }));
    if (fails) {
      await slot.findByText("Answer failed");
      await waitFor(() => expect(store.tasks.listAttachmentsForTask(task.id)).toEqual([]));
      expect(uploaded.every(id => !store.tasks.getAttachment(id))).toBe(true);
    } else {
      await slot.findByText("Earlier (1)");
      const section = slot.getByRole("region", { name: "Questions" });
      await waitFor(() => expect(within(section).getByRole("img", { name: "screen.png", hidden: true })).toBeTruthy());
      expect(within(section).getByText("log.txt").closest("a")?.getAttribute("download")).toBe("log.txt");
      fireEvent.click(within(section).getByRole("img", { name: "screen.png", hidden: true }));
      expect(slot.getByRole("dialog", { name: "screen.png" })).toBeTruthy();
      expect(structured.listQuestions(task.id)[0]?.answeredBy).toBe("You");
      expect(store.tasks.listAttachmentsForTask(task.id)).toEqual([]);
    }
  });

  it("creates and edits bold recommendations without preselecting an answer", async () => {
    const { task, rpc, structured } = setup();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: `task/${task.key}` },
      { rpc },
    );
    fireEvent.click(
      within(await slot.findByRole("complementary")).getByRole("button", {
        name: "Add question",
      }),
    );
    fireEvent.change(slot.getByRole("textbox", { name: "Question" }), {
      target: { value: "Which approach?" },
    });
    for (const [index, label] of ["A", "B"].entries())
      fireEvent.change(
        slot.getByRole("textbox", { name: `Option ${index + 1}` }),
        { target: { value: label } },
      );
    fireEvent.click(
      slot.getByRole("checkbox", { name: "Allow multiple answers" }),
    );
    fireEvent.click(slot.getByRole("checkbox", { name: "Recommend option 1" }));
    fireEvent.click(slot.getByRole("checkbox", { name: "Recommend option 2" }));
    fireEvent.click(
      slot.getByRole("checkbox", { name: "Allow multiple answers" }),
    );
    expect(
      slot.getByRole("checkbox", { name: "Recommend option 2" }),
    ).toHaveProperty("checked", false);
    fireEvent.change(
      slot.getByRole("textbox", { name: "Recommendation reason 1" }),
      { target: { value: "Safer" } },
    );
    fireEvent.click(slot.getByRole("button", { name: "Create question" }));
    const group = await slot.findByRole("group", { name: "Which approach?" });
    const choice = within(group).getByRole("radio", { name: /A/ });
    expect(choice).toHaveProperty("checked", false);
    expect(choice.closest("label")?.querySelector("strong")?.textContent).toBe(
      "A",
    );
    expect(within(group).getByText("Safer")).toBeTruthy();
    expect(structured.listQuestions(task.id)[0]?.selectedOptionIds).toEqual([]);
    fireEvent.click(
      within(group).getByRole("button", { name: "Edit question" }),
    );
    fireEvent.click(slot.getByRole("checkbox", { name: "Recommend option 2" }));
    fireEvent.click(slot.getByRole("button", { name: "Save question" }));
    await waitFor(() =>
      expect(
        structured.listQuestions(task.id)[0]?.options[1]?.recommended,
      ).toBe(true),
    );
    await waitFor(() =>
      expect(slot.queryByRole("textbox", { name: "Question" })).toBeNull(),
    );
    const current = structured.listQuestions(task.id)[0]!;
    expect(current.options[0]!.recommended).toBeUndefined();
    expect(current.history[0]!.options[0]).toMatchObject({
      recommended: true,
      recommendationReason: "Safer",
    });
  });

  it("renders explicit legacy recommendation suffixes in bold without changing their stored labels", async () => {
    const { task, rpc, structured } = setup();
    await structured.handlers.createQuestion({ kind: "decision", askedByThread: null,
      taskId: task.id,
      prompt: "Legacy?",
      mode: "single",
      options: ["A (рекомендую)", "B"],
    });
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: `task/${task.key}` },
      { rpc },
    );
    const group = await slot.findByRole("group", { name: "Legacy?" });
    const choice = within(group).getByRole("radio", { name: "A" });
    expect(choice).toHaveProperty("checked", false);
    expect(choice.closest("label")?.querySelector("strong")?.textContent).toBe(
      "A",
    );
    expect(structured.listQuestions(task.id)[0]!.options[0]!.label).toBe(
      "A (рекомендую)",
    );
  });

  it("links bare URLs in a question prompt without the trailing punctuation", async () => {
    const { task, rpc, structured } = setup();
    const prompt = "Open http://127.0.0.1:8796/Example%20Avatar.html?lang=ru&theme=dark. Correct?";
    await structured.handlers.createQuestion({ kind: "check", askedByThread: null, taskId: task.id, prompt, mode: "single", options: [] });
    const slot = renderSlot(app.navPanels[0]!, { subPath: `task/${task.key}` }, { rpc });
    const group = await slot.findByRole("group", { name: prompt });
    const link = within(group).getByRole("link", { name: "http://127.0.0.1:8796/Example%20Avatar.html?lang=ru&theme=dark" });
    expect(link.getAttribute("href")).toBe("http://127.0.0.1:8796/Example%20Avatar.html?lang=ru&theme=dark");
    fireEvent.click(link);
    expect(slot.navigateCalls).toContainEqual(expect.objectContaining({ method: "openUrl", url: "http://127.0.0.1:8796/Example%20Avatar.html?lang=ru&theme=dark" }));
  });

  it("lists a check's steps between the question and its answers", async () => {
    const { task, rpc, structured } = setup();
    await structured.handlers.createQuestion({ kind: "check", askedByThread: null, taskId: task.id, prompt: "Does the form save?", steps: ["Open the form", "Press Save"], mode: "single", options: [] });
    const slot = renderSlot(app.navPanels[0]!, { subPath: `task/${task.key}` }, { rpc });
    const group = await slot.findByRole("group", { name: "Does the form save?" });
    const steps = within(group).getByRole("list", { name: "How to check" });
    expect(within(steps).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Open the form", "Press Save"]);
  });

  it("requires explicit confirmation to revise an answered question and displays the old decision", async () => {
    const { task, rpc, structured } = setup();
    const { question } = await structured.handlers.createQuestion({ kind: "decision", askedByThread: null,
      taskId: task.id,
      prompt: "Original question",
      mode: "single",
      options: ["Small", "Large"],
    });
    await structured.handlers.answerQuestion({
      questionId: question.id,
      revision: 1,
      selectedOptionIds: [question.options[0]!.id],
      authorName: "Owner",
    });
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: `task/${task.key}` },
      { rpc },
    );
    fireEvent.click(await slot.findByRole("button", { name: "Edit question" }));
    fireEvent.change(slot.getByRole("textbox", { name: "Question" }), {
      target: { value: "New question" },
    });
    fireEvent.change(slot.getByRole("textbox", { name: "Option 1" }), {
      target: { value: "Compact" },
    });
    const save = slot.getByRole("button", { name: "Save question" });
    expect(save).toHaveProperty("disabled", true);
    fireEvent.click(
      slot.getByRole("checkbox", {
        name: "Clear the saved answer and request a new decision",
      }),
    );
    fireEvent.click(save);
    const group = await slot.findByRole("group", { name: "New question" });
    await waitFor(() =>
      expect(slot.queryByRole("textbox", { name: "Question" })).toBeNull(),
    );
    expect(within(group).getByLabelText("Compact")).toHaveProperty(
      "checked",
      false,
    );
    expect(
      within(group).getByText(
        "A new answer is required. Previous decisions are retained in history.",
      ),
    ).toBeTruthy();
    expect(within(group).getByText("Answer: Small · Owner")).toBeTruthy();
    const current = structured.listQuestions(task.id)[0]!;
    expect(current.history.at(-1)?.options).toEqual(question.options);
    expect(current.options[0]!.id).toBe(question.options[0]!.id);
  });

  it("keeps an unsaved answer across leaving the task until it is saved", async () => {
    const { task, rpc, structured } = setup();
    await structured.handlers.createQuestion({ kind: "decision", askedByThread: null, taskId: task.id, prompt: "Draft?", mode: "single", options: ["Now", "Later"] });
    const open = () => renderSlot(app.navPanels[0]!, { subPath: `task/${task.key}` }, { rpc });
    const first = open();
    fireEvent.change(within(await first.findByRole("group", { name: "Draft?" })).getByRole("textbox", { name: "Your answer" }), { target: { value: "Half written" } });
    first.lifecycle.unmount();
    const second = open();
    const group = await second.findByRole("group", { name: "Draft?" });
    expect(within(group).getByRole("textbox", { name: "Your answer" })).toHaveProperty("value", "Half written");
    fireEvent.click(within(group).getByRole("button", { name: "Save answer" }));
    await waitFor(() => expect(structured.listQuestions(task.id)[0]?.answerText).toBe("Half written"));
    expect(Object.keys(window.localStorage).filter(key => key.startsWith("bb-work-board:answer-draft:"))).toEqual([]);
    window.localStorage.clear();
  });

  it("hides the unanswered snapshot an answer replaces and labels versions replaced before an answer", async () => {
    const { task, rpc, structured } = setup();
    const { question } = await structured.handlers.createQuestion({ kind: "check", askedByThread: null, taskId: task.id, prompt: "First wording?", mode: "single", options: [] });
    const revised = (await structured.handlers.updateQuestion({ questionId: question.id, revision: question.revision, prompt: "Second wording?", mode: "single", options: question.options, authorName: "Agent" })).question;
    await structured.handlers.answerQuestion({ questionId: question.id, revision: revised.revision, selectedOptionIds: [revised.options[0]!.id], authorName: "You" });
    const slot = renderSlot(app.navPanels[0]!, { subPath: `task/${task.key}` }, { rpc });
    await changeAnswer(slot);
    const history = await slot.findByText("History · 1");
    const entries = history.closest("details")!.querySelectorAll("ol > li");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.textContent).toContain("First wording?");
    expect(entries[0]!.textContent).toContain("none, replaced before an answer");
  });

  it("withdraws a saved answer after a confirming second click and records it for the agent", async () => {
    const { task, rpc, structured, store } = setup();
    const { question } = await structured.handlers.createQuestion({ kind: "check", askedByThread: null, taskId: task.id, prompt: "Accept?", mode: "single", options: [] });
    await structured.handlers.answerQuestion({ questionId: question.id, revision: question.revision, selectedOptionIds: [question.options[0]!.id], authorName: "You" });
    const slot = renderSlot(app.navPanels[0]!, { subPath: `task/${task.key}` }, { rpc });
    store.tasks.updateProject(task.projectId, { checkReadiness: "on" });
    await changeAnswer(slot);
    fireEvent.click(await slot.findByRole("button", { name: "Withdraw answer" }));
    fireEvent.click(slot.getByRole("button", { name: "Confirm: withdraw and notify the agent" }));
    await waitFor(() => expect(structured.listQuestions(task.id)[0]?.answeredBy).toBeNull());
    expect(store.tasks.listComments(task.id).map(comment => comment.body).join("\n")).toContain("Answer withdrawn (was: Approve)");
    expect(store.tasks.listTasks({ waitingOnOwner: true }).map(t => t.id)).toContain(task.id);
  });

  it("saves an allowed custom answer and restores it in the card", async () => {
    const { task, rpc, structured } = setup();
    await structured.handlers.createQuestion({ kind: "decision", askedByThread: null,
      taskId: task.id,
      prompt: "Delivery?",
      mode: "single",
      options: ["Now", "Later"],
      allowOther: true,
    });
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: `task/${task.key}` },
      { rpc },
    );
    const group = await slot.findByRole("group", { name: "Delivery?" });
    expect(
      within(group).getByRole("button", { name: "Save answer" }),
    ).toHaveProperty("disabled", true);
    fireEvent.change(
      within(group).getByRole("textbox", { name: "Your answer" }),
      { target: { value: "After review" } },
    );
    fireEvent.click(within(group).getByRole("button", { name: "Save answer" }));
    await waitFor(() =>
      expect(structured.listQuestions(task.id)[0]?.answerText).toBe(
        "After review",
      ),
    );
    slot.lifecycle.unmount();
    const restored = renderSlot(
      app.navPanels[0]!,
      { subPath: `task/${task.key}` },
      { rpc },
    );
    fireEvent.click(await restored.findByText("Earlier (1)"));
    expect(
      await restored.findByRole("textbox", { name: "Your answer" }),
    ).toHaveProperty("value", "After review");
  });

  it.each(["board", "list", "side"])(
    "filters unanswered questions on the %s surface and retains the preference",
    async (surface) => {
      window.localStorage.clear();
      const { store, project, task, rpc, structured } = setup();
      store.tasks.createTask({
        projectId: project.id,
        title: "No decision needed",
      });
      const { question } = await structured.handlers.createQuestion({ kind: "decision", askedByThread: null,
        taskId: task.id,
        prompt: "Proceed?",
        mode: "single",
        options: ["Yes", "No"],
      });
      const mount = () =>
        surface === "side"
          ? renderSlot(taskTab(app), { threadId: "thr_questions", environment: null }, {
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
              })
          : renderSlot(
              app.navPanels[0]!,
              { subPath: `${project.id}?view=${surface}` },
              { rpc },
            );
      const slot = mount();
      await slot.findByRole("img", { name: "1 unanswered question" });
      await slot.findByText("No decision needed");
      fireEvent.click(slot.getByRole("button", { name: "Waiting on me" }));
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
        name: "Waiting on me",
      });
      expect(filter.getAttribute("aria-pressed")).toBe("true");
      await waitFor(() => expect(restored.queryByText(task.title)).toBeNull());
      fireEvent.click(filter);
      await restored.findByText(task.title);
      expect(
        restored.queryByRole("img", { name: "1 unanswered question" }),
      ).toBeNull();
    },
  );

  it.each(["single", "multiple"] as const)(
    "creates a %s question centrally, saves the selection and restores it in the side panel",
    async (mode) => {
      const { task, rpc, structured } = setup();
      // The narrow layout has the inline properties' button; the wide one has the rail's.
      if (mode === "multiple") setDetailWidth(480);
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
      const side = renderSlot(taskTab(app), { threadId: "thr_questions", environment: null }, {
          rpc,
          sdk: {
            threads: {
              get: async () =>
                makeThreadResponse({
                  id: "thr_questions",
                  projectId: "proj_questions",
                }),
            },
          }, experimental_fixedTabTarget: { tabId: "task", target: { taskKey: task.key } } });
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
    const details = section.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(within(section).getByText("· 1")).toBeTruthy();
    fireEvent.click(within(section).getByText("Evidence"));
    expect(details.open).toBe(true);
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

it("omits the redundant waiting banner", async () => {
  const { task, rpc, structured } = setup();
  await structured.handlers.createQuestion({kind: "check", askedByThread: null, taskId: task.id, prompt: "Validate", mode: "single", options: [] });
  const slot = renderSlot(app.navPanels[0]!, { subPath: `task/${task.key}` }, { rpc });
  await slot.findByText(task.title);
  expect(slot.queryByRole("button", { name: /Waiting on you/ })).toBeNull();
});

it("orders open questions oldest first and moves an answered check to Earlier with its number", async () => {
  const { task, rpc, structured, bb } = setup();
  const add = async (prompt: string, kind: "decision" | "check", createdAt: string) => {
    const { question } = await structured.handlers.createQuestion({ taskId: task.id, kind, askedByThread: null, prompt, options: ["Proceed"], mode: "single" });
    bb.storage.database().prepare("UPDATE task_questions SET payload=json_set(payload, '$.createdAt', ?) WHERE id=?").run(createdAt, question.id);
    return question;
  };
  const earlier = await add("Old answer", "decision", "2026-01-01T00:00:00Z");
  await structured.handlers.answerQuestion({ questionId: earlier.id, revision: 1, selectedOptionIds: [earlier.options[0]!.id], authorName: "Owner" });
  await add("Older open", "decision", "2026-01-02T00:00:00Z");
  const newest = await add("Newest check", "check", "2026-01-03T00:00:00Z");
  const slot = renderSlot(app.navPanels[0]!, { subPath: `task/${task.key}` }, { rpc });
  const newestGroup = await slot.findByRole("group", { name: newest.prompt });
  const section = newestGroup.closest('section[aria-label="Questions"]')!;
  const groups = [...section.querySelectorAll("fieldset")];
  expect(groups.map(group => group.getAttribute("aria-label"))).toEqual(["Older open", "Newest check", "Old answer"]);
  expect(slot.getByText("Earlier (1)").closest("details")?.open).toBe(false);
  expect(within(newestGroup).getByText("Check")).toBeTruthy();
  expect(within(newestGroup).getByRole("textbox", { name: "Comment (optional)" })).toBeTruthy();
  fireEvent.click(within(newestGroup).getByLabelText("Proceed"));
  fireEvent.click(within(newestGroup).getByRole("button", { name: "Save answer" }));
  // An answered check leaves the live list for Earlier, where it keeps its number and shows the verdict read-only.
  await waitFor(() => expect(slot.getByText("Earlier (2)")).toBeTruthy());
  expect([...section.querySelectorAll("fieldset")].map(group => group.getAttribute("aria-label"))).toEqual(["Older open", "Old answer"]);
  const earlierList = slot.getByText("Earlier (2)").closest("details")!;
  expect(earlierList.textContent).toContain("Check 1 · Answered");
  expect(earlierList.textContent).toContain("Proceed");
});

it("closes the edit form and keeps a withdrawn chain head and its predecessor in Earlier", async () => {
  const { task, rpc, structured } = setup();
  const input = { kind: "check" as const, askedByThread: null, taskId: task.id, mode: "single" as const, options: [] };
  const { question: old } = await structured.handlers.createQuestion({ ...input, prompt: "Does the list load?" });
  const { question: head } = await structured.handlers.createQuestion({ ...input, prompt: "Does the [new list](https://example.com/list) load?", supersedes: { questionId: old.id, revision: 1 } });
  const slot = renderSlot(app.navPanels[0]!, { subPath: `task/${task.key}` }, { rpc });
  const group = await slot.findByRole("group", { name: head.prompt });
  fireEvent.click(within(group).getByRole("button", { name: "Edit question" }));
  expect(slot.getByRole("textbox", { name: "Question" })).toBeTruthy();
  const { question } = await structured.handlers.withdrawQuestion({ taskId: task.id, questionId: head.id, revision: 1, reason: "Review canceled", authorName: "Agent" });
  await slot.behavior.emitRealtime("tasks:changed", { taskId: task.id, projectId: task.projectId });
  await slot.findByText("This question was withdrawn, so the edit was closed.");
  expect(slot.queryByRole("textbox", { name: "Question" })).toBeNull();
  const earlier = slot.getByText("Earlier (1)").closest("details")!;
  expect(earlier.textContent).toContain("Withdrawn by Agent");
  expect(earlier.textContent).toContain("Review canceled");
  expect(earlier.querySelector("time")?.dateTime).toBe(question.withdrawnAt);
  expect(within(earlier).getByText("Replaces an earlier check")).toBeTruthy();
  // The withdrawn card's own prompt renders its Markdown link.
  const promptLink = within(earlier).getAllByRole("link", { name: "new list" }).find((link) => link.closest("p.font-medium"));
  expect(promptLink?.getAttribute("href")).toBe("https://example.com/list");
});

it("closes an open edit form when the check is superseded and shows it dimmed under its successor without controls", async () => {
  const { task, rpc, structured } = setup();
  const { question: old } = await structured.handlers.createQuestion({ kind: "check", askedByThread: null, taskId: task.id, prompt: "Does the old list render?", mode: "single", options: [] });
  await structured.handlers.answerQuestion({ questionId: old.id, revision: 1, selectedOptionIds: [], answerText: "Problem found: rows overlap", authorName: "Owner" });
  const slot = renderSlot(app.navPanels[0]!, { subPath: `task/${task.key}` }, { rpc });
  fireEvent.click(await slot.findByRole("button", { name: "Change answer" }));
  const group = await slot.findByRole("group", { name: old.prompt });
  fireEvent.click(within(group).getByRole("button", { name: "Edit question" }));
  expect(slot.getByRole("textbox", { name: "Question" })).toBeTruthy();
  await structured.handlers.createQuestion({ kind: "check", askedByThread: null, taskId: task.id, prompt: "Does the new list render?", mode: "single", options: [], supersedes: { questionId: old.id, revision: 2 } });
  await slot.behavior.emitRealtime("tasks:changed", { taskId: task.id, projectId: task.projectId });
  await waitFor(() => expect(slot.queryByRole("textbox", { name: "Question" })).toBeNull());
  await slot.findByText("This check was replaced by a newer one, so the edit was closed.");
  expect(slot.queryByRole("group", { name: old.prompt })).toBeNull();
  expect(slot.queryByText(/Earlier/)).toBeNull();
  const superseded = slot.getByLabelText(`Superseded check: ${old.prompt}`);
  expect(superseded.closest("details")?.open).toBe(false);
  expect(within(superseded).getByText(/Problem found: rows overlap/)).toBeTruthy();
  expect(within(superseded).getByText(/Replaced by a later check/).textContent).toContain("Does the new list render?");
  expect(within(superseded).queryByRole("button")).toBeNull();
  expect(within(superseded).queryByRole("textbox")).toBeNull();
  expect(within(slot.getByRole("group", { name: "Does the new list render?" })).getByRole("button", { name: "Save answer" })).toBeTruthy();
});

it("reads a superseded check neutrally after withdraw, reopen or withdraw-then-edit, apart from one never answered, and keeps its history", async () => {
  const { task, rpc, structured } = setup();
  const ask = async (prompt: string, supersedes?: { questionId: string; revision: number }) =>
    (await structured.handlers.createQuestion({ kind: "check", askedByThread: null, taskId: task.id, prompt, mode: "single", options: [], ...(supersedes ? { supersedes } : {}) })).question;
  const answer = async (question: { id: string }, revision: number, text: string | null) =>
    (await structured.handlers.answerQuestion({ questionId: question.id, revision, selectedOptionIds: [], answerText: text, authorName: "Owner" })).question;
  // withdraw → supersede
  const withdrawn = await ask("Does the chart load?");
  await answer(withdrawn, 1, "Problem found: empty axis");
  await answer(withdrawn, 2, null);
  await ask("Does the chart load now?", { questionId: withdrawn.id, revision: 3 });
  // reopen → supersede
  const reopened = await ask("Does the tooltip show?");
  const answered = await answer(reopened, 1, "Confirmed by hand");
  await structured.handlers.updateQuestion({ questionId: reopened.id, revision: answered.revision, prompt: reopened.prompt, mode: "single", options: answered.options, reopen: true, authorName: "Agent" });
  await ask("Does the tooltip show now?", { questionId: reopened.id, revision: 3 });
  // withdraw → edit → supersede
  const edited = await ask("Does the badge count?");
  await answer(edited, 1, "Problem found: off by one");
  const cleared = await answer(edited, 2, null);
  await structured.handlers.updateQuestion({ questionId: edited.id, revision: cleared.revision, prompt: "Does the badge count correctly?", mode: "single", options: cleared.options, authorName: "Agent" });
  await ask("Does the badge count now?", { questionId: edited.id, revision: 4 });
  // never answered → supersede
  const unanswered = await ask("Does the legend show?");
  await ask("Does the legend show now?", { questionId: unanswered.id, revision: 1 });
  const slot = renderSlot(app.navPanels[0]!, { subPath: `task/${task.key}` }, { rpc });
  for (const [id, prompt, earlier] of [[withdrawn.id, withdrawn.prompt, "Problem found: empty axis"], [reopened.id, reopened.prompt, "Confirmed by hand"], [edited.id, "Does the badge count correctly?", "Problem found: off by one"]] as const) {
    const row = await slot.findByLabelText(`Superseded check: ${prompt}`);
    expect(within(row).getByText("Previously answered; no current answer when superseded")).toBeTruthy();
    expect(within(row).queryByText(/withdrawn/i)).toBeNull();
    const link = slot.getAllByRole("link", { name: "Replaces an earlier check" }).find((candidate) => candidate.getAttribute("href") === `#${row.id}`)!;
    expect(id).toBeTruthy();
    expect(link.parentElement!.nextElementSibling!.textContent).toMatch(/No current answer · last answer · Owner · /);
    expect(link.parentElement!.nextElementSibling!.textContent).toContain(earlier);
    // The history view still shows the earlier answer.
    expect(within(row).getByText(/History · /)).toBeTruthy();
    expect(within(row).getByText(new RegExp(earlier))).toBeTruthy();
  }
  const never = slot.getByLabelText(`Superseded check: ${unanswered.prompt}`);
  expect(slot.getByText("Not answered")).toBeTruthy();
  expect(within(never).getByText("No answer before it was superseded")).toBeTruthy();
});

async function exampleChain() {
  const { task, rpc, structured } = setup();
  await structured.handlers.createQuestion({
    taskId: task.id, kind: "check", mode: "single", options: ["Confirmed", "Reviewed"],
    prompt: "Check the preview", askedByThread: null,
  });
  const question = structured.listQuestions(task.id)[0]!;
  const first = { ...question, id: "example-001", supersededBy: "example-002" };
  const second = { ...question, id: "example-002", supersedes: first.id };
  const render = (...questions: TaskQuestion[]) => renderSlot(app.navPanels[0]!, { subPath: `task/${task.key}` }, {
    rpc: { ...rpc, listQuestions: async () => ({ questions }) },
  });
  return { first, second, render };
}

it("shows a custom Approve option as the chosen answer under Earlier Answered", async () => {
  const { task, rpc, structured } = setup();
  await structured.handlers.createQuestion({ taskId: task.id, kind: "check", mode: "single", options: ["Approve", "Maybe", "Reject"], prompt: "Check the layout", askedByThread: null });
  const question = structured.listQuestions(task.id)[0]!;
  const answeredQuestion = { ...question, selectedOptionIds: [question.options[0]!.id], answeredBy: "Owner", revision: 2, updatedAt: "2026-01-02T12:00:00Z" };
  const slot = renderSlot(app.navPanels[0]!, { subPath: `task/${task.key}` }, { rpc: { ...rpc, listQuestions: async () => ({ questions: [answeredQuestion] }) } });
  const earlier = (await slot.findByText("Earlier (1)")).closest("details")!;
  expect(earlier.textContent).toContain("Check 1 · Answered");
  expect(within(earlier).getByText("Approve")).toBeTruthy();
});

it.each([
  ["single", 1, null, "Confirmed"],
  ["single", 0, "Looks good", "Looks good"],
  ["multiple", 2, "Looks good", "Confirmed; Reviewed; Looks good"],
] as const)("shows the %s predecessor answer (%i selections) before the open prompt", async (mode, count, answerText, expected) => {
  const { first, second, render } = await exampleChain();
  const original = { ...first, mode, selectedOptionIds: first.options.slice(0, count).map(option => option.id),
    answerText, answeredBy: "Reviewer", updatedAt: "2026-01-02T12:00:00Z" };
  const slot = render({ ...original, answeredBy: "Attachment author", updatedAt: "2026-01-03T12:00:00Z",
    revision: 4, history: [{ ...original, revision: 1, answeredBy: "Earlier reviewer" }, { ...first, revision: 2 }, { ...original, revision: 3 }] }, second);
  const link = await slot.findByRole("link", { name: "Replaces an earlier check" });
  expect(link.parentElement!.textContent).toBe("Replaces an earlier check");
  const line = link.parentElement!.nextElementSibling!;
  expect(line.textContent).toMatch(/^Answer · Reviewer · /);
  expect(line.textContent).toMatch(new RegExp(`: ${expected}$`));
  expect(line.querySelector("time")?.dateTime).toBe(original.updatedAt);
  const group = slot.getByRole("group", { name: second.prompt });
  expect(link.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // The earlier answer sits inside the new question's card, not in a box of its own above it.
  expect(group.parentElement!.contains(link)).toBe(true);
  expect(slot.getByText("Superseded checks · 1").closest("details")!.open).toBe(false);
  expect(slot.queryByText(/Changed from the replaced check/)).toBeNull();
});

it("follows each direct predecessor from Earlier through a chain with identical prompts", async () => {
  const { first, second, render } = await exampleChain();
  const third = { ...second, id: "example-003", supersedes: second.id };
  const slot = render(first, { ...second, supersededBy: third.id }, third);
  await slot.findByRole("group", { name: third.prompt });
  const link = slot.getAllByRole("link", { name: "Replaces an earlier check" }).find((candidate) => !candidate.closest("details[open] [tabindex]") && !candidate.closest("[tabindex='-1']"))!;
  const group = slot.getByRole("group", { name: third.prompt });
  expect(link.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const disclosure = slot.getByText("Superseded checks · 2").closest("details")!;
  expect(disclosure.open).toBe(false);
  fireEvent.click(link);
  expect(disclosure.open).toBe(true);
  // Identical prompts: the rows are told apart by their place in the chain (the direct predecessor first).
  const [middle, firstRow] = [...disclosure.querySelectorAll<HTMLElement>("[tabindex='-1']")];
  expect(link.getAttribute("href")).toBe(`#${middle!.id}`);
  expect(document.activeElement).toBe(middle);
  expect(within(middle!).getByText(/Replaced by a later check:/)).toBeTruthy();
  const older = within(middle!).getByRole("link", { name: "Replaces an earlier check" });
  expect(older.getAttribute("href")).toBe(`#${firstRow!.id}`);
  fireEvent.click(older);
  expect(document.activeElement).toBe(firstRow);
  expect(within(firstRow!).getByText(/Replaced by a later check:/)).toBeTruthy();
});

it.each([
  ["Old prompt", "New prompt", ["Open"], ["Inspect"], ["the prompt", "− Open", "+ Inspect"]],
  ["Visit https://example.org/old.", "Visit https://example.org/new.", ["Open"], ["Open"], ["a link in the prompt"]],
  ["Check `https://example.org/old`", "Check `https://example.org/new`", ["Open"], ["Open"], ["the prompt"]],
  ["Check", "Check", ["Open", "See https://example.org/a"], ["Open", "See https://example.org/b"], ["a link in step 2"]],
  ["Check", "Check", ["Open", "Inspect"], ["Inspect", "Open"], ["− Open", "+ Open"]],
  ["Check", "Check", [], ["a", "b", "c", "d", "e", "f", "g"], ["+ a", "+ b", "+ c", "+ d", "+ e", "and 2 more"]],
] as [string, string, string[], string[], string[]][])("compares the displayed revision of %s with its predecessor (%j, %j)", async (before, after, oldSteps, steps, expected) => {
  const { task, rpc, structured } = setup();
  const check = { taskId: task.id, kind: "check", mode: "single", askedByThread: null } as const;
  const { createQuestion, updateQuestion } = structured.handlers;
  const { question: first } = await createQuestion({ ...check, options: [], prompt: before, steps: oldSteps });
  const { question: second } = await createQuestion({ ...check, options: [], prompt: after, steps: oldSteps,
    supersedes: { questionId: first.id, revision: first.revision } });
  await updateQuestion({ questionId: second.id, revision: second.revision, prompt: after, steps,
    mode: second.mode, options: second.options, authorName: "Reviewer" });
  const slot = renderSlot(app.navPanels[0]!, { subPath: `task/${task.key}` }, { rpc });
  const line = await slot.findByText("Changed from the replaced check:");
  expect([...line.querySelectorAll("span")].map(span => span.textContent)).toEqual(expected);
});

it("offers a copy button for inline code in steps, but not in a successor preview", async () => {
  const { task, rpc, structured } = setup();
  const check = { taskId: task.id, kind: "check", mode: "single", askedByThread: null } as const;
  const { question: first } = await structured.handlers.createQuestion({ ...check, options: [], prompt: "Does it save?", steps: ["Set `^/a$`"] });
  await structured.handlers.createQuestion({ ...check, options: [], prompt: "Does `^/b$` save?", steps: ["Set `^/b$`"],
    supersedes: { questionId: first.id, revision: first.revision } });
  const slot = renderSlot(app.navPanels[0]!, { subPath: `task/${task.key}` }, { rpc });
  const current = await slot.findByRole("group", { name: "Does `^/b$` save?" });
  expect(within(current).getAllByRole("button", { name: "Copy code" })).toHaveLength(2);
  const superseded = slot.getByLabelText("Superseded check: Does it save?");
  expect(within(superseded).getByText(/Replaced by a later check/).querySelector("code")?.textContent).toBe("^/b$");
  expect(within(superseded).queryByRole("button", { name: "Copy code" })).toBeNull();
});

it("shows a long code value in a step as a block and a short one inline, also in history", async () => {
  const { task, rpc, structured } = setup();
  const long = `^/(?:${"[0-9a-f]".repeat(8)})/_frame$`;
  const { question } = await structured.handlers.createQuestion({ kind: "check", askedByThread: null, taskId: task.id, prompt: "Does `example.com` save?", mode: "single", options: [], steps: [`Set \`${long}\``] });
  await structured.handlers.updateQuestion({ questionId: question.id, revision: question.revision, prompt: "Does `example.com` still save?", steps: [`Set \`${long}\` again`], mode: "single", options: question.options, authorName: "Agent" });
  const slot = renderSlot(app.navPanels[0]!, { subPath: `task/${task.key}` }, { rpc });
  const current = await slot.findByRole("group", { name: "Does `example.com` still save?" });
  const blocks = (root: Element) => [...root.querySelectorAll("[data-code-block] code")].map(code => code.textContent);
  expect(blocks(within(current).getByRole("list", { name: "How to check" }))).toEqual([long]);
  expect(current.querySelector("legend [data-code-block]")).toBeNull();
  expect(current.querySelector("legend code")?.textContent).toBe("example.com");
  expect(blocks(within(current).getByText("History · 1").closest("details")!)).toEqual([long]);
});

it("collects readiness for a check on add, edit and reopen", async () => {
  const { store, project, task, structured, rpc } = setup();
  store.tasks.updateProject(project.id, { checkReadiness: "on" });
  const slot = renderSlot(app.navPanels[0]!, { subPath: `task/${task.key}` }, { rpc });
  fireEvent.click(within(await slot.findByRole("complementary")).getByRole("button", { name: "Add question" }));
  expect(slot.queryByLabelText("Smoke test")).toBeNull();
  const fill = (label: string, value: string) => fireEvent.change(slot.getByLabelText(label), { target: { value } });
  fill("Question type", "check");
  fill("Question", "Does Save work?");
  const submit = async (button: string, line: string) => {
    fill("Smoke test", "Opened the form and saved a draft.");
    fill("Beyond the design", line);
    fireEvent.click(slot.getByRole("button", { name: button }));
    await waitFor(() => expect(structured.listQuestions(task.id)[0]?.beyondDesign).toBe(line));
    expect(await slot.findByText(`Beyond the design: ${line}`)).toBeTruthy();
  };
  await submit("Create question", "none");
  fireEvent.click(slot.getByRole("button", { name: "Edit question" }));
  // Only the design line changes in this revision.
  await submit("Save question", "Extra label");
  expect(slot.getByText("History · 1")).toBeTruthy();
  // A prompt edit needs a fresh smoke note, recorded with the new revision.
  fireEvent.click(slot.getByRole("button", { name: "Edit question" }));
  fill("Question", "Does Save work twice?");
  fill("Smoke test", "Saved the same draft twice in a row.");
  fill("Beyond the design", "Extra label");
  fireEvent.click(slot.getByRole("button", { name: "Save question" }));
  await waitFor(() => expect(structured.listQuestions(task.id)[0]?.revision).toBe(3));
  expect(store.tasks.listComments(task.id).map(comment => comment.body).join("\n"))
    .toMatch(/Smoke test for check \S+ rev 3 .*Saved the same draft twice in a row\./);
  const group = slot.getByRole("group", { name: /Does Save work/ });
  fireEvent.click(within(group).getByLabelText("Approve"));
  fireEvent.click(within(group).getByRole("button", { name: "Save answer" }));
  await waitFor(() => expect(structured.listQuestions(task.id)[0]?.answeredBy).toBe("You"));
  await changeAnswer(slot);
  fireEvent.click(await slot.findByRole("button", { name: "Edit question" }));
  fireEvent.click(slot.getByLabelText("Clear the saved answer and request a new decision"));
  await submit("Save question", "Extra label revised");
  expect(structured.listQuestions(task.id)[0]?.answeredBy).toBeNull();
});

it("shows a steps-only history revision and omits readiness inputs in an ungated check form", async () => {
  const { task, rpc, structured } = setup();
  const { question } = await structured.handlers.createQuestion({ taskId: task.id, kind: "check", askedByThread: null,
    prompt: "Does Save work?", steps: ["Open the form"], options: [], mode: "single" });
  await structured.handlers.updateQuestion({ questionId: question.id, revision: 1, prompt: question.prompt, steps: ["Press Save"],
    options: question.options, mode: question.mode, authorName: "You" });
  const slot = renderSlot(app.navPanels[0]!, { subPath: `task/${task.key}` }, { rpc });
  expect(await slot.findByText("History · 1")).toBeTruthy();
  expect(slot.getByText("Open the form")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Edit question" }));
  expect(slot.queryByLabelText("Smoke test")).toBeNull();
  expect(slot.queryByLabelText("Beyond the design")).toBeNull();
});

async function threeChecks() {
  const host = setup();
  const { task, structured, bb } = host;
  const db = bb.storage.database();
  const ask = async (prompt: string, second: number, supersedes?: { questionId: string; revision: number }) => {
    const { question } = await structured.handlers.createQuestion({ kind: "check", askedByThread: null, taskId: task.id, prompt, mode: "single", options: [], ...(supersedes ? { supersedes } : {}) });
    db.prepare("UPDATE task_questions SET payload=json_set(payload, '$.createdAt', ?) WHERE id=?").run(new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString(), question.id);
    refreshCheckFlow(db, task.id);
    return question;
  };
  return { ...host, ask, checks: [await ask("Check one?", 1), await ask("Check two?", 2), await ask("Check three?", 3)] };
}

const liveOrder = (slot: ReturnType<typeof renderSlot>) => [...slot.container.querySelectorAll("section[aria-label='Questions'] fieldset")]
  .filter((group) => !group.closest("details")).map((group) => group.getAttribute("aria-label"));
const liveNumbers = (slot: ReturnType<typeof renderSlot>) => [...slot.container.querySelectorAll("section[aria-label='Questions'] p.text-xs span.font-semibold")].map((node) => node.textContent);
const answerCheck = (structured: ReturnType<typeof setup>["structured"], taskId: string, id: string, selected: string[], text: string | null = null) => {
  const current = structured.listQuestions(taskId).find((question) => question.id === id)!;
  return structured.handlers.answerQuestion({ questionId: id, revision: current.revision, selectedOptionIds: selected, answerText: text, authorName: "You" });
};
const refresh = (slot: ReturnType<typeof renderSlot>, task: { id: string; projectId: string }) => slot.behavior.emitRealtime("tasks:changed", { taskId: task.id, projectId: task.projectId });

it("moves a confirmed check to Earlier, shows a failed one as a compact card and puts the replacement in its place", async () => {
  const { task, rpc, structured, ask, checks } = await threeChecks();
  const slot = renderSlot(app.navPanels[0]!, { subPath: `task/${task.key}` }, { rpc });
  const first = await slot.findByRole("group", { name: "Check one?" });
  expect(within(first).getByLabelText("Approve")).toBeTruthy();
  expect(within(first).getByLabelText("Reject")).toBeTruthy();
  fireEvent.click(within(first).getByLabelText("Approve"));
  fireEvent.change(within(first).getByRole("textbox", { name: "Comment (optional)" }), { target: { value: "Looks right" } });
  fireEvent.click(within(first).getByRole("button", { name: "Save answer" }));
  await waitFor(() => expect(slot.getByText("Earlier (1)")).toBeTruthy());
  // The live list starts at check 2: numbers never move.
  expect(liveOrder(slot)).toEqual(["Check two?", "Check three?"]);
  expect(liveNumbers(slot)).toEqual(["2.", "3."]);
  const earlier = slot.getByText("Earlier (1)").closest("details")!;
  expect(earlier.textContent).toContain("Check 1 · Approved");
  expect(earlier.textContent).toContain("Looks right");
  expect(within(earlier).queryByRole("group")).toBeNull();

  // Text alone on check 2: a compact card without a form, and check 3 is held.
  await answerCheck(structured, task.id, checks[1]!.id, [], "The button is cut off");
  await refresh(slot, task);
  await slot.findByText("2. Rejected — waiting for the fix");
  // No form for check 2, and check 3's form is behind "Answer anyway".
  expect(liveOrder(slot)).toEqual([]);
  expect(slot.getByText("The button is cut off")).toBeTruthy();
  expect(slot.getAllByText("On hold until check 2 is fixed")).toHaveLength(1);
  // One link on the compact card, one on check 1 in Earlier.
  expect(slot.getAllByRole("button", { name: "Change answer" })).toHaveLength(2);

  // Replacing check 2 puts an open check 2 in its place, check 3 is open again, and the failed one is in its history.
  const current = structured.listQuestions(task.id).find((question) => question.id === checks[1]!.id)!;
  await ask("Check two again?", 4, { questionId: current.id, revision: current.revision });
  await refresh(slot, task);
  await waitFor(() => expect(slot.queryByText(/On hold until/)).toBeNull());
  expect(liveOrder(slot)).toEqual(["Check two again?", "Check three?"]);
  expect(liveNumbers(slot)).toEqual(["2.", "3."]);
  expect(slot.queryByText(/waiting for the fix/)).toBeNull();
  expect(slot.getByText("Superseded checks · 1")).toBeTruthy();
});

it("changes an answer from the compact failed card back to Approve, which moves it to Earlier and releases the held checks", async () => {
  const { task, rpc, structured, checks } = await threeChecks();
  await answerCheck(structured, task.id, checks[0]!.id, [], "Broken");
  const slot = renderSlot(app.navPanels[0]!, { subPath: `task/${task.key}` }, { rpc });
  await slot.findByText("1. Rejected — waiting for the fix");
  expect(slot.getAllByText("On hold until check 1 is fixed")).toHaveLength(2);
  fireEvent.click(slot.getByRole("button", { name: "Change answer" }));
  const group = await slot.findByRole("group", { name: "Check one?" });
  fireEvent.click(within(group).getByLabelText("Approve"));
  fireEvent.click(within(group).getByRole("button", { name: "Save answer" }));
  await waitFor(() => expect(slot.getByText("Earlier (1)")).toBeTruthy());
  expect(slot.queryByText(/On hold until/)).toBeNull();
  expect(slot.queryByText(/waiting for the fix/)).toBeNull();
  expect(liveOrder(slot)).toEqual(["Check two?", "Check three?"]);
});

it("changes an answer from Earlier to Reject: the check returns as a compact card and holds the later open checks", async () => {
  const { task, rpc, structured, checks } = await threeChecks();
  await answerCheck(structured, task.id, checks[0]!.id, [checks[0]!.options[0]!.id]);
  const slot = renderSlot(app.navPanels[0]!, { subPath: `task/${task.key}` }, { rpc });
  await changeAnswer(slot);
  const group = await slot.findByRole("group", { name: "Check one?" });
  fireEvent.click(within(group).getByLabelText("Reject"));
  fireEvent.click(within(group).getByRole("button", { name: "Save answer" }));
  await slot.findByText("1. Rejected — waiting for the fix");
  expect(slot.queryByText(/^Earlier/)).toBeNull();
  expect(slot.getAllByText("On hold until check 1 is fixed")).toHaveLength(2);
});

it("shows a withdrawn check in Earlier with its number and reason, keeps the later numbers and gives it no answer controls", async () => {
  const { task, rpc, structured, checks } = await threeChecks();
  await structured.handlers.withdrawQuestion({ taskId: task.id, questionId: checks[1]!.id, revision: 1, reason: "Not needed", authorName: "Agent" });
  const slot = renderSlot(app.navPanels[0]!, { subPath: `task/${task.key}` }, { rpc });
  await slot.findByRole("group", { name: "Check one?" });
  expect(liveOrder(slot)).toEqual(["Check one?", "Check three?"]);
  expect(liveNumbers(slot)).toEqual(["1.", "3."]);
  const earlier = slot.getByText("Earlier (1)").closest("details")!;
  expect(earlier.textContent).toContain("Check 2 · Withdrawn");
  expect(earlier.textContent).toContain("Not needed");
  expect(within(earlier).queryByRole("button", { name: "Change answer" })).toBeNull();
  expect(within(earlier).queryByRole("group")).toBeNull();
});

it("keeps a verdict and its comment together while typing and choosing", async () => {
  const { task, rpc, structured, checks } = await threeChecks();
  const slot = renderSlot(app.navPanels[0]!, { subPath: `task/${task.key}` }, { rpc });
  const group = await slot.findByRole("group", { name: "Check one?" });
  const comment = within(group).getByRole("textbox", { name: "Comment (optional)" });
  fireEvent.click(within(group).getByLabelText("Reject"));
  fireEvent.change(comment, { target: { value: "Looks off" } });
  expect((within(group).getByLabelText("Reject") as HTMLInputElement).checked).toBe(true);
  fireEvent.click(within(group).getByLabelText("Approve"));
  expect(comment).toHaveProperty("value", "Looks off");
  fireEvent.click(within(group).getByRole("button", { name: "Save answer" }));
  await waitFor(() => expect(structured.listQuestions(task.id).find((question) => question.id === checks[0]!.id)).toMatchObject({
    selectedOptionIds: [checks[0]!.options[0]!.id], answerText: "Looks off",
  }));
  await waitFor(() => expect(slot.getByText("Earlier (1)").closest("details")!.textContent).toContain("Check 1 · Approved"));
  expect(slot.getByText("Earlier (1)").closest("details")!.textContent).toContain("Looks off");
  expect(slot.queryByText(/On hold until/)).toBeNull();
});

it("keeps only finished rounds, withdrawn checks and answered decisions under Earlier", async () => {
  const { task, rpc, structured, ask, bb, checks } = await threeChecks();
  const confirm = (question: { id: string; options: { id: string }[] }) => structured.handlers.answerQuestion({ questionId: question.id, revision: 1, selectedOptionIds: [question.options[0]!.id], authorName: "You" });
  // Round one is finished before round two is asked.
  for (const check of checks) await confirm(check);
  const laterAnswers = bb.storage.database();
  laterAnswers.prepare("UPDATE task_questions SET payload=json_set(payload, '$.updatedAt', ?) WHERE task_id=?").run("2026-01-01T00:00:10.000Z", task.id);
  laterAnswers.prepare("UPDATE task_questions SET payload=json_set(payload, '$.history[0].updatedAt', ?) WHERE task_id=?").run("2026-01-01T00:00:00.000Z", task.id);
  await ask("Round two check?", 20);
  const { question: decision } = await structured.handlers.createQuestion({ kind: "decision", askedByThread: null, taskId: task.id, prompt: "Which one?", mode: "single", options: ["A"] });
  await structured.handlers.answerQuestion({ questionId: decision.id, revision: 1, selectedOptionIds: [decision.options[0]!.id], authorName: "You" });
  const withdrawn = await ask("Not needed?", 21);
  await structured.handlers.withdrawQuestion({ taskId: task.id, questionId: withdrawn.id, revision: 1, reason: "Obsolete", authorName: "Agent" });
  const slot = renderSlot(app.navPanels[0]!, { subPath: `task/${task.key}` }, { rpc });
  await slot.findByRole("group", { name: "Round two check?" });
  const earlier = slot.getByText(/^Earlier \(/).closest("details")!;
  expect(slot.getByText(/^Earlier \(/).textContent).toBe("Earlier (5)");
  for (const prompt of ["Check one?", "Check two?", "Check three?", "Which one?", "Not needed?"]) expect(earlier.textContent).toContain(prompt);
  expect(earlier.textContent).not.toContain("Round two check?");
  // Earlier names the round once the card has more than one; the live list shows round two alone, with no round heading.
  for (const label of ["Round 1 · Check 1 · Approved", "Round 1 · Check 3 · Approved", "Round 2 · Check 2 · Withdrawn"]) expect(earlier.textContent).toContain(label);
  expect(slot.queryByRole("heading", { name: /^Round \d/ })).toBeNull();
});
