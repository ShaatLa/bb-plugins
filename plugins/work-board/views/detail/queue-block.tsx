import { useState } from "react";
import { useThreadName } from "../../components/queue-chip";
import { useOpenThread } from "../../components/open-thread";
import { errorMessage } from "../../shared/errors";
import type { CardQueue } from "../../shared/contract";
import { useTasksQuery, useTasksRpc } from "../../shell/data";
import { IconButton } from "./icon-button";
import { ThreadChooserDialog } from "./thread-chooser-dialog";

/** The card's place in an executor's work queue as its own section, built like Sessions: the title and the icon to join or leave on one line, the place below. */
export function QueueBlock({ taskId, projectId, queue }: { taskId: string; projectId: string; queue?: CardQueue }) {
  const rpc = useTasksRpc();
  const queues = useTasksQuery(async (client) => (await client.call("queueList", { projectId })).queues, ["tasks:changed"], [projectId, queue?.threadId], { enabled: !!queue });
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <section aria-label="Queue" className="mb-2 rounded-md border border-border px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">Queue</span>
        <span className="ml-auto flex items-center gap-2">
          {queue ? (
            <IconButton label="Remove from queue" icon="Trash2" disabled={busy} onClick={async () => {
              setBusy(true); setError(null);
              try { await rpc.call("queueRemove", { taskId, actor: "owner" }); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
            }} />
          ) : <IconButton label="Add to queue" icon="Plus" onClick={() => setChoosing(true)} />}
        </span>
      </div>
      <div className="min-w-0 py-1">
        {queue ? <QueuePlace queue={queue} total={queues.data?.find((item) => item.threadId === queue.threadId)?.entries.length} /> : <span className="text-muted-foreground">None</span>}
        {error ? <p role="alert" className="text-destructive">{error}</p> : null}
      </div>
      {choosing ? <ThreadChooserDialog kind="queue" taskId={taskId} projectId={projectId} onClose={() => setChoosing(false)} /> : null}
    </section>
  );
}

/** One line, cut with an ellipsis; the whole text is in the tooltip. */
function QueuePlace({ queue, total }: { queue: CardQueue; total?: number }) {
  const name = useThreadName(queue.threadId);
  const open = useOpenThread();
  const place = total === undefined ? `#${queue.position}` : `${queue.position} of ${total}`;
  return <div className="flex min-w-0 items-baseline" title={`${place} · ${name}`}><span className="shrink-0 whitespace-pre">{`${place} · `}</span><button type="button" className="min-w-0 truncate text-left hover:underline" onClick={() => open(queue.threadId)}>{name}</button></div>;
}
