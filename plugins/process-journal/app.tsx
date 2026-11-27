import { useCallback, useEffect, useState, type FormEvent } from "react";
import { definePluginApp, Markdown, useBbNavigate, useRealtime, useRpc, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import type { methods, rpcContract } from "./contract";
import { isOpen, states, type State } from "./states";
import { cardPath, proposalPath } from "./paths";

type Data<K extends keyof typeof methods> = z.infer<typeof methods[K]["output"]>;
type Projects = Data<"projects">;
type Detail = Data<"proposal.detail">;
type Range = "week" | "month" | "quarter";
const input = "rounded-md border border-border bg-background px-2 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring";
const button = input + " hover:bg-muted disabled:opacity-50";
const panel = "min-w-0 rounded-lg border border-border bg-card p-4";
const statusLabel = (state: State) => state[0]!.toUpperCase() + state.slice(1);
const message = (error: unknown) => error instanceof Error ? error.message : "The request failed";
const when = (at: number, zone: string) => new Intl.DateTimeFormat("en", {
  timeZone: zone, dateStyle: "medium", timeStyle: "short",
}).format(at);

function EvidenceLinks({ links }: { links: string[] | undefined }) {
  if (!links?.length) return null;
  return <ul className="mt-1 space-y-1">{links.map((href, i) =>
    <li key={i}><a className="break-all underline" href={href} target="_blank" rel="noreferrer">{href}</a></li>)}</ul>;
}
function copyRoute(subPath: string) {
  try { return subPath.split("/").map(part => decodeURIComponent(part)); }
  catch { return []; }
}

function Journal({ subPath }: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [projects, setProjects] = useState<Projects>();
  const [projectId, proposalId] = copyRoute(subPath);
  const [error, setError] = useState("");
  const [stamp, setStamp] = useState(0);
  const refresh = useCallback(() => setStamp(at => at + 1), []);
  useRealtime("journal:changed", refresh);
  useEffect(() => {
    let active = true;
    rpc.call("projects", {}).then(data => { if (active) { setProjects(data); setError(""); } },
      cause => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [rpc, stamp]);
  const current = projects?.find(p => p.id === projectId) ?? projects?.[0];
  return <main className="mx-auto max-w-[95rem] space-y-4 p-4 md:p-6">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-2xl font-semibold tracking-tight">Process Journal</h1>
      {current && <label className="flex items-center gap-2 text-sm">Project
        <select className={input} value={current.id} onChange={event =>
          navigate.toPluginPanel("process-journal", { subPath: event.target.value })}>
          {projects?.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>}
    </header>
    {error && <p role="alert">{error} <button className={button} onClick={refresh}>Retry</button></p>}
    {!projects && !error && <p>Loading projects…</p>}
    {projects?.length === 0 && <p className="text-muted-foreground">Enable Process Journal for a project with <code>bb process-journal config</code>.</p>}
    {current && <Workspace key={current.id} project={current}
      routeProposal={current.id === projectId ? proposalId : undefined} stamp={stamp} refresh={refresh} />}
  </main>;
}

function Workspace({ project, routeProposal, stamp, refresh }: {
  project: Projects[number]; routeProposal?: string; stamp: number; refresh: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [manager, setManager] = useState("");
  const [view, setView] = useState<"board" | "history" | "runs">("board");
  const [range, setRange] = useState<Range>("quarter");
  const [state, setState] = useState<State | "">("");
  const [overdue, setOverdue] = useState(false);
  const [offset, setOffset] = useState(0);
  const [list, setList] = useState<Data<"list">>();
  const [digest, setDigest] = useState<Data<"digest">>();
  const [runs, setRuns] = useState<Data<"run.list">>();
  const [error, setError] = useState("");
  const [local, setLocal] = useState<string>();
  const id = routeProposal ?? local ?? list?.items[0]?.proposal.id;

  useEffect(() => {
    let active = true;
    const target = { projectId: project.id, ...(manager ? { managerId: manager } : {}) };
    setError("");
    if (view === "runs") {
      setRuns(undefined);
      rpc.call("run.list", { ...target, offset }).then(data => {
        if (active) setRuns(data);
      }, cause => { if (active) setError(message(cause)); });
    } else {
      setList(undefined);
      rpc.call("list", { ...target, view, range, offset, ...(view === "history" && state ? { state } : {}),
        overdue: view === "board" && overdue }).then(data => {
        if (active) setList(data);
      }, cause => { if (active) setError(message(cause)); });
    }
    rpc.call("digest", target).then(data => { if (active) setDigest(data); },
      cause => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [rpc, view, project.id, manager, range, state, overdue, offset, stamp]);

  const reset = () => {
    setOffset(0);
    setLocal(undefined);
    if (routeProposal) navigate.toPluginPanel("process-journal", { subPath: project.id });
  };
  const select = (proposalId: string) => {
    setLocal(proposalId);
    navigate.toPluginPanel("process-journal", { subPath: `${project.id}/${proposalId}` });
  };
  const groups = new Map<string, Data<"list">["items"]>();
  for (const row of list?.items ?? []) {
    const known = groups.get(row.entry.id);
    if (known) known.push(row);
    else groups.set(row.entry.id, [row]);
  }
  const name = (threadId: string) => project.managers.find(m => m.id === threadId)?.name ?? threadId;
  function proposalCard(row: Data<"list">["items"][number]) {
    const p = row.proposal, late = row.overdue;
    return <button key={p.id} type="button" aria-current={p.id === id} onClick={() => select(p.id)}
      className={`w-full rounded-md border bg-background p-2.5 text-left hover:bg-muted focus-visible:outline focus-visible:outline-ring ${p.id === id ? "border-ring" : "border-border"}`}>
      <strong className="block break-words text-sm">{p.title}</strong>
      <span className="mt-1 block text-xs text-muted-foreground">{statusLabel(p.state)} · {name(p.managerId)}</span>
      {view === "history" && <span className="block text-xs text-muted-foreground">{row.entry.title}</span>}
      <span className={`block text-xs ${late ? "font-medium text-destructive" : "text-muted-foreground"}`}>
        {late ? "Overdue" : isOpen(p.state) ? "Due" : "Closed"} · {when(row.nextAt, project.timeZone)}
      </span>
    </button>;
  }

  return <>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <nav className="flex gap-2" aria-label="Journal views">
        {(["board", "history", "runs"] as const).map(next =>
          <button className={`${button} ${view === next ? "border-ring" : ""}`} key={next} type="button"
            aria-pressed={view === next} onClick={() => { setView(next); reset(); }}>
            {next === "runs" ? "Scheduled reviews" : next === "history" ? "History" : "Board"}
          </button>)}
      </nav>
      <label className="flex items-center gap-2 text-sm">Manager
        <select className={input} value={manager} onChange={event => { setManager(event.target.value); reset(); }}>
          <option value="">All managers</option>
          {project.managers.map(m => <option key={m.id} value={m.id}>{m.name}{m.reachable ? "" : " (unavailable)"}</option>)}
        </select>
      </label>
    </div>
    <section aria-label="Weekly digest">
      <h2 className="mb-2 text-sm font-semibold">Weekly digest</h2>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {(["applied", "kept", "reverted", "overdue"] as const).map(key => <div key={key} className="rounded-md border border-border p-3">
          <dt className="text-xs capitalize text-muted-foreground">{key}</dt>
          <dd className={`text-lg font-semibold ${key === "overdue" && digest?.overdue ? "text-destructive" : ""}`}>{digest?.[key] ?? "…"}</dd>
        </div>)}
      </dl>
    </section>
    {error && <p role="alert" className="text-destructive">{error} <button className={button} onClick={refresh}>Retry</button></p>}
    {view === "runs" ? <section className={panel}>
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
    </section> : <div className="grid min-w-0 items-start gap-3 xl:grid-cols-[minmax(0,1.6fr)_minmax(21rem,1fr)]">
      <section className={panel}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">{view === "board" ? "Entries" : "Proposal history"}</h2>
          {view === "board" ? <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={overdue} onChange={event => { setOverdue(event.target.checked); reset(); }} /> Overdue only
          </label> : <div className="flex flex-wrap gap-2 text-sm">
            <label className="flex items-center gap-2">Range
              <select className={input} value={range} onChange={event => { setRange(event.target.value as Range); reset(); }}>
                <option value="week">Last 7 days</option><option value="month">Last month</option><option value="quarter">Last 3 months</option>
              </select>
            </label>
            <label className="flex items-center gap-2">Status
              <select className={input} value={state} onChange={event => { setState(event.target.value as State | ""); reset(); }}>
                <option value="">All statuses</option>{states.map(item => <option key={item} value={item}>{statusLabel(item)}</option>)}
              </select>
            </label>
          </div>}
        </div>
        {!list && !error && <p className="mt-3 text-sm text-muted-foreground">Loading proposals…</p>}
        {list?.items.length === 0 && <p className="mt-3 text-sm text-muted-foreground">No matching proposals.</p>}
        {view === "board" && groups.size > 0 && <div className="mt-3 grid auto-cols-[minmax(13rem,1fr)] grid-flow-col items-start gap-2 overflow-x-auto rounded p-1"
          tabIndex={0} aria-label="Entry columns">
          {[...groups.values()].map(rows => <section className="space-y-2 rounded border border-border bg-muted/30 p-2" key={rows[0]!.entry.id}>
            <h3 className="break-words text-sm font-semibold">{rows[0]!.entry.title}</h3>
            {rows.map(proposalCard)}
          </section>)}
        </div>}
        {view === "history" && <div className="mt-3 grid gap-2">{list?.items.map(proposalCard)}</div>}
        <Pages offset={offset} next={list?.nextOffset} setOffset={setOffset} />
      </section>
      {id && <ProposalDetail key={id} project={project} id={id} stamp={stamp} refresh={refresh} />}
    </div>}
  </>;
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
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [comment, setComment] = useState("");
  const [reason, setReason] = useState("");
  const [decision, setDecision] = useState<"kept" | "reverted" | "">("");
  const [override, setOverride] = useState(false);
  const ref = { projectId: project.id, proposalId: id };
  useEffect(() => {
    let active = true;
    rpc.call("proposal.detail", { projectId: project.id, proposalId: id }).then(data => {
      if (active) { setDetail(data); setExtra([]); setCursor(data.nextBefore); setLoading(false); }
    }, cause => { if (active) { setError(message(cause)); setLoading(false); } });
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
    {error ? <p role="alert">{error}</p> : loading && <p>Loading proposal…</p>}
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
  return <section className={panel} aria-label="Proposal detail">
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <strong>{statusLabel(p.state)}</strong>
      <label className="flex items-center gap-2">Assigned manager
        <select className={input} disabled={busy || !isOpen(p.state)} value={p.managerId}
          onChange={event => {
            const managerId = event.target.value;
            void mutate(() => rpc.call("proposal.update", { ...edit, patch: { managerId } }));
          }}>
          {!names.has(p.managerId) && <option value={p.managerId}>{p.managerId}</option>}
          {project.managers.map(m => <option key={m.id} value={m.id} disabled={!m.reachable}>{m.name}{m.reachable ? "" : " (unavailable)"}</option>)}
        </select>
      </label>
    </div>
    {!detail.managerReachable && <p className="mt-1 text-sm text-destructive">Assigned manager is unavailable.</p>}
    <h2 className="mt-2 break-words text-xl font-semibold">{p.title}</h2>
    <p className="text-sm text-muted-foreground">{isOpen(p.state) ? "Deadline" : "Closed"} · {date(p.deadlineAt)}</p>
    {p.checkAt !== null && <p className="text-sm text-muted-foreground">Measurement check · {date(p.checkAt)}</p>}
    <a className="text-xs underline" href={proposalPath(project.id, id)}>Proposal link</a>
    {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}

    <div className="mt-4 space-y-3 text-sm">
      <section className="border-t border-border pt-3">
        <h3 className="font-semibold">{entry.title}</h3>
        <Markdown content={entry.failure} />
        <h4 className="mt-2 font-medium">Process gap</h4>
        <Markdown content={entry.gap} />
        <EvidenceLinks links={entry.links} />
      </section>
      <section className="border-t border-border pt-3">
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
      <section className="border-t border-border pt-3">
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
      <section className="border-t border-border pt-3">
        <h3 className="font-semibold">Timeline</h3>
        <ol className="mt-2 space-y-2">{timeline.map(event => <li key={event.seq} className="border-l border-border pl-2">
          <p className="text-xs text-muted-foreground">{date(event.at)} · {names.get(event.actor) ?? event.actor}</p>
          {event.state && <strong>{statusLabel(event.state)}</strong>}
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
      <form className="border-t border-border pt-3" onSubmit={event => {
        event.preventDefault();
        void mutate(async () => { await rpc.call("proposal.comment", { ...ref, body: comment }); setComment(""); });
      }}>
        <label className="block font-medium" htmlFor="proposal-comment">Comment</label>
        <textarea id="proposal-comment" className={`${input} my-1 w-full`} required maxLength={8000} value={comment}
          onChange={event => setComment(event.target.value)} />
        <button className={button} disabled={busy || !comment.trim()}>Post comment</button>
      </form>
      {(p.state === "measuring" || p.state === "applied") && <form className="border-t border-border pt-3" onSubmit={close}>
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
