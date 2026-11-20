import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TaskThread, TaskThreadLiveStatus, TasksStore } from "../db";
import { isClosedStatus } from "../shared/workflow-policy";
import { recordThreadLink } from "../lifecycle/thread-links";

/** The preset label of a link a person or a session made by hand. */
export const MANUAL_PRESET_NAME = "Attached";

/** Whether a card may take a worker link: templates and pending scheduled occurrences are started by Scheduled only. */
export function canTakeWorkerLink(bb: BbPluginApi, taskId: string): boolean {
  const source = bb.storage.database().prepare<[string], { role: string; started_at: string | null }>("SELECT role, started_at FROM task_scheduled_sources WHERE task_id=?").get(taskId);
  return !source || (source.role !== "template" && source.started_at !== null);
}

/** A manual link, written inside the caller's transaction; the system line is written only for a new link. */
export function attachManualLink(
  tasks: TasksStore,
  taskId: string,
  thread: { threadId: string; title: string; liveStatus: TaskThreadLiveStatus },
): boolean {
  const existing = tasks.getTaskThreadByThreadId(taskId, thread.threadId);
  tasks.upsertTaskThread({ taskId, threadId: thread.threadId, presetName: MANUAL_PRESET_NAME, title: thread.title, liveStatus: thread.liveStatus, linkOrigin: "manual" });
  if (!existing) recordThreadLink(tasks, taskId, thread.threadId, `Thread attached: @thread:${thread.threadId}`);
  return !existing;
}

/**
 * A link written while its card is closed gets its own snapshot row under the current closure (and upgrades a kept row
 * of the same thread when it is a spawn). Returns the closure id to settle after the commit, or null.
 */
export function snapshotLateLink(tasks: TasksStore, taskId: string, link: TaskThread, spawned: boolean): string | null {
  const task = tasks.getTask(taskId);
  const project = task && tasks.getProject(task.projectId);
  if (!task || !project || !isClosedStatus(project, task.status)) return null;
  return tasks.closures.addLate(taskId, { id: link.id, threadId: link.threadId, liveStatus: link.liveStatus, spawned }, project.archiveThreadsOnClose !== "off");
}
