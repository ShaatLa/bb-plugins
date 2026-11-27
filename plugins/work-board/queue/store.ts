import { createHash, randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { getWorkflowPolicy, isClosedStatus, startsFromStatus } from "../shared/workflow-policy";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

export type QueueMode = "off" | "trial" | "on";
export type QueueArm = "auto" | "control";
export type QueuePhase = "closed" | "pre" | "work";

export interface QueueEntry {
  taskId: string;
  key: string;
  title: string;
  status: string;
  position: number;
  addedBy: string;
  addedAt: string;
}
export interface ProjectQueue { projectId: string; threadId: string; entries: QueueEntry[] }

interface TaskFacts { id: string; project_id: string; status: string; archived_at: string | null; key: string; title: string }
interface QueueRow { task_id: string; project_id: string; thread_id: string; position: number; added_by: string; added_at: string }
type Zone = { statuses: { id: string; requiresApprovedPlan?: boolean }[] | null; workflowPolicy: Parameters<typeof getWorkflowPolicy>[0]["workflowPolicy"] };

const nowIso = () => new Date().toISOString();

// A promotion's notice row is delivered after its transaction commits; a rolled-back row is simply not found by the drain.
const noticeListeners = new Set<() => void>();
export function onNoticeQueued(listener: () => void): () => void {
  noticeListeners.add(listener);
  return () => { noticeListeners.delete(listener); };
}

/** A stable half of the (project, executor thread) pairs gets queues in a trial. */
export function queueArm(projectId: string, threadId: string): QueueArm {
  return createHash("sha256").update(`${projectId}:${threadId}`).digest()[0]! % 2 ? "auto" : "control";
}

export function queueMode(db: Database, projectId: string): QueueMode {
  return db.prepare<[string], { mode: QueueMode }>("SELECT mode FROM queue_modes WHERE project_id=?").get(projectId)?.mode ?? "trial";
}

/** The arm a unit is in under the project's mode: `on` is auto everywhere. */
export function effectiveArm(db: Database, projectId: string, threadId: string): QueueArm | "off" {
  const mode = queueMode(db, projectId);
  return mode === "off" ? "off" : mode === "on" ? "auto" : queueArm(projectId, threadId);
}

/** The owner's mode change, logged with its time. */
export function setQueueMode(db: Database, projectId: string, mode: QueueMode, actor = "owner"): void {
  db.transaction(() => {
    const previous = queueMode(db, projectId);
    if (previous === mode) return;
    const at = nowIso();
    db.prepare<[string, string, string]>("INSERT INTO queue_modes(project_id, mode, changed_at) VALUES (?,?,?) ON CONFLICT(project_id) DO UPDATE SET mode=excluded.mode, changed_at=excluded.changed_at").run(projectId, mode, at);
    db.prepare<[string, string, string, string, string]>("INSERT INTO task_queue_log(change_id, at, project_id, action, actor, cause) VALUES (?,?,?,'mode',?,?)")
      .run(randomUUID(), at, projectId, actor, `${previous}->${mode}`);
  })();
}

export function zoneOf(db: Database, projectId: string): Zone {
  const row = db.prepare<[string], { statuses: string | null; workflow_policy: string | null }>("SELECT statuses, workflow_policy FROM projects WHERE id=?").get(projectId);
  if (!row) throw new Error(`Project not found: ${projectId}`);
  return { statuses: row.statuses ? JSON.parse(row.statuses) : null, workflowPolicy: row.workflow_policy ? JSON.parse(row.workflow_policy) : null };
}

/** `pre`: Backlog, Todo or the planning status; `work`: any other open status. */
export function queuePhase(zone: Zone, status: string): QueuePhase {
  if (isClosedStatus(zone, status)) return "closed";
  return startsFromStatus(zone, status) ? "pre" : "work";
}

function taskFacts(db: Database, taskId: string): TaskFacts {
  const row = db.prepare<[string], TaskFacts>("SELECT t.id, t.project_id, t.status, t.archived_at, p.prefix || '-' || t.number AS key, t.title FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?").get(taskId);
  if (!row) throw new Error(`Task not found: ${taskId}`);
  return row;
}

const queueRows = (db: Database, projectId: string, threadId: string) =>
  db.prepare<[string, string], QueueRow>("SELECT * FROM task_queue WHERE project_id=? AND thread_id=? ORDER BY position").all(projectId, threadId);
const rowOf = (db: Database, taskId: string) => db.prepare<[string], QueueRow>("SELECT * FROM task_queue WHERE task_id=?").get(taskId);

export function managerOf(db: Database, projectId: string): string | null {
  return db.prepare<[string], { manager: string | null }>("SELECT manager FROM attention_manager WHERE tracker_id=?").get(projectId)?.manager ?? null;
}

/** The executor edits its own queue, the project's manager any queue of that project, the owner (the UI) any queue. */
export function assertMayEdit(db: Database, projectId: string, threadId: string, actor: string): void {
  if (actor === "owner" || actor === threadId) return;
  const manager = managerOf(db, projectId);
  if (manager && actor === manager) return;
  throw new Error(`Only the executor ${threadId}${manager ? `, the project's manager ${manager}` : ""} or the owner can change this queue`);
}

function assertQueueOn(db: Database, projectId: string, threadId: string): void {
  const arm = effectiveArm(db, projectId, threadId);
  if (arm === "off") throw new Error("the queue is off in this project");
  if (arm === "control") throw new Error("the queue is off for this thread (control arm of the queue trial)");
}

interface Change { changeId: string; at: string; projectId: string; threadId: string; actor: string }
const logRow = (db: Database, change: Change, taskId: string, action: string, cause: string | null, oldPosition: number | null, newPosition: number | null) =>
  db.prepare<(string | number | null)[]>("INSERT INTO task_queue_log(change_id, at, project_id, thread_id, task_id, action, actor, cause, old_position, new_position) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(change.changeId, change.at, change.projectId, change.threadId, taskId, action, change.actor, cause, oldPosition, newPosition);

/**
 * Makes `order` the queue: inserts the new card, removes the dropped ones, renumbers densely, and logs one row per
 * affected card. `primary` is the card the change is about; every other card whose position moved is a shift.
 */
function applyOrder(db: Database, change: Change, order: string[], primary: { taskId: string; action: "add" | "move" | "remove"; cause: string | null }): void {
  const before = new Map(queueRows(db, change.projectId, change.threadId).map((row) => [row.task_id, row.position]));
  const shiftAction = primary.action === "remove" ? "advance" : "move";
  if (primary.action === "remove") db.prepare<[string]>("DELETE FROM task_queue WHERE task_id=?").run(primary.taskId);
  order.forEach((taskId, index) => {
    const position = index + 1;
    const old = before.get(taskId) ?? null;
    if (taskId === primary.taskId && primary.action === "add")
      db.prepare<(string | number)[]>("INSERT INTO task_queue(task_id, project_id, thread_id, position, added_by, added_at) VALUES (?,?,?,?,?,?)").run(taskId, change.projectId, change.threadId, position, change.actor, change.at);
    else if (old !== position) db.prepare<[number, string]>("UPDATE task_queue SET position=? WHERE task_id=?").run(position, taskId);
    if (taskId === primary.taskId) logRow(db, change, taskId, primary.action, primary.cause, old, position);
    else if (old !== position) logRow(db, change, taskId, shiftAction, "shift", old, position);
  });
  if (primary.action === "remove") logRow(db, change, primary.taskId, "remove", primary.cause, before.get(primary.taskId) ?? null, null);
}

/** Waiting cards (positions 2 and up) stay in a pre-work status; only the first card may be in work. */
function assertOrder(db: Database, zone: Zone, order: string[], moved: string): void {
  order.forEach((taskId, index) => {
    if (index === 0) return;
    const facts = taskFacts(db, taskId);
    if (queuePhase(zone, facts.status) === "pre") return;
    if (taskId === moved) throw new Error(`${facts.key} is in ${facts.status}: only the first card of a queue may be in work. Move it back to Todo first, or put it first.`);
    throw new Error(`This would put ${facts.key} (in ${facts.status}) behind another card. Move ${facts.key} back to Todo, or out of the queue, first.`);
  });
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

export interface QueueResult { changeId: string; taskId: string; threadId: string; projectId: string; position: number }

/** Appends the card to the executor's queue (or inserts it at `position`). Thread existence is checked by the caller. */
export function queueAdd(db: Database, input: { taskId: string; threadId: string; position?: number; actor: string }): QueueResult {
  return db.transaction((): QueueResult => {
    const task = taskFacts(db, input.taskId);
    const zone = zoneOf(db, task.project_id);
    if (task.archived_at) throw new Error(`${task.key} is archived`);
    if (queuePhase(zone, task.status) === "closed") throw new Error(`${task.key} is already closed`);
    assertMayEdit(db, task.project_id, input.threadId, input.actor);
    assertQueueOn(db, task.project_id, input.threadId);
    const existing = rowOf(db, task.id);
    if (existing) throw new Error(`${task.key} is already queued #${existing.position} for ${existing.thread_id}; move or remove it first`);
    const order = queueRows(db, task.project_id, input.threadId).map((row) => row.task_id);
    const position = clamp(input.position ?? order.length + 1, 1, order.length + 1);
    order.splice(position - 1, 0, task.id);
    assertOrder(db, zone, order, task.id);
    const change: Change = { changeId: randomUUID(), at: nowIso(), projectId: task.project_id, threadId: input.threadId, actor: input.actor };
    applyOrder(db, change, order, { taskId: task.id, action: "add", cause: null });
    return { changeId: change.changeId, taskId: task.id, threadId: input.threadId, projectId: task.project_id, position };
  })();
}

export function queueMove(db: Database, input: { taskId: string; position: number; actor: string }): QueueResult {
  return db.transaction((): QueueResult => {
    const task = taskFacts(db, input.taskId);
    const row = rowOf(db, task.id);
    if (!row) throw new Error(`${task.key} is not in a queue`);
    assertMayEdit(db, row.project_id, row.thread_id, input.actor);
    const zone = zoneOf(db, row.project_id);
    const order = queueRows(db, row.project_id, row.thread_id).map((entry) => entry.task_id).filter((id) => id !== task.id);
    // A stale position is clamped to what the queue holds now; the log shows the result.
    const position = clamp(input.position, 1, order.length + 1);
    order.splice(position - 1, 0, task.id);
    const change: Change = { changeId: randomUUID(), at: nowIso(), projectId: row.project_id, threadId: row.thread_id, actor: input.actor };
    if (position === row.position) return { changeId: change.changeId, taskId: task.id, threadId: row.thread_id, projectId: row.project_id, position };
    assertOrder(db, zone, order, task.id);
    applyOrder(db, change, order, { taskId: task.id, action: "move", cause: null });
    return { changeId: change.changeId, taskId: task.id, threadId: row.thread_id, projectId: row.project_id, position };
  })();
}

export function queueRemove(db: Database, input: { taskId: string; actor: string }): QueueResult {
  return db.transaction((): QueueResult => {
    const task = taskFacts(db, input.taskId);
    const row = rowOf(db, task.id);
    if (!row) throw new Error(`${task.key} is not in a queue`);
    assertMayEdit(db, row.project_id, row.thread_id, input.actor);
    const change: Change = { changeId: randomUUID(), at: nowIso(), projectId: row.project_id, threadId: row.thread_id, actor: input.actor };
    const order = queueRows(db, row.project_id, row.thread_id).map((entry) => entry.task_id).filter((id) => id !== task.id);
    applyOrder(db, change, order, { taskId: task.id, action: "remove", cause: null });
    return { changeId: change.changeId, taskId: task.id, threadId: row.thread_id, projectId: row.project_id, position: row.position };
  })();
}

/**
 * The card leaves its queue because of what happened to it (closed, review, archived, deleted, moved, or an automatic
 * status change). With `left`, a card that was current also writes the next-card notice row in the same transaction.
 */
export function leaveQueue(db: Database, taskId: string, input: { cause: string; actor: string; left?: string }): { noticeId: string | null } {
  return db.transaction(() => {
    const row = rowOf(db, taskId);
    if (!row) return { noticeId: null };
    const change: Change = { changeId: randomUUID(), at: nowIso(), projectId: row.project_id, threadId: row.thread_id, actor: input.actor };
    const order = queueRows(db, row.project_id, row.thread_id).map((entry) => entry.task_id).filter((id) => id !== taskId);
    applyOrder(db, change, order, { taskId, action: "remove", cause: input.cause });
    if (input.left === undefined || row.position !== 1 || order.length === 0) return { noticeId: null };
    const id = randomUUID();
    db.prepare<string[]>("INSERT INTO task_queue_notices(id, project_id, thread_id, from_task, to_task, created_at, state, attempts, from_key, reason) VALUES (?,?,?,?,?,?,'pending',0,?,?)")
      .run(id, row.project_id, row.thread_id, taskId, order[0]!, change.at, taskFacts(db, taskId).key, input.left);
    setTimeout(() => { for (const listener of noticeListeners) listener(); }, 0);
    return { noticeId: id };
  })();
}

/** Every queue of an executor thread that is archived or deleted goes away; nobody is left to tell. */
export function dropThreadQueues(db: Database, threadId: string, cause: string): number {
  return db.transaction(() => {
    const tasks = db.prepare<[string], { task_id: string }>("SELECT task_id FROM task_queue WHERE thread_id=? ORDER BY project_id, position DESC").all(threadId);
    for (const { task_id } of tasks) leaveQueue(db, task_id, { cause, actor: "Work Board" });
    return tasks.length;
  })();
}

/**
 * A status change of a queued card, inside the write's own transaction. Closing, or the current card reaching the review
 * status, ends its place and promotes the next card; a waiting card cannot enter work: a user path is refused, an
 * automatic path takes the card out of the queue with its cause.
 */
export function onStatusChange(db: Database, taskId: string, to: string, how: { automatic: boolean; by: string; cause?: string; label: string }): void {
  const row = rowOf(db, taskId);
  if (!row) return;
  const task = taskFacts(db, taskId);
  const zone = zoneOf(db, row.project_id);
  const phase = queuePhase(zone, to);
  const review = to === getWorkflowPolicy(zone).reviewStatus;
  if (phase === "closed") leaveQueue(db, taskId, { cause: "closed", actor: how.by, left: how.label });
  else if (row.position === 1 && review) leaveQueue(db, taskId, { cause: "review", actor: how.by, left: how.label });
  else if (phase === "work" && row.position >= 2) {
    if (!how.automatic)
      throw new Error(`${task.key} is queued #${row.position} for ${row.thread_id} and cannot start yet. Bring it to the front with bb work-board queue move ${task.key} --position 1 (the card now first must leave work), or take it out with bb work-board queue remove ${task.key}.`);
    leaveQueue(db, taskId, { cause: how.cause ?? "automatic", actor: how.by });
  }
}

export function listQueue(db: Database, input: { threadId?: string; projectId?: string }): ProjectQueue[] {
  if (!input.threadId && !input.projectId) throw new Error("threadId or projectId is required");
  const rows = db.prepare<[string | null, string | null, string | null, string | null], QueueRow & { key: string; title: string; status: string }>(
    `SELECT q.*, p.prefix || '-' || t.number AS key, t.title, t.status FROM task_queue q JOIN tasks t ON t.id=q.task_id JOIN projects p ON p.id=t.project_id
     WHERE (? IS NULL OR q.thread_id=?) AND (? IS NULL OR q.project_id=?) ORDER BY q.project_id, q.thread_id, q.position`).all(input.threadId ?? null, input.threadId ?? null, input.projectId ?? null, input.projectId ?? null);
  const grouped = new Map<string, ProjectQueue>();
  for (const row of rows) {
    const groupKey = JSON.stringify([row.project_id, row.thread_id]);
    const queue = grouped.get(groupKey) ?? { projectId: row.project_id, threadId: row.thread_id, entries: [] };
    queue.entries.push({ taskId: row.task_id, key: row.key, title: row.title, status: row.status, position: row.position, addedBy: row.added_by, addedAt: row.added_at });
    grouped.set(groupKey, queue);
  }
  return [...grouped.values()];
}

/** The queue place of each card, for the card metadata and `show --json`. */
export function queuePlaces(db: Database, taskIds: readonly string[]): Map<string, { threadId: string; position: number }> {
  const rows = db.prepare<[string], { task_id: string; thread_id: string; position: number }>("SELECT task_id, thread_id, position FROM task_queue WHERE task_id IN (SELECT value FROM json_each(?))").all(JSON.stringify(taskIds));
  return new Map(rows.map((row) => [row.task_id, { threadId: row.thread_id, position: row.position }]));
}
