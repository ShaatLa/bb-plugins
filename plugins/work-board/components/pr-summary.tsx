import { taskBatches } from "../shell/task-batches";
import { signalTaskIds } from "../shell/signal-scheduler";
import { useTasksQuery, type TasksRpc } from "../shell/data";
import type { Overlap } from "../shared/git-sync";
import type { Task } from "../shared/contract";
import { useEffect, useRef } from "react";
export type PrSummary = {
  total: number;
  merged: number;
  failing: number;
  pending: number;
  stale: boolean;
  overlaps?: Overlap[];
};
async function readSummaries(rpc: TasksRpc, ids: readonly string[]) {
  const rows = await taskBatches(ids, async (taskIds) => (await rpc.call("prSummaries", { taskIds })).summaries);
  return new Map<string, PrSummary>(rows.map((row) => [row.taskId, row]));
}
export function usePrSummaries(tasks: readonly Task[], enabled = true, projectId = tasks[0]?.projectId ?? "") {
  const ids = tasks.map((task) => task.id).sort();
  const idsKey = ids.join();
  const previousIds = useRef<{ projectId: string; ids: string[] } | null>(null);
  const query = useTasksQuery(
    async (rpc) => {
      const rows = await readSummaries(rpc, ids);
      previousIds.current = { projectId, ids };
      return rows;
    },
    ["tasks:changed", "prs:changed"],
    [projectId],
    {
      enabled,
      dataScope: projectId,
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
  useEffect(() => {
    if (!enabled || query.isFetching || !query.data) return;
    const previous = previousIds.current;
    previousIds.current = { projectId, ids };
    if (!previous || previous.projectId !== projectId) return;
    const added = ids.filter((id) => !previous.ids.includes(id));
    if (!added.length && previous.ids.length === ids.length) return;
    void query.patch(async (rpc, current) => {
      const next = new Map([...current].filter(([id]) => ids.includes(id)));
      for (const [id, summary] of await readSummaries(rpc, added)) next.set(id, summary);
      return next;
    }).catch(() => query.refresh());
  }, [projectId, idsKey, enabled, query.isFetching, query.data, query.patch]);
  return query;
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
      {summary.overlaps?.length ? <span className={summary.overlaps.some(o => o.rule) ? "text-destructive" : "text-muted-foreground"} title={summary.overlaps.map(o => `Overlaps ${o.otherTaskKey} (${o.otherPr.repository}#${o.otherPr.number}): ${o.rule ? `${o.rule.pattern} ${o.rule.match}; ` : ""}${o.files.length} ${o.rule?.match === "added" ? "matched" : "shared"} files`).join("\n")}> · ⚠ {summary.overlaps.length}</span> : null}
    </span>
  );
}
