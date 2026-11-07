import type { Task } from "../../shared/contract.js";
import { useTasksNavigation } from "../../shell/routes.js";
import { Icon } from "@/components/ui/icon";
import { useScheduledQuery } from "./data.js";
import { browserTimeZone, formatInZone } from "./lib.js";

/** Shown on tasks that belong to a schedule; the lookup runs once when the detail opens. */
export function ScheduledSourceBanner({ task }: { task: Task }) {
  const navigation = useTasksNavigation();
  const query = useScheduledQuery((rpc) => rpc.call("getTaskSchedule", { taskId: task.id }), [task.id]);
  const source = query.data?.source;
  if (!source) return null;
  const isTemplate = source.role === "template";
  return (
    <div role="note" aria-label="Scheduled task source" className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border bg-secondary/50 px-3 py-2 text-xs text-muted-foreground">
      <Icon name="Clock" className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        {isTemplate
          ? <>Template for schedule “{source.scheduleTitle}”. Edits here apply to future runs; it is not an ordinary active task.</>
          : <>Created by schedule “{source.scheduleTitle}”{source.scheduledFor ? ` for ${formatInZone(source.scheduledFor, browserTimeZone())}` : ""}{source.startedAt ? "" : " · not started yet"}.</>}
      </span>
      <button
        type="button"
        className="shrink-0 text-foreground underline-offset-2 hover:underline"
        onClick={() => navigation.go({ kind: "scheduled", tab: isTemplate ? "all" : "results" })}
      >
        Open Scheduled
      </button>
    </div>
  );
}
