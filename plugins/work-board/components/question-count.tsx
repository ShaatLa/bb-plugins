import type { Task } from "../shared/contract";
import { taskBatches } from "../shell/task-batches";
import { signalTaskIds } from "../shell/signal-scheduler";
import { useTasksQuery, type TasksRpc } from "../shell/data";
import { Icon } from "@/components/ui/icon";

async function readCounts(rpc: TasksRpc, ids: readonly string[]) {
  const rows = await taskBatches(ids, async (taskIds) => (await rpc.call("questionCounts", { taskIds })).counts);
  return new Map(rows.map((row) => [row.taskId, row.unanswered]));
}
export function useQuestionCounts(tasks: readonly Task[]) {
  const taskIds = tasks.map((task) => task.id).sort();
  return useTasksQuery(
    (rpc) => readCounts(rpc, taskIds),
    ["tasks:changed"],
    [taskIds.join()],
    {
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
