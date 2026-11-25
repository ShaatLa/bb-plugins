import { createHash, randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { notifyAttentionChanged, touchAttention } from "../attention/ledger";
import { isClosedStatus } from "../shared/workflow-policy";
import { createUlid } from "../db/store";
import { transitionExecutors } from "./executor";
import { MAX_PAUSE_MS } from "../shared/pause";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;
export type PauseEndReason = "resume" | "status_change" | "turn_started" | "takeover" | "signal_cleared" | "expired" | "replaced" | "mode_change";
export interface PauseRow {
  id: string; task_id: string; source: string; signal: string; thread_id: string;
  reason: string; started_at: string; until: string | null; applied: number;
}
export function pauseArm(taskId: string): "control" | "auto" {
  return createHash("sha256").update(taskId).digest()[0]! % 2 ? "auto" : "control";
}
function context(db: Database, taskId: string) {
  const task = db.prepare<[string], { project_id: string; key: string }>("SELECT t.project_id, p.prefix || '-' || t.number AS key FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?").get(taskId);
  if (!task) throw new Error("Task not found");
  return task;
}
function loggedArm(db: Database, projectId: string, taskId: string): "control" | "auto" {
  return db.prepare<[string], { mode: string }>("SELECT mode FROM pause_modes WHERE project_id=?").get(projectId)?.mode === "on" ? "auto" : pauseArm(taskId);
}
function comment(db: Database, taskId: string, body: string, at: string) {
  db.prepare<[string, string, string, string]>("INSERT INTO comments(id, task_id, kind, author_name, body, created_at) VALUES (?, ?, 'system', 'Work Board', ?, ?)").run(createUlid(), taskId, body, at);
}
/** Call inside the transaction of the action ending the pause. */
export function endPauses(db: Database, taskId: string, reason: PauseEndReason, actor: string, filter?: { signal?: string; threadId?: string; autoOnly?: boolean }): number {
  const rows = db.prepare<[string], PauseRow>("SELECT * FROM task_pauses WHERE task_id=?").all(taskId)
    .filter(row => (filter?.signal ? row.signal === filter.signal : filter?.autoOnly ? row.source === "auto" : row.signal === "manual" || row.signal === "background") && (!filter?.threadId || row.thread_id === filter.threadId));
  if (!rows.length) return 0;
  const task = context(db, taskId);
  const at = new Date().toISOString();
  const threads = db.prepare<[string, string], { thread_id: string }>("SELECT thread_id FROM task_threads WHERE task_id=? AND thread_id<>? AND live_status NOT IN ('completed','failed')").all(taskId, actor).map(row => row.thread_id);
  for (const row of rows) {
    db.prepare<[string]>("DELETE FROM task_pauses WHERE id=?").run(row.id);
    if (row.signal === "background" && reason !== "signal_cleared" && reason !== "mode_change") {
      const release = reason === "turn_started" || reason === "status_change" ? "idle" : "cleared";
      db.prepare<[string, string, string]>("INSERT INTO pause_latches(task_id, thread_id, release_on) VALUES (?, ?, ?) ON CONFLICT(task_id, thread_id) DO UPDATE SET release_on=excluded.release_on").run(taskId, row.thread_id, release);
    }
    const previous = reason === "takeover" ? JSON.stringify([...new Set([...threads, row.thread_id])].filter(id => id !== actor)) : null;
    db.prepare<(string | number | null)[]>("INSERT INTO pause_log(project_id,task_id,task_key,at,event,source,signal,end_reason,thread_id,previous_threads,arm,applied,until,detail,signal_thread_id) VALUES (?,?,?,?,'end',?,?,?,?,?,?,?,?,?,?)")
      .run(task.project_id, taskId, task.key, at, row.source, row.signal, reason, actor, previous, loggedArm(db, task.project_id, taskId), row.applied, row.until, row.reason, row.thread_id);
    if (row.applied) comment(db, taskId, `Resumed: ${reason.replaceAll("_", " ")} by ${actor} (pause: ${row.reason})`, at);
  }
  touchAttention(db, [taskId]);
  return rows.length;
}
export function startSignalPause(db: Database, taskId: string, signal: "background" | "held" | "owner_question", threadId: string, reason: string, applied: boolean): void {
  const task = context(db, taskId);
  const at = new Date().toISOString();
  const until = signal === "background" ? new Date(Date.parse(at) + MAX_PAUSE_MS).toISOString() : null;
  db.prepare<(string | number | null)[]>("INSERT INTO task_pauses(id,task_id,source,signal,thread_id,reason,started_at,until,applied) VALUES (?,?,'auto',?,?,?,?,?,?)")
    .run(randomUUID(), taskId, signal, threadId, reason, at, until, applied ? 1 : 0);
  db.prepare<(string | number | null)[]>("INSERT INTO pause_log(project_id,task_id,task_key,at,event,source,signal,thread_id,arm,applied,until,detail,signal_thread_id) VALUES (?,?,?,?,'start','auto',?,?,?,?,?,?,?)")
    .run(task.project_id, taskId, task.key, at, signal, threadId, loggedArm(db, task.project_id, taskId), applied ? 1 : 0, until, reason, threadId);
  if (applied) comment(db, taskId, `Paused automatically: ${reason}${until ? `, until ${until}` : ""}`, at);
  touchAttention(db, [taskId]);
}
export function setPauseMode(db: Database, projectId: string, mode: "off" | "ab" | "on"): void {
  db.transaction(() => {
    const previous = db.prepare<[string], { mode: string }>("SELECT mode FROM pause_modes WHERE project_id=?").get(projectId)?.mode ?? "off";
    if (previous === mode) return;
    const ids = db.prepare<[string], { task_id: string }>("SELECT DISTINCT x.task_id FROM task_pauses x JOIN tasks t ON t.id=x.task_id WHERE t.project_id=? AND x.source='auto'").all(projectId);
    for (const { task_id } of ids) endPauses(db, task_id, "mode_change", "owner", { autoOnly: true });
    db.prepare<[string]>("DELETE FROM pause_latches WHERE task_id IN (SELECT id FROM tasks WHERE project_id=?)").run(projectId);
    const at = new Date().toISOString();
    db.prepare<[string, string, string]>("INSERT INTO pause_modes(project_id,mode,changed_at) VALUES (?,?,?) ON CONFLICT(project_id) DO UPDATE SET mode=excluded.mode,changed_at=excluded.changed_at").run(projectId, mode, at);
    transitionExecutors(db, projectId);
    db.prepare<[string, string, string]>("INSERT INTO pause_log(project_id,at,event,detail) VALUES (?,?,'mode',?)").run(projectId, at, JSON.stringify({ previous, mode }));
  })();
  notifyAttentionChanged(projectId);
}
export function startManualPause(db: Database, taskId: string, reason: string, durationMs: number, actor: string): PauseRow {
  const clean = reason.trim();
  if (!clean || clean.length > 300) throw new Error("Pause reason must contain 1–300 characters");
  if (!Number.isInteger(durationMs) || durationMs < 60_000 || durationMs > MAX_PAUSE_MS) throw new Error("Pause duration must be between 1 minute and 8 hours");
  return db.transaction(() => {
    const task = context(db, taskId);
    const state = db.prepare<[string], { status: string; archived_at: string | null; statuses: string | null; workflow_policy: string | null }>("SELECT t.status,t.archived_at,p.statuses,p.workflow_policy FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?").get(taskId)!;
    if (state.archived_at || isClosedStatus({ workflowPolicy: state.workflow_policy ? JSON.parse(state.workflow_policy) : null }, state.status)) throw new Error("Cannot pause a closed or archived card");
    endPauses(db, taskId, "replaced", actor);
    const at = new Date().toISOString();
    const until = new Date(Date.parse(at) + durationMs).toISOString();
    const row: PauseRow = { id: randomUUID(), task_id: taskId, source: "manual", signal: "manual", thread_id: actor, reason: clean, started_at: at, until, applied: 1 };
    db.prepare<(string | number | null)[]>("INSERT INTO task_pauses(id,task_id,source,signal,thread_id,reason,started_at,until,applied) VALUES (?,?,?,?,?,?,?,?,?)").run(...Object.values(row));
    db.prepare<(string | number | null)[]>("INSERT INTO pause_log(project_id,task_id,task_key,at,event,source,signal,thread_id,arm,applied,until,detail) VALUES (?,?,?,?,'start','manual','manual',?,?,1,?,?)").run(task.project_id, taskId, task.key, at, actor, loggedArm(db, task.project_id, taskId), until, clean);
    comment(db, taskId, `Paused by ${actor}: ${clean}, until ${until}`, at);
    touchAttention(db, [taskId]);
    return row;
  })();
}
