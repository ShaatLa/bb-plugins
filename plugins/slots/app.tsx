import { definePluginApp, experimental_Icon as Icon, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { ReactNode } from "react";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import { Summary } from "./components/ui/summary";
import { LoadingSkeleton, Skeleton } from "./components/ui/skeleton";
import { plural } from "./lib/plural";
import { cn } from "./lib/utils";
import type { AuditEvent, PoolSnapshot, StatusView } from "./contract";
import { SlotsSettings } from "./settings";
import { useStatus } from "./use-status";

export { duration } from "./lib/duration";
import { duration } from "./lib/duration";

function ThreadLink({ id, titles }: { id: string; titles: StatusView["titles"] }) {
  const navigate = useBbNavigate();
  return <Button type="button" variant="link" className="h-auto min-w-0 max-w-full p-0 text-inherit" onClick={() => navigate.toThread(id)}><span className="truncate">{titles[id] || "thread"}</span></Button>;
}

const empty = "text-sm text-muted-foreground";
const badge = "rounded border px-1.5 py-0.5 text-xs font-medium";
const warning = "text-amber-700 dark:text-amber-400";
const poolName = (pool: string) => pool === "heavy" ? "Heavy jobs" : "Local model";
/** Card title; local-model names its device once another device is registered. */
const poolTitle = (pool: PoolSnapshot, split: boolean, view?: StatusView) => (pool.pool === "heavy" ? poolName(pool.pool) : pool.device ? `Local model · ${pool.device}` : split ? "Local model · this Mac" : "Local model") +
  (view && pool.hostId !== view.localHostId ? ` · ${view.leaseHosts?.[pool.hostId]?.name ?? pool.hostId}` : "");

function Tile({ label, heading = label, value, className, children }: { label: string; heading?: string; value: ReactNode; className?: string; children: ReactNode }) {
  return <Card role="region" aria-label={label} className={cn("min-w-0 space-y-2 p-4", className)}>
    <h2 className={cn(empty, "truncate")}>{heading}</h2><div className="text-lg font-semibold tabular-nums sm:text-2xl">{value}</div>
    <div className="space-y-2 text-xs text-muted-foreground">{children}</div>
  </Card>;
}

function Meter({ label, text, value, threshold, max, lowerIsBetter = false }: { label: string; text: string; value: number; threshold: number; max: number; lowerIsBetter?: boolean }) {
  const bad = lowerIsBetter ? value >= threshold : value < threshold;
  const near = lowerIsBetter ? value >= threshold * 0.85 : value <= threshold * 1.15;
  const state = bad ? "Outside limit" : near ? "Near limit" : "Within limit";
  return <div className="space-y-1">
    <div className="flex flex-wrap justify-between gap-x-2"><span className="tabular-nums">{text}</span><span className={cn(bad ? "text-destructive" : near ? warning : "text-muted-foreground")}>{state}</span></div>
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-valuetext={`${value}, ${state.toLowerCase()}`} className="relative h-1.5 rounded-full bg-muted">
      <div className={cn("h-full rounded-full", bad ? "bg-destructive" : near ? "bg-amber-500" : "bg-emerald-600")} style={{ width: `${Math.min(100, Math.max(0, value / max * 100))}%` }} />
      <span aria-hidden className="absolute -top-1 h-3.5 w-px bg-foreground" style={{ left: `${threshold / max * 100}%` }} />
    </div>
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
    case "unleased-load": return "High checkout load without a heavy slot";
    case "idle-lease": return "Heavy slot held while its checkout stayed idle";
    case "use-expired": return "A wrapped run stopped renewing; its use expired";
    case "use-dropped": return "A lent slot returned to its owner; the borrower's runs were dropped";
    case "unclaimed": return "Slot released because no run claimed it";
    case "gate": return "Machine checked";
  }
}

function StatusContent({ view, now }: { view: StatusView; now: number }) {
  const settings = view.hostSettings[view.localHostId], latest = view.gates[view.localHostId]?.latest;
  const heavy = view.pools.find(pool => pool.hostId === view.localHostId && pool.pool === "heavy");
  const locals = view.pools.filter(pool => pool.hostId === view.localHostId && pool.pool === "local-model");
  const local = locals.length ? { leases: locals.flatMap(pool => pool.leases), capacity: locals.reduce((sum, pool) => sum + pool.capacity, 0) } : undefined;
  const hostName = (hostId: string) => view.leaseHosts?.[hostId]?.name ?? hostId;
  const hostOrder = Object.keys(view.leaseHosts ?? {});
  // This Mac, then local-model devices (snapshot keeps registration order), then other hosts in leaseHosts order.
  const deviceHost = ({ device }: PoolSnapshot) => device ? view.deviceHosts?.[device] : undefined;
  const hostRank = (hostId: string) => hostId === view.localHostId ? 0 : 2 + (hostOrder.indexOf(hostId) + 1 || hostOrder.length + 1);
  // A matched device card follows its host's heavy card.
  const rank = (pool: PoolSnapshot) => deviceHost(pool) ? hostRank(deviceHost(pool)!) + 0.5 : pool.device ? 1 : hostRank(pool.hostId);
  const sectionName = (pool: PoolSnapshot): string => deviceHost(pool) ? sectionName({ ...pool, device: undefined, hostId: deviceHost(pool)! }) : pool.device ? `${pool.device} · local model device (not linked to a machine)` : pool.hostId === view.localHostId ? "This Mac" : `${hostName(pool.hostId)}${view.hostSettings[pool.hostId]?.connected === false ? " · offline" : ""}`;
  const sections = new Map<string, PoolSnapshot[]>();
  for (const pool of [...view.pools].sort((a, b) => rank(a) - rank(b))) sections.set(sectionName(pool), [...sections.get(sectionName(pool)) ?? [], pool]);
  const spare = Object.entries(view.hostSettings).filter(([hostId, host]) => hostId !== view.localHostId && host.connected !== false)
    .map(([hostId]) => ({ hostId, pool: view.pools.find(pool => pool.hostId === hostId && pool.pool === "heavy") }))
    .map(({ hostId, pool }) => ({ hostId, free: pool && pool.mode?.admitting !== false ? pool.capacity - pool.leases.length : 0 })).filter(host => host.free > 0);
  const events = view.audit.filter(event => event.type !== "gate").sort((a, b) => b.at - a.at || b.seq - a.seq).slice(0, 15);
  return <>
    {view.settingsWarnings?.map(message => <p key={message} role="alert" className="text-sm text-amber-700 dark:text-amber-400">{message}</p>)}
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-[2fr_1fr_1fr]">
      <Tile label="This Mac" heading={`This Mac${view.localHostName && view.localHostName !== view.localHostId ? ` · ${view.localHostName}` : ""}`} className="col-span-2 xl:col-span-1" value={<span className="block text-lg">{machineState(view)}</span>}>
        {latest && settings && <>
          <Meter label="Memory free" text={`Memory free ${Math.round(latest.memFreePct)}% · needs ${settings.memFreeMinPct}%`} value={latest.memFreePct} threshold={settings.memFreeMinPct} max={100} />
          <Meter label="Load (1 min)" text={`Load ${latest.load1.toFixed(1)} · limit ${settings.loadMax}`} value={latest.load1} threshold={settings.loadMax} max={Math.max(settings.loadMax * 1.25, latest.load1)} lowerIsBetter />
        </>}
        <p>{latest ? `Checked ${duration(now - latest.at)} ago` : "Waiting for the first machine reading."}</p>
      </Tile>
      <Tile label="Heavy slots" value={heavy ? heavy.capacity === 0 && !heavy.leases.length ? "No slots configured" : <span className="whitespace-nowrap">{heavy.leases.length} of {heavy.capacity} in use</span> : "—"}>{heavy?.queue.length ?? 0} waiting</Tile>
      <Tile label="Local model" value={local ? local.leases.length ? "In use" : local.capacity === 0 ? "No slots configured" : "Free" : "—"}>{local?.leases.length ? local.leases.map(lease => view.titles[lease.holderThreadId] || "thread").join(", ") : "No active jobs"}</Tile>
    </div>
    {[...sections].map(([name, pools]) => <section key={name} className="space-y-2">
      <h2 className="pt-2 text-sm font-medium text-muted-foreground">{name}</h2>
      <div className="grid gap-3 lg:grid-cols-2">{pools.map(pool => <Card role="region" aria-label={poolTitle(pool, locals.length > 1, view)} key={`${pool.hostId}/${pool.pool}/${pool.device ?? ""}`} className="min-w-0 space-y-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="text-sm font-medium">{deviceHost(pool) ? `Local model · ${pool.device}` : poolName(pool.pool)}</h3><span className={empty}>{pool.leases.length} of {pool.capacity} in use</span></div>
      {pool.pool === "local-model" && pool.queue.length > 0 && (() => { const machine = pool.device ? view.deviceHosts?.[pool.device] : pool.hostId; const heavyPool = view.pools.find(p => p.pool === "heavy" && p.hostId === machine); return heavyPool?.mode?.reason === "model-queued" ? <p className="text-xs text-muted-foreground">Waiting for heavy jobs here to drop to {heavyPool.mode.withModel}</p> : null; })()}
      {pool.mode && <p className="text-xs text-muted-foreground">{pool.mode.reason === "model-queued" ? "No new heavy jobs: local model queued" : pool.mode.reason === "model-running" ? `With local model · ${pool.leases.length} of ${pool.capacity} (high ${pool.mode.high})` : `Model hold over (${view.modelHoldMinutes ?? 60} min): heavy back to ${pool.mode.high}`}</p>}
      <div role="img" aria-label={`${pool.leases.length} of ${plural(pool.capacity, "slot")} in use`} className="flex flex-wrap gap-1.5">{Array.from({ length: Math.max(pool.capacity, pool.leases.length) }, (_, index) => <span data-held={index < pool.leases.length} key={index} className={cn("h-2.5 w-6 rounded-sm border", index < pool.leases.length ? "border-emerald-600 bg-emerald-600" : "border-border bg-muted")} />)}</div>
      {pool.leases.length === 0 && pool.mode?.admitting !== false ? <p className={empty}>{pool.capacity === 0 ? "No slots configured" : pool.capacity === 1 ? "Slot free" : `All ${plural(pool.capacity, "slot")} free`}</p> : <ul className="divide-y divide-border">{pool.leases.map(lease => {
        const elapsed = Math.max(0, now - lease.grantedAt), over = elapsed > lease.estMs;
        const ports = view.ports.filter(port => port.hostId === lease.hostId && port.threadId === lease.holderThreadId);
        return <li key={lease.id} className="space-y-2 py-3 first:pt-0 last:pb-0 text-sm">
          <div className="font-medium"><ThreadLink id={lease.holderThreadId} titles={view.titles} /></div>
          <p className="break-words">{lease.job}</p>
          <div role="progressbar" aria-label={`${lease.job} elapsed`} aria-valuemin={0} aria-valuemax={lease.estMs} aria-valuenow={Math.min(elapsed, lease.estMs)} aria-valuetext={`${duration(elapsed)} of ${duration(lease.estMs)}${over ? ", over estimate" : ""}`} className="h-1.5 overflow-hidden rounded-full bg-muted"><div className={cn("h-full", over ? "bg-amber-500" : "bg-foreground/60")} style={{ width: `${Math.min(100, elapsed / lease.estMs * 100)}%` }} /></div>
          <p className="text-xs text-muted-foreground tabular-nums">{duration(elapsed)} of {duration(lease.estMs)} · {over && <span className={warning}>{duration(elapsed - lease.estMs)} over estimate · </span>}<span className={cn(lease.warnedAt !== null && warning)}>{lease.expiresAt > now ? `expires in ${duration(lease.expiresAt - now)}` : `expired ${duration(now - lease.expiresAt)} ago`}{lease.warnedAt !== null && " · expiry warning sent"}</span></p>
          {lease.holderThreadId !== lease.ownerThreadId && <p className="text-xs text-muted-foreground">Transferred to <ThreadLink id={lease.holderThreadId} titles={view.titles} /> from <ThreadLink id={lease.ownerThreadId} titles={view.titles} /></p>}
          {ports.map(port => <span key={port.port} className={cn(badge, "inline-block text-muted-foreground")}>Port {port.port}</span>)}
        </li>;
      })}</ul>}
      <div className="space-y-3 border-t border-border pt-3">
        {pool.queue.length === 0 ? <p className={empty}>Nothing waiting</p> : <><h4 className="text-sm font-medium">Waiting · {pool.queue.length}</h4>
          <p className="text-xs text-muted-foreground">{pool.mode?.reason === "model-queued" ? `Next — local model queued on ${hostName(pool.hostId)}` : view.hostSettings[pool.hostId]?.grantMode === "manual" ? "Manual grant mode — waiting for the manager" : !pool.device && view.hostSettings[pool.hostId]?.gated !== false && !gateOpen(view, pool.hostId) ? "Next — waiting for the machine check" : "Next — waiting for a free slot"}</p>
          {pool.pool === "heavy" && pool.hostId === view.localHostId && spare.map(host => <p key={host.hostId} className="text-xs text-muted-foreground">{hostName(host.hostId)} has {plural(host.free, "free heavy slot")}. Only runs started with slots-run --spill use them.</p>)}
          <ol aria-label={`${poolTitle(pool, locals.length > 1, view)} queue`} className="divide-y divide-border">{pool.queue.map((request, index) => <li key={request.id} className="space-y-2 py-3 first:pt-0 last:pb-0 text-sm">
            <div className="flex flex-wrap items-baseline gap-2"><span className="text-xs text-muted-foreground">#{index + 1}</span><ThreadLink id={request.threadId} titles={view.titles} />{locals.length > 1 && pool.pool === "local-model" && !request.device && <span className={cn(badge, "text-muted-foreground")}>any device</span>}{request.priority !== "normal" && <span className={cn(badge, request.priority === "urgent" ? "border-destructive/30 text-destructive" : "border-amber-500/30 " + warning)}>{request.priority}</span>}</div>
            <p className="break-words">{request.job}</p><p className="text-xs text-muted-foreground tabular-nums">Estimate {duration(request.estMs)} · waiting {duration(now - request.createdAt)}</p>
          </li>)}</ol>
        </>}
      </div>
    </Card>)}</div>
    </section>)}
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
      {error && <div role="alert" className="text-sm text-destructive">Unable to refresh status.{view && " Showing the last successful status."}<span className="block text-xs">Retrying automatically every 30 seconds while visible.</span></div>}
      {!view && !error && <LoadingSkeleton label="Loading Slots status…"><div className="grid grid-cols-2 gap-3 xl:grid-cols-[2fr_1fr_1fr]">{[0, 1, 2].map(key => <Card key={key} className={cn("space-y-3 p-4", key === 0 && "col-span-2 xl:col-span-1")}><Skeleton className="h-4 w-24" /><Skeleton className="h-8 w-24" /><Skeleton className="h-3 w-3/4" /></Card>)}</div></LoadingSkeleton>}
      {view && <StatusContent view={view} now={now} />}
    </div>
  </div>;
}

export default definePluginApp(app => {
  app.slots.settingsSection({ id: "settings", title: "Machine Slots", description: "Machine capacity, checks, leases and manager notifications.", component: SlotsSettings });
  app.slots.navPanel({ id: "slots", title: "Slots", icon: "Layers", path: "slots", component: SlotsPage });
});
