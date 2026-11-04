import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TasksApiStore } from "../api";
import { evaluateTaskActivity, type TaskActivity, type TaskActivitySession } from "../shared/task-activity";

type Thread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number];
type Snapshot = { thread: Thread | null; known: boolean; turnId: string | null; pending: boolean; queue: Set<string>; complete: boolean };

export function activityService(bb: BbPluginApi, store: TasksApiStore) {
  const db = bb.storage.database();
  const latestTurn = async (threadId: string) => {
    const events = await bb.sdk.threads.events.list({ threadId, types: ["turn/input/accepted", "turn/completed"], order: "desc", limit: "1" });
    const event = events[0];
    return event?.type === "turn/input/accepted" && event.scope.kind === "turn" ? event.scope.turnId : null;
  };
  const active = (thread: Pick<Thread, "status" | "runtime" | "archivedAt" | "deletedAt">) => thread.status === "active" && thread.runtime.displayStatus === "active" && thread.archivedAt == null && thread.deletedAt == null;
  return {
    async start(taskId: string, threadId: string): Promise<void> {
      const link = store.tasks.listTaskThreads(taskId).find((item) => item.threadId === threadId && item.presetName !== "Parent thread");
      if (!link) throw new Error("An attached worker is required");
      const thread = await bb.sdk.threads.get({ threadId });
      if (!active(thread)) throw new Error("Thread is not actively executing");
      const turnId = await latestTurn(threadId);
      if (!turnId) throw new Error("Current turn identity is unavailable");
      // Recheck both the link and execution after the asynchronous reads.
      const current = await bb.sdk.threads.get({ threadId });
      if (!active(current) || !store.tasks.listTaskThreads(taskId).some((item) => item.id === link.id)) throw new Error("Thread or attachment changed");
      if (await latestTurn(threadId) !== turnId) throw new Error("Current turn changed");
      store.transaction(() => {
        db.prepare("INSERT INTO task_activity_claims(thread_id, task_id, turn_id) VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET task_id=excluded.task_id, turn_id=excluded.turn_id").run(threadId, taskId, turnId);
        db.prepare("INSERT OR IGNORE INTO task_activity_history(task_id) VALUES (?)").run(taskId);
      });
    },
    stop(taskId: string, threadId: string): void {
      db.prepare("DELETE FROM task_activity_claims WHERE task_id = ? AND thread_id = ?").run(taskId, threadId);
    },
    queued(taskId: string, threadId: string, queueId: string): void {
      db.prepare("INSERT OR IGNORE INTO task_activity_queue(thread_id, queue_id, task_id) VALUES (?, ?, ?)").run(threadId, queueId, taskId);
    },
    async metadata(taskIds: readonly string[]): Promise<Map<string, TaskActivity>> {
      const ids = [...new Set(taskIds)];
      if (!ids.length) return new Map();
      const links = store.tasks.listTaskThreadsForTasks(ids);
      const threadIds = [...new Set(links.map((link) => link.threadId))];
      const snapshots = new Map<string, Snapshot>();
      for (let offset = 0; offset < threadIds.length; offset += 200) {
        const batch = threadIds.slice(offset, offset + 200);
        try {
          const rows = await bb.sdk.threads.list({ threadIds: batch, limit: batch.length, includeHidden: true });
          const byId = new Map(rows.map((row) => [row.id, row]));
          for (const id of batch) snapshots.set(id, { thread: byId.get(id) ?? null, known: true, turnId: null, pending: false, queue: new Set(), complete: true });
        } catch {
          for (const id of batch) snapshots.set(id, { thread: null, known: false, turnId: null, pending: false, queue: new Set(), complete: false });
        }
      }
      const work = [...snapshots.entries()].filter(([, snapshot]) => snapshot.thread && snapshot.thread.archivedAt == null && snapshot.thread.deletedAt == null);
      const worker = async () => {
        for (let item = work.shift(); item; item = work.shift()) {
          const [id, snapshot] = item;
          try {
            const [turnId, pending, queue] = await Promise.all([
              active(snapshot.thread!) ? latestTurn(id) : Promise.resolve(null),
              bb.sdk.threads.interactions.list({ threadId: id }),
              bb.sdk.threads.queuedMessages.list({ threadId: id }),
            ]);
            snapshot.turnId = turnId;
            snapshot.pending = !!turnId && pending.some((interaction: Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["interactions"]["list"]>>[number]) => interaction.turnId === turnId && interaction.status === "pending");
            snapshot.queue = new Set(queue.map((row: Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["queuedMessages"]["list"]>>[number]) => row.id));
          } catch { snapshot.complete = false; }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, work.length) }, worker));
      const placeholders = ids.map(() => "?").join(",");
      const history = new Set(db.prepare<string[], { task_id: string }>(`SELECT task_id FROM task_activity_history WHERE task_id IN (${placeholders})`).all(...ids).map((row) => row.task_id));
      const claims = new Map(db.prepare<string[], { thread_id: string; task_id: string; turn_id: string }>(`SELECT thread_id, task_id, turn_id FROM task_activity_claims WHERE task_id IN (${placeholders})`).all(...ids).map((row) => [row.thread_id, row]));
      const queues = db.prepare<string[], { thread_id: string; task_id: string; queue_id: string }>(`SELECT thread_id, task_id, queue_id FROM task_activity_queue WHERE task_id IN (${placeholders})`).all(...ids);
      const taskData = store.tasks.listTaskActivity(ids);
      return new Map(ids.map((id) => {
        const taskLinks = links.filter((link) => link.taskId === id);
        const sessions: TaskActivitySession[] = [];
        for (const link of taskLinks) {
          const snapshot = snapshots.get(link.threadId)!;
          if (snapshot.known && (!snapshot.thread || snapshot.thread.archivedAt != null || snapshot.thread.deletedAt != null)) continue;
          const claim = claims.get(link.threadId);
          const scoped = snapshot.complete && snapshot.turnId !== null && claim?.task_id === id && claim.turn_id === snapshot.turnId;
          const queued = snapshot.complete && queues.some((row) => row.thread_id === link.threadId && row.task_id === id && snapshot.queue.has(row.queue_id));
          const state = scoped ? (snapshot.pending ? "waiting-owner" : "working") : queued ? "queued" : snapshot.thread?.status === "error" ? "error" : "attached";
          sessions.push({ threadId: link.threadId, title: link.title, role: link.presetName === "Parent thread" ? "parent" : "worker", state });
        }
        const status = taskData.get(id)?.status;
        return [id, evaluateTaskActivity({ sessions, hasWorked: history.has(id), terminal: status === "done" || status === "canceled", complete: taskLinks.every((link) => snapshots.get(link.threadId)?.complete) })];
      }));
    },
  };
}
