import { useTasksQuery } from "../shell/data";
import type { Task } from "../shared/contract";
export type PrSummary = {
  total: number;
  merged: number;
  failing: number;
  pending: number;
  stale: boolean;
};
export function usePrSummaries(tasks: readonly Task[]) {
  const ids = tasks.map((task) => task.id);
  return useTasksQuery(
    async (rpc) => {
      const summaries = new Map<string, PrSummary>();
      for (let offset = 0; offset < ids.length; offset += 500) {
        const result = await rpc.call("prSummaries", {
          taskIds: ids.slice(offset, offset + 500),
        });
        for (const summary of result.summaries)
          summaries.set(summary.taskId, summary);
      }
      return summaries;
    },
    ["tasks:changed"],
    [ids.join()],
    { relevantTaskIds: ids },
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
