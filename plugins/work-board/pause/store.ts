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
  reason: string; started_at: string; until: string | null; applied: number; coverage_started_at?: string | null;
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
    db.prepare<(string | number | null)[]>("INSERT INTO pause_log(project_id,task_id,task_key,at,event,source,signal,end_reason,thread_id,previous_threads,arm,applied,until,detail,signal_thread_id,pause_started_at,coverage_started_at) VALUES (?,?,?,?,'end',?,?,?,?,?,?,?,?,?,?,?,?)")
      // A manual end row describes its whole pause, so the report never needs the (prunable) start row.
      .run(task.project_id, taskId, task.key, at, row.source, row.signal, reason, actor, previous, loggedArm(db, task.project_id, taskId), row.applied, row.until, row.reason, row.thread_id, row.signal === "manual" ? row.started_at : null, row.signal === "manual" ? coverageOf(db, row) : null);
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
/** Inside the transaction that ends a manual pause by expiry: the one durable row that says a notice is owed. A second expiry pass changes nothing. */
export function recordExpiredManualPause(db: Database, pause: PauseRow, expiredAt: string): void {
  const task = db.prepare<[string], { project_id: string; key: string }>("SELECT t.project_id, p.prefix || '-' || t.number AS key FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?").get(pause.task_id);
  if (!task || pause.signal !== "manual" || !pause.until) return;
  db.prepare<string[]>("INSERT OR IGNORE INTO pause_expiry_notices(pause_id,project_id,task_id,task_key,setter,reason,started_at,until,expired_at,state) VALUES (?,?,?,?,?,?,?,?,?,'pending')")
    .run(pause.id, task.project_id, pause.task_id, task.key, pause.thread_id, pause.reason, pause.started_at, pause.until, expiredAt);
}
/** Ends the pauses whose deadline has passed (the sweep's rule), recording the notice a manual one owes. Call inside a transaction; `only` limits it to one card and some signals. */
export function expireDuePauses(db: Database, now: string, only?: { taskId: string; signals: readonly string[] }): void {
  for (const row of db.prepare<[string], PauseRow>("SELECT * FROM task_pauses WHERE signal IN ('manual','background') AND until<=?").all(now)) {
    if (only && (row.task_id !== only.taskId || !only.signals.includes(row.signal))) continue;
    if (endPauses(db, row.task_id, "expired", "system", { signal: row.signal, threadId: row.thread_id }) && row.signal === "manual") recordExpiredManualPause(db, row, now);
  }
}

/** The first instant a pause cannot end at: ISO strings of later dates stop sorting as text (`+010000-…`). */
const END_BOUND_MS = Date.UTC(10000, 0, 1);
/** Manual pauses within this gap of each other count as one continuous coverage. */
export const COVERAGE_GAP_MS = 5 * 60_000;
/** A manual pause as the coverage rules see it; `coverage` is null where it was never stored. */
export type PauseSpan = { start: number; end: number; coverage: number | null };
const time = (value: string | null | undefined) => (value ? Date.parse(value) : undefined);
/**
 * The ended manual pauses of a card (or of every card of a project) from the pause log, by card and in order of their start. An end row of
 * the current format describes its whole pause; an older one is paired with its start row (a pause whose start row was pruned cannot be
 * placed). A pause counts until its deadline at the latest, however late it was ended.
 */
export function endedManualSpans(db: Database, filter: { taskId: string } | { projectId: string }): Map<string, PauseSpan[]> {
  const rows = db.prepare<[string], { task_id: string; event: string; at: string; until: string | null; coverage_started_at: string | null; pause_started_at: string | null }>(`SELECT task_id,event,at,until,coverage_started_at,pause_started_at FROM pause_log WHERE ${"taskId" in filter ? "task_id" : "project_id"}=? AND signal='manual' AND event IN ('start','end') AND task_id IS NOT NULL ORDER BY id`).all("taskId" in filter ? filter.taskId : filter.projectId);
  const open = new Map<string, { at: number; coverage: number | null }>();
  const spans = new Map<string, PauseSpan[]>();
  for (const row of rows) {
    if (row.event === "start") { open.set(row.task_id, { at: Date.parse(row.at), coverage: time(row.coverage_started_at) ?? null }); continue; }
    const started = open.get(row.task_id);
    open.delete(row.task_id);
    const start = time(row.pause_started_at) ?? started?.at;
    if (start === undefined || !Number.isFinite(start)) continue;
    (spans.get(row.task_id) ?? spans.set(row.task_id, []).get(row.task_id)!).push({ start, end: Math.min(Date.parse(row.at), time(row.until) ?? Infinity), coverage: time(row.coverage_started_at) ?? started?.coverage ?? null });
  }
  for (const list of spans.values()) list.sort((a, b) => a.start - b.start);
  return spans;
}
/** Fills the missing coverage the v1 way, in place: a pause starting at most five minutes after the previous one ended continues its coverage. `spans` is sorted by start. */
export function fillCoverage(spans: PauseSpan[]): void {
  let previous: { end: number; coverage: number } | undefined;
  for (const span of spans) {
    span.coverage ??= previous && span.start - previous.end <= COVERAGE_GAP_MS ? previous.coverage : span.start;
    previous = { end: span.end, coverage: span.coverage };
  }
}
/** The coverage start of a manual pause: its stored value, or, for one that was already running when the column was added, the chain rebuilt from the older log rows. */
export function coverageOf(db: Database, pause: Pick<PauseRow, "task_id" | "started_at" | "coverage_started_at">): string {
  if (pause.coverage_started_at) return pause.coverage_started_at;
  const start = Date.parse(pause.started_at);
  const spans = (endedManualSpans(db, { taskId: pause.task_id }).get(pause.task_id) ?? []).filter(span => span.start < start);
  const own: PauseSpan = { start, end: start, coverage: null };
  spans.push(own);
  fillCoverage(spans);
  return new Date(own.coverage!).toISOString();
}
/** Where a new manual pause's coverage starts if it continues an earlier one: the pause it replaces, or the last one if it ended at most five minutes ago. */
function inheritedCoverage(db: Database, taskId: string, nowMs: number): string | null {
  // Only a pause still running here: one past its deadline was expired first, and a gap is counted from that deadline.
  const current = db.prepare<[string], PauseRow>("SELECT * FROM task_pauses WHERE task_id=? AND signal='manual'").get(taskId);
  if (current) return coverageOf(db, current);
  const spans = endedManualSpans(db, { taskId }).get(taskId) ?? [];
  const last = spans.at(-1);
  if (!last || nowMs - last.end > COVERAGE_GAP_MS) return null;
  fillCoverage(spans);
  return new Date(last.coverage!).toISOString();
}
export function startManualPause(db: Database, taskId: string, reason: string, durationMs: number, actor: string): PauseRow {
  const clean = reason.trim();
  if (!clean || clean.length > 300) throw new Error("Pause reason must contain 1–300 characters");
  if (!Number.isInteger(durationMs) || durationMs < 60_000) throw new Error("Pause duration must be at least 1 minute");
  // The one remaining upper bound is technical: the end must be a date with a four-digit year.
  if (!(Date.now() + durationMs < END_BOUND_MS)) throw new Error("Pause duration is too long: it must end before the year 10000");
  return db.transaction(() => {
    const task = context(db, taskId);
    const state = db.prepare<[string], { status: string; archived_at: string | null; statuses: string | null; workflow_policy: string | null }>("SELECT t.status,t.archived_at,p.statuses,p.workflow_policy FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?").get(taskId)!;
    if (state.archived_at || isClosedStatus({ workflowPolicy: state.workflow_policy ? JSON.parse(state.workflow_policy) : null }, state.status)) throw new Error("Cannot pause a closed or archived card");
    const at = new Date().toISOString();
    if (!(Date.parse(at) + durationMs < END_BOUND_MS)) throw new Error("Pause duration is too long: it must end before the year 10000");
    // A pause already past its deadline expired (and owes its notice) before this one is set, not when the sweep gets to it.
    expireDuePauses(db, at, { taskId, signals: ["manual"] });
    const inherited = inheritedCoverage(db, taskId, Date.parse(at));
    endPauses(db, taskId, "replaced", actor);
    const until = new Date(Date.parse(at) + durationMs).toISOString();
    const row: PauseRow = { id: randomUUID(), task_id: taskId, source: "manual", signal: "manual", thread_id: actor, reason: clean, started_at: at, until, applied: 1, coverage_started_at: inherited ?? at };
    db.prepare<(string | number | null)[]>("INSERT INTO task_pauses(id,task_id,source,signal,thread_id,reason,started_at,until,applied,coverage_started_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(row.id, taskId, row.source, row.signal, row.thread_id, row.reason, row.started_at, row.until, row.applied, row.coverage_started_at!);
    db.prepare<(string | number | null)[]>("INSERT INTO pause_log(project_id,task_id,task_key,at,event,source,signal,thread_id,arm,applied,until,detail,coverage_started_at) VALUES (?,?,?,?,'start','manual','manual',?,?,1,?,?,?)").run(task.project_id, taskId, task.key, at, actor, loggedArm(db, task.project_id, taskId), until, clean, row.coverage_started_at!);
    comment(db, taskId, `Paused by ${actor}: ${clean}, until ${until}`, at);
    touchAttention(db, [taskId]);
    return row;
  })();
}
