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
 * Threads that worked on the task, newest first: current and past links. Commenters
 * alone (a manager, a reviewer) do not count, nor do parent-fallback links (an
 * orchestrator stands in for a finished worker) or links detached by hand.
 */
export function taskCostThreadIds(db: Db, taskId: string): string[] {
  return db.prepare<[string, string], { thread_id: string }>(`
    WITH traces AS (
      SELECT thread_id, created_at AS at, body FROM comments
      WHERE task_id = ? AND kind = 'system' AND thread_id LIKE 'thr_%'
        AND (body LIKE 'Thread attached%' OR body LIKE 'Thread detached%')
      UNION ALL
      SELECT thread_id, updated_at AS at, '#link' AS body FROM task_threads
      WHERE task_id = ? AND preset_name != 'Parent thread'
    )
    SELECT thread_id FROM traces GROUP BY thread_id
    HAVING SUM(body = '#link') > 0
      OR SUM(body LIKE 'Thread attached (parent fallback):%' OR body LIKE 'Thread detached (manual):%') = 0
    ORDER BY MAX(at) DESC
  `).all(taskId, taskId).map((row) => row.thread_id);
}

export async function getTaskCost(bb: BbPluginApi, taskId: string): Promise<TaskCost | null> {
  const ids = taskCostThreadIds(bb.storage.database(), taskId);
  if (!ids.length) return null;
  try {
    const result = await bb.sdk.plugins.callRpc({
      pluginId: "tokenomos",
      method: "costs.sum",
      input: { threadIds: ids.slice(0, MAX_THREADS), includeDescendants: true },
      outputSchema: tokenomosSum,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // Nothing counted yet (Tokenomos still importing history): "~$0.00" would mislead.
    if (result.threadCount === 0) return null;
    const { usd, tokens, estimated, partial } = result.cost;
    return { usd, tokens, estimated, partial: partial || ids.length > MAX_THREADS, threadCount: result.threadCount };
  } catch {
    // Tokenomos is optional: missing, outdated or slow means no cost line.
    return null;
  }
}
