import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatRelativeTime } from "./activity/time.js";
import { useTasksQuery, useTasksRpc } from "../shell/data.js";
import { errorMessage } from "../shared/errors.js";

const MODE_NOTE: Record<string, string> = {
  off: "Sweep sends stale-status notices; Work Board only keeps this project's settings.",
  shadow: "Sweep still sends. Work Board records what it would send, so the two can be compared.",
  live: "Work Board sends stale-status notices to the manager; Sweep stays silent for this kind.",
};

/** Owner-only setting: the platform cannot tell the app from an agent, so a change is only recorded and shown here. */
export function AttentionSettings({ projectId }: { projectId: string }) {
  const rpc = useTasksRpc();
  const query = useTasksQuery((client) => client.call("getAttentionSettings", { projectId }), ["projects:changed"], [projectId]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parity, setParity] = useState(false);
  const [manager, setManager] = useState<string | null>(null);
  const settings = query.data;
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      query.refresh();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const setMode = (mode: "off" | "shadow" | "live") => run(() => rpc.call("updateAttentionMode", { projectId, mode, ...(mode === "live" ? { parityReviewed: parity } : {}) }));
  const mode = settings?.state.effective.mode ?? "off";
  const pending = settings?.state.transition ?? null;
  const gateHours = settings ? Math.ceil(settings.gateRemainingMs / 3_600_000) : 0;
  return (
    <section aria-label="Manager attention" className="space-y-3 border-t border-border pt-4">
      <h3 className="text-sm font-medium">Manager attention</h3>
      <p className="text-xs text-muted-foreground">Stale-status notices to the manager thread. This is an owner-only convention: the platform cannot tell you from an agent, so every change is recorded (time and previous value) and logged.</p>
      {query.error && !settings ? <p className="text-xs text-destructive" data-testid="attention-load-error">{query.error}</p> : null}
      {settings ? (
        <>
          <p className="text-sm" data-testid="attention-mode">Mode: <strong>{mode}</strong> <span className="text-xs text-muted-foreground">(generation {settings.state.effective.generation})</span></p>
          <p className="text-xs text-muted-foreground">{MODE_NOTE[mode]}</p>
          {settings.changedAt ? (
            <p className="text-xs text-muted-foreground" data-testid="attention-changed">
              Changed <time dateTime={settings.changedAt} title={settings.changedAt}>{formatRelativeTime(settings.changedAt, Date.now())}</time>, was {settings.previousMode ?? "off"}
            </p>
          ) : null}
          {pending ? (
            <p className="text-xs" data-testid="attention-pending">
              {pending.direction === "to_live" ? "Going live" : "Going back to shadow"}: {pending.state === "ready" ? "waiting for Sweep to acknowledge" : "settling in-flight notices"}. No other change is possible until this finishes.
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {mode === "off" ? <Button size="sm" className="h-7 px-2.5" variant="outline" disabled={busy || !settings.linkedBbProjectId} onClick={() => void setMode("shadow")}>Start shadow</Button> : null}
              {mode === "shadow" ? <Button size="sm" className="h-7 px-2.5" variant="outline" disabled={busy} onClick={() => void setMode("off")}>Switch off</Button> : null}
              {mode === "live" ? <Button size="sm" className="h-7 px-2.5" variant="outline" disabled={busy} onClick={() => void setMode("shadow")}>Back to shadow</Button> : null}
              {mode === "shadow" ? (
                <>
                  <label className="flex items-center gap-1.5 text-xs">
                    <input type="checkbox" checked={parity} onChange={(event) => setParity(event.target.checked)} />
                    Parity differences reviewed
                  </label>
                  <Button size="sm" className="h-7 px-2.5" disabled={busy || !parity || settings.gateRemainingMs > 0} onClick={() => void setMode("live")}>Go live</Button>
                  {settings.gateRemainingMs > 0 ? <span className="text-xs text-muted-foreground" data-testid="attention-gate">Live needs 48 hours of shadow; about {gateHours} h left.</span> : null}
                </>
              ) : null}
            </div>
          )}
          {!settings.linkedBbProjectId && mode === "off" ? <p className="text-xs text-muted-foreground">Link this project to a BB project first.</p> : null}
          <label className="flex flex-wrap items-center justify-between gap-2 text-sm">
            Manager thread
            <span className="flex items-center gap-2">
              <Input aria-label="Manager thread" className="h-8 w-56" placeholder="thr_… (empty uses Sweep's manager)" value={manager ?? settings.manager ?? ""} onChange={(event) => setManager(event.target.value)} />
              <Button size="sm" className="h-7 px-2.5" variant="outline" disabled={busy || manager === null || manager === (settings.manager ?? "")}
                onClick={() => void run(async () => { await rpc.call("updateAttentionManager", { projectId, manager: manager!.trim() || null }); setManager(null); })}>Save</Button>
            </span>
          </label>
          {settings.managerChangedAt ? <p className="text-xs text-muted-foreground">Manager changed <time dateTime={settings.managerChangedAt}>{formatRelativeTime(settings.managerChangedAt, Date.now())}</time>, was {settings.managerPrevious ?? "none"}</p> : null}
          {settings.unresolvedAttempts.length ? (
            <div className="space-y-2" data-testid="attention-unknown">
              <h4 className="text-sm font-medium">Notices with an unknown outcome</h4>
              <p className="text-xs text-muted-foreground">Work Board cannot tell whether these reached the manager and never resends them by itself. Going back to shadow waits until you decide.</p>
              {settings.unresolvedAttempts.map((attempt) => (
                <div key={attempt.attemptId} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span>{attempt.occurrenceIds.length} card{attempt.occurrenceIds.length === 1 ? "" : "s"} sent {formatRelativeTime(attempt.startedAt, Date.now())} to {attempt.recipientThreadId}</span>
                  <span className="flex gap-1">
                    <Button size="sm" className="h-7 px-2.5" variant="outline" disabled={busy} onClick={() => void run(() => rpc.call("resolveAttentionAttempt", { attemptId: attempt.attemptId, disposition: "retry" }))}>Send again</Button>
                    <Button size="sm" className="h-7 px-2.5" variant="outline" disabled={busy} onClick={() => void run(() => rpc.call("resolveAttentionAttempt", { attemptId: attempt.attemptId, disposition: "waived_loss" }))}>Accept the loss</Button>
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </section>
  );
}
