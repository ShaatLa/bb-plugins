import { definePluginApp, experimental_Icon as Icon, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { ReactNode } from "react";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import { Summary } from "./components/ui/summary";
import { LoadingSkeleton, Skeleton } from "./components/ui/skeleton";
import { plural } from "./lib/plural";
import { cn } from "./lib/utils";
import type { AuditEvent, StatusView } from "./contract";
import { SlotsSettings } from "./settings";
import { useStatus } from "./use-status";

export function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
}

function ThreadLink({ id, titles }: { id: string; titles: StatusView["titles"] }) {
  const navigate = useBbNavigate();
  return <Button type="button" variant="link" className="h-auto min-w-0 max-w-full p-0 text-inherit" onClick={() => navigate.toThread(id)}><span className="truncate">{titles[id] || "thread"}</span></Button>;
}

const empty = "text-sm text-muted-foreground";
const badge = "rounded border px-1.5 py-0.5 text-xs font-medium";
const warning = "text-amber-700 dark:text-amber-400";
const poolName = (pool: string) => pool === "heavy" ? "Heavy jobs" : "Local model";

function Tile({ label, value, children }: { label: string; value: ReactNode; children: ReactNode }) {
  return <Card role="region" aria-label={label} className="min-w-0 space-y-2 p-4">
    <h2 className={empty}>{label}</h2><div className="text-2xl font-semibold tabular-nums">{value}</div>
    <div className="text-xs text-muted-foreground">{children}</div>
  </Card>;
}

function Meter({ label, value, threshold, max, lowerIsBetter = false }: { label: string; value: number; threshold: number; max: number; lowerIsBetter?: boolean }) {
  const bad = lowerIsBetter ? value >= threshold : value < threshold;
  const near = lowerIsBetter ? value >= threshold * 0.85 : value <= threshold * 1.15;
  const state = bad ? "Outside limit" : near ? "Near limit" : "Within limit";
  return <div className="mt-2 space-y-1">
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-valuetext={`${value}, ${state.toLowerCase()}`} className="relative h-1.5 rounded-full bg-muted">
      <div className={cn("h-full rounded-full", bad ? "bg-destructive" : near ? "bg-amber-500" : "bg-emerald-600")} style={{ width: `${Math.min(100, Math.max(0, value / max * 100))}%` }} />
      <span aria-hidden className="absolute -top-1 h-3.5 w-px bg-foreground" style={{ left: `${threshold / max * 100}%` }} />
    </div><p className={cn(bad ? "text-destructive" : near ? warning : "text-muted-foreground")}>{state}</p>
  </div>;
}

function gateOpen(view: StatusView, hostId: string) {
  const gate = view.gates[hostId], settings = view.hostSettings[hostId];
  return !!(gate?.latest?.passed && settings && gate.streak >= settings.gateSamples);
}

function machineState(view: StatusView) {
  const gate = view.gates[view.localHostId], settings = view.hostSettings[view.localHostId];
  const latest = gate?.latest;
  if (!latest || !settings) return "Checking… (waiting for the first reading)";
  if (latest.memFreePct < settings.memFreeMinPct) return `Low memory — ${Math.round(latest.memFreePct)}% free, needs ${settings.memFreeMinPct}%`;
  if (latest.load1 >= settings.loadMax) return `Busy — load ${latest.load1.toFixed(1)} is ${latest.load1 === settings.loadMax ? "at" : "above"} ${settings.loadMax}`;
  if (gateOpen(view, view.localHostId)) return "Ready for heavy work";
  return `Checking… (${gate.streak} of ${plural(settings.gateSamples, "check")})`;
}

export function eventSentence(event: AuditEvent, view: StatusView) {
  const title = event.threadId ? view.titles[event.threadId] || "A thread" : "A thread";
  const resource = event.pool === "local-model" ? "local model slot" : "heavy slot";
  const request = view.pools.flatMap(pool => [...pool.queue, ...pool.leases]).find(item => ("requestId" in item ? item.requestId : item.id) === event.requestId);
  switch (event.type) {
    case "request": return `${title} asked for a ${resource}${request ? ` (${duration(request.estMs)})` : ""}`;
    case "grant": return `${title} got a ${resource}`;
    case "release": return `Lease released${event.reason === "archived" || event.reason === "deleted" ? ` — thread ${event.reason}` : ""}`;
    case "expire": return "Lease expired";
    case "warn": return "Expiry warning sent";
    case "revoke": return "Lease revoked";
    case "transfer": return event.reason === "returned-to-owner" ? `${title} got their slot back` : `Slot transferred to ${title}`;
    case "prioritize": return `Priority updated for ${title}`;
    case "capacity": return `Capacity set to ${event.reason && /^\d+$/.test(event.reason) ? plural(Number(event.reason), "slot") : "a new limit"}`;
    case "port": return `Port ${event.port ?? ""} leased`;
    case "port-release": return `Port ${event.port ?? ""} released`;
    case "gate": return "Machine checked";
  }
}

function StatusContent({ view, now }: { view: StatusView; now: number }) {
  const settings = view.hostSettings[view.localHostId], latest = view.gates[view.localHostId]?.latest;
  const heavy = view.pools.find(pool => pool.hostId === view.localHostId && pool.pool === "heavy");
  const local = view.pools.find(pool => pool.hostId === view.localHostId && pool.pool === "local-model");
  const events = view.audit.filter(event => event.type !== "gate").sort((a, b) => b.at - a.at || b.seq - a.seq).slice(0, 15);
  return <>
    {view.settingsWarnings?.map(message => <p key={message} role="alert" className="text-sm text-amber-700 dark:text-amber-400">{message}</p>)}
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <Tile label="Machine" value={<span className="block text-lg">{machineState(view)}</span>}>{latest ? `Checked ${duration(now - latest.at)} ago` : "Waiting for the first machine reading."}</Tile>
      <Tile label="Memory free" value={latest ? `${Math.round(latest.memFreePct)}%` : "—"}>
        {settings && <>needs at least {settings.memFreeMinPct}%</>}
        {latest && settings && <Meter label="Memory free" value={latest.memFreePct} threshold={settings.memFreeMinPct} max={100} />}
      </Tile>
      <Tile label="Load (1 min)" value={latest ? latest.load1.toFixed(1) : "—"}>
        {settings && <>limit {settings.loadMax}</>}
        {latest && settings && <Meter label="Load (1 min)" value={latest.load1} threshold={settings.loadMax} max={Math.max(settings.loadMax * 1.25, latest.load1)} lowerIsBetter />}
      </Tile>
      <Tile label="Heavy slots" value={heavy ? heavy.capacity === 0 && !heavy.leases.length ? "No slots configured" : `${heavy.leases.length} of ${heavy.capacity} in use` : "—"}>{heavy?.queue.length ?? 0} waiting</Tile>
      <Tile label="Local model" value={local ? local.leases.length ? "In use" : local.capacity === 0 ? "No slots configured" : "Free" : "—"}>{local?.leases.length ? local.leases.map(lease => view.titles[lease.holderThreadId] || "thread").join(", ") : "No active jobs"}</Tile>
    </div>
    <div className="grid gap-3 lg:grid-cols-2">{view.pools.map(pool => <Card role="region" aria-label={poolName(pool.pool)} key={`${pool.hostId}/${pool.pool}`} className="min-w-0 space-y-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-sm font-medium">{poolName(pool.pool)}</h2><span className={empty}>{pool.leases.length} of {pool.capacity} in use</span></div>
      <div role="img" aria-label={`${pool.leases.length} of ${plural(pool.capacity, "slot")} in use`} className="flex flex-wrap gap-1.5">{Array.from({ length: Math.max(pool.capacity, pool.leases.length) }, (_, index) => <span data-held={index < pool.leases.length} key={index} className={cn("h-2.5 w-6 rounded-sm border", index < pool.leases.length ? "border-emerald-600 bg-emerald-600" : "border-border bg-muted")} />)}</div>
      {pool.leases.length === 0 ? <p className={empty}>{pool.capacity === 0 ? "No slots configured" : pool.capacity === 1 ? "Slot free" : `All ${plural(pool.capacity, "slot")} free`}</p> : <ul className="divide-y divide-border">{pool.leases.map(lease => {
        const elapsed = Math.max(0, now - lease.grantedAt);
        const ports = view.ports.filter(port => port.hostId === lease.hostId && port.threadId === lease.holderThreadId);
        return <li key={lease.id} className="space-y-2 py-3 first:pt-0 last:pb-0 text-sm">
          <div className="font-medium"><ThreadLink id={lease.holderThreadId} titles={view.titles} /></div>
          <p className="break-words">{lease.job}</p>
          <div role="progressbar" aria-label={`${lease.job} elapsed`} aria-valuemin={0} aria-valuemax={lease.estMs} aria-valuenow={Math.min(elapsed, lease.estMs)} aria-valuetext={`${duration(elapsed)} of ${duration(lease.estMs)}`} className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full bg-foreground/60" style={{ width: `${Math.min(100, elapsed / lease.estMs * 100)}%` }} /></div>
          <p className="text-xs text-muted-foreground tabular-nums">{duration(elapsed)} of {duration(lease.estMs)} · <span className={cn(lease.warnedAt !== null && warning)}>{lease.expiresAt > now ? `expires in ${duration(lease.expiresAt - now)}` : `expired ${duration(now - lease.expiresAt)} ago`}{lease.warnedAt !== null && " · expiry warning sent"}</span></p>
          {lease.holderThreadId !== lease.ownerThreadId && <p className="text-xs text-muted-foreground">Transferred to <ThreadLink id={lease.holderThreadId} titles={view.titles} /> from <ThreadLink id={lease.ownerThreadId} titles={view.titles} /></p>}
          {ports.map(port => <span key={port.port} className={cn(badge, "inline-block text-muted-foreground")}>Port {port.port}</span>)}
        </li>;
      })}</ul>}
      <div className="space-y-3 border-t border-border pt-3">
        {pool.queue.length === 0 ? <p className={empty}>Nothing waiting</p> : <><h3 className="text-sm font-medium">Waiting · {pool.queue.length}</h3>
          <p className="text-xs text-muted-foreground">{view.hostSettings[pool.hostId]?.grantMode === "manual" ? "Manual grant mode — waiting for the manager" : !gateOpen(view, pool.hostId) ? "Next — waiting for the machine check" : "Next — waiting for a free slot"}</p>
          <ol aria-label={`${poolName(pool.pool)} queue`} className="divide-y divide-border">{pool.queue.map((request, index) => <li key={request.id} className="space-y-2 py-3 first:pt-0 last:pb-0 text-sm">
            <div className="flex flex-wrap items-baseline gap-2"><span className="text-xs text-muted-foreground">#{index + 1}</span><ThreadLink id={request.threadId} titles={view.titles} />{request.priority !== "normal" && <span className={cn(badge, request.priority === "urgent" ? "border-destructive/30 text-destructive" : "border-amber-500/30 " + warning)}>{request.priority}</span>}</div>
            <p className="break-words">{request.job}</p><p className="text-xs text-muted-foreground tabular-nums">Estimate {duration(request.estMs)} · waiting {duration(now - request.createdAt)}</p>
          </li>)}</ol>
        </>}
      </div>
    </Card>)}</div>
    {view.pools.length === 0 && <p className={empty}>No pools available.</p>}
    <Card className="p-4 sm:p-5"><details>
      <Summary className="text-sm font-medium">Recent activity · {events.length}</Summary>
      {events.length === 0 ? <p className={cn(empty, "mt-3")}>No recent activity.</p> : <ol className="mt-3 divide-y divide-border text-sm">{events.map(event => <li key={event.seq} title={[event.leaseId, event.requestId].filter(Boolean).join(" · ")} className="flex items-baseline justify-between gap-3 py-2">
        <span>{eventSentence(event, view)}</span>
        <time className="shrink-0 text-xs text-muted-foreground tabular-nums" dateTime={new Date(event.at).toISOString()}>{duration(now - event.at)} ago</time>
      </li>)}</ol>}
    </details></Card>
  </>;
}

function SlotsPage() {
  const { view, error, now, refresh, busy } = useStatus();
  return <div className="h-full min-h-0 flex-1 overflow-y-auto">
    <div className="mx-auto w-full max-w-6xl space-y-3 p-4 md:p-6">
      <header className="flex items-center justify-between gap-3 py-2">
        <div><h1 className="text-base font-semibold">Machine Slots</h1><p className={empty}>{view?.localHostName && view.localHostName !== view.localHostId ? view.localHostName : "This machine"}</p></div>
        <div className="flex items-center gap-2"><span className="text-xs text-muted-foreground">{view ? `Updated ${duration(now - view.at)} ago` : "Waiting for status"}</span><Button variant="ghost" size="icon" className="shrink-0" disabled={busy} aria-label="Refresh" aria-busy={busy} onClick={refresh}>
          <Icon name="ArrowReloadHorizontal" fallback="RotateCcw" aria-hidden className={`size-4${busy ? " animate-spin motion-reduce:animate-none" : ""}`} />
        </Button></div>
      </header>
      {error && <div role="alert" className="text-sm text-destructive">Unable to refresh status.{view && " Showing the last successful status."}<span className="block text-xs">Retrying automatically every 10 seconds while visible.</span></div>}
      {!view && !error && <LoadingSkeleton label="Loading Slots status…"><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{[0, 1, 2, 3, 4].map(key => <Card key={key} className="space-y-3 p-4"><Skeleton className="h-4 w-24" /><Skeleton className="h-8 w-24" /><Skeleton className="h-3 w-3/4" /></Card>)}</div></LoadingSkeleton>}
      {view && <StatusContent view={view} now={now} />}
    </div>
  </div>;
}

export default definePluginApp(app => {
  app.slots.settingsSection({ id: "settings", title: "Machine Slots", description: "Machine capacity, checks, leases and manager notifications.", component: SlotsSettings });
  app.slots.navPanel({ id: "slots", title: "Slots", icon: "Layers", path: "slots", component: SlotsPage });
});
