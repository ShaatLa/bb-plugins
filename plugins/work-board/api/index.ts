import { createHash } from "node:crypto";
import { UNANSWERED_QUESTION } from "../db/waiting-on-owner";
import { getWorkflowPolicy, isClosedStatus } from "../shared/workflow-policy";
import { observeStatusNotifications } from "../status-notifications";
import { ordinaryTaskVisibilitySql } from "../scheduled/visibility";
import { taskAdvisories } from "../advisories";
import { idleThreshold } from "../shared/project-settings";
import { getBadgeCriteria, getBoardPreferences, getGlobalSettings, setBadgeCriteria, setBoardPreferences, setGlobalSettings } from "../global-settings";
import { activityService } from "../activity/index.js";
import { createDependencyStore } from "../dependencies/store";
import { createPlanStore, PlanError } from "../plans/store";
import { createPlanNoteStore } from "../plans/notes";
import { deliverPlanReview, reviewerProblem, wakeReviewer } from "../plans/delivery";
import { cardInWork, noticeLeftApproved } from "../plans/notice";
import { actorLabel, buildApprovalMessage, buildFeedbackMessage, buildResultCopyMessage, buildStateChangeMessage, buildReviewRequestMessage, orderNotes, type PlanNoteKind } from "../shared/plan-notes";
import { storageService } from "../storage";
import { gitSyncService } from "../git-sync/service";
import { projectConfigHandlers } from "../config";
import { attentionUiHandlers } from "../attention/rpc";
import { checksUiHandlers } from "../checks/rpc";
import { createLockHandlers } from "../locks/service";
import { DEFAULT_TASK_STATUSES, STALE_STATUSES, statusLabel, taskStatusesSchema } from "../shared/statuses.js";
import { createClosureService, type ClosureService } from "../closure/service";
import { attachManualLink, canTakeWorkerLink } from "../delegate/attach";
import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import {
  createTasksStore,
  TaskEpicError,
  type Attachment as StoredAttachment,
  type Comment as StoredComment,
  type Task as StoredTask,
  type TaskThreadLiveStatus,
  type TasksStore,
} from "../db";
import {
  AttachmentReferencedError,
  deleteAttachmentById,
  removeAttachmentBlobs,
} from "../attachments";
import { deliverCommentToLatestAgent, notifyThread } from "../steer";
import { getTaskCostSpans } from "../costs";
import { reconcileTaskThreads, threadLiveStatus } from "../lifecycle/thread-links";
import { truncateToWidth } from "../shared/text-measure";
import { discoverRunningTaskThreads } from "../lifecycle/discovery";
import { displayName } from "../shared/display-name";
import { evaluateThreadHealth } from "../shared/thread-health";
import { environmentPullRequests } from "../git-sync/environment-prs";
import { navigationBadgeCounts } from "./badge";
import { BADGE_CRITERIA, DEFAULT_BADGE_CRITERIA } from "../shared/badge";
import { errorMessage } from "../shared/errors";
import { SecretDetectedError } from "../shared/secret-guard.js";
import { createStructuredStore } from "../structured/store";
import type { Evidence, PlanAuthor, PlanNote } from "../shared/contract";
import { isSideChatShapedThread } from "../shared/side-chat";
import {
  tasksRpcContract,
  type Attachment as AttachmentMetadata,
  type ProjectsChangedEvent,
  type SidebarProjectSummary,
  type Task,
  type TaskPullRequest,
  type TaskThread,
  type TasksChangedEvent,
  type TasksDomainError,
  type CommentsChangedEvent,
  type CommentProvider,
} from "../shared/contract";

interface TaskLabelIdRow {
  task_id: string;
  label_id: string;
}

interface CountRow {
  count: number;
}

interface PrefixRow {
  found: number;
}

interface SummaryRow {
  project_id: string;
  task_count: number;
  active_agent_count: number;
}

const MAX_THREAD_SEARCH_RESULTS = 10;

export interface TasksApiStore {
  readonly tasks: TasksStore;
  /** What happens to the threads of a card after it closed (archive decisions, turn-bound intents, notices). */
  readonly closures: ClosureService;
  transaction<T>(operation: () => T): T;
  taskLabelIds(taskIds: readonly string[]): Map<string, string[]>;
  projectTaskCount(projectId: string): number;
  projectPrefixExists(prefix: string, excludingProjectId: string): boolean;
  openTaskCount(): number;
  sidebarSummary(): SidebarProjectSummary[];
}

export function createStore(bb: BbPluginApi): TasksApiStore {
  const database = bb.storage.database();
  const tasks = createTasksStore(database, (message) => bb.log.info(message));
  observeStatusNotifications(bb, tasks);
  const closures = createClosureService(bb, tasks);
  // A closure is evaluated once, after the commit that wrote it; the RPC and CLI paths ask the same evaluation.
  tasks.onClosure((closureId) => void closures.onClosed(closureId));
  // An epic the store moved automatically is published after the commit, whichever path wrote the child.
  tasks.onEpicMoved(({ epicId, projectId }) => { publishTasksChanged(bb, epicId, projectId); publishCommentsChanged(bb, epicId); });

  return {
    tasks,
    closures,
    transaction<T>(operation: () => T): T {
      return tasks.closureScope(() => database.transaction(operation)());
    },
    taskLabelIds(taskIds: readonly string[]): Map<string, string[]> {
      const labelsByTask = new Map<string, string[]>();
      for (const taskId of taskIds) labelsByTask.set(taskId, []);

      for (let offset = 0; offset < taskIds.length; offset += 500) {
        const ids = taskIds.slice(offset, offset + 500);
        if (ids.length === 0) continue;
        const placeholders = ids.map(() => "?").join(", ");
        const rows = database
          .prepare<string[], TaskLabelIdRow>(
            `
              SELECT task_id, label_id
              FROM task_labels
              WHERE task_id IN (${placeholders})
              ORDER BY task_id, label_id
            `,
          )
          .all(...ids);
        for (const row of rows)
          labelsByTask.get(row.task_id)?.push(row.label_id);
      }
      return labelsByTask;
    },
    projectTaskCount(projectId: string): number {
      return (
        database
          .prepare<
            [string],
            CountRow
          >(`SELECT COUNT(*) AS count FROM tasks t WHERE project_id = ? AND ${ordinaryTaskVisibilitySql()}`)
          .get(projectId)?.count ?? 0
      );
    },
    projectPrefixExists(prefix: string, excludingProjectId: string): boolean {
      return Boolean(
        database
          .prepare<[string, string], PrefixRow>(
            `
              SELECT 1 AS found FROM projects
              WHERE prefix = ? COLLATE NOCASE AND id <> ?
              LIMIT 1
            `,
          )
          .get(prefix, excludingProjectId),
      );
    },
    openTaskCount(): number {
      return (
        database
          .prepare<[], CountRow>(
            `
              SELECT COUNT(*) AS count
              FROM tasks
              WHERE archived_at IS NULL AND status NOT IN ('done', 'canceled') AND ${ordinaryTaskVisibilitySql('tasks')}
            `,
          )
          .get()?.count ?? 0
      );
    },
    sidebarSummary(): SidebarProjectSummary[] {
      return database
        .prepare<[], SummaryRow>(
          `
            SELECT
              p.id AS project_id,
              COUNT(DISTINCT t.id) AS task_count,
              COUNT(DISTINCT CASE
                WHEN tt.live_status IN ('starting', 'working') THEN tt.thread_id
              END) AS active_agent_count
            FROM projects p
            LEFT JOIN tasks t
              ON t.project_id = p.id AND t.archived_at IS NULL AND ${ordinaryTaskVisibilitySql()}
              AND t.parent_task_id IS NULL
            LEFT JOIN task_threads tt ON tt.task_id = t.id
            GROUP BY p.id
            ORDER BY p.name COLLATE NOCASE, p.id
          `,
        )
        .all()
        .map((row) => ({
          projectId: row.project_id,
          taskCount: row.task_count,
          activeAgentCount: row.active_agent_count,
        }));
    },
  };
}

class TasksDomainFailure extends Error {
  constructor(readonly detail: TasksDomainError) {
    super(detail.message);
    this.name = "TasksDomainFailure";
  }
}

function fail(code: TasksDomainError["code"], message: string): never {
  throw new TasksDomainFailure({ code, message });
}

function taskFailure(error: TasksDomainFailure) {
  return { ok: false as const, error: error.detail };
}

export function publishTasksChanged(
  bb: BbPluginApi,
  taskId: string,
  projectId: string,
): void {
  const payload: TasksChangedEvent = { taskId, projectId };
  bb.realtime.publish("tasks:changed", payload);
  if (bb.storage.database().prepare("SELECT 1 FROM task_scheduled_sources WHERE task_id=?").get(taskId))
    bb.realtime.publish("schedules:changed", { projectId });
  // A predecessor's status/key changes must refresh its neighbours without board-wide polling.
  const neighbours = bb.storage.database().prepare<[string, string, string], { taskId: string; projectId: string }>(`
    SELECT DISTINCT t.id AS taskId, t.project_id AS projectId FROM task_dependencies d JOIN tasks t
      ON t.id=CASE WHEN d.task_id=? THEN d.blocking_task_id ELSE d.task_id END
    WHERE d.task_id=? OR d.blocking_task_id=?
  `).all(taskId, taskId, taskId);
  for (const neighbour of neighbours) bb.realtime.publish("tasks:changed", neighbour);
  // Subtask lists on a parent's or epic's page listen for that parent, since a new child's ID is unknown there.
  const family = bb.storage.database().prepare<[string], { parent: string | null; epic: string | null }>(
    "SELECT parent_task_id AS parent, epic_id AS epic FROM tasks WHERE id=?",
  ).get(taskId);
  for (const id of new Set([family?.parent, family?.epic])) if (id) bb.realtime.publish("tasks:changed", { taskId: id, projectId });
}

export function publishProjectsChanged(
  bb: BbPluginApi,
  projectId: string | null,
): void {
  const payload: ProjectsChangedEvent = { projectId };
  bb.realtime.publish("projects:changed", payload);
}

/** Background status changes (a check tick, a manager re-read): only the settings views read these, so the board is not reloaded. */
export function publishSettingsChanged(bb: BbPluginApi, projectId: string): void {
  const payload: ProjectsChangedEvent = { projectId };
  bb.realtime.publish("settings:changed", payload);
}

export function publishCommentsChanged(bb: BbPluginApi, taskId: string): void {
  const payload: CommentsChangedEvent = { taskId };
  bb.realtime.publish("comments:changed", payload);
}

function apiTask(store: TasksApiStore, task: StoredTask): Task {
  return {
    ...task,
    labelIds: store.taskLabelIds([task.id]).get(task.id) ?? [],
  };
}

function apiTasks(store: TasksApiStore, tasks: StoredTask[]): Task[] {
  const labelsByTask = store.taskLabelIds(tasks.map((task) => task.id));
  return tasks.map((task) => ({
    ...task,
    labelIds: labelsByTask.get(task.id) ?? [],
  }));
}

function validateTaskParent(
  store: TasksApiStore,
  projectId: string,
  parentTaskId: string | null,
  ownTaskId?: string,
): void {
  if (parentTaskId === null) return;
  if (parentTaskId === ownTaskId) {
    fail("task_parent_invalid", "A task cannot be its own parent");
  }

  const parent = store.tasks.getTask(parentTaskId);
  if (!parent) throw new Error(`Task not found: ${parentTaskId}`);
  if (parent.projectId !== projectId) {
    fail(
      "subtask_project_mismatch",
      "A sub-task must belong to the same project as its parent",
    );
  }
  if (parent.type === "epic") {
    fail("task_epic_invalid", "Use the epic field to add a task to an epic");
  }
  if (parent.parentTaskId !== null) {
    fail(
      "subtask_depth_exceeded",
      "Tasks support at most one level of sub-tasks",
    );
  }
  if (ownTaskId && store.tasks.listSubtasks(ownTaskId).length > 0) {
    fail(
      "subtask_depth_exceeded",
      "A task with sub-tasks cannot itself become a sub-task",
    );
  }
}

function validateTaskLabels(
  store: TasksApiStore,
  projectId: string,
  labelIds: readonly string[],
): void {
  for (const labelId of labelIds) {
    const label = store.tasks.getLabel(labelId);
    if (!label || label.projectId !== projectId) {
      fail(
        "label_project_mismatch",
        `Task labels must belong to the task project: ${labelId}`,
      );
    }
  }
}

function replaceTaskLabels(
  store: TasksApiStore,
  taskId: string,
  labelIds: readonly string[],
): void {
  const current = new Set(
    store.tasks.listTaskLabels(taskId).map((link) => link.labelId),
  );
  const next = new Set(labelIds);
  for (const labelId of current) {
    if (!next.has(labelId)) store.tasks.removeTaskLabel(taskId, labelId);
  }
  for (const labelId of next) {
    if (!current.has(labelId)) store.tasks.addTaskLabel(taskId, labelId);
  }
}

function labelsChanged(
  before: readonly string[],
  after: readonly string[],
): boolean {
  if (before.length !== after.length) return true;
  const afterSet = new Set(after);
  return before.some((labelId) => !afterSet.has(labelId));
}

function labelChangeBody(
  store: TasksApiStore,
  taskId: string,
  authorName: string,
): string {
  const names = store.tasks
    .listLabelsForTask(taskId)
    .map((label) => label.name)
    .sort((left, right) => left.localeCompare(right));
  return names.length === 0
    ? `Labels cleared by ${authorName}`
    : `Labels changed to ${names.join(", ")} by ${authorName}`;
}

/** An agent may not close a card while a question to the owner is open; the owner and automatic moves are not checked. */
function assertNoOpenOwnerQuestions(
  bb: BbPluginApi,
  store: TasksApiStore,
  task: StoredTask,
  targetStatus: string | undefined,
  agentThreadId: string | null | undefined,
): void {
  const project = store.tasks.getProject(task.projectId);
  if (!agentThreadId || !targetStatus || !project || !isClosedStatus(project, targetStatus) || isClosedStatus(project, task.status)) return;
  const open = bb.storage.database().prepare<[string], { payload: string }>(
    `SELECT q.payload FROM task_questions q WHERE q.task_id = ? AND ${UNANSWERED_QUESTION} ORDER BY q.id`,
  ).all(task.id).map((row) => JSON.parse(row.payload) as { id: string; revision: number; kind?: string; prompt: string; supersedes?: string });
  if (!open.length) return;
  const list = open.map((q) => `${q.id} rev ${q.revision} (${q.kind ?? "decision"}) "${q.prompt.length > 60 ? `${q.prompt.slice(0, 60)}…` : q.prompt}"`).join("; ");
  // An open question that replaced a check is part of a supersede chain, which cannot be deleted.
  const deletable = open.filter((q) => !q.supersedes);
  const linked = open.filter((q) => q.supersedes);
  throw new Error(
    `${task.key} cannot move to ${statusLabel(targetStatus, project.statuses)}: ${open.length} owner question${open.length > 1 ? "s are" : " is"} still open: ${list}. ` +
    `Wait for the answers${deletable.length ? `, or withdraw a question that is no longer needed (${deletable.map((q) => `\`bb work-board question delete ${task.key} --question ${q.id} --revision ${q.revision}\``).join("; ")})` : ""}, then move the card.` +
    (linked.length ? ` ${linked.map((q) => q.id).join(", ")} replace${linked.length > 1 ? "" : "s"} an earlier check and cannot be deleted: wait for the owner's answer.` : ""),
  );
}

function writeSystemComments(
  store: TasksApiStore,
  taskId: string,
  authorName: string,
  bodies: readonly string[],
): void {
  for (const body of bodies) {
    store.tasks.createComment({
      taskId,
      kind: "system",
      authorName,
      body,
    });
  }
}

function attachmentMetadata(attachment: StoredAttachment): AttachmentMetadata {
  return {
    id: attachment.id,
    taskId: attachment.taskId,
    commentId: attachment.commentId,
    fileName: attachment.fileName,
    mime: attachment.mime,
    sizeBytes: attachment.sizeBytes,
    isImage: attachment.isImage,
    createdAt: attachment.createdAt,
  };
}

function attachmentsForTasks(
  store: TasksStore,
  taskIds: readonly string[],
): StoredAttachment[] {
  return taskIds.flatMap((taskId) => [
    ...store.listAttachmentsForTask(taskId),
    ...store
      .listComments(taskId)
      .flatMap((comment) => store.listAttachmentsForComment(comment.id)),
  ]);
}

interface AgentThreadInfo {
  title: string | null;
  providerId: string;
}

function sdkErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

const THREAD_LIST_CHUNK = 200; // SDK `threads.list` limit
const THREAD_GET_CONCURRENCY = 5;

/** Distinct worker threads of agent comments; system comments may reuse a thread id but never show its metadata. */
function agentThreadIds(comments: readonly StoredComment[]): Set<string> {
  const ids = new Set<string>();
  for (const comment of comments) {
    if (comment.kind === "agent" && comment.threadId !== null) ids.add(comment.threadId);
  }
  return ids;
}

type SdkThreadRow = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;

function agentThreadInfo(
  thread: Pick<SdkThreadRow, "title" | "titleFallback" | "providerId" | "originKind" | "originPluginId" | "visibility">,
): AgentThreadInfo {
  const title = isSideChatShapedThread(thread)
    ? undefined
    : [thread.title, thread.titleFallback].find(
        (candidate) => candidate !== null && candidate.trim() !== "",
      );
  return { title: title ?? null, providerId: thread.providerId };
}

/**
 * Titles and providers of worker threads, same reach as one `threads.get` per id: a batched `list` (active, then
 * archived; `list` omits deleted and unknown ids), then `get` for every id still missing, a few at a time. A
 * not-found `get` is an authoritative absence; any other failure leaves the result `complete: false` so it is retried.
 */
async function resolveAgentThreadInfo(
  bb: BbPluginApi,
  threadIds: Iterable<string>,
): Promise<{ infos: Map<string, AgentThreadInfo>; complete: boolean }> {
  const infos = new Map<string, AgentThreadInfo>();
  let pending = [...threadIds];
  // A failed batched list makes the result incomplete even when the per-id reads recover every id: it is retried.
  let complete = true;
  for (const archived of [false, true]) {
    if (pending.length === 0) break;
    for (let offset = 0; offset < pending.length; offset += THREAD_LIST_CHUNK) {
      const chunk = pending.slice(offset, offset + THREAD_LIST_CHUNK);
      try {
        const rows = await bb.sdk.threads.list({
          threadIds: chunk,
          limit: chunk.length,
          includeHidden: true,
          ...(archived ? { archived: true } : {}),
        });
        for (const row of rows) infos.set(row.id, agentThreadInfo(row));
      } catch {
        complete = false; // the ids stay pending and fall through to the per-id read below
      }
    }
    pending = pending.filter((id) => !infos.has(id));
  }
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(THREAD_GET_CONCURRENCY, pending.length) }, async () => {
      while (next < pending.length) {
        const threadId = pending[next++]!;
        try {
          infos.set(threadId, agentThreadInfo(await bb.sdk.threads.get({ threadId })));
        } catch (error) {
          if (sdkErrorCode(error) !== "thread_not_found") complete = false;
        }
      }
    }),
  );
  return { infos, complete };
}

async function resolveProviderBadges(
  bb: BbPluginApi,
  threadInfo: ReadonlyMap<string, AgentThreadInfo>,
): Promise<{ badges: Map<string, CommentProvider>; complete: boolean }> {
  const providerIds = new Set(
    [...threadInfo.values()].map((info) => info.providerId),
  );
  const badges = new Map<string, CommentProvider>();
  if (providerIds.size === 0) return { badges, complete: true };
  let providers: Awaited<ReturnType<typeof bb.sdk.providers.list>>;
  try {
    providers = await bb.sdk.providers.list();
  } catch {
    return { badges, complete: false };
  }
  for (const provider of providers) {
    if (providerIds.has(provider.id)) {
      badges.set(provider.id, {
        id: provider.id,
        name: provider.displayName,
        logoUrl: provider.logoUrl,
        icon: provider.icon ?? null,
        strings: { iconTint: provider.strings?.iconTint ?? null },
      });
    }
  }
  return { badges, complete: true };
}

/** Title and provider badge per thread id; a provider missing from the catalog falls back to its id. */
async function resolveCommentThreads(
  bb: BbPluginApi,
  threadIds: Iterable<string>,
): Promise<{
  byThread: Map<string, { threadTitle: string | null; provider: CommentProvider }>;
  complete: boolean;
}> {
  const { infos, complete: threadsComplete } = await resolveAgentThreadInfo(bb, threadIds);
  const { badges, complete: providersComplete } = await resolveProviderBadges(bb, infos);
  const byThread = new Map<string, { threadTitle: string | null; provider: CommentProvider }>();
  for (const [threadId, info] of infos) {
    byThread.set(threadId, {
      threadTitle: info.title,
      provider: badges.get(info.providerId) ?? {
        id: info.providerId,
        name: info.providerId,
        logoUrl: null,
        icon: null,
        strings: { iconTint: null },
      },
    });
  }
  return { byThread, complete: threadsComplete && providersComplete };
}

function commentsRevisionPart(bb: BbPluginApi, taskId: string): string {
  const row = bb.storage
    .database()
    .prepare<[string], { n: number; last: string | null; notified: number | null }>(
      "/* comments revision */ SELECT COUNT(*) AS n, MAX(id) AS last, SUM(notified_count) AS notified FROM comments WHERE task_id = ?",
    )
    .get(taskId)!;
  return `${row.n}:${row.last ?? ""}:${row.notified ?? 0}`;
}

/** Count plus a digest of the whole ordered id set: a replaced non-maximum attachment still changes the token. */
function attachmentsRevisionPart(bb: BbPluginApi, taskId: string): string {
  const ids = bb.storage
    .database()
    .prepare<[string], { id: string }>(
      "/* attachments revision */ SELECT id FROM attachments WHERE comment_id IN (SELECT id FROM comments WHERE task_id = ?) ORDER BY id",
    )
    .all(taskId);
  const digest = createHash("sha1");
  for (const { id } of ids) digest.update(id).update("\n");
  return `${ids.length}:${digest.digest("hex")}`;
}

interface CreateCommentInput {
  evidence?: Evidence;
  recordedByThread?: string | null;
  taskId: string;
  kind: StoredComment["kind"];
  authorName: string;
  presetName: string | null;
  threadId: string | null;
  body: string;
  notify: boolean;
  awaitDelivery: boolean;
}

/** Agent reports beyond this belong in an attachment; long comment logs bloat every task read and Git snapshot. */
export const MAX_AGENT_COMMENT_BYTES = 8 * 1024;

export async function createComment(
  bb: BbPluginApi,
  store: TasksApiStore,
  input: CreateCommentInput,
): Promise<StoredComment> {
  const size = Buffer.byteLength(input.body, "utf8");
  if (input.kind === "agent" && size > MAX_AGENT_COMMENT_BYTES)
    throw new Error(
      `Agent comments are limited to ${MAX_AGENT_COMMENT_BYTES / 1024} KB; this one is ${(size / 1024).toFixed(1)} KB. ` +
        "Attach the full report with `bb work-board attachment add KEY --file report.md` and comment a short summary that points to it.",
    );
  const comment = store.transaction(() =>
    store.tasks.createComment({
      taskId: input.taskId,
      kind: input.kind,
      authorName: input.authorName,
      presetName: input.presetName,
      threadId: input.threadId,
      body: input.body,
      ...(input.evidence ? { evidence: { ...input.evidence, recordedByThread: input.recordedByThread ?? input.threadId } } : {}),
    }),
  );

  publishCommentsChanged(bb, input.taskId);
  if (!input.notify) return comment;

  const deliver = async (): Promise<StoredComment> => {
    const notifiedCount = await deliverCommentToLatestAgent(bb, store.tasks, {
      taskId: comment.taskId,
      commentId: comment.id,
      body: comment.body,
      authorName: comment.authorName,
    });
    const updated = store.transaction(() =>
      store.tasks.updateComment(comment.id, { notifiedCount }),
    );
    publishCommentsChanged(bb, input.taskId);
    return updated;
  };

  if (input.awaitDelivery) return deliver();
  void deliver().catch((error) => {
    bb.log.warn(
      `failed to update comment notification ${comment.id}: ${errorMessage(error)}`,
    );
  });
  return comment;
}

export const REPORT_KINDS = ["ready", "question", "blocker"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export const REPORT_NEED_HINT = 'Progress that asks nothing goes to bb work-board update KEY --progress "<text>", which wakes nobody.';

/** A question or blocker must say what the recipient has to decide or do; ready needs nothing. */
export function reportNeed(kind: ReportKind, need: string | undefined): string | null {
  const text = need?.trim() ?? "";
  if (kind !== "ready" && !text) throw new Error(`A ${kind} report needs --need "<what the recipient must decide or do>"`);
  // A dash alone is a placeholder; "- Decide X" is a bullet that still asks for something.
  if (kind !== "ready" && /^(?:nothing|none|no action|n\/a)(?![a-z])|^-+(?!\s*\w)/i.test(text))
    throw new Error(`A ${kind} report's --need must ask the recipient to decide or do something, not "${text.slice(0, 40)}"`);
  return text || null;
}

export const REPORT_WAIT_MINUTES = 30;
export const REPORT_WAIT_HINT = 'Your parent already sees that wait on the card; post progress with bb work-board update KEY --progress "<text>", which wakes nobody.';

/** The calling thread's own open owner question on the card, asked within the last 30 minutes. */
export function recentOwnQuestion(bb: BbPluginApi, taskId: string, threadId: string): { id: string } | null {
  const since = new Date(Date.now() - REPORT_WAIT_MINUTES * 60_000).toISOString();
  return bb.storage.database().prepare<[string, string, string], { id: string }>(
    `SELECT q.id FROM task_questions q WHERE q.task_id = ? AND json_extract(q.payload, '$.askedByThread') = ?
      AND json_extract(q.payload, '$.createdAt') >= ? AND ${UNANSWERED_QUESTION} LIMIT 1`,
  ).get(taskId, threadId, since) ?? null;
}

export function ownQuestionRefusal(kind: ReportKind, taskKey: string): string {
  return `A ${kind} report on ${taskKey} is refused while your own owner question there, asked in the last ${REPORT_WAIT_MINUTES} minutes, is open`;
}

/** How a calling thread stands on a card: its own session, or a helper whose parent already holds the card. */
export async function cardRole(bb: BbPluginApi, store: TasksApiStore, taskId: string, threadId: string) {
  const thread = await bb.sdk.threads.get({ threadId });
  // The parent fallback link only marks a card nobody works on; it makes no one a helper. One predicate, shared with the attach path.
  const sessions = store.tasks.closures.holders(taskId);
  const parentThreadId = thread.parentThreadId ?? null;
  return { parentThreadId, attached: sessions.includes(threadId), helper: parentThreadId !== null && sessions.includes(parentThreadId) };
}

const STATE_LIMIT = 4096;
function fitState(text: string, overflow: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= STATE_LIMIT) return text;
  const kept = new TextDecoder().decode(bytes.subarray(0, STATE_LIMIT - Buffer.byteLength(overflow, "utf8"))).replace(/\uFFFD$/, "");
  return kept + overflow;
}

/**
 * A child thread's report on its card wakes the child's own parent thread and
 * stays out of the card log. The card's own session also replaces Current
 * state with it; a helper's report leaves the state to the session it helps.
 */
export async function reportToParent(
  bb: BbPluginApi,
  store: TasksApiStore,
  input: { taskId: string; threadId: string; kind: ReportKind; body: string; need?: string },
): Promise<{ parentThreadId: string; notified: boolean; stateUpdated: boolean }> {
  const need = reportNeed(input.kind, input.need);
  const body = need ? `Needed: ${need}\n\n${input.body}` : input.body;
  if (input.kind !== "ready" && recentOwnQuestion(bb, input.taskId, input.threadId))
    throw new Error(ownQuestionRefusal(input.kind, store.tasks.getTask(input.taskId)!.key));
  const role = await cardRole(bb, store, input.taskId, input.threadId);
  const parentThreadId = role.parentThreadId;
  if (!parentThreadId) throw new Error(`Thread ${input.threadId} has no parent thread to report to`);
  const parent = await bb.sdk.threads.get({ threadId: parentThreadId });
  if (parent.archivedAt != null || parent.deletedAt != null)
    throw new Error(`Parent thread ${parentThreadId} is archived or deleted`);
  const label = input.kind.toUpperCase();
  const task = store.tasks.getTask(input.taskId)!;
  const stateUpdated = !role.helper;
  if (stateUpdated) {
    // A "Handoff:" line points a compacted or successor session at its notes; a report must not drop it.
    const handoff = (task.progressNote ?? "").split("\n").filter((line) => line.startsWith("Handoff:"));
    const progressNote = fitState([...handoff, `**${label}**\n\n${body}`].join("\n\n"), `\n\n… (cut; the full report went to @thread:${parentThreadId})`);
    store.transaction(() => store.tasks.updateTask(task.id, { progressNote, authorName: input.threadId }));
    publishTasksChanged(bb, task.id, task.projectId);
  }
  let notified = false;
  try {
    await notifyThread(
      bb,
      parentThreadId,
      `**${task.key} · ${label}** from @thread:${input.threadId}\n\n${body}\n\n[Open ${task.key}](/plugins/work-board/work-board/task/${task.key})`,
    );
    notified = true;
  } catch (error) {
    bb.log.warn(`failed to deliver ${label} report on ${task.key} to ${parentThreadId}: ${errorMessage(error)}`);
  }
  return { parentThreadId, notified, stateUpdated };
}

// shortcut: one page of 200 children, page with offset if a parent ever has more.
const MAX_CHILDREN = 200;

/** A parent's open child threads with the cards each one is linked to and their state notes. */
export async function childrenCards(bb: BbPluginApi, store: TasksApiStore, parentThreadId: string, includeFinished = false) {
  const threads = await bb.sdk.threads.list({ parentThreadId, limit: MAX_CHILDREN });
  const children = threads
    .filter((thread) => thread.archivedAt == null)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((thread) => {
      const cards = store.tasks
        .listTaskThreadsByThreadId(thread.id)
        .filter((link) => link.presetName !== "Parent thread")
        .flatMap((link) => {
          const task = store.tasks.getTask(link.taskId);
          return task && !task.archivedAt
            ? [{ key: task.key, title: task.title, status: task.status, progressNote: task.progressNote, progressUpdatedAt: task.progressUpdatedAt }]
            : [];
        });
      const shown = includeFinished ? cards : cards.filter((card) => !["done", "canceled"].includes(card.status));
      return {
        threadId: thread.id,
        title: thread.title ?? thread.titleFallback ?? null,
        status: thread.status,
        cards: shown,
        hiddenFinishedCards: cards.length - shown.length,
      };
    });
  return { parentThreadId, children, truncated: threads.length >= MAX_CHILDREN };
}

interface TaskPullRequestsResult {
  pullRequests: TaskPullRequest[];
  unavailableThreadIds: string[];
}

async function listTaskPullRequests(
  bb: BbPluginApi,
  store: TasksApiStore,
  taskId: string,
): Promise<TaskPullRequestsResult> {
  const taskThreads = store.tasks.listTaskThreads(taskId);

  const unavailable = new Set<string>();
  const threadIdsByEnvironment = new Map<string, string[]>();
  await Promise.all(
    taskThreads.map(async (taskThread) => {
      try {
        const thread = await bb.sdk.threads.get({
          threadId: taskThread.threadId,
        });
        if (!thread.environmentId) return;
        const group = threadIdsByEnvironment.get(thread.environmentId) ?? [];
        group.push(taskThread.threadId);
        threadIdsByEnvironment.set(thread.environmentId, group);
      } catch {
        unavailable.add(taskThread.threadId);
      }
    }),
  );

  const byUrl = new Map<string, TaskPullRequest>();
  const lookups = await environmentPullRequests(bb, threadIdsByEnvironment.keys());
  for (const [environmentId, threadIds] of threadIdsByEnvironment) {
    const result = lookups.get(environmentId)!;
    if (result.outcome === "unavailable") {
      for (const threadId of threadIds) unavailable.add(threadId);
      continue;
    }
    if (result.outcome === "absent") continue;
    const { pullRequest } = result;
    const existing = byUrl.get(pullRequest.url);
    if (!existing) {
      byUrl.set(pullRequest.url, {
        url: pullRequest.url,
        number: pullRequest.number,
        title: pullRequest.title,
        state: pullRequest.state,
        updatedAt: pullRequest.updatedAt,
        threadIds: [...threadIds],
      });
      continue;
    }
    const threadIdUnion = [...existing.threadIds, ...threadIds];
    if (pullRequest.updatedAt.localeCompare(existing.updatedAt) > 0) {
      byUrl.set(pullRequest.url, {
        url: pullRequest.url,
        number: pullRequest.number,
        title: pullRequest.title,
        state: pullRequest.state,
        updatedAt: pullRequest.updatedAt,
        threadIds: threadIdUnion,
      });
    } else {
      existing.threadIds = threadIdUnion;
    }
  }

  const threadOrder = new Map(
    taskThreads.map((taskThread, index) => [taskThread.threadId, index]),
  );
  const orderByThread = (threadId: string) =>
    threadOrder.get(threadId) ?? Number.MAX_SAFE_INTEGER;
  const pullRequests = [...byUrl.values()].map((pullRequest) => ({
    ...pullRequest,
    threadIds: [...pullRequest.threadIds].sort(
      (left, right) => orderByThread(left) - orderByThread(right),
    ),
  }));

  return {
    pullRequests: pullRequests.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    ),
    unavailableThreadIds: [...unavailable].sort(
      (left, right) => orderByThread(left) - orderByThread(right),
    ),
  };
}


/** Runs a note write; refusals come back as results, and a success refreshes the task feeds. */
function runNoteWrite<T extends { taskId: string }>(bb: BbPluginApi, store: TasksApiStore, write: () => T, options: { comments?: boolean } = {}) {
  try {
    const result = store.transaction(write);
    const task = store.tasks.getTask(result.taskId)!;
    publishTasksChanged(bb, task.id, task.projectId);
    if (options.comments) publishCommentsChanged(bb, task.id);
    return { ok: true as const, result };
  } catch (error) {
    if (error instanceof PlanError) return { ok: false as const, error: { code: error.code, message: error.message } };
    if (error instanceof SecretDetectedError) return { ok: false as const, error: { code: "secret_detected" as const, message: error.message } };
    throw error;
  }
}

/**
 * Plan decisions: feedback and approval by the owner (RPC) or by the assigned reviewer thread (CLI only; `version` is
 * then the version the reviewer read), with the message to the session that waits on the review. Reviewer-only writes
 * (notes, dismiss, resolve, reopen) live here too and are not RPCs, so no caller-supplied author can act as a reviewer.
 */
export function createPlanReviewFlow(bb: BbPluginApi, store: TasksApiStore) {
  const plans = createPlanStore(bb.storage.database(), store.tasks);
  const notes = createPlanNoteStore(bb.storage.database(), store.tasks, plans.head);
  const noteResult = (taskId: string, write: () => PlanNote) => {
    const outcome = runNoteWrite(bb, store, () => ({ taskId, note: write() }));
    return outcome.ok ? { ok: true as const, note: outcome.result.note } : outcome;
  };
  return {
    sendFeedback: async (taskId: string, by: PlanAuthor, reviewerVersion?: number) => {
      const before = plans.head(taskId)?.state;
      const outcome = runNoteWrite(bb, store, () => ({ taskId, ...notes.sendFeedback(taskId, by, reviewerVersion) }), { comments: true });
      if (!outcome.ok) return outcome;
      const { plan, version, body, taskKey, notes: sent, reviewer } = outcome.result;
      // Eligibility for the executor notice is read at the commit, before the delivery below can take any time.
      const inWork = before === "approved" && cardInWork(store.tasks, taskId);
      // The feedback is saved above; delivery only wakes the author, and its failure is reported, not undone.
      const text = buildFeedbackMessage({ taskKey, version, notes: orderNotes(sent, body), by: reviewerVersion === undefined ? "the owner" : actorLabel(by), reviewer });
      const recipients = plans.resultRecipients(taskId, version);
      const delivery = await deliverPlanReview(bb, {
        taskId,
        recipients,
        text,
        copyText: (actor) => buildResultCopyMessage({ taskKey, headline: text.split("\n")[0]!, actor }),
      });
      if (before === "approved")
        await noticeLeftApproved(bb, store.tasks, { taskId, version, state: plan.state, reason: "changes were requested", changedBy: by.threadId, inWork, exclude: [...Object.values(recipients), ...delivery.deliveries.map((entry) => entry.threadId)] });
      return { ok: true as const, plan, ...delivery, notes: sent.length };
    },
    approve: async (taskId: string, by: PlanAuthor, text?: string, reviewerVersion?: number) => {
      const outcome = runNoteWrite(bb, store, () => ({ taskId, ...notes.approve(taskId, by, text, reviewerVersion) }), { comments: true });
      if (!outcome.ok) return outcome;
      const { plan, version, taskKey, note: given } = outcome.result;
      const message = buildApprovalMessage({ taskKey, version, by: reviewerVersion === undefined ? "the owner" : actorLabel(by), note: given });
      const delivery = await deliverPlanReview(bb, {
        taskId,
        recipients: plans.resultRecipients(taskId, version),
        text: message,
        copyText: (actor) => buildResultCopyMessage({ taskKey, headline: message.split("\n")[0]!, actor }),
      });
      return { ok: true as const, plan, ...delivery, notes: 0 };
    },
    addNote: (input: { taskId: string; by: PlanAuthor; version: number; kind?: PlanNoteKind; body: string; quote?: string; section?: string }) =>
      noteResult(input.taskId, () => notes.createByReviewer(input)),
    dismiss: (taskId: string, by: PlanAuthor, version: number, numbers: readonly number[]) => {
      const outcome = runNoteWrite(bb, store, () => notes.dismissByReviewer(taskId, by, version, numbers));
      return outcome.ok ? { ok: true as const, removed: outcome.result.removed } : outcome;
    },
    setState: (taskId: string, by: PlanAuthor, version: number, numbers: readonly number[], state: "resolved" | "draft") => {
      const outcome = runNoteWrite(bb, store, () => ({ taskId, notes: notes.setStateByReviewer(taskId, by, version, numbers, state) }));
      return outcome.ok ? { ok: true as const, notes: outcome.result.notes } : outcome;
    },
  };
}

export function registerHandlers(
  bb: BbPluginApi,
  store: TasksApiStore,
): PluginRpcHandlers<typeof tasksRpcContract> {
  const structured = createStructuredStore(bb, store);
  const dependencies = createDependencyStore(bb.storage.database(), store.tasks);
  const plans = createPlanStore(bb.storage.database(), store.tasks);
  // Plan writes report refusals as results; every success logs a system comment, so both feeds refresh.
  function planWrite<T extends { plan: { taskId: string } }>(write: () => T) {
    try {
      const result = store.transaction(write);
      const task = store.tasks.getTask(result.plan.taskId)!;
      publishTasksChanged(bb, task.id, task.projectId);
      publishCommentsChanged(bb, task.id);
      return { ok: true as const, ...result };
    } catch (error) {
      if (error instanceof PlanError) return { ok: false as const, error: { code: error.code, message: error.message } };
      if (error instanceof SecretDetectedError) return { ok: false as const, error: { code: "secret_detected" as const, message: error.message } };
      throw error;
    }
  }
  const planNotes = createPlanNoteStore(bb.storage.database(), store.tasks, plans.head);
  const review = createPlanReviewFlow(bb, store);
  /** Runs a note write; refusals come back as results, and a success refreshes the task feeds. */
  const noteWrite = <T extends { taskId: string }>(write: () => T, options: { comments?: boolean } = {}) => runNoteWrite(bb, store, write, options);
  const noteResult = (write: () => PlanNote) => {
    const outcome = noteWrite(write);
    return outcome.ok ? { ok: true as const, note: outcome.result } : outcome;
  };
  function changeDependency(input: { taskId: string; blockingTaskId: string; authorName: string }, add: boolean) {
    const changed = store.transaction(() => {
      const changed = add ? dependencies.add(input.taskId, input.blockingTaskId) : dependencies.remove(input.taskId, input.blockingTaskId);
      if (changed) {
        const task = store.tasks.getTask(input.taskId)!, blocker = store.tasks.getTask(input.blockingTaskId)!;
        writeSystemComments(store, task.id, input.authorName, [`${add ? "Dependency added" : "Dependency removed"}: blocked by ${blocker.key} (until Done) by ${input.authorName}`]);
        writeSystemComments(store, blocker.id, input.authorName, [`${add ? "Dependency added" : "Dependency removed"}: blocks ${task.key} (until Done) by ${input.authorName}`]);
      }
      return changed;
    });
    if (changed) for (const id of [input.taskId, input.blockingTaskId]) {
      publishTasksChanged(bb, id, store.tasks.getTask(id)!.projectId);
      publishCommentsChanged(bb, id);
    }
    return { changed };
  }
  function changeRelation(input: { taskId: string; relatedTaskId: string; authorName: string }, add: boolean) {
    const changed = store.transaction(() => {
      const changed = add ? dependencies.relate(input.taskId, input.relatedTaskId) : dependencies.unrelate(input.taskId, input.relatedTaskId);
      if (changed) {
        const task = store.tasks.getTask(input.taskId)!, other = store.tasks.getTask(input.relatedTaskId)!;
        writeSystemComments(store, task.id, input.authorName, [`${add ? "Related task added" : "Related task removed"}: ${other.key} by ${input.authorName}`]);
        writeSystemComments(store, other.id, input.authorName, [`${add ? "Related task added" : "Related task removed"}: ${task.key} by ${input.authorName}`]);
      }
      return changed;
    });
    if (changed) for (const id of [input.taskId, input.relatedTaskId]) {
      publishTasksChanged(bb, id, store.tasks.getTask(id)!.projectId);
      publishCommentsChanged(bb, id);
    }
    return { changed };
  }
  return {
    getTaskPlan: ({ taskId, version }) => {
      const plan = plans.get(taskId, version);
      return { plan: plan && { ...plan, noteCounts: planNotes.counts(taskId) } };
    },
    listTaskPlanVersions: ({ taskId }) => ({ ...plans.listVersions(taskId), noteCounts: planNotes.counts(taskId), paused: plans.paused(taskId) }),
    listPlanNotes: ({ taskId }) => ({ notes: planNotes.list(taskId) }),
    createPlanNote: (input) => noteResult(() => planNotes.create(input as Parameters<typeof planNotes.create>[0])),
    updatePlanNote: ({ noteId, body }) => noteResult(() => planNotes.update(noteId, body)),
    deletePlanNote: ({ noteId }) => {
      const outcome = noteWrite(() => ({ taskId: planNotes.remove(noteId) }));
      return outcome.ok ? { ok: true as const } : outcome;
    },
    setPlanNoteState: ({ noteId, state }) => noteResult(() => planNotes.setState(noteId, state)),
    replyPlanNote: (input) => noteResult(() => planNotes.reply(input)),
    // The owner's decisions: an `author` passed here names the actor in the log but never acts as a reviewer.
    sendPlanFeedback: ({ taskId, author }) => review.sendFeedback(taskId, author),
    approvePlan: ({ taskId, author, note }) => review.approve(taskId, author, note),
    listPlanReviews: ({ taskId }) => ({ reviews: plans.listReviews(taskId), paused: plans.paused(taskId) }),
    diffTaskPlan: ({ taskId, from, to }) => plans.diff(taskId, from, to),
    saveTaskPlan: async (input) => {
      const before = plans.head(input.taskId)?.state;
      const result = planWrite(() => plans.save(input));
      if (result.ok && before === "approved")
        await noticeLeftApproved(bb, store.tasks, { taskId: input.taskId, version: result.plan.version, state: result.plan.state, reason: "a new version was saved", changedBy: input.author.threadId });
      return result;
    },
    submitTaskPlan: async ({ taskId, author, reviewer, dedicatedReviewer }) => {
      const task = store.tasks.getTask(taskId);
      // Without a reviewer a revised plan goes back to the reviewer of the latest attempt.
      let latest;
      try {
        latest = plans.listReviews(taskId).at(-1)?.reviewer;
      } catch (error) {
        if (error instanceof PlanError) return { ok: false as const, error: { code: error.code, message: error.message } };
        throw error;
      }
      const chosen = reviewer ?? (latest ? (latest.kind === "owner" ? "owner" : latest.threadId) : undefined);
      if (!chosen) return { ok: false as const, error: { code: "plan_invalid" as const, message: "This plan was never submitted with a reviewer: pass --reviewer owner (only when the user asked to approve the plan) or --reviewer <thread id>" } };
      const thread = chosen === "owner" ? null : chosen;
      const problem = thread ? await reviewerProblem(bb, thread, task?.key ?? taskId) : null;
      const result = planWrite(() => plans.submit(taskId, author, thread, problem, reviewer === undefined ? (latest ?? null) : null, dedicatedReviewer === true));
      if (!result.ok) return result;
      if (!thread) return { ...result, delivered: null, deliveryHint: null };
      const text = buildReviewRequestMessage({
        taskKey: task!.key,
        version: result.plan.version,
        decidedVersion: plans.lastDecidedVersion(taskId, thread),
        blockingNotes: planNotes.blockingCount(taskId),
      });
      const wake = await wakeReviewer(bb, { taskId, taskKey: task!.key, threadId: thread, text });
      return { ...result, delivered: wake.delivered, deliveryHint: wake.hint };
    },
    setTaskPlanState: async ({ taskId, state, author }) => {
      const before = plans.head(taskId)?.state;
      const result = planWrite(() => plans.setState(taskId, state, author));
      if (!result.ok) return result;
      // A repeated state changed nothing and sends nothing. An approval or a request for changes reaches the waiting
      // author like the dedicated owner commands do, and the outcome is returned.
      const inWork = before === "approved" && cardInWork(store.tasks, taskId);
      let deliveries: Awaited<ReturnType<typeof deliverPlanReview>>["deliveries"] = [];
      if (result.changed && (state === "approved" || state === "changes_requested")) {
        const task = store.tasks.getTask(taskId)!;
        const { version } = result.plan;
        const text = state === "approved"
          ? buildApprovalMessage({ taskKey: task.key, version, by: "the owner" })
          : buildStateChangeMessage({ taskKey: task.key, version, reviewer: result.plan.reviewer.kind === "thread" && result.plan.reviewer.threadId ? result.plan.reviewer.threadId : "owner" });
        const recipients = plans.resultRecipients(taskId, version);
        deliveries = (await deliverPlanReview(bb, { taskId, recipients, text, copyText: (actor) => buildResultCopyMessage({ taskKey: task.key, headline: text.split("\n")[0]!, actor }) })).deliveries;
      }
      if (before === "approved" && state !== "approved")
        await noticeLeftApproved(bb, store.tasks, { taskId, version: result.plan.version, state, reason: "the owner changed its state", changedBy: author.threadId, inWork, exclude: deliveries.map((entry) => entry.threadId) });
      return { ok: true as const, plan: result.plan, version: result.version, deliveries };
    },
    listTaskDependencies: ({ taskId }) => dependencies.list(taskId),
    addTaskRelation: (input) => changeRelation(input, true),
    removeTaskRelation: (input) => changeRelation(input, false),
    getStorageStatus: () => storageService(bb).status(),
    maintainStorage: ({ optimize }) => storageService(bb).run(optimize),
    addTaskDependency: (input) => changeDependency(input, true),
    removeTaskDependency: (input) => changeDependency(input, false),
    createSequence: (input) => ({ sequence: store.tasks.createSequence(input.projectId, input.name, input.next, input.format) }),
    listSequences: (input) => ({ sequences: store.tasks.listSequences(input.projectId) }),
    showSequence: (input) => { const sequence = store.tasks.getSequence(input.projectId, input.name); if (!sequence) throw new Error("Sequence not found"); return { sequence, claims: store.tasks.listSequenceClaims(input.projectId, input.name) }; },
    setSequenceNext: (input) => ({ sequence: store.tasks.setSequenceNext(input.projectId, input.name, input.next, input.force) }),
    deleteSequence: (input) => ({ deleted: store.tasks.deleteSequence(input.projectId, input.name) }),
    claimSequence: (input) => { const claim = store.tasks.claimSequence(input.projectId, input.name, input.taskId, input.prUrl, input.threadId, input.another); publishTasksChanged(bb, input.taskId, input.projectId); return { claim }; },
    releaseClaim: (input) => { const claim = store.tasks.releaseClaim(input.projectId, input.name, input.value, input.reason); if (claim.taskId) publishTasksChanged(bb, claim.taskId, input.projectId); return { claim }; },
    listTaskClaims: (input) => ({ claims: store.tasks.listTaskClaims(input.taskId) }),
    ...structured.handlers,
    ...gitSyncService(bb, store).handlers,
    ...projectConfigHandlers(bb, store),
    ...attentionUiHandlers(bb, store),
    ...checksUiHandlers(bb),
    ...createLockHandlers(bb, store),
    createFolder(input) {
      const folder = store.tasks.createFolder(input);
      publishProjectsChanged(bb, null);
      return { folder };
    },
    renameFolder(input) {
      const folder = store.tasks.updateFolder(input.folderId, {
        name: input.name,
      });
      publishProjectsChanged(bb, null);
      return { folder };
    },
    moveFolder(input) {
      const folder = store.tasks.updateFolder(input.folderId, {
        parentFolderId: input.parentFolderId,
      });
      publishProjectsChanged(bb, null);
      return { folder };
    },
    deleteFolder(input) {
      const result = store.tasks.deleteFolder(input.folderId);
      if (result.deleted) publishProjectsChanged(bb, null);
      return result;
    },
    listFolders() {
      return { folders: store.tasks.listFolders() };
    },
    getBoardPreferences() {
      return getBoardPreferences(bb);
    },
    async "globalSettings.set"({ values, expected }) {
      return { values: await setGlobalSettings(bb, values, expected) };
    },
    async "globalSettings.get"() {
      return { values: await getGlobalSettings(bb) };
    },
    async setBoardPreferences(input) {
      await setBoardPreferences(bb, input);
      publishProjectsChanged(bb, null);
      return input;
    },
    createProject(input) {
      const project = store.tasks.createProject(input);
      publishProjectsChanged(bb, project.id);
      return { project };
    },
    updateProject(input) {
      const { projectId, baseStatuses, ...changes } = input;
      const before = store.tasks.getProject(projectId)?.planning ?? "off";
      const canonical = (statuses: unknown) => JSON.stringify(taskStatusesSchema.parse(statuses));
      const project = store.transaction(() => {
        if (baseStatuses && canonical(store.tasks.getProject(projectId)?.statuses ?? DEFAULT_TASK_STATUSES) !== canonical(baseStatuses)) throw new Error(STALE_STATUSES);
        return store.tasks.updateProject(projectId, changes);
      });
      // The platform cannot tell the app from another caller, so a change is only made visible: a log entry.
      if ((project.planning ?? "off") !== before) bb.log.info(`planning for ${project.prefix}: ${before} → ${project.planning}`);
      publishProjectsChanged(bb, project.id);
      return { project };
    },
    renameProjectPrefix(input) {
      try {
        if (store.projectPrefixExists(input.prefix, input.projectId)) {
          fail(
            "project_prefix_conflict",
            `Project prefix is already in use: ${input.prefix}`,
          );
        }
        const project = store.tasks.updateProject(input.projectId, {
          prefix: input.prefix,
        });
        publishProjectsChanged(bb, project.id);
        return { ok: true, project };
      } catch (error) {
        if (error instanceof TasksDomainFailure) return taskFailure(error);
        throw error;
      }
    },
    async deleteProject(input) {
      try {
        if (!input.force && store.projectTaskCount(input.projectId) > 0) {
          fail(
            "project_not_empty",
            "A project must be empty before it can be deleted; pass force: true to delete its tasks",
          );
        }
        const taskIds = store.tasks
          .listTasks({ projectId: input.projectId })
          .map((task) => task.id);
        const attachments = attachmentsForTasks(store.tasks, taskIds);
        const deleted = store.tasks.deleteProject(input.projectId);
        if (deleted) {
          await removeAttachmentBlobs(bb, store.tasks, attachments);
          publishProjectsChanged(bb, input.projectId);
        }
        return { ok: true, deleted };
      } catch (error) {
        if (error instanceof TasksDomainFailure) return taskFailure(error);
        throw error;
      }
    },
    listProjects(input) {
      return { projects: store.tasks.listProjects(input.folderId) };
    },
    createTask(input) {
      try {
        validateTaskParent(store, input.projectId, input.parentTaskId);
        validateTaskLabels(store, input.projectId, input.labelIds);
        const task = store.transaction(() => {
          const created = store.tasks.createTask({
            projectId: input.projectId,
            title: input.title,
            description: structured.applyTemplate(
              input.projectId,
              input.template,
              input.labelIds,
              input.description,
            ),
            status: input.status,
            priority: input.priority,
            dueDate: input.dueDate,
            parentTaskId: input.parentTaskId,
            type: input.type,
            epicId: input.epicId,
          });
          replaceTaskLabels(store, created.id, input.labelIds);
          return apiTask(store, created);
        });
        publishTasksChanged(bb, task.id, task.projectId);
        return { ok: true, task };
      } catch (error) {
        if (error instanceof SecretDetectedError) {
          return {
            ok: false,
            error: { code: "secret_detected", message: error.message },
          };
        }
        if (error instanceof TaskEpicError) {
          return {
            ok: false,
            error: { code: "task_epic_invalid", message: error.message },
          };
        }
        if (error instanceof TasksDomainFailure) return taskFailure(error);
        throw error;
      }
    },
    getTask(input) {
      const task = store.tasks.getTask(input.taskId);
      return { task: task ? apiTask(store, task) : null };
    },
    getTaskByKey(input) {
      const task = store.tasks.getTaskByKey(input.taskKey);
      return { task: task ? apiTask(store, task) : null };
    },
    async updateTask(input) {
      try {
        const current = store.tasks.getTask(input.taskId);
        if (!current) throw new Error(`Task not found: ${input.taskId}`);
        const parentTaskId =
          input.parentTaskId === undefined
            ? current.parentTaskId
            : input.parentTaskId;
        validateTaskParent(store, current.projectId, parentTaskId, current.id);
        if (input.labelIds) {
          validateTaskLabels(store, current.projectId, input.labelIds);
        }

        // The SDK reads that attaching the caller needs come first; the transaction below re-checks the local conditions.
        let attachment: { threadId: string; parentThreadId: string | null; title: string; liveStatus: TaskThreadLiveStatus } | undefined;
        let attachWarning: string | undefined;
        if (input.attachCaller) {
          const caller = input.agentThreadId;
          try {
            if (!caller || input.progressNote == null) throw new Error("it needs the calling thread and a progress note");
            // One read: its parent id is the one the write checks, so the two cannot disagree.
            const thread = await bb.sdk.threads.get({ threadId: caller });
            if (thread.parentThreadId) {
              if (thread.archivedAt != null || thread.deletedAt != null || thread.status === "stopping")
                throw new Error("Choose a thread that is not archived, deleted, or stopping");
              attachment = { threadId: caller, parentThreadId: thread.parentThreadId, title: truncateToWidth(thread.title ?? thread.titleFallback ?? current.key, 120), liveStatus: threadLiveStatus(thread) };
            }
          } catch (error) {
            attachWarning = `Could not attach ${caller ?? "the caller"} to the card: ${errorMessage(error)}; run bb work-board attach KEY`;
          }
        }
        const closureBefore = store.tasks.closures.currentId(current.id);
        const result = store.transaction(() => {
          const beforeLabelIds = store.tasks
            .listTaskLabels(current.id)
            .map((link) => link.labelId);
          // The card as it is now, after the SDK reads: its archive state and the old values the history lines compare.
          const before = store.tasks.getTask(current.id);
          if (!before) throw new Error(`Task not found: ${input.taskId}`);
          // The caller's own session is attached first, so the closure snapshot below includes it.
          assertNoOpenOwnerQuestions(bb, store, before, input.status, input.agentThreadId);
          const attached = attachment && !before.archivedAt && canTakeWorkerLink(bb, current.id)
            ? attachManualLink(store.tasks, current.id, attachment) : undefined;
          const updated = store.tasks.updateTask(current.id, {
            closerThreadId: input.agentThreadId ?? null,
            title: input.title,
            description: input.description,
            notifyStatus: Boolean(input.agentThreadId),
            progressNote: input.progressNote,
            authorName: input.authorName,
            status: input.status,
            priority: input.priority,
            dueDate: input.dueDate,
            parentTaskId: input.parentTaskId,
            type: input.type,
            epicId: input.epicId,
          });
          if (input.labelIds) {
            replaceTaskLabels(store, current.id, input.labelIds);
          }

          const bodies: string[] = [];
          if (updated.type !== before.type) {
            bodies.push(
              `Type changed to ${displayName(updated.type)} by ${input.authorName}`,
            );
          }
          if (updated.epicId !== before.epicId) {
            const epic = updated.epicId
              ? store.tasks.getTask(updated.epicId)
              : null;
            bodies.push(
              epic
                ? `Added to epic ${epic.key} by ${input.authorName}`
                : `Removed from epic by ${input.authorName}`,
            );
          }
          if (updated.status !== before.status) {
            bodies.push(
              `Status changed to ${statusLabel(updated.status, store.tasks.getProject(updated.projectId)?.statuses)} by ${input.authorName}`,
            );
          }
          if (updated.priority !== before.priority) {
            bodies.push(
              `Priority changed to ${displayName(updated.priority)} by ${input.authorName}`,
            );
          }
          if (updated.dueDate !== before.dueDate) {
            bodies.push(
              updated.dueDate === null
                ? `Due date removed by ${input.authorName}`
                : `Due date changed to ${updated.dueDate} by ${input.authorName}`,
            );
          }
          if (input.labelIds && labelsChanged(beforeLabelIds, input.labelIds)) {
            bodies.push(labelChangeBody(store, current.id, input.authorName));
          }
          writeSystemComments(store, current.id, input.authorName, bodies);
          return {
            task: apiTask(store, updated),
            systemCommentsWritten: bodies.length,
            attached,
          };
        });

        publishTasksChanged(bb, result.task.id, result.task.projectId);
        if (result.systemCommentsWritten > 0) {
          publishCommentsChanged(bb, result.task.id);
        }
        if (result.attached) bb.realtime.publish("threads:changed", { taskId: result.task.id });
        const closureAfter = store.tasks.closures.currentId(current.id);
        const closedThreads = closureAfter && closureAfter !== closureBefore ? await store.closures.onClosed(closureAfter) : undefined;
        return { ok: true, task: result.task, ...(closedThreads ? { closedThreads } : {}), ...(result.attached === undefined ? {} : { attached: result.attached }), ...(attachWarning ? { attachWarning } : {}) };
      } catch (error) {
        if (error instanceof SecretDetectedError) {
          return {
            ok: false,
            error: { code: "secret_detected", message: error.message },
          };
        }
        if (error instanceof TaskEpicError) {
          return {
            ok: false,
            error: { code: "task_epic_invalid", message: error.message },
          };
        }
        if (error instanceof TasksDomainFailure) return taskFailure(error);
        throw error;
      }
    },
    async deleteTask(input) {
      const task = store.tasks.getTask(input.taskId);
      const dependents = task
        ? [
            ...store.tasks.listSubtasks(task.id),
            ...store.tasks.listTasks({ epicId: task.id }),
          ]
        : [];
      const attachments = attachmentsForTasks(store.tasks, [input.taskId]);
      const dependencyNeighbours = dependencies.related(input.taskId);
      const deleted = store.tasks.deleteTask(input.taskId);
      if (deleted && task) {
        await removeAttachmentBlobs(bb, store.tasks, attachments);
        publishTasksChanged(bb, task.id, task.projectId);
        for (const dependent of dependents) {
          publishTasksChanged(bb, dependent.id, dependent.projectId);
        }
        for (const neighbour of dependencyNeighbours) publishTasksChanged(bb, neighbour.id, neighbour.projectId);
      }
      return { deleted };
    },
    listTasks(input) {
      // One clock for the selection and the flags returned with it.
      const nowMs = Date.now();
      const page = store.tasks.listTasksPage({
        nowMs,
        ordinaryOnly: !input.includeScheduled,
        archive: input.archive,
        dateField: input.dateField,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        projectId: input.projectId,
        statuses: input.statuses,
        excludeStatuses: input.excludeStatuses,
        priorities: input.priorities,
        labelIds: input.labelIds,
        activeOnly: input.activeOnly,
        staleStatus: input.staleStatus,
        waitingOnOwner: input.waitingOnOwner,
        planDebt: input.planDebt,
        parentTaskId: input.parentTaskId,
        type: input.type,
        epicId: input.epicId,
        search: input.search,
        sort: input.sort,
        limit: input.limit,
        cursor: input.cursor,
        allowStaleCursor: input.allowStaleCursor,
      });
      const flags = store.tasks.staleStatusFlags(page.tasks.map((task) => task.id), undefined, nowMs);
      const tasks = apiTasks(store, page.tasks);
      return {
        tasks: input.omitBodies ? tasks.map((task) => ({ ...task, description: "", progressNote: null })) : tasks,
        staleStatusFlags: page.tasks.map((task) => ({ taskId: task.id, flags: flags.get(task.id) ?? [] })),
        nextCursor: page.nextCursor,
      };
    },
    async boardMove(input) {
      const current = store.tasks.getTask(input.taskId);
      if (!current) throw new Error(`Task not found: ${input.taskId}`);
      const closureBefore = store.tasks.closures.currentId(current.id);
      const result = store.transaction(() => {
        const before = store.tasks.getTask(current.id);
        if (!before) throw new Error(`Task not found: ${input.taskId}`);
        assertNoOpenOwnerQuestions(bb, store, before, input.status, input.agentThreadId);
        const moved = store.tasks.updatePosition(current.id, {
          closerThreadId: input.agentThreadId ?? null,
          status: input.status,
          notifyStatus: Boolean(input.agentThreadId),
          beforeTaskId: input.beforeTaskId,
          afterTaskId: input.afterTaskId,
        });
        const statusChanged = moved.status !== current.status;
        if (statusChanged) {
          writeSystemComments(store, current.id, input.authorName, [
            `Status changed to ${statusLabel(moved.status, store.tasks.getProject(moved.projectId)?.statuses)} by ${input.authorName}`,
          ]);
        }
        return { task: apiTask(store, moved), statusChanged };
      });
      publishTasksChanged(bb, result.task.id, result.task.projectId);
      if (result.statusChanged) publishCommentsChanged(bb, result.task.id);
      const closureAfter = store.tasks.closures.currentId(current.id);
      const closedThreads = closureAfter && closureAfter !== closureBefore ? await store.closures.onClosed(closureAfter) : undefined;
      return { ok: true, task: result.task, ...(closedThreads ? { closedThreads } : {}) };
    },
    moveTaskToProject(input) {
      const current = store.tasks.getTask(input.taskId);
      if (!current) throw new Error(`Task not found: ${input.taskId}`);
      const result = store.transaction(() => {
        const outcome = store.tasks.moveTaskToProject(
          current.id,
          input.projectId,
        );
        if (bb.storage.database().prepare<[], { found: number }>(`
          SELECT 1 AS found FROM task_dependencies d JOIN tasks t ON t.id=d.task_id
          JOIN tasks b ON b.id=d.blocking_task_id WHERE t.project_id<>b.project_id
          UNION ALL SELECT 1 FROM task_relations r JOIN tasks t ON t.id=r.task_id
          JOIN tasks b ON b.id=r.related_task_id WHERE t.project_id<>b.project_id LIMIT 1
        `).get()) throw new Error("Remove dependencies and related links outside the moving task family before changing projects");
        for (const { previousKey, task } of outcome.moved) {
          writeSystemComments(store, task.id, input.authorName, [
            `Moved from ${previousKey} to ${task.key} by ${input.authorName}`,
          ]);
        }
        return { task: apiTask(store, outcome.task), moved: outcome.moved };
      });
      if (result.moved.length > 0) {
        for (const { task } of result.moved) {
          publishTasksChanged(bb, task.id, current.projectId);
          publishTasksChanged(bb, task.id, task.projectId);
        }
        publishProjectsChanged(bb, result.task.projectId);
        for (const { task } of result.moved) {
          publishCommentsChanged(bb, task.id);
        }
      }
      return { ok: true, task: result.task };
    },
    createLabel(input) {
      const label = store.tasks.createLabel(input);
      publishProjectsChanged(bb, label.projectId);
      return { label };
    },
    updateLabel(input) {
      const label = store.tasks.updateLabel(input.labelId, {
        name: input.name,
        color: input.color,
      });
      publishProjectsChanged(bb, label.projectId);
      return { label };
    },
    deleteLabel(input) {
      const label = store.tasks.getLabel(input.labelId);
      const deleted = store.tasks.deleteLabel(input.labelId);
      if (deleted && label) publishProjectsChanged(bb, label.projectId);
      return { deleted };
    },
    listLabels(input) {
      return { labels: store.tasks.listLabels(input.projectId) };
    },
    async createComment(input) {
      const comment = await createComment(bb, store, {
        taskId: input.taskId,
        kind: "user",
        authorName: "You",
        presetName: null,
        threadId: null,
        body: input.body,
        ...(input.evidence ? { evidence: input.evidence } : {}),
        notify: input.notify,
        awaitDelivery: false,
      });
      return { comment };
    },
    async listComments(input) {
      const comments = store.tasks.listComments(input.taskId);
      // Taken in the same synchronous step as the rows, so the token is never newer than the data it came with.
      const revision = input.withRevision ? { revision: commentsRevisionPart(bb, input.taskId) } : {};
      if (input.resolveMetadata === false) {
        return { comments: comments.map((comment) => ({ ...comment, threadTitle: null, provider: null })), ...revision };
      }
      const { byThread } = await resolveCommentThreads(bb, agentThreadIds(comments));
      return {
        comments: comments.map((comment) => {
          const meta =
            comment.kind === "agent" && comment.threadId !== null
              ? byThread.get(comment.threadId)
              : undefined;
          return { ...comment, threadTitle: meta?.threadTitle ?? null, provider: meta?.provider ?? null };
        }),
        ...revision,
      };
    },
    commentsRevision(input) {
      return { revision: `${commentsRevisionPart(bb, input.taskId)}|${attachmentsRevisionPart(bb, input.taskId)}` };
    },
    async listCommentThreads(input) {
      const ids = bb.storage
        .database()
        .prepare<[string], { id: string }>(
          "SELECT DISTINCT thread_id AS id FROM comments WHERE task_id = ? AND kind = 'agent' AND thread_id IS NOT NULL",
        )
        .all(input.taskId)
        .map((row) => row.id);
      const { byThread, complete } = await resolveCommentThreads(bb, ids);
      return {
        threads: [...byThread].map(([threadId, meta]) => ({ threadId, ...meta })),
        complete,
      };
    },
    listAttachments(input) {
      const attachments =
        "taskId" in input
          ? store.tasks.listAttachmentsForTask(input.taskId)
          : "commentId" in input
            ? store.tasks.listAttachmentsForComment(input.commentId)
            : store.tasks.listAttachmentsForTaskComments(
                input.commentsOfTaskId,
              );
      return {
        attachments: attachments.map(attachmentMetadata),
        ...("commentsOfTaskId" in input && input.withRevision
          ? { revision: attachmentsRevisionPart(bb, input.commentsOfTaskId) }
          : {}),
      };
    },
    async deleteAttachment(input) {
      try {
        const attachment = await deleteAttachmentById(
          bb,
          store.tasks,
          input.attachmentId,
          {
            removeDescriptionReferences: input.removeDescriptionReferences,
          },
        );
        return attachment
          ? {
              ok: true,
              deleted: true,
              attachment: attachmentMetadata(attachment),
            }
          : { ok: true, deleted: false, attachment: null };
      } catch (error) {
        if (error instanceof AttachmentReferencedError) {
          return {
            ok: false,
            error: {
              code: "attachment_referenced",
              message: error.message,
            },
          };
        }
        throw error;
      }
    },
    archiveTask(input) {
      const changed = store.transaction(() => {
        const changed = store.tasks.setTaskArchived(input.taskId, input.archived);
        for (const task of changed) store.tasks.createComment({ taskId: task.id, kind: "system", authorName: input.authorName, body: input.archived ? "Task archived" : "Task restored from archive" });
        return changed;
      });
      for (const task of changed) {
        publishTasksChanged(bb, task.id, task.projectId);
        publishCommentsChanged(bb, task.id);
      }
      return { ok: true as const, task: apiTask(store, store.tasks.getTask(input.taskId)!) };
    },
    archiveCompleted(input) {
      const changed = store.transaction(() => {
        const changed = store.tasks.archiveCompletedTasks(input.projectId);
        for (const task of changed) store.tasks.createComment({ taskId: task.id, kind: "system", authorName: input.authorName, body: "Task archived" });
        return changed;
      });
      for (const task of changed) {
        publishTasksChanged(bb, task.id, task.projectId);
        publishCommentsChanged(bb, task.id);
      }
      return { archivedCount: changed.length };
    },
    async setTaskActivity({ taskId, threadId, active }) {
      const task = store.tasks.getTask(taskId);
      if (!task) throw new Error("Task not found");
      const service = activityService(bb, store);
      if (active) await service.start(taskId, threadId);
      else await service.stop(taskId, threadId);
      const affected = new Set([taskId, ...store.tasks.listTaskThreadsByThreadId(threadId).map((link) => link.taskId)]);
      for (const id of affected) bb.realtime.publish("threads:changed", { taskId: id });
      return { ok: true as const };
    },
    async listTaskCardMeta({ taskIds, skipStaleStatusFlags }) {
      const ids = [...new Set(taskIds)];
      if (ids.length === 0) return { metadata: [] };
      const discoveryComplete = await discoverRunningTaskThreads(bb, store);
      const counts = new Map(bb.storage.database().prepare<string[], { task_id: string; count: number }>(
        `SELECT task_id, COUNT(*) AS count FROM attachments WHERE task_id IN (${ids.map(() => "?").join(",")}) GROUP BY task_id`,
      ).all(...ids).map((row) => [row.task_id, row.count]));
      const threads = new Map<string, TaskThread[]>();
      const allLinks = store.tasks.listTaskThreadsForTasks(ids);
      for (const thread of allLinks) {
        const entries = threads.get(thread.taskId) ?? [];
        entries.push(thread);
        threads.set(thread.taskId, entries);
      }
      const flags = skipStaleStatusFlags ? new Map<string, string[]>() : store.tasks.staleStatusFlags(ids);
      const activity = store.tasks.listTaskActivity(ids);
      const scopedActivity = await activityService(bb, store).metadata(ids, discoveryComplete, allLinks);
      const blockedBy = dependencies.blockers(ids);
      const advisories = taskAdvisories(bb, activity, blockedBy, scopedActivity, threads);
      const projects = store.tasks.listProjects();
      const thresholds = new Map(projects.map((project) => [project.id, idleThreshold(project)]));
      const waitingStatuses = new Map(projects.map((project) => [project.id, [getWorkflowPolicy(project).reviewStatus]]));
      const waitingOnOwner = new Set(bb.storage.database().prepare<string[], { task_id: string }>(
        `SELECT DISTINCT q.task_id FROM task_questions q WHERE q.task_id IN (${ids.map(() => "?").join(",")}) AND ${UNANSWERED_QUESTION}`,
      ).all(...ids).map((row) => row.task_id));
      return { metadata: ids.map((taskId) => {
        const links = threads.get(taskId) ?? [];
        const task = activity.get(taskId);
        return {
          taskId,
          attachmentCount: counts.get(taskId) ?? 0,
          staleStatusFlags: flags.get(taskId) ?? [],
          activity: scopedActivity.get(taskId),
          blockedBy: blockedBy.get(taskId) ?? [],
          advisories: advisories.get(taskId) ?? [],
          taskThreads: links.filter((link) => link.liveStatus === "starting" || link.liveStatus === "working"),
          threadHealth: evaluateThreadHealth(task?.status ?? "", links, task?.lastActivityAt ?? "", task ? thresholds.get(task.projectId) ?? null : null, task ? waitingStatuses.get(task.projectId) : undefined, waitingOnOwner.has(taskId)),
        };
      }) };
    },
    async getTaskCostSpans(input) {
      return getTaskCostSpans(bb.storage.database(), input.taskId);
    },
    async listTaskThreads(input) {
      if (input.reconcile !== false) await discoverRunningTaskThreads(bb, store);
      return { taskThreads: input.reconcile === false
        ? store.tasks.listTaskThreads(input.taskId)
        : await reconcileTaskThreads(bb, store.tasks, input.taskId) };
    },
    async listTaskPullRequests(input) {
      return listTaskPullRequests(bb, store, input.taskId);
    },
    createPreset(input) {
      const preset = store.tasks.createPreset({ ...input, builtin: false });
      publishProjectsChanged(bb, null);
      return { preset };
    },
    updatePreset(input) {
      const { presetId, ...changes } = input;
      const preset = store.tasks.updatePreset(
        presetId,
        changes.environmentKind === "project-default"
          ? { ...changes, baseBranch: null, machineId: null }
          : changes,
      );
      publishProjectsChanged(bb, null);
      return { preset };
    },
    deletePreset(input) {
      const deleted = store.tasks.deletePreset(input.presetId);
      if (deleted) publishProjectsChanged(bb, null);
      return { deleted };
    },
    listPresets() {
      return { presets: store.tasks.listPresets() };
    },
    async listMachines() {
      const machines = await bb.sdk.hosts.list();
      return {
        machines: machines.map((machine) => ({
          id: machine.id,
          name: machine.name,
        })),
      };
    },
    async searchThreads(input) {
      const query = input.query.trim();
      const limit = Math.min(input.limit ?? MAX_THREAD_SEARCH_RESULTS, 10);
      const candidates =
        query.length >= 2
          ? await bb.sdk.threads.search({
              query,
              limitPerGroup: String(MAX_THREAD_SEARCH_RESULTS),
            })
          : null;
      const threads = candidates
        ? [...candidates.active.results, ...candidates.archived.results].map(
            (result) => result.thread,
          )
        : (
            await bb.sdk.threads.list({
              limit: MAX_THREAD_SEARCH_RESULTS,
            })
          ).filter((thread) => {
            if (query.length === 0) return true;
            const title = thread.title ?? thread.titleFallback ?? "";
            return title
              .toLocaleLowerCase()
              .includes(query.toLocaleLowerCase());
          });
      return {
        threads: threads
          .sort((left, right) => right.updatedAt - left.updatedAt)
          .slice(0, limit)
          .map((thread) => ({
            id: thread.id,
            title: thread.title ?? thread.titleFallback ?? "Untitled thread",
            status: thread.status,
          })),
      };
    },
    async listBbProjects() {
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      return {
        bbProjects: projects.map((project) => ({
          id: project.id,
          name: project.name,
        })),
      };
    },
    async getNavigationBadgeCriteria() {
      return { criteria: await getBadgeCriteria(bb) };
    },
    async setNavigationBadgeCriteria({ criteria }) {
      const saved = await setBadgeCriteria(bb, criteria);
      bb.realtime.publish("badge:changed", {});
      return { criteria: saved };
    },
    async navigationBadge() {
      const criteria = await getBadgeCriteria(bb);
      return {
        ...navigationBadgeCounts(bb, store, criteria, Date.now()),
        criteria,
        timeBased: criteria.includes("stale_idle") && store.tasks.listProjects().some((project) => idleThreshold(project) !== null),
      };
    },
    sidebarOpenTaskCount() {
      return { openTaskCount: store.openTaskCount() };
    },
    sidebarSummary() {
      return { projects: store.sidebarSummary() };
    },
  };
}

export function registerTasksApi(
  bb: BbPluginApi,
  store: TasksApiStore,
): void {
  bb.rpc.register(tasksRpcContract, registerHandlers(bb, store));
}
