import { registerAttachments } from "../attachments";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeQueueEntry,
  makeThreadResponse,
  type FakePluginHarness,
} from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from "../api";
import { registerTasksCli } from "../cli";
import {
  tasksRpcContract,
  evidenceSchema,
  questionSchema,
  type Evidence,
  type Comment,
} from "../shared/contract";
import { createStructuredStore } from "./store";
import { assertStepsSingleAction, isQuestionOpen } from "../shared/questions";
import { evidenceFlags, evidenceIndex } from "./evidence";
import { createPlanStore } from "../plans/store";

const harnesses: FakePluginHarness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
});
function setup() {
  const { bb, harness } = createFakePluginHost({
    pluginId: "work-board",
    sdk: {
      files: {
        read: async ({ path }) => ({
          path,
          content: "**Goal:** template body",
          contentEncoding: "utf8",
          sizeBytes: 23,
        }),
      },
    },
  });
  harnesses.push(harness);
  const store = createStore(bb);
  registerAttachments(bb, store.tasks);
  registerTasksApi(bb, store);
  registerTasksCli(bb, store, { name: "Work Board", version: "test" });
  const project = store.tasks.createProject({
    name: "Structured work",
    prefix: "STR",
    color: "purple",
  });
  const task = store.tasks.createTask({
    projectId: project.id,
    title: "Decisions",
  });
  const structured = createStructuredStore(bb, store);
  const cli = async (...args: string[]) => {
    const result = await harness.runCli(args);
    expect(result, result.stderr).toMatchObject({ exitCode: 0, stderr: "" });
    return JSON.parse(result.stdout);
  };
  return { bb, harness, store, project, task, structured, cli };
}

describe("task questions", () => {
  it("moves answer attachments atomically, returns their IDs and includes retrieval commands in the notification", async () => {
    const { harness, store, task, structured, cli } = setup();
    harness.sdk.stub("threads.get", async ({ threadId }) => makeThreadResponse({ id: threadId, status: "idle" }));
    harness.sdk.stub("threads.send", async () => {});
    const { question } = await structured.handlers.createQuestion({ taskId: task.id, kind: "decision", askedByThread: "thr_asker", prompt: "Proceed?", mode: "single", options: ["Yes"] });
    const attachment = store.tasks.createAttachment({ taskId: task.id, fileName: "log.txt", mime: "text/plain", sizeBytes: 12, blobPath: "blobs/log.txt", isImage: false });
    const result = await structured.handlers.answerQuestion({ questionId: question.id, revision: 1, selectedOptionIds: [question.options[0]!.id], authorName: "Owner", attachmentIds: [attachment.id] });
    expect(result.attachmentIds).toEqual([attachment.id]);
    expect(store.tasks.getAttachment(attachment.id)).toMatchObject({ taskId: null, commentId: result.commentId });
    expect(store.tasks.listAttachmentsForTask(task.id)).toEqual([]);
    expect(JSON.stringify(harness.sdk.callsTo("threads.send"))).toContain(`Attachment: log.txt (12 bytes) — \`bb work-board attachment get ${attachment.id} --out <path>\``);
    const listed = await cli("question", "list", task.key, "--json");
    expect(listed.questions[0].answerAttachments).toEqual([{ id: attachment.id, fileName: "log.txt", mime: "text/plain", sizeBytes: 12 }]);
    const payload = structured.listQuestions(task.id)[0]!;
    expect(payload).not.toHaveProperty("answerAttachments");
    expect(payload).not.toHaveProperty("answerCommentId");
  });

  it("rejects foreign, comment-owned and attachment-only answers without changing the decision", async () => {
    const { store, task, project, structured } = setup();
    const foreign = store.tasks.createTask({ projectId: project.id, title: "Other" });
    const comment = store.tasks.createComment({ taskId: task.id, kind: "user", authorName: "Owner", body: "Other comment" });
    const create = (owner: { taskId: string } | { commentId: string }) => store.tasks.createAttachment({ ...owner, fileName: "log.txt", mime: "text/plain", sizeBytes: 1, blobPath: "blobs/log.txt", isImage: false });
    const own = create({ taskId: task.id });
    const { question } = await structured.handlers.createQuestion({ taskId: task.id, kind: "decision", askedByThread: null, prompt: "Proceed?", mode: "single", options: ["Yes"] });
    for (const attachment of [create({ taskId: foreign.id }), create({ commentId: comment.id })]) {
      await expect(structured.handlers.answerQuestion({ questionId: question.id, revision: 1, selectedOptionIds: [question.options[0]!.id], authorName: "Owner", attachmentIds: [own.id, attachment.id] })).rejects.toThrow("Attachment must belong");
      expect(store.tasks.getAttachment(own.id)?.taskId).toBe(task.id);
      expect(structured.listQuestions(task.id)[0]?.revision).toBe(1);
    }
    await expect(structured.handlers.answerQuestion({ questionId: question.id, revision: 1, selectedOptionIds: [], authorName: "Owner", attachmentIds: [own.id] })).rejects.toThrow("Attachments require an answer");
  });

  it("uploads repeatable CLI answer files on the selected machine and cleans up after a stale answer", async () => {
    const { harness, store, task, structured, cli } = setup();
    const { question } = await structured.handlers.createQuestion({ taskId: task.id, kind: "decision", askedByThread: null, prompt: "Proceed?", mode: "single", options: ["Yes"] });
    const args = ["question", "answer", task.key, "--question", question.id, "--text", "Confirmed", "--revision", "1", "--file", "one.txt", "--file", "two.txt", "--json"];
    const result = await cli(...args);
    expect(result.attachmentIds).toHaveLength(2);
    expect(store.tasks.listAttachmentsForComment(result.commentId).map(a => a.fileName)).toEqual(["one.txt", "two.txt"]);
    expect(harness.sdk.callsTo("files.read")).toHaveLength(2);
    const failed = await harness.runCli(args);
    expect(failed.exitCode).not.toBe(0);
    expect(store.tasks.listAttachmentsForTask(task.id)).toEqual([]);
    expect(store.tasks.listAttachmentsForComment(result.commentId)).toHaveLength(2);
  });

  it("allows one link across prompt and steps, keeps a reopen to the same scope and hands the reopened question to the reopener", async () => {
    const { structured, task } = setup();
    const ask = (prompt: string, steps: string[]) => structured.handlers.createQuestion({ kind: "check", askedByThread: "thr_example", taskId: task.id, prompt, steps, mode: "single", options: [] });
    await expect(ask("Does [the page](https://example.com/a) look right?", ["Open [state B](https://example.com/b)"])).rejects.toThrow(/at most one link.*has 2.*several --kind check questions/);
    await expect(ask("See https://example.com/a and https://example.com/b", [])).rejects.toThrow(/has 2/);
    await expect(ask("Open [one](/docs/a(b)/one)", ["Then [two](/docs/a(b)/two)"])).rejects.toThrow(/has 2/);
    await expect(ask("Open [the board](/plugins/work-board/work-board/task/EXA-1)", ["Then [the plan](/plugins/work-board/work-board/task/EXA-1/plan)"])).rejects.toThrow(/has 2/);
    // The same link twice is one link.
    const { question } = await ask("Does [the page](https://example.com/a) look right?", ["Open https://example.com/a", "Press Save"]);
    const answered = (await structured.handlers.answerQuestion({ questionId: question.id, revision: question.revision, selectedOptionIds: [question.options[0]!.id], authorName: "Owner" })).question;
    const reopen = (steps: string[], askedByThread?: string) => structured.handlers.updateQuestion({ questionId: question.id, revision: answered.revision, prompt: answered.prompt, steps, mode: answered.mode, options: answered.options, reopen: true, authorName: "Agent", ...(askedByThread ? { askedByThread } : {}) });
    // Any change to an answered check's ordered steps is a new state: added, changed or removed, it needs a successor.
    for (const steps of [[...(answered.steps ?? []), "Dismiss the notice"], ["Open https://example.com/a", "Press Save twice"], ["Open https://example.com/a"], ["Press Save", "Open https://example.com/a"]])
      await expect(reopen(steps)).rejects.toThrow(`its steps changed, so this is a new state. Replace it: \`bb work-board question add ${task.key} --kind check --supersedes ${question.id} --supersedes-revision ${answered.revision}`);
    await expect(reopen(["Open https://example.com/c", "Press Save"])).rejects.toThrow(/at most one link|steps changed/);
    const reopened = (await reopen(["Open https://example.com/a", "Press Save"], "thr_reopener")).question;
    expect(reopened.askedByThread).toBe("thr_reopener");
    expect(reopened.steps).toEqual(["Open https://example.com/a", "Press Save"]);
  });

  it("refuses plan-approval questions: any link to a task plan, and approval wording once the task has a plan, but only with planning on", async () => {
    const { bb, structured, task, store, project } = setup();
    const ask = (prompt: string, steps: string[] = []) => structured.handlers.createQuestion({ kind: "decision", askedByThread: null, taskId: task.id, prompt, steps, mode: "single", options: ["Yes", "No"] });
    const link = `Do you accept [the plan](/plugins/work-board/work-board/task/${task.key}/plan)?`;
    const now = new Date().toISOString();
    bb.storage.database().prepare("INSERT INTO task_plans (task_id, format, version, body, state, updated_at, author_kind, author_thread, author_name) VALUES (?, 'markdown', 1, '# Plan', 'in_review', ?, 'agent', NULL, 'agent')").run(task.id, now);
    // With planning off (the default) the plan has no review: the guard does not apply, plan links included.
    let current = (await ask(link)).question;
    await ask("Do you accept the plan so I can start?");
    const update = async (prompt: string) => {
      current = (await structured.handlers.updateQuestion({ questionId: current.id, revision: current.revision, prompt, mode: current.mode, options: current.options, authorName: "Owner" })).question;
    };
    await update("Do you approve the plan now?");
    store.tasks.updateProject(project.id, { planning: "optional" });
    await expect(ask(link)).rejects.toThrow(/plan submit.*--reviewer/);
    await expect(update("Do you accept the plan so we can go?")).rejects.toThrow(/Plan approval is not an owner question/);
    // Without a plan on the task, approval wording alone is an ordinary question (e.g. a plan of something else), but a plan link is not.
    bb.storage.database().prepare("DELETE FROM task_plans WHERE task_id = ?").run(task.id);
    await ask("Do you approve the pricing plan change?");
    await expect(ask(link)).rejects.toThrow(/plan submit/);
    bb.storage.database().prepare("INSERT INTO task_plans (task_id, format, version, body, state, updated_at, author_kind, author_thread, author_name) VALUES (?, 'markdown', 1, '# Plan', 'in_review', ?, 'agent', NULL, 'agent')").run(task.id, now);
    await expect(ask("Do you accept the plan so I can start?")).rejects.toThrow(/Plan approval is not an owner question/);
    await expect(ask("Принимаете план от 19.11?")).rejects.toThrow(/plan submit/);
    await expect(ask("Can I start step 1?", ["Approve the plan first"])).rejects.toThrow(/plan submit/);
    await ask("Which database should step 2 use?");
  });

  it("refuses owner checks and check reopens while the card has plan debt, and keeps decisions allowed", async () => {
    const { bb, store, project, structured } = setup();
    const plans = createPlanStore(bb.storage.database(), store.tasks);
    const author = { kind: "agent" as const, threadId: "thr_example", name: "agent" };
    store.tasks.updateProject(project.id, { planning: "optional" });
    const card = store.tasks.createTask({ projectId: project.id, title: "Rendered states", status: "in_progress" });
    const epic = store.tasks.createTask({ projectId: project.id, title: "Area", type: "epic", status: "in_progress" });
    const check = (taskId: string) => structured.handlers.createQuestion({ kind: "check", askedByThread: null, taskId, prompt: "Does the list render?", steps: [], mode: "single", options: [] });
    // Optional planning: no debt, so checks are asked as before.
    const early = (await check(card.id)).question;
    await structured.handlers.answerQuestion({ questionId: early.id, revision: early.revision, selectedOptionIds: [early.options[0]!.id], authorName: "Owner" });
    store.tasks.updateProject(project.id, { planning: "required" });
    const refusal = `Plan debt: ${card.key} is in work without an approved plan (no plan). Owner checks wait for an approved plan; write it (bb work-board plan set ${card.key} --file plan.md --base-version 0 --summary "Initial plan"), then submit it: bb work-board plan submit ${card.key} --reviewer …`;
    await expect(check(card.id)).rejects.toThrow(refusal);
    plans.save({ taskId: card.id, op: "replace", baseVersion: 0, body: "# Plan\n", summary: "Plan", author });
    await expect(check(card.id)).rejects.toThrow(`(plan v1 is draft). Owner checks wait for an approved plan; submit it for review: bb work-board plan submit ${card.key} --reviewer …`);
    plans.submit(card.id, author, null);
    await expect(check(card.id)).rejects.toThrow(`(plan v1 is in review). Owner checks wait for an approved plan; wait for the review to finish (bb work-board plan show ${card.key}); if it asks for changes, revise the plan and submit it again: bb work-board plan submit ${card.key} --reviewer …`);
    plans.setState(card.id, "changes_requested", { kind: "person", threadId: null, name: "Owner" });
    await expect(check(card.id)).rejects.toThrow(`(plan v1 is changes requested). Owner checks wait for an approved plan; revise it (bb work-board plan edit ${card.key} … --base-version 1), then submit it: bb work-board plan submit ${card.key} --reviewer …`);
    // A reopen asks the owner again, so it waits too; an epic never carries debt.
    const answered = structured.listQuestions(card.id)[0]!;
    await expect(structured.handlers.updateQuestion({ questionId: answered.id, revision: answered.revision, prompt: answered.prompt, mode: "single", options: answered.options, reopen: true, authorName: "agent" })).rejects.toThrow("Owner checks wait for an approved plan");
    expect((await check(epic.id)).question.kind).toBe("check");
    // Clearing an answer is not an ask: it stays open to every caller, so a withdrawn confirmation never sticks.
    const cleared = await structured.handlers.answerQuestion({ questionId: answered.id, revision: answered.revision, selectedOptionIds: [], authorName: "agent" });
    expect(cleared.question.answeredBy).toBeNull();
    expect(isQuestionOpen(cleared.question)).toBe(true);
    // The cleared check is open again, so an edit (not a reopen) stays allowed during the debt.
    const edited = await structured.handlers.updateQuestion({ questionId: answered.id, revision: cleared.question.revision, prompt: "Does the list render after reload?", mode: "single", options: cleared.question.options, authorName: "agent" });
    expect(edited.question.prompt).toBe("Does the list render after reload?");
    const again = await structured.handlers.answerQuestion({ questionId: answered.id, revision: edited.question.revision, selectedOptionIds: [answered.options[0]!.id], authorName: "Owner" });
    const reanswered = again.question;
    const decision = await structured.handlers.createQuestion({ kind: "decision", askedByThread: null, taskId: card.id, prompt: "Which layout?", mode: "single", options: ["A", "B"] });
    expect(decision.question.kind).toBe("decision");
    await structured.handlers.deleteQuestion({ questionId: decision.question.id, revision: decision.question.revision });
    plans.setState(card.id, "approved", { kind: "person", threadId: null, name: "Owner" });
    expect((await check(card.id)).question.kind).toBe("check");
    const reopened = await structured.handlers.updateQuestion({ questionId: reanswered.id, revision: reanswered.revision, prompt: answered.prompt, mode: "single", options: answered.options, reopen: true, authorName: "agent" });
    expect(reopened.question.answeredBy).toBeNull();
  });

  it("keeps each check step to one sentence and one action", async () => {
    const { structured, task } = setup();
    const ask = (steps: string[]) => structured.handlers.createQuestion({ kind: "check", askedByThread: null, taskId: task.id, prompt: "Does Retry recover the list?", steps, mode: "single", options: [] });
    await expect(ask(["Press Retry, close the message and press Reload. Check that the list appears."])).rejects.toThrow(/Step 1 has 2 sentences.*separate --step values, in order/);
    await expect(ask(["Press Retry", "Нажмите Retry. Проверьте список."])).rejects.toThrow(/Step 2 has 2 sentences/);
    await ask(["Open settings, e.g. the Storage page", "Check that the list appears."]);
    const joined = ["Press Retry, close the message and press Reload", "Check that the list appears", "Нажмите Retry, затем закройте окно"];
    expect(() => assertStepsSingleAction(joined)).toThrow(/^Steps 1, 3 may join several actions.*Nothing was saved\..*separate --step values, in order/);
    expect(() => assertStepsSingleAction(["Open Settings and Storage", "Check the list"])).not.toThrow();
    expect(() => assertStepsSingleAction(joined, [joined[0]!, joined[2]!])).not.toThrow();
    // Each kept entry covers one occurrence: a second copy of a legacy step is new.
    expect(() => assertStepsSingleAction([joined[0]!, joined[0]!], [joined[0]!])).toThrow(/^Step 2 may join/);
  });

  it("refuses joined steps through the registered RPCs and the CLI without saving anything", async () => {
    const { harness, task, structured, bb } = setup();
    const joined = "Press Retry and press Reload";
    const base = { taskId: task.id, kind: "check", prompt: "Does it reload?", options: [] };
    await expect(harness.callRpc("createQuestion", { ...base, steps: [joined] })).rejects.toThrow(/Step 1 may join several actions.*Nothing was saved/);
    expect(structured.listQuestions(task.id)).toEqual([]);
    const { question } = (await harness.callRpc("createQuestion", { ...base, steps: ["Press Retry"] })) as { question: { id: string; revision: number; options: unknown[] } };
    const update = (steps: string[], prompt = "Does it reload?") =>
      harness.callRpc("updateQuestion", { questionId: question.id, revision: question.revision, prompt, steps, mode: "single", options: [{ label: "Yes" }] });
    await expect(update(["Press Retry", joined])).rejects.toThrow(/Step 2 may join several actions/);
    expect(structured.listQuestions(task.id)[0]?.revision).toBe(question.revision);
    // A legacy joined step that is kept does not block an edit of the prompt.
    bb.storage.database().prepare("UPDATE task_questions SET payload = json_set(payload, '$.steps', json_array(?)) WHERE id = ?").run(joined, question.id);
    await update([joined], "Does Retry reload the list?");
    const kept = structured.listQuestions(task.id)[0]!;
    expect(kept).toMatchObject({ prompt: "Does Retry reload the list?", steps: [joined] });
    // A second copy of the legacy step is a new step and is refused.
    await expect(harness.callRpc("updateQuestion", { questionId: question.id, revision: kept.revision, prompt: kept.prompt, steps: [joined, joined], mode: "single", options: [{ label: "Yes" }] })).rejects.toThrow(/Step 2 may join several actions/);
    expect(structured.listQuestions(task.id)[0]?.revision).toBe(kept.revision);
  });

  it("refuses joined steps in question add and question update with a non-zero exit", async () => {
    const { harness, task, structured } = setup();
    const add = await harness.runCli(["question", "add", task.key, "--kind", "check", "--prompt", "Does it reload?", "--step", "Press Retry and press Reload"]);
    expect(add.exitCode).not.toBe(0);
    expect(add.stderr).toMatch(/Nothing was saved/);
    expect(JSON.parse((await harness.runCli(["question", "list", task.key, "--json"])).stdout).questions).toEqual([]);
    const created = await harness.runCli(["question", "add", task.key, "--kind", "check", "--prompt", "Does it reload?", "--step", "Press Retry", "--json"]);
    expect(created.exitCode).toBe(0);
    const { id, revision } = structured.listQuestions(task.id)[0]!;
    const update = await harness.runCli(["question", "update", task.key, "--question", id, "--revision", String(revision), "--step", "Press Retry, then press Reload"]);
    expect(update.exitCode).not.toBe(0);
    expect(update.stderr + update.stdout).toMatch(/may join several actions/);
    expect(structured.listQuestions(task.id)[0]?.revision).toBe(revision);
  });

  it("keeps the decision label until the last open question is answered or deleted", async () => {
    const { structured, store, project, task } = setup();
    const keep = store.tasks.createLabel({ projectId: project.id, name: "Keep", color: "blue" });
    store.tasks.addTaskLabel(task.id, keep.id);
    const create = async () => (await structured.handlers.createQuestion({ kind: "decision", askedByThread: null, taskId: task.id, prompt: "Choose?", mode: "single", options: ["A", "B"] })).question;
    const first = await create();
    const second = await create();
    const names = () => store.tasks.listLabelsForTask(task.id).map((label) => label.name).sort();
    expect(names()).toEqual(["Keep", "owner decision"]);
    const answered = (await structured.handlers.answerQuestion({ questionId: first.id, revision: first.revision, selectedOptionIds: [first.options[0]!.id], authorName: "Owner" })).question;
    expect(names()).toContain("owner decision");
    await structured.handlers.deleteQuestion({ questionId: second.id, revision: second.revision });
    expect(names()).toEqual(["Keep"]);
    const reopened = (await structured.handlers.updateQuestion({ questionId: first.id, revision: answered.revision, prompt: answered.prompt, mode: answered.mode, options: answered.options, reopen: true, authorName: "Owner" })).question;
    expect(names()).toContain("owner decision");
    await structured.handlers.answerQuestion({ questionId: first.id, revision: reopened.revision, selectedOptionIds: [], answerText: null, authorName: "Owner" });
    expect(names()).toContain("owner decision");
    await structured.handlers.deleteQuestion({ questionId: first.id, revision: reopened.revision });
    expect(names()).toEqual(["Keep"]);
  });

  it("marks a legacy no-free-text question as allowing free text when answered with text", async () => {
    const { bb, structured, task } = setup();
    const { question } = await structured.handlers.createQuestion({ kind: "check", askedByThread: null, taskId: task.id, prompt: "Verify?", mode: "single", options: [] });
    bb.storage.database().prepare("UPDATE task_questions SET payload=json_set(payload, '$.allowOther', json('false')) WHERE id=?").run(question.id);
    const { question: answered } = await structured.handlers.answerQuestion({ questionId: question.id, revision: question.revision, selectedOptionIds: [], answerText: "Broken on dev", authorName: "Owner" });
    expect(answered).toMatchObject({ allowOther: true, answerText: "Broken on dev", selectedOptionIds: [] });
    expect(answered.history?.at(-1)).toMatchObject({ allowOther: false, answerText: null });
  });

  it("sets and clears recommendations through stable IDs without selecting an answer", async () => {
    const { cli, task, structured, harness } = setup();
    const { question } = await cli(
      "question",
      "add",
      task.key,
      "--prompt",
      "Choose?",
      "--option",
      "A",
      "--option",
      "B",
      "--recommend",
      "2",
      "--recommendation-reason",
      "Less work",
      "--json",
    );
    expect(question.options[1]).toMatchObject({
      recommended: true,
      recommendationReason: "Less work",
    });
    expect(question.selectedOptionIds).toEqual([]);
    expect(question.answeredBy).toBeNull();
    const { question: edited } = await cli(
      "question",
      "update",
      task.key,
      "--question",
      question.id,
      "--revision",
      "1",
      "--recommend",
      question.options[0].id,
      "--recommendation-reason",
      "Safer",
      "--json",
    );
    expect(edited.options[0]).toMatchObject({
      id: question.options[0].id,
      recommended: true,
      recommendationReason: "Safer",
    });
    expect(edited.options[1].recommended).toBeUndefined();
    expect(edited.options[1].recommendationReason).toBeUndefined();
    expect(edited.history[0].options[1]).toMatchObject({
      recommended: true,
      recommendationReason: "Less work",
    });
    const { question: cleared } = await cli(
      "question",
      "update",
      task.key,
      "--question",
      question.id,
      "--revision",
      "2",
      "--no-recommendation",
      "--json",
    );
    expect(
      cleared.options.every(
        (option: { recommended?: boolean }) => !option.recommended,
      ),
    ).toBe(true);
    for (const args of [
      ["--recommend", "3"],
      ["--recommend", "1", "--recommend", "2"],
      ["--recommendation-reason", "No choice"],
    ]) {
      expect(
        (
          await harness.runCli([
            "question",
            "add",
            task.key,
            "--prompt",
            "Invalid?",
            "--option",
            "A",
            "--option",
            "B",
            ...args,
          ])
        ).exitCode,
      ).not.toBe(0);
    }
    const invalid = {
      taskId: task.id,
      prompt: "Invalid?",
      mode: "single",
      options: [{ label: "A", recommendationReason: "Unmarked" }, "B"],
    };
    await expect(harness.callRpc("createQuestion", invalid)).rejects.toThrow(
      "requires recommended=true",
    );
    await expect(
      harness.callRpc("createQuestion", {
        ...invalid,
        options: [
          {
            label: "A",
            recommended: true,
            recommendationReason: "ghp_" + "a".repeat(36),
          },
          "B",
        ],
      }),
    ).rejects.toThrow("question");
    expect(structured.listQuestions(task.id)).toHaveLength(1);
    const { question: multi } = await cli(
      "question",
      "add",
      task.key,
      "--prompt",
      "Platforms?",
      "--option",
      "A",
      "--option",
      "B",
      "--multiple",
      "--recommend",
      "1",
      "--recommend",
      "2",
      "--json",
    );
    expect(
      multi.options.every(
        (option: { recommended?: boolean }) => option.recommended,
      ),
    ).toBe(true);
    expect(multi.selectedOptionIds).toEqual([]);
  });

  it("reads replacement options on the CLI host and keeps existing option IDs", async () => {
    const { cli, harness, task, structured } = setup();
    const { question } = await structured.handlers.createQuestion({ kind: "decision", askedByThread: null,
      taskId: task.id,
      prompt: "Choices?",
      mode: "single",
      options: ["A", "B"],
    });
    const content = JSON.stringify([
      { id: question.options[0]!.id, label: "Renamed" },
      { label: "New" },
    ]);
    harness.sdk.stub("files.read", async ({ path }) => ({
      path,
      content,
      contentEncoding: "utf8",
      sizeBytes: content.length,
    }));
    const result = await cli(
      "question",
      "update",
      task.key,
      "--question",
      question.id,
      "--revision",
      "1",
      "--options-file",
      "/tmp/choices.json",
      "--json",
    );
    expect(result.question.options).toEqual([
      { id: question.options[0]!.id, label: "Renamed" },
      { id: expect.any(String), label: "New" },
    ]);
    expect(result.question.history[0].options).toEqual(question.options);
  });

  it("edits by stable option ID, rejects stale or unconfirmed changes and preserves the previous decision", async () => {
    const { task, harness, structured, cli, store } = setup();
    const { question } = await structured.handlers.createQuestion({ kind: "decision", askedByThread: null,
      taskId: task.id,
      prompt: "Size?",
      mode: "single",
      options: ["Small", "Large"],
    });
    const edited = await cli(
      "question",
      "update",
      task.key,
      "--question",
      question.id,
      "--revision",
      "1",
      "--prompt",
      "Canvas size?",
      "--json",
    );
    expect(edited.question).toMatchObject({
      options: question.options,
      prompt: "Canvas size?",
      revision: 2,
    });
    const { question: answered } = await structured.handlers.answerQuestion({
      questionId: question.id,
      revision: 2,
      selectedOptionIds: [question.options[0]!.id],
      authorName: "Owner",
    });
    const input = {
      questionId: question.id,
      revision: answered.revision,
      prompt: "Final size?",
      mode: "single" as const,
      options: [
        { ...question.options[0]!, label: "Compact" },
        { label: "Extra large" },
      ],
      authorName: "Editor",
    };
    const beforeComments = store.tasks.listComments(task.id);
    await expect(harness.callRpc("updateQuestion", input)).rejects.toThrow(
      "confirm reopen",
    );
    await expect(
      harness.callRpc("updateQuestion", {
        ...input,
        reopen: true,
        revision: 1,
      }),
    ).rejects.toThrow("Question changed");
    await expect(
      harness.callRpc("updateQuestion", {
        ...input,
        reopen: true,
        options: [{ id: task.id, label: "Foreign" }, { label: "Other" }],
      }),
    ).rejects.toThrow("does not belong");
    await expect(
      harness.callRpc("updateQuestion", {
        ...input,
        reopen: true,
        prompt: "ghp_" + "a".repeat(36),
      }),
    ).rejects.toThrow("question");
    expect(structured.listQuestions(task.id)[0]).toEqual(answered);
    expect(store.tasks.listComments(task.id)).toEqual(beforeComments);
    const { question: reopened } = tasksRpcContract.updateQuestion.output.parse(
      await harness.callRpc("updateQuestion", { ...input, reopen: true }),
    );
    expect(reopened).toMatchObject({
      id: question.id,
      revision: 4,
      selectedOptionIds: [],
      answerText: null,
      answeredBy: null,
      options: [
        { id: question.options[0]!.id, label: "Compact" },
        { label: "Extra large" },
      ],
    });
    expect(reopened.options[1]!.id).not.toBe(question.options[1]!.id);
    expect(reopened.history.at(-1)).toMatchObject({
      prompt: "Canvas size?",
      options: question.options,
      selectedOptionIds: answered.selectedOptionIds,
      answeredBy: "Owner",
      revision: 3,
    });
    expect(
      await harness.callRpc("questionCounts", { taskIds: [task.id] }),
    ).toMatchObject({ counts: [{ taskId: task.id, unanswered: 1, waitingOnOwner: true }] });
    const noop = await cli(
      "question",
      "update",
      task.key,
      "--question",
      question.id,
      "--revision",
      "4",
      "--json",
    );
    expect(noop.question).toEqual(reopened);
    const other = store.tasks.createTask({
      projectId: task.projectId,
      title: "Other",
    });
    expect(
      (
        await harness.runCli([
          "question",
          "update",
          other.key,
          "--question",
          question.id,
          "--revision",
          "4",
          "--prompt",
          "Wrong owner",
        ])
      ).exitCode,
    ).not.toBe(0);
  });

  it("supports opt-in free text through the CLI, guards secrets and retains previous answers", async () => {
    const { cli, task, harness, structured } = setup();
    const { question } = await cli(
      "question",
      "add",
      task.key,
      "--prompt",
      "Delivery?",
      "--option",
      "Now",
      "--option",
      "Later",

      "--json",
    );
    const result = await cli(
      "question",
      "answer",
      task.key,
      "--question",
      question.id,
      "--revision",
      "1",
      "--text",
      "After the release",
      "--json",
    );
    expect(result.question).toMatchObject({
      allowOther: true,
      answerText: "After the release",
      selectedOptionIds: [],
      revision: 2,
      history: [expect.objectContaining({ revision: 1, answerText: null })],
    });
    expect(
      await harness.callRpc("questionCounts", { taskIds: [task.id] }),
    ).toMatchObject({ counts: [{ taskId: task.id, unanswered: 0, waitingOnOwner: false }] });
    await expect(
      harness.callRpc("answerQuestion", {
        questionId: question.id,
        revision: 2,
        selectedOptionIds: [question.options[0].id],
        answerText: "Both",
      }),
    ).rejects.toThrow("Invalid question answer");
    await expect(
      harness.callRpc("answerQuestion", {
        questionId: question.id,
        revision: 2,
        selectedOptionIds: [],
        answerText: "ghp_" + "a".repeat(36),
      }),
    ).rejects.toThrow("question");
    const cleared = await cli(
      "question",
      "answer",
      task.key,
      "--question",
      question.id,
      "--revision",
      "2",
      "--clear",
      "--json",
    );
    expect(cleared.question).toMatchObject({
      answerText: null,
      answeredBy: null,
      history: [
        expect.anything(),
        expect.objectContaining({
          answerText: "After the release",
          revision: 2,
        }),
      ],
    });
    const other = (
      await structured.handlers.createQuestion({ kind: "decision", askedByThread: null,
        taskId: task.id,
        prompt: "Strict?",
        mode: "single",
        options: ["A", "B"],
      })
    ).question;
    await expect(
      harness.callRpc("answerQuestion", {
        questionId: other.id,
        revision: 1,
        selectedOptionIds: [],
        answerText: "Always allowed",
      }),
    ).resolves.toMatchObject({ question: { answerText: "Always allowed" } });
  });

  it.each([false, true])(
    "notifies the attached thread once and preserves the answer on delivery failure=%s",
    async (fails) => {
      const { harness, store, task, structured } = setup();
      harness.sdk.stub("threads.get", async ({ threadId }) =>
        makeThreadResponse({ id: threadId, status: "idle" }),
      );
      harness.sdk.stub("threads.send", async () => {
        if (fails) throw new Error("Unavailable");
      });
      store.tasks.upsertTaskThread({
        taskId: task.id,
        threadId: "thr_decision",
        presetName: "Existing thread",
        title: "Worker",
        liveStatus: "idle",
      });
      const { question } = await structured.handlers.createQuestion({ kind: "decision", askedByThread: null,
        taskId: task.id,
        prompt: "Proceed?",
        mode: "single",
        options: ["Yes", "No"],
      });
      const input = {
        questionId: question.id,
        revision: question.revision,
        selectedOptionIds: [question.options[0]!.id],
        authorName: "Owner",
      };
      const result = await structured.handlers.answerQuestion(input);
      expect(result.notification).toBe(fails ? "failed" : "sent");
      expect(structured.listQuestions(task.id)[0]?.selectedOptionIds).toEqual(
        input.selectedOptionIds,
      );
      expect(harness.sdk.callsTo("threads.send")).toEqual([
        [
          expect.objectContaining({
            threadId: "thr_decision",
            mode: "queue-if-active",
            input: [
              expect.objectContaining({
                text: expect.stringContaining("**Answer:** Yes"),
              }),
            ],
          }),
        ],
      ]);
      expect(JSON.stringify(harness.sdk.callsTo("threads.send"))).not.toContain("Treat this as updated context");
      expect(store.tasks.listComments(task.id)[0]?.notifiedCount).toBe(
        fails ? 0 : 1,
      );
      expect(
        (
          await structured.handlers.answerQuestion({
            ...input,
            revision: result.question.revision,
          })
        ).notification,
      ).toBe("unchanged");
      expect(harness.sdk.callsTo("threads.send")).toHaveLength(1);
    },
  );

  it("validates options, prevents stale answers and records changes atomically", async () => {
    const { harness, store, task } = setup();
    const { question } = tasksRpcContract.createQuestion.output.parse(
      await harness.callRpc("createQuestion", {
        taskId: task.id,
        prompt: "Which size?",
        options: ["Small", "Large"],
      }),
    );
    expect(question.mode).toBe("single");
    const answer = {
      questionId: question.id,
      revision: question.revision,
      selectedOptionIds: [question.options[0]!.id],
    };
    await expect(
      harness.callRpc("createQuestion", {
        taskId: task.id,
        prompt: "Duplicate",
        options: ["A", "A"],
      }),
    ).rejects.toThrow("unique");
    await expect(
      harness.callRpc("answerQuestion", {
        ...answer,
        selectedOptionIds: question.options.map((option) => option.id),
      }),
    ).rejects.toThrow("Invalid question answer");
    await expect(
      harness.callRpc("answerQuestion", {
        ...answer,
        selectedOptionIds: [task.id],
      }),
    ).rejects.toThrow("Invalid question answer");
    expect(store.tasks.listComments(task.id)).toHaveLength(0);
    const saved = tasksRpcContract.answerQuestion.output.parse(
      await harness.callRpc("answerQuestion", answer),
    ).question;
    expect(saved).toMatchObject({
      id: question.id,
      revision: 2,
      selectedOptionIds: answer.selectedOptionIds,
      answeredBy: "You",
    });
    await expect(
      harness.callRpc("answerQuestion", { ...answer, selectedOptionIds: [] }),
    ).rejects.toThrow("Question changed");
    expect(store.tasks.listComments(task.id)).toHaveLength(1);
    const cleared = tasksRpcContract.answerQuestion.output.parse(
      await harness.callRpc("answerQuestion", {
        ...answer,
        revision: saved.revision,
        selectedOptionIds: [],
      }),
    ).question;
    expect(cleared).toMatchObject({
      id: question.id,
      revision: 3,
      selectedOptionIds: [],
      answeredBy: null,
    });
    expect(store.tasks.listComments(task.id)).toHaveLength(2);
  });

  it("supports CLI multi-choice, task ownership, clearing, deletion and task cascade", async () => {
    const { cli, harness, structured, store, project, task, bb } = setup();
    const { question } = await cli(
      "question",
      "add",
      task.key,
      "--prompt",
      "Platforms?",
      "--option",
      "macOS",
      "--option",
      "Linux",
      "--multiple",
      "--json",
    );
    const ids = question.options.map((option: { id: string }) => option.id);
    const result = await cli(
      "question",
      "answer",
      task.key,
      "--question",
      question.id,
      "--answer",
      ids[0],
      "--answer",
      ids[1],
      "--revision",
      "1",
      "--json",
    );
    expect(result.question.selectedOptionIds).toEqual(ids);
    expect((await cli("show", task.key, "--json")).questions[0]).toMatchObject({
      id: question.id,
      mode: "multiple",
      selectedOptionIds: ids,
    });
    const other = store.tasks.createTask({
      projectId: project.id,
      title: "Other",
    });
    const foreign = await harness.runCli([
      "question",
      "answer",
      other.key,
      "--question",
      question.id,
      "--answer",
      ids[0],
      "--revision",
      "2",
    ]);
    expect(foreign).toMatchObject({ exitCode: 1 });
    expect(foreign.stderr).toContain("does not belong");
    await cli(
      "question",
      "answer",
      task.key,
      "--question",
      question.id,
      "--clear",
      "--revision",
      "2",
      "--json",
    );
    await cli(
      "question",
      "delete",
      task.key,
      "--question",
      question.id,
      "--revision",
      "3",
      "--json",
    );
    expect(structured.listQuestions(task.id)).toEqual([]);
    await structured.handlers.createQuestion({ kind: "decision", askedByThread: null,
      taskId: task.id,
      prompt: "Will cascade?",
      mode: "single",
      options: ["Yes", "No"],
    });
    store.tasks.deleteTask(task.id);
    expect(
      bb.storage.database().prepare("SELECT * FROM task_questions").all(),
    ).toEqual([]);
  });

  it("guards prompts and choice labels against secrets, including quoted text", async () => {
    const { harness, task, structured } = setup();
    const secret = "ghp_" + "a".repeat(36);
    for (const input of [
      { prompt: secret, options: ["A", "B"] },
      { prompt: "Safe", options: [secret, "B"] },
      {
        prompt: 'aws_secret_access_key = "' + "aB/1".repeat(10) + '"',
        options: ["A", "B"],
      },
    ]) {
      await expect(
        harness.callRpc("createQuestion", { taskId: task.id, ...input }),
      ).rejects.toThrow("detected");
    }
    expect(structured.listQuestions(task.id)).toEqual([]);
  });
});

describe("description templates", () => {
  it("sets, lists, applies, appends, shows and deletes a template through CLI", async () => {
    const { cli, harness, project } = setup();
    const { template } = await cli(
      "template",
      "set",
      "--project",
      project.prefix,
      "--name",
      "task",
      "--body-file",
      "/tmp/synthetic-template.md",
      "--json",
    );
    expect(template.body).toBe("**Goal:** template body");
    expect(
      (await cli("template", "list", "--project", project.prefix, "--json"))
        .templates,
    ).toEqual([template]);
    expect(
      (
        await cli(
          "template",
          "show",
          "--project",
          project.prefix,
          "--name",
          "task",
          "--json",
        )
      ).template.id,
    ).toBe(template.id);
    const created = await cli(
      "create",
      "--project",
      project.prefix,
      "--title",
      "From template",
      "--template",
      "task",
      "--description",
      "Extra acceptance criteria",
      "--json",
    );
    expect(created.task.description).toBe(
      "**Goal:** template body\n\nExtra acceptance criteria",
    );
    const missing = await harness.runCli([
      "create",
      "--project",
      project.prefix,
      "--title",
      "Missing",
      "--template",
      "unknown",
    ]);
    expect(missing.exitCode).not.toBe(0);
    await cli(
      "template",
      "delete",
      "--project",
      project.prefix,
      "--name",
      "task",
      "--json",
    );
    expect(
      (await cli("template", "list", "--project", project.prefix, "--json"))
        .templates,
    ).toEqual([]);
  });

  it("binds by label ID, refuses ambiguous labels, respects explicit selection and preserves stable IDs", async () => {
    const { structured, store, harness, project } = setup();
    const labels = ["Design", "QA"].map((name) =>
      store.tasks.createLabel({ projectId: project.id, name, color: "blue" }),
    );
    const first = await structured.handlers.setTemplate({
      projectId: project.id,
      name: "design",
      body: "Design template",
      labelId: labels[0]!.id,
    });
    await structured.handlers.setTemplate({
      projectId: project.id,
      name: "qa",
      body: "QA template",
      labelId: labels[1]!.id,
    });
    const input = {
      projectId: project.id,
      title: "By label",
      labelIds: [labels[0]!.id],
    };
    const automatic = tasksRpcContract.createTask.output.parse(
      await harness.callRpc("createTask", input),
    );
    expect(automatic).toMatchObject({
      ok: true,
      task: { description: "Design template" },
    });
    await expect(
      harness.callRpc("createTask", {
        ...input,
        labelIds: labels.map((label) => label.id),
      }),
    ).rejects.toThrow("--template");
    const explicit = tasksRpcContract.createTask.output.parse(
      await harness.callRpc("createTask", {
        ...input,
        labelIds: labels.map((label) => label.id),
        template: "qa",
      }),
    );
    expect(explicit).toMatchObject({
      ok: true,
      task: { description: "QA template" },
    });
    const updated = await structured.handlers.setTemplate({
      projectId: project.id,
      name: "DESIGN",
      body: "Updated template",
      labelId: labels[0]!.id,
    });
    expect(updated.template.id).toBe(first.template.id);
    expect(updated.template.name).toBe(first.template.name);
    await expect(
      harness.callRpc("setTemplate", {
        projectId: project.id,
        name: "unsafe",
        body: "sk-proj-" + "x".repeat(80),
      }),
    ).rejects.toThrow("detected");
  });
});

describe("evidence index", () => {
  it.each([
    {
      kind: "review",
      pr: 12,
      head: "a".repeat(40),
      verdict: "approve",
      thread: "thr_review",
      lens: "security",
    },
    {
      kind: "qa",
      head: "a".repeat(40),
      verdict: "partial",
      thread: "thr_qa",
      target: "localenv",
      note: "docs/findings.md",
    },
    {
      kind: "merge",
      pr: 12,
      head: "a".repeat(40),
      merge: "b".repeat(40),
      part: "1/2",
    },
    { kind: "deploy", pr: 12, merge: "b".repeat(40), run: "123", env: "production" },
    {
      kind: "exemption",
      row: "qa",
      reason: "Documentation only",
      ownerQuote: "Waived",
      date: "2026-10-23",
    },
  ])(
    "stores $kind through CLI and exposes every field in show/evidence JSON",
    async (entry) => {
      const { cli, task, store } = setup();
      const flags = Object.entries(entry).flatMap(([key, value]) => [
        `--${key === "ownerQuote" ? "owner-quote" : key}`,
        String(value),
      ]);
      const result = await cli(
        "comment",
        task.key,
        "--body",
        "Evidence remark",
        ...flags,
        "--json",
      );
      expect(result.comment.evidence).toEqual({ ...entry, recordedByThread: process.env.BB_THREAD_ID ?? null });
      const index = await cli(
        "evidence",
        task.key,
        "--kind",
        entry.kind,
        "--json",
      );
      expect(index.records[0]).toMatchObject({
        ...entry,
        body: "Evidence remark",
      });
      const shown = await cli("show", task.key, "--json");
      expect(shown.evidence[0]).toMatchObject(entry);
      expect(store.tasks.getTask(task.id)?.status).toBe("backlog");
    },
  );

  it("stamps CLI and UI writers automatically", async () => {
    const { cli, harness, task } = setup();
    const previous = process.env.BB_THREAD_ID;
    process.env.BB_THREAD_ID = "thr_writer";
    try {
      const result = await cli("comment", task.key, "--body", "Approved", "--kind", "review", "--pr", "12", "--head", "a".repeat(40), "--verdict", "approve", "--thread", "thr_reviewer", "--json");
      expect(result.comment.evidence.recordedByThread).toBe("thr_writer");
      expect((await cli("show", task.key, "--json")).evidence[0].recordedByThread).toBe("thr_writer");
    } finally {
      if (previous === undefined) delete process.env.BB_THREAD_ID; else process.env.BB_THREAD_ID = previous;
    }
    const result = await harness.callRpc("createComment", { taskId: task.id, body: "UI", notify: false, evidence: { kind: "review", pr: 12, head: "a".repeat(40), verdict: "approve", thread: "thr_reviewer", recordedByThread: "thr_spoofed" } });
    expect(tasksRpcContract.createComment.output.parse(result).comment.evidence?.recordedByThread).toBeNull();
  });

  it("flags self-review and only the newest uncovered approval", () => {
    const entries = [
      { kind: "review", pr: 12, head: "a".repeat(40), verdict: "approve", thread: "thr_author" },
      { kind: "qa", pr: 12, head: "b".repeat(40), verdict: "pass", thread: "thr_other" },
    ] as Evidence[];
    const records = evidenceIndex(entries.map((evidence, i) => ({ id: String(i), taskId: "t", kind: "agent", authorName: "A", presetName: null, threadId: null, body: "", notifiedCount: 0, createdAt: `2026-10-2${i}T00:00:00.000Z`, evidence } as Comment))).records;
    const prs: import("../shared/contract").TaskPullRequest[] = [{ url: "https://github.com/a/b/pull/12", number: 12, title: "PR", state: "merged", updatedAt: "2026-10-20", threadIds: ["thr_author"] }];
    const links = [{ link: { number: 12, url: prs[0]!.url }, snapshot: { state: "merged", headSha: "c".repeat(40) } }];
    expect(evidenceFlags(records, prs, links)).toEqual([
      { commentId: "0", kind: "self_review", message: "Reviewer is the PR author thread" },
      { commentId: "1", kind: "stale_head", message: "Approved head bbbbbbb differs from merged head ccccccc" },
    ]);
    expect(evidenceFlags(records, prs, [{ link: { number: 12, url: "https://github.com/other/repo/pull/12" }, snapshot: null }])).toEqual([]);
    expect(evidenceFlags(records, [], links).map((flag) => flag.kind)).toEqual(["stale_head"]);
    expect(evidenceFlags(records, [], [{ link: { number: 12 }, snapshot: { state: "merged", headSha: "a".repeat(40) } }])).toEqual([]);
    expect(evidenceFlags(records, [{ ...prs[0], threadIds: ["thr_other_author"] }], [])).toEqual([]);
  });

  it("rejects malformed or incomplete evidence and secrets without persisting comments", async () => {
    const { harness, task, store } = setup();
    for (const evidence of [
      {
        kind: "review",
        pr: 1,
        head: "abc",
        verdict: "approve",
        thread: "thr_review",
      },
      { kind: "qa", head: "a".repeat(40), verdict: "pass", thread: "invalid" },
      { kind: "exemption", row: "qa", reason: "waived", ownerQuote: "yes" },
      {
        kind: "merge",
        pr: 1,
        head: "a".repeat(40),
        merge: "b".repeat(40),
        part: "3/2",
      },
    ])
      expect(evidenceSchema.safeParse(evidence).success).toBe(false);
    await expect(
      harness.callRpc("createComment", {
        taskId: task.id,
        body: "Safe",
        notify: false,
        evidence: {
          kind: "exemption",
          row: "qa",
          reason: "ghp_" + "a".repeat(36),
        },
      }),
    ).rejects.toThrow("detected");
    expect(store.tasks.listComments(task.id)).toEqual([]);
  });

  it("groups PRs and heads, marks older heads and never treats late carry-over QA as a new head", () => {
    const a = "a".repeat(40),
      b = "b".repeat(40),
      merge = "c".repeat(40);
    const entries: Evidence[] = [
      { kind: "review", pr: 1, head: a, verdict: "approve", thread: "thr_old" },
      { kind: "review", pr: 1, head: b, verdict: "approve", thread: "thr_new" },
      { kind: "qa", pr: 1, head: a, verdict: "pass", thread: "thr_late" },
      { kind: "merge", pr: 1, head: b, merge },
      { kind: "deploy", merge, run: "1", env: "development" },
    ];
    const comments = entries.map(
      (evidence, index) =>
        ({
          id: String(index),
          taskId: "task",
          kind: "agent",
          authorName: "Agent",
          presetName: null,
          threadId: null,
          body: "Remark",
          notifiedCount: 0,
          createdAt: `2026-10-23T00:00:0${index}.000Z`,
          evidence,
        }) satisfies Comment,
    );
    const index = evidenceIndex(comments);
    expect(index.summary).toEqual([
      { pr: 1, newestHead: b, kinds: ["deploy", "merge", "review"] },
    ]);
    expect(index.records.filter((entry) => entry.superseded)).toHaveLength(2);
    expect(
      index.records.find((entry) => entry.kind === "deploy"),
    ).toMatchObject({ indexedPr: 1, indexedHead: b });
  });
});

describe("superseding an owner check", () => {
  const checkInput = (taskId: string, prompt: string, steps: string[] = [], supersedes?: { questionId: string; revision: number }) =>
    ({ kind: "check" as const, askedByThread: "thr_example", taskId, prompt, steps, mode: "single" as const, options: [], ...(supersedes ? { supersedes } : {}) });
  const confirm = (structured: ReturnType<typeof setup>["structured"], question: { id: string; revision: number; options: { id: string }[] }, answerText?: string) =>
    structured.handlers.answerQuestion({ questionId: question.id, revision: question.revision, selectedOptionIds: answerText ? [] : [question.options[0]!.id], answerText: answerText ?? null, authorName: "Owner" });
  const counts = async (structured: ReturnType<typeof setup>["structured"], taskId: string) => (await structured.handlers.questionCounts({ taskIds: [taskId] })).counts[0]!;

  it("closes an answered check with its remark kept, opens the successor and exposes the links", async () => {
    const { structured, task, cli } = setup();
    const { question: old } = await structured.handlers.createQuestion(checkInput(task.id, "Does [the list](https://example.com/a) render?"));
    const answered = (await confirm(structured, old, "Problem found: the header overlaps")).question;
    const { question: next } = await structured.handlers.createQuestion(checkInput(task.id, "Does [the list](https://example.com/b) render?", [], { questionId: old.id, revision: answered.revision }));
    const [before, after] = structured.listQuestions(task.id);
    expect(before).toMatchObject({ id: old.id, revision: answered.revision, answerText: "Problem found: the header overlaps", supersededBy: next.id, history: answered.history });
    expect(before!.supersededAt).toBeTruthy();
    expect(after).toMatchObject({ id: next.id, supersedes: old.id, answeredBy: null });
    expect(isQuestionOpen(before!)).toBe(false);
    expect(isQuestionOpen(after!)).toBe(true);
    expect(await counts(structured, task.id)).toMatchObject({ unanswered: 1, checks: 1, waitingOnOwner: true });
    const listed = (await cli("question", "list", task.key, "--json")).questions;
    expect(listed.map((question: { supersedes?: string; supersededBy?: string }) => [question.supersedes, question.supersededBy])).toEqual([[undefined, next.id], [old.id, undefined]]);
    const brief = (await cli("show", task.key, "--json", "--brief")).questions;
    expect(brief[0]).toMatchObject({ id: old.id, supersededBy: next.id, supersededAt: before!.supersededAt });
  });

  it("stops waiting on an unanswered predecessor and lets the card archive once the successor is answered", async () => {
    const { structured, store, project, task } = setup();
    const { question: old } = await structured.handlers.createQuestion(checkInput(task.id, "Does the form save?"));
    const { question: next } = await structured.handlers.createQuestion(checkInput(task.id, "Does the form save twice?", [], { questionId: old.id, revision: old.revision }));
    expect(await counts(structured, task.id)).toMatchObject({ unanswered: 1 });
    await confirm(structured, next);
    expect(await counts(structured, task.id)).toMatchObject({ unanswered: 0, waitingOnOwner: false });
    store.tasks.updateTask(task.id, { status: "done" });
    expect(store.tasks.archiveCompletedTasks(project.id, "2999-01-01T00:00:00.000Z").map((archived) => archived.id)).toEqual([task.id]);
  });

  it("refuses a foreign, decision or already superseded target, a decision successor and any change to a superseded check", async () => {
    const { structured, store, project, task } = setup();
    const other = store.tasks.createTask({ projectId: project.id, title: "Other" });
    const { question: foreign } = await structured.handlers.createQuestion(checkInput(other.id, "Does the other page load?"));
    const { question: decision } = await structured.handlers.createQuestion({ kind: "decision", askedByThread: null, taskId: task.id, prompt: "Which layout?", mode: "single", options: ["A", "B"] });
    const { question: old } = await structured.handlers.createQuestion(checkInput(task.id, "Does the page load?"));
    await expect(structured.handlers.createQuestion(checkInput(task.id, "Next?", [], { questionId: foreign.id, revision: 1 }))).rejects.toThrow(`Question ${foreign.id} is not on ${task.key}`);
    await expect(structured.handlers.createQuestion(checkInput(task.id, "Next?", [], { questionId: decision.id, revision: 1 }))).rejects.toThrow(/is a decision; --supersedes replaces only a check/);
    await expect(structured.handlers.createQuestion({ ...checkInput(task.id, "Next?", [], { questionId: old.id, revision: 1 }), kind: "decision", options: ["A"] })).rejects.toThrow(/must be --kind check/);
    const { question: next } = await structured.handlers.createQuestion(checkInput(task.id, "Does the page load now?", [], { questionId: old.id, revision: 1 }));
    await expect(structured.handlers.createQuestion(checkInput(task.id, "Again?", [], { questionId: old.id, revision: 1 }))).rejects.toThrow(`already superseded by ${next.id}`);
    const redirect = `Question ${old.id} is superseded by ${next.id}; act on that question`;
    // Stale revisions get the redirect too, before any revision check or no-op return.
    for (const revision of [1, 7]) {
      await expect(structured.handlers.answerQuestion({ questionId: old.id, revision, selectedOptionIds: [old.options[0]!.id], authorName: "Owner" })).rejects.toThrow(redirect);
      await expect(structured.handlers.answerQuestion({ questionId: old.id, revision, selectedOptionIds: [], answerText: null, authorName: "Owner" })).rejects.toThrow(redirect);
      await expect(structured.handlers.updateQuestion({ questionId: old.id, revision, prompt: old.prompt, mode: "single", options: old.options, authorName: "Agent" })).rejects.toThrow(redirect);
      await expect(structured.handlers.updateQuestion({ questionId: old.id, revision, prompt: old.prompt, mode: "single", options: old.options, reopen: true, authorName: "Agent" })).rejects.toThrow(redirect);
    }
  });

  it("withdraws only an open question on the named card and preserves its supersede chain", async () => {
    const { structured, task, store, project, harness } = setup();
    const h = structured.handlers;
    const { question: old } = await h.createQuestion(checkInput(task.id, "Does the list load?"));
    const answered = (await confirm(structured, old)).question;
    const input = { questionId: old.id, taskId: task.id, revision: answered.revision, reason: "Review canceled", authorName: "Agent" };
    await expect(h.withdrawQuestion(input)).rejects.toThrow(/answered/);
    const { question: head } = await h.createQuestion(checkInput(task.id, "Does the new list load?", [], { questionId: old.id, revision: answered.revision }));
    await expect(h.withdrawQuestion(input)).rejects.toThrow(`superseded by ${head.id}`);
    const request = { ...input, questionId: head.id, revision: head.revision };
    const other = store.tasks.createTask({ projectId: project.id, title: "Other" });
    await expect(h.withdrawQuestion({ ...request, taskId: other.id })).rejects.toThrow(/does not belong/);
    const wrongCard = await harness.runCli(["question", "withdraw", other.key, "--question", head.id, "--revision", "1", "--reason", input.reason]);
    expect(wrongCard.stderr).toContain("does not belong");
    await expect(h.withdrawQuestion({ ...request, revision: 2 })).rejects.toThrow(/reload/);
    for (const reason of [" ", "a".repeat(501), "ghp_" + "a".repeat(36)]) await expect(h.withdrawQuestion({ ...request, reason })).rejects.toThrow();
    expect(structured.listQuestions(task.id)[1]).toEqual(head);
    const { question } = await h.withdrawQuestion(request);
    expect(isQuestionOpen(question)).toBe(false);
    expect(question).toEqual({ ...head, withdrawnAt: expect.any(String), withdrawnBy: "Agent", withdrawReason: input.reason });
    expect(structured.listQuestions(task.id)[0]?.supersededBy).toBe(head.id);
    expect(store.tasks.listComments(task.id).filter(c => c.body.startsWith("Question withdrawn"))).toMatchObject([
      { kind: "system", authorName: "Agent", body: `Question withdrawn by Agent: ${head.prompt} — Reason: Review canceled` },
    ]);
    const refusal = `Question ${head.id} was withdrawn: Review canceled. Ask a new question if it is needed again.`;
    await expect(h.withdrawQuestion(request)).rejects.toThrow(refusal);
    await expect(h.answerQuestion({ ...request, selectedOptionIds: [] })).rejects.toThrow(refusal);
    for (const reopen of [true, false])
      await expect(h.updateQuestion({ ...request, prompt: head.prompt, mode: head.mode, options: head.options, reopen })).rejects.toThrow(refusal);
    await expect(h.deleteQuestion(request)).rejects.toThrow(refusal);
    await expect(h.createQuestion(checkInput(task.id, head.prompt, [], request))).rejects.toThrow(refusal);
    expect((await h.createQuestion(checkInput(task.id, head.prompt))).warnings).toBeUndefined();
    for (const fields of [{ answeredBy: "Owner", answerText: "Yes" }, { supersededBy: old.id, supersededAt: question.withdrawnAt },
      { withdrawnBy: undefined }, { withdrawReason: undefined }, { withdrawnAt: undefined }])
      expect(questionSchema.safeParse({ ...question, ...fields }).success).toBe(false);
  });

  it("lets only one of two replacements win and refuses a replacement of a revision the owner already answered", async () => {
    const { structured, task } = setup();
    const { question: old } = await structured.handlers.createQuestion(checkInput(task.id, "Does the export finish?"));
    const results = await Promise.allSettled([
      structured.handlers.createQuestion(checkInput(task.id, "Does the export finish (A)?", [], { questionId: old.id, revision: 1 })),
      structured.handlers.createQuestion(checkInput(task.id, "Does the export finish (B)?", [], { questionId: old.id, revision: 1 })),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(structured.listQuestions(task.id)).toHaveLength(2);
    const { question: second } = await structured.handlers.createQuestion(checkInput(task.id, "Does the import finish?"));
    // The answer lands just before the replacement that was based on the unanswered revision.
    const answered = (await confirm(structured, second, "Problem found")).question;
    await expect(structured.handlers.createQuestion(checkInput(task.id, "Does the import finish now?", [], { questionId: second.id, revision: 1 })))
      .rejects.toThrow(`Question ${second.id} is now at revision ${answered.revision} (answered "Problem found"), not 1`);
    expect(structured.listQuestions(task.id).find((question) => question.id === second.id)).toEqual(answered);
  });

  it("refuses a superseding check during plan debt and leaves the old check open and unchanged", async () => {
    const { structured, store, project } = setup();
    const card = store.tasks.createTask({ projectId: project.id, title: "Debt", status: "in_progress" });
    const { question: old } = await structured.handlers.createQuestion(checkInput(card.id, "Does the chart render?"));
    store.tasks.updateProject(project.id, { planning: "required" });
    await expect(structured.handlers.createQuestion(checkInput(card.id, "Does the chart render now?", [], { questionId: old.id, revision: 1 }))).rejects.toThrow(/Owner checks wait for an approved plan/);
    expect(structured.listQuestions(card.id)).toEqual([old]);
  });

  it("refuses to delete any question of a supersede chain", async () => {
    const { structured, task } = setup();
    const { question: head } = await structured.handlers.createQuestion(checkInput(task.id, "Step one?"));
    const { question: middle } = await structured.handlers.createQuestion(checkInput(task.id, "Step two?", [], { questionId: head.id, revision: 1 }));
    const { question: tail } = await structured.handlers.createQuestion(checkInput(task.id, "Step three?", [], { questionId: middle.id, revision: 1 }));
    for (const question of [head, middle, tail])
      await expect(structured.handlers.deleteQuestion({ questionId: question.id, revision: 1 })).rejects.toThrow(/part of a supersede chain.*cannot be deleted on its own/);
    // The revision check runs in the same write: a stale revision is still the reload error.
    await expect(structured.handlers.deleteQuestion({ questionId: tail.id, revision: 9 })).rejects.toThrow("Question changed; reload it before deleting");
    expect(structured.listQuestions(task.id)).toHaveLength(3);
  });

  it("keeps the links out of revision history through answer, reload and reopen, and reads legacy questions", async () => {
    const { bb, structured, task } = setup();
    const { question: old } = await structured.handlers.createQuestion(checkInput(task.id, "Does the banner show?"));
    const { question: next } = await structured.handlers.createQuestion(checkInput(task.id, "Does the banner hide?", [], { questionId: old.id, revision: 1 }));
    const answered = (await confirm(structured, next)).question;
    const reopened = (await structured.handlers.updateQuestion({ questionId: next.id, revision: answered.revision, prompt: next.prompt, mode: "single", options: answered.options, reopen: true, authorName: "Agent" })).question;
    const reloaded = structured.listQuestions(task.id).find((question) => question.id === next.id)!;
    expect(reloaded).toEqual(reopened);
    expect(reloaded.supersedes).toBe(old.id);
    for (const entry of reloaded.history) expect(Object.keys(entry).filter((key) => key.startsWith("supersed"))).toEqual([]);
    // A question written before supersession existed has none of the fields and stays open.
    const legacy = (await structured.handlers.createQuestion(checkInput(task.id, "Does the footer show?"))).question;
    bb.storage.database().prepare("UPDATE task_questions SET payload = json_remove(payload, '$.supersedes') WHERE id = ?").run(legacy.id);
    expect(isQuestionOpen(structured.listQuestions(task.id).find((question) => question.id === legacy.id)!)).toBe(true);
  });

  it("names --supersedes when a reopen changes the prompt link with the steps unchanged", async () => {
    const { structured, task } = setup();
    const { question } = await structured.handlers.createQuestion(checkInput(task.id, "Does [the page](https://example.com/a) look right?", ["Press Save"]));
    const answered = (await confirm(structured, question)).question;
    await expect(structured.handlers.updateQuestion({ questionId: question.id, revision: answered.revision, prompt: "Does [the page](https://example.com/b) look right?", steps: ["Press Save"], mode: "single", options: answered.options, reopen: true, authorName: "Agent" }))
      .rejects.toThrow(`--supersedes ${question.id} --supersedes-revision ${answered.revision}`);
  });

  it("saves a check with a duplicate prompt and warns with the existing id, revision, state and what to do", async () => {
    const { harness, structured, task } = setup();
    const { question: open } = await structured.handlers.createQuestion(checkInput(task.id, "Does the list render?", ["Open [state A](https://example.com/a)"]));
    const add = (...args: string[]) => harness.runCli(["question", "add", task.key, ...args]);
    // Same prompt after trimming, case-folding and collapsing whitespace, with a different step link: saved and warned.
    const text = await add("--kind", "check", "--prompt", "  does the   LIST render? ", "--step", "Open [state B](https://example.com/b)");
    expect(text.exitCode).toBe(0);
    expect(text.stderr).toContain(`Check ${open.id} (revision 1, open) on ${task.key} has the same prompt; both are saved. It is still open: edit it with \`bb work-board question update ${task.key} --question ${open.id} --revision 1\`.`);
    expect(structured.listQuestions(task.id)).toHaveLength(2);
    await confirm(structured, open, "Problem found");
    const json = JSON.parse((await add("--kind", "check", "--prompt", "Does the list render?", "--step", "Open [state A](https://example.com/a)", "--json")).stdout);
    expect(json.warnings.join("\n")).toContain(`Check ${open.id} (revision 2, answered "Problem found") on ${task.key} has the same prompt; both are saved. Its prompt and steps are unchanged: reopen it`);
    const changed = JSON.parse((await add("--kind", "check", "--prompt", "Does the list render?", "--step", "Open [state C](https://example.com/c)", "--json")).stdout);
    expect(changed.warnings.join("\n")).toContain(`--supersedes ${open.id} --supersedes-revision 2`);
    for (const args of [["--kind", "check", "--prompt", "Does the grid render?"], ["--kind", "decision", "--prompt", "Does the list render?", "--option", "Yes"]]) {
      const result = await add(...args);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain("has the same prompt");
    }
    // With --supersedes the add is the fix, so it is not warned about.
    const latest = structured.listQuestions(task.id).filter((question) => question.kind === "check" && question.prompt === "Does the list render?").at(-1)!;
    const replaced = await add("--kind", "check", "--prompt", "Does the list render?", "--supersedes", latest.id, "--supersedes-revision", "1");
    expect(replaced).toMatchObject({ exitCode: 0 });
    expect(replaced.stderr).not.toContain("has the same prompt");
    expect((await add("--kind", "check", "--prompt", "X?", "--supersedes", latest.id)).stderr).toContain("--supersedes and --supersedes-revision go together");
    expect((await harness.runCli(["question", "list", task.key])).stderr).toContain(`Question ${latest.id} is superseded by`);
  });

  it("drops an answer delivery when the check is superseded before dispatch", async () => {
    const { harness, structured, task } = setup();
    const { question: old } = await structured.handlers.createQuestion(checkInput(task.id, "Does the menu open?"));
    harness.sdk.stub("threads.get", async ({ threadId }) => {
      // The replacement commits while the answer notice is on its way.
      await structured.handlers.createQuestion(checkInput(task.id, "Does the menu open twice?", [], { questionId: old.id, revision: 2 }));
      return makeThreadResponse({ id: threadId, status: "idle" });
    });
    harness.sdk.stub("threads.send", async () => {});
    const result = await confirm(structured, old);
    expect(result.notification).toBe("none");
    expect(harness.sdk.callsTo("threads.send")).toEqual([]);
  });

  it("delivers a withdrawal that a replacement overtakes, naming the successor known at dispatch", async () => {
    const { harness, structured, task } = setup();
    harness.sdk.stub("threads.send", async () => {});
    harness.sdk.stub("threads.get", async ({ threadId }) => makeThreadResponse({ id: threadId, status: "idle" }));
    const { question: old } = await structured.handlers.createQuestion(checkInput(task.id, "Does the dialog close?"));
    const answered = (await confirm(structured, old)).question;
    let successor = "";
    harness.sdk.stub("threads.get", async ({ threadId }) => {
      // The replacement commits after the withdrawal is saved and before it reaches the thread.
      if (!successor) successor = (await structured.handlers.createQuestion(checkInput(task.id, "Does the dialog close twice?", [], { questionId: old.id, revision: answered.revision + 1 }))).question.id;
      return makeThreadResponse({ id: threadId, status: "idle" });
    });
    const result = await structured.handlers.answerQuestion({ questionId: old.id, revision: answered.revision, selectedOptionIds: [], answerText: null, authorName: "Owner" });
    expect(result.notification).toBe("sent");
    const sent = JSON.stringify(harness.sdk.callsTo("threads.send").at(-1));
    expect(sent).toContain("Answer withdrawn");
    expect(sent).toContain(`This check is superseded by ${successor}: act on that question.`);
  });

  it.each([false, true])("builds the withdrawal text after the queue read, so a replacement during it is named (queued row: %s)", async (queued) => {
    const { harness, structured, task } = setup();
    harness.sdk.stub("threads.send", async () => {});
    harness.sdk.stub("threads.queuedMessages.update", async () => ({ ok: true }) as never);
    harness.sdk.stub("threads.get", async ({ threadId }) => makeThreadResponse({ id: threadId, status: "idle" }));
    const { question: old } = await structured.handlers.createQuestion(checkInput(task.id, "Does the toast fade?"));
    const answered = (await confirm(structured, old)).question;
    let successor = "";
    harness.sdk.stub("threads.queuedMessages.list", async ({ threadId }) => {
      if (!successor) successor = (await structured.handlers.createQuestion(checkInput(task.id, "Does the toast fade twice?", [], { questionId: old.id, revision: answered.revision + 1 }))).question.id;
      return queued ? [makeQueueEntry({ id: "queued_1", threadId, originPluginId: "work-board", state: "queued", content: [{ type: "text", text: "[bb message from plugin:work-board]\n\nEarlier", mentions: [] }] })] : [];
    });
    await structured.handlers.answerQuestion({ questionId: old.id, revision: answered.revision, selectedOptionIds: [], answerText: null, authorName: "Owner" });
    const delivered = JSON.stringify(harness.sdk.callsTo(queued ? "threads.queuedMessages.update" : "threads.send").at(-1));
    expect(delivered).toContain("Answer withdrawn");
    expect(delivered).toContain(`This check is superseded by ${successor}: act on that question.`);
  });

  it("points a changed answered decision to a fresh decision question, never --supersedes", async () => {
    const { structured, task } = setup();
    const { question } = await structured.handlers.createQuestion({ kind: "decision", askedByThread: null, taskId: task.id, prompt: "Which layout?", mode: "single", options: ["A", "B"] });
    const answered = (await confirm(structured, question)).question;
    const reopen = structured.handlers.updateQuestion({ questionId: question.id, revision: answered.revision, prompt: "Which [layout](https://example.com/a)?", mode: "single", options: answered.options, reopen: true, authorName: "Agent" });
    await expect(reopen).rejects.toThrow(`Ask the changed decision as a fresh decision question: \`bb work-board question add ${task.key} --kind decision`);
    await expect(structured.handlers.updateQuestion({ questionId: question.id, revision: answered.revision, prompt: "Which [layout](https://example.com/a)?", mode: "single", options: answered.options, reopen: true, authorName: "Agent" })).rejects.not.toThrow(/--supersedes/);
  });

  it("shows the superseded check and lets an agent cancel after withdrawing each open question", async () => {
    const { harness, structured, task } = setup();
    const { question: old } = await structured.handlers.createQuestion(checkInput(task.id, "Does the table sort?"));
    await confirm(structured, old, "Problem found: wrong order");
    const { question: next } = await structured.handlers.createQuestion(checkInput(task.id, "Does the table sort now?", [], { questionId: old.id, revision: 2 }));
    const { question: plain } = await structured.handlers.createQuestion(checkInput(task.id, "Does the filter work?"));
    const brief = (await harness.runCli(["show", task.key, "--brief"])).stdout;
    expect(brief).toContain(`superseded by ${next.id}: Does the table sort? → Problem found: wrong order (${old.id})`);
    expect(brief).not.toContain(`✓ Does the table sort?`);
    const close = await harness.runCli(["update", task.key, "--status", "done"], { threadId: "thr_example" });
    expect(close.exitCode).not.toBe(0);
    expect(close.stderr).toContain(`--question ${plain.id} --revision 1`);
    for (const q of [plain, next]) {
      expect(close.stderr).toContain(`question withdraw ${task.key} --question ${q.id} --revision 1 --reason "..."`);
      const result = await harness.runCli(["question", "withdraw", task.key, "--question", q.id, "--revision", "1", "--reason", " Review canceled ", "--json"]);
      expect(JSON.parse(result.stdout).question).toMatchObject({ withdrawnBy: "cli", withdrawReason: "Review canceled", revision: 1 });
    }
    const message = "withdrawn by cli: Review canceled";
    expect((await harness.runCli(["question", "list", task.key])).stderr).toContain(message);
    for (const flags of [[], ["--brief"]])
      expect((await harness.runCli(["show", task.key, ...flags])).stdout).toContain(message);
    const json = JSON.parse((await harness.runCli(["show", task.key, "--brief", "--json"])).stdout);
    const row = json.questions.find((q: { id: string }) => q.id === next.id);
    expect(row).toMatchObject({ withdrawnBy: "cli", withdrawnAt: expect.any(String), withdrawReason: "Review canceled", supersedes: old.id });
    expect(row).not.toHaveProperty("answer");
    expect((await harness.runCli(["update", task.key, "--status", "canceled"], { threadId: "thr_example" })).exitCode).toBe(0);
  });

  it("tells a withdrawal's recipient to read supersededBy instead of treating the question as open", async () => {
    const { harness, structured, task } = setup();
    harness.sdk.stub("threads.get", async ({ threadId }) => makeThreadResponse({ id: threadId, status: "idle" }));
    harness.sdk.stub("threads.send", async () => {});
    const { question: old } = await structured.handlers.createQuestion(checkInput(task.id, "Does the tooltip show?"));
    const answered = (await confirm(structured, old)).question;
    await structured.handlers.answerQuestion({ questionId: old.id, revision: answered.revision, selectedOptionIds: [], answerText: null, authorName: "Owner" });
    // The withdrawal is queued first; the replacement commits before the thread reads it.
    await structured.handlers.createQuestion(checkInput(task.id, "Does the tooltip hide?", [], { questionId: old.id, revision: answered.revision + 1 }));
    const sent = JSON.stringify(harness.sdk.callsTo("threads.send").at(-1));
    expect(sent).toContain("Answer withdrawn");
    expect(sent).toContain("read this question's id, revision and `supersededBy` with `bb work-board question list " + task.key + "`; when `supersededBy` is set, act on that successor");
    expect(sent).not.toMatch(/open again/);
  });
});

describe("owner check readiness", () => {
  const evidence = { smoke: "Opened the form and saved a draft.", beyondDesign: "none" };
  it("gates additions, replacements and revisions atomically across moves", async () => {
    const { structured, task, harness, store } = setup();
    const { createQuestion, updateQuestion } = structured.handlers;
    const add = { taskId: task.id, kind: "check", prompt: "Does Save work?", askedByThread: "thr_example", mode: "single", options: [] } as const;
    const ask = (extra = {}) => createQuestion({ ...add, options: [], ...extra });
    const previous = (await ask()).question;
    const project = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue" });
    store.tasks.updateProject(project.id, { checkReadiness: "on" });
    store.tasks.moveTaskToProject(task.id, project.id);
    expect(structured.listQuestions(task.id)).toEqual([previous]);
    const hint = /smoke-test.*--smoke.*--beyond-design/;
    await expect(harness.callRpc("createQuestion", add)).rejects.toThrow(hint);
    const supersedes = { questionId: previous.id, revision: 1 };
    await expect(ask({ supersedes, smoke: evidence.smoke })).rejects.toThrow(hint);
    await expect(ask({ beyondDesign: "none" })).rejects.toThrow(hint);
    await ask({ kind: "decision", options: ["Yes"] });
    const q = (await ask({ supersedes, ...evidence })).question;
    const smokeComments = () => store.tasks.listComments(task.id).filter(c => c.body.startsWith("Smoke test for check"));
    expect(smokeComments()).toMatchObject([{ body: `Smoke test for check ${q.id} rev 1 (${q.prompt}): ${evidence.smoke}`, authorName: "agent (thr_example)" }]);
    const edit = (extra = {}) => updateQuestion({ questionId: q.id, revision: 1, prompt: q.prompt, mode: q.mode, options: q.options, authorName: "You", ...extra });
    for (const changes of [{ steps: ["Press Save"] }, { prompt: "Does Reload work?" }, { reopen: true }])
      await expect(edit(changes)).rejects.toThrow(hint);
    expect((await edit(evidence)).question.revision).toBe(1);
    await expect(edit({ ...evidence, reopen: true, revision: 2 })).rejects.toThrow(/reload/);
    expect(smokeComments()).toHaveLength(1);
    const updated = (await edit({ steps: ["Press Save"], ...evidence, beyondDesign: "Extra label" })).question;
    expect(updated).toMatchObject({ beyondDesign: "Extra label", history: [{ beyondDesign: "none" }] });
    expect(smokeComments()).toHaveLength(2);
    expect((await edit({ revision: 2, options: [{ label: "Works" }] })).question.beyondDesign).toBe("Extra label");
    for (const extra of [{ smoke: "short" }, { smoke: "x".repeat(2001) }, { beyondDesign: " " }, { beyondDesign: "x".repeat(501) },
      { smoke: "Found -----BEGIN PRIVATE KEY-----" }, { beyondDesign: "-----BEGIN PRIVATE KEY-----" }])
      await expect(harness.callRpc("createQuestion", { ...add, ...evidence, ...extra })).rejects.toThrow();
    expect(smokeComments()).toHaveLength(2);
  });

  it("reserves the setting and answer withdrawal for the panel even without a calling thread", async () => {
    const { harness, store, project, task, structured } = setup();
    const prior = process.env.BB_THREAD_ID;
    delete process.env.BB_THREAD_ID;
    try {
      for (const args of [["config", "set", "checkReadiness", "on", "--project", project.prefix], ["project", "update", project.prefix, "--check-readiness", "on"]]) {
        const refused = await harness.runCli(args);
        expect(refused.stderr).toContain("check readiness is changed by the owner");
      }
      await harness.callRpc("updateProject", { projectId: project.id, checkReadiness: "on" });
      expect(harness.logEntries).toContainEqual({ level: "info", message: `check readiness for ${project.prefix}: off → on` });
      expect((await harness.runCli(["config", "get", "checkReadiness", "--project", project.prefix])).stdout).toContain("checkReadiness=on");
      const result = await harness.runCli(["question", "add", task.key, "--kind", "check", "--prompt", "Can you save?", "--smoke", evidence.smoke, "--beyond-design", " NONE "]);
      expect(result.exitCode, result.stderr).toBe(0);
      const q = structured.listQuestions(task.id)[0]!;
      await structured.handlers.answerQuestion({ questionId: q.id, revision: 1, selectedOptionIds: [q.options[0]!.id], authorName: "You" });
      expect((await harness.runCli(["question", "answer", task.key, "--question", q.id, "--revision", "2", "--clear"])).stderr).toMatch(/--reopen.*--smoke.*--beyond-design/);
      expect(structured.listQuestions(task.id)[0]).toMatchObject({ revision: 2, answeredBy: "You", beyondDesign: "NONE" });
      for (const flags of [[], ["--json"]])
        expect((await harness.runCli(["show", task.key, "--brief", ...flags])).stdout).toContain("NONE");
      expect(store.tasks.listTasks({ waitingOnOwner: true })).toHaveLength(0);
    } finally {
      if (prior !== undefined) process.env.BB_THREAD_ID = prior;
    }
  });

  it("reminds the asker only on confirming the last open check carrying a design line", async () => {
    const { harness, task, structured } = setup();
    harness.sdk.stub("threads.get", async ({ threadId }) => makeThreadResponse({ id: threadId, status: "idle" }));
    harness.sdk.stub("threads.send", async () => {});
    const ask = async (prompt: string, extras = {}) => (await structured.handlers.createQuestion({ taskId: task.id, kind: "check", askedByThread: "thr_example", prompt, mode: "single", options: [], ...extras })).question;
    const first = await ask("Does reload work?", evidence);
    const second = await ask("Does save work?", evidence);
    const answer = async (check: typeof first, option: number) => {
      await structured.handlers.answerQuestion({ questionId: check.id, revision: 1, selectedOptionIds: [check.options[option]!.id], authorName: "You" });
      return JSON.stringify(harness.sdk.callsTo("threads.send").at(-1));
    };
    const reminder = "confirmed the last open check";
    expect(await answer(first, 0)).not.toContain(reminder);
    expect(await answer(second, 1)).not.toContain(reminder);
    expect(await answer(await ask("Does cancel work?"), 0)).not.toContain(reminder);
    expect(await answer(await ask("Does retry work?", evidence), 0)).toContain(reminder);
    // A multiple-choice answer that also reports a problem is not a confirmation.
    const mixed = await ask("Does export work?", { ...evidence, mode: "multiple" });
    await structured.handlers.answerQuestion({ questionId: mixed.id, revision: 1, selectedOptionIds: mixed.options.map(option => option.id), authorName: "You" });
    expect(JSON.stringify(harness.sdk.callsTo("threads.send").at(-1))).not.toContain(reminder);
  });
});
