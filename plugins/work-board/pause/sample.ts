import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { PILOT_STATUSES, staleRows } from "../attention/observe";
import { pauseArm } from "./store";
import { planningStatusOf } from "../shared/workflow-policy";

/** A run marker records even a project with no cards, so the report can measure outages. */
export function samplePauses(bb: BbPluginApi, nowMs = Date.now()): void {
  const db = bb.storage.database();
  const now = new Date(nowMs).toISOString();
  const projects = db.prepare<[], { project_id: string; mode: string }>("SELECT project_id,mode FROM pause_modes WHERE mode IN ('ab','on')").all();
  db.transaction(() => {
    for (const project of projects) {
      const previous = db.prepare<[string], { at: string }>("SELECT at FROM pause_sample_runs WHERE project_id=? ORDER BY at DESC LIMIT 1").get(project.project_id)?.at;
      db.prepare<[string, string]>("INSERT OR IGNORE INTO pause_sample_runs(project_id,at) VALUES (?,?)").run(project.project_id, now);
      const projectRow = db.prepare<[string], { statuses: string | null; workflow_policy: string | null }>("SELECT statuses,workflow_policy FROM projects WHERE id=?").get(project.project_id)!;
      const planning = planningStatusOf({ statuses: projectRow.statuses ? JSON.parse(projectRow.statuses) : null, workflowPolicy: projectRow.workflow_policy ? JSON.parse(projectRow.workflow_policy) : null });
      for (const card of staleRows(db, undefined, project.project_id, nowMs)) {
        if (card.archived || (!PILOT_STATUSES.includes(card.status) && card.status !== planning)) continue;
        const prior = db.prepare<[string], { status: string }>("SELECT status FROM pause_samples WHERE task_id=? ORDER BY at DESC LIMIT 1").get(card.id);
        const cutoff = previous ?? now;
        const working = db.prepare<[string, string], { found: number }>("SELECT 1 AS found FROM task_threads WHERE task_id=? AND (live_status IN ('starting','working') OR last_working_at>?) LIMIT 1").get(card.id, cutoff);
        const comment = db.prepare<[string, string], { found: number }>("SELECT 1 AS found FROM comments WHERE task_id=? AND kind IN ('agent','user') AND created_at>? LIMIT 1").get(card.id, cutoff);
        const worked = Boolean(working || comment || (prior && prior.status !== card.status));
        db.prepare<(string | number)[]>("INSERT OR IGNORE INTO pause_samples(at,project_id,task_id,arm,status,in_scope,held,waiting_owner,paused,worked) VALUES (?,?,?,?,?,?,?,?,?,?)")
          .run(now, project.project_id, card.id, project.mode === 'on' ? 'auto' : pauseArm(card.id), card.status, PILOT_STATUSES.includes(card.status) && !card.held && !card.ongoing ? 1 : 0, card.held, card.waiting_owner, card.paused, worked ? 1 : 0);
      }
    }
    const cutoff = new Date(nowMs - 30 * 86400_000).toISOString();
    db.prepare<[string]>("DELETE FROM pause_samples WHERE at<?").run(cutoff);
    db.prepare<[string]>("DELETE FROM pause_sample_runs WHERE at<?").run(cutoff);
    db.prepare<[string]>("DELETE FROM pause_log WHERE at<?").run(new Date(nowMs - 90 * 86400_000).toISOString());
  })();
}
