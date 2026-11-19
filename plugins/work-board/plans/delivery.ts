import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TasksStore } from "../db";
import { errorMessage } from "../shared/errors";
import { defaultTaskThreadId, notifyThread } from "../steer";

export type PlanDelivery = "sent" | "failed" | "no_thread";

/**
 * Where a plan review message goes: the session that wrote the newest agent version of the plan (unless it is
 * archived or deleted), else the thread a question answer would go to. Null when there is none.
 */
export async function planReviewThread(bb: BbPluginApi, tasks: TasksStore, taskId: string, authorThread: string | null): Promise<string | null> {
  if (authorThread) {
    try {
      const thread = await bb.sdk.threads.get({ threadId: authorThread });
      if (thread.archivedAt == null && thread.deletedAt == null) return authorThread;
    } catch {
      // A thread that cannot be read cannot be woken either; fall through to the task's own thread.
    }
  }
  return defaultTaskThreadId(tasks, taskId) ?? null;
}

/** Wakes the plan's agent with `text`. A failure never throws: the review is already saved, and the caller reports it. */
export async function deliverPlanReview(
  bb: BbPluginApi,
  tasks: TasksStore,
  input: { taskId: string; authorThread: string | null; text: string },
): Promise<{ delivered: PlanDelivery; threadId: string | null }> {
  const threadId = await planReviewThread(bb, tasks, input.taskId, input.authorThread);
  if (!threadId) return { delivered: "no_thread", threadId: null };
  try {
    await notifyThread(bb, threadId, input.text);
    return { delivered: "sent", threadId };
  } catch (error) {
    bb.log.warn(`failed to deliver the plan review of ${input.taskId} to ${threadId}: ${errorMessage(error)}`);
    return { delivered: "failed", threadId };
  }
}
