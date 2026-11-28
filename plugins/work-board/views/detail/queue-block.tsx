import { useState } from "react";
import { useThreadName } from "../../components/queue-chip";
import { useOpenThread } from "../../components/open-thread";
import { errorMessage } from "../../shared/errors";
import type { CardQueue } from "../../shared/contract";
import { useTasksQuery, useTasksRpc } from "../../shell/data";
import { IconButton } from "./icon-button";
import { ThreadChooserDialog } from "./thread-chooser-dialog";

/** The card's place in an executor's work queue as the "Queue" row of the status card: two grid cells, the place and the icon to join or leave. */
export function QueueBlock({ taskId, projectId, queue }: { taskId: string; projectId: string; queue?: CardQueue }) {
  const rpc = useTasksRpc();
  const queues = useTasksQuery(async (client) => (await client.call("queueList", { projectId })).queues, ["tasks:changed"], [projectId, queue?.threadId], { enabled: !!queue });
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <div className="min-w-0 py-1">
        {queue ? <QueuePlace queue={queue} total={queues.data?.find((item) => item.threadId === queue.threadId)?.entries.length} /> : <span className="text-muted-foreground">None</span>}
        {error ? <p role="alert" className="text-destructive">{error}</p> : null}
      </div>
      <div className="flex items-start">
        {queue ? (
          <IconButton label="Remove from queue" icon="Trash2" disabled={busy} onClick={async () => {
            setBusy(true); setError(null);
            try { await rpc.call("queueRemove", { taskId, actor: "owner" }); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
          }} />
        ) : <IconButton label="Add to queue" icon="Plus" onClick={() => setChoosing(true)} />}
        {choosing ? <ThreadChooserDialog kind="queue" taskId={taskId} projectId={projectId} onClose={() => setChoosing(false)} /> : null}
      </div>
    </>
  );
}

function QueuePlace({ queue, total }: { queue: CardQueue; total?: number }) {
  const name = useThreadName(queue.threadId);
  const open = useOpenThread();
  // The section is titled Queue already, so the place stays short and a long session name wraps instead of being cut.
  return <span className="min-w-0 [overflow-wrap:anywhere]">{total === undefined ? `#${queue.position}` : `${queue.position} of ${total}`} · <button type="button" className="max-w-full text-left hover:underline" onClick={() => open(queue.threadId)}>{name}</button></span>;
}
