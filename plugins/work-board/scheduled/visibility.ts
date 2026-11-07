/** History expiry must never change ordinary visibility or lose result provenance. */
export function ordinaryTaskVisibilitySql(alias = "t"): string {
  return `NOT EXISTS (SELECT 1 FROM task_scheduled_sources ss WHERE ss.task_id=${alias}.id AND (ss.role='template' OR ss.started_at IS NULL OR (ss.role='recurring_run' AND ${alias}.status='done')))`;
}
