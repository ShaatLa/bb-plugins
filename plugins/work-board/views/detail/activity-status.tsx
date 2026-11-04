import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { TaskActivity } from "../../shared/task-activity.js";
import type { Task } from "../../shared/contract.js";
import { ACTIVITY_LABELS } from "../../shared/task-activity.js";
import { TaskActivityIndicator } from "../../components/task-activity.js";
import { StatusIcon } from "../../components/status-icon.js";
import { useTasksNavigation } from "../../shell/routes.js";
import { useTaskStatuses } from "../../shell/task-statuses.js";

export function ActivityStatus({ task, activity, isFetching, error, onViewHistory }: { task: Task; activity?: TaskActivity; isFetching: boolean; error: string | null; onViewHistory: () => void }) {
  const navigate = useBbNavigate();
  const navigation = useTasksNavigation();
  const workflow = useTaskStatuses(task.projectId);
  const diagnostics = activity?.diagnostics;
  return (
    <section aria-label="Task activity status" className="mb-4 rounded-md border border-border px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 text-muted-foreground" title="Workflow status">
          <StatusIcon projectId={task.projectId} status={task.status} />
          {workflow.label(task.status)}
        </span>
        <span aria-hidden className="text-muted-foreground">·</span>
        {activity?.state ? <TaskActivityIndicator activity={activity} /> : <span className="text-muted-foreground">{error ? "Activity unavailable" : activity ? "No activity" : isFetching ? "Checking activity…" : "Activity unavailable"}</span>}
      </div>
      {error ? <p role="status" className="mt-2 text-warning">Could not refresh activity. Displayed details may be out of date.</p> : null}
      {activity ? <details className="mt-2">
        <summary className="cursor-pointer text-2xs text-muted-foreground hover:text-foreground">Why this status?</summary>
        <div className="mt-2 space-y-2 text-2xs leading-relaxed">
          <p>{diagnostics?.explanation ?? "Diagnostic details are unavailable for this snapshot."}</p>
          {diagnostics ? <>
            <p className="text-muted-foreground">Previous work recorded: {diagnostics.hasWorked ? "yes" : "no"}. Session data: {diagnostics.complete ? "complete" : "incomplete"}.</p>
            {!diagnostics.complete ? <p className="text-warning">Some session data could not be read. Unverified sessions stay Attached.</p> : null}
            {diagnostics.hasWorked ? <p className="text-muted-foreground">Work history records verified scoped execution or agent comments. Historical execution details may not have been retained. <button type="button" className="underline underline-offset-2" onClick={onViewHistory}>View activity reports</button></p> : null}
          </> : null}
          {activity.sessions.map((session) => <div key={session.threadId} className="rounded border border-border p-2">
            <button type="button" className="break-words text-left font-medium underline underline-offset-2" onClick={() => navigate.toThread(session.threadId)}>{session.title || session.threadId}</button>
            <span className="text-muted-foreground"> · {session.role === "parent" ? "Parent thread" : "Worker"} · {ACTIVITY_LABELS[session.state]}</span>
            <p className="mt-1">{session.diagnostics?.explanation ?? "Session diagnostic details are unavailable."}</p>
            <div className="mt-1 break-all font-mono text-muted-foreground">
              <p>Thread: {session.threadId}</p>
              {session.diagnostics ? <>
                <p>Status: {session.diagnostics.threadStatus ?? "unknown"}; runtime: {session.diagnostics.runtimeStatus ?? "unknown"}</p>
                {session.diagnostics.focusedTaskId ? <p>Focused task: {session.diagnostics.focusedTaskKey ? <button type="button" className="underline underline-offset-2" onClick={() => navigation.go({ kind: "task", taskKey: session.diagnostics!.focusedTaskKey! })}>{session.diagnostics.focusedTaskKey}</button> : session.diagnostics.focusedTaskId}</p> : null}
                {session.diagnostics.turnId ? <p>Turn: {session.diagnostics.turnId}</p> : null}
                {session.diagnostics.requestId ? <p>Request: {session.diagnostics.requestId}</p> : null}
                {session.diagnostics.queueIds.map((id) => <p key={id}>Queue: {id}</p>)}
                {session.diagnostics.interactionIds.map((id) => <p key={id}>Interaction: {id}</p>)}
              </> : null}
            </div>
          </div>)}
          {diagnostics?.inactiveSessions.map((session) => <p key={session.threadId}>
            <button type="button" className="underline underline-offset-2" onClick={() => navigate.toThread(session.threadId)}>{session.title || session.threadId}</button>
            <span className="text-muted-foreground"> · {session.threadId} · {session.reason}; excluded from current activity</span>
          </p>)}
          {diagnostics ? <p className="text-muted-foreground">Checked <time dateTime={diagnostics.checkedAt}>{new Date(diagnostics.checkedAt).toLocaleString()}</time></p> : null}
        </div>
      </details> : null}
    </section>
  );
}
