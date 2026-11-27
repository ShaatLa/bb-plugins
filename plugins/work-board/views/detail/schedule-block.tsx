import { useState } from "react";
import { useOpenThread } from "../../components/open-thread";
import { BLANK_START, StartLaterForm, isoOf, launchOf, localOf, type StartLaterValue } from "../../components/start-later-form";
import { formatStartTime, joinArgs } from "../../schedule/when";
import type { CardScheduledStart, ScheduledStartInfo } from "../../shared/contract";
import { errorMessage } from "../../shared/errors";
import { useTasksQuery, useTasksRpc } from "../../shell/data";
import { Button } from "@/components/ui/button";

const local = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

const valueOf = (start: ScheduledStartInfo): StartLaterValue => ({ at: localOf(start.at), args: start.builderArgs ? joinArgs(start.builderArgs) : "", presetId: start.presetId ?? "", brief: start.brief ?? "" });

/** The card's scheduled start with its Change and Cancel; after a launch it shows the session, or why the start did not happen. */
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
  const canSave = !busy && mode !== null && iso !== null && (mode === "spawn_gate" || value.presetId !== "");
  // One request that validates and stores; the server refuses a start the builder rejects, so nothing is saved until it passes.
  const save = async () => {
    // An args field left as it was keeps the stored array byte for byte; only an edited one is parsed again.
    const launch = mode === "spawn_gate" && current?.builderArgs && value.args === joinArgs(current.builderArgs) ? { kind: "gate" as const, args: current.builderArgs } : launchOf(value, mode!);
    if (await run(() => (current && active ? rpc.call("changeScheduledStart", { taskId, at: iso!, launch, actor: "owner" }) : rpc.call("scheduleStart", { taskId, at: iso!, launch, actor: "owner" })))) setEditing(false);
  };
  return (
    <div className="grid gap-1 text-xs" data-schedule-block>
      {editing ? (
        <div className="grid gap-2">
          <StartLaterForm projectId={projectId} taskId={taskId} value={value} onChange={setValue} onReady={setMode} disabled={busy} />
          <div className="flex gap-2">
            <Button size="sm" className="h-6 px-2 text-xs" disabled={!canSave} onClick={() => void save()}>{active ? "Save change" : "Schedule"}</Button>
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" disabled={busy} onClick={() => { setEditing(false); setError(null); }}>Cancel</Button>
          </div>
        </div>
      ) : current && active ? (
        <>
          <div>Scheduled for <span className="font-medium" title={formatStartTime(current.at)}>{local(current.at)}</span>{current.state === "launching" ? " · launching now" : ""}</div>
          <div className="text-muted-foreground [overflow-wrap:anywhere]">{current.mode === "spawn_gate" ? `Spawn Gate: ${(current.builderArgs ?? []).join(" ")}` : `Preset ${current.presetName ?? current.presetId}`} · set by {current.setter}</div>
          {current.policyError ? <div className="text-warning">Waiting to retry: {current.policyError}</div> : null}
          {current.state === "scheduled" ? (
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" className="h-6 px-1 text-muted-foreground" disabled={busy} onClick={() => { setValue(valueOf(current)); setEditing(true); }}>Change</Button>
              <Button size="sm" variant="ghost" className="h-6 px-1 text-muted-foreground" disabled={busy} onClick={() => void run(() => rpc.call("cancelScheduledStart", { taskId, actor: "owner" }))}>Cancel</Button>
            </div>
          ) : null}
        </>
      ) : current?.state === "launched" && current.threadId ? (
        <div>Launched <button type="button" className="hover:underline" onClick={() => open(current.threadId!)}>{current.threadId}</button> at {local(current.at)}</div>
      ) : current && (current.state === "refused" || current.state === "unknown") ? (
        <>
          <div role="status" className="text-warning [overflow-wrap:anywhere]">{current.state === "refused" ? "Start refused" : "Start outcome unknown"}{current.reasonCode ? ` (${current.reasonCode})` : ""}: {current.error}</div>
          {current.state === "unknown" ? <div className="text-muted-foreground">Check the project's threads, then run <code>bb work-board schedule resolve {taskKey} --launched thr_… | --not-launched</code>.</div> : null}
        </>
      ) : null}
      {!editing && !active && current?.state !== "unknown" ? <div><Button size="sm" variant="ghost" className="h-6 px-1 text-muted-foreground" onClick={() => { setValue(BLANK_START); setEditing(true); }}>{current ? "Schedule another start…" : "Schedule a start…"}</Button></div> : null}
      {error ? <p role="alert" className="text-destructive">{error}</p> : null}
    </div>
  );
}
