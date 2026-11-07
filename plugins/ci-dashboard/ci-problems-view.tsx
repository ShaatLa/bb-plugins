import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { UrlLink, useBbNavigate, useRpc, useSdk } from "@get-bb/plugin-sdk/app";
import { Button } from "./components/ui/button";
import { Summary } from "./components/ui/summary";
import { LoadingSkeleton, Skeleton } from "./components/ui/skeleton";
import { ago } from "./ci-cards";
import { ThreadPickerDialog } from "./thread-picker-dialog";
import type { Contract, JobSignals } from "./signals-panel";

type Problem = NonNullable<JobSignals["repo"]>["problems"][number];
const SHOWN = 5;
// Severity badges reuse the plugin's small bordered label (see the UTC tag) with a tinted fill.
const tone = { critical: "border-destructive/30 bg-destructive/10 text-destructive-text", warning: "border-warning/30 bg-warning/10 text-warning-text" } as const;
const message = (cause: unknown) => cause instanceof Error ? cause.message : "The action failed. Try again.";

function ThreadLink({ threadId }: { threadId: string }) {
  const sdk = useSdk(), navigate = useBbNavigate();
  const [title, setTitle] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    sdk.threads.get({ threadId }).then((thread) => { if (!disposed) setTitle(thread.title ?? thread.titleFallback ?? null); }, () => {});
    return () => { disposed = true; };
  }, [sdk, threadId]);
  return <Button variant="link" size="sm" className="h-auto min-w-0 max-w-56 p-0 text-xs" onClick={() => navigate.toThread(threadId)}><span className="truncate">{title ?? "session"}</span></Button>;
}

/** "Investigate" menu: new session in the repository's project, or an existing one chosen in a dialog. */
function InvestigateMenu({ problem, projectId, busy, onNew, onExisting }: { problem: Problem; projectId: string | null; busy: boolean; onNew: () => void; onExisting: (threadId: string) => Promise<void> }) {
  const [open, setOpen] = useState(false), [picking, setPicking] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const menu = useId(), hint = useId();
  const items = () => Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
  useEffect(() => { if (open) items()[0]?.focus(); }, [open]);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!open) return;
    if (event.key === "Escape") { event.preventDefault(); close(); }
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const list = items(), at = list.indexOf(document.activeElement as HTMLButtonElement);
      list[(at + (event.key === "ArrowDown" ? 1 : list.length - 1)) % list.length]?.focus();
    }
  };
  return <div ref={root} className="relative" onKeyDown={onKeyDown} onBlur={(event) => { if (open && !root.current?.contains(event.relatedTarget)) setOpen(false); }}>
    <Button ref={trigger} variant="outline" size="sm" disabled={busy} aria-label={`Investigate: ${problem.title}`} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menu : undefined} onClick={() => setOpen(!open)}>Investigate</Button>
    {open && <div id={menu} role="menu" aria-label="Investigate" className="absolute right-0 z-10 mt-1 w-56 space-y-1 rounded-md border border-border bg-popover text-popover-foreground p-1 shadow-md">
      <Button role="menuitem" variant="ghost" size="sm" className="w-full justify-start" disabled={!projectId} aria-describedby={projectId ? undefined : hint} onClick={() => { setOpen(false); onNew(); }}>New session</Button>
      {!projectId && <p id={hint} className="px-2 py-1 text-xs text-muted-foreground">No BB project is linked to this repository.</p>}
      <Button role="menuitem" variant="ghost" size="sm" className="w-full justify-start" onClick={() => { setOpen(false); setPicking(true); }}>Existing session…</Button>
    </div>}
    {picking && <ThreadPickerDialog projectId={projectId} problemTitle={problem.title} onSelect={onExisting} onClose={() => { setPicking(false); trigger.current?.focus(); }} />}
  </div>;
}

/** The CI health card's problem list: unhandled problems, then one collapsed "Handled" section (investigating with its session, dismissed with Restore). */
const badge = "inline-block rounded border px-1.5 py-0.5 align-middle text-[10px] font-medium leading-none";
/** Problem count next to the CI health title; renders nothing until signals load. */
export function ProblemsBadge({ signals }: { signals: JobSignals }) {
  const unhandled = signals.repo?.problems.filter((problem) => !problem.handled);
  if (!unhandled) return null;
  const critical = unhandled.some((problem) => problem.severity === "critical");
  return <span className={`${badge} ${unhandled.length ? tone[critical ? "critical" : "warning"] : "border-border text-muted-foreground"}`}>
    {unhandled.length ? `${unhandled.length} ${unhandled.length === 1 ? "problem needs" : "problems need"} attention` : "All good"}</span>;
}

export function CiProblems({ repository, signals }: { repository: string; signals: JobSignals }) {
  const rpc = useRpc<Contract>();
  const [all, setAll] = useState(false), [busy, setBusy] = useState<string | null>(null), [failure, setFailure] = useState<string | null>(null);
  const job = signals.repo;
  if (!job) return signals.loading ? <LoadingSkeleton label="Loading CI problems"><Skeleton className="h-3 w-3/4" /></LoadingSkeleton>
    : signals.error ? <p role="alert" className="text-sm text-destructive-text">CI problems failed to load. <Button variant="outline" size="sm" onClick={signals.retry}>Retry</Button></p> : null;
  const unhandled = job.problems.filter((problem) => !problem.handled);
  // Handled problems leave the list; they close on their own once the underlying problem resolves.
  const handledRows = [...job.problems.filter((problem) => problem.handled?.state === "investigating"), ...job.problems.filter((problem) => problem.handled?.state === "dismissed")];
  const rows = unhandled, shown = all ? rows : rows.slice(0, SHOWN);
  const run = async (id: string, action: () => Promise<unknown>) => {
    setBusy(id); setFailure(null);
    try { await action(); signals.retry(); } finally { setBusy(null); }
  };
  const report = (cause: unknown) => setFailure(message(cause));
  const investigate = (problem: Problem, threadId?: string) => run(problem.id, () => rpc.call("investigate", { repository, id: problem.id, ...(threadId ? { threadId } : {}) }));
  const act = (problem: Problem, action: "dismiss" | "restore") => run(problem.id, () => rpc.call("problemAction", { repository, id: problem.id, action })).catch(report);
  const row = (problem: Problem) => {
    const { handled } = problem;
    return <li key={problem.id} className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0">
      <div className="min-w-0 space-y-1">
        <p className="break-words text-sm"><span className={`mr-0.5 ${badge} ${tone[problem.severity]}`}>{problem.severity === "critical" ? "Critical" : "Warning"}</span>{" "}
          <UrlLink href={problem.where.url ?? `https://github.com/${repository}/actions`} className="hover:underline">{problem.title}</UrlLink>
          <span className="text-xs text-muted-foreground"> · {ago(problem.since, signals.now)}</span></p>
        {problem.severity === "critical" && <p className="text-xs text-muted-foreground">{problem.what}</p>}
      </div>
      {!handled ? <div className="flex shrink-0 items-center gap-2">
        <InvestigateMenu problem={problem} projectId={job.projectId} busy={busy === problem.id} onNew={() => void investigate(problem).catch(report)} onExisting={(threadId) => investigate(problem, threadId)} />
        <Button variant="outline" size="sm" disabled={busy === problem.id} aria-label={`Dismiss: ${problem.title}`} onClick={() => void act(problem, "dismiss")}>Dismiss</Button>
      </div> : handled.state === "investigating" && handled.threadId ? <p className="flex min-w-0 shrink-0 items-center gap-1 text-xs text-muted-foreground">Investigating in <ThreadLink threadId={handled.threadId} /></p>
        : <Button variant="outline" size="sm" className="shrink-0" disabled={busy === problem.id} aria-label={`Restore: ${problem.title}`} onClick={() => void act(problem, "restore")}>Restore</Button>}
    </li>;
  };
  return <section aria-label="CI problems" className="space-y-3">
    {job.error && <p role="alert" className="text-xs text-destructive-text">{job.error}</p>}
    {signals.error && <p role="alert" className="text-sm text-destructive-text">CI problems failed to refresh. <Button variant="outline" size="sm" onClick={signals.retry}>Retry</Button></p>}
    {failure && <p role="alert" className="text-sm text-destructive-text">{failure}</p>}
    {shown.length > 0 && <div>
      <ul aria-label="Problems" className="divide-y divide-border">{shown.map(row)}</ul>
      {rows.length > SHOWN && <button type="button" className="mt-1 rounded-sm text-sm text-muted-foreground hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-expanded={all} onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${rows.length}`}</button>}
    </div>}
    {handledRows.length > 0 && <details><Summary className="text-sm text-muted-foreground">Handled · {handledRows.length}</Summary>
      <ul aria-label="Handled problems" className="mt-2 divide-y divide-border">{handledRows.map(row)}</ul></details>}
  </section>;
}
