import { useEffect, useId, useRef, useState } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Icon } from "@/components/ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DisclosureSummary } from "../components/disclosure.js";
import { formatRelativeTime } from "./activity/time.js";
import { useThreadNames } from "../components/thread-names.js";
import { useOrderClock, useTasksQuery, useTasksRpc } from "../shell/data.js";
import { SettingsCard, SwitchRow, useSaveStatus } from "./settings-card.js";

const SUMMARY = "Work Board messages the manager thread about tasks that look stuck:";
const CONDITIONS = [
  ["In progress", "no working session"],
  ["In review", "no open pull request, and none merged in the last 2 hours"],
  ["In testing", "no open or merged pull request"],
  ["In review or In testing", "Work Board cannot read the pull request from GitHub"],
  ["Any of these or Bugfix", "a pull request closed without merging"],
] as const;
const DETAILS = [
  "Tasks waiting on an unfinished blocker and ongoing epics are skipped.",
  "A task is reported after it has been stuck for 10 minutes, then again only if it recovers and gets stuck again.",
  "While on, repository check reports leave these tasks out; while off, they may still list them.",
  "Turning notices off and on again starts over.",
];
const STATE_TEXT = {
  off: "Off: no notices are sent.",
  live: "On: notices go to the manager thread.",
  switching: "Switching off: a notice is still being sent.",
};

type ManagerThread = Awaited<ReturnType<ReturnType<typeof useSdk>["threads"]["list"]>>[number];
const threadTitle = (thread: ManagerThread) => thread.title || thread.titleFallback || "Untitled thread";
const noManager = "No manager";
const selectable = (thread: ManagerThread) => thread.archivedAt == null && thread.deletedAt == null
  && thread.visibility !== "hidden" && thread.status !== "stopping";

function ManagerPicker({ projectId, value, disabled, onChange }: {
  projectId: string | null; value: string; disabled: boolean; onChange: (value: string, title: string) => void;
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

  const choose = (next: string, title: string) => { onChange(next, title); setOpen(false); };
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
            {!filter ? <CommandItem value={noManager} onSelect={() => choose("", noManager)}>{noManager}</CommandItem> : null}
            {(exactMatch ? [...matches, exactMatch] : matches).map((thread) => (
              <CommandItem key={thread.id} value={thread.id} onSelect={() => choose(thread.id, threadTitle(thread))}>
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

const PR_SWITCHES = [
  { key: "prEvents", label: "PR lifecycle messages", hint: "Message the task's working session about its pull request: CI results, merge-queue removal, the merge and the first successful post-merge run." },
  { key: "prEventsManager", label: "Copy PR messages to the manager", hint: "Also send those messages to the manager thread." },
] as const;
const PR_MANAGER_NEEDS_EVENTS = "Turn on PR lifecycle messages to copy them to the manager.";
type PrKey = (typeof PR_SWITCHES)[number]["key"];

/** Two per-project keys, read and written one at a time through `config.get`/`config.set`; stored as "on" or "off". */
function PrMessages({ projectId, save }: { projectId: string; save: ReturnType<typeof useSaveStatus> }) {
  const rpc = useTasksRpc();
  const stamp = useOrderClock();
  const query = useTasksQuery((client) => { const readAt = stamp(); return client.call("config.get", { projectId }).then((data) => ({ ...data, readAt })); }, ["projects:changed"], [projectId]);
  // Acknowledged values win over every read that started before the write, including one that fails.
  const [acknowledged, setAcknowledged] = useState<Partial<Record<PrKey, { value: unknown; at: number }>>>({});
  const value = (key: PrKey) => {
    const ack = acknowledged[key];
    return ack && ack.at > (query.data?.readAt ?? 0) ? ack.value : query.data?.values[key];
  };
  const latestValue = useRef(value);
  latestValue.current = value;
  const [busy, setBusy] = useState(false);
  // A Retry runs later: a copy whose lifecycle messages were turned off meanwhile is dropped, not written.
  const retry = (key: PrKey, on: boolean) => {
    if (key === "prEventsManager" && latestValue.current("prEvents") !== "on") save.forget(key);
    else void write(key, on);
  };
  const write = async (key: PrKey, on: boolean) => {
    setBusy(true);
    await save.track(async () => {
      const result = await rpc.call("config.set", { projectId, key, value: on ? "on" : "off" });
      const at = stamp();
      setAcknowledged((current) => ({ ...current, [key]: { value: result.value, at } }));
      await query.refresh();
    }, () => retry(key, on), key);
    setBusy(false);
  };
  // Copies exist only of messages that are sent, so the copy switch waits for the lifecycle switch.
  const eventsOff = value("prEvents") !== "on";
  return (
    <div className="space-y-3">
      <AutomaticPause projectId={projectId} save={save} value={query.data?.values.autoPause} refresh={query.refresh} />
      <h4 className="text-sm font-medium">Pull request messages</h4>
      {PR_SWITCHES.map(({ key, label, hint }) => {
        const needsEvents = key === "prEventsManager" && eventsOff;
        return <SwitchRow key={key} label={label} hint={needsEvents ? PR_MANAGER_NEEDS_EVENTS : hint} disabled={busy || !query.data || needsEvents}
          checked={value(key) === "on"} onChange={(on) => void write(key, on)} />;
      })}
      {query.error && !query.data ? <p role="alert" className="text-xs text-destructive">{query.error}</p> : null}
    </div>
  );
}

function AutomaticPause({ projectId, save, value, refresh }: { projectId: string; save: ReturnType<typeof useSaveStatus>; value: unknown; refresh: () => Promise<unknown> }) {
  const rpc = useTasksRpc();
  const mode = String(value ?? "off");
  return <label className="flex items-center justify-between gap-3 text-sm">Automatic pause
    <select aria-label="Automatic pause" value={mode} disabled={value === undefined} onChange={event => {
      const next = event.target.value as "off" | "ab" | "on";
      void save.track(async () => { await rpc.call("updatePauseMode", { projectId, mode: next }); await refresh(); }, undefined, "autoPause");
    }} className="rounded border border-border bg-background px-2 py-1">
      <option value="off">Off</option><option value="ab">A/B test</option><option value="on">On</option>
    </select>
  </label>;
}

/** Owner-only setting: the platform cannot tell the app from an agent, so a change is only recorded and shown here. */
export function AttentionSettings({ projectId }: { projectId: string }) {
  const rpc = useTasksRpc();
  const stamp = useOrderClock();
  const query = useTasksQuery((client) => { const readAt = stamp(); return client.call("getAttentionSettings", { projectId }).then((data) => ({ ...data, readAt })); }, ["projects:changed", "settings:changed"], [projectId]);
  // The manager the last write stored; it wins over every read that started before that write, including a failed one.
  const [managerAck, setManagerAck] = useState<{ manager: string | null; at: number }>();
  const saving = useSaveStatus();
  const { status: save, busy, track } = saving;
  const switchHint = useId();
  // A replacement or removal of a set manager waits here for the owner's confirmation.
  const [confirming, setConfirming] = useState<{ id: string; title: string } | null>(null);
  const settings = query.data;
  // The controls stay locked until the refreshed settings land, so a second pick sees the manager just set.
  const run = (key: string, action: () => Promise<unknown>) => track(async () => { await action(); await query.refresh(); }, undefined, key);
  const setMode = (mode: "off" | "live") => run("mode", () => rpc.call("updateAttentionMode", { projectId, mode }));
  const mode = settings?.state.effective.mode ?? "off";
  const switching = settings?.state.switchingOff ?? false;
  const shown = switching ? "switching" : mode;
  const previousManager = settings?.managerPrevious;
  const previousNames = useThreadNames(previousManager ? [previousManager] : []);
  const current = (managerAck && managerAck.at > (settings?.readAt ?? 0) ? managerAck.manager : settings?.manager) ?? "";
  const currentNames = useThreadNames(current ? [current] : []);
  const unresolved = settings?.unresolvedAttempts.length ?? 0;
  const saveManager = (id: string) => run("manager", async () => {
    const result = await rpc.call("updateAttentionManager", { projectId, manager: id || null });
    setManagerAck({ manager: result.manager, at: stamp() });
  });
  // Picking is the commit gesture; picking the current manager again does nothing.
  const pick = (id: string, title: string) => {
    if (id === current) return;
    if (current) setConfirming({ id, title });
    else void saveManager(id);
  };
  const retryOffered = settings?.unresolvedAttempts.some((attempt) => attempt.canRetry) ?? false;
  // One hint at a time: the link first, then the manager; a second project on the link is the server's refusal on turning on.
  const onHint = mode !== "off" || switching || !settings ? null
    : !settings.linkedBbProjectId ? "Link this project to a BB project to turn notices on."
    : !current ? "Choose a manager thread to turn notices on." : null;
  return (
    <SettingsCard title="Manager" description="The manager thread, stale-status delivery and pull request messages for this project." save={save}>
      {query.error && !settings ? <p className="text-xs text-destructive" data-testid="attention-load-error">{query.error}</p> : null}
      {settings ? (
        <>
          <div className="flex flex-col gap-3 rounded-lg border border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-1">
              <h4 className="text-sm font-medium">Manager thread</h4>
              <p className="text-xs text-muted-foreground">Receives stale-status notices and repository check reports for this project, and copies of pull request messages when both PR switches below are on.</p>
              {settings.managerChangedAt ? <p className="text-xs text-muted-foreground">
                Changed <time dateTime={settings.managerChangedAt}>{formatRelativeTime(settings.managerChangedAt, Date.now())}</time>
                {previousManager ? <> from {previousNames.get(previousManager) ?? previousManager}</> : " from no manager"}.
              </p> : null}
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <ManagerPicker key={settings.linkedBbProjectId} projectId={settings.linkedBbProjectId} value={current} disabled={busy} onChange={pick} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">Changes follow an owner-only convention and are logged.</p>
          <Dialog open={confirming !== null} onOpenChange={(open) => { if (!open) setConfirming(null); }}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{confirming?.id ? "Replace the manager thread?" : "Remove the manager thread?"}</DialogTitle>
                <DialogDescription>
                  From {currentNames.get(current) ?? current} to {confirming?.title ?? noManager}. Stale-status notices and copied PR messages go to the new manager.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setConfirming(null)}>Cancel</Button>
                <Button type="button" onClick={() => { const next = confirming!.id; setConfirming(null); void saveManager(next); }}>
                  {confirming?.id ? "Replace manager" : "Remove manager"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <PrMessages projectId={projectId} save={saving} />
          {/* The switch sits on the summary row but outside the summary, so it never toggles the disclosure and is not
              nested in the summary's button. */}
          <div className="relative">
          <details className="rounded-md border border-border text-sm">
            <DisclosureSummary className="py-2.5 pl-3 pr-14">
              <span className="min-w-0 space-y-0.5">
                <span className="block"><span className="font-medium">Stale-status notices</span> · <span data-testid="attention-sender">{switching ? "Switching off" : mode === "live" ? "On" : "Off"}</span></span>
                {onHint ? <span id={switchHint} className="block text-xs text-muted-foreground" data-testid="attention-hint">{onHint}</span> : null}
                {settings.managerWarning ? <span className="block text-xs text-amber-600 dark:text-amber-400" data-testid="attention-manager-warning">{settings.managerWarning}</span> : null}
                {unresolved ? <span className="block text-xs text-amber-600 dark:text-amber-400" data-testid="attention-unknown-count">{unresolved} {unresolved === 1 ? "notice" : "notices"} with an unknown outcome need your decision</span> : null}
              </span>
            </DisclosureSummary>
            <div className="space-y-3 border-t border-border p-3">
              <p className="text-sm font-medium" data-testid="attention-mode">{STATE_TEXT[shown]}</p>
              <div className="space-y-1.5 text-xs text-muted-foreground" data-testid="attention-explanation">
                <p>{SUMMARY}</p>
                <ul className="space-y-0.5">
                  {CONDITIONS.map(([status, condition]) => (
                    <li key={status}><span className="font-medium text-foreground">{status}</span> · {condition}</li>
                  ))}
                </ul>
                <details>
                  <summary className="cursor-pointer select-none">Details</summary>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4">
                    {DETAILS.map((line) => <li key={line}>{line}</li>)}
                  </ul>
                </details>
              </div>
              {unresolved ? (
                <div className="space-y-2" data-testid="attention-unknown">
                  <h5 className="text-sm font-medium">Notices with an unknown outcome</h5>
                  <p className="text-xs text-muted-foreground">Work Board could not confirm that these reached the manager thread and never resends them by itself. {retryOffered ? "Send again or accept that they may be lost." : "Accept that they may be lost."}</p>
                  {settings.unresolvedAttempts.map((attempt) => (
                    <div key={attempt.attemptId} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span>{attempt.occurrenceIds.length} task{attempt.occurrenceIds.length === 1 ? "" : "s"} sent {formatRelativeTime(attempt.startedAt, Date.now())} to {attempt.recipientThreadId}</span>
                      <span className="flex gap-1">
                        {attempt.canRetry ? <Button size="sm" className="h-7 px-2.5" variant="outline" disabled={busy} onClick={() => void run(attempt.attemptId, () => rpc.call("resolveAttentionAttempt", { attemptId: attempt.attemptId, disposition: "retry" }))}>Send again</Button> : null}
                        <Button size="sm" className="h-7 px-2.5" variant="outline" disabled={busy} onClick={() => void run(attempt.attemptId, () => rpc.call("resolveAttentionAttempt", { attemptId: attempt.attemptId, disposition: "waived_loss" }))}>Accept the loss</Button>
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </details>
          <Switch className="absolute right-3 top-3" aria-label="Stale-status notices" aria-describedby={onHint ? switchHint : undefined}
            checked={mode === "live" && !switching} disabled={busy || switching || (mode === "off" && onHint !== null)}
            onCheckedChange={(on) => void setMode(on ? "live" : "off")} />
          </div>
        </>
      ) : null}
    </SettingsCard>
  );
}
