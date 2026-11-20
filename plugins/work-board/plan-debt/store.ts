import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { PlanState } from "../shared/plan";
import { hasPlanDebt, PLAN_DEBT_REMINDER_MS, type PlanDebtInfo } from "../shared/plan-debt";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

export type NoticeState = "pending" | "sending" | "sent" | "failed" | "unknown";
export interface NoticeRow {
  episodeId: number; trigger: string; destination: string; marker: string; state: NoticeState; attempts: number;
  lastError: string | null; cursor: string | null; updatedAt: string; taskId: string; projectId: string; eventAt: string;
}
export interface PendingEvent { episodeId: number; trigger: string; taskId: string; projectId: string }

const CARD = `SELECT t.id, t.project_id, t.type, t.status, t.archived_at, p.planning, p.statuses, p.workflow_policy, pl.state AS plan_state
  FROM tasks t JOIN projects p ON p.id = t.project_id LEFT JOIN task_plans pl ON pl.task_id = t.id`;
type CardRow = { id: string; project_id: string; type: string; status: string; archived_at: string | null; planning: string | null; statuses: string | null; workflow_policy: string | null; plan_state: PlanState | null };

/**
 * Applies the plan-debt definition to one card and opens or closes its episode. It is called inside the transaction of every
 * write that can start or end debt, so leaving and re-entering (or losing approval again) always starts a new episode.
 */
export function syncPlanDebt(db: Database, taskId: string): void {
  const card = db.prepare<[string], CardRow>(`${CARD} WHERE t.id = ?`).get(taskId);
  if (!card) return;
  const debt = hasPlanDebt({ planning: card.planning, workflowPolicy: card.workflow_policy ? JSON.parse(card.workflow_policy) : null, statuses: card.statuses ? JSON.parse(card.statuses) : null }, { type: card.type, status: card.status, archivedAt: card.archived_at }, card.plan_state);
  const open = db.prepare<[string], { id: number }>("SELECT id FROM plan_debt_episodes WHERE task_id = ? AND ended_at IS NULL").get(taskId);
  if (debt && !open) db.prepare("INSERT INTO plan_debt_episodes (task_id, since) VALUES (?, ?)").run(taskId, new Date().toISOString());
  else if (!debt && open) db.prepare("UPDATE plan_debt_episodes SET ended_at = ? WHERE id = ?").run(new Date().toISOString(), open.id);
}

/** One pass over a project's cards, for a change of its planning, status flags or workflow policy. */
export function syncProjectPlanDebt(db: Database, projectId: string): void {
  for (const row of db.prepare<[string], { id: string }>("SELECT id FROM tasks WHERE project_id = ?").all(projectId)) syncPlanDebt(db, row.id);
}

/** The scan's repair: every card of a required-planning project, plus every card that still has an open episode. */
export function repairPlanDebt(db: Database): void {
  const ids = db.prepare<[], { id: string }>("SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.planning = 'required' UNION SELECT task_id FROM plan_debt_episodes WHERE ended_at IS NULL").all();
  for (const { id } of ids) syncPlanDebt(db, id);
}

/** The open episode of a card with the plan as it is now; null when the card has no debt. */
export function openPlanDebt(db: Database, taskId: string): PlanDebtInfo | null {
  const row = db.prepare<[string], { since: string; version: number | null; state: PlanState | null }>(
    "SELECT e.since, pl.version, pl.state FROM plan_debt_episodes e LEFT JOIN task_plans pl ON pl.task_id = e.task_id WHERE e.task_id = ? AND e.ended_at IS NULL",
  ).get(taskId);
  return row ? { since: row.since, planVersion: row.version, planState: row.state } : null;
}

/** The open episodes of the given cards (with the card key), in bounded batches. */
export function openPlanDebts(db: Database, taskIds: readonly string[]): Map<string, PlanDebtInfo & { key: string }> {
  const result = new Map<string, PlanDebtInfo & { key: string }>();
  for (let offset = 0; offset < taskIds.length; offset += 500) {
    const ids = taskIds.slice(offset, offset + 500);
    const rows = db.prepare<string[], { id: string; key: string; since: string; version: number | null; state: PlanState | null }>(
      `SELECT t.id, p.prefix || '-' || t.number AS key, e.since, pl.version, pl.state FROM plan_debt_episodes e JOIN tasks t ON t.id = e.task_id JOIN projects p ON p.id = t.project_id
       LEFT JOIN task_plans pl ON pl.task_id = e.task_id WHERE e.ended_at IS NULL AND e.task_id IN (${ids.map(() => "?").join(",")})`,
    ).all(...ids);
    for (const row of rows) result.set(row.id, { key: row.key, since: row.since, planVersion: row.version, planState: row.state });
  }
  return result;
}

/** The debt of one episode, as long as that exact episode is open. */
export function openEpisodeDebt(db: Database, episodeId: number): PlanDebtInfo | null {
  const row = db.prepare<[number], { since: string; version: number | null; state: PlanState | null }>(
    "SELECT e.since, pl.version, pl.state FROM plan_debt_episodes e LEFT JOIN task_plans pl ON pl.task_id = e.task_id WHERE e.id = ? AND e.ended_at IS NULL",
  ).get(episodeId);
  return row ? { since: row.since, planVersion: row.version, planState: row.state } : null;
}

/** Records a trigger as an event of the card's open episode, once per episode and key. False when there is no debt or the event is not new. */
export function recordPlanDebtEvent(db: Database, taskId: string, trigger: string): boolean {
  return db.prepare(
    "INSERT OR IGNORE INTO plan_debt_events (episode_id, trigger, created_at) SELECT id, ?, ? FROM plan_debt_episodes WHERE task_id = ? AND ended_at IS NULL",
  ).run(trigger, new Date().toISOString(), taskId).changes > 0;
}

export const hasPlanDebtEvent = (db: Database, taskId: string, trigger: string): boolean =>
  Boolean(db.prepare("SELECT 1 FROM plan_debt_events ev JOIN plan_debt_episodes e ON e.id = ev.episode_id WHERE e.task_id = ? AND e.ended_at IS NULL AND ev.trigger = ?").get(taskId, trigger));

/** The 24 h due point of each open episode, written once. */
export function writeDueReminders(db: Database, now = Date.now()): void {
  db.prepare("INSERT OR IGNORE INTO plan_debt_events (episode_id, trigger, created_at) SELECT id, '24h', ? FROM plan_debt_episodes WHERE ended_at IS NULL AND since <= ?")
    .run(new Date(now).toISOString(), new Date(now - PLAN_DEBT_REMINDER_MS).toISOString());
}

export function unexpandedEvents(db: Database): PendingEvent[] {
  return db.prepare<[], { episode_id: number; trigger: string; task_id: string; project_id: string }>(
    `SELECT ev.episode_id, ev.trigger, e.task_id, t.project_id FROM plan_debt_events ev JOIN plan_debt_episodes e ON e.id = ev.episode_id JOIN tasks t ON t.id = e.task_id
     WHERE ev.expanded = 0 AND e.ended_at IS NULL ORDER BY ev.created_at, ev.rowid`,
  ).all().map((row) => ({ episodeId: row.episode_id, trigger: row.trigger, taskId: row.task_id, projectId: row.project_id }));
}

/** One notice row per destination, at most once per event; the event is marked expanded in the same transaction unless `complete` is false (a recipient lookup failed, so the next drain expands it again). */
export function expandEvent(db: Database, episodeId: number, trigger: string, destinations: readonly string[], complete = true): void {
  db.transaction(() => {
    const insert = db.prepare("INSERT OR IGNORE INTO plan_debt_notices (episode_id, trigger, destination, marker, state, updated_at) VALUES (?, ?, ?, ?, 'pending', ?)");
    for (const destination of destinations) insert.run(episodeId, trigger, destination, `<!-- work-board-plan-debt:${randomUUID()} -->`, new Date().toISOString());
    if (complete) db.prepare("UPDATE plan_debt_events SET expanded = 1 WHERE episode_id = ? AND trigger = ?").run(episodeId, trigger);
  })();
}

type RawNotice = { episode_id: number; trigger: string; destination: string; marker: string; state: NoticeState; attempts: number; last_error: string | null; cursor: string | null; updated_at: string; task_id: string; project_id: string; event_at: string };
const fromRaw = (row: RawNotice): NoticeRow => ({ episodeId: row.episode_id, trigger: row.trigger, destination: row.destination, marker: row.marker, state: row.state, attempts: row.attempts, lastError: row.last_error, cursor: row.cursor, updatedAt: row.updated_at, taskId: row.task_id, projectId: row.project_id, eventAt: row.event_at });
const NOTICE = `SELECT n.*, e.task_id, t.project_id, ev.created_at AS event_at FROM plan_debt_notices n
  JOIN plan_debt_episodes e ON e.id = n.episode_id JOIN tasks t ON t.id = e.task_id
  JOIN plan_debt_events ev ON ev.episode_id = n.episode_id AND ev.trigger = n.trigger
  WHERE n.state <> 'sent' AND e.ended_at IS NULL`;

/** Notices still owed on open episodes; the rest stop with their episode. */
export const unsentNotices = (db: Database): NoticeRow[] => db.prepare<[], RawNotice>(`${NOTICE} ORDER BY ev.created_at, n.rowid`).all().map(fromRaw);
export const unsentNoticesOf = (db: Database, taskId: string): NoticeRow[] => db.prepare<[string], RawNotice>(`${NOTICE} AND e.task_id = ? ORDER BY ev.created_at, n.rowid`).all(taskId).map(fromRaw);

export const setNoticeCursor = (db: Database, row: Pick<NoticeRow, "episodeId" | "trigger" | "destination">, cursor: string): void => {
  db.prepare("UPDATE plan_debt_notices SET cursor = ? WHERE episode_id = ? AND trigger = ? AND destination = ?").run(cursor, row.episodeId, row.trigger, row.destination);
};

export function setNotice(db: Database, row: Pick<NoticeRow, "episodeId" | "trigger" | "destination">, state: NoticeState, options: { error?: string | null; attempt?: boolean } = {}): void {
  db.prepare("UPDATE plan_debt_notices SET state = ?, attempts = attempts + ?, last_error = ?, updated_at = ? WHERE episode_id = ? AND trigger = ? AND destination = ?")
    .run(state, options.attempt ? 1 : 0, options.error ?? null, new Date().toISOString(), row.episodeId, row.trigger, row.destination);
}
