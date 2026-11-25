import { receiptGate } from "./check-receipt";
import { receiptInScope } from "../shared/check-receipt";
import { assertNotPlanApproval, assertQuestionShape, assertReopenKeepsScope, assertStepsAtomic, assertStepsSingleAction, checkGuidance, isQuestionOpen, normalizedPrompt, supersededRefusal } from "../shared/questions";
import { UNANSWERED_QUESTION, WAITING_ON_OWNER, NEWEST_UNANSWERED } from "../db/waiting-on-owner";
import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { TasksApiStore } from "../api";
import { createUlid } from "../db/store";
import { getWorkflowPolicy } from "../shared/workflow-policy";
import { planningOn, READINESS_HINT } from "../shared/project-settings";
import { defaultTaskThreadId, deliverCommentToLatestAgent, notifyThread } from "../steer";
import { errorMessage } from "../shared/errors";
import { planReviewThread, wakeReviewer } from "../plans/delivery";
import { openDecisionIds, reviewBinding, type ReviewBinding } from "../plans/pause";
import { planDebtService } from "../plan-debt/service";
import { openPlanDebt, recordPlanDebtEvent } from "../plan-debt/store";
import { planDebtCheckRefusal } from "../shared/plan-debt";
import { createPlanStore } from "../plans/store";
import { buildOwnerReviewSettledMessage, buildResultCopyMessage, buildReviewPausedMessage, buildReviewResumedMessage } from "../shared/plan-notes";
import {
  questionSchema,
  smokeSchema,
  templateSchema,
  type TaskQuestion,
  type PlanWake,
  type DescriptionTemplate,
  type tasksRpcContract,
} from "../shared/contract";
import {
  assertNoSecrets,
  assertNoSecretsInValue,
} from "../shared/secret-guard";

export function createStructuredStore(bb: BbPluginApi, store: TasksApiStore) {
  const db = bb.storage.database();
  const prepareReceipt = receiptGate(bb, store);
  const changed = (taskId: string) => {
    const task = store.tasks.getTask(taskId)!;
    bb.realtime.publish("tasks:changed", { taskId, projectId: task.projectId });
  };
  const requireTask = (id: string) => {
    if (!store.tasks.getTask(id)) throw new Error(`Task not found: ${id}`);
  };
  type ReadinessWrite = {
    smoke?: string;
    beyondDesign?: string;
    askedByThread?: string | null;
    authorName?: string;
    supersedes?: { questionId: string; revision: number };
    reopen?: boolean;
  };
  const recordReadiness = (question: TaskQuestion, input: ReadinessWrite, previous?: TaskQuestion) => {
    if (question.kind !== "check") return;
    const asking = !previous || input.reopen || previous.prompt !== question.prompt ||
      JSON.stringify(previous.steps) !== JSON.stringify(question.steps);
    if (asking && (!input.smoke || !input.beyondDesign)) {
      const task = store.tasks.getTask(question.taskId)!;
      if (store.tasks.getProject(task.projectId)?.checkReadiness === "on") {
        const command = previous
          ? `update ${task.key} --question ${question.id} --revision ${previous.revision}${input.reopen ? " --reopen" : ""}`
          : `add ${task.key} --kind check${input.supersedes ? ` --supersedes ${input.supersedes.questionId} --supersedes-revision ${input.supersedes.revision}` : ""}`;
        const prompt = !previous || previous.prompt !== question.prompt ? ' --prompt "<prompt>"' : "";
        const steps = question.steps.length && (!previous || JSON.stringify(previous.steps) !== JSON.stringify(question.steps)) ? ' --step "<step>"' : "";
        throw new Error(`${READINESS_HINT}. Use \`bb work-board question ${command}${prompt}${steps} --smoke "<what you ran and saw>" --beyond-design "<extras or none>"\`.`);
      }
    }
    if (input.smoke !== undefined) {
      const smoke = smokeSchema.parse(input.smoke);
      assertNoSecrets(smoke, "smoke test");
      store.tasks.createComment({
        taskId: question.taskId,
        kind: "system",
        authorName: input.askedByThread ? `agent (${input.askedByThread})` : input.authorName ?? "You",
        body: `Smoke test for check ${question.id} rev ${question.revision} (${question.prompt.slice(0, 100)}): ${smoke}`,
      });
    }
  };
  const assertNotPlanQuestion = (taskId: string, prompt: string, steps: readonly string[]) => {
    const task = store.tasks.getTask(taskId)!;
    // With planning off the plan has no review, so a question about it is an ordinary question.
    if (!planningOn(store.tasks.getProject(task.projectId) ?? {})) return;
    assertNotPlanApproval(prompt, steps, task.key, db.prepare<[string], { found: number }>("SELECT 1 AS found FROM task_plans WHERE task_id = ?").get(taskId) !== undefined);
  };
  /** An owner check waits for an approved plan; decisions stay allowed because a plan often needs one. */
  const assertNoCheckDuringPlanDebt = (taskId: string) => {
    const debt = openPlanDebt(db, taskId);
    if (debt) throw new Error(planDebtCheckRefusal(store.tasks.getTask(taskId)!.key, debt));
  };
  const plans = createPlanStore(db, store.tasks);
  /**
   * The wake a question write owes the plan reviewer, read inside the write's own transaction from the open-decision count
   * before and after: only 0 → ≥1 (pause) and ≥1 → 0 (resume) count, and only while a review waits on the card. A resume also
   * fixes who is told about it, as of the attempt it settled.
   */
  type Wake = { event: PlanWake["event"]; taskId: string; binding: ReviewBinding; recipients: { actor: string | null; copy: string | null } } | null;
  const decisionTransition = (taskId: string, before: number): Wake => {
    const after = openDecisionIds(db, taskId).length;
    if ((before === 0) === (after === 0)) return null;
    const binding = reviewBinding(db, taskId);
    return binding ? { event: after > 0 ? "paused" : "resumed", taskId, binding, recipients: plans.resultRecipients(taskId, binding.version, binding.attemptId) } : null;
  };
  /** Sends the wake after the commit. A delivery failure never undoes the question; it comes back for the command to print. */
  async function announce(wake: Wake): Promise<PlanWake | undefined> {
    const task = wake && store.tasks.getTask(wake.taskId);
    const project = task && store.tasks.getProject(task.projectId);
    // With planning off the plan is not touched. An owner review has no thread to wake, but its author still hears a resume.
    if (!wake || !task || !project || !planningOn(project)) return undefined;
    const { reviewerThread, version, attemptId } = wake.binding;
    if (!reviewerThread && wake.event === "paused") return undefined;
    // Read again right before each append or send, and once more before a failure is reported: after an override, a
    // reassignment, a newer draft or a decision that changed again, a notice that went stale is dropped.
    // The live count must still match the event, in both directions: a delayed pause never follows its own resume.
    const wanted = () => reviewBinding(db, task.id)?.attemptId === attemptId && (openDecisionIds(db, task.id).length > 0) === (wake.event === "paused");
    if (!wanted()) return undefined;
    const failed: string[] = [];
    let hint: string | null = null;
    // A wake that went stale everywhere reports nothing.
    let sentAny = false;
    const text = (wake.event === "paused" ? buildReviewPausedMessage : reviewerThread ? buildReviewResumedMessage : buildOwnerReviewSettledMessage)({ taskKey: task.key, version });
    if (reviewerThread) {
      const woke = await wakeReviewer(bb, { taskId: task.id, taskKey: task.key, threadId: reviewerThread, text, wanted });
      if (woke.delivered === "failed") {
        failed.push(reviewerThread);
        hint = woke.hint;
      } else if (woke.delivered === "sent") sentAny = true;
    }
    if (wake.event === "resumed") {
      // The author hears about it for information, through the same routing as a review result, as of the settled attempt.
      const copy = buildResultCopyMessage({ taskKey: task.key, headline: text, actor: reviewerThread });
      const told = new Set<string>();
      for (const original of [wake.recipients.actor, wake.recipients.copy]) {
        // A recipient that cannot be reached at all is a failure; an author with no thread (a plan written in the app) is not.
        if (!original) continue;
        const thread = await planReviewThread(bb, original);
        if (!thread) {
          failed.push(original);
          continue;
        }
        if (thread === reviewerThread || told.has(thread)) continue;
        told.add(thread);
        try {
          if (await notifyThread(bb, thread, copy, wanted)) sentAny = true;
        } catch (error) {
          bb.log.warn(`failed to tell ${thread} that the decision on ${task.key} is settled: ${errorMessage(error)}`);
          failed.push(thread);
        }
      }
    }
    // Lookups and sends take time: a handoff warning is only for a notice that is still needed once they are done.
    if (failed.length && !wanted()) failed.length = 0;
    if (!failed.length && !sentAny) return undefined;
    return { event: wake.event, delivered: failed.length ? "failed" : "sent", failed, hint: failed.length ? hint : null };
  }
  const findQuestion = (id: string) => {
    const row = db
      .prepare<
        [string],
        { payload: string }
      >("SELECT payload FROM task_questions WHERE id = ?")
      .get(id);
    return row ? questionSchema.parse(JSON.parse(row.payload)) : undefined;
  };
  const getQuestion = (id: string) => {
    const question = findQuestion(id);
    if (!question) throw new Error(`Question not found: ${id}`);
    return question;
  };
  const taskKey = (taskId: string) => store.tasks.getTask(taskId)!.key;
  const assertNotWithdrawn = (question: TaskQuestion) => {
    if (question.withdrawnAt)
      throw new Error(`Question ${question.id} was withdrawn: ${question.withdrawReason}. Ask a new question if it is needed again.`);
  };
  /** Any change to a superseded check is redirected to its successor, before revision checks and no-op returns. */
  const assertQuestionCurrent = (question: TaskQuestion) => {
    assertNotWithdrawn(question);
    if (question.supersededBy) throw new Error(supersededRefusal(question, taskKey(question.taskId)));
  };
  const answerOf = (state: Pick<TaskQuestion, "options" | "selectedOptionIds" | "answerText">) => [
    ...state.options.filter((option) => state.selectedOptionIds.includes(option.id)).map((option) => option.label),
    ...(state.answerText ? [state.answerText] : []),
  ].join("; ");
  const stateOf = (question: TaskQuestion) => {
    const answer = answerOf(question);
    return isQuestionOpen(question) ? "open" : `answered "${answer.length > 80 ? `${answer.slice(0, 80)}…` : answer}"`;
  };
  /** A revision snapshot carries only the question's own state; the supersession links stay on the question. */
  const snapshotOf = (question: TaskQuestion) => {
    const { id: _id, taskId: _taskId, createdAt: _createdAt, history: _history, supersedes: _supersedes, supersededBy: _supersededBy, supersededAt: _supersededAt, ...snapshot } = question;
    return snapshot;
  };
  const listQuestions = (taskId: string): TaskQuestion[] =>
    db
      .prepare<[string], { payload: string }>(
        "SELECT payload FROM task_questions WHERE task_id = ? ORDER BY id",
      )
      .all(taskId)
      .map((row) => questionSchema.parse(JSON.parse(row.payload)));
  // Keep the association in the exported system comment, without changing the archive schema.
  const answerCommentId = (question: TaskQuestion) => question.answeredBy ? db.prepare<[string, string], { id: string }>(
    "SELECT id FROM comments WHERE task_id = ? AND kind = 'system' AND body LIKE ? ORDER BY id DESC LIMIT 1",
  ).get(question.taskId, `%\nQuestion ID: ${question.id}; revision: %`)?.id ?? null : null;
  const syncDecisionLabel = (taskId: string) => {
    const task = store.tasks.getTask(taskId)!;
    const name = getWorkflowPolicy(store.tasks.getProject(task.projectId)!).ownerDecisionLabel;
    if (!name) return;
    const open = listQuestions(taskId).some(isQuestionOpen);
    let label = store.tasks.listLabels(task.projectId).find((item) => item.name === name);
    if (open) {
      label ??= store.tasks.createLabel({ projectId: task.projectId, name, color: "blue" });
      store.tasks.addTaskLabel(taskId, label.id);
    } else if (label) {
      store.tasks.removeTaskLabel(taskId, label.id);
    }
  };
  // One project-wide read grouped by task, in the same per-task order (id) as listQuestions.
  const listQuestionsForProject = (projectId: string) => {
    const byTask = new Map<string, TaskQuestion[]>();
    for (const row of db
      .prepare<[string], { task_id: string; payload: string }>(
        `SELECT q.task_id, q.payload FROM task_questions q JOIN tasks t ON t.id = q.task_id
         WHERE t.project_id = ? ORDER BY q.task_id, q.id`,
      )
      .all(projectId)) {
      const list = byTask.get(row.task_id) ?? [];
      list.push(questionSchema.parse(JSON.parse(row.payload)));
      byTask.set(row.task_id, list);
    }
    return byTask;
  };
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
    | "withdrawQuestion"
    | "deleteQuestion"
    | "listTemplates"
    | "setTemplate"
    | "deleteTemplate"
  > = {
    listQuestions: ({ taskId }) => ({ questions: listQuestions(taskId).map(question => {
      const commentId = answerCommentId(question);
      return { ...question, answerCommentId: commentId,
        answerAttachments: commentId ? store.tasks.listAttachmentsForComment(commentId).map(({ id, fileName, mime, sizeBytes }) => ({ id, fileName, mime, sizeBytes })) : [] };
    }) }),
    questionCounts: ({ taskIds }) => ({
      counts: taskIds.length ? db.prepare<string[], { taskId: string; unanswered: number; decisions: number; checks: number; waitingOnOwner: number; newestUnansweredAt: string | null }>(`
        SELECT t.id AS taskId,
          (SELECT COUNT(*) FROM task_questions q WHERE q.task_id=t.id AND ${UNANSWERED_QUESTION}) AS unanswered,
          (SELECT COUNT(*) FROM task_questions q WHERE q.task_id=t.id AND ${UNANSWERED_QUESTION} AND COALESCE(json_extract(q.payload, '$.kind'), 'decision')='decision') AS decisions,
          (SELECT COUNT(*) FROM task_questions q WHERE q.task_id=t.id AND ${UNANSWERED_QUESTION} AND json_extract(q.payload, '$.kind')='check') AS checks,
          (${WAITING_ON_OWNER}) AS waitingOnOwner,
          ${NEWEST_UNANSWERED} AS newestUnansweredAt
        FROM tasks t WHERE t.id IN (${taskIds.map(() => "?").join(",")})
      `).all(...taskIds).map(row => ({ ...row, waitingOnOwner: Boolean(row.waitingOnOwner) })) : [],
    }),
    async createQuestion(input) {
      requireTask(input.taskId);
      assertQuestionShape(input.prompt, input.steps ?? []);
      assertStepsAtomic(input.steps ?? []);
      assertStepsSingleAction(input.steps ?? []);
      assertNotPlanQuestion(input.taskId, input.prompt, input.steps ?? []);
      if (input.supersedes && input.kind !== "check")
        throw new Error("--supersedes replaces an owner check, so the new question must be --kind check; ask a decision without --supersedes.");
      const now = new Date().toISOString();
      const question = questionSchema.parse({
        id: createUlid(),
        taskId: input.taskId,
        kind: input.kind ?? "decision",
        askedByThread: input.askedByThread ?? null,
        ...(input.kind === "check" && input.beyondDesign ? { beyondDesign: input.beyondDesign } : {}),
        prompt: input.prompt,
        steps: input.steps ?? [],
        mode: input.mode,
        allowOther: true,
        options: (input.kind === "check" && !input.options.length ? ["Confirmed", "Problem found"] : input.options).map((option) => ({
          ...(typeof option === "string" ? { label: option } : option),
          id: createUlid(),
        })),
        selectedOptionIds: [],
        answeredBy: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        ...(input.supersedes ? { supersedes: input.supersedes.questionId } : {}),
      });
      assertNoSecretsInValue(question, "question");
      const predecessor = input.supersedes ? findQuestion(input.supersedes.questionId) : undefined;
      if (input.supersedes && (!predecessor || predecessor.taskId !== input.taskId))
        throw new Error(`Question ${input.supersedes.questionId} is not on ${taskKey(input.taskId)}; --supersedes names a check on the same card (see \`bb work-board question list ${taskKey(input.taskId)}\`).`);
      const receipt = await prepareReceipt(input.supersedes ? "supersede" : "add", question, input, predecessor);
      const warnings: string[] = receipt.warnings;
      const wake = store.transaction(() => {
        receipt.verify?.();
        const before = openDecisionIds(db, question.taskId).length;
        const key = taskKey(question.taskId);
        if (input.supersedes) {
          // Read and linked in the same write as the insert, so of two replacements of one check only one wins.
          const { questionId, revision } = input.supersedes;
          const target = findQuestion(questionId);
          if (!target || target.taskId !== question.taskId)
            throw new Error(`Question ${questionId} is not on ${key}; --supersedes names a check on the same card (see \`bb work-board question list ${key}\`).`);
          assertNotWithdrawn(target);
          if (target.kind !== "check")
            throw new Error(`Question ${questionId} is a decision; --supersedes replaces only a check. Change a decision with \`bb work-board question update ${key} --question ${questionId} --revision ${target.revision}\`.`);
          if (target.supersededBy)
            throw new Error(`Question ${questionId} is already superseded by ${target.supersededBy}; supersede that check instead.`);
          if (target.revision !== revision)
            throw new Error(`Question ${questionId} is now at revision ${target.revision} (${stateOf(target)}), not ${revision}; read it with \`bb work-board question list ${key}\` and supersede the revision you mean to replace.`);
          db.prepare<[string, string]>("UPDATE task_questions SET payload = ? WHERE id = ?")
            .run(JSON.stringify(questionSchema.parse({ ...target, supersededBy: question.id, supersededAt: now })), target.id);
        } else if (question.kind === "check") {
          // Two checks may share a prompt and differ in their step targets, so a duplicate is saved and only warned about.
          const prompt = normalizedPrompt(question.prompt);
          for (const existing of listQuestions(question.taskId))
            if (existing.kind === "check" && !existing.supersededBy && !existing.withdrawnAt && normalizedPrompt(existing.prompt) === prompt)
              warnings.push(`Check ${existing.id} (revision ${existing.revision}, ${stateOf(existing)}) on ${key} has the same prompt; both are saved. ${checkGuidance(key, existing, question)} Then delete this new one with \`bb work-board question delete ${key} --question ${question.id} --revision 1\` unless both are needed.`);
        }
        // Check in the same transaction as both the supersede link and the insert.
        if (question.kind === "check") assertNoCheckDuringPlanDebt(question.taskId);
        db.prepare<[string, string, string]>(
          "INSERT INTO task_questions (id, task_id, payload) VALUES (?, ?, ?)",
        ).run(question.id, question.taskId, JSON.stringify(question));
        recordReadiness(question, input);
        receipt.record?.(question);
        syncDecisionLabel(question.taskId);
        return decisionTransition(question.taskId, before);
      });
      if ((input.smoke || receipt.record) && question.kind === "check") bb.realtime.publish("comments:changed", { taskId: question.taskId });
      changed(question.taskId);
      const planWake = await announce(wake);
      return { question, ...(planWake ? { planWake } : {}), ...(warnings.length ? { warnings } : {}) };
    },
    async answerQuestion(input) {
      let withdrawn = false;
      let debtEvent = false, sameAnswer = false;
      let notice = "";
      let comment: ReturnType<typeof store.tasks.createComment> | undefined;
      let wake: Wake = null;
      const question = store.transaction(() => {
        const current = getQuestion(input.questionId);
        assertQuestionCurrent(current);
        const before = openDecisionIds(db, current.taskId).length;
        const attachmentIds = input.attachmentIds ?? [];
        if (new Set(attachmentIds).size !== attachmentIds.length) throw new Error("Duplicate attachment IDs");
        for (const id of attachmentIds) {
          const attachment = store.tasks.getAttachment(id);
          if (!attachment || attachment.taskId !== current.taskId || attachment.commentId)
            throw new Error("Attachment must belong to this task and not to a comment");
        }
        if (attachmentIds.length && !input.selectedOptionIds.length && !input.answerText?.trim())
          throw new Error("Attachments require an answer");
        if (input.revision !== current.revision)
          throw new Error("Question changed; reload it before answering");
        const clearing = !input.selectedOptionIds.length && !input.answerText?.trim();
        if (input.refuseReadinessClear && clearing && current.kind === "check") {
          const task = store.tasks.getTask(current.taskId)!;
          // The card's project as it is now, inside this write, so a concurrent move cannot slip a clear through.
          const project = store.tasks.getProject(task.projectId)!;
          const readiness = project.checkReadiness === "on";
          const receipt = receiptInScope(project.checkReceipt, current.prompt, current.steps);
          if (readiness || receipt)
            throw new Error(`${readiness ? READINESS_HINT : "This project requires a UI receipt"}. Use \`bb work-board question update ${task.key} --question ${current.id} --revision ${current.revision} --reopen${readiness ? ' --smoke "<what you ran and saw>" --beyond-design "<extras or none>"' : ""}${receipt ? " --receipt <file>" : ""}\`.`);
        }
        const next = questionSchema.parse({
          ...current,
          // Free text is always allowed now; stamping it keeps answered records valid under the pre-0.33 rule.
          allowOther: true,
          selectedOptionIds: input.selectedOptionIds,
          answerText: input.answerText?.trim() || null,
          answeredBy:
            (input.selectedOptionIds.length || input.answerText?.trim())
              ? input.authorName
              : null,
          revision: current.revision + 1,
          updatedAt: new Date().toISOString(),
        });
        assertNoSecretsInValue(next, "question");
        // Attachments make a save a change, but only options and text make it a new answer.
        sameAnswer = JSON.stringify([...current.selectedOptionIds].sort()) === JSON.stringify([...next.selectedOptionIds].sort()) && current.answerText === next.answerText;
        if (sameAnswer && !attachmentIds.length) return current;
        next.history = [...current.history, snapshotOf(current)];
        db.prepare<[string, string]>(
          "UPDATE task_questions SET payload = ? WHERE id = ?",
        ).run(JSON.stringify(next), next.id);
        syncDecisionLabel(next.taskId);
        wake = decisionTransition(next.taskId, before);
        const answer = answerOf(next), previous = answerOf(current);
        // A saved, non-empty answer to a decision is a plan-debt trigger of the card's open episode.
        if ((next.kind ?? "decision") === "decision" && answer && !sameAnswer) debtEvent = recordPlanDebtEvent(db, next.taskId, `answer:${next.id}:${next.revision}`);
        withdrawn = !answer && Boolean(previous);
        comment = store.tasks.createComment({
          taskId: next.taskId,
          kind: "system",
          authorName: input.authorName,
          body: `Question: ${next.prompt}\n${answer ? `Answer: ${answer}` : withdrawn ? `Answer withdrawn (was: ${previous})` : "Answer: (cleared)"}\nQuestion ID: ${next.id}; revision: ${next.revision}`,
        });
        // Delivered as Markdown, so each part is its own paragraph instead of one run-on line.
        notice = [
          `**Question:** ${next.prompt}`,
          answer ? `**Answer:** ${answer}` : withdrawn ? `**Answer withdrawn** (was: ${previous})` : "**Answer:** (cleared)",
          `Question ID: ${next.id}; revision: ${next.revision}`,
          ...(next.kind === "check" && next.beyondDesign && isQuestionOpen(current) &&
            // Confirmed alone: a multiple-choice answer that also reports a problem is not a confirmation.
            next.selectedOptionIds.length === 1 && next.options.find(option => option.id === next.selectedOptionIds[0])?.label === "Confirmed" &&
            !listQuestions(next.taskId).some(q => q.kind === "check" && isQuestionOpen(q))
            ? ["The owner confirmed the last open check. If this card's work goes to a PR, run the full review and the tests once now, then open it."] : []),
        ].join("\n\n");
        for (const id of attachmentIds) db.prepare<[string, string]>(
          "UPDATE attachments SET task_id = NULL, comment_id = ? WHERE id = ?",
        ).run(comment.id, id);
        return next;
      });
      const commentId = comment?.id ?? answerCommentId(question);
      const attachments = commentId ? store.tasks.listAttachmentsForComment(commentId) : [];
      const result = { commentId, attachmentIds: attachments.map(a => a.id) };
      changed(question.taskId);
      if (!comment) return { ...result, question, notification: "unchanged" as const };
      bb.realtime.publish("comments:changed", { taskId: question.taskId });
      const planWake = await announce(wake);
      // Its own message, after the answer's delivery below and outside it: the reminder has its own receipts.
      const remind = () => (debtEvent ? planDebtService(bb, store.tasks).drain() : undefined);
      const threadId = question.askedByThread ?? defaultTaskThreadId(store.tasks, question.taskId, comment.id);
      if (!threadId) { await remind(); return { ...result, question, notification: "none" as const, ...(planWake ? { planWake } : {}) }; }
      const key = taskKey(question.taskId);
      const successor = () => findQuestion(question.id)?.supersededBy;
      const notifiedCount = await deliverCommentToLatestAgent(bb, store.tasks, {
        taskId: question.taskId,
        commentId: comment.id,
        // Built at dispatch, so a replacement committed by then is named; queued text cannot change later, so never call it open again.
        body: () => [
          notice,
          ...(withdrawn ? [`The owner withdrew this answer. Do not act on the earlier answer, and undo or report anything you already did because of it (for example, move the task back if you changed its status).${successor() ? ` This check is superseded by ${successor()}: act on that question.` : ""} Before you act further, read this question's id, revision and \`supersededBy\` with \`bb work-board question list ${key}\`; when \`supersededBy\` is set, act on that successor instead.`] : []),
          ...attachments.map(a => `Attachment: ${a.fileName} (${a.sizeBytes} bytes) — \`bb work-board attachment get ${a.id} --out <path>\``),
          `Read the current saved decision with \`bb work-board question list ${key} --json\` before continuing.`,
        ].join("\n\n"),
        authorName: input.authorName,
        threadId,
        mode: "queue-if-active",
        replyHint: false,
        // A positive answer to a check superseded after it was saved is stale and dropped; a withdrawal always goes out,
        // or the thread could keep acting on the answer it already received.
        wanted: () => withdrawn || !successor(),
      });
      store.transaction(() =>
        store.tasks.updateComment(comment!.id, { notifiedCount }),
      );
      bb.realtime.publish("comments:changed", { taskId: question.taskId });
      await remind();
      return {
        ...result,
        question,
        notification: notifiedCount ? ("sent" as const) : !withdrawn && successor() ? ("none" as const) : ("failed" as const),
        ...(planWake ? { planWake } : {}),
      };
    },
    async updateQuestion(input) {
      const previous = getQuestion(input.questionId);
      const check = { ...previous, prompt: input.prompt.trim(), steps: input.steps?.map(step => step.trim()) ?? previous.steps };
      const changedContent = check.prompt !== previous.prompt || JSON.stringify(check.steps) !== JSON.stringify(previous.steps);
      const receipt = await prepareReceipt(input.reopen ? "reopen" : changedContent ? "update" : null, check, input, previous);
      let wake: Wake = null;
      const question = store.transaction(() => {
        receipt.verify?.();
        const current = getQuestion(input.questionId);
        assertQuestionCurrent(current);
        const before = openDecisionIds(db, current.taskId).length;
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
          ...option,
          id: option.id ?? createUlid(),
          label: option.label.trim(),
        }));
        const content = {
          prompt: input.prompt.trim(),
          steps: input.steps?.map((step) => step.trim()) ?? current.steps,
          ...(current.kind === "check" && input.beyondDesign ? { beyondDesign: input.beyondDesign } : {}),
          mode: input.mode,
          options,
          allowOther: true,
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
        assertQuestionShape(content.prompt, content.steps);
        // Only new or changed steps must be single sentences, so an untouched legacy step does not block an edit.
        assertStepsAtomic(content.steps, current.steps ?? []);
        assertStepsSingleAction(content.steps, current.steps ?? []);
        assertNotPlanQuestion(current.taskId, content.prompt, content.steps);
        if (current.answeredBy) assertReopenKeepsScope(current, content, taskKey(current.taskId));
        if (current.answeredBy && current.kind === "check") assertNoCheckDuringPlanDebt(current.taskId);
        const next = questionSchema.parse({
          ...current,
          ...content,
          // Whoever reopens an answered question asks it now, so the new answer goes to them.
          ...(current.answeredBy && input.askedByThread ? { askedByThread: input.askedByThread } : {}),
          selectedOptionIds: [],
          answerText: null,
          answeredBy: null,
          revision: current.revision + 1,
          updatedAt: new Date().toISOString(),
          history: [...current.history, snapshotOf(current)],
        });
        assertNoSecretsInValue(next, "question");
        receipt.record?.(next);
        recordReadiness(next, input, current);
        db.prepare<[string, string]>(
          "UPDATE task_questions SET payload = ? WHERE id = ?",
        ).run(JSON.stringify(next), next.id);
        syncDecisionLabel(next.taskId);
        wake = decisionTransition(next.taskId, before);
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
      const planWake = await announce(wake);
      return { question, ...(planWake ? { planWake } : {}), ...(receipt.warnings.length ? { warnings: receipt.warnings } : {}) };
    },
    async withdrawQuestion(input) {
      let wake: Wake = null;
      const question = store.transaction(() => {
        const current = getQuestion(input.questionId);
        if (current.taskId !== input.taskId) throw new Error("Question does not belong to this task");
        assertQuestionCurrent(current);
        if (current.revision !== input.revision) throw new Error("Question changed; reload it before withdrawing");
        if (!isQuestionOpen(current)) throw new Error("An answered question cannot be withdrawn");
        const next = questionSchema.parse({
          ...current, withdrawnAt: new Date().toISOString(), withdrawnBy: input.authorName, withdrawReason: input.reason,
        });
        assertNoSecretsInValue(next, "question");
        const before = openDecisionIds(db, current.taskId).length;
        db.prepare<[string, string]>("UPDATE task_questions SET payload = ? WHERE id = ?").run(JSON.stringify(next), next.id);
        syncDecisionLabel(next.taskId);
        wake = decisionTransition(next.taskId, before);
        store.tasks.createComment({
          taskId: next.taskId, kind: "system", authorName: input.authorName,
          body: `Question withdrawn by ${next.withdrawnBy}: ${next.prompt} — Reason: ${next.withdrawReason}`,
        });
        return next;
      });
      changed(question.taskId);
      bb.realtime.publish("comments:changed", { taskId: question.taskId });
      const planWake = await announce(wake);
      return { question, ...(planWake ? { planWake } : {}) };
    },
    async deleteQuestion(input) {
      let wake: Wake = null;
      let question!: TaskQuestion;
      const deleted = store.transaction(() => {
        question = getQuestion(input.questionId);
        assertNotWithdrawn(question);
        if (question.revision !== input.revision)
          throw new Error("Question changed; reload it before deleting");
        // A supersede chain is the record of how a check's state changed; removing one link would strand the other end.
        if (question.supersedes || question.supersededBy)
          throw new Error(`Question ${question.id} is part of a supersede chain (${[question.supersedes && `supersedes ${question.supersedes}`, question.supersededBy && `superseded by ${question.supersededBy}`].filter(Boolean).join(", ")}), so it cannot be deleted on its own. A superseded check is already closed; change the current check with \`bb work-board question update ${taskKey(question.taskId)}\` instead.`);
        const before = openDecisionIds(db, question.taskId).length;
        const result = db.prepare<[string]>("DELETE FROM task_questions WHERE id = ?")
          .run(question.id).changes > 0;
        syncDecisionLabel(question.taskId);
        wake = decisionTransition(question.taskId, before);
        return result;
      });
      changed(question.taskId);
      const planWake = await announce(wake);
      return { deleted, ...(planWake ? { planWake } : {}) };
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
  return { handlers, listQuestions, listQuestionsForProject, listTemplates, applyTemplate };
}
