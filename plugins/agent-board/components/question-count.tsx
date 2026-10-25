import type { Task } from "../shared/contract";
import { useTasksQuery } from "../shell/data";
import { Icon } from "@/components/ui/icon";

export function useQuestionCounts(tasks: readonly Task[]) {
  const taskIds = tasks.map((task) => task.id);
  return useTasksQuery(
    async (rpc) => {
      const counts = new Map<string, number>();
      for (let offset = 0; offset < taskIds.length; offset += 500) {
        const result = await rpc.call("questionCounts", {
          taskIds: taskIds.slice(offset, offset + 500),
        });
        for (const entry of result.counts)
          counts.set(entry.taskId, entry.unanswered);
      }
      return counts;
    },
    ["tasks:changed"],
    [taskIds.join()],
    { relevantTaskIds: taskIds },
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
