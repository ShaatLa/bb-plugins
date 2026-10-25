import { useState } from "react";
import type { Task } from "../shared/contract";
import { useTasksRpc } from "../shell/data";
import { Button } from "@/components/ui/button";
import { errorMessage } from "../shared/errors";

export function ArchiveTaskControl({
  task,
  onError,
}: {
  task: Task;
  onError: (message: string) => void;
}) {
  const rpc = useTasksRpc();
  const [busy, setBusy] = useState(false);
  if (!task.archivedAt && !["done", "canceled"].includes(task.status))
    return null;
  const change = async () => {
    setBusy(true);
    try {
      const result = await rpc.call("archiveTask", {
        taskId: task.id,
        archived: !task.archivedAt,
        authorName: "You",
      });
      if (!result.ok) throw new Error(result.error.message);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mb-3 flex items-center gap-3 text-xs text-muted-foreground">
      {task.archivedAt ? (
        <span>Archived · {task.archivedAt.slice(0, 10)}</span>
      ) : null}
      <Button
        size="sm"
        variant="ghost"
        className="h-7"
        disabled={busy}
        onClick={() => void change()}
      >
        {task.archivedAt ? "Restore task" : "Archive task"}
      </Button>
    </div>
  );
}
