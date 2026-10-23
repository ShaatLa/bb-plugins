import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  type FakePluginHarness,
} from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from "../api";
import { registerTasksCli } from "../cli";
import {
  tasksRpcContract,
  evidenceSchema,
  type Evidence,
  type Comment,
} from "../shared/contract";
import { createStructuredStore } from "./store";
import { evidenceIndex } from "./evidence";

const harnesses: FakePluginHarness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
});
function setup() {
  const { bb, harness } = createFakePluginHost({
    pluginId: "tasks-plus",
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
  registerTasksApi(bb, store);
  registerTasksCli(bb, store, { name: "Tasks Plus", version: "test" });
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
  it("reads replacement options on the CLI host and keeps existing option IDs", async () => {
    const { cli, harness, task, structured } = setup();
    const { question } = await structured.handlers.createQuestion({
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
    const { question } = await structured.handlers.createQuestion({
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
    ).toEqual({ counts: [{ taskId: task.id, unanswered: 1 }] });
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
      "--allow-other",
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
    ).toEqual({ counts: [] });
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
      await structured.handlers.createQuestion({
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
        answerText: "Not allowed",
      }),
    ).rejects.toThrow("Invalid question answer");
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
      const { question } = await structured.handlers.createQuestion({
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
                text: expect.stringContaining("Answer: Yes"),
              }),
            ],
          }),
        ],
      ]);
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
    await structured.handlers.createQuestion({
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
    { kind: "deploy", merge: "b".repeat(40), run: "123", env: "production" },
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
      expect(result.comment.evidence).toEqual(entry);
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
