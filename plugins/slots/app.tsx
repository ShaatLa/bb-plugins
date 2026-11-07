import { definePluginApp, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { ReactNode } from "react";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import { LoadingSkeleton, Skeleton } from "./components/ui/skeleton";
import { cn } from "./lib/utils";
import type { StatusView } from "./contract";
import { useStatus } from "./use-status";

function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function ThreadLink({ id, titles }: { id: string; titles: StatusView["titles"] }) {
  const navigate = useBbNavigate();
  return <Button type="button" variant="link" className="h-auto min-w-0 max-w-full p-0 text-inherit" onClick={() => navigate.toThread(id)}><span className="truncate">{titles[id] || "thread"}</span></Button>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <Card role="region" aria-label={title} className="min-w-0 space-y-4 p-4 sm:p-5">
    <h2 className="text-base font-semibold">{title}</h2>{children}
  </Card>;
}

const empty = "text-sm text-muted-foreground";
const badge = "rounded-md border px-2 py-0.5 text-xs font-medium";

function StatusContent({ view, now }: { view: StatusView; now: number }) {
  const hosts = [...new Set([view.localHostId, ...Object.keys(view.gates), ...view.pools.map(pool => pool.hostId)])];
  const events = view.audit.filter(event => event.type !== "gate").sort((a, b) => b.at - a.at || b.seq - a.seq).slice(0, 15);
  return <>
    <div className="grid gap-3 lg:grid-cols-2">{hosts.map(hostId => {
      const gate = view.gates[hostId];
      const settings = view.hostSettings[hostId];
      const latest = gate?.latest;
      const open = latest?.passed && settings && gate.streak >= settings.gateSamples;
      return <Section key={hostId} title={`Machine gate · ${hostId}`}>
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn(badge, latest?.passed ? "border-emerald-600/30 text-emerald-700 dark:text-emerald-400" : "text-destructive border-destructive/30")}>
            {latest ? latest.passed ? "Sample passed" : "Sample failed" : "No sample"}
          </span>
          <span className="text-sm">{open ? "Gate open" : "Gate waiting"}</span>
          <span className="text-sm text-muted-foreground">Streak {gate?.streak ?? 0}/{settings?.gateSamples ?? "?"}</span>
        </div>
        <dl className="grid grid-cols-2 gap-4 text-sm">
          <div><dt className="text-muted-foreground">Memory free</dt><dd className="mt-1 font-medium tabular-nums">{latest ? `${latest.memFreePct.toFixed(1)}%` : "—"}<span className="block text-xs text-muted-foreground">Minimum {settings ? `${settings.memFreeMinPct}%` : "unknown"}</span></dd></div>
          <div><dt className="text-muted-foreground">1-minute load</dt><dd className="mt-1 font-medium tabular-nums">{latest ? latest.load1.toFixed(1) : "—"}<span className="block text-xs text-muted-foreground">Below {settings?.loadMax ?? "unknown"}</span></dd></div>
        </dl>
        <p className={empty}>{latest ? <>Latest sample <time dateTime={new Date(latest.at).toISOString()} title={new Date(latest.at).toLocaleString()}>{duration(now - latest.at)} ago</time></> : "Waiting for the first machine reading."}</p>
      </Section>;
    })}</div>
    <div className="grid gap-3 lg:grid-cols-2">{view.pools.map(pool => <Section key={`${pool.hostId}/${pool.pool}`} title={`${pool.pool} · ${pool.hostId}`}>
      <p className="text-sm tabular-nums">Capacity {pool.capacity} · {pool.leases.length} used · {Math.max(0, pool.capacity - pool.leases.length)} free</p>
      {pool.leases.length === 0 ? <p className={empty}>No active leases.</p> : <ul className="divide-y divide-border">{pool.leases.map(lease => {
        const ports = view.ports.filter(port => port.hostId === lease.hostId && port.threadId === lease.holderThreadId);
        return <li key={lease.id} className="space-y-2 py-3 first:pt-0 last:pb-0 text-sm">
          <div className="flex flex-wrap items-baseline gap-2"><span className={cn(badge, "text-muted-foreground")}>Slot {lease.slotIndex}</span><ThreadLink id={lease.holderThreadId} titles={view.titles} /></div>
          <p className="break-words">{lease.job}</p>
          <p className="text-xs text-muted-foreground tabular-nums">Granted {duration(now - lease.grantedAt)} ago · Estimate {duration(lease.estMs)} · {lease.expiresAt > now ? `Expires in ${duration(lease.expiresAt - now)}` : `Expired ${duration(now - lease.expiresAt)} ago`}</p>
          {lease.holderThreadId !== lease.ownerThreadId && <p className="text-xs text-muted-foreground">Transferred to <ThreadLink id={lease.holderThreadId} titles={view.titles} /> from <ThreadLink id={lease.ownerThreadId} titles={view.titles} /></p>}
          {ports.map(port => <p key={port.port} className="text-xs font-medium">Port {port.port}</p>)}
        </li>;
      })}</ul>}
    </Section>)}</div>
    {view.pools.length === 0 && <p className={empty}>No pools available.</p>}
    <Section title="Queue">
      {view.pools.every(pool => pool.queue.length === 0) ? <p className={empty}>No requests waiting.</p> : <div className="space-y-4">{view.pools.filter(pool => pool.queue.length > 0).map(pool => <div key={`${pool.hostId}/${pool.pool}`}>
        <h3 className="mb-2 text-sm font-medium">{pool.pool} · {pool.hostId}</h3>
        <ol aria-label={`${pool.pool} queue on ${pool.hostId}`} className="divide-y divide-border">{pool.queue.map(request => <li key={request.id} className="space-y-2 py-3 first:pt-0 last:pb-0 text-sm">
          <div className="flex flex-wrap items-baseline gap-2"><span className={cn(badge, request.priority === "urgent" ? "border-destructive/30 text-destructive" : request.priority === "high" ? "border-amber-600/30 text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>{request.priority}</span><ThreadLink id={request.threadId} titles={view.titles} /></div>
          <p className="break-words">{request.job}</p><p className="text-xs text-muted-foreground tabular-nums">Estimate {duration(request.estMs)} · Waiting {duration(now - request.createdAt)}</p>
        </li>)}</ol>
      </div>)}</div>}
    </Section>
    <Section title="Recent events">
      {events.length === 0 ? <p className={empty}>No recent events.</p> : <ol className="space-y-2 text-sm">{events.map(event => <li key={event.seq} className="flex flex-wrap gap-x-2 gap-y-1">
        <time className="text-xs text-muted-foreground tabular-nums" dateTime={new Date(event.at).toISOString()} title={new Date(event.at).toLocaleString()}>{duration(now - event.at)} ago</time>
        <span className="font-medium">{event.type}</span><span className="text-muted-foreground">{[event.hostId, event.pool].filter(Boolean).join(" · ")}</span>
        {event.threadId && <ThreadLink id={event.threadId} titles={view.titles} />}
        <span className="break-words text-muted-foreground">{[event.leaseId ?? event.requestId, event.port ? `Port ${event.port}` : null, event.manual ? "Manual" : null, event.reason].filter(Boolean).join(" · ")}</span>
      </li>)}</ol>}
    </Section>
  </>;
}

function SlotsPage() {
  const { view, error, now } = useStatus();
  return <div className="h-full min-h-0 flex-1 overflow-y-auto">
    <div className="mx-auto w-full max-w-5xl space-y-3 p-4 md:p-6">
      <p className={empty}>Machine capacity and waiting work · Updates every 10 seconds</p>
      {error && <div role="alert" className="rounded-lg border border-destructive/30 p-4 text-sm text-destructive">{error}{view && <p>Showing the last successful status.</p>}<p>Retrying automatically every 10 seconds while visible.</p></div>}
      {!view && !error && <LoadingSkeleton label="Loading Slots status…"><div className="grid gap-3 sm:grid-cols-2">{[0, 1, 2, 3].map(key => <Card key={key} className="space-y-4 p-5"><Skeleton className="h-5 w-32" /><Skeleton className="h-7 w-24" /><Skeleton className="h-4 w-3/4" /></Card>)}</div></LoadingSkeleton>}
      {view && <StatusContent view={view} now={now} />}
    </div>
  </div>;
}

export default definePluginApp(app => {
  app.slots.navPanel({ id: "slots", title: "Slots", icon: "Layers", path: "slots", component: SlotsPage });
});
