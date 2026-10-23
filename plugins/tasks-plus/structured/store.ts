import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { TasksApiStore } from "../api";
import { createUlid } from "../db/store";
import { deliverCommentToLatestAgent } from "../steer";
import {
  questionSchema,
  templateSchema,
  type TaskQuestion,
  type DescriptionTemplate,
  type tasksRpcContract,
} from "../shared/contract";
import {
  assertNoSecrets,
  assertNoSecretsInValue,
} from "../shared/secret-guard";

export function createStructuredStore(bb: BbPluginApi, store: TasksApiStore) {
  const db = bb.storage.database();
  const changed = (taskId: string) => {
    const task = store.tasks.getTask(taskId)!;
    bb.realtime.publish("tasks:changed", { taskId, projectId: task.projectId });
  };
  const requireTask = (id: string) => {
    if (!store.tasks.getTask(id)) throw new Error(`Task not found: ${id}`);
  };
  const getQuestion = (id: string) => {
    const row = db
      .prepare<
        [string],
        { payload: string }
      >("SELECT payload FROM task_questions WHERE id = ?")
      .get(id);
    if (!row) throw new Error(`Question not found: ${id}`);
    return questionSchema.parse(JSON.parse(row.payload));
  };
  const listQuestions = (taskId: string): TaskQuestion[] =>
    db
      .prepare<[string], { payload: string }>(
        "SELECT payload FROM task_questions WHERE task_id = ? ORDER BY id",
      )
      .all(taskId)
      .map((row) => questionSchema.parse(JSON.parse(row.payload)));
  const listTemplates = (projectId: string): DescriptionTemplate[] =>
    db
      .prepare<
        [string],
        {
          id: string;
          project_id: string;
          name: string;
          body: string;
          label_id: string | null;
          created_at: string;
          updated_at: string;
        }
      >("SELECT * FROM description_templates WHERE project_id = ? ORDER BY id")
      .all(projectId)
      .map((row) =>
        templateSchema.parse({
          id: row.id,
          projectId: row.project_id,
          name: row.name,
          body: row.body,
          labelId: row.label_id,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }),
      );
  const applyTemplate = (
    projectId: string,
    name: string | undefined,
    labelIds: readonly string[],
    description = "",
  ) => {
    assertNoSecrets(name, "template name");
    const templates = listTemplates(projectId);
    const matches = name
      ? templates.filter(
          (template) => template.name.toLowerCase() === name.toLowerCase(),
        )
      : templates.filter(
          (template) => template.labelId && labelIds.includes(template.labelId),
        );
    if (name && matches.length === 0) throw new Error("Template not found");
    if (matches.length > 1)
      throw new Error(
        "Several labels have description templates; choose --template explicitly",
      );
    return matches[0]
      ? `${matches[0].body}${description.trim() ? `\n\n${description}` : ""}`
      : description;
  };
  const handlers: Pick<
    PluginRpcHandlers<typeof tasksRpcContract>,
    | "listQuestions"
    | "questionCounts"
    | "createQuestion"
    | "answerQuestion"
    | "updateQuestion"
    | "deleteQuestion"
    | "listTemplates"
    | "setTemplate"
    | "deleteTemplate"
  > = {
    listQuestions: ({ taskId }) => ({ questions: listQuestions(taskId) }),
    questionCounts: ({ taskIds }) => ({
      counts: taskIds.length
        ? db
            .prepare<string[], { taskId: string; unanswered: number }>(
              `SELECT task_id AS taskId, COUNT(*) AS unanswered FROM task_questions
         WHERE task_id IN (${taskIds.map(() => "?").join(",")})
           AND json_array_length(payload, '$.selectedOptionIds') = 0
           AND COALESCE(json_extract(payload, '$.answerText'), '') = ''
         GROUP BY task_id`,
            )
            .all(...taskIds)
        : [],
    }),
    createQuestion(input) {
      requireTask(input.taskId);
      const now = new Date().toISOString();
      const question = questionSchema.parse({
        id: createUlid(),
        taskId: input.taskId,
        prompt: input.prompt,
        mode: input.mode,
        allowOther: input.allowOther ?? false,
        options: input.options.map((label) => ({ id: createUlid(), label })),
        selectedOptionIds: [],
        answeredBy: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
      assertNoSecretsInValue(question, "question");
      db.prepare<[string, string, string]>(
        "INSERT INTO task_questions (id, task_id, payload) VALUES (?, ?, ?)",
      ).run(question.id, question.taskId, JSON.stringify(question));
      changed(question.taskId);
      return { question };
    },
    async answerQuestion(input) {
      let comment: ReturnType<typeof store.tasks.createComment> | undefined;
      const question = store.transaction(() => {
        const current = getQuestion(input.questionId);
        if (input.revision !== current.revision)
          throw new Error("Question changed; reload it before answering");
        const next = questionSchema.parse({
          ...current,
          selectedOptionIds: input.selectedOptionIds,
          answerText: input.answerText?.trim() || null,
          answeredBy:
            input.selectedOptionIds.length || input.answerText?.trim()
              ? input.authorName
              : null,
          revision: current.revision + 1,
          updatedAt: new Date().toISOString(),
        });
        assertNoSecretsInValue(next, "question");
        if (
          JSON.stringify([...current.selectedOptionIds].sort()) ===
            JSON.stringify([...next.selectedOptionIds].sort()) &&
          current.answerText === next.answerText
        )
          return current;
        const { id, taskId, createdAt, history, ...snapshot } = current;
        next.history = [...history, snapshot];
        db.prepare<[string, string]>(
          "UPDATE task_questions SET payload = ? WHERE id = ?",
        ).run(JSON.stringify(next), next.id);
        const selected = next.options.filter((option) =>
          next.selectedOptionIds.includes(option.id),
        );
        comment = store.tasks.createComment({
          taskId: next.taskId,
          kind: "system",
          authorName: input.authorName,
          body: `Question: ${next.prompt}\nAnswer: ${[...selected.map((option) => option.label), ...(next.answerText ? [next.answerText] : [])].join("; ") || "(cleared)"}`,
        });
        return next;
      });
      changed(question.taskId);
      if (!comment) return { question, notification: "unchanged" as const };
      bb.realtime.publish("comments:changed", { taskId: question.taskId });
      const threadId =
        store.tasks.listTaskThreads(question.taskId)[0]?.threadId ??
        store.tasks.getLatestAgentComment(question.taskId, comment.id)
          ?.threadId;
      if (!threadId) return { question, notification: "none" as const };
      const notifiedCount = await deliverCommentToLatestAgent(bb, store.tasks, {
        taskId: question.taskId,
        commentId: comment.id,
        body: `${comment.body}\nQuestion ID: ${question.id}; revision: ${question.revision}. Read the current saved decision with bb tasks question list ${store.tasks.getTask(question.taskId)!.key} --json before continuing.`,
        authorName: input.authorName,
        threadId,
        mode: "queue-if-active",
      });
      store.transaction(() =>
        store.tasks.updateComment(comment!.id, { notifiedCount }),
      );
      bb.realtime.publish("comments:changed", { taskId: question.taskId });
      return {
        question,
        notification: notifiedCount ? ("sent" as const) : ("failed" as const),
      };
    },
    updateQuestion(input) {
      const question = store.transaction(() => {
        const current = getQuestion(input.questionId);
        if (current.revision !== input.revision)
          throw new Error("Question changed; reload it before editing");
        if (
          input.options.some(
            (option) =>
              option.id &&
              !current.options.some((existing) => existing.id === option.id),
          )
        )
          throw new Error("Option ID does not belong to this question");
        const options = input.options.map((option) => ({
          id: option.id ?? createUlid(),
          label: option.label.trim(),
        }));
        const content = {
          prompt: input.prompt.trim(),
          mode: input.mode,
          options,
          allowOther: input.allowOther ?? current.allowOther,
        };
        const unchanged = Object.entries(content).every(
          ([key, value]) =>
            JSON.stringify(value) ===
            JSON.stringify(current[key as keyof typeof content]),
        );
        if (unchanged && !input.reopen) return current;
        if (current.answeredBy && !input.reopen)
          throw new Error(
            "Question has an answer; confirm reopen to clear it and request a new decision",
          );
        const { id, taskId, createdAt, history, ...snapshot } = current;
        const next = questionSchema.parse({
          ...current,
          ...content,
          selectedOptionIds: [],
          answerText: null,
          answeredBy: null,
          revision: current.revision + 1,
          updatedAt: new Date().toISOString(),
          history: [...history, snapshot],
        });
        assertNoSecretsInValue(next, "question");
        db.prepare<[string, string]>(
          "UPDATE task_questions SET payload = ? WHERE id = ?",
        ).run(JSON.stringify(next), next.id);
        store.tasks.createComment({
          taskId: next.taskId,
          kind: "system",
          authorName: input.authorName,
          body: `Question revised (revision ${next.revision}): ${next.prompt}${current.answeredBy ? "\nA new decision is required; the previous answer is retained in question history." : ""}`,
        });
        return next;
      });
      changed(question.taskId);
      bb.realtime.publish("comments:changed", { taskId: question.taskId });
      return { question };
    },
    deleteQuestion(input) {
      const question = getQuestion(input.questionId);
      if (question.revision !== input.revision)
        throw new Error("Question changed; reload it before deleting");
      const deleted =
        db
          .prepare<[string]>("DELETE FROM task_questions WHERE id = ?")
          .run(question.id).changes > 0;
      changed(question.taskId);
      return { deleted };
    },
    listTemplates: ({ projectId }) => ({ templates: listTemplates(projectId) }),
    setTemplate(input) {
      if (!store.tasks.getProject(input.projectId))
        throw new Error("Project not found");
      if (
        input.labelId &&
        store.tasks.getLabel(input.labelId)?.projectId !== input.projectId
      )
        throw new Error("Template label must belong to the same project");
      assertNoSecrets(input.name, "template name");
      assertNoSecrets(input.body, "template body");
      const current = listTemplates(input.projectId).find(
        (template) => template.name.toLowerCase() === input.name.toLowerCase(),
      );
      if (
        current &&
        current.body === input.body &&
        current.labelId === input.labelId
      )
        return { template: current };
      const now = new Date().toISOString();
      const template = templateSchema.parse({
        ...input,
        name: current?.name ?? input.name,
        id: current?.id ?? createUlid(),
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      });
      db.prepare<
        [string, string, string, string, string | null, string, string]
      >(
        "INSERT INTO description_templates (id, project_id, name, body, label_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, name) DO UPDATE SET body = excluded.body, label_id = excluded.label_id, updated_at = excluded.updated_at",
      ).run(
        template.id,
        template.projectId,
        template.name,
        template.body,
        template.labelId,
        template.createdAt,
        template.updatedAt,
      );
      bb.realtime.publish("projects:changed", { projectId: input.projectId });
      return { template };
    },
    deleteTemplate({ templateId }) {
      const row = db
        .prepare<
          [string],
          { project_id: string }
        >("SELECT project_id FROM description_templates WHERE id = ?")
        .get(templateId);
      const deleted =
        db
          .prepare<[string]>("DELETE FROM description_templates WHERE id = ?")
          .run(templateId).changes > 0;
      if (row)
        bb.realtime.publish("projects:changed", { projectId: row.project_id });
      return { deleted };
    },
  };
  return { handlers, listQuestions, listTemplates, applyTemplate };
}
