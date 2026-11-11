import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TasksStore } from "../db";
import type { DependencyTask } from "../shared/contract";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;
export type DependencyEdge = { taskId: string; blockingTaskId: string };

export function createDependencyStore(db: Database, tasks: TasksStore) {
  function requireTask(id: string) {
    const task = tasks.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    return task;
  }
  /** Every task linked to taskId in either direction, as blocker, dependent or related task. */
  function related(taskId: string) {
    return db.prepare<[string, string, string, string, string, string], { id: string; projectId: string }>(`
      SELECT t.id, t.project_id AS projectId FROM task_dependencies d
      JOIN tasks t ON t.id = CASE WHEN d.task_id = ? THEN d.blocking_task_id ELSE d.task_id END
      WHERE d.task_id = ? OR d.blocking_task_id = ?
      UNION
      SELECT t.id, t.project_id FROM task_relations r
      JOIN tasks t ON t.id = CASE WHEN r.task_id = ? THEN r.related_task_id ELSE r.task_id END
      WHERE r.task_id = ? OR r.related_task_id = ?
    `).all(taskId, taskId, taskId, taskId, taskId, taskId);
  }
  // Relations are symmetric; each pair is stored once with the smaller ID first.
  const pair = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);
  function list(taskId: string) {
    requireTask(taskId);
    const rows = db.prepare<[string, string, string, string], DependencyTask & { direction: string }>(`
      SELECT t.id, t.project_id AS projectId, p.prefix || '-' || t.number AS key, t.title, t.status,
        CASE WHEN d.task_id = ? THEN 'blockedBy' ELSE 'blocks' END AS direction
      FROM task_dependencies d JOIN tasks t
        ON t.id = CASE WHEN d.task_id = ? THEN d.blocking_task_id ELSE d.task_id END
      JOIN projects p ON p.id=t.project_id
      WHERE d.task_id = ? OR d.blocking_task_id = ? ORDER BY p.prefix, t.number
    `).all(taskId, taskId, taskId, taskId);
    const result: { blockedBy: DependencyTask[]; blocks: DependencyTask[]; related: DependencyTask[] } = { blockedBy: [], blocks: [], related: [] };
    for (const { direction, ...task } of rows) result[direction as "blockedBy" | "blocks"].push(task);
    result.related = db.prepare<[string, string, string], DependencyTask>(`
      SELECT t.id, t.project_id AS projectId, p.prefix || '-' || t.number AS key, t.title, t.status
      FROM task_relations r JOIN tasks t ON t.id = CASE WHEN r.task_id = ? THEN r.related_task_id ELSE r.task_id END
      JOIN projects p ON p.id=t.project_id
      WHERE r.task_id = ? OR r.related_task_id = ? ORDER BY p.prefix, t.number
    `).all(taskId, taskId, taskId);
    return result;
  }
  function blockers(taskIds: readonly string[]) {
    const result = new Map<string, DependencyTask[]>();
    // One indexed batch read avoids a dependency query per visible card.
    for (let offset = 0; offset < taskIds.length; offset += 500) {
      const ids = taskIds.slice(offset, offset + 500);
      if (!ids.length) continue;
      const rows = db.prepare<string[], DependencyTask & { taskId: string }>(`
        SELECT d.task_id AS taskId, t.id, t.project_id AS projectId,
          p.prefix || '-' || t.number AS key, t.title, t.status
        FROM task_dependencies d JOIN tasks t ON t.id=d.blocking_task_id
        JOIN projects p ON p.id=t.project_id
        WHERE d.task_id IN (${ids.map(() => "?").join(",")}) AND t.status <> 'done'
        ORDER BY p.prefix, t.number
      `).all(...ids);
      for (const { taskId, ...task } of rows) {
        const group = result.get(taskId) ?? [];
        group.push(task);
        result.set(taskId, group);
      }
    }
    return result;
  }
  function add(taskId: string, blockingTaskId: string) {
    const task = requireTask(taskId), blocker = requireTask(blockingTaskId);
    if (taskId === blockingTaskId) throw new Error("A task cannot depend on itself");
    if (task.projectId !== blocker.projectId) throw new Error("Dependencies must belong to the same project");
    // Walk predecessor edges once; UNION also terminates on malformed imported graphs.
    const cycle = db.prepare<[string, string], { id: string }>(`
      WITH RECURSIVE predecessors(id) AS (
        SELECT ? UNION SELECT d.blocking_task_id FROM task_dependencies d JOIN predecessors p ON d.task_id=p.id
      ) SELECT id FROM predecessors WHERE id=? LIMIT 1
    `).get(blockingTaskId, taskId);
    if (cycle) throw new Error("Dependency would create a cycle");
    return db.prepare<[string, string]>("INSERT OR IGNORE INTO task_dependencies(task_id, blocking_task_id) VALUES (?, ?)")
      .run(taskId, blockingTaskId).changes > 0;
  }
  function remove(taskId: string, blockingTaskId: string) {
    requireTask(taskId);
    requireTask(blockingTaskId);
    return db.prepare<[string, string]>("DELETE FROM task_dependencies WHERE task_id=? AND blocking_task_id=?")
      .run(taskId, blockingTaskId).changes > 0;
  }
  function relate(taskId: string, relatedTaskId: string) {
    const task = requireTask(taskId), other = requireTask(relatedTaskId);
    if (taskId === relatedTaskId) throw new Error("A task cannot relate to itself");
    if (task.projectId !== other.projectId) throw new Error("Related tasks must belong to the same project");
    return db.prepare<[string, string]>("INSERT OR IGNORE INTO task_relations(task_id, related_task_id) VALUES (?, ?)")
      .run(...pair(taskId, relatedTaskId)).changes > 0;
  }
  function unrelate(taskId: string, relatedTaskId: string) {
    requireTask(taskId);
    requireTask(relatedTaskId);
    return db.prepare<[string, string]>("DELETE FROM task_relations WHERE task_id=? AND related_task_id=?")
      .run(...pair(taskId, relatedTaskId)).changes > 0;
  }
  return { list, blockers, add, remove, related, relate, unrelate };
}
