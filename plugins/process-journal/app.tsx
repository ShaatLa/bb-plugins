import { useCallback, useEffect, useRef, useState, type ComponentPropsWithoutRef, type FormEvent, type ReactNode } from "react";
import { definePluginApp, experimental_Icon as Icon, Markdown, useBbNavigate, useRealtime, useRpc, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import { boardDisplaySchema, type BoardColumnDisplay } from "./board-display-contract";
import type { methods, rpcContract } from "./contract";
import { JournalCheckbox, JournalSelect } from "./controls";
import { isOpen, states, type BoardState, type State } from "./states";
import { cardPath, hiddenColumnsPath, journalPath, proposalPath, settingsPath } from "./paths";
import { ProposalDates } from "./proposal-dates";
import { JournalSettings } from "./settings";
import { defaultColumns, displayName, StatusMark } from "./status-display";
import { ReviewPanel, reviewBadge } from "./review-panel";

type Data<K extends keyof typeof methods> = z.infer<typeof methods[K]["output"]>;
type Projects = Data<"projects">;
type Detail = Data<"proposal.detail">;
type ProposalRow = Data<"list">["items"][number];
type Range = "week" | "month" | "quarter";
const ranges: { value: Range; label: string }[] = [
  { value: "week", label: "Last 7 days" }, { value: "month", label: "Last month" }, { value: "quarter", label: "Last 3 months" },
];
const input = "min-w-0 max-w-full rounded-md border border-border bg-background px-2 py-1 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring";
const button = input + " hover:bg-muted disabled:opacity-50";
const panel = "min-w-0 rounded-lg border border-border bg-card p-4";
const detailPanel = `${panel} space-y-3 text-sm shadow-2xs @sm:p-5`;
const detailHeading = "text-base font-semibold leading-snug";
const detailText = "max-w-[72ch] leading-relaxed [overflow-wrap:anywhere]";
const detailCallout = "space-y-1 rounded-md bg-muted/45 p-3";
const control = "flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground";
const cardSurface = "min-w-0 rounded-lg border border-border bg-card px-3 py-2.5 text-sm shadow-2xs";
const property = "inline-flex min-w-0 items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground";
const runStatusLabel: Record<Data<"run.list">["items"][number]["status"], string> = {
  pending: "Pending", sent: "Awaiting outcome", uncertain: "Delivery uncertain", completed: "Completed", failed: "Failed",
};
const message = (error: unknown) => error instanceof Error ? error.message : "The request failed";
const when = (at: number, zone: string) => new Intl.DateTimeFormat("en", {
  timeZone: zone, dateStyle: "medium", timeStyle: "short",
}).format(at);

function EvidenceLinks({ links }: { links: string[] | undefined }) {
  if (!links?.length) return null;
  return <ul className="mt-1 space-y-1">{links.map((href, i) =>
    <li key={i}><a className="break-all underline" href={href} target="_blank" rel="noreferrer">{href}</a></li>)}</ul>;
}
function readRoute(subPath: string) {
  try {
    const parts = subPath.replace(/^\/+|\/+$/g, "").split("/").map(decodeURIComponent);
    const [projectId, second, third, fourth] = parts;
    if (projectId && second === "board" && third === "hidden" && parts.length <= 4) {
      return { projectId, proposalId: fourth, hidden: true, runs: false };
    }
    if (projectId && second === "review" && third === "runs" && parts.length === 3) {
      return { projectId, proposalId: undefined, hidden: false, runs: true };
    }
    if (parts.length > 2 || (parts.length === 2 && !projectId)) return null;
    return { projectId, proposalId: second, hidden: false, runs: false };
  } catch {
    return null;
  }
}

function JournalLink({ projectId, proposalId, hidden, ...props }: Omit<ComponentPropsWithoutRef<"a">, "href" | "onClick"> & {
  projectId?: string; proposalId?: string; hidden?: boolean;
}) {
  const navigate = useBbNavigate();
  const href = projectId && hidden ? hiddenColumnsPath(projectId, proposalId)
    : projectId && proposalId ? proposalPath(projectId, proposalId) : journalPath(projectId);
  const subPath = href.slice(journalPath().length + 1);
  return <a {...props} href={href} onClick={event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate.toPluginPanel("process-journal", { subPath });
  }} />;
}

function Journal({ subPath }: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const viewport = useRef<HTMLElement>(null);
  const [projects, setProjects] = useState<Projects>();
  const route = readRoute(subPath);
  const [error, setError] = useState("");
  const [stamp, setStamp] = useState(0);
  const refresh = useCallback(() => setStamp(at => at + 1), []);
  useRealtime("journal:changed", refresh);
  useEffect(() => {
    if (viewport.current) viewport.current.scrollTop = 0;
  }, [subPath]);
  useEffect(() => {
    let active = true;
    rpc.call("projects", {}).then(data => { if (active) { setProjects(data); setError(""); } },
      cause => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [rpc, stamp]);
  const current = route && (route.projectId ? projects?.find(p => p.id === route.projectId) : projects?.[0]);
  const unavailable = !route || Boolean(projects && route.projectId && !current);
  return <main ref={viewport} tabIndex={0} className="h-full min-h-0 w-full min-w-0 overflow-y-auto bg-surface-recessed-solid">
    {error && <p className="p-4 text-sm text-destructive" role="alert">{error} <button className={button} onClick={refresh}>Retry</button></p>}
    {!projects && !error && <p className="p-4 text-sm text-muted-foreground">Loading projects…</p>}
    {unavailable && <div className={`${panel} m-4`}>
      <p role="alert">{route ? "This project is unavailable in Process Journal." : "This Process Journal link is invalid."}</p>
      <JournalLink className="mt-2 inline-block underline">Back to Process Journal</JournalLink>
    </div>}
    {!unavailable && projects?.length === 0 && <p className="p-4 text-sm text-muted-foreground">Enable Process Journal for a project with <code>bb process-journal config</code>.</p>}
    {current && projects && <Workspace key={current.id} project={current} projects={projects}
      routeProposal={route?.proposalId} routeHidden={route?.hidden} routeRuns={route?.runs} stamp={stamp} refresh={refresh} />}
  </main>;
}

function Workspace({ project, projects, routeProposal, routeHidden, routeRuns, stamp, refresh }: {
  project: Projects[number]; projects: Projects; routeProposal?: string; routeHidden?: boolean; routeRuns?: boolean; stamp: number; refresh: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [manager, setManager] = useState("");
  const [tab, setTab] = useState<"board" | "history" | "runs">("board");
  const view = routeRuns ? "runs" : routeHidden ? "hidden" : tab;
  const inBoard = view === "board" || view === "hidden";
  const [columns, setColumns] = useState<BoardColumnDisplay[]>();
  const display = columns ?? defaultColumns;
  const hiddenColumns = display.filter(column => !column.visible);
  const label = (state: State) => displayName(state, display);
  const [range, setRange] = useState<Range>("quarter");
  const [state, setState] = useState<State | "">("");
  const [overdue, setOverdue] = useState(false);
  const [offset, setOffset] = useState(0);
  const [columnOffsets, setColumnOffsets] = useState<Partial<Record<BoardState, number>>>({});
  const [list, setList] = useState<Data<"list">>();
  const [digest, setDigest] = useState<Data<"digest">>();
  const [runs, setRuns] = useState<Data<"run.list">>();
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    rpc.call("config.get", { projectId: project.id, key: "boardDisplay" }).then(raw => {
      if (active) setColumns(boardDisplaySchema.parse(raw).columns ?? defaultColumns);
    }).catch(() => { if (active) setColumns(defaultColumns); });
    return () => { active = false; };
  }, [rpc, project.id, stamp]);

  useEffect(() => {
    if (routeProposal) return;
    let active = true;
    const target = { projectId: project.id, ...(manager ? { managerId: manager } : {}) };
    setError("");
    if (view === "runs") {
      setRuns(undefined);
      rpc.call("run.list", { ...target, offset }).then(data => {
        if (active) setRuns(data);
      }, cause => { if (active) setError(message(cause)); });
    } else if (view === "history") {
      setList(undefined);
      rpc.call("list", { ...target, view, range, offset, ...(state ? { state } : {}), overdue: false }).then(data => {
        if (active) setList(data);
      }, cause => { if (active) setError(message(cause)); });
    }
    if (view !== "runs") rpc.call("digest", target).then(data => { if (active) setDigest(data); },
      cause => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [rpc, view, project.id, manager, range, state, offset, stamp, routeProposal]);

  const backLabel = routeHidden ? "Back to hidden columns" : view === "history" ? "Back to history" : "Back to board";
  const toolbar = <header className="sticky top-0 z-10 flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border-hairline bg-background px-4 py-1.5">
    {routeProposal && <JournalLink projectId={project.id} hidden={routeHidden}
      aria-label={backLabel} title={backLabel}
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-state-hover focus-visible:outline focus-visible:outline-ring pointer-coarse:size-10">
      <Icon name="ArrowLeft" className="size-4" />
    </JournalLink>}
    <div className={control}>
      <span>Project</span>
      <JournalSelect label="Project" value={project.id} options={projects.map(p => ({ value: p.id, label: p.name }))}
        onChange={projectId => navigate.toPluginPanel("process-journal", { subPath: projectId })} />
    </div>
  </header>;

  if (routeProposal) return <>
    {toolbar}
    <div className="mx-auto max-w-5xl px-3 pb-5 pt-3 sm:px-4">
      <ProposalDetail key={routeProposal} project={project} id={routeProposal} columns={display} stamp={stamp} refresh={refresh} />
    </div>
  </>;

  const reset = () => {
    setOffset(0);
    setColumnOffsets({});
  };
  const name = (threadId: string) => project.managers.find(m => m.id === threadId)?.name ?? threadId;
  function proposalCard(row: ProposalRow) {
    const p = row.proposal, late = row.overdue;
    const review = reviewBadge(p, row.review);
    return <JournalLink key={p.id} projectId={project.id} proposalId={p.id} hidden={routeHidden}
      className={`${cardSurface} block text-left transition-colors hover:border-input hover:bg-state-hover focus-visible:outline focus-visible:outline-ring`}>
      <strong className="block break-words text-sm font-medium leading-snug">{p.title}</strong>
      <span className="mt-1 block break-words text-xs leading-snug text-muted-foreground">{row.entry.title}</span>
      <span className="mt-2 flex flex-wrap items-center gap-1.5">
        {view === "history" && <span className={property}><StatusMark state={p.state} display={display.find(column => column.id === p.state)} />{label(p.state)}</span>}
        <span className={property}><span className="min-w-0 break-words">{name(p.managerId)}</span></span>
        {review && <span className={property}>{review}</span>}
        <span className={`${property} ${late ? "border-destructive/30 font-medium text-destructive" : ""}`}>
          <Icon name="Clock" className="size-3 shrink-0" />
          <span>{late ? "Overdue" : isOpen(p.state) ? "Due" : "Closed"} · {when(row.nextAt, project.timeZone)}</span>
        </span>
      </span>
    </JournalLink>;
  }

  return <>
    {toolbar}
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border-hairline bg-background px-4 py-2">
      <nav className="flex max-w-full flex-wrap items-center rounded-md bg-muted p-0.5" aria-label="Journal views">
        {(["board", "history", "runs"] as const).map(next =>
          <button className={`rounded-sm px-2.5 py-1 text-xs font-medium focus-visible:outline focus-visible:outline-ring ${(view === next || view === "hidden" && next === "board") ? "bg-background text-foreground shadow-2xs" : "text-muted-foreground hover:text-foreground"}`} key={next} type="button"
            aria-pressed={view === next || view === "hidden" && next === "board"} onClick={() => {
              setTab(next);
              reset();
              if (routeHidden || routeRuns && next !== "runs") navigate.toPluginPanel("process-journal", { subPath: project.id });
            }}>
            {next === "runs" ? "Review runs" : next === "history" ? "History" : "Board"}
          </button>)}
      </nav>
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <div className={control}>
          <span>Manager</span>
          <JournalSelect label="Manager" value={manager} options={[
            { value: "", label: "All managers" },
            ...project.managers.map(m => ({ value: m.id, label: m.reachable ? m.name : `${m.name} (unavailable)` })),
          ]} onChange={managerId => { setManager(managerId); reset(); }} />
        </div>
        {inBoard && <label className={`${control} min-h-8 cursor-pointer`}>
          <JournalCheckbox checked={overdue} onChange={event => { setOverdue(event.target.checked); reset(); }} /> Overdue only
        </label>}
        {view === "board" && hiddenColumns.length > 0 && <JournalLink projectId={project.id} hidden className={button}>Hidden columns</JournalLink>}
      </div>
    </div>
    {view !== "runs" && <section aria-label="Weekly digest" className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border-hairline bg-background px-4 py-2 text-xs">
      <h2 className="font-medium text-muted-foreground">Weekly digest</h2>
      <dl className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {(["applied", "kept", "reverted", "overdue"] as const).map(key => <div key={key} className="flex items-center gap-1.5">
          <dt className="text-muted-foreground">{key === "overdue" ? "Overdue" : label(key)}</dt>
          <dd className={`font-medium tabular-nums ${key === "overdue" && digest?.overdue ? "text-destructive" : ""}`}>{digest?.[key] ?? "…"}</dd>
        </div>)}
      </dl>
    </section>}
    {error && <p role="alert" className="px-4 pt-2 text-sm text-destructive">{error} <button className={button} onClick={refresh}>Retry</button></p>}
    {view === "runs" ? <section className="mx-auto max-w-5xl space-y-3 px-4 pb-5 pt-3" aria-label="Review runs">
      <p className="text-sm text-muted-foreground">See when this project’s automatic proposal reviews ran and how they ended.</p>
      {!runs && !error && <p className="py-2 text-sm text-muted-foreground">Loading review runs…</p>}
      {runs?.items.length === 0 && <p className="py-2 text-sm text-muted-foreground">No review runs to show.</p>}
      {!!runs?.items.length && <ul className="space-y-2">{runs.items.map(run =>
        <li className={`${cardSurface} space-y-1.5`} key={run.id}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <time className="font-medium tabular-nums" dateTime={run.occurrence}>{run.occurrence}</time>
            <span className={`${property} ${run.delayed || run.status === "failed" ? "border-destructive/30 text-destructive" : ""}`}>
              {runStatusLabel[run.status]}{run.delayed && " · overdue"}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">{name(run.managerId)}</p>
          {run.note && <div className={detailText}><Markdown content={run.note} /></div>}
          <code className="block break-all text-xs text-muted-foreground">{run.id}</code>
        </li>)}</ul>}
      <Pages offset={offset} next={runs?.nextOffset} setOffset={setOffset} />
    </section> : inBoard ?
      <section className={view === "hidden" ? "px-4 py-3" : ""} aria-label={view === "hidden" ? "Hidden columns" : undefined}>
        {view === "hidden" && <h2 className="text-sm font-semibold">Hidden columns</h2>}
        {!columns ? <p className="p-4 text-sm text-muted-foreground">Loading status display…</p>
          : view === "hidden" && !hiddenColumns.length ? <p className="py-3 text-sm text-muted-foreground">No hidden columns.</p>
          : view === "board" && hiddenColumns.length === columns.length ? <div className="space-y-2 p-4 text-sm">
            <p>All board columns are hidden.</p>
            <a className="underline" href={settingsPath}>Open Process Journal settings</a>
          </div>
          : <div className={view === "hidden" ? "grid gap-4 py-3 lg:grid-cols-2" : "flex min-w-0 items-start gap-3 overflow-x-auto p-4 focus-visible:outline focus-visible:-outline-offset-2 focus-visible:outline-ring"}
              tabIndex={view === "board" ? 0 : undefined} role="region" aria-label={view === "board" ? "Status columns" : "Hidden status lists"}>
            {(view === "hidden" ? hiddenColumns : columns.filter(column => column.visible)).map(column =>
              <BoardColumn key={column.id} column={column} hiddenView={view === "hidden"} projectId={project.id} manager={manager}
                overdue={overdue} stamp={stamp} refresh={refresh} offset={columnOffsets[column.id] ?? 0}
                setOffset={next => setColumnOffsets(previous => ({ ...previous, [column.id]: next }))} renderCard={proposalCard} />)}
          </div>}
      </section> : <section className="mx-auto max-w-5xl px-4 pb-5 pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Proposal history</h2>
          <div className="flex flex-wrap gap-2">
            <div className={control}>
              <span>Range</span>
              <JournalSelect label="Range" value={range} options={ranges}
                onChange={next => { setRange(next); reset(); }} />
            </div>
            <div className={control}>
              <span>Status</span>
              <JournalSelect<State | ""> label="Status" value={state} options={[
                { value: "", label: "All statuses" }, ...states.map(value => ({ value, label: label(value) })),
              ]} onChange={next => { setState(next); reset(); }} />
            </div>
          </div>
        </div>
        {!list && !error && <p className="mt-3 text-sm text-muted-foreground">Loading proposals…</p>}
        {list?.items.length === 0 && <p className="mt-3 text-sm text-muted-foreground">No matching proposals.</p>}
        <div className="mt-3 grid gap-2">{list?.items.map(proposalCard)}</div>
        <Pages offset={offset} next={list?.nextOffset} setOffset={setOffset} />
      </section>}
  </>;
}

function BoardColumn({ column, hiddenView, projectId, manager, overdue, stamp, refresh, offset, setOffset, renderCard }: {
  column: BoardColumnDisplay; hiddenView: boolean; projectId: string; manager: string; overdue: boolean; stamp: number; refresh: () => void;
  offset: number; setOffset: (offset: number) => void; renderCard: (row: ProposalRow) => ReactNode;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [list, setList] = useState<Data<"list">>();
  const [error, setError] = useState("");
  const status = column.id;
  const open = isOpen(status);
  const hiddenByOverdue = overdue && !open;
  useEffect(() => {
    if (hiddenByOverdue) return;
    let active = true;
    setList(undefined);
    setError("");
    rpc.call("list", { projectId, ...(manager ? { managerId: manager } : {}), state: status,
      view: open ? "board" : "history", range: "quarter", offset, overdue, ...(hiddenView ? { withTotal: true } : {}) }).then(data => {
      if (active) setList(data);
    }, cause => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [rpc, projectId, manager, status, open, overdue, hiddenByOverdue, hiddenView, offset, stamp]);
  return <section className={hiddenView ? "min-w-0" : "min-w-[13.5rem] flex-1 basis-60"} aria-label={column.name}>
    <div className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-0.5 px-1 pb-2">
      <StatusMark state={status} display={column} />
      <h3 className="text-sm font-semibold [overflow-wrap:anywhere]">{column.name}</h3>
      {hiddenView && <span className={property}>{hiddenByOverdue ? 0 : list?.total ?? "…"} proposals</span>}
      {!open && <p className="text-xs text-muted-foreground">Last 3 months</p>}
    </div>
    <div className={`space-y-2 p-1 ${!hiddenByOverdue && list?.items.length ? "rounded-lg bg-muted/35" : ""}`}>
      {hiddenByOverdue ? <p className="px-2 py-2 text-xs text-muted-foreground">No overdue proposals.</p> : <>
        {error && <p role="alert" className="text-xs">{error} <button className={button} onClick={refresh}>Retry</button></p>}
        {!list && !error && <p className="px-2 py-2 text-xs text-muted-foreground">Loading proposals…</p>}
        {list?.items.length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground">No proposals.</p>}
        {list?.items.map(renderCard)}
        <Pages offset={offset} next={list?.nextOffset} setOffset={setOffset} />
      </>}
    </div>
  </section>;
}

function Pages({ offset, next, setOffset }: { offset: number; next?: number | null; setOffset: (offset: number) => void }) {
  if (!offset && next == null) return null;
  return <div className="mt-3 flex gap-2">
    <button className={button} type="button" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 25))}>Previous</button>
    <button className={button} type="button" disabled={next == null} onClick={() => { if (next != null) setOffset(next); }}>Next</button>
  </div>;
}

function ProposalDetail({ project, id, columns, stamp, refresh }: { project: Projects[number]; id: string; columns: BoardColumnDisplay[]; stamp: number; refresh: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [detail, setDetail] = useState<Detail>();
  const [extra, setExtra] = useState<Detail["events"]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [comment, setComment] = useState("");
  const [reason, setReason] = useState("");
  const [decision, setDecision] = useState<"kept" | "reverted" | "">("");
  const [override, setOverride] = useState(false);
  const ref = { projectId: project.id, proposalId: id };
  useEffect(() => {
    let active = true;
    setLoadError("");
    rpc.call("proposal.detail", { projectId: project.id, proposalId: id }).then(data => {
      if (active) { setDetail(data); setExtra([]); setCursor(data.nextBefore); }
    }, cause => { if (active) setLoadError(message(cause)); });
    return () => { active = false; };
  }, [rpc, project.id, id, stamp]);
  async function mutate(run: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try { await run(); refresh(); }
    catch (cause) { setError(message(cause)); refresh(); }
    finally { setBusy(false); }
  }
  if (!detail) return <section className={panel} aria-label="Proposal detail">
    {loadError ? <p role="alert">{loadError} <button className={button} onClick={refresh}>Retry</button></p> : <p>Loading proposal…</p>}
  </section>;
  const { entry, proposal: p } = detail;
  const canKeep = detail.measured && detail.review?.result?.status === "approved";
  const edit = { ...ref, revision: p.revision };
  const timeline = [...detail.events, ...extra];
  const observations = timeline.filter(event => event.observation);
  const names = new Map(project.managers.map(m => [m.id, m.name]));
  const date = (value: number) => when(value, project.timeZone);
  const close = (event: FormEvent) => {
    event.preventDefault();
    if (!decision) return;
    void mutate(async () => {
      await rpc.call("proposal.transition", { ...edit, transition: decision === "reverted"
        ? { state: decision, reason, override } : { state: decision, reason } });
      setDecision(""); setReason(""); setOverride(false);
    });
  };
  return <section className="@container space-y-3" aria-label="Proposal detail">
    <header className={detailPanel}>
      <h2 className="break-words text-2xl font-semibold leading-tight">{p.title}</h2>
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary px-2.5 py-0.5 text-xs font-medium">
          <StatusMark state={p.state} display={columns.find(column => column.id === p.state)} />{displayName(p.state, columns)}
        </span>
        <a className="rounded-md px-1.5 py-0.5 text-xs text-muted-foreground underline hover:text-foreground" href={proposalPath(project.id, id)}>Proposal link</a>
      </div>
      <ProposalDates proposal={p} timeZone={project.timeZone} linked={detail.links.some(link => link.deadlineSource)}
        disabled={busy} refresh={refresh} date={date}>
        <div className="min-w-0">
          <dt className="mb-0.5 text-xs text-muted-foreground">Assigned manager</dt>
          <dd>
            <JournalSelect label="Assigned manager" disabled={busy || !isOpen(p.state)} value={p.managerId} options={[
              ...(!names.has(p.managerId) ? [{ value: p.managerId, label: p.managerId }] : []),
              ...project.managers.map(m => ({ value: m.id, label: m.reachable ? m.name : `${m.name} (unavailable)`, disabled: !m.reachable })),
            ]} onChange={managerId => void mutate(() => rpc.call("proposal.update", { ...edit, patch: { managerId } }))} />
          </dd>
        </div>
      </ProposalDates>
      {!detail.managerReachable && <p className="text-xs text-destructive">Assigned manager is unavailable.</p>}
    </header>
    {loadError && <p role="alert" className="mt-2 text-sm text-destructive">
      {loadError} <button className={button} onClick={refresh}>Retry</button>
    </p>}
    {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}

    <div className="grid min-w-0 items-start gap-3 @[48rem]:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="min-w-0 space-y-3">
        <section className={detailPanel} aria-label="Process failure">
          <h3 className={detailHeading}>Process failure</h3>
          <div className={`${detailText} space-y-1`}>
            <h4 className="font-medium">{entry.title}</h4>
            <Markdown content={entry.failure} />
          </div>
          <div className={detailCallout}>
            <h4 className="font-medium">Process gap</h4>
            <div className={detailText}><Markdown content={entry.gap} /></div>
          </div>
          <EvidenceLinks links={entry.links} />
        </section>
        <section className={detailPanel} aria-label="Fix hypothesis">
          <h3 className={detailHeading}>Fix hypothesis</h3>
          <div className={detailText}><Markdown content={p.hypothesis} /></div>
          <div className={detailCallout}>
            <h4 className="font-medium">Rollback condition</h4>
            <div className={detailText}><Markdown content={p.rollbackCondition} /></div>
          </div>
          <EvidenceLinks links={p.links} />
          {detail.links.map(link => <div key={link.taskId} className="rounded-md border border-border-hairline p-2.5">
            <a href={cardPath(link.key)} className="underline">{link.key}</a> · {link.status}{link.dueDate && ` · Due ${link.dueDate}`}
            {link.conflict && <div className="mt-1 flex flex-wrap items-center gap-2 text-destructive">
              Deadline conflict
              <button className={button} disabled={busy} onClick={() => void mutate(() =>
                rpc.call("fix.resolveDeadline", { ...edit, taskId: link.taskId, prefer: "journal" }))}>Use journal date</button>
              <button className={button} disabled={busy || !link.dueDate} onClick={() => void mutate(() =>
                rpc.call("fix.resolveDeadline", { ...edit, taskId: link.taskId, prefer: "card" }))}>Use card date</button>
            </div>}
          </div>)}
        </section>
      </div>
      <section className={detailPanel} aria-label="Metric history">
        <h3 className={detailHeading}>Metric history</h3>
        <div className={detailText}><Markdown content={p.metric.definition} /></div>
        {(p.metric.baseline !== undefined || p.metric.target !== undefined) && <dl className="grid grid-cols-2 gap-2">
          {([["baseline", "Baseline"], ["target", "Target"]] as const).map(([key, label]) => <div className="min-w-0 rounded-md border border-border-hairline bg-muted/35 p-2.5" key={key}>
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="break-words text-base font-semibold tabular-nums">
              {p.metric[key] ?? "Unset"} {p.metric[key] !== undefined && p.metric.unit}
            </dd>
          </div>)}
        </dl>}
        {!observations.length ? <p className="text-muted-foreground">No observations on this page.</p> :
          <ul className="space-y-2">{observations.map(event => <li key={event.seq} className={`${detailText} rounded-md border border-border-hairline p-2.5`}>
            <p className="text-xs text-muted-foreground">Observation #{event.seq} · {date(event.at)} · {event.message}</p>
            {event.observation?.value !== undefined && <strong>{event.observation.value} {event.unit}</strong>}
            {event.observation?.note && <Markdown content={event.observation.note} />}
            <EvidenceLinks links={event.observation?.evidence} />
          </li>)}</ul>}
      </section>
    </div>
    {detail.review && <ReviewPanel className={detailPanel} summary={detail.review} rounds={detail.reviewRounds ?? []} date={date} />}
    {(p.state === "measuring" || p.state === "applied") && <section className={detailPanel} aria-label="Decision">
      <h3 className={detailHeading}>Decision</h3>
      <form onSubmit={close}>
        <div className="flex gap-2">
          {p.state === "measuring" && <button type="button" className={button} aria-pressed={decision === "kept"}
            disabled={!canKeep} onClick={() => { setDecision("kept"); setOverride(false); }}>Keep</button>}
          <button type="button" className={button} aria-pressed={decision === "reverted"}
            onClick={() => setDecision("reverted")}>Revert</button>
        </div>
        {p.state === "measuring" && detail.measured && !canKeep &&
          <p className="mt-2 text-xs text-muted-foreground">An independent result approval is required to keep this proposal.</p>}
        {decision && <div className="mt-2 space-y-2">
          <label className="block">Reason
            <textarea className={`${input} mt-1 block w-full`} required maxLength={8000} value={reason} onChange={event => setReason(event.target.value)} />
          </label>
          {decision === "reverted" && !detail.measured && <label className="flex min-h-8 cursor-pointer items-center gap-2">
            <JournalCheckbox checked={override} onChange={event => setOverride(event.target.checked)} /> Urgent rollback before measurement
          </label>}
          <button className={button} disabled={busy || !reason.trim() || (decision === "kept" ? !canKeep : !detail.measured && !override)}>
            {decision === "kept" ? "Confirm keep" : "Record rollback decision"}
          </button>
        </div>}
      </form>
    </section>}
    <section className={detailPanel} aria-label="Timeline">
      <h3 className={detailHeading}>Timeline</h3>
      <ol className="space-y-2">{timeline.map(event => <li key={event.seq} className="space-y-1.5 rounded-md border border-border-hairline bg-muted/20 p-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="min-w-0 break-words text-xs font-medium">{names.get(event.actor) ?? event.actor}</span>
          <time className="text-xs text-muted-foreground" dateTime={new Date(event.at).toISOString()}>{date(event.at)}</time>
        </div>
        {event.state && <strong className="flex items-center gap-1.5 text-sm font-medium"><StatusMark state={event.state} display={columns.find(column => column.id === event.state)} />{displayName(event.state, columns)}</strong>}
        {event.state && isOpen(event.state) && event.deadlineAt !== undefined &&
          <p className="text-xs text-muted-foreground">Deadline · {date(event.deadlineAt)}</p>}
        {event.checkAt != null && <p className="text-xs text-muted-foreground">Measurement check · {date(event.checkAt)}</p>}
        <div className={detailText}><Markdown content={event.message} /></div>
      </li>)}</ol>
      {cursor != null && <button className={button} disabled={busy} onClick={() => {
        setBusy(true);
        rpc.call("proposal.detail", { ...ref, before: cursor }).then(data => {
          setExtra(previous => [...previous, ...data.events]); setCursor(data.nextBefore);
        }, cause => setError(message(cause))).finally(() => setBusy(false));
      }}>Older timeline entries</button>}
      <form className="space-y-2 border-t border-border-hairline pt-3" onSubmit={event => {
        event.preventDefault();
        void mutate(async () => { await rpc.call("proposal.comment", { ...ref, body: comment }); setComment(""); });
      }}>
        <label className="block font-medium" htmlFor="proposal-comment">Comment</label>
        <textarea id="proposal-comment" className={`${input} block min-h-20 w-full resize-y`} required maxLength={8000} value={comment}
          onChange={event => setComment(event.target.value)} />
        <button className={button} disabled={busy || !comment.trim()}>Post comment</button>
      </form>
    </section>
  </section>;
}

export default definePluginApp(app => {
  app.slots.settingsSection({ id: "settings", title: "Process Journal", component: JournalSettings });
  app.slots.navPanel({ id: "process-journal", path: "process-journal", title: "Process Journal", icon: "process-journal/book-open", component: Journal });
});
