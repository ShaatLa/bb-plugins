import { useState } from "react";
import { useOpenThread } from "../../components/open-thread";
import { useThreadName } from "../../components/queue-chip";
import { BLANK_START, StartLaterForm, hasLaunch, isoOf, launchOf, localOf, type StartLaterValue } from "../../components/start-later-form";
import { formatStartTime, joinArgs } from "../../schedule/when";
import type { CardScheduledStart, ScheduledStartInfo } from "../../shared/contract";
import { errorMessage } from "../../shared/errors";
import { useTasksQuery, useTasksRpc } from "../../shell/data";
import { Button } from "@/components/ui/button";
import { IconButton } from "./icon-button";

const local = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

/** A thread by its name, like the queue block shows one; the id stays in the tooltip. */
function ThreadName({ id }: { id: string }) {
  const name = useThreadName(id);
  return <span title={id}>{name}</span>;
}
const Setter = ({ setter }: { setter: string }) => (setter === "owner" ? <>the owner</> : <ThreadName id={setter} />);

const valueOf = (start: ScheduledStartInfo): StartLaterValue => ({
  ...BLANK_START, at: localOf(start.at), args: start.builderArgs ? joinArgs(start.builderArgs) : "", brief: start.brief ?? "",
  ...(start.presetId && !start.agent ? { keepPreset: { id: start.presetId, name: start.presetName ?? start.presetId } } : {}),
  ...(start.agent ? { providerId: start.agent.providerId, model: start.agent.model, reasoningLevel: start.agent.reasoningLevel ?? "", permissionMode: start.agent.permissionMode ?? "auto", ...(start.agent.serviceTier ? { serviceTier: start.agent.serviceTier } : {}) } : {}),
});
/** `Spawn Gate`, `provider · model · reasoning`, or the preset's name: the second half of the one-line summary. */
const modeText = (start: ScheduledStartInfo) => (start.mode === "spawn_gate" ? "Spawn Gate" : start.agent ? [start.agent.providerId, start.agent.model, start.agent.reasoningLevel].filter(Boolean).join(" · ") : `Preset ${start.presetName ?? start.presetId}`);
/** What the second line says before the setter: the builder's args, or the brief. */
const detailText = (start: ScheduledStartInfo) => (start.mode === "spawn_gate" ? (start.builderArgs ?? []).join(" ") : start.brief ?? "");

/**
 * The card's scheduled start as the "Start" row of the status card: two grid cells (the summary, the icons) and, while editing, the
 * form across the full width. After a launch the summary shows the session, or why the start did not happen.
 */
export function ScheduleBlock({ taskId, projectId, taskKey, start }: { taskId: string; projectId: string; taskKey: string; start?: CardScheduledStart }) {
  const rpc = useTasksRpc();
  const open = useOpenThread();
  const detail = useTasksQuery(async (client) => (await client.call("getScheduledStart", { taskId })).scheduledStart, ["tasks:changed"], [taskId, start?.state, start?.at], { relevantTaskIds: [taskId] });
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<StartLaterValue>(BLANK_START);
  const [mode, setMode] = useState<"spawn_gate" | "preset" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = detail.data ?? null;
  const active = current && (current.state === "scheduled" || current.state === "launching");
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await action(); detail.refresh(); return true; } catch (cause) { setError(errorMessage(cause)); return false; } finally { setBusy(false); }
  };
  const iso = isoOf(value.at);
  const canSave = !busy && mode !== null && iso !== null && hasLaunch(value, mode);
  // One request that validates and stores; the server refuses a start the builder rejects, so nothing is saved until it passes.
  const save = async () => {
    // An args field left as it was keeps the stored array byte for byte; only an edited one is parsed again.
    const launch = mode === "spawn_gate" && current?.builderArgs && value.args === joinArgs(current.builderArgs) ? { kind: "gate" as const, args: current.builderArgs } : launchOf(value, mode!);
    if (await run(() => (current && active ? rpc.call("changeScheduledStart", { taskId, at: iso!, launch, actor: "owner" }) : rpc.call("scheduleStart", { taskId, at: iso!, launch, actor: "owner" })))) setEditing(false);
  };
  const canAdd = !editing && !active && current?.state !== "unknown";
  return (
    <>
      <div className="min-w-0 py-1" data-schedule-block>
        {current && active ? (
          <>
            <div><span className="font-medium" title={formatStartTime(current.at)}>{local(current.at)}</span>{current.state === "launching" ? " · launching now" : ""} · {modeText(current)}</div>
            <div className="text-muted-foreground [overflow-wrap:anywhere]">{detailText(current) ? `${detailText(current)} · ` : ""}set by <Setter setter={current.setter} /></div>
            {current.policyError ? <div className="text-warning">Waiting to retry: {current.policyError}</div> : null}
          </>
        ) : current?.state === "launched" && current.threadId ? (
          <div>Launched <button type="button" className="hover:underline" title={current.threadId} onClick={() => open(current.threadId!)}><ThreadName id={current.threadId} /></button> at {local(current.at)}</div>
        ) : current && (current.state === "refused" || current.state === "unknown") ? (
          <>
            <div role="status" className="text-warning [overflow-wrap:anywhere]">{current.state === "refused" ? "Start refused" : "Start outcome unknown"}{current.reasonCode ? ` (${current.reasonCode})` : ""}: {current.error}</div>
            {current.state === "unknown" ? <div className="text-muted-foreground">Check the project's threads, then run <code>bb work-board schedule resolve {taskKey} --launched thr_… | --not-launched</code>.</div> : null}
          </>
        ) : <span className="text-muted-foreground">None</span>}
        {error ? <p role="alert" className="text-destructive">{error}</p> : null}
      </div>
      <div className="flex items-start gap-1">
        {current && active && current.state === "scheduled" && !editing ? (
          <>
            <IconButton label="Change scheduled start" icon="Edit" disabled={busy} onClick={() => { setValue(valueOf(current)); setEditing(true); }} />
            <IconButton label="Cancel scheduled start" icon="X" disabled={busy} onClick={() => void run(() => rpc.call("cancelScheduledStart", { taskId, actor: "owner" }))} />
          </>
        ) : null}
        {canAdd ? <IconButton label="Schedule a start" icon="Clock" onClick={() => { setValue(BLANK_START); setEditing(true); }} /> : null}
      </div>
      {editing ? (
        <div className="col-span-full grid gap-2 pb-1 pt-1">
          <StartLaterForm projectId={projectId} taskId={taskId} value={value} onChange={setValue} onReady={setMode} disabled={busy} />
          <div className="flex gap-2">
            <Button size="sm" className="h-6 px-2 text-xs" disabled={!canSave} onClick={() => void save()}>{active ? "Save change" : "Schedule"}</Button>
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" disabled={busy} onClick={() => { setEditing(false); setError(null); }}>Cancel</Button>
          </div>
        </div>
      ) : null}
    </>
  );
}
