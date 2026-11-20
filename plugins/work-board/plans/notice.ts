import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TasksStore } from "../db";
import { errorMessage } from "../shared/errors";
import type { PlanState } from "../shared/plan";
import { buildLeftApprovedNotice } from "../shared/plan-notes";
import { inWorkNow } from "../shared/workflow-policy";
import { notifyThread } from "../steer";

/**
 * A plan left `approved` while its card is in the work zone: the linked threads that are executing now hear about
 * it once, for information. The thread that made the change and `exclude` (the threads that already get the decision
 * message for this change) are left out. A failed delivery is only logged: the change is saved.
 */
/** Whether the card is "in work" right now. Callers read it at the committed transition, before they await any delivery. */
export function cardInWork(tasks: TasksStore, taskId: string): boolean {
  const task = tasks.getTask(taskId);
  const project = task && tasks.getProject(task.projectId);
  return Boolean(task && project && inWorkNow(project, task.status));
}

/**
 * Whether a thread is executing now, read from the live thread, not from a link: a link's name or stored state says nothing about whether
 * it is running. A thread the platform confirms gone, archived or idle is `inactive`; any other failed lookup is `unknown`, because that
 * thread's state is not known, which is not the same as inactive.
 */
export async function threadActivity(bb: BbPluginApi, threadId: string): Promise<"active" | "inactive" | "unknown"> {
  try {
    const thread = await bb.sdk.threads.get({ threadId });
    return thread.archivedAt == null && thread.deletedAt == null && (thread.status === "active" || thread.status === "starting") ? "active" : "inactive";
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "thread_not_found" ? "inactive" : "unknown";
  }
}

/** The card's linked thread ids, each once. */
export const linkedThreads = (tasks: TasksStore, taskId: string): string[] => [...new Set(tasks.listTaskThreads(taskId).map((link) => link.threadId))];

/** The executors that can be told now; a thread whose lookup failed cannot be told either. */
export async function activeExecutors(bb: BbPluginApi, tasks: TasksStore, taskId: string, skip: ReadonlySet<string | null> = new Set()): Promise<string[]> {
  const active: string[] = [];
  for (const threadId of linkedThreads(tasks, taskId)) if (!skip.has(threadId) && (await threadActivity(bb, threadId)) === "active") active.push(threadId);
  return active;
}

export async function noticeLeftApproved(
  bb: BbPluginApi,
  tasks: TasksStore,
  input: { taskId: string; version: number; state: PlanState; reason: string; changedBy: string | null; exclude?: ReadonlyArray<string | null>; /** Eligibility captured at the commit; read now when absent. */ inWork?: boolean },
): Promise<void> {
  const task = tasks.getTask(input.taskId);
  const project = task && tasks.getProject(task.projectId);
  if (!task || !project || !(input.inWork ?? inWorkNow(project, task.status))) return;
  const threads = await activeExecutors(bb, tasks, task.id, new Set([input.changedBy, ...(input.exclude ?? [])]));
  const text = buildLeftApprovedNotice({ taskKey: task.key, version: input.version, state: input.state, reason: input.reason });
  for (const threadId of threads) {
    try {
      await notifyThread(bb, threadId, text);
    } catch (error) {
      bb.log.warn(`failed to tell ${threadId} that the plan of ${task.key} left approval: ${errorMessage(error)}`);
    }
  }
}
