import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { errorMessage } from "../shared/errors.js";
import { useOrderClock, useTasksQuery, useTasksRpc } from "../shell/data.js";
import { ThreadChooserDialog } from "../views/detail/thread-chooser-dialog.js";
import { ManagerChangeDialog } from "./manager-change-dialog.js";
import { useThreadNames } from "./thread-names.js";

const UNLINKED = "Link this project to a BB project to choose a manager thread.";

/** The project's manager next to its name: one click to set it, with the Manager card's confirmation and write safeguards. */
/** Sits right after the project name; `className` sets its gap from the name (four times the header's own gap). */
export function ManagerQuickSet({ projectId, className }: { projectId: string; className?: string }) {
  const rpc = useTasksRpc();
  const stamp = useOrderClock();
  const query = useTasksQuery((client) => { const readAt = stamp(); return client.call("getAttentionSettings", { projectId }).then((data) => ({ ...data, readAt })); }, ["projects:changed", "settings:changed"], [projectId]);
  // The manager the last write stored; it wins over every read that started before that write, including a failed one.
  const [ack, setAck] = useState<{ manager: string | null; at: number }>();
  const [choosing, setChoosing] = useState(false);
  const [confirming, setConfirming] = useState<{ id: string; title: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settings = query.data;
  const current = (ack && ack.at > (settings?.readAt ?? 0) ? ack.manager : settings?.manager) ?? "";
  const names = useThreadNames(current ? [current] : []);
  if (!settings) return null;
  const linked = settings.linkedBbProjectId;
  const name = current ? names.get(current) ?? current : "";

  // Locked until the refreshed settings land, so a second pick sees the manager just set.
  const save = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.call("updateAttentionManager", { projectId, manager: id || null });
      setAck({ manager: result.manager, at: stamp() });
      await query.refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  // Picking is the commit gesture; picking the current manager again does nothing.
  const pick = (id: string, title: string) => {
    if (id === current) return;
    if (current) setConfirming({ id, title });
    else void save(id);
  };
  return (
    <>
      {/* Shrinks with a truncated name rather than being clipped when the header is narrow, and much faster than the
          project name beside it, so the project name stays readable. The class stays a plain string literal: Tailwind does
          not pick up a class that a template placeholder follows. */}
      <span className={cn("flex min-w-0 shrink-[20]", className)} title={linked ? name || undefined : UNLINKED}>
        <Button type="button" size="sm" variant="ghost" className="h-6 min-w-0 max-w-56 gap-1 px-1.5 text-xs font-normal text-muted-foreground"
          disabled={busy || !linked} aria-label={current ? `Manager: ${name}` : "Set manager"} onClick={() => setChoosing(true)}>
          <span className="truncate">{current ? `Manager: ${name}` : "Set manager"}</span>
          <Icon name="ChevronDown" className="size-3 shrink-0 opacity-50" />
        </Button>
      </span>
      {error ? <span role="alert" className="truncate text-xs text-destructive" title={error}>Manager not saved: {error}</span> : null}
      {choosing && linked ? <ThreadChooserDialog kind="manager" bbProjectId={linked} current={current} onPick={pick} onClose={() => setChoosing(false)} /> : null}
      <ManagerChangeDialog change={confirming} from={name} onCancel={() => setConfirming(null)} onConfirm={(id) => { setConfirming(null); void save(id); }} />
    </>
  );
}
