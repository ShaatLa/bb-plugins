import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { publishCommentsChanged, type TasksApiStore } from "../api";
import type { TaskThread, TaskThreadLiveStatus } from "../db";
import { createSystemComment, publishThreadsChanged } from "../delegate";
import { errorMessage } from "../shared/errors";
import { reconcileTaskThreads } from "./thread-links";
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
  // Completed scheduled results keep provenance, not perpetual startup SDK reads.
  const ids = bb.storage.database().prepare<[], { id: string }>(`SELECT t.id FROM tasks t
    WHERE EXISTS (SELECT 1 FROM task_threads tt WHERE tt.task_id=t.id)
      AND NOT EXISTS (SELECT 1 FROM task_scheduled_sources ss WHERE ss.task_id=t.id AND
        (ss.role='template' OR ss.started_at IS NULL OR t.status IN ('done','canceled')))`
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
  bb.events.on("thread.created", ({ thread }) => {
    attachNamedTaskThread(bb, store, thread);
    transitionTrackedThread(bb, store, thread.id, liveStatusFromThread(thread));
  });
  bb.events.on("thread.active", ({ thread }) => {
    attachNamedTaskThread(bb, store, thread);
    transitionTrackedThread(bb, store, thread.id, "working");
  });
  bb.events.on("thread.idle", ({ thread }) => {
    transitionTrackedThread(bb, store, thread.id, "idle");
  });
  bb.events.on("thread.failed", ({ thread }) => {
    transitionTrackedThread(bb, store, thread.id, "failed");
  });
  bb.events.on("thread.deleted", ({ thread }) => {
    transitionTrackedThread(bb, store, thread.id, "completed");
  });

  bb.events.on("thread.archived", async ({ thread }) => {
    for (const link of store.tasks.listTaskThreadsByThreadId(thread.id)) {
      await reconcileTaskThreads(bb, store.tasks, link.taskId, thread);
    }
  });

  await reconcileTrackedThreads(bb, store);
}
