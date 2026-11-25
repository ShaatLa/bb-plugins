import type { TaskThread, TaskThreadLiveStatus, TasksStore } from "../db";
import { isClosedStatus } from "../shared/workflow-policy";
import { recordThreadLink } from "../lifecycle/thread-links";

/** The preset label of a link a person or a session made by hand. */
export const MANUAL_PRESET_NAME = "Attached";

/**
 * A manual link for a session that is not on the card yet, written inside the caller's transaction. It re-checks the
 * local role conditions at write time: an existing link is never overwritten (that would erase its provenance), and a
 * session whose parent already holds the card is a helper, not a worker. Returns whether the link was made.
 */
export function attachManualLink(
  tasks: TasksStore,
  taskId: string,
  thread: { threadId: string; parentThreadId: string | null; title: string; liveStatus: TaskThreadLiveStatus },
): boolean {
  if (tasks.getTaskThreadByThreadId(taskId, thread.threadId)) return false;
  if (!thread.parentThreadId) return false;
  if (tasks.closures.holders(taskId).includes(thread.parentThreadId)) return false;
  tasks.upsertTaskThread({ taskId, threadId: thread.threadId, presetName: MANUAL_PRESET_NAME, title: thread.title, liveStatus: thread.liveStatus, linkOrigin: "manual" });
  recordThreadLink(tasks, taskId, thread.threadId, `Thread attached: @thread:${thread.threadId}`);
  return true;
}

/**
 * A link written while its card is closed gets its own snapshot row under the current closure (and upgrades a kept row
 * of the same thread when it is a spawn). Returns the closure id to settle after the commit, or null.
 */
export function snapshotLateLink(tasks: TasksStore, taskId: string, link: TaskThread, spawned: boolean, origin: string): string | null {
  const task = tasks.getTask(taskId);
  const project = task && tasks.getProject(task.projectId);
  if (!task || !project || !isClosedStatus(project, task.status)) return null;
  return tasks.closures.addLate(taskId, { id: link.id, threadId: link.threadId, liveStatus: link.liveStatus, spawned, origin }, project.archiveThreadsOnClose !== "off");
}
