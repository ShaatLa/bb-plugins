import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { ordinaryTaskVisibilitySql } from "../scheduled/visibility";
import { getWorkflowPolicy, type WorkflowPolicy } from "../shared/workflow-policy";

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
  visible: number;
  ongoing: number;
  active: number;
  held: number;
  merged_pr: number;
  merge_evidence: number;
  outcome: number;
  unknown_pr: number;
  legacy_outcome: number;
  /** Open/closed as of a refresh that succeeded; a failed refresh keeps the old payload, which is no longer a known answer. The flags and the ledger both use these. */
  open_known: number;
  closed_known: number;
}

/** The raw per-card facts behind the stale-status flags; one query for a task list or a whole project. */
export function staleRows(db: Database, taskIds?: readonly string[], projectId?: string): StaleRow[] {
  const ids = taskIds ? JSON.stringify(taskIds) : null;
  return db.prepare<[string | null, string | null, string | null, string | null], StaleRow>(`
      SELECT t.id, t.project_id, p.prefix || '-' || t.number AS key, t.status, t.type,
        CASE WHEN t.archived_at IS NULL THEN 0 ELSE 1 END AS archived,
        CASE WHEN ${ordinaryTaskVisibilitySql("t")} THEN 1 ELSE 0 END AS visible,
        CASE WHEN t.type='epic' AND EXISTS(SELECT 1 FROM task_labels tl JOIN labels l ON l.id=tl.label_id WHERE tl.task_id=t.id AND l.name='ongoing') THEN 1 ELSE 0 END AS ongoing,
        EXISTS(SELECT 1 FROM task_threads x WHERE x.task_id=t.id AND x.live_status IN ('starting','working')) AS active,
        EXISTS(SELECT 1 FROM task_dependencies d JOIN tasks b ON b.id=d.blocking_task_id WHERE d.task_id=t.id AND b.status <> 'done') AS held,
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
      FROM tasks t JOIN projects p ON p.id=t.project_id
      WHERE (? IS NULL OR t.project_id=?) AND (? IS NULL OR t.id IN (SELECT value FROM json_each(?))) ORDER BY t.id`)
    .all(projectId ?? null, projectId ?? null, ids, ids);
}

export function projectPolicies(db: Database): Map<string, WorkflowPolicy> {
  const rows = db.prepare<[], { id: string; workflow_policy: string | null }>("SELECT id, workflow_policy FROM projects").all();
  return new Map(rows.map((row) => [row.id, getWorkflowPolicy({ workflowPolicy: row.workflow_policy == null ? null : JSON.parse(row.workflow_policy) })]));
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
export function staleStatusObservations(db: Database, taskIds?: readonly string[], projectId?: string): CardObservation[] {
  const policies = projectPolicies(db);
  const result: CardObservation[] = [];
  for (const row of staleRows(db, taskIds, projectId)) {
    const policy = policies.get(row.project_id);
    if (!policy) continue;
    const valid = (present: boolean) => ({ present, validity: "valid" as const });
    const reviewOrTesting = row.status === policy.reviewStatus || row.status === policy.testingStatus;
    const prSettled = Boolean(row.open_known) || (row.status === policy.testingStatus && Boolean(row.merged_pr));
    const prUnresolved = reviewOrTesting && !prSettled;
    const unknownPr = Boolean(row.unknown_pr);
    result.push({
      taskId: row.id,
      trackerId: row.project_id,
      key: row.key,
      inScope: Boolean(row.visible) && !row.archived && PILOT_STATUSES.includes(row.status) && !row.held && !row.ongoing,
      scopeReason: !row.visible ? "not_ordinary" : row.archived ? "archived" : row.ongoing ? "ongoing" : row.held ? "blocked" : "status_changed",
      doneScope: Boolean(row.visible) && !row.archived && row.status === policy.doneStatus && !row.ongoing,
      signals: {
        no_active_thread: valid(row.status === policy.inProgressStatus && !row.active && !row.held),
        no_open_pr: prUnresolved && unknownPr ? { present: false, validity: "unknown" } : valid(prUnresolved),
        pr_state_unavailable: valid(prUnresolved && unknownPr),
        closed_unmerged_pr: Boolean(row.closed_known) ? valid(true) : unknownPr ? { present: false, validity: "unknown" } : valid(false),
        no_merge_or_outcome: valid(row.status === policy.doneStatus && !row.merge_evidence && !row.outcome && !row.legacy_outcome),
      },
    });
  }
  return result;
}
