import { useEffect, useState } from "react";
import type { tasksRpcContract } from "../shared/contract";
import { errorMessage } from "../shared/errors";
import { splitArgs } from "../schedule/when";
import { useTasksQuery, useTasksRpc } from "../shell/data";
import { Button } from "@/components/ui/button";

/** What the "Start later" form holds: the time as a local `datetime-local` text, and what launches. */
export interface StartLaterValue { at: string; args: string; presetId: string; brief: string }
export const BLANK_START: StartLaterValue = { at: "", args: "", presetId: "", brief: "" };
export type StartLaunch = { kind: "gate"; args?: string[] } | { kind: "preset"; presetId: string; brief?: string };
type Options = typeof tasksRpcContract.scheduleOptions.output._output;

/** The RPC input for a form value in a project of `mode`; `{key}` stays in the gate args for the server to fill. */
export function launchOf(value: StartLaterValue, mode: "spawn_gate" | "preset"): StartLaunch {
  if (mode === "spawn_gate") { const args = splitArgs(value.args); return args.length ? { kind: "gate", args } : { kind: "gate" }; }
  return { kind: "preset", presetId: value.presetId, ...(value.brief.trim() ? { brief: value.brief } : {}) };
}
/** The time as an ISO string with the zone applied, or null while the field is empty or unreadable. */
export function isoOf(local: string): string | null {
  const ms = local ? new Date(local).getTime() : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
/** `datetime-local` text for an ISO time, in the viewer's zone. */
export function localOf(iso: string): string {
  const date = new Date(iso), pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const FIELD = "h-7 rounded-md border border-input bg-transparent px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50";

/**
 * The one "Start later" form of the new-task dialog and the task page. It asks only what the project's launch needs: a time, then
 * either the Spawn Gate builder's arguments (with a Check that runs its dry run) or a preset with an optional brief. A policy that
 * cannot be read disables it: nothing is scheduled on a guess. `taskId` is unset before the card exists, so there is nothing to check yet.
 */
export function StartLaterForm({ projectId, taskId, value, onChange, onReady, disabled }: { projectId: string; taskId?: string; value: StartLaterValue; onChange: (value: StartLaterValue) => void; onReady?: (mode: "spawn_gate" | "preset" | null) => void; disabled?: boolean }) {
  const rpc = useTasksRpc();
  const options = useTasksQuery<Options>(async (client) => client.call("scheduleOptions", { projectId }), ["projects:changed"], [projectId]);
  const [check, setCheck] = useState<{ ok: boolean; text: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const mode = options.data?.mode ?? null;
  const set = (patch: Partial<StartLaterValue>) => { setCheck(null); onChange({ ...value, ...patch }); };
  // Reported once the policy is read (null when it could not be); the owner keeps the last answer while a form reloads, so Save does not flicker.
  useEffect(() => { if (options.data) onReady?.(mode); }, [options.data, mode]);
  if (options.isLoading || !options.data) return <p className="text-xs text-muted-foreground">{options.error ? `Could not read how this project launches sessions: ${options.error}` : "Reading the project's launch settings…"}</p>;
  return (
    <div className="grid gap-2 text-xs" data-start-later>
      <label className="flex items-center gap-2"><span className="w-16 shrink-0 text-muted-foreground">Start at</span>
        <input type="datetime-local" aria-label="Start time" className={FIELD} value={value.at} disabled={disabled} onChange={(event) => set({ at: event.target.value })} />
        <span className="text-muted-foreground">your time zone</span>
      </label>
      {mode === null ? <p role="alert" className="text-destructive">{options.data.error ?? "Could not read the launch policy"}. Nothing can be scheduled until it can be read.</p> : null}
      {mode === "spawn_gate" ? (
        <label className="grid gap-1"><span className="text-muted-foreground">Launch arguments (the project's Spawn Gate builder; {"{key}"} is the card key)</span>
          <input aria-label="Launch arguments" className={`${FIELD} font-mono`} value={value.args} placeholder={options.data.defaultArgs} disabled={disabled} onChange={(event) => set({ args: event.target.value })} />
        </label>
      ) : null}
      {mode === "preset" ? (
        <>
          <label className="flex items-center gap-2"><span className="w-16 shrink-0 text-muted-foreground">Preset</span>
            <select aria-label="Preset" className={FIELD} value={value.presetId} disabled={disabled} onChange={(event) => set({ presetId: event.target.value })}>
              <option value="">Choose a preset…</option>
              {options.data.presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
            </select>
          </label>
          <label className="grid gap-1"><span className="text-muted-foreground">Brief for the session (optional)</span>
            <textarea aria-label="Brief" className="min-h-14 rounded-md border border-input bg-transparent px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring" value={value.brief} disabled={disabled} onChange={(event) => set({ brief: event.target.value })} />
          </label>
        </>
      ) : null}
      {mode === "spawn_gate" && taskId ? (
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="outline" className="h-6 px-2 text-xs" disabled={disabled || checking} onClick={async () => {
            setChecking(true);
            try { const result = await rpc.call("checkScheduledStart", { taskId, launch: launchOf(value, "spawn_gate"), actor: "owner" }); setCheck({ ok: result.ok, text: result.ok ? "The builder accepts these arguments." : `${result.reasonCode ? `${result.reasonCode}: ` : ""}${result.error ?? "refused"}` }); } catch (cause) { setCheck({ ok: false, text: errorMessage(cause) }); } finally { setChecking(false); }
          }}>Check</Button>
          {check ? <span role={check.ok ? "status" : "alert"} className={check.ok ? "text-muted-foreground" : "text-destructive"}>{check.text}</span> : null}
        </div>
      ) : null}
      {mode === "spawn_gate" && !taskId ? <p className="text-muted-foreground">The builder checks these arguments when the card is created.</p> : null}
      <p className="text-muted-foreground">Nothing is sent to the session before it starts.</p>
    </div>
  );
}
