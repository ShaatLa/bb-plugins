import { waitingOnOwner } from "../shared/waiting-on-owner";
import type { Task } from "../shared/contract";
import { useEffect, useRef, useMemo } from "react";
import { taskBatches } from "../shell/task-batches";
import { signalTaskIds } from "../shell/signal-scheduler";
import { useTasksQuery, type TasksRpc } from "../shell/data";
import { Icon } from "@/components/ui/icon";

async function readCounts(rpc: TasksRpc, ids: readonly string[]) {
  const rows = await taskBatches(ids, async (taskIds) => (await rpc.call("questionCounts", { taskIds })).counts);
  return new Map(rows.map((row) => [row.taskId, row]));
}
export function useQuestionCounts(tasks: readonly Task[], enabled = true, projectId = tasks[0]?.projectId ?? "") {
  const taskIds = tasks.map((task) => task.id).sort();
  const idsKey = taskIds.join();
  const previousIds = useRef<{ projectId: string; ids: string[] } | null>(null);
  const query = useTasksQuery(
    async (rpc) => {
      const rows = await readCounts(rpc, taskIds);
      previousIds.current = { projectId, ids: taskIds };
      return rows;
    },
    ["tasks:changed"],
    [projectId],
    {
      enabled,
      dataScope: projectId,
      relevantTaskIds: taskIds,
      applySignals: async (rpc, current, signals) => {
        const changed = signalTaskIds(signals, "tasks:changed").filter((id) => taskIds.includes(id));
        if (!changed.length) return current;
        const next = new Map(current);
        for (const id of changed) next.delete(id);
        for (const [id, count] of await readCounts(rpc, changed)) next.set(id, count);
        return next;
      },
    },
  );
  useEffect(() => {
    if (!enabled || query.isFetching || !query.data) return;
    const previous = previousIds.current;
    previousIds.current = { projectId, ids: taskIds };
    if (!previous || previous.projectId !== projectId) return;
    const added = taskIds.filter((id) => !previous.ids.includes(id));
    if (!added.length && previous.ids.length === taskIds.length) return;
    void query.patch(async (rpc, current) => {
      const next = new Map([...current].filter(([id]) => taskIds.includes(id)));
      for (const [id, count] of await readCounts(rpc, added)) next.set(id, count);
      return next;
    }).catch(() => query.refresh());
  }, [projectId, idsKey, enabled, query.isFetching, query.data, query.patch]);
  return { ...query,
    details: query.data,
    data: useMemo(() => query.data && new Map([...query.data].map(([id, row]) => [id, row.unanswered])), [query.data]),
  };
}

export function QuestionCount({
  count = 0,
  title,
}: {
  count?: number;
  title?: string;
}) {
  if (!count) return null;
  const label = `${count} unanswered ${count === 1 ? "question" : "questions"}`;
  return (
    <span
      role="img"
      aria-label={label}
      title={title ?? label}
      className="inline-flex shrink-0 items-center gap-1 px-1.5 py-px text-xs tabular-nums text-warning"
    >
      <Icon name="FileQuestion" className="size-3" aria-hidden />
      {count}
    </span>
  );
}

export function WaitingOnYou({ task, count = 0 }: { task: Task; count?: number }) {
  if (!waitingOnOwner(task, count)) return null;
  return <span className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-xs text-warning"><Icon name="FileQuestion" className="size-3" aria-hidden />Waiting on you</span>;
}
