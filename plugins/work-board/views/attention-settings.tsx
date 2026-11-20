import { useEffect, useState } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Icon } from "@/components/ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DisclosureSummary } from "../components/disclosure.js";
import { formatRelativeTime } from "./activity/time.js";
import { useThreadNames } from "../components/thread-names.js";
import { useTasksQuery, useTasksRpc } from "../shell/data.js";
import { errorMessage } from "../shared/errors.js";

const MODE_LABEL = { off: "Off: Sweep sends", shadow: "Shadow: compare only, Sweep sends", live: "Live: Work Board sends" };
const SENDER = { off: "Sweep sends", shadow: "Sweep sends", live: "Work Board sends" };
const MODE_NOTE = {
  off: "Sweep sends stale-status notices.",
  shadow: "Sweep sends notices while Work Board records what it would send.",
  live: "Work Board sends stale-status notices to the manager.",
};

type ManagerThread = Awaited<ReturnType<ReturnType<typeof useSdk>["threads"]["list"]>>[number];
const threadTitle = (thread: ManagerThread) => thread.title || thread.titleFallback || "Untitled thread";
const noManager = "No manager";
const selectable = (thread: ManagerThread) => thread.archivedAt == null && thread.deletedAt == null
  && thread.visibility !== "hidden" && thread.status !== "stopping";

function ManagerPicker({ projectId, value, disabled, onChange }: {
  projectId: string | null; value: string; disabled: boolean; onChange: (value: string) => void;
}) {
  const sdk = useSdk();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [threads, setThreads] = useState<ManagerThread[]>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [byId, setById] = useState<ManagerThread>();
  const names = useThreadNames(value ? [value] : []);
  const selected = threads?.find((thread) => thread.id === value) ?? (byId?.id === value ? byId : undefined);
  const label = selected ? threadTitle(selected) : value ? names.get(value) ?? value : noManager;
  const exactId = search.trim();

  useEffect(() => {
    if (!open || !projectId) return;
    const abort = new AbortController();
    const load = async () => {
      const found = new Map<string, ManagerThread>();
      const limit = 100;
      for (let offset = 0; !abort.signal.aborted; offset += limit) {
        const page = await sdk.threads.list({ projectId, archived: false, limit, offset, signal: abort.signal });
        for (const thread of page.filter(selectable)) found.set(thread.id, thread);
        if (page.length < limit) return [...found.values()];
      }
    };
    void load().then((result) => {
      if (!abort.signal.aborted) setThreads(result);
    }, () => {
      if (!abort.signal.aborted) setLoadFailed(true);
    });
    return () => abort.abort();
  }, [open, projectId, sdk]);

  useEffect(() => {
    if (!open || !/^thr_[A-Za-z0-9_-]+$/.test(exactId) || threads?.some((thread) => thread.id === exactId)) return;
    const abort = new AbortController();
    void sdk.threads.list({ threadIds: [exactId], archived: false, limit: 1, signal: abort.signal }).then((result) => {
      if (!abort.signal.aborted) setById(result.find(selectable));
    }, () => {
      if (!abort.signal.aborted) setById(undefined);
    });
    return () => abort.abort();
  }, [exactId, open, sdk, threads]);

  const choose = (next: string) => { onChange(next); setOpen(false); };
  const options = threads ?? [];
  const exactMatch = byId?.id === exactId && !options.some((thread) => thread.id === exactId) ? byId : undefined;
  const filter = exactId.toLocaleLowerCase();
  const matches = options.filter((thread) => thread.id === exactId || threadTitle(thread).toLocaleLowerCase().includes(filter));
  return (
    <Popover open={open} onOpenChange={(next) => {
      setOpen(next);
      if (next) { setSearch(""); setLoadFailed(false); setThreads(undefined); }
    }}>
      <PopoverTrigger asChild>
        <Button type="button" size="sm" variant="outline" aria-label={`Manager thread: ${label}`} disabled={disabled}
          className="h-8 min-w-0 flex-1 justify-between gap-2 border-input px-2.5 font-normal sm:w-64">
          <span className="truncate" title={label}>{label}</span>
          <Icon name="ChevronDown" className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] min-w-52 max-w-[var(--radix-popover-content-available-width)] p-0">
        <Command label="Search threads" shouldFilter={false}>
          <CommandInput placeholder="Search by thread name" value={search} onValueChange={setSearch} />
          <CommandList>
            {!filter ? <CommandItem value={noManager} onSelect={() => choose("")}>{noManager}</CommandItem> : null}
            {(exactMatch ? [...matches, exactMatch] : matches).map((thread) => (
              <CommandItem key={thread.id} value={thread.id} onSelect={() => choose(thread.id)}>
                <span className="truncate" title={threadTitle(thread)}>{threadTitle(thread)}</span>
              </CommandItem>
            ))}
            {loadFailed ? <p role="alert" className="px-2 py-2 text-xs text-destructive">Couldn't load threads. Reopen the picker to try again.</p>
              : projectId && !threads ? <p role="status" className="px-2 py-2 text-xs text-muted-foreground">Loading project threads…</p>
              : <CommandEmpty>No matching threads.</CommandEmpty>}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** Owner-only setting: the platform cannot tell the app from an agent, so a change is only recorded and shown here. */
export function AttentionSettings({ projectId }: { projectId: string }) {
  const rpc = useTasksRpc();
  const query = useTasksQuery((client) => client.call("getAttentionSettings", { projectId }), ["projects:changed"], [projectId]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parityGeneration, setParityGeneration] = useState<number>();
  const [manager, setManager] = useState<string | null>(null);
  const settings = query.data;
  const generation = settings?.state.effective.generation;
  const parity = generation !== undefined && parityGeneration === generation;
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
  const previousManager = settings?.managerPrevious;
  const previousNames = useThreadNames(previousManager ? [previousManager] : []);
  const unresolved = settings?.unresolvedAttempts.length ?? 0;
  return (
    <section aria-label="Manager attention" className="space-y-3">
      <h4 className="text-sm font-medium">Manager attention</h4>
      {query.error && !settings ? <p className="text-xs text-destructive" data-testid="attention-load-error">{query.error}</p> : null}
      {settings ? (
        <>
          <div className="flex flex-col gap-3 rounded-lg border border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-1">
              <h5 className="text-sm font-medium">Manager thread</h5>
              <p className="text-xs text-muted-foreground">Receives notices when Work Board is live.</p>
              {settings.managerChangedAt ? <p className="text-xs text-muted-foreground">
                Changed <time dateTime={settings.managerChangedAt}>{formatRelativeTime(settings.managerChangedAt, Date.now())}</time>
                {previousManager ? <> from {previousNames.get(previousManager) ?? previousManager}</> : " from no manager"}.
              </p> : null}
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <ManagerPicker key={settings.linkedBbProjectId} projectId={settings.linkedBbProjectId} value={manager ?? settings.manager ?? ""} disabled={busy} onChange={setManager} />
              <Button size="sm" className="h-8" disabled={busy || manager === null || manager === (settings.manager ?? "")}
                onClick={() => void run(async () => { await rpc.call("updateAttentionManager", { projectId, manager: manager || null }); setManager(null); })}>Save</Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">Changes follow an owner-only convention and are logged.</p>
          <details className="rounded-md border border-border text-sm">
            <DisclosureSummary className="px-3 py-2.5">
              <span className="min-w-0 space-y-0.5">
                <span className="block"><span className="font-medium">Stale-status delivery</span> · <span data-testid="attention-sender">{SENDER[mode]}</span></span>
                {settings.managerWarning ? <span className="block text-xs text-amber-600 dark:text-amber-400" data-testid="attention-manager-warning">{settings.managerWarning}</span> : null}
                {unresolved ? <span className="block text-xs text-amber-600 dark:text-amber-400" data-testid="attention-unknown-count">{unresolved} {unresolved === 1 ? "notice" : "notices"} with an unknown outcome need your decision</span> : null}
              </span>
            </DisclosureSummary>
            <div className="space-y-3 border-t border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="space-y-1">
                  <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs" data-testid="attention-mode">{MODE_LABEL[mode]}</span>
                  <p className="text-xs text-muted-foreground">{MODE_NOTE[mode]}</p>
                </div>
                {!pending && (mode === "off"
                  ? <Button size="sm" className="h-8" variant="outline" disabled={busy || !settings.linkedBbProjectId} onClick={() => void setMode("shadow")}>Start shadow</Button>
                  : <Button size="sm" className="h-8" variant="outline" disabled={busy} onClick={() => void setMode(mode === "shadow" ? "off" : "shadow")}>{mode === "shadow" ? "Switch off" : "Back to shadow"}</Button>)}
              </div>
              {pending ? (
                <p className="rounded-md bg-muted/50 px-3 py-2 text-xs" data-testid="attention-pending">
                  {pending.direction === "to_live" ? "Going live" : "Going back to shadow"} · {pending.state === "ready" ? "Waiting for Sweep to acknowledge" : "Settling in-flight notices"}
                </p>
              ) : mode === "shadow" ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/50 px-3 py-2">
                  {gateHours > 0 ? <p className="text-xs text-muted-foreground" data-testid="attention-gate">Live delivery requires 48 hours in shadow. About {gateHours} {gateHours === 1 ? "hour" : "hours"} left.</p>
                    : <label className="flex items-center gap-1.5 text-xs">
                        <input type="checkbox" checked={parity} onChange={(event) => setParityGeneration(event.target.checked ? generation : undefined)} />
                        I reviewed the differences between Work Board and Sweep
                      </label>}
                  <Button size="sm" className="h-8" disabled={busy || !parity || gateHours > 0} onClick={() => void setMode("live")}>Go live</Button>
                </div>
              ) : null}
              {!settings.linkedBbProjectId && mode === "off" ? <p className="text-xs text-muted-foreground">Link a BB project to start shadow.</p> : null}
              {unresolved ? (
                <div className="space-y-2" data-testid="attention-unknown">
                  <h5 className="text-sm font-medium">Notices with an unknown outcome</h5>
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
            </div>
          </details>
        </>
      ) : null}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </section>
  );
}
