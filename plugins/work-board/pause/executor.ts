import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;
export function treatment(db: Database, projectId: string, taskId: string): boolean {
  const mode = db.prepare<[string], { mode: string }>("SELECT mode FROM pause_modes WHERE project_id=?").get(projectId)?.mode ?? "off";
  const live = db.prepare<[string], { effective_mode: string; requested_mode: string | null }>("SELECT effective_mode,requested_mode FROM attention_modes WHERE tracker_id=? AND kind='stale-status'").get(projectId);
  return live?.effective_mode === "live" && live.requested_mode === null && (mode === "on" || (mode === "ab" && createHash("sha256").update(taskId).digest()[0]! % 2 === 1));
}
/** Reconcile unclaimed open occurrences inside the transaction that changes a mode. */
export function transitionExecutors(db: Database, projectId: string): void {
  const at = new Date().toISOString();
  const grace = new Date(Date.now() + 600_000).toISOString();
  const rows = db.prepare<[string], { id: string; task_id: string; executor_state: string | null }>(`SELECT o.id,o.task_id,o.executor_state FROM manager_attention o WHERE o.tracker_id=? AND o.cleared_at IS NULL AND o.kind='stale-status' AND o.signal<>'no_merge_or_outcome' AND NOT EXISTS (SELECT 1 FROM attention_attempt_items i JOIN attention_attempts a ON a.attempt_id=i.attempt_id WHERE i.occurrence_id=o.id AND a.outcome IN ('claimed','sending','appended','queued','inline','unknown'))`).all(projectId);
  for (const row of rows) {
    if (treatment(db, projectId, row.task_id)) {
      if (row.executor_state === null) db.prepare<[string]>("UPDATE manager_attention SET executor_state='pending' WHERE id=? AND executor_state IS NULL").run(row.id);
    } else if (row.executor_state === "pending") {
      db.prepare<[string]>("UPDATE manager_attention SET executor_state=NULL WHERE id=? AND executor_state='pending'").run(row.id);
    } else if (row.executor_state === "sending") {
      db.prepare<[string, string, string]>("UPDATE manager_attention SET executor_state='unknown',executor_at=?,eligible_at=MAX(eligible_at,?) WHERE id=? AND executor_state='sending'").run(at, grace, row.id);
    }
  }
}
