import { useRef, useState } from "react";
import { errorMessage } from "../shared/errors";
import { useTasksQuery, useTasksRpc } from "../shell/data";
import { useTasksNavigation } from "../shell/routes";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The executor thread's work queue above its board: the cards in order, the first one current. A card is dragged to a new
 * place or removed; the owner may do both for any queue, so the calls are made as the owner.
 */
export function QueuePanel({ threadId }: { threadId: string }) {
  const rpc = useTasksRpc();
  const navigation = useTasksNavigation();
  const queues = useTasksQuery(async (query) => (await query.call("queueList", { threadId })).queues, ["tasks:changed"], [threadId]);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  // A card moves only inside its own project's queue: positions of two projects are independent.
  const dragged = useRef<{ taskId: string; projectId: string } | null>(null);
  const list = (queues.data ?? []).filter((queue) => queue.entries.length);
  if (!list.length && !error) return null;
  const act = async (call: () => Promise<unknown>) => {
    setError(null);
    try { await call(); queues.refresh(); } catch (cause) { setError(errorMessage(cause)); }
  };
  return (
    <section aria-label="Work queue" className="shrink-0 border-b border-border px-3 py-2 text-xs">
      <div className="mb-1 font-medium text-muted-foreground">Queue</div>
      {error ? <p role="alert" className="mb-1 text-destructive">{error}</p> : null}
      {list.map((queue) => (
      <ol key={queue.projectId} aria-label={list.length > 1 ? `${queue.entries[0]!.key.split("-")[0]} queue` : undefined} className="mb-1 space-y-1">
        {queue.entries.map((entry) => (
          <li
            key={entry.taskId}
            draggable
            aria-label={`${entry.key}, ${entry.position === 1 ? "current" : `queued number ${entry.position}`}`}
            className={cn("flex items-center gap-2 rounded-md border border-border px-2 py-1", over === entry.taskId && "bg-muted")}
            onDragStart={(event) => { dragged.current = { taskId: entry.taskId, projectId: queue.projectId }; event.dataTransfer.effectAllowed = "move"; }}
            onDragOver={(event) => { if (dragged.current && dragged.current.projectId === queue.projectId && dragged.current.taskId !== entry.taskId) { event.preventDefault(); setOver(entry.taskId); } }}
            onDragLeave={() => setOver((current) => (current === entry.taskId ? null : current))}
            onDragEnd={() => { dragged.current = null; setOver(null); }}
            onDrop={(event) => {
              event.preventDefault();
              const source = dragged.current;
              dragged.current = null;
              setOver(null);
              const taskId = source?.projectId === queue.projectId ? source.taskId : null;
              if (taskId && taskId !== entry.taskId) void act(() => rpc.call("queueMove", { taskId, position: entry.position, actor: "owner" }));
            }}
          >
            <span className="w-14 shrink-0 text-muted-foreground tabular-nums">{entry.position === 1 ? "Current" : `#${entry.position}`}</span>
            <button type="button" className="min-w-0 flex-1 truncate text-left hover:underline" onClick={() => navigation.go({ kind: "task", taskKey: entry.key })}>{entry.key} · {entry.title}</button>
            <span className="shrink-0 text-muted-foreground">{entry.status}</span>
            <Button size="sm" variant="ghost" className="h-6 px-1" aria-label={`Remove ${entry.key} from the queue`} onClick={() => void act(() => rpc.call("queueRemove", { taskId: entry.taskId, actor: "owner" }))}>Remove</Button>
          </li>
        ))}
      </ol>
      ))}
    </section>
  );
}
