import { UNANSWERED_QUESTION, WAITING_ON_OWNER } from "../db/waiting-on-owner";
import { ordinaryTaskVisibilitySql } from "../scheduled/visibility";
import { idleThreshold } from "../shared/project-settings";
import { getWorkflowPolicy } from "../shared/workflow-policy";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { BadgeCriterion } from "../shared/badge";
import { evaluateThreadHealth, staleIdleMinutes } from "../shared/thread-health";
import type { TasksApiStore } from ".";

const LIVE = `t.archived_at IS NULL AND ${ordinaryTaskVisibilitySql()}`;
const ACTIVE = `${LIVE} AND t.status NOT IN ('done', 'canceled')`;
const UNANSWERED = `EXISTS (SELECT 1 FROM task_questions q WHERE q.task_id = t.id AND ${UNANSWERED_QUESTION})`;

const QUERIES: Record<Exclude<BadgeCriterion, "stale_idle">, string> = {
  open: ACTIVE,
  waiting_on_owner: WAITING_ON_OWNER,
  // The project's review status; an explicit null policy value counts nothing.
  in_review: `${LIVE} AND t.status = (SELECT CASE WHEN json_type(p.workflow_policy, '$.reviewStatus') IS NULL THEN 'in_review' ELSE json_extract(p.workflow_policy, '$.reviewStatus') END FROM projects p WHERE p.id = t.project_id)`,
  needs_answer: `${ACTIVE} AND ${UNANSWERED}`,
  failed_thread: `${ACTIVE} AND EXISTS (SELECT 1 FROM task_threads l WHERE l.task_id = t.id AND l.live_status = 'failed')`,
};

/** Distinct task ids per selected criterion, plus their union size. */
export function navigationBadgeCounts(
  bb: BbPluginApi,
  store: TasksApiStore,
  criteria: readonly BadgeCriterion[],
  now: number,
): { count: number; counts: Partial<Record<BadgeCriterion, number>> } {
  const db = bb.storage.database();
  const projects = store.tasks.listProjects();
  const thresholds = new Map(projects.map((project) => [project.id, idleThreshold(project)]));
  const waitingStatuses = new Map(projects.map((project) => [project.id, [getWorkflowPolicy(project).reviewStatus]]));
  const ids = (where: string) =>
    db.prepare<[], { id: string }>(`SELECT t.id FROM tasks t WHERE ${where}`).all().map((row) => row.id);
  const union = new Set<string>();
  const counts: Partial<Record<BadgeCriterion, number>> = {};
  for (const criterion of criteria) {
    let matched: string[];
    if (criterion === "stale_idle") {
      // Only tasks with an idle thread can be stale, so the rule runs on a small candidate set.
      // An open owner question means the agent waits for the owner, so it is not stale.
      const candidates = ids(`${ACTIVE} AND NOT ${UNANSWERED}
        AND EXISTS (SELECT 1 FROM task_threads l WHERE l.task_id = t.id AND l.live_status = 'idle')`);
      const links = new Map<string, ReturnType<TasksApiStore["tasks"]["listTaskThreadsForTasks"]>>();
      for (const link of store.tasks.listTaskThreadsForTasks(candidates))
        links.set(link.taskId, [...(links.get(link.taskId) ?? []), link]);
      const activity = store.tasks.listTaskActivity(candidates);
      matched = candidates.filter((taskId) => {
        const task = activity.get(taskId);
        const health = evaluateThreadHealth(task?.status ?? "", links.get(taskId) ?? [], task?.lastActivityAt ?? "", task ? thresholds.get(task.projectId) ?? null : null, task ? waitingStatuses.get(task.projectId) : undefined);
        return staleIdleMinutes(health.idle, now) !== null;
      });
    } else {
      matched = ids(QUERIES[criterion]);
    }
    counts[criterion] = matched.length;
    for (const id of matched) union.add(id);
  }
  return { count: union.size, counts };
}
