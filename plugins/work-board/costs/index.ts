import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { TaskCost } from "../shared/contract";

const MAX_SPANS = 2000;
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

export type CostSpan = { threadId: string; from: number; to: number | null };
type Event = { task_id: string; thread_id: string; at: string; event: "attach" | "fallback" | "detach" | "link"; created: string };
type Attachment = { taskId: string; from: number; to: number };

/** Attach..detach intervals of one thread on one task, chronological events in; open ones end at Infinity. */
function attachments(events: Event[]): Attachment[] {
  const out: Attachment[] = [];
  let open: number | null = null;
  let lastClose: number | null = null;
  for (const event of events) {
    const at = Date.parse(event.at);
    if (event.event === "attach") open ??= at;
    else if (event.event === "detach") {
      // Links older than attach comments only left a detach: assume from task creation.
      const from = open ?? (event === events[0] ? Date.parse(event.created) : null);
      if (from !== null) out.push({ taskId: event.task_id, from: Math.min(from, at), to: at });
      open = null;
      lastClose = at;
    } else if (event.event === "link" && open === null) open = Math.max(at, lastClose ?? at);
  }
  if (open !== null) out.push({ taskId: events[0]!.task_id, from: open, to: Infinity });
  return out;
}

/**
 * When threads worked on the task or anything inside it (epic members and subtasks,
 * recursively). A thread works on a task from "Thread attached" to "Thread detached",
 * or until now while linked. Workers often stay linked to old tasks while moving on,
 * so at any moment a thread's time belongs to the task it was attached to most
 * recently, across all tasks. Commenters alone (a manager, a reviewer) and
 * parent-fallback links (an orchestrator stands in for a finished worker) never own
 * time. Newest spans first; taskCount is how many tasks of the tree own any time.
 */
export function taskCostSpans(db: Db, taskId: string): { spans: CostSpan[]; taskCount: number } {
  const tree = new Set(db.prepare<[string], { id: string }>(`
    WITH RECURSIVE tree(id) AS (
      SELECT ? UNION SELECT t.id FROM tasks t JOIN tree ON t.epic_id = tree.id OR t.parent_task_id = tree.id
    ) SELECT id FROM tree
  `).all(taskId).map((row) => row.id));
  const treeJson = JSON.stringify([...tree]);
  // Every attachment of every thread that touched the tree, on any task: needed to see where it moved on.
  const rows = db.prepare<[string, string], Event>(`
    WITH threads(id) AS (
      SELECT thread_id FROM comments WHERE task_id IN (SELECT value FROM json_each(?)) AND kind = 'system'
        AND thread_id LIKE 'thr_%' AND (body LIKE 'Thread attached%' OR body LIKE 'Thread detached%')
      UNION SELECT thread_id FROM task_threads WHERE task_id IN (SELECT value FROM json_each(?)) AND preset_name != 'Parent thread'
    )
    SELECT c.task_id, c.thread_id, c.created_at AS at, t.created_at AS created,
      CASE WHEN c.body LIKE 'Thread attached (parent fallback):%' THEN 'fallback'
           WHEN c.body LIKE 'Thread attached%' THEN 'attach' ELSE 'detach' END AS event
    FROM comments c JOIN tasks t ON t.id = c.task_id
    WHERE c.kind = 'system' AND c.thread_id IN (SELECT id FROM threads)
      AND (c.body LIKE 'Thread attached%' OR c.body LIKE 'Thread detached%')
    UNION ALL
    SELECT l.task_id, l.thread_id, l.attached_at, t.created_at, 'link'
    FROM task_threads l JOIN tasks t ON t.id = l.task_id
    WHERE l.thread_id IN (SELECT id FROM threads) AND l.preset_name != 'Parent thread'
  `).all(treeJson, treeJson);
  // Chronological; a link sorts after an event at the same instant (it mirrors the attach).
  rows.sort((x, y) => x.at.localeCompare(y.at) || Number(x.event === "link") - Number(y.event === "link"));
  const byThread = new Map<string, Map<string, Event[]>>();
  for (const row of rows) {
    const tasks = byThread.get(row.thread_id) ?? new Map<string, Event[]>();
    byThread.set(row.thread_id, tasks);
    tasks.set(row.task_id, [...(tasks.get(row.task_id) ?? []), row]);
  }
  const spans: { threadId: string; from: number; to: number }[] = [];
  const owners = new Set<string>();
  for (const [threadId, tasks] of byThread) {
    const all = [...tasks.values()].flatMap(attachments);
    const points = [...new Set(all.flatMap((span) => [span.from, span.to]))].sort((x, y) => x - y);
    let last: (typeof spans)[number] | undefined;
    for (let i = 0; i + 1 < points.length; i++) {
      const [from, to] = [points[i]!, points[i + 1]!];
      const owner = all
        .filter((span) => span.from <= from && span.to >= to)
        .reduce<Attachment | undefined>((best, span) => (best && best.from >= span.from ? best : span), undefined);
      if (!owner || !tree.has(owner.taskId)) continue;
      owners.add(owner.taskId);
      if (last?.threadId === threadId && last.to === from) last.to = to;
      else spans.push((last = { threadId, from, to }));
    }
  }
  spans.sort((x, y) => y.to - x.to);
  return {
    spans: spans.map(({ threadId, from, to }) => ({ threadId, from, to: to === Infinity ? null : to })),
    taskCount: owners.size,
  };
}

export async function getTaskCost(bb: BbPluginApi, taskId: string): Promise<TaskCost | null> {
  const { spans, taskCount } = taskCostSpans(bb.storage.database(), taskId);
  if (!spans.length) return null;
  try {
    const result = await bb.sdk.plugins.callRpc({
      pluginId: "tokenomos",
      method: "costs.sum",
      input: { spans: spans.slice(0, MAX_SPANS), includeDescendants: true },
      outputSchema: tokenomosSum,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // One call for the whole tree: Tokenomos merges overlapping spans and dedupes descendants within it.
    // Nothing counted yet (Tokenomos still importing history): "~$0.00" would mislead.
    if (result.threadCount === 0) return null;
    const { usd, tokens, estimated, partial } = result.cost;
    return { usd, tokens, estimated, partial: partial || spans.length > MAX_SPANS, threadCount: result.threadCount, taskCount };
  } catch {
    // Tokenomos is optional: missing, outdated or slow means no cost line.
    return null;
  }
}
