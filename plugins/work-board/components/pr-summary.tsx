import { taskBatches } from "../shell/task-batches";
import { signalTaskIds } from "../shell/signal-scheduler";
import { useTasksQuery, type TasksRpc } from "../shell/data";
import type { Task } from "../shared/contract";
export type PrSummary = {
  total: number;
  merged: number;
  failing: number;
  pending: number;
  stale: boolean;
};
async function readSummaries(rpc: TasksRpc, ids: readonly string[]) {
  const rows = await taskBatches(ids, async (taskIds) => (await rpc.call("prSummaries", { taskIds })).summaries);
  return new Map<string, PrSummary>(rows.map((row) => [row.taskId, row]));
}
export function usePrSummaries(tasks: readonly Task[]) {
  const ids = tasks.map((task) => task.id).sort();
  return useTasksQuery(
    (rpc) => readSummaries(rpc, ids),
    ["tasks:changed", "prs:changed"],
    [ids.join()],
    {
      relevantTaskIds: ids,
      applySignals: async (rpc, current, signals) => {
        const changed = [...new Set([...signalTaskIds(signals, "tasks:changed"), ...signalTaskIds(signals, "prs:changed")])].filter((id) => ids.includes(id));
        if (!changed.length) return current;
        const next = new Map(current);
        for (const id of changed) next.delete(id);
        for (const [id, summary] of await readSummaries(rpc, changed)) next.set(id, summary);
        return next;
      },
    },
  );
}
export function PullRequestSummary({ summary }: { summary?: PrSummary }) {
  if (!summary?.total) return null;
  return (
    <span
      title="Linked PR state; open the card for roles, checks and merge blockers"
      className={`text-2xs ${summary.failing ? "text-destructive" : "text-muted-foreground"}`}
    >
      PR {summary.merged}/{summary.total} merged
      {summary.failing
        ? ` · CI ${summary.failing} failing`
        : summary.pending
          ? ` · CI ${summary.pending} pending`
          : ""}
      {summary.stale ? " · stale" : ""}
    </span>
  );
}
