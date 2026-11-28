import { useEffect, useState } from "react";
import { experimental_ProviderModelPicker as ProviderModelPicker } from "@get-bb/plugin-sdk/app";
import { PRESET_PERMISSION_MODES, type PresetPermissionMode, type tasksRpcContract } from "../shared/contract";
import { errorMessage } from "../shared/errors";
import { splitArgs } from "../schedule/when";
import { useTasksQuery, useTasksRpc } from "../shell/data";
import { Button } from "@/components/ui/button";

/** What the "Start later" form holds: the time as a local `datetime-local` text, and what launches (Spawn Gate arguments, or the agent Work Board spawns). */
export interface StartLaterValue { at: string; args: string; brief: string; providerId: string; model: string; reasoningLevel: string; serviceTier?: string; permissionMode: PresetPermissionMode;
  /** A stored preset start being changed: kept as it is until an agent is chosen instead. */ keepPreset?: { id: string; name: string } | undefined }
export const BLANK_START: StartLaterValue = { at: "", args: "", brief: "", providerId: "", model: "", reasoningLevel: "medium", permissionMode: "auto" };
export type StartLaunch = { kind: "gate"; args?: string[] } | { kind: "preset"; presetId: string; brief?: string } | { kind: "agent"; providerId: string; model: string; reasoningLevel?: string; serviceTier?: string; permissionMode: PresetPermissionMode; brief?: string };
const PERMISSION_LABELS: Record<PresetPermissionMode, string> = { "accept-edits": "Accept Edits", auto: "Approve for me", full: "Full Access" };
/** Whether the form holds what its mode needs besides the time. */
export const hasLaunch = (value: StartLaterValue, mode: "spawn_gate" | "preset") => mode === "spawn_gate" || value.keepPreset !== undefined || (value.providerId !== "" && value.model !== "");
type Options = typeof tasksRpcContract.scheduleOptions.output._output;

/** The RPC input for a form value in a project of `mode`; `{key}` stays in the gate args for the server to fill. */
export function launchOf(value: StartLaterValue, mode: "spawn_gate" | "preset"): StartLaunch {
  if (mode === "spawn_gate") { const args = splitArgs(value.args); return args.length ? { kind: "gate", args } : { kind: "gate" }; }
  if (value.keepPreset) return { kind: "preset", presetId: value.keepPreset.id, ...(value.brief.trim() ? { brief: value.brief } : {}) };
  return {
    kind: "agent", providerId: value.providerId, model: value.model, permissionMode: value.permissionMode,
    ...(value.reasoningLevel ? { reasoningLevel: value.reasoningLevel } : {}), ...(value.serviceTier ? { serviceTier: value.serviceTier } : {}), ...(value.brief.trim() ? { brief: value.brief } : {}),
  };
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

/** Every field fills the card and may shrink below its content, so nothing runs past the side panel's edge. */
const FIELD = "h-7 w-full min-w-0 rounded-md border border-input bg-transparent px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50";

/**
 * The one "Start later" form of the new-task dialog and the task page: one field per line, no hint texts. It asks only what the
 * project's launch needs: a time, then either the Spawn Gate builder's arguments (with a Check that runs its dry run), or, where
 * Work Board spawns the session itself, a provider, model and options from the host's picker, the permissions and an optional brief.
 * A policy that cannot be read disables it: nothing is scheduled on a guess. `taskId` is unset before the card exists, so there is nothing to check yet.
 */
export function StartLaterForm({ projectId, taskId, value, onChange, onReady, disabled }: { projectId: string; taskId?: string; value: StartLaterValue; onChange: (value: StartLaterValue) => void; onReady?: (mode: "spawn_gate" | "preset" | null) => void; disabled?: boolean }) {
  const rpc = useTasksRpc();
  const options = useTasksQuery<Options>(async (client) => client.call("scheduleOptions", { projectId }), ["projects:changed"], [projectId]);
  const [check, setCheck] = useState<{ ok: boolean; text: string } | null>(null);
  const [checking, setChecking] = useState(false);
  // The brief stays behind "+ Brief" unless the start already has one.
  const [briefOpen, setBriefOpen] = useState(value.brief !== "");
  const mode = options.data?.mode ?? null;
  const set = (patch: Partial<StartLaterValue>) => { setCheck(null); onChange({ ...value, ...patch }); };
  // Reported once the policy is read (null when it could not be); the owner keeps the last answer while a form reloads, so Save does not flicker.
  useEffect(() => { if (options.data) onReady?.(mode); }, [options.data, mode]);
  if (options.isLoading || !options.data) return <p className="text-xs text-muted-foreground">{options.error ? `Could not read how this project launches sessions: ${options.error}` : "Reading the project's launch settings…"}</p>;
  return (
    <div className="grid w-full min-w-0 gap-2 text-xs" data-start-later>
      <input type="datetime-local" aria-label="Start time" className={FIELD} value={value.at} disabled={disabled} onChange={(event) => set({ at: event.target.value })} />
      {mode === null ? <p role="alert" className="text-destructive [overflow-wrap:anywhere]">{options.data.error ?? "Could not read the launch policy"}. Nothing can be scheduled until it can be read.</p> : null}
      {mode === "spawn_gate" ? (
        <input aria-label="Launch arguments" title="{key} is the card key" className={`${FIELD} font-mono`} value={value.args} placeholder={options.data.defaultArgs} disabled={disabled} onChange={(event) => set({ args: event.target.value })} />
      ) : null}
      {mode === "preset" ? (
        <>
          {value.keepPreset ? (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-muted-foreground [overflow-wrap:anywhere]">Preset {value.keepPreset.name}, kept</span>
              <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-xs" disabled={disabled} onClick={() => set({ keepPreset: undefined })}>Use an agent instead</Button>
            </div>
          ) : (<>
            <ProviderModelPicker
              value={{ providerId: value.providerId, model: value.model, reasoningLevel: value.reasoningLevel, ...(value.serviceTier ? { serviceTier: value.serviceTier } : {}) }}
              onChange={(picked) => set({ providerId: picked.providerId, model: picked.model, reasoningLevel: picked.reasoningLevel, ...(picked.serviceTier ? { serviceTier: picked.serviceTier } : { serviceTier: "" }) })}
              disabled={disabled} className="h-7 w-full min-w-0 max-w-full" />
            <select aria-label="Permission mode" className={FIELD} value={value.permissionMode} disabled={disabled} onChange={(event) => set({ permissionMode: event.target.value as PresetPermissionMode })}>
              {PRESET_PERMISSION_MODES.map((mode) => <option key={mode} value={mode}>{PERMISSION_LABELS[mode]}</option>)}
            </select>
          </>)}
          {briefOpen ? (
            <textarea aria-label="Brief" className="min-h-14 w-full min-w-0 rounded-md border border-input bg-transparent px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring" value={value.brief} disabled={disabled} onChange={(event) => set({ brief: event.target.value })} />
          ) : (
            <Button type="button" size="sm" variant="ghost" className="h-6 justify-start px-1 text-xs text-muted-foreground" disabled={disabled} onClick={() => setBriefOpen(true)}>+ Brief</Button>
          )}
        </>
      ) : null}
      {mode === "spawn_gate" && taskId ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="outline" className="h-6 px-2 text-xs" disabled={disabled || checking} onClick={async () => {
            setChecking(true);
            try { const result = await rpc.call("checkScheduledStart", { taskId, launch: launchOf(value, "spawn_gate"), actor: "owner" }); setCheck({ ok: result.ok, text: result.ok ? "The builder accepts these arguments." : `${result.reasonCode ? `${result.reasonCode}: ` : ""}${result.error ?? "refused"}` }); } catch (cause) { setCheck({ ok: false, text: errorMessage(cause) }); } finally { setChecking(false); }
          }}>Check</Button>
          {check ? <span role={check.ok ? "status" : "alert"} className={`min-w-0 [overflow-wrap:anywhere] ${check.ok ? "text-muted-foreground" : "text-destructive"}`}>{check.text}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
