import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TasksStore, TaskThread, TaskThreadLiveStatus } from "../db";
import { isSideChatShapedThread } from "../shared/side-chat";
import { errorMessage } from "../shared/errors";

type SdkThread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;
const pending = new WeakMap<TasksStore, Map<string, Promise<TaskThread[]>>>();

export function threadUnavailable(thread: SdkThread): boolean {
  return (
    thread.archivedAt != null ||
    thread.deletedAt != null ||
    isSideChatShapedThread(thread)
  );
}

export function threadLiveStatus(thread: SdkThread): TaskThreadLiveStatus {
  if (thread.status === "error") return "failed";
  if (thread.status === "pending" || thread.status === "starting")
    return "starting";
  return thread.status === "idle" ? "idle" : "working";
}

export function recordThreadLink(
  store: TasksStore,
  taskId: string,
  threadId: string,
  body: string,
) {
  store.createComment({
    taskId,
    threadId,
    kind: "system",
    authorName: "Tasks Plus",
    body,
  });
}

async function reconcile(
  bb: BbPluginApi,
  store: TasksStore,
  taskId: string,
  known?: SdkThread,
): Promise<TaskThread[]> {
  const links = store.listTaskThreads(taskId);
  if (!links.length) return links;
  const inherited = new Set<string>();
  for (const comment of store.listComments(taskId)) {
    if (comment.kind !== "system" || !comment.threadId) continue;
    if (comment.body.startsWith("Thread attached (parent fallback):"))
      inherited.add(comment.threadId);
    else if (
      comment.body.startsWith("Thread attached:") ||
      comment.body.startsWith("Thread detached")
    )
      inherited.delete(comment.threadId);
  }
  const snapshots = new Map<string, SdkThread | null>();
  if (known) snapshots.set(known.id, known);
  const get = async (threadId: string): Promise<SdkThread | null> => {
    if (snapshots.has(threadId)) return snapshots.get(threadId)!;
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      snapshots.set(threadId, thread);
      return thread;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "thread_not_found"
      ) {
        snapshots.set(threadId, null);
        return null;
      }
      throw error;
    }
  };
  try {
    for (const link of links) await get(link.threadId);
    const unavailable = links.filter((link) => {
      const thread = snapshots.get(link.threadId);
      return !thread || threadUnavailable(thread);
    });
    const hasWorker = links.some((link) => {
      const thread = snapshots.get(link.threadId);
      return (
        !inherited.has(link.threadId) &&
        thread &&
        !threadUnavailable(thread) &&
        thread.status !== "stopping"
      );
    });
    let parent: SdkThread | null = null;
    if (unavailable.length === links.length) {
      const latest = [...links].sort(
        (a, b) =>
          b.attachedAt.localeCompare(a.attachedAt) || b.id.localeCompare(a.id),
      )[0]!;
      const source = snapshots.get(latest.threadId);
      if (source && !isSideChatShapedThread(source)) {
        const visited = new Set([source.id]);
        let ancestorId = source.parentThreadId;
        while (ancestorId && !visited.has(ancestorId)) {
          visited.add(ancestorId);
          const candidate = await get(ancestorId);
          if (!candidate || isSideChatShapedThread(candidate)) break;
          if (
            !threadUnavailable(candidate) &&
            candidate.status !== "stopping"
          ) {
            parent = candidate;
            break;
          }
          ancestorId = candidate.parentThreadId;
        }
      }
    }
    let changed = false;
    let historyChanged = false;
    let removed = false;
    bb.storage.database().transaction(() => {
      for (const link of links) {
        const current = store.getTaskThread(link.id);
        if (!current || current.updatedAt !== link.updatedAt) continue;
        const thread = snapshots.get(link.threadId);
        const replacedParent = inherited.has(link.threadId) && hasWorker;
        if (!thread || threadUnavailable(thread) || replacedParent) {
          store.deleteTaskThread(link.id);
          const reason = replacedParent
            ? "replaced"
            : !thread
              ? "missing"
              : thread.archivedAt != null
                ? "archived"
                : thread.deletedAt != null
                  ? "deleted"
                  : "private";
          recordThreadLink(
            store,
            taskId,
            link.threadId,
            `Thread detached (${reason}): @thread:${link.threadId} (attached ${link.attachedAt})`,
          );
          changed = historyChanged = removed = true;
        } else if (link.liveStatus !== threadLiveStatus(thread)) {
          store.updateTaskThreadStatus(link.id, threadLiveStatus(thread));
          changed = true;
        }
      }
      if (
        parent &&
        removed &&
        store.listTaskThreads(taskId).length === 0 &&
        store.getTask(taskId)?.executionTarget !== "owner"
      ) {
        store.upsertTaskThread({
          taskId,
          threadId: parent.id,
          presetName: "Parent thread",
          title: parent.title ?? parent.titleFallback ?? parent.id,
          liveStatus: threadLiveStatus(parent),
        });
        recordThreadLink(
          store,
          taskId,
          parent.id,
          `Thread attached (parent fallback): @thread:${parent.id}`,
        );
        snapshots.set(parent.id, parent);
        changed = historyChanged = true;
      }
    })();
    if (changed) {
      bb.realtime.publish("threads:changed", { taskId });
      const task = store.getTask(taskId)!;
      bb.realtime.publish("tasks:changed", {
        taskId,
        projectId: task.projectId,
      });
      if (historyChanged) bb.realtime.publish("comments:changed", { taskId });
    }
    return store
      .listTaskThreads(taskId)
      .filter((link) => snapshots.get(link.threadId)?.status !== "stopping");
  } catch (error) {
    // Keep associations on lookup failures; a network outage is not an archive event.
    bb.log.warn(
      `Could not reconcile task threads for ${taskId}: ${errorMessage(error)}`,
    );
    return store.listTaskThreads(taskId);
  }
}

export async function reconcileTaskThreads(
  bb: BbPluginApi,
  store: TasksStore,
  taskId: string,
  known?: SdkThread,
): Promise<TaskThread[]> {
  let tasks = pending.get(store);
  if (!tasks) pending.set(store, (tasks = new Map()));
  const current = tasks.get(taskId);
  if (current) {
    if (!known) return current;
    await current;
  }
  const operation = reconcile(bb, store, taskId, known);
  tasks.set(taskId, operation);
  try {
    return await operation;
  } finally {
    if (tasks.get(taskId) === operation) tasks.delete(taskId);
  }
}
