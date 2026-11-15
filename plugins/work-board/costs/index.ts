import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { TaskCost } from "../shared/contract";

const MAX_THREADS = 200;
const TIMEOUT_MS = 3000;

const count = z.number();
// Local copy of Tokenomos' cost shape: Work Board must not import or require that plugin.
const tokenomosSum = z.object({
  cost: z.object({
    usd: z.number().nullable(),
    tokens: z.object({ freshIn: count, cacheRead: count, cacheWrite: count, output: count }),
    estimated: z.boolean(),
    partial: z.boolean(),
  }),
  threadCount: count,
});

type Db = ReturnType<BbPluginApi["storage"]["database"]>;

/**
 * Threads that worked on the task or anything inside it (epic members and subtasks,
 * recursively), newest first, plus how many of those tasks contributed. Per task:
 * current and past links. Commenters alone (a manager, a reviewer) do not count, nor
 * do parent-fallback links (an orchestrator stands in for a finished worker) or links
 * detached by hand.
 */
export function taskCostThreadIds(db: Db, taskId: string): { threadIds: string[]; taskCount: number } {
  const rows = db.prepare<[string], { task_id: string; thread_id: string }>(`
    WITH RECURSIVE tree(id) AS (
      SELECT ?
      UNION
      SELECT t.id FROM tasks t JOIN tree ON t.epic_id = tree.id OR t.parent_task_id = tree.id
    ),
    traces AS (
      SELECT c.task_id, c.thread_id, c.created_at AS at, c.body FROM comments c JOIN tree ON c.task_id = tree.id
      WHERE c.kind = 'system' AND c.thread_id LIKE 'thr_%'
        AND (c.body LIKE 'Thread attached%' OR c.body LIKE 'Thread detached%')
      UNION ALL
      SELECT l.task_id, l.thread_id, l.updated_at AS at, '#link' AS body FROM task_threads l JOIN tree ON l.task_id = tree.id
      WHERE l.preset_name != 'Parent thread'
    )
    SELECT task_id, thread_id FROM traces GROUP BY task_id, thread_id
    HAVING SUM(body = '#link') > 0
      OR SUM(body LIKE 'Thread attached (parent fallback):%' OR body LIKE 'Thread detached (manual):%') = 0
    ORDER BY MAX(at) DESC
  `).all(taskId);
  return {
    threadIds: [...new Set(rows.map((row) => row.thread_id))],
    taskCount: new Set(rows.map((row) => row.task_id)).size,
  };
}

export async function getTaskCost(bb: BbPluginApi, taskId: string): Promise<TaskCost | null> {
  const { threadIds: ids, taskCount } = taskCostThreadIds(bb.storage.database(), taskId);
  if (!ids.length) return null;
  try {
    const result = await bb.sdk.plugins.callRpc({
      pluginId: "tokenomos",
      method: "costs.sum",
      input: { threadIds: ids.slice(0, MAX_THREADS), includeDescendants: true },
      outputSchema: tokenomosSum,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // One call for the whole tree: Tokenomos dedupes shared threads and descendants within it.
    // Nothing counted yet (Tokenomos still importing history): "~$0.00" would mislead.
    if (result.threadCount === 0) return null;
    const { usd, tokens, estimated, partial } = result.cost;
    return { usd, tokens, estimated, partial: partial || ids.length > MAX_THREADS, threadCount: result.threadCount, taskCount };
  } catch {
    // Tokenomos is optional: missing, outdated or slow means no cost line.
    return null;
  }
}
