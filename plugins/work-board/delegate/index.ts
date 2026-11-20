import { notifyThread, withPluginHeader } from "../steer";
import { buildPlanAdvisoryNotice } from "../shared/plan-notes";
import { dispatchMarker } from "../activity/dispatch.js";
import { createPlanStore } from "../plans/store";
import { createDependencyStore } from "../dependencies/store";
import type { DependencyTask } from "../shared/contract";
import { activityService } from "../activity/index.js";
import { recordThreadLink } from "../lifecycle/thread-links";
import { DEFAULT_TASK_STATUSES, statusLabel } from "../shared/statuses.js";
import { effectiveInProgressStatus, getWorkflowPolicy } from "../shared/workflow-policy";
import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { createStructuredStore } from "../structured/store";
import type { TaskQuestion } from "../shared/contract";
import type {
  Attachment,
  Comment,
  Preset,
  Project,
  Task,
  TasksStore,
  TaskThreadLiveStatus,
} from "../db";
import {
  publishCommentsChanged,
  publishTasksChanged,
  type TasksApiStore,
} from "../api";
import {
  presetPermissionModeSchema,
  presetReasoningLevelSchema,
  presetServiceTierSchema,
  type ThreadsChangedEvent,
} from "../shared/contract";
import { errorMessage } from "../shared/errors";
import { truncateToWidth } from "../shared/text-measure";
import { delegationRpcContract } from "./contract";
import { MANUAL_PRESET_NAME, snapshotLateLink } from "./attach";

const MAX_DELEGATED_THREAD_TITLE_WIDTH = 120;
const SYSTEM_AUTHOR_NAME = "Work Board";

const presetExecutionSchema = z
  .object({
    providerId: z.string().trim().min(1),
    model: z.string().trim().min(1),
    reasoningLevel: presetReasoningLevelSchema,
    serviceTier: presetServiceTierSchema.nullable(),
    permissionMode: presetPermissionModeSchema,
  })
  .strict();

type DelegationErrorCode = "project_not_linked" | "spawn_target_invalid";

class DelegationError extends Error {
  constructor(
    readonly code: DelegationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DelegationError";
  }
}

interface SeedPromptInput {
  blockedBy?: readonly DependencyTask[];
  questions?: readonly TaskQuestion[];
  task: Task;
  project: Project;
  subtasks: readonly Task[];
  epic?: Task | null;
  attachments: readonly Pick<Attachment, "id" | "fileName">[];
  recentComments: readonly Comment[];
  presetInstructions: string;
  extraInstructions?: string;
  /** Set while the card's plan exists and is not approved. */
  planWarning?: string | null;
}

function markdownSection(title: string, body: string): string {
  return `## ${title}\n\n${body}`;
}

function formatSubtasks(subtasks: readonly Task[]): string {
  if (subtasks.length === 0) return "None.";
  return subtasks
    .map(
      (subtask) =>
        `- ${subtask.key} · ${subtask.title} (${subtask.status})`,
    )
    .join("\n");
}

function formatAttachments(
  attachments: readonly Pick<Attachment, "id" | "fileName">[],
): string {
  if (attachments.length === 0) return "None.";
  return attachments
    .map(
      (attachment) =>
        `- ${attachment.fileName} · ${attachment.id}\n` +
        `  Fetch with: bb work-board attachment get ${attachment.id} --out <path>`,
    )
    .join("\n");
}

function formatComments(comments: readonly Comment[]): string {
  if (comments.length === 0) return "None.";
  return comments
    .map(
      (comment) =>
        `### ${comment.authorName} · ${comment.kind} · ${comment.createdAt}\n\n${comment.body}`,
    )
    .join("\n\n");
}

function reportBackContract(key: string, project: Project): string {
  const policy = getWorkflowPolicy(project);
  const statuses = project.statuses?.length ? project.statuses : DEFAULT_TASK_STATUSES;
  const done = policy.reviewStatus
    ? `move the task to ${statusLabel(policy.reviewStatus, statuses)} (bb work-board update ${key} --status ${policy.reviewStatus})`
    : `move the task to the status that means review or done (bb work-board update ${key} --status <id>; ids: ${statuses.map((status) => status.id).join(", ")})`;
  return `You are working on task ${key}; this thread is attached to it and activity is tracked automatically. Keep Current state up to date with bb work-board update ${key} --progress "..." (done, next, waiting for): the owner reads it on the card. Post results and evidence as comments (bb work-board comment ${key} --body ...) and attach artifacts. When you need the owner, ask on the task with bb work-board question add ${key} --kind decision|check (steps in --step), not in chat or a comment. When done, ${done}. If this thread has a parent thread, tell it what it must act on with bb work-board report ${key} --kind ready|question|blocker --body "..." (ready when the work is ready, blocker when you are stuck; question and blocker also need --need "<what the parent must decide or do>"): Current state alone wakes nobody, and progress that asks nothing stays in --progress.`;
}

/**
 * The status move was skipped because the plan is not approved, but the prompt that was sent was built while it still
 * was: the executor gets one advisory notice. A failed delivery is only logged.
 */
export async function noticeSkippedMove(bb: BbPluginApi, store: TasksStore, task: Task, threadId: string): Promise<void> {
  const advisory = createPlanStore(bb.storage.database(), store).advisoryFor(task);
  if (!advisory) return;
  try {
    await notifyThread(bb, threadId, buildPlanAdvisoryNotice(task.key, advisory));
  } catch (error) {
    bb.log.warn(`failed to send the plan advisory of ${task.key} to ${threadId}: ${errorMessage(error)}`);
  }
}

export function buildSeedPrompt(input: SeedPromptInput): string {
  const sections = [
    `${dispatchMarker(input.task.id)}\n# ${input.task.key} · ${input.task.title}`,
    markdownSection(
      "Description",
      input.task.description.trim() || "No description provided.",
    ),
    markdownSection(
      "Project context",
      `- Name: ${input.project.name}\n- Linked bb project: ${input.project.linkedBbProjectId ?? "Not linked"}`,
    ),
    ...(input.epic
      ? [
          markdownSection(
            "Epic context",
            `${input.epic.key} · ${input.epic.title}\n\n${input.epic.description}`,
          ),
        ]
      : []),
    markdownSection(
      input.task.type === "epic" ? "Tasks in epic" : "Sub-tasks",
      formatSubtasks(input.subtasks),
    ),
    markdownSection("Attachments", formatAttachments(input.attachments)),
    markdownSection("Recent comments", formatComments(input.recentComments)),
    ...(input.blockedBy?.length ? [markdownSection("Dependency warning", `This task is blocked by unfinished predecessors:\n${input.blockedBy.map(task => `- ${task.key} · ${task.title} (${task.status})`).join("\n")}\nOnly Done satisfies a dependency. Work and status changes are allowed, but respect this ordering and report any blocker. Recheck with bb work-board dependency list ${input.task.key}.`)] : []),
    ...(input.planWarning ? [markdownSection("Plan warning", `${input.planWarning}. Wait for the approval, or ask the plan author, instead of starting. Read it with bb work-board plan show ${input.task.key}.`)] : []),
    ...(input.questions?.length
      ? [markdownSection("Questions", JSON.stringify(input.questions, null, 2))]
      : []),
    markdownSection(
      "Report-back contract",
      reportBackContract(input.task.key, input.project),
    ),
  ];

  if (input.presetInstructions.trim()) {
    sections.push(
      markdownSection("Preset instructions", input.presetInstructions.trim()),
    );
  }
  if (input.extraInstructions?.trim()) {
    sections.push(
      markdownSection(
        "Additional instructions",
        input.extraInstructions.trim(),
      ),
    );
  }

  return `${sections.join("\n\n")}\n`;
}

function taskEpic(store: TasksStore, task: Task): Task | null {
  const epicId =
    task.epicId ??
    (task.parentTaskId ? store.getTask(task.parentTaskId)?.epicId : null);
  return epicId ? (store.getTask(epicId) ?? null) : null;
}

function delegatedThreadTitle(task: Task): string {
  return truncateToWidth(
    `${task.key} · ${task.title}`,
    MAX_DELEGATED_THREAD_TITLE_WIDTH,
  );
}

function requireTask(store: TasksStore, taskId: string): Task {
  const task = store.getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  return task;
}

function requireProject(store: TasksStore, projectId: string): Project {
  const project = store.getProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);
  return project;
}

function requirePreset(store: TasksStore, presetId: string): Preset {
  const preset = store.getPreset(presetId);
  if (!preset) throw new Error(`Preset not found: ${presetId}`);
  return preset;
}

function requireLinkedBbProject(project: Project): string {
  if (project.linkedBbProjectId) return project.linkedBbProjectId;
  throw new DelegationError(
    "project_not_linked",
    `Task project "${project.name}" is not linked to a bb project`,
  );
}

function collectAttachments(
  store: TasksStore,
  taskId: string,
  comments: readonly Comment[],
): Attachment[] {
  const attachments = new Map<string, Attachment>();
  for (const attachment of store.listAttachmentsForTask(taskId)) {
    attachments.set(attachment.id, attachment);
  }
  for (const comment of comments) {
    for (const attachment of store.listAttachmentsForComment(comment.id)) {
      attachments.set(attachment.id, attachment);
    }
  }
  return [...attachments.values()];
}

type SpawnEnvironment = Parameters<
  BbPluginApi["sdk"]["threads"]["spawn"]
>[0]["environment"];

export async function presetSpawnEnvironment(
  bb: BbPluginApi,
  preset: Preset,
): Promise<SpawnEnvironment> {
  if (preset.environmentKind === "project-default") {
    return { type: "project-default" };
  }

  const hostId =
    preset.machineId ?? (await bb.sdk.system.config()).primaryHostId;
  if (hostId === null) {
    throw new DelegationError(
      "spawn_target_invalid",
      "Could not create a worktree because BB has no default machine",
    );
  }
  return {
    type: "host",
    hostId,
    workspace: {
      type: "managed-worktree",
      baseBranch:
        preset.baseBranch === null
          ? { kind: "default" }
          : { kind: "named", name: preset.baseBranch },
    },
  };
}

function isBbHttpError(
  error: unknown,
): error is Error & { code: string | null; status: number } {
  return (
    error instanceof Error &&
    "code" in error &&
    (typeof error.code === "string" || error.code === null) &&
    "status" in error &&
    typeof error.status === "number"
  );
}

const SPAWN_TARGET_ERROR_CODES = new Set([
  "host_not_found",
  "host_unavailable",
  "invalid_request",
  "project_unavailable",
  "unsupported_host",
  "workspace_unavailable",
]);

function mapSpawnTargetError(error: unknown, preset: Preset): never {
  if (
    preset.environmentKind === "new-worktree" &&
    isBbHttpError(error) &&
    error.code !== null &&
    SPAWN_TARGET_ERROR_CODES.has(error.code)
  ) {
    const machine = preset.machineId ?? "the default machine";
    const branch = preset.baseBranch ?? "the default branch";
    const detail = error.message.replace(/^HTTP \d+:\s*/u, "");
    throw new DelegationError(
      "spawn_target_invalid",
      `Could not create a worktree on ${machine} from ${branch}: ${detail}`,
    );
  }
  throw error;
}

export function createSystemComment(
  store: TasksStore,
  input: {
    taskId: string;
    presetName: string;
    threadId: string;
    body: string;
  },
): void {
  store.createComment({
    taskId: input.taskId,
    kind: "system",
    authorName: SYSTEM_AUTHOR_NAME,
    presetName: input.presetName,
    threadId: input.threadId,
    body: input.body,
  });
}

export function publishThreadsChanged(bb: BbPluginApi, taskId: string): void {
  const payload: ThreadsChangedEvent = { taskId };
  bb.realtime.publish("threads:changed", payload);
}

type SdkThread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;

function taskThreadLiveStatus(thread: SdkThread): TaskThreadLiveStatus {
  if (thread.deletedAt != null) return "completed";
  switch (thread.status) {
    case "pending":
    case "starting":
      return "starting";
    case "active":
    case "stopping":
      return "working";
    case "idle":
      return "idle";
    case "error":
      return "failed";
  }
}

export function handlers(
  bb: BbPluginApi,
  store: TasksApiStore,
): PluginRpcHandlers<typeof delegationRpcContract> {
  const dispatchableTask = (taskId: string) => {
    const task = requireTask(store.tasks, taskId);
    const source = bb.storage.database().prepare<[string], { role: string; started_at: string | null }>("SELECT role, started_at FROM task_scheduled_sources WHERE task_id=?").get(taskId);
    // Generic dispatch must not bypass scheduled reservation/acceptance or start a template itself.
    if (source && (source.role === "template" || source.started_at === null))
      throw new Error("Use Scheduled run-now or its queued-run controls; templates and pending occurrences cannot be dispatched directly");
    return task;
  };
  return {
    async delegateToThread(input) {
      const task = dispatchableTask(input.taskId);
      if (task.archivedAt) throw new Error("Restore the task before dispatching or changing worker links");
      const project = requireProject(store.tasks, task.projectId);
      const thread = await bb.sdk.threads.get({ threadId: input.threadId });
      if (
        thread.deletedAt != null ||
        thread.archivedAt != null ||
        thread.status === "stopping"
      ) {
        throw new Error(
          "Choose a thread that is not archived, deleted, or stopping",
        );
      }
      const comments = store.tasks.listComments(task.id);
      const planWarning = createPlanStore(bb.storage.database(), store.tasks).advisoryFor(task);
      const prompt = buildSeedPrompt({
        blockedBy: createDependencyStore(bb.storage.database(), store.tasks).blockers([task.id]).get(task.id),
        questions: createStructuredStore(bb, store).listQuestions(task.id),
        planWarning,
        task,
        project,
        subtasks:
          task.type === "epic"
            ? store.tasks.listTasks({ epicId: task.id })
            : store.tasks.listSubtasks(task.id),
        epic: taskEpic(store.tasks, task),
        attachments: collectAttachments(store.tasks, task.id, comments),
        recentComments: comments.slice(-5),
        presetInstructions: "",
        extraInstructions: input.extraInstructions,
      });
      const delivery = await bb.sdk.threads.send({
        threadId: thread.id,
        mode: "queue-if-active",
        input: [{ type: "text", text: withPluginHeader(bb.pluginId, prompt), mentions: [] }],
      });
      let skippedMove = false;
      let lateClosure: string | null = null;
      store.transaction(() => {
        const link = store.tasks.upsertTaskThread({
          taskId: task.id,
          threadId: thread.id,
          linkOrigin: "delegate_existing",
          presetName: "Existing thread",
          title: truncateToWidth(
            thread.title ?? thread.titleFallback ?? delegatedThreadTitle(task),
            MAX_DELEGATED_THREAD_TITLE_WIDTH,
          ),
          liveStatus: taskThreadLiveStatus(thread),
        });
        // The send above took time: the card and the project are read again here, so a card canceled meanwhile stays canceled.
        // A card whose plan is not approved stays where it is; the seed prompt carries the plan warning.
        const current = store.tasks.getTask(task.id) ?? task;
        const target = effectiveInProgressStatus(store.tasks.getProject(current.projectId) ?? project);
        if ((current.status === "backlog" || current.status === "todo") && target) {
          if (store.tasks.planGate(current, target)) skippedMove = true;
          else store.tasks.updateTask(task.id, { status: target });
        }
        createSystemComment(store.tasks, {
          taskId: task.id,
          presetName: "Existing thread",
          threadId: thread.id,
          body: `Dispatched to existing thread ${thread.title ?? thread.titleFallback ?? thread.id}`,
        });
        lateClosure = snapshotLateLink(store.tasks, task.id, link, false, "delegate_existing");
      });
      await store.closures.lateLink(lateClosure, thread.id);
      if (skippedMove && !planWarning) await noticeSkippedMove(bb, store.tasks, store.tasks.getTask(task.id) ?? task, thread.id);
      if (delivery?.delivery === "queued")
        activityService(bb, store).queued(task.id, thread.id, delivery.queuedMessage.id);
      publishThreadsChanged(bb, task.id);
      // The card may have changed projects during the dispatch: subscribers of its committed project hear about it.
      publishTasksChanged(bb, task.id, (store.tasks.getTask(task.id) ?? task).projectId);
      publishCommentsChanged(bb, task.id);
      return { threadId: thread.id };
    },
    async delegate(input) {
      const task = dispatchableTask(input.taskId);
      if (task.archivedAt) throw new Error("Restore the task before dispatching or changing worker links");
      const project = requireProject(store.tasks, task.projectId);
      const linkedBbProjectId = requireLinkedBbProject(project);
      const preset = requirePreset(store.tasks, input.presetId);
      const comments = store.tasks.listComments(task.id);
      const recentComments = comments.slice(-5);
      const title = delegatedThreadTitle(task);
      const execution = presetExecutionSchema.parse({
        providerId: preset.providerId,
        model: preset.modelId,
        reasoningLevel: preset.reasoningLevel,
        serviceTier: preset.serviceTier,
        permissionMode: preset.permissionMode,
      });
      const planWarning = createPlanStore(bb.storage.database(), store.tasks).advisoryFor(task);
      const prompt = buildSeedPrompt({
        blockedBy: createDependencyStore(bb.storage.database(), store.tasks).blockers([task.id]).get(task.id),
        questions: createStructuredStore(bb, store).listQuestions(task.id),
        planWarning,
        task,
        project,
        subtasks:
          task.type === "epic"
            ? store.tasks.listTasks({ epicId: task.id })
            : store.tasks.listSubtasks(task.id),
        epic: taskEpic(store.tasks, task),
        attachments: collectAttachments(store.tasks, task.id, comments),
        recentComments,
        presetInstructions: preset.instructions,
        extraInstructions: input.extraInstructions,
      });

      const environment = await presetSpawnEnvironment(bb, preset);
      // The server accepts parentNotifications on create, but the SDK typings omit it.
      const parentLink = {
        ...(input.parentThreadId
          ? { parentThreadId: input.parentThreadId }
          : {}),
        ...(input.parentThreadId && input.parentNotifications
          ? { parentNotifications: input.parentNotifications }
          : {}),
      };
      const thread = await bb.sdk.threads
        .spawn({
          projectId: linkedBbProjectId,
          environment,
          providerId: execution.providerId,
          model: execution.model,
          reasoningLevel: execution.reasoningLevel,
          ...(execution.serviceTier === null
            ? {}
            : { serviceTier: execution.serviceTier }),
          permissionMode: execution.permissionMode,
          title,
          prompt,
          ...parentLink,
        })
        .catch((error: unknown) => mapSpawnTargetError(error, preset));

      let skippedMove = false;
      let lateClosure: string | null = null;
      const taskThread = store.transaction(() => {
        const attached = store.tasks.upsertTaskThread({
          taskId: task.id,
          threadId: thread.id,
          presetName: preset.name,
          title,
          liveStatus: "starting",
          linkOrigin: "delegate_spawn",
          createdForTask: true,
        });

        // The spawn above took time: the card and the project are read again here, so a card canceled meanwhile stays canceled.
        const current = store.tasks.getTask(task.id) ?? task;
        // The card may have changed projects meanwhile; its own project decides the target status.
        const freshProject = store.tasks.getProject(current.projectId) ?? project;
        const inProgress = effectiveInProgressStatus(freshProject);
        if ((current.status === "backlog" || current.status === "todo") && inProgress && store.tasks.planGate(current, inProgress)) skippedMove = true;
        else if ((current.status === "backlog" || current.status === "todo") && inProgress) {
          store.tasks.updateTask(task.id, { status: inProgress });
          createSystemComment(store.tasks, {
            taskId: task.id,
            presetName: preset.name,
            threadId: thread.id,
            body: `Status changed to ${statusLabel(inProgress, freshProject.statuses)} · dispatched to ${preset.name}`,
          });
        }

        createSystemComment(store.tasks, {
          taskId: task.id,
          presetName: preset.name,
          threadId: thread.id,
          body: `Dispatched to ${preset.name}`,
        });
        lateClosure = snapshotLateLink(store.tasks, task.id, attached, true, "delegate_spawn");
        return attached;
      });
      await store.closures.lateLink(lateClosure, thread.id);

      if (skippedMove && !planWarning) await noticeSkippedMove(bb, store.tasks, store.tasks.getTask(task.id) ?? task, thread.id);
      try {
        const currentThread = await bb.sdk.threads.get({ threadId: thread.id });
        const currentLiveStatus = taskThreadLiveStatus(currentThread);
        if (currentLiveStatus !== taskThread.liveStatus) {
          store.tasks.updateTaskThreadStatus(taskThread.id, currentLiveStatus);
        }
      } catch (error) {
        bb.log.warn(
          `Could not read delegated thread ${thread.id} after attach: ${errorMessage(
            error,
          )}`,
        );
      }

      publishThreadsChanged(bb, task.id);
      // The card may have changed projects during the dispatch: subscribers of its committed project hear about it.
      publishTasksChanged(bb, task.id, (store.tasks.getTask(task.id) ?? task).projectId);
      publishCommentsChanged(bb, task.id);
      return { threadId: thread.id };
    },

    async taskThreadsAttach(input) {
      const task = dispatchableTask(input.taskId);
      if (task.archivedAt) throw new Error("Restore the task before dispatching or changing worker links");
      const thread = await bb.sdk.threads.get({ threadId: input.threadId });
      if (
        thread.archivedAt != null ||
        thread.deletedAt != null ||
        thread.status === "stopping"
      )
        throw new Error(
          "Choose a thread that is not archived, deleted, or stopping",
        );
      const existing = store.tasks.getTaskThreadByThreadId(task.id, thread.id);
      const title = truncateToWidth(
        thread.title ?? thread.titleFallback ?? delegatedThreadTitle(task),
        MAX_DELEGATED_THREAD_TITLE_WIDTH,
      );

      store.transaction(() => {
        store.tasks.upsertTaskThread({
          taskId: task.id,
          threadId: thread.id,
          presetName: MANUAL_PRESET_NAME,
          title,
          liveStatus: taskThreadLiveStatus(thread),
          linkOrigin: "manual",
        });

        if (!existing) {
          recordThreadLink(
            store.tasks,
            task.id,
            thread.id,
            `Thread attached: @thread:${thread.id}`,
          );
        }
      });
      if (!existing) publishCommentsChanged(bb, task.id);
      publishThreadsChanged(bb, task.id);
      publishTasksChanged(bb, task.id, task.projectId);
      return { threadId: thread.id };
    },

    async taskThreadsDetach(input) {
      const task = requireTask(store.tasks, input.taskId);
      if (task.archivedAt) throw new Error("Restore the task before dispatching or changing worker links");
      const taskThread = store.tasks.getTaskThreadByThreadId(
        task.id,
        input.threadId,
      );
      if (!taskThread) {
        throw new Error(
          `Thread ${input.threadId} is not attached to ${task.key}`,
        );
      }
      store.transaction(() => {
        store.tasks.deleteTaskThread(taskThread.id);
        recordThreadLink(
          store.tasks,
          task.id,
          taskThread.threadId,
          `Thread detached (manual): @thread:${taskThread.threadId} (attached ${taskThread.attachedAt})`,
        );
      });
      publishCommentsChanged(bb, task.id);
      publishThreadsChanged(bb, task.id);
      publishTasksChanged(bb, task.id, task.projectId);
      return { threadId: taskThread.threadId };
    },
  };
}

export function registerDelegation(
  bb: BbPluginApi,
  store: TasksApiStore,
): void {
  bb.rpc.register(delegationRpcContract, handlers(bb, store));
}
