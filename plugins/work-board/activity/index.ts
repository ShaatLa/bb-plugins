import { z } from "zod";
import { dispatchedTask } from "./dispatch.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TasksApiStore } from "../api";
import { createActivityReads, MAX_SDK_READS, type AcceptedTurn, type ActivityReads } from "./shared-reads.js";
import { evaluateTaskActivity, type TaskActivity, type TaskActivitySession } from "../shared/task-activity";

type Thread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number];
type Snapshot = { thread: Thread | null; known: boolean; turnId: string | null; claimKey: string | null; requestId: string | null; dispatchTaskId: string | null; interactionIds: string[]; dispatchUnavailable: boolean; pending: boolean; queue: Set<string>; complete: boolean };

// Services are created per call, so sampling state lives per plugin host and is shared by all of them.
const readsByHost = new WeakMap<object, ActivityReads<Thread>>();

export function activityService(bb: BbPluginApi, store: TasksApiStore) {
  const db = bb.storage.database();
  const reads = readsByHost.get(bb) ?? readsByHost.set(bb, createActivityReads<Thread>()).get(bb)!;
  const readAccepted = async (threadId: string): Promise<AcceptedTurn | null> => {
    const events = await bb.sdk.threads.events.list({ threadId, types: ["turn/input/accepted", "turn/completed"], order: "desc", limit: "1" });
    const event = events[0];
    if (event?.type !== "turn/input/accepted" || event.scope.kind !== "turn") return null;
    const accepted = z.object({ clientRequestId: z.string() }).safeParse(event.data);
    const requestId = accepted.success ? accepted.data.clientRequestId : null;
    // Keep only small parsed identity; the raw event is dropped.
    return { seq: event.seq, turnId: event.scope.turnId, requestId, claimKey: requestId === null ? null : JSON.stringify([event.scope.turnId, requestId]) };
  };
  const latestTurn = async (threadId: string) => (await readAccepted(threadId))?.claimKey ?? null;
  const readDispatch = async (threadId: string, accepted: AcceptedTurn & { requestId: string }) => {
    // Only the request actually accepted into this turn can establish automatic focus.
    const requests = await bb.sdk.threads.events.list({ threadId, types: ["client/turn/requested"], order: "desc", beforeSeq: String(accepted.seq), limit: "50" });
    const matching = requests.find((request) => z.object({ requestId: z.literal(accepted.requestId) }).safeParse(request.data).success);
    // The up-to-50 large request events die here; callers cache only this task id or null.
    return matching ? dispatchedTask(matching.data, accepted.requestId) : null;
  };
  const invalidate = (threadId: string) => { for (const cache of [reads.threads, reads.accepted, reads.interactions, reads.queues]) cache.delete(threadId); };
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
      invalidate(threadId);
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
      invalidate(threadId);
    },
    queued(taskId: string, threadId: string, queueId: string): void {
      db.prepare("INSERT OR IGNORE INTO task_activity_queue(thread_id, queue_id, task_id) VALUES (?, ?, ?)").run(threadId, queueId, taskId);
      // A queue sample taken before this row existed must not be used to delete it.
      reads.queues.delete(threadId);
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
      // Register every missing thread before yielding, so overlapping calls join these requests instead of repeating them.
      const pendingThreads = new Map<string, Promise<Thread | null>>();
      const missing: string[] = [];
      for (const id of threadIds) {
        const shared = reads.threads.peek(id);
        if (shared) pendingThreads.set(id, shared); else missing.push(id);
      }
      for (let offset = 0; offset < missing.length; offset += 200) {
        const batch = missing.slice(offset, offset + 200); // SDK list limit
        const rows = (async () => new Map((await bb.sdk.threads.list({ threadIds: batch, limit: batch.length, includeHidden: true })).map((row) => [row.id, row] as const)))();
        for (const id of batch) pendingThreads.set(id, reads.threads.set(id, rows.then((byId) => byId.get(id) ?? null)));
      }
      const settledThreads = await Promise.allSettled(threadIds.map((id) => pendingThreads.get(id)!));
      threadIds.forEach((id, index) => {
        const result = settledThreads[index]!;
        // Snapshots are built per call from the shared thread DTO; they are never shared between consumers.
        snapshots.set(id, { thread: result.status === "fulfilled" ? result.value : null, known: result.status === "fulfilled", turnId: null, claimKey: null, requestId: null, dispatchTaskId: null, interactionIds: [], dispatchUnavailable: false, pending: false, queue: new Set(), complete: result.status === "fulfilled" });
      });
      const work = [...snapshots.entries()].filter(([, snapshot]) => snapshot.thread && snapshot.thread.archivedAt == null && snapshot.thread.deletedAt == null);
      const worker = async () => {
        for (let item = work.shift(); item; item = work.shift()) {
          const [id, snapshot] = item;
          const executing = active(snapshot.thread!);
          // Each read is shared (in flight and for a short TTL) and goes through the global read limiter; one failure never discards the others.
          const [accepted, pending, queue] = await Promise.allSettled([
            executing ? reads.accepted.get(id, () => reads.limit(() => readAccepted(id))) : null,
            executing ? reads.interactions.get(id, () => reads.limit(async () => (await bb.sdk.threads.interactions.list({ threadId: id })).filter((interaction) => interaction.status === "pending").map((interaction) => ({ id: interaction.id, turnId: interaction.turnId ?? null })))) : [],
            queuesByThread.has(id) ? reads.queues.get(id, () => reads.limit(async () => (await bb.sdk.threads.queuedMessages.list({ threadId: id })).map((row) => row.id))) : [],
          ]);
          if (accepted.status === "rejected" || pending.status === "rejected" || queue.status === "rejected") snapshot.complete = false;
          const turn = accepted.status === "fulfilled" ? accepted.value : null;
          snapshot.turnId = turn?.turnId ?? null;
          snapshot.claimKey = turn?.claimKey ?? null;
          snapshot.requestId = turn?.requestId ?? null;
          if (pending.status === "fulfilled") {
            const mine = snapshot.turnId ? pending.value.filter((interaction) => interaction.turnId === snapshot.turnId) : [];
            snapshot.pending = mine.length > 0;
            snapshot.interactionIds = mine.map((interaction) => interaction.id);
          }
          if (queue.status === "fulfilled") snapshot.queue = new Set(queue.value);
          if (turn?.requestId) {
            const request = { ...turn, requestId: turn.requestId };
            // Keyed by the immutable accepted request, so repeated polls do not re-read the large request history.
            try { snapshot.dispatchTaskId = await reads.dispatches.get(JSON.stringify([id, turn.seq, turn.turnId, turn.requestId]), () => reads.limit(() => readDispatch(id, request))); }
            catch { snapshot.dispatchUnavailable = true; }
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(MAX_SDK_READS, work.length) }, worker));
      for (const row of queues) {
        const snapshot = snapshots.get(row.thread_id);
        if (snapshot?.complete && snapshot.thread && !snapshot.queue.has(row.queue_id))
          db.prepare("DELETE FROM task_activity_queue WHERE thread_id=? AND queue_id=?").run(row.thread_id, row.queue_id);
      }
      const claims = new Map(threadIds.length ? db.prepare<string[], { thread_id: string; task_id: string; turn_id: string }>(`SELECT thread_id, task_id, turn_id FROM task_activity_claims WHERE thread_id IN (${threadIds.map(() => "?").join(",")})`).all(...threadIds).map((row) => [row.thread_id, row] as const) : []);
      // Agent comments are work evidence, not assignment; only a confirmed lost link permits Abandoned.
      const lost = new Set(db.prepare<string[], { task_id: string }>(`SELECT DISTINCT task_id FROM comments WHERE task_id IN (${placeholders}) AND kind='system' AND (body LIKE 'Thread detached (archived):%' OR body LIKE 'Thread detached (deleted):%' OR body LIKE 'Thread detached (missing):%' OR body LIKE 'Thread detached (manual):%' OR body LIKE 'Thread detached (private):%')`).all(...ids).map(row => row.task_id));
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
        const task = taskData.get(id);
        const status = task?.status;
        return [id, evaluateTaskActivity({ sessions, executionTarget: task?.executionTarget ?? "agent", hasWorked: history.has(id), hasLostSession: inactiveSessions.length > 0 || lost.has(id), terminal: status === "done" || status === "canceled", inactiveSessions, complete: discoveryComplete && taskLinks.every((link) => snapshots.get(link.threadId)?.complete && !snapshots.get(link.threadId)?.dispatchUnavailable) })];
      }));
    },
  };
}
