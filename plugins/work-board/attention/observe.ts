import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { UNANSWERED_QUESTION } from "../db/waiting-on-owner";
import { getWorkflowPolicy, isClosedStatus, startsFromStatus, type WorkflowPolicy } from "../shared/workflow-policy";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

export const ATTENTION_KIND = "stale-status";
/** Statuses the pilot covers (the pilot scope); a custom workflow's other statuses stay out of scope. */
export const PILOT_STATUSES: readonly string[] = ["in_progress", "in_review", "in_testing", "bugfix"];
export const PILOT_SIGNALS = ["no_active_thread", "no_open_pr", "pr_state_unavailable", "closed_unmerged_pr"] as const;
export const ATTENTION_SIGNALS = [...PILOT_SIGNALS, "no_merge_or_outcome"] as const;
export type AttentionSignal = (typeof ATTENTION_SIGNALS)[number];
export type SignalValidity = "valid" | "unknown";

export interface StaleRow {
  id: string;
  project_id: string;
  key: string;
  status: string;
  type: string;
  archived: number;
  ongoing: number;
  active: number;
  held: number;
  /** An open owner question: the card waits for the owner, so it is not abandoned. */
  waiting_owner: number;
  paused: number;
  project_uses_prs: number;
  merged_pr: number;
  merge_evidence: number;
  outcome: number;
  unknown_pr: number;
  legacy_outcome: number;
  /** Open/closed as of a refresh that succeeded; a failed refresh keeps the old payload, which is no longer a known answer. The flags and the ledger both use these. */
  open_known: number;
  closed_known: number;
  /** The place in an executor's work queue (1 is current), or null when the card is not queued. */
  queue_position: number | null;
  /** JSON array of the `mergedAt` values of the card's merged, non-excluded PRs, as the snapshots hold them (unvalidated). */
  merged_at: string;
}

/** A card in the review status whose PR merged this recently is still collecting post-merge evidence, not stale. */
export const POST_MERGE_REVIEW_GRACE_MS = 2 * 60 * 60 * 1000;

/**
 * Whether the card's PR question is settled, the one predicate the flags and the attention ledger share: an open PR
 * settles it; in testing a merged PR does too; in review only a merge inside the grace, using the latest merge instant
 * that parses and is not in the future, so a malformed or future value neither masks a valid merge nor extends the grace.
 */
export function prSettled(row: StaleRow, policy: WorkflowPolicy, nowMs: number): boolean {
  if (row.open_known) return true;
  if (row.status === policy.testingStatus) return Boolean(row.merged_pr);
  if (row.status !== policy.reviewStatus) return false;
  const merges = (JSON.parse(row.merged_at ?? "[]") as unknown[])
    .map((value) => (typeof value === "string" ? Date.parse(value) : Number.NaN))
    .filter((at) => Number.isFinite(at) && at <= nowMs);
  return merges.length > 0 && nowMs - Math.max(...merges) < POST_MERGE_REVIEW_GRACE_MS;
}

/** The raw per-card facts behind the stale-status flags; one query for a task list or a whole project. */
export function staleRows(db: Database, taskIds?: readonly string[], projectId?: string, nowMs = Date.now()): StaleRow[] {
  const ids = taskIds ? JSON.stringify(taskIds) : null;
  return db.prepare<(string | null)[], StaleRow>(`
      SELECT t.id, t.project_id, p.prefix || '-' || t.number AS key, t.status, t.type,
        CASE WHEN t.archived_at IS NULL THEN 0 ELSE 1 END AS archived,
        CASE WHEN t.type='epic' AND EXISTS(SELECT 1 FROM task_labels tl JOIN labels l ON l.id=tl.label_id WHERE tl.task_id=t.id AND l.name='ongoing') THEN 1 ELSE 0 END AS ongoing,
        EXISTS(SELECT 1 FROM task_threads x WHERE x.task_id=t.id AND x.live_status IN ('starting','working')) AS active,
        EXISTS(SELECT 1 FROM task_dependencies d JOIN tasks b ON b.id=d.blocking_task_id WHERE d.task_id=t.id AND b.status <> 'done') AS held,
        EXISTS(SELECT 1 FROM task_questions q WHERE q.task_id=t.id AND ${UNANSWERED_QUESTION}) AS waiting_owner,
        EXISTS(SELECT 1 FROM task_pauses x WHERE x.task_id=t.id AND x.applied=1 AND x.signal IN ('manual','background') AND x.until > ?) AS paused,
        EXISTS(SELECT 1 FROM project_pr_history h WHERE h.project_id=t.project_id) AS project_uses_prs,
        EXISTS(SELECT 1 FROM task_pr_links l JOIN git_pr_snapshots s ON s.project_id=t.project_id AND s.identity=l.identity
          WHERE l.task_id=t.id AND COALESCE(json_extract(l.payload,'$.excluded'),0)=0 AND json_extract(s.payload,'$.state')='merged') AS merged_pr,
        EXISTS(SELECT 1 FROM comments c WHERE c.task_id=t.id AND json_extract(c.evidence,'$.kind')='merge') AS merge_evidence,
        EXISTS(SELECT 1 FROM comments c WHERE c.task_id=t.id AND json_extract(c.evidence,'$.kind')='outcome') AS outcome,
        EXISTS(SELECT 1 FROM legacy_done_tasks d JOIN comments c ON c.task_id=d.task_id WHERE d.task_id=t.id AND c.kind != 'system') AS legacy_outcome,
        -- Merged is final, so a failed refresh of a merged PR leaves its state known.
        EXISTS(SELECT 1 FROM task_pr_links l LEFT JOIN git_pr_snapshots s ON s.project_id=t.project_id AND s.identity=l.identity WHERE l.task_id=t.id AND COALESCE(json_extract(l.payload,'$.excluded'),0)=0 AND (s.payload IS NULL OR (s.error IS NOT NULL AND COALESCE(json_extract(s.payload,'$.state'),'') <> 'merged'))) AS unknown_pr
        , EXISTS(SELECT 1 FROM task_pr_links l JOIN git_pr_snapshots s ON s.project_id=t.project_id AND s.identity=l.identity
          WHERE l.task_id=t.id AND COALESCE(json_extract(l.payload,'$.excluded'),0)=0 AND s.error IS NULL AND json_extract(s.payload,'$.state') IN ('open','draft')) AS open_known
        , EXISTS(SELECT 1 FROM task_pr_links l JOIN git_pr_snapshots s ON s.project_id=t.project_id AND s.identity=l.identity
          WHERE l.task_id=t.id AND COALESCE(json_extract(l.payload,'$.excluded'),0)=0 AND s.error IS NULL AND json_extract(s.payload,'$.state')='closed') AS closed_known
        , (SELECT q.position FROM task_queue q WHERE q.task_id=t.id) AS queue_position
        , (SELECT json_group_array(json_extract(s.payload,'$.mergedAt')) FROM task_pr_links l JOIN git_pr_snapshots s ON s.project_id=t.project_id AND s.identity=l.identity
          WHERE l.task_id=t.id AND COALESCE(json_extract(l.payload,'$.excluded'),0)=0 AND json_extract(s.payload,'$.state')='merged') AS merged_at
      FROM tasks t JOIN projects p ON p.id=t.project_id
      ${ids === null ? "WHERE (? IS NULL OR t.project_id=?)" : "WHERE t.id IN (SELECT value FROM json_each(?)) AND (? IS NULL OR t.project_id=?)"} ORDER BY t.id`)
    // An ID-scoped read must seek by key: an `? IS NULL OR` arm on the ID predicate forces a scan of every task.
    .all(new Date(nowMs).toISOString(), ...(ids === null ? [projectId ?? null, projectId ?? null] : [ids, projectId ?? null, projectId ?? null]));
}

/**
 * The tasks in work of each epic, as card keys: unarchived, neither Backlog, Todo nor closed. A sub-task belongs to the epic
 * of its parent (the effective epic), so it counts even when the parent itself is not started. Epics with none are absent.
 */
export function epicTasksInWork(db: Database, epicIds?: readonly string[], projectId?: string): Map<string, string[]> {
  const ids = epicIds ? JSON.stringify(epicIds) : null;
  const columns = "p.prefix || '-' || c.number AS key, c.number, c.status, c.project_id";
  const open = "c.archived_at IS NULL AND c.status NOT IN ('backlog','todo')";
  const rows = db.prepare<(string | null)[], { epic_id: string; key: string; status: string; project_id: string }>(`
      WITH e(id) AS (SELECT t.id FROM tasks t WHERE t.type='epic' AND ${ids === null ? "(? IS NULL OR t.project_id=?)" : "t.id IN (SELECT value FROM json_each(?)) AND (? IS NULL OR t.project_id=?)"})
      SELECT c.epic_id AS epic_id, ${columns} FROM tasks c JOIN e ON e.id=c.epic_id JOIN projects p ON p.id=c.project_id WHERE ${open}
      UNION ALL
      SELECT par.epic_id AS epic_id, ${columns} FROM tasks c JOIN tasks par ON par.id=c.parent_task_id JOIN e ON e.id=par.epic_id JOIN projects p ON p.id=c.project_id
      WHERE c.epic_id IS NULL AND ${open}
      ORDER BY 3`)
    .all(...(ids === null ? [projectId ?? null, projectId ?? null] : [ids, projectId ?? null, projectId ?? null]));
  const policies = projectPolicies(db);
  const result = new Map<string, string[]>();
  for (const row of rows) {
    const policy = policies.get(row.project_id);
    if (!policy || isClosedStatus({ workflowPolicy: policy }, row.status)) continue;
    result.set(row.epic_id, [...(result.get(row.epic_id) ?? []), row.key]);
  }
  return result;
}

export function projectPolicies(db: Database): Map<string, WorkflowPolicy> {
  const rows = db.prepare<[], { id: string; workflow_policy: string | null }>("SELECT id, workflow_policy FROM projects").all();
  return new Map(rows.map((row) => [row.id, getWorkflowPolicy({ workflowPolicy: row.workflow_policy == null ? null : JSON.parse(row.workflow_policy) })]));
}

/**
 * The cards waiting their turn in an executor's work queue: position 2 or later and still in a pre-work status, so the
 * stale flags leave them out. A waiting card already in work (data that breaks the queue's rule) is flagged as usual.
 */
export function queuedWaiting(db: Database, rows: readonly StaleRow[]): Set<string> {
  const waiting = rows.filter((row) => (row.queue_position ?? 0) >= 2);
  if (!waiting.length) return new Set();
  const zones = new Map(db.prepare<[], { id: string; statuses: string | null; workflow_policy: string | null }>("SELECT id, statuses, workflow_policy FROM projects").all()
    .map((row) => [row.id, { statuses: row.statuses ? JSON.parse(row.statuses) : null, workflowPolicy: row.workflow_policy ? JSON.parse(row.workflow_policy) : null }] as const));
  return new Set(waiting.filter((row) => zones.has(row.project_id) && startsFromStatus(zones.get(row.project_id)!, row.status)).map((row) => row.id));
}

export interface CardObservation {
  taskId: string;
  trackerId: string;
  key: string;
  /** Pilot scope: ordinary, unarchived, an active pilot status, not held by a blocker, not an ongoing epic. */
  inScope: boolean;
  /** Scope of the Done-only `no_merge_or_outcome` journal. */
  doneScope: boolean;
  /** Why the pilot scope does not hold, recorded as the retired reason of an occurrence that leaves it. */
  scopeReason: string;
  signals: Record<AttentionSignal, { present: boolean; validity: SignalValidity }>;
}

/**
 * Stale-status observations with a validity per signal. A signal is `unknown` only when a PR snapshot is missing or failed
 * and no definite answer exists; `prSettled` is the same predicate the flags use.
 */
export function staleStatusObservations(db: Database, taskIds?: readonly string[], projectId?: string, nowMs = Date.now()): CardObservation[] {
  const policies = projectPolicies(db);
  const result: CardObservation[] = [];
  const rows = staleRows(db, taskIds, projectId, nowMs);
  const waiting = queuedWaiting(db, rows);
  const inWork = epicTasksInWork(db, rows.filter((row) => row.type === "epic").map((row) => row.id));
  for (const row of rows) {
    const policy = policies.get(row.project_id);
    if (!policy) continue;
    const queuedWaiting = waiting.has(row.id);
    const valid = (present: boolean) => ({ present, validity: "valid" as const });
    const reviewOrTesting = row.status === policy.reviewStatus || row.status === policy.testingStatus;
    const prUnresolved = reviewOrTesting && !prSettled(row, policy, nowMs);
    const unknownPr = Boolean(row.unknown_pr);
    result.push({
      taskId: row.id,
      trackerId: row.project_id,
      key: row.key,
      inScope: !row.archived && PILOT_STATUSES.includes(row.status) && !row.held && !row.ongoing && !queuedWaiting,
      scopeReason: row.archived ? "archived" : row.ongoing ? "ongoing" : row.held ? "blocked" : queuedWaiting ? "queued" : "status_changed",
      doneScope: !row.archived && row.status === policy.doneStatus && !row.ongoing,
      signals: {
        no_active_thread: valid(!row.paused && row.status === policy.inProgressStatus && !row.active && !row.held && !row.waiting_owner && !inWork.has(row.id)),
        no_open_pr: !row.paused && prUnresolved && unknownPr ? { present: false, validity: "unknown" } : valid(!row.paused && Boolean(row.project_uses_prs) && prUnresolved),
        pr_state_unavailable: valid(!row.paused && prUnresolved && unknownPr),
        closed_unmerged_pr: row.paused ? valid(false) : Boolean(row.closed_known) ? valid(true) : unknownPr ? { present: false, validity: "unknown" } : valid(false),
        no_merge_or_outcome: valid(row.status === policy.doneStatus && !row.merge_evidence && !row.outcome && !row.legacy_outcome),
      },
    });
  }
  return result;
}
