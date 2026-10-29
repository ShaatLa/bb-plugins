import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { BadgeCriterion } from "../shared/badge";
import { evaluateThreadHealth, staleIdleMinutes } from "../shared/thread-health";
import type { TasksApiStore } from ".";

const LIVE = "t.archived_at IS NULL";
const ACTIVE = `${LIVE} AND t.status NOT IN ('done', 'canceled')`;
const UNANSWERED = `EXISTS (SELECT 1 FROM task_questions q WHERE q.task_id = t.id
  AND json_array_length(q.payload, '$.selectedOptionIds') = 0
  AND COALESCE(json_extract(q.payload, '$.answerText'), '') = '')`;

const QUERIES: Record<Exclude<BadgeCriterion, "stale_idle">, string> = {
  open: ACTIVE,
  in_review: `${LIVE} AND t.status = 'in_review'`,
  needs_answer: `${ACTIVE} AND ${UNANSWERED}`,
  owner: `${ACTIVE} AND t.execution_target = 'owner'`,
  failed_thread: `${ACTIVE} AND EXISTS (SELECT 1 FROM task_threads l WHERE l.task_id = t.id AND l.live_status = 'failed')`,
};

/** Distinct task ids per selected criterion, plus their union size. */
export function navigationBadgeCounts(
  bb: BbPluginApi,
  store: TasksApiStore,
  criteria: readonly BadgeCriterion[],
  idleThresholdMinutes: number | null,
  now: number,
): { count: number; counts: Partial<Record<BadgeCriterion, number>> } {
  const db = bb.storage.database();
  const ids = (where: string) =>
    db.prepare<[], { id: string }>(`SELECT t.id FROM tasks t WHERE ${where}`).all().map((row) => row.id);
  const union = new Set<string>();
  const counts: Partial<Record<BadgeCriterion, number>> = {};
  for (const criterion of criteria) {
    let matched: string[];
    if (criterion === "stale_idle") {
      if (idleThresholdMinutes === null) continue;
      // Only tasks with an idle thread can be stale, so the rule runs on a small candidate set.
      const candidates = ids(`${ACTIVE} AND t.status <> 'in_review'
        AND EXISTS (SELECT 1 FROM task_threads l WHERE l.task_id = t.id AND l.live_status = 'idle')`);
      const links = new Map<string, ReturnType<TasksApiStore["tasks"]["listTaskThreadsForTasks"]>>();
      for (const link of store.tasks.listTaskThreadsForTasks(candidates))
        links.set(link.taskId, [...(links.get(link.taskId) ?? []), link]);
      const activity = store.tasks.listTaskActivity(candidates);
      matched = candidates.filter((taskId) => {
        const task = activity.get(taskId);
        const health = evaluateThreadHealth(task?.status ?? "", links.get(taskId) ?? [], task?.lastActivityAt ?? "", idleThresholdMinutes);
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
