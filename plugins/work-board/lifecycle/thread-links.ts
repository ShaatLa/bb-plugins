import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TasksStore, TaskThread, TaskThreadLiveStatus } from "../db";
import { isSideChatShapedThread } from "../shared/side-chat";
import { errorMessage } from "../shared/errors";
import { isClosedStatus } from "../shared/workflow-policy";
import { reviewRoleOf } from "../shared/thread-role";

type SdkThread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;
/**
 * `error` is set when a thread read failed or the links changed during the reads (`changed`): the links are the stored ones,
 * unreconciled; after a change, without the sessions read as stopping.
 */
type Reconciled = { links: TaskThread[]; error?: unknown; changed?: true };
const pending = new WeakMap<TasksStore, Map<string, Promise<Reconciled>>>();

export function threadUnavailable(thread: Pick<SdkThread, "archivedAt" | "deletedAt" | "originKind" | "originPluginId" | "visibility">): boolean {
  return (
    thread.archivedAt != null ||
    thread.deletedAt != null ||
    isSideChatShapedThread(thread)
  );
}

export function threadLiveStatus(thread: Pick<SdkThread, "status">): TaskThreadLiveStatus {
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
    authorName: "Work Board",
    body,
  });
}

function parentCardClosed(store: TasksStore, taskId: string): boolean {
  const task = store.getTask(taskId);
  const project = task && store.getProject(task.projectId);
  return !!task && !!project && isClosedStatus(project, task.status);
}

async function reconcile(
  bb: BbPluginApi,
  store: TasksStore,
  taskId: string,
  known?: SdkThread,
): Promise<Reconciled> {
  const links = store.listTaskThreads(taskId);
  if (!links.length) return { links };
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
  let changedDuringReads = false;
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
    await Promise.all(links.map((link) => get(link.threadId)));
    const unavailable = links.filter((link) => {
      const thread = snapshots.get(link.threadId);
      return !thread || threadUnavailable(thread);
    });
    // A review child that attached by its title never takes the card over, so it must not replace the owner's parent link.
    const key = store.getTask(taskId)?.key;
    const discovered = new Set(
      bb.storage
        .database()
        .prepare<[string], { id: string }>("SELECT id FROM task_threads WHERE task_id = ? AND link_origin = 'discovery'")
        .all(taskId)
        .map((row) => row.id),
    );
    const hasWorker = links.some((link) => {
      const thread = snapshots.get(link.threadId);
      return (
        !inherited.has(link.threadId) &&
        !(key && discovered.has(link.id) && reviewRoleOf(thread?.title ?? link.title, key)) &&
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
      // Every decision below (`hasWorker`, the parent fallback) used the links as read, so a change made during the reads voids them all.
      const stored = store.listTaskThreads(taskId);
      const started = new Map(links.map((link) => [link.id, link]));
      if (
        stored.length !== links.length ||
        stored.some((link) => started.get(link.id)?.threadId !== link.threadId || started.get(link.id)?.updatedAt !== link.updatedAt)
      ) {
        changedDuringReads = true;
        throw new Error(`The sessions linked to ${taskId} changed during reconciliation`);
      }
      for (const link of links) {
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
        // A finished task needs no responsible session; the fallback only keeps open work accountable.
        !parentCardClosed(store, taskId)
      ) {
        store.upsertTaskThread({
          taskId,
          threadId: parent.id,
          presetName: "Parent thread",
          linkOrigin: "parent",
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
    return {
      links: store
        .listTaskThreads(taskId)
        .filter((link) => snapshots.get(link.threadId)?.status !== "stopping"),
    };
  } catch (error) {
    if (changedDuringReads)
      return {
        links: store
          .listTaskThreads(taskId)
          .filter((link) => snapshots.get(link.threadId)?.status !== "stopping"),
        error,
        changed: true,
      };
    // Keep associations on lookup failures; a network outage is not an archive event.
    bb.log.warn(
      `Could not reconcile task threads for ${taskId}: ${errorMessage(error)}`,
    );
    return { links: store.listTaskThreads(taskId), error };
  }
}

export async function reconcileTaskThreads(
  bb: BbPluginApi,
  store: TasksStore,
  taskId: string,
  known?: SdkThread,
): Promise<TaskThread[]> {
  const result = await reconcileShared(bb, store, taskId, known);
  // Links changed during the reads: one run from the fresh links, whose own change result is good enough to list.
  return (result.changed ? await reconcileShared(bb, store, taskId, known) : result).links;
}

/** As `reconcileTaskThreads`, but an incomplete run throws, also one it joined, instead of returning the stored links. */
export async function reconcileTaskThreadsStrict(
  bb: BbPluginApi,
  store: TasksStore,
  taskId: string,
): Promise<TaskThread[]> {
  const result = await reconcileShared(bb, store, taskId);
  if ("error" in result) throw result.error;
  return result.links;
}

async function reconcileShared(
  bb: BbPluginApi,
  store: TasksStore,
  taskId: string,
  known?: SdkThread,
): Promise<Reconciled> {
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
