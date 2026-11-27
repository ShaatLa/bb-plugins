import { useEffect, useState } from "react";
import { useRealtime, useSdk } from "@get-bb/plugin-sdk/app";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useTasksQuery, useTasksRpc } from "../shell/data";
import { useTasksNavigation } from "../shell/routes";
import { useThreadName } from "./queue-chip";
import { errorMessage } from "../shared/errors";
import { useTaskStatuses } from "../shell/task-statuses";

export function QueueMenu({ projectId }: { projectId: string }) {
  const sdk = useSdk();
  const rpc = useTasksRpc();
  const navigation = useTasksNavigation();
  const statuses = useTaskStatuses(projectId);
  const query = useTasksQuery(async (client) => (await client.call("queueList", { projectId })).queues, ["tasks:changed"], [projectId]);
  const [threadRevision, setThreadRevision] = useState(0);
  useRealtime("threads:changed", () => setThreadRevision((value) => value + 1));
  const [states, setStates] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<{ threadId: string; message: string } | null>(null);
  const queues = query.data ?? [];
  const ids = queues.map((queue) => queue.threadId).join("\0");
  useEffect(() => {
    if (!ids) return;
    let cancelled = false;
    const threadIds = ids.split("\0");
    void sdk.threads.list({ threadIds, limit: threadIds.length, includeHidden: true }).then((threads) => {
      if (!cancelled) setStates(Object.fromEntries(threads.map((thread) => [thread.id, thread.status === "active" && thread.runtime.displayStatus === "active"])));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [sdk, ids, threadRevision]);
  if (!queues.length && !query.error) return null;
  const act = async (threadId: string, action: () => Promise<unknown>) => {
    setError(null);
    try { await action(); await query.refresh(); } catch (cause) { setError({ threadId, message: errorMessage(cause) }); }
  };
  return <DropdownMenu onOpenChange={(open) => { if (open) void query.refresh(); }}>
    <DropdownMenuTrigger asChild><button type="button" className="ml-2 shrink-0 rounded px-2 py-1 text-xs hover:bg-state-hover">Queues · {queues.length}</button></DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="max-h-96 w-96 overflow-y-auto p-2">
      {query.error ? <p role="alert" className="text-destructive">{query.error}</p> : null}
      {queues.map((queue) => <section key={queue.threadId} className="mb-2 text-xs">
        <QueueHeading threadId={queue.threadId} working={states[queue.threadId]} />
        {queue.entries.map((entry) => <div key={entry.taskId} className="flex items-center gap-2 py-1">
          <span className="w-4">{entry.position === 1 ? "▶" : entry.position}</span>
          <button type="button" className="min-w-0 flex-1 truncate text-left hover:underline" onClick={() => navigation.go({ kind: "task", taskKey: entry.key })}>{entry.key} · {entry.title} · {statuses.label(entry.status)}</button>
          {entry.position > 1 ? <button type="button" aria-label={`Move ${entry.key} up`} onClick={() => void act(queue.threadId, () => rpc.call("queueMove", { taskId: entry.taskId, position: entry.position - 1, actor: "owner" }))}>↑</button> : null}
          {entry.position < queue.entries.length ? <button type="button" aria-label={`Move ${entry.key} down`} onClick={() => void act(queue.threadId, () => rpc.call("queueMove", { taskId: entry.taskId, position: entry.position + 1, actor: "owner" }))}>↓</button> : null}
          <button type="button" aria-label={`Remove ${entry.key}`} onClick={() => void act(queue.threadId, () => rpc.call("queueRemove", { taskId: entry.taskId, actor: "owner" }))}>×</button>
        </div>)}
        {error?.threadId === queue.threadId ? <p role="alert" className="text-destructive">{error.message}</p> : null}
      </section>)}
    </DropdownMenuContent>
  </DropdownMenu>;
}
function QueueHeading({ threadId, working }: { threadId: string; working?: boolean }) {
  const name = useThreadName(threadId);
  return <div className="font-medium">{name} · {working ? "working" : "idle"}</div>;
}
