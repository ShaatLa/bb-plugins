import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TasksApiStore } from "../api";
import { errorMessage } from "../shared/errors";
import { recordThreadLink, threadLiveStatus, threadUnavailable } from "./thread-links";

type Thread = Pick<Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>,
  "id" | "title" | "projectId" | "status" | "runtime" | "archivedAt" | "deletedAt" | "originKind" | "originPluginId" | "visibility">;

function titleTaskKey(title: string | null): string | null {
  const key = title?.match(/^([A-Z][A-Z0-9]{0,9}-[1-9][0-9]*)(?=$|[\s:–—])/i)?.[1]?.toUpperCase();
  if (!key) return null;
  const keys = new Set(title!.toUpperCase().match(/\b[A-Z][A-Z0-9]{0,9}-[1-9][0-9]*\b/g));
  return keys.size === 1 ? key : null;
}

/** A single leading task key is an assignment hint; a key mentioned in prose is not. */
export function attachNamedTaskThread(bb: BbPluginApi, store: TasksApiStore, thread: Thread): void {
  const key = titleTaskKey(thread.title);
  if (!key || threadUnavailable(thread) || !["pending", "starting", "active"].includes(thread.status)) return;
  const task = store.tasks.getTaskByKey(key);
  if (!task || task.archivedAt || task.executionTarget === "owner" || ["done", "canceled"].includes(task.status)) return;
  const project = store.tasks.getProject(task.projectId);
  if (!project?.linkedBbProjectId || project.linkedBbProjectId !== thread.projectId) return;
  // Existing assignments and explicit detachments take priority over inferred titles.
  if (store.tasks.listTaskThreadsByThreadId(thread.id).length) return;
  const db = bb.storage.database();
  if (db.prepare<[string, string], { found: number }>(
    "SELECT 1 AS found FROM comments WHERE task_id = ? AND thread_id = ? AND kind = 'system' AND body LIKE 'Thread detached (manual):%' LIMIT 1",
  ).get(task.id, thread.id)) return;
  store.transaction(() => {
    store.tasks.upsertTaskThread({
      taskId: task.id,
      threadId: thread.id,
      title: thread.title!,
      presetName: "Auto attached",
      liveStatus: threadLiveStatus(thread),
    });
    recordThreadLink(store.tasks, task.id, thread.id,
      `Thread attached: @thread:${thread.id} (automatic: title starts with ${key})`);
    if (thread.status === "active" && thread.runtime.displayStatus === "active")
      db.prepare("INSERT OR IGNORE INTO task_activity_history(task_id) VALUES (?)").run(task.id);
  });
  bb.realtime.publish("threads:changed", { taskId: task.id });
  bb.realtime.publish("comments:changed", { taskId: task.id });
  bb.realtime.publish("tasks:changed", { taskId: task.id, projectId: task.projectId });
}

const discoveries = new WeakMap<TasksApiStore, { until: number; pending: boolean; promise: Promise<boolean> }>();

/** Share a bounded running-thread read across polling views; never scan idle thread history. */
export function discoverRunningTaskThreads(bb: BbPluginApi, store: TasksApiStore): Promise<boolean> {
  const cached = discoveries.get(store);
  if (cached && (cached.pending || cached.until > Date.now())) return cached.promise;
  const linkedProjects = new Set(store.tasks.listProjects().map((project) => project.linkedBbProjectId).filter((id) => id !== null));
  if (!linkedProjects.size) return Promise.resolve(true);
  const entry = { until: 0, pending: true, promise: Promise.resolve(true) };
  discoveries.set(store, entry);
  entry.promise = (async () => {
    const signal = AbortSignal.timeout(2_000);
    const running = await bb.sdk.threads.listRunning({ signal });
    for (let offset = 0; offset < running.length; offset += 200) {
      const ids = running.slice(offset, offset + 200).map((thread) => thread.id);
      const threads = await bb.sdk.threads.list({ threadIds: ids, limit: ids.length, includeHidden: true, signal });
      for (const thread of threads) {
        if (linkedProjects.has(thread.projectId)) attachNamedTaskThread(bb, store, thread);
      }
    }
    return true;
  })().catch((error) => { bb.log.warn(`Could not discover task sessions: ${errorMessage(error)}`); return false; })
    .finally(() => { entry.pending = false; entry.until = Date.now() + 10_000; });
  return entry.promise;
}
