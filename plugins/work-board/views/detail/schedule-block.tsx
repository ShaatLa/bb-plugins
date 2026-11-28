import { useState, type ReactNode } from "react";
import { experimental_ProviderIcon as ProviderIcon, experimental_useProviders as useProviders } from "@get-bb/plugin-sdk/app";
import { useOpenThread } from "../../components/open-thread";
import { useThreadName } from "../../components/queue-chip";
import { BLANK_START, StartLaterForm, hasLaunch, isoOf, launchOf, localOf, type StartLaterValue } from "../../components/start-later-form";
import { joinArgs } from "../../schedule/when";
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
/** The row's tooltip: who set the start, then the first line of its brief. */
const tip = (who: string, brief?: string) => [`set by ${who}`, brief?.split("\n")[0]?.trim()].filter(Boolean).join(" · ");
function ThreadTip({ start, children }: { start: ScheduledStartInfo; children: (title: string) => ReactNode }) {
  return <>{children(tip(useThreadName(start.setter), start.brief))}</>;
}
const Tip = ({ start, children }: { start: ScheduledStartInfo; children: (title: string) => ReactNode }) => (start.setter === "owner" ? <>{children(tip("the owner", start.brief))}</> : <ThreadTip start={start}>{children}</ThreadTip>);

const valueOf = (start: ScheduledStartInfo): StartLaterValue => ({
  ...BLANK_START, at: localOf(start.at), args: start.builderArgs ? joinArgs(start.builderArgs) : "", brief: start.brief ?? "",
  ...(start.presetId && !start.agent ? { keepPreset: { id: start.presetId, name: start.presetName ?? start.presetId } } : {}),
  ...(start.agent ? { providerId: start.agent.providerId, model: start.agent.model, reasoningLevel: start.agent.reasoningLevel ?? "", permissionMode: start.agent.permissionMode ?? "auto", ...(start.agent.serviceTier ? { serviceTier: start.agent.serviceTier } : {}) } : {}),
});
/** The second line: the agent as its provider icon and `model · reasoning`; `Spawn Gate` where the gate chooses; `Preset <name>` for a legacy start. */
function agentLine(start: ScheduledStartInfo, providers: ReturnType<typeof useProviders>["providers"]) {
  if (start.mode === "spawn_gate") return "Spawn Gate";
  if (!start.agent) return `Preset ${start.presetName ?? start.presetId}`;
  const { providerId, model, reasoningLevel } = start.agent;
  return <>
    <ProviderIcon providerKind="agent" provider={providers.find((item) => item.id === providerId) ?? { id: providerId }} fallback="Bot" className="size-3.5 shrink-0" aria-hidden="true" />
    <span className="min-w-0 truncate">{[model, reasoningLevel].filter(Boolean).join(" · ")}</span>
  </>;
}

/**
 * The card's scheduled start as its own section, built like Sessions: the title with its icons on one line, then at most two lines
 * (the time, the agent) and, while editing, the form at full width. After a launch the body shows the session, or why the start did not happen.
 */
export function ScheduleBlock({ taskId, projectId, taskKey, start }: { taskId: string; projectId: string; taskKey: string; start?: CardScheduledStart }) {
  const rpc = useTasksRpc();
  const open = useOpenThread();
  const { providers } = useProviders();
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
    <section aria-label="Start" className="mb-2 rounded-md border border-border px-3 py-2 text-xs" data-schedule-block>
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">Start</span>
        <span className="ml-auto flex items-center gap-2">
          {current && active && current.state === "scheduled" && !editing ? (
            <>
              <IconButton label="Change scheduled start" icon="Edit" disabled={busy} onClick={() => { setValue(valueOf(current)); setEditing(true); }} />
              <IconButton label="Cancel scheduled start" icon="X" disabled={busy} onClick={() => void run(() => rpc.call("cancelScheduledStart", { taskId, actor: "owner" }))} />
            </>
          ) : null}
          {canAdd ? <IconButton label="Schedule a start" icon="Clock" onClick={() => { setValue(BLANK_START); setEditing(true); }} /> : null}
        </span>
      </div>
      <div className="min-w-0 py-1">
        {current && active ? (
          <Tip start={current}>{(title) => (
            <div title={title}>
              <div><span className="font-medium">{local(current.at)}</span>{current.state === "launching" ? " · launching now" : ""}</div>
              <div className="flex min-w-0 items-center gap-1 text-muted-foreground">{agentLine(current, providers)}</div>
              {current.policyError ? <div className="text-warning [overflow-wrap:anywhere]">Waiting to retry: {current.policyError}</div> : null}
            </div>
          )}</Tip>
        ) : current?.state === "launched" && current.threadId ? (
          <div className="[overflow-wrap:anywhere]">Launched <button type="button" className="hover:underline" title={current.threadId} onClick={() => open(current.threadId!)}><ThreadName id={current.threadId} /></button> at {local(current.at)}</div>
        ) : current && (current.state === "refused" || current.state === "unknown") ? (
          <>
            <div role="status" className="text-warning [overflow-wrap:anywhere]">{current.state === "refused" ? "Start refused" : "Start outcome unknown"}{current.reasonCode ? ` (${current.reasonCode})` : ""}: {current.error}</div>
            {current.state === "unknown" ? <div className="text-muted-foreground [overflow-wrap:anywhere]">Check the project's threads, then run <code>bb work-board schedule resolve {taskKey} --launched thr_… | --not-launched</code>.</div> : null}
          </>
        ) : <span className="text-muted-foreground">None</span>}
        {error ? <p role="alert" className="text-destructive [overflow-wrap:anywhere]">{error}</p> : null}
      </div>
      {editing ? (
        <div className="grid gap-2 pb-1 pt-1">
          <StartLaterForm projectId={projectId} taskId={taskId} value={value} onChange={setValue} onReady={setMode} disabled={busy} />
          <div className="flex gap-2">
            <Button size="sm" className="h-6 px-2 text-xs" disabled={!canSave} onClick={() => void save()}>{active ? "Save change" : "Schedule"}</Button>
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" disabled={busy} onClick={() => { setEditing(false); setError(null); }}>Cancel</Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
