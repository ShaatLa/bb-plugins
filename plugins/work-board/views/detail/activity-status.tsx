import { TaskAdvisories } from "../../components/task-advisories";
import type { TaskAdvisory } from "../../shared/task-advisories";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { TaskActivity } from "../../shared/task-activity.js";
import type { Task, TaskThread } from "../../shared/contract.js";
import { TaskActivityIndicator } from "../../components/task-activity.js";
import { StatusIcon } from "../../components/status-icon.js";
import { useTaskStatuses } from "../../shell/task-statuses.js";

export function ActivityStatus({ task, activity, advisories, isFetching, error, threads, onStatusChange }: { task: Task; activity?: TaskActivity; advisories?: TaskAdvisory[]; isFetching: boolean; error: string | null; threads: TaskThread[]; onStatusChange: (status: Task["status"]) => void }) {
  const navigate = useBbNavigate();
  const workflow = useTaskStatuses(task.projectId);
  return (
    <section aria-label="Task activity status" className="mb-2 rounded-md border border-border px-3 py-2 text-xs">
      <div className="grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1">
        <span className="text-muted-foreground">Status</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label="Change task status" className="inline-flex min-w-0 items-center gap-1 rounded px-1 py-1 text-left hover:bg-state-hover">
              <StatusIcon projectId={task.projectId} status={task.status} />
              {workflow.label(task.status)}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {workflow.ids.map((status) => <DropdownMenuItem key={status} onSelect={() => onStatusChange(status)}>
              <StatusIcon projectId={task.projectId} status={status} />
              {workflow.label(status)}
              {status === task.status ? <Icon name="Check" className="ml-auto size-3.5" /> : null}
            </DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="text-muted-foreground">Activity</span>
        <div className="min-w-0 px-1 py-1">
          {activity?.state ? <TaskActivityIndicator activity={activity} /> : <span className="text-muted-foreground">{error ? "Activity unavailable" : activity ? "No activity" : isFetching ? "Checking activity…" : "Activity unavailable"}</span>}
        </div>
      </div>
      <TaskAdvisories items={advisories} />
      {error ? <p role="status" className="mt-2 text-warning">Could not refresh activity. Status may be out of date.</p> : null}
      {threads.length ? <div className="mt-2 border-t border-border pt-2">
        <div className="mb-1 text-2xs text-muted-foreground">Sessions</div>
        {threads.map((thread) => <button key={thread.threadId} type="button" aria-label={`Open thread ${thread.title || thread.threadId}`} title={thread.title || thread.threadId} className="block w-full truncate py-1 text-left hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={() => navigate.toThread(thread.threadId)}>{thread.title || thread.threadId}</button>)}
      </div> : null}
    </section>
  );
}
