import { useState } from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { Task } from "../../shared/contract";
import { errorMessage } from "../../shared/errors";
import { useTasksRpc } from "../../shell/data";

export function CurrentState({ task }: { task: Task }) {
  const rpc = useTasksRpc();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await rpc.call("updateTask", { taskId: task.id, progressNote: draft || null });
      if (!result.ok) setError(result.error.message);
      else setEditing(false);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section aria-label="Current state" className="my-4 space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Current state</h3>
        {!editing && (
          <Button size="sm" variant="ghost" onClick={() => {
            setDraft(task.progressNote ?? "");
            setError(null);
            setEditing(true);
          }}>
            Edit
          </Button>
        )}
      </div>
      {editing ? (
        <>
          <Textarea
            aria-label="Current state note"
            value={draft}
            onChange={event => setDraft(event.target.value)}
            disabled={saving}
          />
          <div className="flex gap-2">
            <Button size="sm" disabled={saving} onClick={() => void save()}>Save</Button>
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </>
      ) : task.progressNote ? (
        <>
          <p className="text-xs text-muted-foreground">updated {task.progressUpdatedAt} by {task.progressUpdatedBy}</p>
          <Markdown content={task.progressNote} className="text-sm [overflow-wrap:anywhere]" />
        </>
      ) : (
        <p className="text-sm text-muted-foreground">No current state yet</p>
      )}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </section>
  );
}
