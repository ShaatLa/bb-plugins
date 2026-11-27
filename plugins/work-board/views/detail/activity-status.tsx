import { useState } from "react";
import { ConfirmDeleteDialog, ConfirmDeleteDialogContent } from "@/components/ui/confirm-delete-dialog";
import { cn } from "@/lib/utils";
import { THREAD_STATUS_META, formatRelativeTime } from "./meta.js";
import { ThreadPullRequestPill } from "./threads.js";
import { ThreadChooserDialog } from "./thread-chooser-dialog.js";
import type { TaskPullRequest } from "../../shared/contract.js";
import { TaskAdvisories } from "../../components/task-advisories";
import type { TaskAdvisory } from "../../shared/task-advisories";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import type { TaskActivity } from "../../shared/task-activity.js";
import type { Task, TaskThread } from "../../shared/contract.js";
import { TaskActivityIndicator } from "../../components/task-activity.js";
import { StatusIcon } from "../../components/status-icon.js";
import { useTaskStatuses } from "../../shell/task-statuses.js";
import { useOpenThread } from "../../components/open-thread";

export function ActivityStatus({ task, activity, advisories, isFetching, error, threads, pullRequests, unavailableThreadIds, onDetach, onError, onStatusChange }: { task: Task; activity?: TaskActivity; advisories?: TaskAdvisory[]; isFetching: boolean; error: string | null; threads: TaskThread[]; pullRequests?: TaskPullRequest[]; unavailableThreadIds: string[]; onDetach: (thread: TaskThread) => Promise<void>; onError: (message: string) => void; onStatusChange: (status: Task["status"]) => void }) {
  const openThread = useOpenThread();
  const [confirm, setConfirm] = useState<TaskThread | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [pending, setPending] = useState(false);
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
          {activity?.state ? <TaskActivityIndicator activity={activity} sessionLines={false} /> : <span className="text-muted-foreground">{error ? "Activity unavailable" : activity ? "No activity" : isFetching ? "Checking activity…" : "Activity unavailable"}</span>}
        </div>
      </div>
      <TaskAdvisories items={advisories} />
      {error ? <p role="status" className="mt-2 text-warning">Could not refresh activity. Status may be out of date.</p> : null}
      {threads.length ? <div className="mt-2 border-t border-border pt-2">
        <div className="mb-1 text-2xs text-muted-foreground">Sessions</div>
        {threads.map((thread) => {
          const meta = THREAD_STATUS_META[thread.liveStatus];
          const title = thread.title || thread.threadId;
          return <div key={thread.threadId} data-thread-status={thread.liveStatus} className={cn("rounded py-1", thread.liveStatus === "failed" && "border border-destructive/60 bg-destructive/5 px-1 text-destructive")}>
            <div className="flex min-w-0 items-center gap-1">
              <span className={cn("flex shrink-0 items-center gap-1", meta.textClassName)}><span aria-hidden className={cn("size-1.5 rounded-full", meta.dotClassName)} />{meta.label}</span>
              <button type="button" title={title} aria-label={`Open thread ${title}`} className="min-w-0 flex-1 truncate text-left hover:underline" onClick={() => openThread(thread.threadId)}>{title}</button>
              <ThreadPullRequestPill pullRequest={pullRequests?.find((pr) => pr.threadIds.includes(thread.threadId))} unavailable={unavailableThreadIds.includes(thread.threadId)} />
              {!task.archivedAt ? <button type="button" aria-label={`Unassign ${title}`} disabled={pending} onClick={() => setConfirm(thread)}><Icon name="X" className="size-3" /></button> : null}
            </div>
            <div className="text-muted-foreground">{thread.presetName} · attached {formatRelativeTime(thread.attachedAt)}{thread.liveStatus === "failed" ? <span className="text-destructive"> · failed {formatRelativeTime(thread.updatedAt)}</span> : null}</div>
          </div>;
        })}
        {!task.archivedAt ? <button type="button" className="mt-1 text-muted-foreground hover:underline" onClick={() => setChoosing(true)}>Send to another thread…</button> : null}
        {choosing ? <ThreadChooserDialog kind="task" taskId={task.id} projectId={task.projectId} onClose={() => setChoosing(false)} /> : null}
        <ConfirmDeleteDialog className="max-w-sm" open={confirm !== null} onOpenChange={(open) => { if (!open) setConfirm(null); }}>
          {confirm ? <ConfirmDeleteDialogContent title="Detach thread?" description={`"${confirm.title}" will no longer be listed on this task. The thread itself is not deleted; re-attach it with bb work-board attach.`} confirmLabel="Detach" pending={pending} size="sm" onCancel={() => setConfirm(null)} onConfirm={() => { const thread = confirm; setConfirm(null); setPending(true); void onDetach(thread).catch((error) => onError(error instanceof Error ? error.message : String(error))).finally(() => setPending(false)); }} /> : null}
        </ConfirmDeleteDialog>
      </div> : null}
    </section>
  );
}
