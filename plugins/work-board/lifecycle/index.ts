import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { publishCommentsChanged, type TasksApiStore } from "../api";
import type { TaskThread, TaskThreadLiveStatus } from "../db";
import { createSystemComment, publishThreadsChanged } from "../delegate";
import { errorMessage } from "../shared/errors";
import { reconcileTaskThreads } from "./thread-links";

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

function trackedThreads(store: TasksApiStore): TaskThread[] {
  const tracked: TaskThread[] = [];
  for (const task of store.tasks.listTasks()) {
    for (const thread of store.tasks.listTaskThreads(task.id)) {
      tracked.push(thread);
    }
  }
  return tracked;
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

  store.transaction(() => {
    store.tasks.updateTaskThreadStatus(thread.id, liveStatus);
    if (liveStatus === "completed" || liveStatus === "failed") {
      createSystemComment(store.tasks, {
        taskId: thread.taskId,
        presetName: thread.presetName,
        threadId: thread.threadId,
        body: statusCommentBody(thread, liveStatus),
      });
    }
  });

  publishThreadsChanged(bb, thread.taskId);
  publishCommentsChanged(bb, thread.taskId);
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
): Promise<void> {
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
    bb.log.warn(
      `Could not reconcile task thread ${trackedThread.threadId}: ${errorMessage(
        error,
      )}`,
    );
  }
}

const RECONCILE_CONCURRENCY = 4;

async function reconcileTrackedThreads(
  bb: BbPluginApi,
  store: TasksApiStore,
): Promise<void> {
  const groups = new Map<string, TaskThread[]>();
  for (const link of trackedThreads(store)) {
    const group = groups.get(link.threadId) ?? [];
    group.push(link);
    groups.set(link.threadId, group);
  }
  const queue = [...groups.values()];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift())
      await reconcileTrackedThread(bb, store, next);
  };
  await Promise.all(Array.from({ length: RECONCILE_CONCURRENCY }, worker));
}

export async function registerLifecycle(
  bb: BbPluginApi,
  store: TasksApiStore,
): Promise<void> {
  bb.events.on("thread.created", ({ thread }) => {
    transitionTrackedThread(bb, store, thread.id, liveStatusFromThread(thread));
  });
  bb.events.on("thread.active", ({ thread }) => {
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
