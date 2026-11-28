import { useState } from "react";
import { IconButton } from "./icon-button.js";
import { ConfirmDeleteDialog, ConfirmDeleteDialogContent } from "@/components/ui/confirm-delete-dialog";
import { cn } from "@/lib/utils";
import { THREAD_STATUS_META, formatRelativeTime } from "./meta.js";
import { ThreadPullRequestPill } from "./threads.js";
import { ThreadChooserDialog } from "./thread-chooser-dialog.js";
import { Icon } from "@/components/ui/icon";
import type { Task, TaskPullRequest, TaskThread } from "../../shared/contract.js";
import { useOpenThread } from "../../components/open-thread";

/** The task's linked sessions in their own card, between the status card and the pause. */
export function TaskSessions({ task, threads, pullRequests, unavailableThreadIds, onDetach, onError }: { task: Task; threads: TaskThread[]; pullRequests?: TaskPullRequest[]; unavailableThreadIds: string[]; onDetach: (thread: TaskThread) => Promise<void>; onError: (message: string) => void }) {
  const openThread = useOpenThread();
  const [confirm, setConfirm] = useState<TaskThread | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [pending, setPending] = useState(false);
  return (
    <section aria-label="Sessions" className="mb-2 rounded-md border border-border px-3 py-2 text-xs">
      <div className="flex items-center gap-1">
        <span className="text-muted-foreground">Sessions</span>
        {/* The add icon sits on the header's right edge, as the pause card puts its end time. */}
        <span className="ml-auto flex items-center">
          {!task.archivedAt ? <IconButton label="Send to another thread" icon="Plus" onClick={() => setChoosing(true)} /> : null}
        </span>
      </div>
      {threads.length ? threads.map((thread) => {
        const meta = THREAD_STATUS_META[thread.liveStatus];
        const title = thread.title || thread.threadId;
        return <div key={thread.threadId} data-thread-status={thread.liveStatus} className={cn("rounded py-1", thread.liveStatus === "failed" && "border border-destructive/60 bg-destructive/5 px-1 text-destructive")}>
          <div className="flex min-w-0 items-center gap-1">
            <span className={cn("flex shrink-0 items-center gap-1", meta.textClassName)}><span aria-hidden className={cn("size-1.5 rounded-full", meta.dotClassName)} />{meta.label}</span>
            <button type="button" title={title} aria-label={`Open thread ${title}`} className="min-w-0 flex-1 truncate text-left hover:underline" onClick={() => openThread(thread.threadId)}>{title}</button>
            <ThreadPullRequestPill pullRequest={pullRequests?.find((pr) => pr.threadIds.includes(thread.threadId))} unavailable={unavailableThreadIds.includes(thread.threadId)} />
            {!task.archivedAt ? <button type="button" aria-label={`Unassign ${title}`} disabled={pending} onClick={() => setConfirm(thread)}><Icon name="X" className="size-3" /></button> : null}
          </div>
          <div className="text-muted-foreground [overflow-wrap:anywhere]">{thread.presetName} · attached {formatRelativeTime(thread.attachedAt)}{thread.liveStatus === "failed" ? <span className="text-destructive"> · failed {formatRelativeTime(thread.updatedAt)}</span> : null}</div>
        </div>;
      }) : <span className="inline-block py-1 text-muted-foreground">None</span>}
      {choosing ? <ThreadChooserDialog kind="task" taskId={task.id} projectId={task.projectId} onClose={() => setChoosing(false)} /> : null}
      <ConfirmDeleteDialog className="max-w-sm" open={confirm !== null} onOpenChange={(open) => { if (!open) setConfirm(null); }}>
        {confirm ? <ConfirmDeleteDialogContent title="Detach thread?" description={`"${confirm.title}" will no longer be listed on this task. The thread itself is not deleted; re-attach it with bb work-board attach.`} confirmLabel="Detach" pending={pending} size="sm" onCancel={() => setConfirm(null)} onConfirm={() => { const thread = confirm; setConfirm(null); setPending(true); void onDetach(thread).catch((error) => onError(error instanceof Error ? error.message : String(error))).finally(() => setPending(false)); }} /> : null}
      </ConfirmDeleteDialog>
    </section>
  );
}
