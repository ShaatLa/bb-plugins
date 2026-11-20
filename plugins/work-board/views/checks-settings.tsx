import { useState } from "react";
import { Button } from "@/components/ui/button";
import { formatRelativeTime } from "./activity/time.js";
import { useTasksQuery, useTasksRpc } from "../shell/data.js";
import { errorMessage } from "../shared/errors.js";

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
  const query = useTasksQuery((client) => client.call("getChecksStatus", { projectId }), ["projects:changed"], [projectId]);
  const [drafts, setDrafts] = useState<Partial<Record<Key, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = query.data;
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await action(); query.refresh(); } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  };
  const shown = (key: Key) => drafts[key] ?? (key === "args" ? JSON.stringify(status!.config.args) : String(status!.config[key] ?? ""));
  const save = (key: Key) => run(async () => {
    const raw = shown(key).trim();
    const value = key === "args" ? JSON.parse(raw) : key === "intervalMinutes" || key === "timeoutSeconds" ? Number(raw) : raw;
    await rpc.call("updateChecksSetting", { projectId, key, value });
    setDrafts(({ [key]: _saved, ...rest }) => rest);
  });
  return (
    <section aria-label="Repository checks" className="space-y-3 border-t border-border pt-4">
      <h3 className="text-sm font-medium">Repository checks</h3>
      {query.error && !status ? <p className="text-xs text-destructive">{query.error}</p> : null}
      {status ? (
        <>
          <div className="divide-y divide-border rounded-lg border border-border">
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <div className="space-y-1">
                <h4 className="text-sm font-medium">Run the repository check script</h4>
                <p className="text-xs text-muted-foreground">Off by default. Findings go to the manager thread chosen in Manager attention.</p>
                {status.ownedByOtherTracker ? <p className="text-xs text-amber-600 dark:text-amber-400">Another project linked to this BB project owns the runner.</p> : null}
                {!status.bbProjectId ? <p className="text-xs text-muted-foreground">Link a BB project to enable.</p> : null}
              </div>
              <label className="flex items-center gap-1.5 text-xs">
                <input type="checkbox" aria-label="Run repository checks" checked={status.config.enabled} disabled={busy || (!status.config.enabled && !status.bbProjectId)}
                  onChange={(event) => void run(() => rpc.call("updateChecksEnabled", { projectId, enabled: event.target.checked }))} />
                Enabled
              </label>
            </div>
            {FIELDS.map(({ key, label, hint }) => (
              <div key={key} className="flex flex-col gap-1 px-4 py-2 sm:flex-row sm:items-center sm:justify-between">
                <label className="min-w-0 text-xs"><span className="font-medium">{label}</span> <span className="text-muted-foreground">{hint}</span>
                  <input aria-label={label} className="mt-1 block h-8 w-full rounded-md border border-input bg-background px-2 text-sm sm:w-80" value={shown(key)} disabled={busy}
                    onChange={(event) => setDrafts((current) => ({ ...current, [key]: event.target.value }))} />
                </label>
                <Button size="sm" className="h-8" variant="outline" disabled={busy || drafts[key] === undefined} onClick={() => void save(key)}>Save</Button>
              </div>
            ))}
            <label className="flex items-center gap-1.5 px-4 py-3 text-xs">
              <input type="checkbox" aria-label="Snapshots" checked={status.config.snapshots} disabled={busy}
                onChange={(event) => void run(() => rpc.call("updateChecksSetting", { projectId, key: "snapshots", value: event.target.checked }))} />
              Snapshots: pass <code>--committed-state</code> and <code>--candidate-snapshot</code> to the script
            </label>
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
              <p className="flex flex-wrap items-center gap-2" data-testid="checks-retry">{status.blocked}. Work Board cannot tell whether the report reached the manager. Retry sends it again and may duplicate it.
                <Button size="sm" className="h-7 px-2.5" variant="outline" disabled={busy} onClick={() => void run(() => rpc.call("retryChecksReport", { projectId }))}>Retry</Button>
              </p>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">Enabling follows an owner-only convention and is logged. The script path and Git URL come from the repository and the BB project settings.</p>
        </>
      ) : null}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </section>
  );
}
