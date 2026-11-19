import { DialogScope } from "@/components/ui/dialog";
import { TasksRefreshProvider } from "../../shell/refresh.js";
import { TaskStatusesProvider } from "../../shell/task-statuses.js";
import { PlanView } from "./plan-view.js";

function isTaskKeyParam(params: unknown): params is { taskKey: string } {
  return typeof params === "object" && params !== null && typeof (params as { taskKey?: unknown }).taskKey === "string" && (params as { taskKey: string }).taskKey !== "";
}

/** Content of one Plan tab instance; `params` is what `openTab` was given, round-tripped through persistence. */
export function PlanTabPanel({ params }: { params: unknown }) {
  if (!isTaskKeyParam(params)) {
    return <p role="status" className="p-4 text-sm text-muted-foreground">No task selected. Open a plan from a task's Plan card.</p>;
  }
  return (
    <DialogScope className="relative h-full min-h-0">
      <TasksRefreshProvider>
        <TaskStatusesProvider>
          <PlanView key={params.taskKey} taskKey={params.taskKey} surface="panel" />
        </TaskStatusesProvider>
      </TasksRefreshProvider>
    </DialogScope>
  );
}
