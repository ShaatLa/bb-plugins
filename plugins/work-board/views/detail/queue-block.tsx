import { useState } from "react";
import { useThreadName } from "../../components/queue-chip";
import { useOpenThread } from "../../components/open-thread";
import { errorMessage } from "../../shared/errors";
import type { CardQueue } from "../../shared/contract";
import { useTasksQuery, useTasksRpc } from "../../shell/data";
import { Button } from "@/components/ui/button";
import { ThreadChooserDialog } from "./thread-chooser-dialog";

/** The card's place in an executor's work queue, with the doors to join or leave it. */
export function QueueBlock({ taskId, projectId, queue }: { taskId: string; projectId: string; queue?: CardQueue }) {
  const rpc = useTasksRpc();
  const queues = useTasksQuery(async (client) => (await client.call("queueList", { projectId })).queues, ["tasks:changed"], [projectId, queue?.threadId], { enabled: !!queue });
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="grid gap-1 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        {queue ? <QueuePlace queue={queue} total={queues.data?.find((item) => item.threadId === queue.threadId)?.entries.length} /> : <span className="text-muted-foreground">Not in a work queue</span>}
        {queue ? (
          <Button size="sm" variant="ghost" className="h-6 px-1 text-muted-foreground" disabled={busy} onClick={async () => {
            setBusy(true); setError(null);
            try { await rpc.call("queueRemove", { taskId, actor: "owner" }); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
          }}>Remove from queue</Button>
        ) : (
          <Button size="sm" variant="ghost" className="h-6 px-1 text-muted-foreground" onClick={() => setChoosing(true)}>Add to queue of …</Button>
        )}
      </div>
      {error ? <p role="alert" className="text-destructive">{error}</p> : null}
      {choosing ? <ThreadChooserDialog kind="queue" taskId={taskId} projectId={projectId} onClose={() => setChoosing(false)} /> : null}
    </div>
  );
}

function QueuePlace({ queue, total }: { queue: CardQueue; total?: number }) {
  const name = useThreadName(queue.threadId);
  const open = useOpenThread();
  const n = queue.position;
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return <span>{total === undefined ? "In the queue of " : `${n}${suffix} of ${total} in the queue of `}<button type="button" className="hover:underline" onClick={() => open(queue.threadId)}>{name}</button></span>;
}
