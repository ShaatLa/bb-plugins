import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { managerOf, zoneOf } from "../queue/store";
import type { StartAgent } from "../shared/contract";
import { isClosedStatus } from "../shared/workflow-policy";
import { cardComment } from "../notices/once";
import { formatStartTime, withoutFinalPeriod } from "./when";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;
export type StartMode = "spawn_gate" | "preset";
export type StartState = "scheduled" | "launching" | "launched" | "refused" | "unknown" | "canceled";
export type StartEvent = "scheduled" | "changed" | "canceled" | "launching" | "launched" | "refused" | "unknown" | "reconciled" | "resolved";
/** What a card's schedule is for: the launch mode with its parameters. A Work Board launch holds a preset or an agent, never both. */
export type Launch = { mode: "spawn_gate"; args: string[] } | { mode: "preset"; presetId?: string; agent?: StartAgent; brief?: string };
export interface ScheduledStart {
  id: string; taskId: string; projectId: string; startAt: string; mode: StartMode;
  builderArgs: string[] | null; presetId: string | null; agent: StartAgent | null; extraInstructions: string | null;
  setter: string; state: StartState; launchId: string | null; policyError: string | null; attemptedAt: string | null;
  threadId: string | null; parentThreadId: string | null; attached: boolean; error: string | null; reasonCode: string | null;
  createdAt: string; updatedAt: string;
}
interface Row {
  id: string; task_id: string; project_id: string; start_at: string; mode: StartMode; builder_args: string | null; preset_id: string | null; agent: string | null; extra_instructions: string | null;
  setter: string; state: StartState; launch_id: string | null; policy_error: string | null; attempted_at: string | null; thread_id: string | null; parent_thread_id: string | null;
  attached: number; error: string | null; reason_code: string | null; created_at: string; updated_at: string;
}
export const ACTIVE_STATES = ["scheduled", "launching", "unknown"] as const;
/** A refusal that leaves the card carrying its reason until the next schedule: these are the states the chips show. */
export const PROBLEM_STATES = ["refused", "unknown"] as const;
export const markerOf = (launchId: string) => `<!-- work-board-scheduled-start:${launchId} -->`;

export const toStart = (row: Row): ScheduledStart => ({
  id: row.id, taskId: row.task_id, projectId: row.project_id, startAt: row.start_at, mode: row.mode,
  builderArgs: row.builder_args ? (JSON.parse(row.builder_args) as string[]) : null, presetId: row.preset_id, agent: row.agent ? (JSON.parse(row.agent) as StartAgent) : null, extraInstructions: row.extra_instructions,
  setter: row.setter, state: row.state, launchId: row.launch_id, policyError: row.policy_error, attemptedAt: row.attempted_at,
  threadId: row.thread_id, parentThreadId: row.parent_thread_id, attached: row.attached === 1, error: row.error, reasonCode: row.reason_code,
  createdAt: row.created_at, updatedAt: row.updated_at,
});

export interface CardFacts { id: string; projectId: string; key: string; title: string; archived: boolean; closed: boolean }
export function cardFacts(db: Database, taskId: string): CardFacts | undefined {
  const row = db.prepare<[string], { id: string; project_id: string; status: string; archived_at: string | null; key: string; title: string }>("SELECT t.id, t.project_id, t.status, t.archived_at, p.prefix || '-' || t.number AS key, t.title FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?").get(taskId);
  if (!row) return undefined;
  return { id: row.id, projectId: row.project_id, key: row.key, title: row.title, archived: row.archived_at !== null, closed: isClosedStatus(zoneOf(db, row.project_id), row.status) };
}

export function activeStart(db: Database, taskId: string): ScheduledStart | undefined {
  const row = db.prepare<[string], Row>("SELECT * FROM scheduled_starts WHERE task_id=? AND state IN ('scheduled','launching','unknown')").get(taskId);
  return row && toStart(row);
}
export function getStart(db: Database, id: string): ScheduledStart | undefined {
  const row = db.prepare<[string], Row>("SELECT * FROM scheduled_starts WHERE id=?").get(id);
  return row && toStart(row);
}
/** The active start, else the latest one (a refused or unknown one stays on the card until the next schedule). */
export function currentStart(db: Database, taskId: string): ScheduledStart | undefined {
  const row = db.prepare<[string], Row>("SELECT * FROM scheduled_starts WHERE task_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(taskId);
  return row && toStart(row);
}

const presetName = (db: Database, id: string | null) => (id ? db.prepare<[string], { name: string }>("SELECT name FROM presets WHERE id=?").get(id)?.name ?? id : "");
/** `agent codex/gpt-5, high`: the provider and model, then the reasoning level when there is one. */
export const describeAgent = (agent: StartAgent) => `agent ${agent.providerId}/${agent.model}${agent.reasoningLevel ? `, ${agent.reasoningLevel}` : ""}`;
export function describeLaunch(db: Database, start: Pick<ScheduledStart, "mode" | "builderArgs" | "presetId" | "agent">): string {
  return start.mode === "spawn_gate" ? `Spawn Gate \`${(start.builderArgs ?? []).join(" ")}\`` : start.agent ? describeAgent(start.agent) : `preset ${presetName(db, start.presetId)}`;
}
/** A Work Board launch is a preset or an agent, exactly one; the table cannot say so, so every write checks it. */
function assertTarget(launch: Launch): void {
  if (launch.mode === "preset" && Boolean(launch.presetId) === Boolean(launch.agent)) throw new Error("A start launches from a preset or an agent, exactly one");
}
const launchColumns = (launch: Launch) => [
  launch.mode, launch.mode === "spawn_gate" ? JSON.stringify(launch.args) : null, launch.mode === "preset" ? launch.presetId ?? null : null,
  launch.mode === "preset" && launch.agent ? JSON.stringify(launch.agent) : null, launch.mode === "preset" ? launch.brief ?? null : null,
];

/** One log row and one system comment for an event; call inside the transaction of the change itself. */
export function recordEvent(db: Database, start: ScheduledStart, key: string, event: StartEvent, actor: string, detail: Record<string, unknown>, comment: string | null, at = new Date().toISOString()): void {
  db.prepare<(string | null)[]>("INSERT INTO scheduled_start_log(task_id,task_key,project_id,start_id,at,event,actor,detail) VALUES (?,?,?,?,?,?,?,?)")
    .run(start.taskId, key, start.projectId, start.id, at, event, actor, JSON.stringify(detail));
  if (comment) cardComment(db, start.taskId, comment, at);
}
const launchDetail = (start: ScheduledStart) => ({ at: start.startAt, mode: start.mode, ...(start.builderArgs ? { args: start.builderArgs } : {}), ...(start.presetId ? { presetId: start.presetId } : {}), ...(start.agent ? { agent: start.agent } : {}), parentThreadId: start.parentThreadId });

/** Who may change, cancel or resolve a start: the setter, the project's manager, the owner. */
export function assertMayEdit(db: Database, start: ScheduledStart, actor: string): void {
  if (actor === "owner" || actor === start.setter || actor === managerOf(db, start.projectId)) return;
  throw new Error(`Only the setter (${start.setter}), the project's manager or the owner may change this scheduled start`);
}

export interface NewStart { taskId: string; startAt: string; launch: Launch; setter: string; parentThreadId: string }
export function insertStart(db: Database, input: NewStart): ScheduledStart {
  return db.transaction(() => {
    const card = cardFacts(db, input.taskId);
    if (!card) throw new Error("Task not found");
    if (card.archived || card.closed) throw new Error(`${card.key} is closed or archived; a closed card cannot be scheduled`);
    const previous = db.prepare<[string], { state: StartState }>("SELECT state FROM scheduled_starts WHERE task_id=? AND state IN ('scheduled','launching','unknown')").get(input.taskId);
    if (previous) throw new Error(previous.state === "unknown" ? `${card.key} has a start whose outcome is unknown: resolve the previous start first (schedule resolve)` : `${card.key} already has a scheduled start: use schedule change or schedule cancel`);
    assertTarget(input.launch);
    const at = new Date().toISOString(), id = randomUUID();
    db.prepare<(string | null)[]>("INSERT INTO scheduled_starts(id,task_id,project_id,start_at,mode,builder_args,preset_id,agent,extra_instructions,setter,state,parent_thread_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,'scheduled',?,?,?)")
      .run(id, input.taskId, card.projectId, input.startAt, ...launchColumns(input.launch), input.setter, input.parentThreadId, at, at);
    const start = getStart(db, id)!;
    recordEvent(db, start, card.key, "scheduled", input.setter, launchDetail(start), `Start scheduled for ${formatStartTime(start.startAt)} by ${input.setter}: ${describeLaunch(db, start)}`, at);
    return start;
  })();
}

/** Both guard on `state='scheduled'`: a start the sweep has already claimed is refused here, never reported as changed or canceled. */
function refusedBecause(db: Database, id: string, verb: string): never {
  const state = getStart(db, id)?.state ?? "gone";
  throw new Error(state === "launching" ? `The launch is already in progress; ${verb} is no longer possible` : `The start is ${state}; ${verb} is no longer possible`);
}
export function changeStart(db: Database, id: string, actor: string, change: { startAt?: string; launch?: Launch; parentThreadId: string }): ScheduledStart {
  return db.transaction(() => {
    const before = getStart(db, id);
    if (!before) throw new Error("Scheduled start not found");
    assertMayEdit(db, before, actor);
    const card = cardFacts(db, before.taskId)!;
    if (card.archived || card.closed) throw new Error(`${card.key} is closed or archived`);
    const launch = change.launch;
    if (launch) assertTarget(launch);
    const at = new Date().toISOString();
    const columns = launch ? launchColumns(launch) : [before.mode, before.builderArgs && JSON.stringify(before.builderArgs), before.presetId, before.agent && JSON.stringify(before.agent), before.extraInstructions];
    const result = db.prepare<(string | null)[]>("UPDATE scheduled_starts SET start_at=?, mode=?, builder_args=?, preset_id=?, agent=?, extra_instructions=?, parent_thread_id=?, policy_error=NULL, updated_at=? WHERE id=? AND state='scheduled'")
      .run(change.startAt ?? before.startAt, ...columns, change.parentThreadId, at, id);
    if (!result.changes) refusedBecause(db, id, "change");
    const start = getStart(db, id)!;
    recordEvent(db, start, card.key, "changed", actor, { ...launchDetail(start), previousAt: before.startAt }, `Scheduled start changed by ${actor}: ${formatStartTime(start.startAt)}, ${describeLaunch(db, start)}`, at);
    return start;
  })();
}
export function cancelStart(db: Database, id: string, actor: string, reason?: string): ScheduledStart {
  return db.transaction(() => {
    const before = getStart(db, id);
    if (!before) throw new Error("Scheduled start not found");
    assertMayEdit(db, before, actor);
    const at = new Date().toISOString();
    const result = db.prepare<(string | null)[]>("UPDATE scheduled_starts SET state='canceled', error=?, updated_at=? WHERE id=? AND state='scheduled'").run(reason ?? null, at, id);
    if (!result.changes) refusedBecause(db, id, "cancel");
    const start = getStart(db, id)!;
    recordEvent(db, start, cardFacts(db, start.taskId)!.key, "canceled", actor, { ...(reason ? { reason } : {}) }, `Scheduled start canceled by ${actor}${reason ? `: ${reason}` : ""}`, at);
    return start;
  })();
}

/** The oldest due start becomes `launching`, or undefined; `skip` holds starts already handled in this pass. A cancel or change that committed first leaves nothing to claim. */
export function claimDue(db: Database, now: string, skip: ReadonlySet<string> = new Set()): ScheduledStart | undefined {
  return db.transaction(() => {
    const due = db.prepare<string[], Row>(`SELECT * FROM scheduled_starts WHERE state='scheduled' AND start_at<=? ${skip.size ? `AND id NOT IN (${[...skip].map(() => "?").join(",")})` : ""} ORDER BY start_at, created_at, rowid LIMIT 1`).get(now, ...skip);
    if (!due) return undefined;
    const claimed = db.prepare<[string, string, string, string]>("UPDATE scheduled_starts SET state='launching', attempted_at=?, launch_id=?, updated_at=? WHERE id=? AND state='scheduled'").run(now, randomUUID(), now, due.id);
    if (!claimed.changes) return undefined;
    const start = getStart(db, due.id)!;
    const card = cardFacts(db, start.taskId);
    recordEvent(db, start, card?.key ?? start.taskId, "launching", "system", { launchId: start.launchId }, null, now);
    return start;
  })();
}

/** The parent the launch is about to use, saved before the call so a crash right after a spawn still knows whose children to search. */
export function setLaunchParent(db: Database, id: string, parentThreadId: string): boolean {
  return db.prepare<[string, string]>("UPDATE scheduled_starts SET parent_thread_id=? WHERE id=? AND state='launching'").run(parentThreadId, id).changes > 0;
}

/** Back to `scheduled` after a policy read failed before anything launched. */
export function releaseClaim(db: Database, id: string, policyError: string): void {
  db.prepare<[string, string, string]>("UPDATE scheduled_starts SET state='scheduled', policy_error=?, updated_at=? WHERE id=? AND state='launching'").run(policyError, new Date().toISOString(), id);
}

export type Outcome =
  | { state: "launched"; threadId: string; event?: "launched" | "reconciled" }
  | { state: "refused" | "unknown"; error: string; reasonCode?: string | null }
  | { state: "canceled"; error: string };
const NOTICE_KINDS = new Set(["refused", "unknown"]);
const OUTCOME_COMMENT = (key: string, outcome: Outcome) =>
  outcome.state === "launched" ? (outcome.event === "reconciled" ? `Scheduled start launched ${outcome.threadId} (found by its marker after a restart)` : `Scheduled start launched ${outcome.threadId}`)
  : outcome.state === "refused" ? `Scheduled start refused, nothing was started: ${withoutFinalPeriod(outcome.error)}`
  : outcome.state === "unknown" ? `Scheduled start outcome unknown: ${withoutFinalPeriod(outcome.error)}. A session may exist and nothing is retried. Check the project's threads, then run: bb work-board schedule resolve ${key} --launched <thread> | --not-launched`
  : `Scheduled start canceled: ${outcome.error}`;

/** One transaction: the new state, the log row, the card comment and, for refused and unknown, the notice row. */
export function recordOutcome(db: Database, id: string, from: "launching" | "unknown", outcome: Outcome, actor = "system"): ScheduledStart | undefined {
  return db.transaction(() => {
    const before = getStart(db, id);
    if (!before || before.state !== from) return undefined;
    const at = new Date().toISOString();
    const failed = outcome.state === "refused" || outcome.state === "unknown";
    db.prepare<(string | null)[]>("UPDATE scheduled_starts SET state=?, thread_id=?, error=?, reason_code=?, policy_error=NULL, updated_at=? WHERE id=?")
      .run(outcome.state, outcome.state === "launched" ? outcome.threadId : before.threadId, outcome.state === "launched" ? null : outcome.error, failed ? outcome.reasonCode ?? null : null, at, id);
    const start = getStart(db, id)!;
    const key = cardFacts(db, start.taskId)?.key ?? start.taskId;
    const event: StartEvent = outcome.state === "launched" ? outcome.event ?? "launched" : outcome.state === "canceled" ? "canceled" : outcome.state;
    recordEvent(db, start, key, event, actor, { ...launchDetail(start), ...(outcome.state === "launched" ? { threadId: outcome.threadId } : { error: outcome.error }), ...(failed && outcome.reasonCode ? { reasonCode: outcome.reasonCode } : {}) }, OUTCOME_COMMENT(key, outcome), at);
    if (NOTICE_KINDS.has(outcome.state)) {
      db.prepare<string[]>("INSERT INTO scheduled_start_notices(notice_id,start_id,project_id,task_id,task_key,setter,kind,detail,created_at,state) VALUES (?,?,?,?,?,?,?,?,?,'pending')")
        .run(randomUUID(), id, start.projectId, start.taskId, key, start.setter, outcome.state, (outcome as { error: string }).error, at);
    }
    return start;
  })();
}

/** The manual answer to an `unknown` start: the thread it did start, or that it started nothing. */
export function resolveStart(db: Database, id: string, actor: string, result: { launched: string } | { notLaunched: true }): ScheduledStart {
  return db.transaction(() => {
    const before = getStart(db, id);
    if (!before) throw new Error("Scheduled start not found");
    assertMayEdit(db, before, actor);
    if (before.state !== "unknown") throw new Error(`The start is ${before.state}; only a start with an unknown outcome is resolved`);
    const at = new Date().toISOString();
    const launched = "launched" in result;
    db.prepare<(string | null)[]>("UPDATE scheduled_starts SET state=?, thread_id=?, error=?, updated_at=? WHERE id=?").run(launched ? "launched" : "canceled", launched ? result.launched : null, launched ? null : "Marked as not launched", at, id);
    const start = getStart(db, id)!;
    const key = cardFacts(db, start.taskId)?.key ?? start.taskId;
    recordEvent(db, start, key, "resolved", actor, launched ? { threadId: result.launched } : { launched: false }, launched ? `Scheduled start resolved by ${actor}: launched ${result.launched}` : `Scheduled start resolved by ${actor}: nothing was launched`, at);
    return start;
  })();
}

export function markAttached(db: Database, id: string): void {
  db.prepare<[string]>("UPDATE scheduled_starts SET attached=1 WHERE id=?").run(id);
}

export interface StartLogRow { id: number; taskId: string | null; taskKey: string | null; projectId: string | null; startId: string | null; at: string; event: StartEvent; actor: string | null; detail: Record<string, unknown> }
export function listLog(db: Database, filter: { taskId?: string; projectId?: string; limit?: number }): StartLogRow[] {
  const where = [filter.taskId ? "task_id=?" : "", filter.projectId ? "project_id=?" : ""].filter(Boolean);
  const rows = db.prepare<string[], { id: number; task_id: string | null; task_key: string | null; project_id: string | null; start_id: string | null; at: string; event: StartEvent; actor: string | null; detail: string | null }>(`SELECT * FROM scheduled_start_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ${Math.min(Math.max(filter.limit ?? 100, 1), 1000)}`)
    .all(...[filter.taskId, filter.projectId].filter((value): value is string => Boolean(value)));
  return rows.reverse().map((row) => ({ id: row.id, taskId: row.task_id, taskKey: row.task_key, projectId: row.project_id, startId: row.start_id, at: row.at, event: row.event, actor: row.actor, detail: row.detail ? (JSON.parse(row.detail) as Record<string, unknown>) : {} }));
}
/** Log rows older than this many days are dropped, as the pause log's are. */
export const LOG_KEEP_DAYS = 90;
export function pruneLog(db: Database, now = Date.now()): void {
  db.prepare<[string]>("DELETE FROM scheduled_start_log WHERE at<?").run(new Date(now - LOG_KEEP_DAYS * 86_400_000).toISOString());
}

/** The start each card shows: its active one, else a refused or unknown one, else a launch of the last 24 hours. */
export function startsForCards(db: Database, taskIds: readonly string[], now = Date.now()): Map<string, ScheduledStart> {
  const result = new Map<string, ScheduledStart>();
  if (!taskIds.length) return result;
  const rows = db.prepare<string[], Row>(`SELECT * FROM scheduled_starts WHERE task_id IN (${taskIds.map(() => "?").join(",")}) ORDER BY created_at, rowid`).all(...taskIds);
  const recent = new Date(now - 24 * 3_600_000).toISOString();
  for (const row of rows) {
    const start = toStart(row);
    // Rows run oldest to newest, so the latest start of a card wins.
    if (start.state === "canceled" || (start.state === "launched" && start.updatedAt < recent)) result.delete(start.taskId);
    else result.set(start.taskId, start);
  }
  return result;
}
