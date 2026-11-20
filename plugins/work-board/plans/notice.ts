import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TasksStore } from "../db";
import { errorMessage } from "../shared/errors";
import type { PlanState } from "../shared/plan";
import { buildLeftApprovedNotice } from "../shared/plan-notes";
import { inWorkZone } from "../shared/workflow-policy";
import { notifyThread } from "../steer";

/**
 * A plan left `approved` while its card is in the In progress status: the active threads linked to the card hear about
 * it once, for information. The thread that made the change and `exclude` (the threads that already get the decision
 * message for this change) are left out. A failed delivery is only logged: the change is saved.
 */
export async function noticeLeftApproved(
  bb: BbPluginApi,
  tasks: TasksStore,
  input: { taskId: string; version: number; state: PlanState; reason: string; changedBy: string | null; exclude?: ReadonlyArray<string | null> },
): Promise<void> {
  const task = tasks.getTask(input.taskId);
  const project = task && tasks.getProject(task.projectId);
  if (!task || !project || !inWorkZone(project, task.status)) return;
  const skip = new Set([input.changedBy, ...(input.exclude ?? [])]);
  const threads = new Set(
    tasks
      .listTaskThreads(task.id)
      .filter((link) => link.presetName !== "Parent thread" && link.liveStatus !== "completed" && link.liveStatus !== "failed" && !skip.has(link.threadId))
      .map((link) => link.threadId),
  );
  const text = buildLeftApprovedNotice({ taskKey: task.key, version: input.version, state: input.state, reason: input.reason });
  for (const threadId of threads) {
    try {
      await notifyThread(bb, threadId, text);
    } catch (error) {
      bb.log.warn(`failed to tell ${threadId} that the plan of ${task.key} left approval: ${errorMessage(error)}`);
    }
  }
}
