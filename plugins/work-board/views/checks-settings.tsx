import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { DisclosureSummary } from "../components/disclosure.js";
import { useThreadNames } from "../components/thread-names.js";
import { formatRelativeTime } from "./activity/time.js";
import { useTasksQuery, useTasksRpc } from "../shell/data.js";
import { RunnerPaths } from "./general-settings.js";
import { SettingsCard, SwitchRow, useSaveStatus } from "./settings-card.js";

type Key = "remote" | "branch" | "script" | "args" | "intervalMinutes" | "timeoutSeconds";
const FIELDS: { key: Key; label: string; hint: string }[] = [
  { key: "remote", label: "Repository", hint: "Optional. Defaults to the bb project's Git remote" },
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
  const id = useId();
  const query = useTasksQuery((client) => client.call("getChecksStatus", { projectId }), ["projects:changed", "settings:changed"], [projectId]);
  const [drafts, setDrafts] = useState<Partial<Record<Key, string>>>({});
  const saving = useSaveStatus();
  const { busy, track } = saving;
  const status = query.data;
  const deliveredTo = status?.lastDelivery?.to ?? null;
  const names = useThreadNames(deliveredTo ? [deliveredTo] : []);
  const run = (key: string, action: () => Promise<unknown>, retry?: () => void) => track(async () => { await action(); query.refresh(); }, retry, key);
  const shown = (key: Key) => drafts[key] ?? stored(key);
  const stored = (key: Key) => (key === "args" ? JSON.stringify(status!.config.args) : String(status!.config[key] ?? ""));
  const changed = status ? FIELDS.map(({ key }) => key).filter((key) => drafts[key] !== undefined && drafts[key] !== stored(key)) : [];
  // The script fields depend on each other and change a running check, so they wait for one Apply: it sends only the
  // changed fields, which the server validates together and writes all or nothing. Retry applies the latest edits.
  const apply = () => run("apply", async () => {
    const patch = Object.fromEntries(changed.map((key) => {
      if (key === "remote") return [key, shown(key) || null];
      const raw = shown(key).trim();
      return [key, key === "args" ? JSON.parse(raw) : key === "intervalMinutes" || key === "timeoutSeconds" ? Number(raw) : raw];
    }));
    await rpc.call("checks.configPatch", { projectId, patch });
    setDrafts({});
  }, () => void latestApply.current());
  const latestApply = useRef(apply);
  latestApply.current = apply;
  return (
    <SettingsCard title="Repository checks" description="Run the repository check script on a schedule and send its findings to the manager thread." save={saving.status}>
      {query.error && !status ? <p className="text-xs text-destructive">{query.error}</p> : null}
      {status ? (
        <>
          <div className="divide-y divide-border rounded-lg border border-border">
            <div className="space-y-2 px-4 py-3">
              <SwitchRow label="Run repository checks" checked={status.config.enabled}
                disabled={busy || (!status.config.enabled && !status.bbProjectId)}
                onChange={(enabled) => void run("enabled", () => rpc.call("updateChecksEnabled", { projectId, enabled }))}
                hint="Off by default. Findings go to the manager thread chosen in Manager. Enabling follows an owner-only convention and is logged." />
              {status.ownedByOtherTracker ? <p className="text-xs text-amber-600 dark:text-amber-400">Another project linked to this BB project owns the runner.</p> : null}
              {!status.bbProjectId ? <p className="text-xs text-muted-foreground">Link a BB project to enable.</p> : null}
            </div>
            {FIELDS.map(({ key, label, hint }) => (
              <div key={key} className="min-w-0 space-y-1 px-4 py-2 text-xs">
                <label htmlFor={`${id}-${key}`} className="block font-medium">{label}</label>
                <input id={`${id}-${key}`} aria-describedby={`${id}-${key}-hint`} className="block h-8 w-full rounded-md border border-input bg-background px-2 text-sm sm:w-80"
                  value={shown(key)} disabled={busy} onChange={(event) => setDrafts((current) => ({ ...current, [key]: event.target.value }))} />
                <p id={`${id}-${key}-hint`} className="text-muted-foreground">{hint}</p>
              </div>
            ))}
            {changed.length ? (
              <div className="flex flex-wrap items-center gap-2 px-4 py-3" data-testid="checks-unapplied">
                <Button size="sm" className="h-7 px-2.5" disabled={busy} onClick={() => void apply()}>Apply</Button>
                <Button size="sm" variant="ghost" className="h-7 px-2.5" disabled={busy} onClick={() => { setDrafts({}); saving.forget("apply"); }}>Discard</Button>
                <span className="text-xs text-muted-foreground">Checks run with the applied values until you press Apply.</span>
              </div>
            ) : null}
            <div className="px-4 py-3">
              <SwitchRow label="Snapshots" checked={status.config.snapshots} disabled={busy}
                onChange={(snapshots) => void run("snapshots", () => rpc.call("checks.configPatch", { projectId, patch: { snapshots } }))}
                hint={<>Pass <code>--committed-state</code> and <code>--candidate-snapshot</code> to the script.</>} />
            </div>
          </div>
          <div className="space-y-1 text-xs" data-testid="checks-status">
            <p>Last run {when(status.lastRun)} · next run {when(status.nextRun)} · exit {status.exitCode ?? "–"}{status.failureStage ? ` · ${status.failureStage} failure` : ""}</p>
            {status.error ? <p className="text-destructive">{status.error}</p> : null}
            {status.deliveryError && !status.blocked ? <p className="text-destructive">{status.deliveryError}</p> : null}
            {status.lastDelivery ? <p>Last report {when(status.lastDelivery.at)} to {deliveredTo ? names.get(deliveredTo) ?? deliveredTo : "no manager"} ({status.lastDelivery.receipt?.mode ?? "recorded"})</p> : null}
            {status.pending ? <p>Report waiting for delivery since {status.pending.stagedAt ? formatRelativeTime(status.pending.stagedAt, Date.now()) : "–"}.</p> : null}
            {status.managerError ? <p className="text-amber-600 dark:text-amber-400">Manager: {status.managerError}</p> : null}
            {status.pushError ? <p className="text-amber-600 dark:text-amber-400">Push: {status.pushError}</p> : null}
            {status.stateMismatch ? (
              <p className="flex flex-wrap items-center gap-2 text-amber-600 dark:text-amber-400" data-testid="checks-mismatch">{status.stateMismatch}
                <Button size="sm" className="h-7 px-2.5" variant="outline" disabled={busy || status.config.enabled || status.draining} onClick={() => void run("reset", () => rpc.call("resetChecksState", { projectId }))}>Reset state</Button>
              </p>
            ) : null}
            {status.awaitingRetry ? (
              <p className="flex flex-wrap items-center gap-2" data-testid="checks-retry">{status.blocked}. Work Board cannot tell whether the report reached the manager / Agent Hub. Retry sends it to the manager and may duplicate it.
                <Button size="sm" className="h-7 px-2.5" variant="outline" disabled={busy} onClick={() => void run("retryReport", () => rpc.call("retryChecksReport", { projectId }))}>Retry</Button>
              </p>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">Checks fetch from the bb project's Git remote, unless Repository is set. The script path is relative to that checkout.</p>
        </>
      ) : null}
      <details className="rounded-md border border-border text-sm">
        <DisclosureSummary className="px-3 py-2.5"><span className="font-medium">Runner paths (all projects)</span></DisclosureSummary>
        <div className="space-y-3 border-t border-border p-3">
          <p className="text-xs text-muted-foreground">How every project's repository-check script is launched. A change here applies to all projects, not only this one.</p>
          <RunnerPaths save={saving} />
        </div>
      </details>
    </SettingsCard>
  );
}
