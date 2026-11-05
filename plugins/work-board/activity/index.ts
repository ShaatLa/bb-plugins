import { z } from "zod";
import { dispatchedTask } from "./dispatch.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TasksApiStore } from "../api";
import { evaluateTaskActivity, type TaskActivity, type TaskActivitySession } from "../shared/task-activity";

type Thread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number];
type Snapshot = { thread: Thread | null; known: boolean; turnId: string | null; claimKey: string | null; requestId: string | null; dispatchTaskId: string | null; interactionIds: string[]; dispatchUnavailable: boolean; pending: boolean; queue: Set<string>; complete: boolean };

export function activityService(bb: BbPluginApi, store: TasksApiStore) {
  const db = bb.storage.database();
  const acceptedTurn = async (threadId: string) => {
    const events = await bb.sdk.threads.events.list({ threadId, types: ["turn/input/accepted", "turn/completed"], order: "desc", limit: "1" });
    const event = events[0];
    return event?.type === "turn/input/accepted" && event.scope.kind === "turn" ? event : null;
  };
  const turnKey = (event: NonNullable<Awaited<ReturnType<typeof acceptedTurn>>>) => {
    const accepted = z.object({ clientRequestId: z.string() }).safeParse(event.data);
    return accepted.success && event.scope.kind === "turn" ? JSON.stringify([event.scope.turnId, accepted.data.clientRequestId]) : null;
  };
  const latestTurn = async (threadId: string) => {
    const event = await acceptedTurn(threadId);
    return event ? turnKey(event) : null;
  };
  const dispatchForTurn = async (threadId: string, event: NonNullable<Awaited<ReturnType<typeof acceptedTurn>>>) => {
    const accepted = z.object({ clientRequestId: z.string() }).safeParse(event.data);
    if (!accepted.success) return null;
    // Only the request actually accepted into this turn can establish automatic focus.
    const requests = await bb.sdk.threads.events.list({ threadId, types: ["client/turn/requested"], order: "desc", beforeSeq: String(event.seq), limit: "50" });
    const matching = requests.find((request) => z.object({ requestId: z.literal(accepted.data.clientRequestId) }).safeParse(request.data).success);
    return matching ? dispatchedTask(matching.data, accepted.data.clientRequestId) : null;
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
    async stop(taskId: string, threadId: string): Promise<void> {
      const readClaim = () => db.prepare<[string], { task_id: string; turn_id: string }>("SELECT task_id, turn_id FROM task_activity_claims WHERE thread_id=?").get(threadId);
      const previous = readClaim();
      if (previous && previous.task_id !== taskId) return;
      const turnId = await latestTurn(threadId);
      const current = readClaim();
      if (current?.task_id !== previous?.task_id || current?.turn_id !== previous?.turn_id) return;
      if (turnId) db.prepare("INSERT INTO task_activity_claims(thread_id, task_id, turn_id) VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET task_id=excluded.task_id, turn_id=excluded.turn_id").run(threadId, taskId, `stopped:${turnId}`);
      else db.prepare("DELETE FROM task_activity_claims WHERE task_id=? AND thread_id=?").run(taskId, threadId);
    },
    queued(taskId: string, threadId: string, queueId: string): void {
      db.prepare("INSERT OR IGNORE INTO task_activity_queue(thread_id, queue_id, task_id) VALUES (?, ?, ?)").run(threadId, queueId, taskId);
    },
    async metadata(taskIds: readonly string[], discoveryComplete = true): Promise<Map<string, TaskActivity>> {
      const ids = [...new Set(taskIds)];
      if (!ids.length) return new Map();
      const placeholders = ids.map(() => "?").join(",");
      const history = new Set(db.prepare<string[], { task_id: string }>(`SELECT task_id FROM task_activity_history WHERE task_id IN (${placeholders})`).all(...ids).map((row) => row.task_id));
      const queues = db.prepare<string[], { thread_id: string; task_id: string; queue_id: string }>(`SELECT thread_id, task_id, queue_id FROM task_activity_queue WHERE task_id IN (${placeholders})`).all(...ids);
      const links = store.tasks.listTaskThreadsForTasks(ids);
      // Group once so metadata work scales with links and queued messages, not cards times those rows.
      const linksByTask = new Map<string, typeof links>();
      for (const link of links) {
        const group = linksByTask.get(link.taskId) ?? [];
        group.push(link);
        linksByTask.set(link.taskId, group);
      }
      const queuesByThread = new Map<string, Map<string, string[]>>();
      for (const row of queues) {
        const tasks = queuesByThread.get(row.thread_id) ?? new Map<string, string[]>();
        const group = tasks.get(row.task_id) ?? [];
        group.push(row.queue_id);
        tasks.set(row.task_id, group);
        queuesByThread.set(row.thread_id, tasks);
      }
      const threadIds = [...new Set(links.map((link) => link.threadId))];
      const snapshots = new Map<string, Snapshot>();
      for (let offset = 0; offset < threadIds.length; offset += 200) {
        const batch = threadIds.slice(offset, offset + 200);
        try {
          const rows = await bb.sdk.threads.list({ threadIds: batch, limit: batch.length, includeHidden: true });
          const byId = new Map(rows.map((row) => [row.id, row]));
          for (const id of batch) snapshots.set(id, { thread: byId.get(id) ?? null, known: true, turnId: null, claimKey: null, requestId: null, dispatchTaskId: null, interactionIds: [], dispatchUnavailable: false, pending: false, queue: new Set(), complete: true });
        } catch {
          for (const id of batch) snapshots.set(id, { thread: null, known: false, turnId: null, claimKey: null, requestId: null, dispatchTaskId: null, interactionIds: [], dispatchUnavailable: false, pending: false, queue: new Set(), complete: false });
        }
      }
      const work = [...snapshots.entries()].filter(([, snapshot]) => snapshot.thread && snapshot.thread.archivedAt == null && snapshot.thread.deletedAt == null);
      const worker = async () => {
        for (let item = work.shift(); item; item = work.shift()) {
          const [id, snapshot] = item;
          try {
            const [accepted, pending, queue] = await Promise.all([
              active(snapshot.thread!) ? acceptedTurn(id) : Promise.resolve(null),
              active(snapshot.thread!) ? bb.sdk.threads.interactions.list({ threadId: id }) : Promise.resolve([]),
              queuesByThread.has(id) ? bb.sdk.threads.queuedMessages.list({ threadId: id }) : Promise.resolve([]),
            ]);
            const turnId = accepted?.scope.kind === "turn" ? accepted.scope.turnId : null;
            snapshot.turnId = turnId;
            snapshot.claimKey = accepted ? turnKey(accepted) : null;
            const request = z.object({ clientRequestId: z.string() }).safeParse(accepted?.data);
            snapshot.requestId = request.success ? request.data.clientRequestId : null;
            if (accepted) snapshot.dispatchTaskId = await dispatchForTurn(id, accepted).catch(() => { snapshot.dispatchUnavailable = true; return null; });
            snapshot.pending = !!turnId && pending.some((interaction: Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["interactions"]["list"]>>[number]) => interaction.turnId === turnId && interaction.status === "pending");
            snapshot.interactionIds = pending.filter((interaction) => interaction.turnId === turnId && interaction.status === "pending").map((interaction) => interaction.id);
            snapshot.queue = new Set(queue.map((row: Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["queuedMessages"]["list"]>>[number]) => row.id));
          } catch { snapshot.complete = false; }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, work.length) }, worker));
      for (const row of queues) {
        const snapshot = snapshots.get(row.thread_id);
        if (snapshot?.complete && snapshot.thread && !snapshot.queue.has(row.queue_id))
          db.prepare("DELETE FROM task_activity_queue WHERE thread_id=? AND queue_id=?").run(row.thread_id, row.queue_id);
      }
      const claims = new Map(threadIds.length ? db.prepare<string[], { thread_id: string; task_id: string; turn_id: string }>(`SELECT thread_id, task_id, turn_id FROM task_activity_claims WHERE thread_id IN (${threadIds.map(() => "?").join(",")})`).all(...threadIds).map((row) => [row.thread_id, row] as const) : []);
      const taskData = store.tasks.listTaskActivity(ids);
      const focusedKeys = new Map<string, string | null>();
      const focusedKey = (taskId: string | null) => {
        if (!taskId) return null;
        if (!focusedKeys.has(taskId)) focusedKeys.set(taskId, store.tasks.getTask(taskId)?.key ?? null);
        return focusedKeys.get(taskId)!;
      };
      return new Map(ids.map((id) => {
        const taskLinks = linksByTask.get(id) ?? [];
        const sessions: TaskActivitySession[] = [];
        const inactiveSessions: NonNullable<TaskActivity["diagnostics"]>["inactiveSessions"] = [];
        for (const link of taskLinks) {
          const snapshot = snapshots.get(link.threadId)!;
          if (snapshot.known && (!snapshot.thread || snapshot.thread.archivedAt != null || snapshot.thread.deletedAt != null)) {
            inactiveSessions.push({ threadId: link.threadId, title: link.title, reason: !snapshot.thread ? "missing" : snapshot.thread.deletedAt != null ? "deleted" : "archived" });
            continue;
          }
          const claim = claims.get(link.threadId);
          const explicit = claim?.turn_id === snapshot.claimKey || claim?.turn_id === `stopped:${snapshot.claimKey}`;
          const executing = snapshot.thread !== null && active(snapshot.thread);
          if (executing && !history.has(id)) {
            db.prepare("INSERT OR IGNORE INTO task_activity_history(task_id) VALUES (?)").run(id);
            history.add(id);
          }
          const queueIds = (queuesByThread.get(link.threadId)?.get(id) ?? []).filter((queueId) => snapshot.queue.has(queueId));
          const queued = snapshot.complete && queueIds.length > 0;
          const state = executing ? (snapshot.pending ? "waiting-owner" : "working") : snapshot.thread?.status === "error" ? "error" : queued ? "queued" : "attached";
          const focusedTaskId = explicit ? (claim!.turn_id === snapshot.claimKey ? claim!.task_id : null) : snapshot.dispatchTaskId;
          const explanation = !snapshot.known ? "Session data is unavailable; execution cannot be verified."
            : executing ? (snapshot.pending ? "The attached session has a pending owner interaction." : "The attached session is actively executing.")
            : state === "error" ? "The attached session reports an error."
            : queued ? "A dispatched request is queued; the attached session is not actively executing."
            : "The session is attached but is not actively executing.";
          sessions.push({ threadId: link.threadId, title: link.title, role: link.presetName === "Parent thread" ? "parent" : "worker", state,
            diagnostics: { explanation, threadStatus: snapshot.thread?.status ?? null, runtimeStatus: snapshot.thread?.runtime.displayStatus ?? null, turnId: snapshot.turnId, requestId: snapshot.requestId, focusedTaskId, focusedTaskKey: focusedKey(focusedTaskId), queueIds, interactionIds: executing ? snapshot.interactionIds : [] } });
        }
        const status = taskData.get(id)?.status;
        return [id, evaluateTaskActivity({ sessions, hasWorked: history.has(id), terminal: status === "done" || status === "canceled", inactiveSessions, complete: discoveryComplete && taskLinks.every((link) => snapshots.get(link.threadId)?.complete && !snapshots.get(link.threadId)?.dispatchUnavailable) })];
      }));
    },
  };
}
