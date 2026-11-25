import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { publishCommentsChanged, type TasksApiStore } from "../api";
import type { TaskThread, TaskThreadLiveStatus } from "../db";
import { createSystemComment, publishThreadsChanged } from "../delegate";
import { errorMessage } from "../shared/errors";
import { reconcileTaskThreads, recordThreadLink } from "./thread-links";
import { isClosedStatus } from "../shared/workflow-policy";
import { attachNamedTaskThread } from "./discovery";

const TERMINAL_LIVE_STATUSES = new Set<TaskThreadLiveStatus>(["completed"]);

type SdkThread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;

function liveStatusFromThread(thread: SdkThread): TaskThreadLiveStatus {
  if (thread.status === "error") return "failed";
  if (thread.deletedAt !== null) return "completed";

  switch (thread.status) {
    case "pending":
    case "starting":
      return "starting";
    case "active":
    case "stopping":
      return "working";
    case "idle":
      return "idle";
  }
}

function trackedThreads(bb: BbPluginApi, store: TasksApiStore): TaskThread[] {
  const ids = bb.storage.database().prepare<[], { id: string }>(`SELECT t.id FROM tasks t
    WHERE EXISTS (SELECT 1 FROM task_threads tt WHERE tt.task_id=t.id)`
  ).all().map(row => row.id);
  const links: TaskThread[] = [];
  for (let offset = 0; offset < ids.length; offset += 500)
    links.push(...store.tasks.listTaskThreadsForTasks(ids.slice(offset, offset + 500)));
  return links;
}

function statusCommentBody(
  thread: TaskThread,
  liveStatus: Extract<TaskThreadLiveStatus, "completed" | "failed">,
): string {
  const outcome =
    liveStatus === "completed" ? "completed — final message posted" : "failed";
  return `Thread "${thread.title}" ${outcome} · ${thread.threadId}`;
}

function sdkErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

/**
 * A done or canceled card keeps a thread only while that thread works on it. When the thread goes idle, or starts a
 * new turn after the card was closed, the link is released: later work is elsewhere, so the card neither warns nor
 * counts its cost.
 */
function releaseFromClosedTask(bb: BbPluginApi, store: TasksApiStore, thread: TaskThread, liveStatus: "working" | "idle"): boolean {
  // One indexed read: lifecycle events are hot and query-counted.
  const task = bb.storage.database().prepare<[string], { id: string; key: string; status: string; policy: string | null }>(
    "SELECT t.id, p.prefix || '-' || t.number AS key, t.status, p.workflow_policy AS policy FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?",
  ).get(thread.taskId);
  if (!task || !isClosedStatus({ workflowPolicy: task.policy ? JSON.parse(task.policy) : null }, task.status)) return false;
  // A session whose archive is still to be decided keeps its link until the decision is made (and releases it once then).
  if (store.tasks.closures.holdsLink(task.id, thread.threadId)) return false;
  store.transaction(() => {
    store.tasks.deleteTaskThread(thread.id);
    recordThreadLink(store.tasks, task.id, thread.threadId,
      `Thread detached (automatic): @thread:${thread.threadId} ${liveStatus === "idle" ? "finished its turn" : "started new work"} after ${task.key} was closed`);
  });
  publishThreadsChanged(bb, task.id);
  publishCommentsChanged(bb, task.id);
  return true;
}

function transitionThread(
  bb: BbPluginApi,
  store: TasksApiStore,
  thread: TaskThread,
  liveStatus: TaskThreadLiveStatus,
): void {
  if (
    thread.liveStatus === liveStatus ||
    TERMINAL_LIVE_STATUSES.has(thread.liveStatus)
  ) {
    return;
  }
  if ((liveStatus === "working" || liveStatus === "idle") && releaseFromClosedTask(bb, store, thread, liveStatus)) return;

  let commented = false;
  store.transaction(() => {
    store.tasks.updateTaskThreadStatus(thread.id, liveStatus);
    if (liveStatus === "completed" || liveStatus === "failed") {
      const body = statusCommentBody(thread, liveStatus);
      // A flapping thread (failed -> working -> failed) must not repeat the same note.
      const seen = bb.storage.database().prepare<[string, string, string], { one: number }>(
        `SELECT 1 AS one FROM comments
         WHERE task_id=? AND thread_id=? AND kind='system' AND body=? LIMIT 1`,
      ).get(thread.taskId, thread.threadId, body);
      if (seen) return;
      createSystemComment(store.tasks, {
        taskId: thread.taskId,
        presetName: thread.presetName,
        threadId: thread.threadId,
        body,
      });
      commented = true;
    }
  });

  publishThreadsChanged(bb, thread.taskId);
  if (commented) publishCommentsChanged(bb, thread.taskId);
}

function transitionTrackedThread(
  bb: BbPluginApi,
  store: TasksApiStore,
  threadId: string,
  liveStatus: TaskThreadLiveStatus,
): void {
  for (const thread of store.tasks.listTaskThreadsByThreadId(threadId)) {
    transitionThread(bb, store, thread, liveStatus);
  }
}

async function reconcileTrackedThread(
  bb: BbPluginApi,
  store: TasksApiStore,
  trackedThreads: TaskThread[],
): Promise<string | undefined> {
  const trackedThread = trackedThreads[0]!;
  try {
    const thread = await bb.sdk.threads.get({
      threadId: trackedThread.threadId,
    });
    for (const link of trackedThreads) {
      const current = store.tasks.getTaskThread(link.id);
      if (!current || current.updatedAt !== link.updatedAt || current.liveStatus !== link.liveStatus) continue;
      if (thread.archivedAt != null || thread.deletedAt != null) {
        await reconcileTaskThreads(bb, store.tasks, link.taskId, thread);
      } else {
        transitionThread(bb, store, link, liveStatusFromThread(thread));
      }
    }
  } catch (error) {
    if (sdkErrorCode(error) === "thread_not_found") {
      for (const link of trackedThreads)
        await reconcileTaskThreads(bb, store.tasks, link.taskId);
      return;
    }
    return errorMessage(error);
  }
}

const RECONCILE_CONCURRENCY = 4;

async function reconcileTrackedThreads(
  bb: BbPluginApi,
  store: TasksApiStore,
): Promise<void> {
  const groups = new Map<string, TaskThread[]>();
  for (const link of trackedThreads(bb, store)) {
    const group = groups.get(link.threadId) ?? [];
    group.push(link);
    groups.set(link.threadId, group);
  }
  const queue = [...groups.values()];
  const failures = new Map<string, number>();
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const failure = await reconcileTrackedThread(bb, store, next);
      if (failure) failures.set(failure, (failures.get(failure) ?? 0) + 1);
    }
  };
  await Promise.all(Array.from({ length: RECONCILE_CONCURRENCY }, worker));
  // One line per distinct error per sweep: an outage fails every thread alike.
  for (const [message, count] of failures)
    bb.log.warn(`Could not reconcile ${count} task thread(s): ${message}`);
}

export async function registerLifecycle(
  bb: BbPluginApi,
  store: TasksApiStore,
): Promise<void> {
  // A restart cannot tell a missed idle from none: pending intents are retired, and nothing is archived by startup.
  const { unknownNotices } = store.tasks.closures.recoverOnStartup();
  if (unknownNotices) bb.log.warn(`${unknownNotices} closed-card notice(s) were interrupted by a restart; their delivery is unknown and they are not resent`);
  bb.events.on("thread.created", ({ thread }) => {
    attachNamedTaskThread(bb, store, thread);
    transitionTrackedThread(bb, store, thread.id, liveStatusFromThread(thread));
  });
  bb.events.on("thread.active", async ({ thread }) => {
    // Before any await: a new turn ends every turn-bound archive intent of this thread, and reserves its comparison.
    const kept = store.tasks.closures.markActive(thread.id);
    const started = store.closures.turnStarted(thread, kept).catch((error) => bb.log.warn(`Could not sample ${thread.id} at its turn start: ${errorMessage(error)}`));
    attachNamedTaskThread(bb, store, thread);
    transitionTrackedThread(bb, store, thread.id, "working");
    await started;
  });
  bb.events.on("thread.idle", async ({ thread }) => {
    // Claimed synchronously, so the release below keeps the link of a session whose archive is being decided.
    const claimed = store.closures.claimIdle(thread.id);
    // Taken synchronously too; the Git reads and notices run beside the archive decisions, which never wait on them.
    const ended = store.closures.turnEnded(thread).catch((error) => bb.log.warn(`Could not compare ${thread.id} at its turn end: ${errorMessage(error)}`));
    transitionTrackedThread(bb, store, thread.id, "idle");
    await store.closures.settleIdle(claimed);
    await store.closures.reviewerIdle(thread.id);
    await ended;
  });
  bb.events.on("thread.failed", ({ thread }) => {
    store.closures.turnAbandoned(thread.id);
    transitionTrackedThread(bb, store, thread.id, "failed");
  });
  bb.events.on("thread.deleted", ({ thread }) => {
    store.closures.turnAbandoned(thread.id);
    transitionTrackedThread(bb, store, thread.id, "completed");
  });

  bb.events.on("thread.archived", async ({ thread }) => {
    store.closures.turnAbandoned(thread.id);
    for (const link of store.tasks.listTaskThreadsByThreadId(thread.id)) {
      // An archive this plugin made for the card: only that link goes, with no fallback parent and no second line.
      // Only the link the archive was decided for goes; a reattached pair is reconciled like any other.
      const own = store.tasks.closures.ownArchive(link.taskId, thread.id);
      if (own && own.linkId === link.id && store.tasks.closures.linkUnchanged(own)) {
        store.tasks.deleteTaskThread(link.id);
        publishThreadsChanged(bb, link.taskId);
        continue;
      }
      await reconcileTaskThreads(bb, store.tasks, link.taskId, thread);
    }
  });
  bb.events.on("thread.unarchived", ({ thread }) => {
    store.tasks.closures.clearArchived(thread.id);
  });

  await reconcileTrackedThreads(bb, store);
}
