import { useState } from "react";
import { QueueChip } from "../../components/queue-chip";
import { errorMessage } from "../../shared/errors";
import type { CardQueue } from "../../shared/contract";
import { useTasksRpc } from "../../shell/data";
import { Button } from "@/components/ui/button";
import { ThreadChooserDialog } from "./thread-chooser-dialog";

/** The card's place in an executor's work queue, with the doors to join or leave it. */
export function QueueBlock({ taskId, projectId, queue }: { taskId: string; projectId: string; queue?: CardQueue }) {
  const rpc = useTasksRpc();
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mb-2 grid gap-1 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        {queue ? <QueueChip queue={queue} /> : <span className="text-muted-foreground">Not in a work queue</span>}
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
