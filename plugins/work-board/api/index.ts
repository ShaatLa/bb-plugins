import { observeStatusNotifications } from "../status-notifications";
import { ordinaryTaskVisibilitySql } from "../scheduled/visibility";
import { taskAdvisories } from "../advisories";
import { BOARD_PREFERENCES_KEY, DEFAULT_BOARD_PREFERENCES, boardPreferencesSchema, idleThreshold } from "../shared/project-settings";
import { activityService } from "../activity/index.js";
import { createDependencyStore } from "../dependencies/store";
import { storageService } from "../storage";
import { gitSyncService } from "../git-sync/service";
import { createLockHandlers } from "../locks/service";
import { statusLabel } from "../shared/statuses.js";
import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import {
  createTasksStore,
  TaskEpicError,
  type Attachment as StoredAttachment,
  type Comment as StoredComment,
  type Task as StoredTask,
  type TasksStore,
} from "../db";
import {
  AttachmentReferencedError,
  deleteAttachmentById,
  removeAttachmentBlobs,
} from "../attachments";
import { deliverCommentToLatestAgent } from "../steer";
import { reconcileTaskThreads } from "../lifecycle/thread-links";
import { discoverRunningTaskThreads } from "../lifecycle/discovery";
import { displayName } from "../shared/display-name";
import { evaluateThreadHealth } from "../shared/thread-health";
import { environmentPullRequests } from "../git-sync/environment-prs";
import { navigationBadgeCounts } from "./badge";
import { BADGE_CRITERIA, DEFAULT_BADGE_CRITERIA } from "../shared/badge";
import { errorMessage } from "../shared/errors";
import { SecretDetectedError } from "../shared/secret-guard.js";
import { createStructuredStore } from "../structured/store";
import type { Evidence } from "../shared/contract";
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
  transaction<T>(operation: () => T): T;
  taskLabelIds(taskIds: readonly string[]): Map<string, string[]>;
  projectTaskCount(projectId: string): number;
  projectPrefixExists(prefix: string, excludingProjectId: string): boolean;
  openTaskCount(): number;
  sidebarSummary(): SidebarProjectSummary[];
}

export function createStore(bb: BbPluginApi): TasksApiStore {
  const database = bb.storage.database();
  const tasks = createTasksStore(database);
  observeStatusNotifications(bb, tasks);

  return {
    tasks,
    transaction<T>(operation: () => T): T {
      return database.transaction(operation)();
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

function recordOwnerCompletion(
  store: TasksApiStore,
  before: StoredTask,
  after: StoredTask,
  authorName: string,
): StoredComment | null {
  if (
    after.executionTarget !== "owner" ||
    after.status !== "done" ||
    before.status === "done"
  )
    return null;
  return store.tasks.createComment({
    taskId: after.id,
    kind: "system",
    authorName,
    body: `Owner action completed by ${authorName}: ${after.title}. Re-read the task and its comments to verify the result before continuing.`,
  });
}

async function notifyOwnerCompletion(
  bb: BbPluginApi,
  store: TasksApiStore,
  task: StoredTask,
  comment: StoredComment | null,
): Promise<{ notification?: "sent" | "not_sent" }> {
  if (!comment || !task.requesterThreadId) return {};
  const count = await deliverCommentToLatestAgent(bb, store.tasks, {
    taskId: task.id,
    commentId: comment.id,
    body: comment.body,
    authorName: comment.authorName,
    threadId: task.requesterThreadId,
    mode: "queue-if-active",
  });
  store.tasks.updateComment(comment.id, { notifiedCount: count });
  if (!count)
    writeSystemComments(store, task.id, "Work Board", [
      "Owner action is saved as Done, but the requester thread could not be notified. Notify it manually.",
    ]);
  publishCommentsChanged(bb, task.id);
  return { notification: count ? "sent" : "not_sent" };
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

async function resolveAgentThreadInfo(
  bb: BbPluginApi,
  comments: readonly StoredComment[],
): Promise<Map<string, AgentThreadInfo>> {
  const threadIds = new Set<string>();
  for (const comment of comments) {
    if (comment.kind === "agent" && comment.threadId !== null) {
      threadIds.add(comment.threadId);
    }
  }
  const infos = new Map<string, AgentThreadInfo>();
  await Promise.all(
    [...threadIds].map(async (threadId) => {
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        const isSideChat = isSideChatShapedThread(thread);
        const title = isSideChat
          ? undefined
          : [thread.title, thread.titleFallback].find(
              (candidate) => candidate !== null && candidate.trim() !== "",
            );
        infos.set(threadId, {
          title: title ?? null,
          providerId: thread.providerId,
        });
      } catch {}
    }),
  );
  return infos;
}

async function resolveProviderBadges(
  bb: BbPluginApi,
  threadInfo: ReadonlyMap<string, AgentThreadInfo>,
): Promise<Map<string, CommentProvider>> {
  const providerIds = new Set(
    [...threadInfo.values()].map((info) => info.providerId),
  );
  const badges = new Map<string, CommentProvider>();
  if (providerIds.size === 0) return badges;
  let providers: Awaited<ReturnType<typeof bb.sdk.providers.list>>;
  try {
    providers = await bb.sdk.providers.list();
  } catch {
    return badges;
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
  return badges;
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

const BADGE_CRITERIA_KEY = "navigation-badge:criteria";

async function readBadgeCriteria(bb: BbPluginApi) {
  const stored = await bb.storage.kv.get<unknown>(BADGE_CRITERIA_KEY);
  if (!Array.isArray(stored)) return [...DEFAULT_BADGE_CRITERIA];
  return BADGE_CRITERIA.filter((criterion) => stored.includes(criterion));
}

export function registerHandlers(
  bb: BbPluginApi,
  store: TasksApiStore,
): PluginRpcHandlers<typeof tasksRpcContract> {
  const structured = createStructuredStore(bb, store);
  const dependencies = createDependencyStore(bb.storage.database(), store.tasks);
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
    async getBoardPreferences() {
      return boardPreferencesSchema.parse(await bb.storage.kv.get(BOARD_PREFERENCES_KEY) ?? DEFAULT_BOARD_PREFERENCES);
    },
    async setBoardPreferences(input) {
      await bb.storage.kv.set(BOARD_PREFERENCES_KEY, input);
      publishProjectsChanged(bb, null);
      return input;
    },
    createProject(input) {
      const project = store.tasks.createProject(input);
      publishProjectsChanged(bb, project.id);
      return { project };
    },
    updateProject(input) {
      const { projectId, ...changes } = input;
      const project = store.tasks.updateProject(projectId, changes);
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
            executionTarget: input.executionTarget,
            requesterThreadId: input.requesterThreadId,
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
        if (
          input.executionTarget === "owner" &&
          current.executionTarget !== "owner" &&
          store.tasks
            .listTaskThreads(current.id)
            .some(
              (thread) =>
                thread.liveStatus === "starting" ||
                thread.liveStatus === "working",
            )
        ) {
          return {
            ok: false,
            error: {
              code: "task_execution_invalid",
              message:
                "Stop active task agents before converting to an Owner action",
            },
          };
        }
        const parentTaskId =
          input.parentTaskId === undefined
            ? current.parentTaskId
            : input.parentTaskId;
        validateTaskParent(store, current.projectId, parentTaskId, current.id);
        if (input.labelIds) {
          validateTaskLabels(store, current.projectId, input.labelIds);
        }

        const result = store.transaction(() => {
          const beforeLabelIds = store.tasks
            .listTaskLabels(current.id)
            .map((link) => link.labelId);
          const updated = store.tasks.updateTask(current.id, {
            title: input.title,
            description: input.description,
            progressNote: input.progressNote,
            authorName: input.authorName,
            status: input.status,
            priority: input.priority,
            dueDate: input.dueDate,
            parentTaskId: input.parentTaskId,
            type: input.type,
            executionTarget: input.executionTarget,
            requesterThreadId: input.requesterThreadId,
            epicId: input.epicId,
          });
          if (input.labelIds) {
            replaceTaskLabels(store, current.id, input.labelIds);
          }

          const completion = recordOwnerCompletion(
            store,
            current,
            updated,
            input.authorName,
          );
          const bodies: string[] = [];
          if (updated.executionTarget !== current.executionTarget)
            bodies.push(
              `Executor changed to ${displayName(updated.executionTarget)} by ${input.authorName}`,
            );
          if (updated.requesterThreadId !== current.requesterThreadId)
            bodies.push(
              `Requester thread ${updated.requesterThreadId ? `set to @thread:${updated.requesterThreadId}` : "cleared"} by ${input.authorName}`,
            );
          if (updated.type !== current.type) {
            bodies.push(
              `Type changed to ${displayName(updated.type)} by ${input.authorName}`,
            );
          }
          if (updated.epicId !== current.epicId) {
            const epic = updated.epicId
              ? store.tasks.getTask(updated.epicId)
              : null;
            bodies.push(
              epic
                ? `Added to epic ${epic.key} by ${input.authorName}`
                : `Removed from epic by ${input.authorName}`,
            );
          }
          if (updated.status !== current.status) {
            bodies.push(
              `Status changed to ${statusLabel(updated.status, store.tasks.getProject(updated.projectId)?.statuses)} by ${input.authorName}`,
            );
          }
          if (updated.priority !== current.priority) {
            bodies.push(
              `Priority changed to ${displayName(updated.priority)} by ${input.authorName}`,
            );
          }
          if (updated.dueDate !== current.dueDate) {
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
            systemCommentsWritten: bodies.length + (completion ? 1 : 0),
            completion,
          };
        });

        publishTasksChanged(bb, result.task.id, result.task.projectId);
        if (result.systemCommentsWritten > 0) {
          publishCommentsChanged(bb, result.task.id);
        }
        const notification = await notifyOwnerCompletion(
          bb,
          store,
          result.task,
          result.completion,
        );
        return { ok: true, task: result.task, ...notification };
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
      const page = store.tasks.listTasksPage({
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
        parentTaskId: input.parentTaskId,
        type: input.type,
        executionTarget: input.executionTarget,
        epicId: input.epicId,
        search: input.search,
        sort: input.sort,
        limit: input.limit,
        cursor: input.cursor,
        allowStaleCursor: input.allowStaleCursor,
      });
      const flags = store.tasks.staleStatusFlags(page.tasks.map((task) => task.id));
      return {
        tasks: apiTasks(store, page.tasks),
        staleStatusFlags: page.tasks.map((task) => ({ taskId: task.id, flags: flags.get(task.id) ?? [] })),
        nextCursor: page.nextCursor,
      };
    },
    async boardMove(input) {
      const current = store.tasks.getTask(input.taskId);
      if (!current) throw new Error(`Task not found: ${input.taskId}`);
      const result = store.transaction(() => {
        const moved = store.tasks.updatePosition(current.id, {
          status: input.status,
          beforeTaskId: input.beforeTaskId,
          afterTaskId: input.afterTaskId,
        });
        const statusChanged = moved.status !== current.status;
        if (statusChanged) {
          writeSystemComments(store, current.id, input.authorName, [
            `Status changed to ${statusLabel(moved.status, store.tasks.getProject(moved.projectId)?.statuses)} by ${input.authorName}`,
          ]);
        }
        const completion = recordOwnerCompletion(
          store,
          current,
          moved,
          input.authorName,
        );
        return { task: apiTask(store, moved), statusChanged, completion };
      });
      publishTasksChanged(bb, result.task.id, result.task.projectId);
      if (result.statusChanged) publishCommentsChanged(bb, result.task.id);
      const notification = await notifyOwnerCompletion(
        bb,
        store,
        result.task,
        result.completion,
      );
      return { ok: true, task: result.task, ...notification };
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
      if (input.resolveMetadata === false) {
        return { comments: comments.map((comment) => ({ ...comment, threadTitle: null, provider: null })) };
      }
      const threadInfo = await resolveAgentThreadInfo(bb, comments);
      const providerBadges = await resolveProviderBadges(bb, threadInfo);
      return {
        comments: comments.map((comment) => {
          const info =
            comment.kind === "agent" && comment.threadId !== null
              ? threadInfo.get(comment.threadId)
              : undefined;
          return {
            ...comment,
            threadTitle: info?.title ?? null,
            provider:
              info === undefined
                ? null
                : (providerBadges.get(info.providerId) ?? {
                    id: info.providerId,
                    name: info.providerId,
                    logoUrl: null,
                    icon: null,
                    strings: { iconTint: null },
                  }),
          };
        }),
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
    async listTaskCardMeta({ taskIds }) {
      const ids = [...new Set(taskIds)];
      if (ids.length === 0) return { metadata: [] };
      const discoveryComplete = await discoverRunningTaskThreads(bb, store);
      const counts = new Map(bb.storage.database().prepare<string[], { task_id: string; count: number }>(
        `SELECT task_id, COUNT(*) AS count FROM attachments WHERE task_id IN (${ids.map(() => "?").join(",")}) GROUP BY task_id`,
      ).all(...ids).map((row) => [row.task_id, row.count]));
      const threads = new Map<string, TaskThread[]>();
      for (const thread of store.tasks.listTaskThreadsForTasks(ids)) {
        const entries = threads.get(thread.taskId) ?? [];
        entries.push(thread);
        threads.set(thread.taskId, entries);
      }
      const flags = store.tasks.staleStatusFlags(ids);
      const activity = store.tasks.listTaskActivity(ids);
      const scopedActivity = await activityService(bb, store).metadata(ids, discoveryComplete);
      const blockedBy = dependencies.blockers(ids);
      const advisories = taskAdvisories(bb, activity, blockedBy, scopedActivity, threads);
      const thresholds = new Map(store.tasks.listProjects().map((project) => [project.id, idleThreshold(project)]));
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
          threadHealth: evaluateThreadHealth(task?.status ?? "", links, task?.lastActivityAt ?? "", task ? thresholds.get(task.projectId) ?? null : null),
        };
      }) };
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
      return { criteria: await readBadgeCriteria(bb) };
    },
    async setNavigationBadgeCriteria({ criteria }) {
      // Store in a stable order and without repeats so the badge never counts a criterion twice.
      const saved = BADGE_CRITERIA.filter((criterion) => criteria.includes(criterion));
      await bb.storage.kv.set(BADGE_CRITERIA_KEY, saved);
      bb.realtime.publish("badge:changed", {});
      return { criteria: saved };
    },
    async navigationBadge() {
      const criteria = await readBadgeCriteria(bb);
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
