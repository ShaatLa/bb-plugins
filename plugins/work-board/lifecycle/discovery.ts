import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TasksApiStore } from "../api";
import { errorMessage } from "../shared/errors";
import { recordThreadLink, threadLiveStatus, threadUnavailable } from "./thread-links";

type Thread = Pick<Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>,
  "id" | "title" | "projectId" | "status" | "runtime" | "archivedAt" | "deletedAt" | "originKind" | "originPluginId" | "visibility">;

function titleTaskKeys(title: string): string[] {
  const keys = new Set<string>();
  for (const match of title.matchAll(/\b([A-Z][A-Z0-9]{0,9})-([1-9][0-9]*(?:\s*\+\s*[1-9][0-9]*)*)\b/gi)) {
    for (const number of match[2]!.split(/\s*\+\s*/)) keys.add(`${match[1]!.toUpperCase()}-${number}`);
  }
  return [...keys];
}

/** Explicit task keys anywhere in a session title can identify several assignments. */
export function attachNamedTaskThread(bb: BbPluginApi, store: TasksApiStore, thread: Thread): void {
  const title = thread.title;
  if (!title || threadUnavailable(thread) || !["pending", "starting", "active"].includes(thread.status)) return;
  const keys = titleTaskKeys(title);
  if (!keys.length) return;
  const projects = store.tasks.listProjects().filter((project) => project.linkedBbProjectId != null && project.linkedBbProjectId === thread.projectId);
  if (!projects.length) return;
  const projectIds = new Set(projects.map((project) => project.id));
  const attached = new Set(store.tasks.listTaskThreadsByThreadId(thread.id).map((link) => link.taskId));
  const db = bb.storage.database();
  for (const key of keys) {
    const task = store.tasks.getTaskByKey(key);
    if (!task || task.ordinaryVisible === false || !projectIds.has(task.projectId) || attached.has(task.id) || task.archivedAt || ["done", "canceled"].includes(task.status)) continue;
    // Manual detachment wins for that card; other explicitly named cards can still attach.
    if (db.prepare<[string, string], { found: number }>(
      "SELECT 1 AS found FROM comments WHERE task_id = ? AND thread_id = ? AND kind = 'system' AND body LIKE 'Thread detached (manual):%' LIMIT 1",
    ).get(task.id, thread.id)) continue;
    store.transaction(() => {
      store.tasks.upsertTaskThread({
        taskId: task.id,
        threadId: thread.id,
        title,
        presetName: "Auto attached",
        liveStatus: threadLiveStatus(thread),
      });
      recordThreadLink(store.tasks, task.id, thread.id,
        `Thread attached: @thread:${thread.id} (automatic: title references ${key})`);
      if (thread.status === "active" && thread.runtime.displayStatus === "active")
        db.prepare("INSERT OR IGNORE INTO task_activity_history(task_id) VALUES (?)").run(task.id);
    });
    attached.add(task.id);
    bb.realtime.publish("threads:changed", { taskId: task.id });
    bb.realtime.publish("comments:changed", { taskId: task.id });
    bb.realtime.publish("tasks:changed", { taskId: task.id, projectId: task.projectId });
  }
}

type Discovery = { at: number; ok: boolean; pending: boolean; dirty: boolean; promise: Promise<boolean> };
const discoveries = new WeakMap<TasksApiStore, Discovery>();
const subscribed = new WeakSet<TasksApiStore>();

const REFRESH_MIN_MS = 10_000; // an event-invalidated snapshot is rebuilt at most this often
const REFRESH_MAX_MS = 60_000; // safety net for changes with no event, e.g. a session renamed to carry a task key

/** Runs one bounded scan of the running threads; the entry stays usable while it is in flight. */
function refresh(bb: BbPluginApi, store: TasksApiStore, entry: Discovery): void {
  const linkedProjects = new Set(store.tasks.listProjects().map((project) => project.linkedBbProjectId).filter((id) => id !== null));
  entry.pending = true;
  entry.dirty = false;
  entry.promise = (async () => {
    const signal = AbortSignal.timeout(2_000);
    const running = linkedProjects.size ? await bb.sdk.threads.listRunning({ signal }) : [];
    for (let offset = 0; offset < running.length; offset += 200) {
      const ids = running.slice(offset, offset + 200).map((thread) => thread.id);
      const threads = await bb.sdk.threads.list({ threadIds: ids, limit: ids.length, includeHidden: true, signal });
      for (const thread of threads) {
        if (linkedProjects.has(thread.projectId)) attachNamedTaskThread(bb, store, thread);
      }
    }
    return true;
  })().catch((error) => { bb.log.warn(`Could not discover task sessions: ${errorMessage(error)}`); return false; })
    // Without a linked project the entry expires at once: the next call rescans, which costs no SDK read.
    .then((ok) => { entry.ok = ok; entry.pending = false; entry.at = linkedProjects.size ? Date.now() : 0; return ok; });
}

/**
 * Share a bounded running-thread scan across polling views; never scan idle thread history.
 * A good result is reused until a thread lifecycle event or the safety interval makes it stale; then it keeps
 * being served while a refresh runs in the background. Only the first scan and a retry after a failure are awaited.
 */
export function discoverRunningTaskThreads(bb: BbPluginApi, store: TasksApiStore): Promise<boolean> {
  if (!subscribed.has(store)) {
    subscribed.add(store);
    for (const type of ["thread.created", "thread.active", "thread.idle", "thread.failed", "thread.deleted", "thread.archived", "thread.unarchived"] as const)
      bb.events.on(type, () => { const entry = discoveries.get(store); if (entry) entry.dirty = true; });
  }
  let entry = discoveries.get(store);
  if (!entry) {
    entry = { at: 0, ok: false, pending: false, dirty: false, promise: Promise.resolve(true) };
    discoveries.set(store, entry);
    refresh(bb, store, entry);
    return entry.promise;
  }
  if (!entry.pending) {
    const age = Date.now() - entry.at;
    if (entry.ok ? age >= REFRESH_MAX_MS || (entry.dirty && age >= REFRESH_MIN_MS) : age >= REFRESH_MIN_MS) refresh(bb, store, entry);
  }
  return entry.ok ? (entry.pending ? Promise.resolve(true) : entry.promise) : entry.promise;
}
