import { useState } from "react";
import { Button } from "@/components/ui/button";
import { formatRelativeTime } from "./activity/time.js";
import { useTasksQuery, useTasksRpc } from "../shell/data.js";
import { errorMessage } from "../shared/errors.js";
import { SettingsCard, SwitchRow } from "./settings-card.js";

type Key = "branch" | "script" | "args" | "intervalMinutes" | "timeoutSeconds";
const FIELDS: { key: Key; label: string; hint: string }[] = [
  { key: "branch", label: "Branch", hint: "For example main" },
  { key: "script", label: "Script", hint: "Repository-relative, for example checks/run.py" },
  { key: "args", label: "Arguments", hint: 'JSON array; {manager} becomes the manager thread, for example ["--root","{manager}"]' },
  { key: "intervalMinutes", label: "Interval (minutes)", hint: "1–1440" },
  { key: "timeoutSeconds", label: "Timeout (seconds)", hint: "1–300" },
];
const when = (ms: number | null) => (ms === null ? "–" : formatRelativeTime(new Date(ms).toISOString(), Date.now()));

/** Owner-only `enabled`: the platform cannot tell the app from an agent, so a change is only recorded and shown here. */
export function ChecksSettings({ projectId }: { projectId: string }) {
  const rpc = useTasksRpc();
  const query = useTasksQuery((client) => client.call("getChecksStatus", { projectId }), ["projects:changed", "settings:changed"], [projectId]);
  const [drafts, setDrafts] = useState<Partial<Record<Key, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = query.data;
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await action(); query.refresh(); } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  };
  const shown = (key: Key) => drafts[key] ?? stored(key);
  const stored = (key: Key) => (key === "args" ? JSON.stringify(status!.config.args) : String(status!.config[key] ?? ""));
  const changed = status ? FIELDS.map(({ key }) => key).filter((key) => drafts[key] !== undefined && drafts[key] !== stored(key)) : [];
  // One Save sends only the changed fields; the server validates them together and writes all or nothing.
  const save = () => run(async () => {
    const patch = Object.fromEntries(changed.map((key) => {
      const raw = shown(key).trim();
      return [key, key === "args" ? JSON.parse(raw) : key === "intervalMinutes" || key === "timeoutSeconds" ? Number(raw) : raw];
    }));
    await rpc.call("checks.configPatch", { projectId, patch });
    setDrafts({});
  });
  return (
    <SettingsCard title="Repository checks" description="Run the repository check script on a schedule and send its findings to the manager thread."
      actions={status ? <>
        {changed.length ? <Button size="sm" variant="ghost" className="h-7 px-2.5" disabled={busy} onClick={() => setDrafts({})}>Discard</Button> : null}
        <Button size="sm" className="h-7 px-2.5" disabled={busy || !changed.length} onClick={() => void save()}>Save</Button>
      </> : undefined}>
      <p className="text-xs text-muted-foreground">Runner paths: General → Repository-check runner.</p>
      {query.error && !status ? <p className="text-xs text-destructive">{query.error}</p> : null}
      {status ? (
        <>
          <div className="divide-y divide-border rounded-lg border border-border">
            <div className="space-y-2 px-4 py-3">
              <SwitchRow label="Run repository checks" checked={status.config.enabled}
                disabled={busy || (!status.config.enabled && (!status.bbProjectId || changed.length > 0))}
                onChange={(enabled) => void run(() => rpc.call("updateChecksEnabled", { projectId, enabled }))}
                hint="Off by default. Findings go to the manager thread chosen in Manager. Enabling follows an owner-only convention and is logged." />
              {!status.config.enabled && changed.length ? <p className="text-xs text-amber-600 dark:text-amber-400">Save or discard your changes first.</p> : null}
              <p className="text-xs text-muted-foreground">Runner owner: {status.runnerOwner}{status.unconfirmedSend ? ` · send to Sweep ${status.unconfirmedSend} is not confirmed` : ""}</p>
              {status.ownedByOtherTracker ? <p className="text-xs text-amber-600 dark:text-amber-400">Another project linked to this BB project owns the runner.</p> : null}
              {!status.bbProjectId ? <p className="text-xs text-muted-foreground">Link a BB project to enable.</p> : null}
            </div>
            {FIELDS.map(({ key, label, hint }) => (
              <div key={key} className="px-4 py-2">
                <label className="block min-w-0 text-xs"><span className="font-medium">{label}</span> <span className="text-muted-foreground">{hint}</span>
                  <input aria-label={label} className="mt-1 block h-8 w-full rounded-md border border-input bg-background px-2 text-sm sm:w-80" value={shown(key)} disabled={busy}
                    onChange={(event) => setDrafts((current) => ({ ...current, [key]: event.target.value }))} />
                </label>
              </div>
            ))}
            <div className="px-4 py-3">
              <SwitchRow label="Snapshots" checked={status.config.snapshots} disabled={busy}
                onChange={(snapshots) => void run(() => rpc.call("checks.configPatch", { projectId, patch: { snapshots } }))}
                hint={<>Pass <code>--committed-state</code> and <code>--candidate-snapshot</code> to the script.</>} />
            </div>
          </div>
          <div className="space-y-1 text-xs" data-testid="checks-status">
            <p>Last run {when(status.lastRun)} · next run {when(status.nextRun)} · exit {status.exitCode ?? "–"}{status.failureStage ? ` · ${status.failureStage} failure` : ""}</p>
            {status.error ? <p className="text-destructive">{status.error}</p> : null}
            {status.deliveryError && !status.blocked ? <p className="text-destructive">{status.deliveryError}</p> : null}
            {status.lastDelivery ? <p>Last report {when(status.lastDelivery.at)} to {status.lastDelivery.to} ({status.lastDelivery.receipt?.mode ?? "recorded"})</p> : null}
            {status.pending ? <p>Report waiting for delivery since {status.pending.stagedAt ? formatRelativeTime(status.pending.stagedAt, Date.now()) : "–"}.</p> : null}
            {status.managerError ? <p className="text-amber-600 dark:text-amber-400">Manager: {status.managerError}</p> : null}
            {status.pushError ? <p className="text-amber-600 dark:text-amber-400">Push: {status.pushError}</p> : null}
            {status.stateMismatch ? (
              <p className="flex flex-wrap items-center gap-2 text-amber-600 dark:text-amber-400" data-testid="checks-mismatch">{status.stateMismatch}
                <Button size="sm" className="h-7 px-2.5" variant="outline" disabled={busy || status.config.enabled || status.draining} onClick={() => void run(() => rpc.call("resetChecksState", { projectId }))}>Reset state</Button>
              </p>
            ) : null}
            {status.awaitingRetry ? (
              <p className="flex flex-wrap items-center gap-2" data-testid="checks-retry">{status.blocked}. Work Board cannot tell whether the report reached the manager / Agent Hub. Retry sends it to the manager and may duplicate it.
                <Button size="sm" className="h-7 px-2.5" variant="outline" disabled={busy} onClick={() => void run(() => rpc.call("retryChecksReport", { projectId }))}>Retry</Button>
              </p>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">The script path and Git URL come from the repository and the BB project settings.</p>
        </>
      ) : null}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </SettingsCard>
  );
}
