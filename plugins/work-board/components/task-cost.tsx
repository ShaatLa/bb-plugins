import type { TaskCost } from "../shared/contract";
import { useTasksQuery } from "../shell/data";

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

export function formatTaskCost(cost: TaskCost): { amount: string; detail: string } {
  const { freshIn, cacheRead, cacheWrite, output } = cost.tokens;
  const tokens = freshIn + cacheRead + cacheWrite + output;
  const approx = cost.estimated || cost.partial ? "~" : "";
  const amount = cost.usd === null ? `${approx}${compact.format(tokens)} tokens` : `${approx}$${cost.usd.toFixed(2)}`;
  const detail = [
    `Input ${compact.format(freshIn)}, cache read ${compact.format(cacheRead)}, cache write ${compact.format(cacheWrite)}, output ${compact.format(output)} tokens`,
    cost.usd === null ? "no price for some models" : "API-equivalent price",
    cost.estimated ? "includes estimates" : "",
    cost.partial ? "some threads are not counted yet" : "",
  ].filter(Boolean).join(" · ");
  return { amount, detail };
}

/** Spend of every thread that worked on the task or its epic members and subtasks, from the optional Tokenomos plugin. */
export function TaskCostLine({ taskId, epic }: { taskId: string; epic: boolean }) {
  const query = useTasksQuery(
    async (rpc) => (await rpc.call("getTaskCost", { taskId })).cost,
    ["threads:changed", "comments:changed"],
    [taskId],
    { relevantTaskIds: [taskId] },
  );
  const cost = query.data;
  if (!cost) return null;
  const { amount, detail } = formatTaskCost(cost);
  const label = epic ? "Spent on this epic" : cost.taskCount > 1 ? "Agent cost with subtasks" : "Agent cost";
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return (
    <div className="mt-3 text-xs" title={detail}>
      <div className="mb-1 text-2xs font-semibold text-muted-foreground">{label}</div>
      <span className="tabular-nums">{amount}</span>
      <span className="text-muted-foreground">
        {" · "}{plural(cost.threadCount, "thread")}{epic || cost.taskCount > 1 ? ` across ${plural(cost.taskCount, "task")}` : ""}
      </span>
    </div>
  );
}
