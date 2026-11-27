import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useRealtime, useSdk } from "@get-bb/plugin-sdk/app";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useTasksQuery, useTasksRpc } from "../shell/data";
import { useTasksNavigation } from "../shell/routes";
import { useThreadName } from "./queue-chip";
import { errorMessage } from "../shared/errors";
import { useTaskStatuses } from "../shell/task-statuses";

type QueueList = readonly { entries: readonly { taskId: string; position: number }[] }[];

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
  const [drag, setDrag] = useState<{ threadId: string; taskId: string; position: number } | null>(null);
  const [over, setOver] = useState<{ taskId: string; edge: "top" | "bottom" } | null>(null);
  // Where focus goes after a keyboard change, consumed only by data that already shows the change (a stale read can land first).
  const focusTarget = useRef<{ taskId: string | null; settled: (queues: QueueList) => boolean } | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
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
  useEffect(() => {
    const target = focusTarget.current;
    if (!target || !query.data || !target.settled(query.data)) return;
    focusTarget.current = null;
    if (target.taskId) Array.from(contentRef.current?.querySelectorAll<HTMLElement>("[data-task-id]") ?? []).find((node) => node.dataset.taskId === target.taskId)?.focus();
  }, [query.data]);
  if (!queues.length && !query.error) return null;
  const first = queues[0]?.entries[1] ?? queues[0]?.entries[0];
  const current = first?.position === 1;
  const others = Math.max(0, queues.length - 1);
  const act = async (threadId: string, action: () => Promise<unknown>, focus?: { taskId: string | null; settled: (queues: QueueList) => boolean }) => {
    setError(null);
    try { await action(); if (focus) focusTarget.current = focus; await query.refresh(); } catch (cause) { focusTarget.current = null; setError({ threadId, message: errorMessage(cause) }); }
  };
  return <DropdownMenu onOpenChange={(open) => { if (open) void query.refresh(); }}>
    {/* Shares the room the project name leaves with the manager control, as that control does, so the name is never cut. */}
    <span className="ml-2 flex min-w-14 grow basis-0 max-w-max items-center gap-1.5">
      <span className="min-w-0 truncate text-xs text-muted-foreground">Queue</span>
      <DropdownMenuTrigger asChild><Button type="button" size="sm" variant="outline" className="h-6 min-w-11 max-w-56 shrink-[20] gap-1.5 overflow-hidden rounded-md px-2 text-xs font-normal shadow-none" aria-label={first ? `Queue: ${current ? "current" : "next"} ${first.key} ${first.title}${others ? `, ${others} more queues` : ""}` : "Queue: unavailable"}>
        {current ? <Icon name="Play" className="size-3 shrink-0" /> : null}<span className="min-w-0 truncate">{first ? `${first.key} · ${first.title}` : "Unavailable"}</span>{others ? <span className="shrink-0 text-muted-foreground">+{others}</span> : null}<Icon name="ChevronDown" className="size-3 shrink-0 text-muted-foreground" />
      </Button></DropdownMenuTrigger>
    </span>
    <DropdownMenuContent ref={contentRef} align="start" className="max-h-96 w-96 overflow-y-auto p-2">
      {query.error ? <p role="alert" className="text-destructive">{query.error}</p> : null}
      {queues.map((queue) => <section key={queue.threadId} className="mb-2 text-xs">
        <QueueHeading threadId={queue.threadId} working={states[queue.threadId]} />
        {queue.entries.map((entry, index) => <div key={entry.taskId} draggable className={`relative flex items-center gap-2 py-1 ${drag?.taskId === entry.taskId && drag.threadId === queue.threadId ? "opacity-50" : ""}`} onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; setDrag({ threadId: queue.threadId, taskId: entry.taskId, position: entry.position }); }} onDragEnd={() => { setDrag(null); setOver(null); }} onDragOver={(event) => { if (drag?.threadId !== queue.threadId || drag.taskId === entry.taskId) { setOver(null); return; } event.preventDefault(); setOver({ taskId: entry.taskId, edge: drag.position > entry.position ? "top" : "bottom" }); }} onDrop={(event) => { event.preventDefault(); if (drag?.threadId === queue.threadId && drag.taskId !== entry.taskId) void act(queue.threadId, () => rpc.call("queueMove", { taskId: drag.taskId, position: entry.position, actor: "owner" })); setDrag(null); setOver(null); }}>
          {over?.taskId === entry.taskId && drag?.threadId === queue.threadId ? <span aria-hidden className={`absolute inset-x-0 h-0.5 bg-primary ${over.edge === "top" ? "top-0" : "bottom-0"}`} /> : null}
          <span className="w-4 shrink-0">{entry.position === 1 ? <Icon name="Play" className="size-4" /> : entry.position}</span>
          <DropdownMenuItem data-task-id={entry.taskId} aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Delete" className="min-w-0 flex-1 truncate text-left hover:underline" onSelect={() => navigation.go({ kind: "task", taskKey: entry.key })} onKeyDown={(event) => {
            const move = event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown");
            const remove = event.key === "Delete" || event.key === "Backspace";
            if (!move && !remove) return;
            event.preventDefault(); event.stopPropagation();
            if (move) { const position = entry.position + (event.key === "ArrowUp" ? -1 : 1); if (position < 1 || position > queue.entries.length) return; void act(queue.threadId, () => rpc.call("queueMove", { taskId: entry.taskId, position, actor: "owner" }), { taskId: entry.taskId, settled: (queues) => queues.some((item) => item.entries.some((other) => other.taskId === entry.taskId && other.position === position)) }); }
            else void act(queue.threadId, () => rpc.call("queueRemove", { taskId: entry.taskId, actor: "owner" }), { taskId: (queue.entries[index + 1] ?? queue.entries[index - 1])?.taskId ?? null, settled: (queues) => !queues.some((item) => item.entries.some((other) => other.taskId === entry.taskId)) });
          }}>{entry.key} · {entry.title} · {statuses.label(entry.status)}</DropdownMenuItem>
          <button type="button" tabIndex={-1} aria-label={`Remove ${entry.key} from the queue`} onClick={() => void act(queue.threadId, () => rpc.call("queueRemove", { taskId: entry.taskId, actor: "owner" }))}><Icon name="Trash2" className="size-3.5" /></button>
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
