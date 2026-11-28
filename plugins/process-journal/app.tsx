import { useCallback, useEffect, useRef, useState, type ComponentPropsWithoutRef, type FormEvent, type ReactNode } from "react";
import { definePluginApp, experimental_Icon as Icon, Markdown, useBbNavigate, useRealtime, useRpc, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import type { methods, rpcContract } from "./contract";
import { isOpen, openStates, states, type State } from "./states";
import { cardPath, journalPath, proposalPath } from "./paths";

type Data<K extends keyof typeof methods> = z.infer<typeof methods[K]["output"]>;
type Projects = Data<"projects">;
type Detail = Data<"proposal.detail">;
type ProposalRow = Data<"list">["items"][number];
type Range = "week" | "month" | "quarter";
const boardStates = [...openStates, "kept", "reverted"] as const;
type BoardState = typeof boardStates[number];
const input = "min-w-0 max-w-full rounded-md border border-border bg-background px-2 py-1 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring";
const button = input + " hover:bg-muted disabled:opacity-50";
const panel = "min-w-0 rounded-lg border border-border bg-card p-4";
const control = "flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground";
const property = "inline-flex min-w-0 items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground";
const statusColor: Record<State, string> = {
  proposed: "text-muted-foreground", applied: "text-blue-500", measuring: "text-amber-500",
  kept: "text-emerald-500", reverted: "text-rose-500", withdrawn: "text-muted-foreground",
};
const statusLabel = (state: State) => state[0]!.toUpperCase() + state.slice(1);
const message = (error: unknown) => error instanceof Error ? error.message : "The request failed";
const when = (at: number, zone: string) => new Intl.DateTimeFormat("en", {
  timeZone: zone, dateStyle: "medium", timeStyle: "short",
}).format(at);

function StatusMark({ state }: { state: State }) {
  return <span aria-hidden="true" className={`inline-flex size-3.5 shrink-0 items-center justify-center rounded-full border border-current ${statusColor[state]} ${state === "proposed" ? "border-dashed" : ""}`}>
    {state !== "proposed" && <span className="size-1.5 rounded-full bg-current" />}
  </span>;
}

function EvidenceLinks({ links }: { links: string[] | undefined }) {
  if (!links?.length) return null;
  return <ul className="mt-1 space-y-1">{links.map((href, i) =>
    <li key={i}><a className="break-all underline" href={href} target="_blank" rel="noreferrer">{href}</a></li>)}</ul>;
}
function readRoute(subPath: string) {
  try {
    const parts = subPath.replace(/^\/+|\/+$/g, "").split("/").map(decodeURIComponent);
    if (parts.length > 2 || (parts.length === 2 && !parts[0])) return null;
    const [projectId, proposalId] = parts;
    return { projectId, proposalId };
  } catch {
    return null;
  }
}

function JournalLink({ projectId, proposalId, ...props }: Omit<ComponentPropsWithoutRef<"a">, "href" | "onClick"> & {
  projectId?: string; proposalId?: string;
}) {
  const navigate = useBbNavigate();
  const subPath = projectId ? [projectId, ...(proposalId ? [proposalId] : [])].map(encodeURIComponent).join("/") : "";
  return <a {...props} href={projectId && proposalId ? proposalPath(projectId, proposalId) : journalPath(projectId)} onClick={event => {
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
      routeProposal={route?.proposalId} stamp={stamp} refresh={refresh} />}
  </main>;
}

function Workspace({ project, projects, routeProposal, stamp, refresh }: {
  project: Projects[number]; projects: Projects; routeProposal?: string; stamp: number; refresh: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [manager, setManager] = useState("");
  const [view, setView] = useState<"board" | "history" | "runs">("board");
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
    rpc.call("digest", target).then(data => { if (active) setDigest(data); },
      cause => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [rpc, view, project.id, manager, range, state, offset, stamp, routeProposal]);

  const toolbar = <header className="sticky top-0 z-10 flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border-hairline bg-background px-4 py-1.5">
    {routeProposal && <JournalLink projectId={project.id}
      className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 text-sm font-medium hover:bg-state-hover focus-visible:outline focus-visible:outline-ring">
      <Icon name="ArrowLeft" className="size-4 shrink-0" />
      {view === "history" ? "Back to history" : "Back to board"}
    </JournalLink>}
    <label className={control}>Project
      <select className={`${input} font-medium text-foreground`} value={project.id} onChange={event =>
        navigate.toPluginPanel("process-journal", { subPath: event.target.value })}>
        {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    </label>
  </header>;

  if (routeProposal) return <>
    {toolbar}
    <div className="mx-auto max-w-5xl px-3 pb-5 pt-3 sm:px-4">
      <ProposalDetail key={routeProposal} project={project} id={routeProposal} stamp={stamp} refresh={refresh} />
    </div>
  </>;

  const reset = () => {
    setOffset(0);
    setColumnOffsets({});
  };
  const name = (threadId: string) => project.managers.find(m => m.id === threadId)?.name ?? threadId;
  function proposalCard(row: ProposalRow) {
    const p = row.proposal, late = row.overdue;
    return <JournalLink key={p.id} projectId={project.id} proposalId={p.id}
      className="block min-w-0 rounded-lg border border-border bg-card px-3 py-2.5 text-left shadow-2xs transition-colors hover:border-input hover:bg-state-hover focus-visible:outline focus-visible:outline-ring">
      <strong className="block break-words text-sm font-medium leading-snug">{p.title}</strong>
      <span className="mt-1 block break-words text-xs leading-snug text-muted-foreground">{row.entry.title}</span>
      <span className="mt-2 flex flex-wrap items-center gap-1.5">
        {view === "history" && <span className={property}><StatusMark state={p.state} />{statusLabel(p.state)}</span>}
        <span className={property}><span className="min-w-0 break-words">{name(p.managerId)}</span></span>
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
          <button className={`rounded-sm px-2.5 py-1 text-xs font-medium focus-visible:outline focus-visible:outline-ring ${view === next ? "bg-background text-foreground shadow-2xs" : "text-muted-foreground hover:text-foreground"}`} key={next} type="button"
            aria-pressed={view === next} onClick={() => { setView(next); reset(); }}>
            {next === "runs" ? "Scheduled reviews" : next === "history" ? "History" : "Board"}
          </button>)}
      </nav>
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <label className={control}>Manager
          <select className={input} value={manager} onChange={event => { setManager(event.target.value); reset(); }}>
            <option value="">All managers</option>
            {project.managers.map(m => <option key={m.id} value={m.id}>{m.name}{m.reachable ? "" : " (unavailable)"}</option>)}
          </select>
        </label>
        {view === "board" && <label className={control}>
          <input type="checkbox" checked={overdue} onChange={event => { setOverdue(event.target.checked); reset(); }} /> Overdue only
        </label>}
      </div>
    </div>
    <section aria-label="Weekly digest" className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border-hairline bg-background px-4 py-2 text-xs">
      <h2 className="font-medium text-muted-foreground">Weekly digest</h2>
      <dl className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {(["applied", "kept", "reverted", "overdue"] as const).map(key => <div key={key} className="flex items-center gap-1.5">
          <dt className="capitalize text-muted-foreground">{key}</dt>
          <dd className={`font-medium tabular-nums ${key === "overdue" && digest?.overdue ? "text-destructive" : ""}`}>{digest?.[key] ?? "…"}</dd>
        </div>)}
      </dl>
    </section>
    {error && <p role="alert" className="px-4 pt-2 text-sm text-destructive">{error} <button className={button} onClick={refresh}>Retry</button></p>}
    {view === "runs" ? <section className={`${panel} mx-4 my-3`}>
      <h2 className="mb-3 text-lg font-semibold">Scheduled reviews</h2>
      {!runs && !error && <p>Loading reviews…</p>}
      {runs?.items.length === 0 && <p>No scheduled reviews on this page.</p>}
      <ul className="space-y-2">{runs?.items.map(run =>
        <li className="rounded border border-border p-2 text-sm" key={run.id}>
          <strong>{run.occurrence}</strong> · {name(run.managerId)} · {run.status}{run.delayed ? " · overdue, awaiting outcome" : ["pending", "sent", "uncertain"].includes(run.status) && " · awaiting outcome"}
          <p className="break-all text-xs text-muted-foreground">{run.id}</p>
          {run.note && <Markdown content={run.note} />}
        </li>)}</ul>
      <Pages offset={offset} next={runs?.nextOffset} setOffset={setOffset} />
    </section> : view === "board" ?
      <div className="flex min-w-0 items-start gap-3 overflow-x-auto p-4 focus-visible:outline focus-visible:-outline-offset-2 focus-visible:outline-ring"
        tabIndex={0} role="region" aria-label="Status columns">
        {boardStates.map(status => <BoardColumn key={status} status={status} projectId={project.id} manager={manager}
          overdue={overdue} stamp={stamp} refresh={refresh} offset={columnOffsets[status] ?? 0}
          setOffset={next => setColumnOffsets(previous => ({ ...previous, [status]: next }))} renderCard={proposalCard} />)}
      </div> : <section className="mx-auto max-w-5xl px-4 pb-5 pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Proposal history</h2>
          <div className="flex flex-wrap gap-2">
            <label className={control}>Range
              <select className={input} value={range} onChange={event => { setRange(event.target.value as Range); reset(); }}>
                <option value="week">Last 7 days</option><option value="month">Last month</option><option value="quarter">Last 3 months</option>
              </select>
            </label>
            <label className={control}>Status
              <select className={input} value={state} onChange={event => { setState(event.target.value as State | ""); reset(); }}>
                <option value="">All statuses</option>{states.map(item => <option key={item} value={item}>{statusLabel(item)}</option>)}
              </select>
            </label>
          </div>
        </div>
        {!list && !error && <p className="mt-3 text-sm text-muted-foreground">Loading proposals…</p>}
        {list?.items.length === 0 && <p className="mt-3 text-sm text-muted-foreground">No matching proposals.</p>}
        <div className="mt-3 grid gap-2">{list?.items.map(proposalCard)}</div>
        <Pages offset={offset} next={list?.nextOffset} setOffset={setOffset} />
      </section>}
  </>;
}

function BoardColumn({ status, projectId, manager, overdue, stamp, refresh, offset, setOffset, renderCard }: {
  status: BoardState; projectId: string; manager: string; overdue: boolean; stamp: number; refresh: () => void;
  offset: number; setOffset: (offset: number) => void; renderCard: (row: ProposalRow) => ReactNode;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [list, setList] = useState<Data<"list">>();
  const [error, setError] = useState("");
  const open = isOpen(status);
  const hiddenByOverdue = overdue && !open;
  useEffect(() => {
    if (hiddenByOverdue) return;
    let active = true;
    setList(undefined);
    setError("");
    rpc.call("list", { projectId, ...(manager ? { managerId: manager } : {}), state: status,
      view: open ? "board" : "history", range: "quarter", offset, overdue }).then(data => {
      if (active) setList(data);
    }, cause => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [rpc, projectId, manager, status, open, overdue, hiddenByOverdue, offset, stamp]);
  return <section className="min-w-[13.5rem] flex-1 basis-60" aria-label={statusLabel(status)}>
    <div className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-0.5 px-1 pb-2">
      <StatusMark state={status} />
      <h3 className="text-sm font-semibold">{statusLabel(status)}</h3>
      {!open && <p className="text-xs text-muted-foreground">Last 3 months</p>}
    </div>
    <div className="space-y-2 rounded-lg bg-muted/35 p-1">
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

function ProposalDetail({ project, id, stamp, refresh }: { project: Projects[number]; id: string; stamp: number; refresh: () => void }) {
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
  return <section className="min-w-0 rounded-lg border border-border bg-card px-4 pb-6 pt-5 shadow-2xs sm:px-7 sm:pt-7" aria-label="Proposal detail">
    <header className="space-y-3">
      <h2 className="break-words text-2xl font-semibold leading-tight">{p.title}</h2>
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary px-2.5 py-0.5 text-xs font-medium">
          <StatusMark state={p.state} />{statusLabel(p.state)}
        </span>
        <a className="rounded-md px-1.5 py-0.5 text-xs text-muted-foreground underline hover:text-foreground" href={proposalPath(project.id, id)}>Proposal link</a>
      </div>
      <dl className="flex flex-wrap items-start gap-x-6 gap-y-3 rounded-md border border-border-hairline bg-muted/25 px-3 py-2.5 text-sm">
        <div className="min-w-0">
          <dt className="mb-0.5 text-xs text-muted-foreground">Assigned manager</dt>
          <dd>
            <select aria-label="Assigned manager" className={input} disabled={busy || !isOpen(p.state)} value={p.managerId}
              onChange={event => {
                const managerId = event.target.value;
                void mutate(() => rpc.call("proposal.update", { ...edit, patch: { managerId } }));
              }}>
              {!names.has(p.managerId) && <option value={p.managerId}>{p.managerId}</option>}
              {project.managers.map(m => <option key={m.id} value={m.id} disabled={!m.reachable}>{m.name}{m.reachable ? "" : " (unavailable)"}</option>)}
            </select>
          </dd>
        </div>
        <div>
          <dt className="mb-0.5 text-xs text-muted-foreground">{isOpen(p.state) ? "Deadline" : "Closed"}</dt>
          <dd className="py-1">{date(p.deadlineAt)}</dd>
        </div>
        {p.checkAt !== null && <div>
          <dt className="mb-0.5 text-xs text-muted-foreground">Measurement check</dt>
          <dd className="py-1">{date(p.checkAt)}</dd>
        </div>}
      </dl>
      {!detail.managerReachable && <p className="text-xs text-destructive">Assigned manager is unavailable.</p>}
    </header>
    {loadError && <p role="alert" className="mt-2 text-sm text-destructive">
      {loadError} <button className={button} onClick={refresh}>Retry</button>
    </p>}
    {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}

    <div className="mt-5 space-y-5 text-sm">
      <section className="space-y-1.5">
        <h3 className="font-semibold">{entry.title}</h3>
        <Markdown content={entry.failure} />
        <h4 className="mt-2 font-medium">Process gap</h4>
        <Markdown content={entry.gap} />
        <EvidenceLinks links={entry.links} />
      </section>
      <section className="space-y-1.5 border-t border-border-hairline pt-4">
        <h3 className="font-semibold">Fix hypothesis</h3>
        <Markdown content={p.hypothesis} />
        <h4 className="mt-2 font-medium">Rollback condition</h4>
        <Markdown content={p.rollbackCondition} />
        <EvidenceLinks links={p.links} />
        {detail.links.map(link => <div key={link.taskId} className="mt-2">
          <a href={cardPath(link.key)} className="underline">{link.key}</a> · {link.status}{link.dueDate && ` · Due ${link.dueDate}`}
          {link.conflict && <div className="flex flex-wrap items-center gap-2 text-destructive">
            Deadline conflict
            <button className={button} disabled={busy} onClick={() => void mutate(() =>
              rpc.call("fix.resolveDeadline", { ...edit, taskId: link.taskId, prefer: "journal" }))}>Use journal date</button>
            <button className={button} disabled={busy || !link.dueDate} onClick={() => void mutate(() =>
              rpc.call("fix.resolveDeadline", { ...edit, taskId: link.taskId, prefer: "card" }))}>Use card date</button>
          </div>}
        </div>)}
      </section>
      <section className="space-y-1.5 border-t border-border-hairline pt-4">
        <h3 className="font-semibold">Metric history</h3>
        <Markdown content={p.metric.definition} />
        {(p.metric.baseline !== undefined || p.metric.target !== undefined) && <dl className="my-2 grid grid-cols-2 gap-2">
          <div><dt>Baseline</dt><dd>{p.metric.baseline ?? "Unset"} {p.metric.baseline !== undefined && p.metric.unit}</dd></div>
          <div><dt>Target</dt><dd>{p.metric.target ?? "Unset"} {p.metric.target !== undefined && p.metric.unit}</dd></div>
        </dl>}
        {!observations.length && <p className="text-muted-foreground">No observations on this page.</p>}
        <ul className="space-y-2">{observations.map(event => <li key={event.seq}>
          <p className="text-xs text-muted-foreground">{date(event.at)} · {event.message}</p>
          {event.observation?.value !== undefined && <strong>{event.observation.value} {event.unit}</strong>}
          {event.observation?.note && <Markdown content={event.observation.note} />}
          <EvidenceLinks links={event.observation?.evidence} />
        </li>)}</ul>
      </section>
      <section className="border-t border-border-hairline pt-4">
        <h3 className="font-semibold">Timeline</h3>
        <ol className="mt-2 divide-y divide-border-hairline">{timeline.map(event => <li key={event.seq} className="space-y-0.5 py-2">
          <p className="text-xs text-muted-foreground">{date(event.at)} · {names.get(event.actor) ?? event.actor}</p>
          {event.state && <strong className="flex items-center gap-1.5 text-sm font-medium"><StatusMark state={event.state} />{statusLabel(event.state)}</strong>}
          {event.state && isOpen(event.state) && event.deadlineAt !== undefined &&
            <p className="text-xs text-muted-foreground">Deadline · {date(event.deadlineAt)}</p>}
          {event.checkAt != null && <p className="text-xs text-muted-foreground">Measurement check · {date(event.checkAt)}</p>}
          <Markdown content={event.message} />
        </li>)}</ol>
        {cursor != null && <button className={button} disabled={busy} onClick={() => {
          setBusy(true);
          rpc.call("proposal.detail", { ...ref, before: cursor }).then(data => {
            setExtra(previous => [...previous, ...data.events]); setCursor(data.nextBefore);
          }, cause => setError(message(cause))).finally(() => setBusy(false));
        }}>Older timeline entries</button>}
      </section>
      <form className="border-t border-border-hairline pt-4" onSubmit={event => {
        event.preventDefault();
        void mutate(async () => { await rpc.call("proposal.comment", { ...ref, body: comment }); setComment(""); });
      }}>
        <label className="block font-medium" htmlFor="proposal-comment">Comment</label>
        <textarea id="proposal-comment" className={`${input} my-1 w-full`} required maxLength={8000} value={comment}
          onChange={event => setComment(event.target.value)} />
        <button className={button} disabled={busy || !comment.trim()}>Post comment</button>
      </form>
      {(p.state === "measuring" || p.state === "applied") && <form className="border-t border-border-hairline pt-4" onSubmit={close}>
        <div className="flex gap-2">
          {p.state === "measuring" && <button type="button" className={button} aria-pressed={decision === "kept"}
            disabled={!detail.measured} onClick={() => { setDecision("kept"); setOverride(false); }}>Keep</button>}
          <button type="button" className={button} aria-pressed={decision === "reverted"}
            onClick={() => setDecision("reverted")}>Revert</button>
        </div>
        {decision && <div className="mt-2 space-y-2">
          <label className="block">Reason
            <textarea className={`${input} mt-1 block w-full`} required maxLength={8000} value={reason} onChange={event => setReason(event.target.value)} />
          </label>
          {decision === "reverted" && !detail.measured && <label className="flex gap-2">
            <input type="checkbox" checked={override} onChange={event => setOverride(event.target.checked)} /> Urgent rollback before measurement
          </label>}
          <button className={button} disabled={busy || !reason.trim() || !detail.measured && !override}>
            {decision === "kept" ? "Confirm keep" : "Record rollback decision"}
          </button>
        </div>}
      </form>}
    </div>
  </section>;
}

export default definePluginApp(app => {
  app.slots.navPanel({ id: "process-journal", path: "process-journal", title: "Process Journal", icon: "process-journal/book-open", component: Journal });
});
