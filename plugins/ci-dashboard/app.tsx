import { useEffect, useRef, useState } from "react";
import { minimumDate, presets, resolveRange, type RangeInput } from "./date-range";
import { definePluginApp, experimental_Icon as Icon, UrlLink, useRealtime, useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import type { DashboardData, rpcContract } from "./server";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import { LoadingSkeleton } from "./components/ui/skeleton";
import { DashboardSkeleton } from "./dashboard-skeleton";
import { IntervalDialog, type IntervalSelection } from "./interval-dialog";
import { HistoryCharts } from "./history-chart";
import { CiTiming } from "./ci-cards";
import { RepositoryActivity, RepositoryDetails, CiOutcomes } from "./repository-details";
import { metricsProgressSchema } from "./metrics";

type DashboardSnapshot = { configuration: string; selection: string; result: DashboardData };
// Keep the last view across sidebar navigation within this window; never persist repository data in browser storage.
let lastSnapshot: DashboardSnapshot | null = null;
const snapshots = new Map<string, DashboardSnapshot>();
let cacheGeneration = 0;
const snapshotKey = (configuration: string, selection: string) => JSON.stringify([configuration, selection]);
function rememberSnapshot(snapshot: DashboardSnapshot) {
  const earliest = minimumDate();
  for (const [key, cached] of snapshots) {
    if (cached.result.repositories.some((repo) => repo.range.since.slice(0, 10) < earliest)) snapshots.delete(key);
  }
  const key = snapshotKey(snapshot.configuration, snapshot.selection);
  snapshots.delete(key);
  snapshots.set(key, snapshot);
  if (snapshots.size > 8) snapshots.delete(snapshots.keys().next().value!);
}
let lastSelection: RangeInput = { days: 7 };

export function Dashboard() {
  const rpc = useRpc<typeof rpcContract>();
  const { values, isLoading } = useSettings();
  const repository = typeof values?.repository === "string" ? values.repository : "";
  const importProjects = values?.importBbRepositories !== false;
  const configuration = JSON.stringify([repository, importProjects]);
  const seconds = typeof values?.refreshSeconds === "number" ? values.refreshSeconds : 300;
  const [range, setRange] = useState<RangeInput>(() => lastSelection);
  const selection = JSON.stringify(range);
  const [mode, setMode] = useState(() => range && "days" in range ? String(range.days) : "custom");
  const today = new Date().toISOString().slice(0, 10);
  const earliest = minimumDate();
  const [start, setStart] = useState(() => range && "start" in range ? range.start : today);
  const [end, setEnd] = useState(() => range && "end" in range ? range.end : today);
  const [rangeError, setRangeError] = useState<string | null>(null);
  function applyRange(next: RangeInput) {
    try { resolveRange(next); }
    catch { setRangeError("Choose valid dates within the past year through today, with the start on or before the end."); return; }
    lastSelection = next;
    const cached = snapshots.get(snapshotKey(configuration, JSON.stringify(next)));
    if (cached) {
      rememberSnapshot(cached);
      lastSnapshot = cached;
      setData(cached);
    }
    setRange(next);
    setRangeError(null);
  }
  const [data, setData] = useState<DashboardSnapshot | null>(() => lastSnapshot);
  const [interval, setInterval] = useState<IntervalSelection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const previousRefresh = useRef(refresh);
  const progressStarted = useRef(new Map<string, number>());
  useRealtime("metrics-progress", (payload) => {
    const event = metricsProgressSchema.safeParse(payload);
    if (!event.success || isLoading || event.data.selection !== selection) return;
    const { metrics, startedAt } = event.data;
    const progressKey = JSON.stringify([selection, metrics.repository]);
    if (startedAt < (progressStarted.current.get(progressKey) ?? 0)) return;
    progressStarted.current.set(progressKey, startedAt);
    const key = snapshotKey(configuration, selection);
    const previous = snapshots.get(key)?.result ?? { repositories: [], authSource: "anonymous" as const, discoveryError: null };
    const repositories = [...previous.repositories];
    const index = repositories.findIndex((repo) => repo.repository === metrics.repository);
    if (index >= 0) {
      const cached = repositories[index];
      const merged = { ...metrics };
      // Progress contains empty placeholders for unfinished fields, not replacement data.
      for (const field of ["deployments", "pullRequests", "ci", "reviewQueue", "production", "pullRequestsCreated", "commitActivity"] as const) {
        if (metrics.pending?.includes(field)) Object.assign(merged, { [field]: cached[field] });
      }
      if (metrics.pending?.includes("ci")) {
        merged.ciOutcomes = cached.ciOutcomes;
        merged.ciInsights = cached.ciInsights;
      }
      // Retained values still describe the previous collection until this refresh completes.
      if (metrics.pending?.length) merged.updatedAt = cached.updatedAt;
      repositories[index] = merged;
    }
    else repositories.push(metrics);
    const entry = { configuration, selection, result: { ...previous, repositories } };
    rememberSnapshot(entry);
    lastSnapshot = entry;
    setData(entry);
  });
  useRealtime("configuration-changed", () => {
    cacheGeneration++;
    snapshots.clear();
    progressStarted.current.clear();
    lastSnapshot = null;
    setData(null);
    setRefresh((n) => n + 1);
  });

  useEffect(() => {
    setError(null);
    if (isLoading) return;
    let disposed = false;
    const generation = cacheGeneration;
    const key = snapshotKey(configuration, selection);
    const force = refresh !== previousRefresh.current;
    previousRefresh.current = refresh;
    let timer: ReturnType<typeof setTimeout>;
    async function load(force = false) {
      setBusy(true);
      let nextRefresh = seconds * 1000;
      try {
        const cached = snapshots.get(key);
        if (cached && !disposed) {
          lastSnapshot = cached;
          setData(cached);
        }
        // Persisted snapshots seed a view; polling must not rewind fresh in-memory data.
        if (!cached) {
          const snapshot = await rpc.call("snapshot", range).catch(() => null);
          if (snapshot && generation === cacheGeneration && !snapshots.has(key)) {
            const entry = { configuration, selection, result: snapshot };
            rememberSnapshot(entry);
            if (!disposed) {
              lastSnapshot = entry;
              setData(entry);
            }
          }
        }
        if (disposed) return;
        const available = snapshots.get(key);
        if (!force && available && available.result.repositories.length > 0 && available.result.repositories.every((repo) => !repo.pending?.length)) {
          const checkedAt = Math.min(...available.result.repositories.map((repo) => Date.parse(repo.updatedAt)));
          const age = Date.now() - checkedAt;
          const sameDay = !range || !("days" in range) || range.days !== 1 || available.result.repositories.every((repo) => repo.range.since === resolveRange(range).since);
          if (sameDay && age >= 0 && age < seconds * 1000) {
            nextRefresh = seconds * 1000 - age;
            return;
          }
        }
        const result = await rpc.call("metrics", force ? { selection: range, force: true } : range);
        if (generation === cacheGeneration) {
          const entry = { configuration, selection, result };
          rememberSnapshot(entry);
          if (!disposed) {
            lastSnapshot = entry;
            setData(entry);
            setError(null);
          }
        }
      } catch {
        if (!disposed) setError("Refresh failed. Displayed values may be out of date. Check connectivity and plugin settings.");
      } finally {
        if (!disposed) {
          setBusy(false);
          timer = setTimeout(load, nextRefresh);
        }
      }
    }
    void load(force);
    return () => { disposed = true; clearTimeout(timer); };
  }, [rpc, isLoading, configuration, selection, seconds, refresh]);

  const current = data && (isLoading || data.configuration === configuration) ? data.result : null;
  if (isLoading && !current) return <p role="status" className="text-sm text-muted-foreground">Loading dashboard settings…</p>;
  return (
    <section aria-label="GitHub CI metrics" aria-busy={busy && !current} className="space-y-6">
      <div className="flex items-center gap-3" aria-label="Date range filters">
        <span className="relative inline-block">
          <select aria-label="Date range" value={mode} className="h-9 appearance-none rounded-md border border-input bg-background pl-3 pr-9 text-sm text-foreground" onChange={(event) => {
            const value = event.target.value;
            setMode(value);
            setRangeError(null);
            if (value !== "custom") applyRange({ days: Number(value) as typeof presets[number] });
          }}>
            {presets.map((days, index) => <option key={days} value={days}>{["1 day", "3 days", "1 week", "2 weeks", "1 month", "3 months"][index]}</option>)}
            <option value="custom">Custom dates</option>
          </select>
          <svg aria-hidden="true" viewBox="0 0 12 8" fill="none" className="pointer-events-none absolute right-3 top-1/2 h-2 w-3 -translate-y-1/2 text-foreground"><path d="m1 1 5 5 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </span>
        <Button variant="ghost" size="icon" className="shrink-0" disabled={busy} aria-label="Refresh" aria-busy={busy} onClick={() => setRefresh((n) => n + 1)}>
          <svg data-refresh-icon aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={`size-4${busy ? " animate-spin motion-reduce:animate-none" : ""}`}>
            <path d="M21 12a9 9 0 1 1-9-9c2.5 0 4.9 1 6.7 2.8L21 8" />
            <path d="M21 3v5h-5" />
          </svg>
        </Button>
      </div>
      {mode === "custom" && <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-xs text-muted-foreground"><span className="block">From (UTC)</span><input aria-label="From date" type="date" min={earliest} max={end && end < today ? end : today} value={start} onChange={(event) => setStart(event.target.value)} className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground" /></label>
        <label className="space-y-1 text-xs text-muted-foreground"><span className="block">Through (UTC)</span><input aria-label="Through date" type="date" min={start > earliest ? start : earliest} max={today} value={end} onChange={(event) => setEnd(event.target.value)} className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground" /></label>
        <Button variant="outline" size="sm" onClick={() => applyRange({ start, end })}>Apply dates</Button>
      </div>}
      {rangeError && <p role="alert" className="text-sm text-destructive">{rangeError}</p>}
      {!current && !error && <DashboardSkeleton />}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {current?.discoveryError && <p role="alert" className="text-sm text-destructive">{current.discoveryError}</p>}
      {current?.repositories.length === 0 && <p className="text-sm text-muted-foreground">No GitHub repositories found. Add a BB project with a GitHub remote or list repositories in Settings → Plugins → CI Dashboard.</p>}
      {current?.repositories.map((repo) => {
        const cards = [
          { title: "CI pass rate", pending: "ci", metric: repo.ci, format: (n: number) => `${n.toFixed(1)}%` },
          { title: "Deploy frequency", pending: "deployments", metric: repo.deployments, format: (n: number) => `${n.toFixed(1)} / day` },
          { title: "Open pull requests", pending: "pullRequests", metric: repo.pullRequests, format: (n: number) => n.toLocaleString() },
        ];
        const name = repo.projectName?.trim() || repo.repository.split("/")[1].replace(/[-_]+/g, " ");
        const projectTitle = name.charAt(0).toUpperCase() + name.slice(1);
        const rangeTitle = repo.range.label === "today" ? "Today" : repo.range.label.startsWith("last ") ? `L${repo.range.label.slice(1)}` : "Custom range";
        const dates = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
          .formatRange(new Date(repo.range.since), new Date(repo.range.until));
        return <section key={repo.repository} aria-label={repo.repository} className="space-y-3">
          <h3 className="break-words text-base font-semibold">
            <UrlLink href={`https://github.com/${repo.repository}`} title={`Open ${repo.repository} on GitHub`} className="inline-flex items-center gap-1.5 rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {projectTitle}<Icon name="ExternalLink" aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            </UrlLink>
          </h3>
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" title={`${new Date(repo.range.since).toUTCString()} – ${new Date(repo.range.until).toUTCString()}`}>
            <span className="font-medium text-foreground">{rangeTitle}</span><span aria-hidden="true">·</span><span>{dates}</span><span className="rounded border border-border px-1.5 py-0.5 text-[10px]">UTC</span>
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {cards.map(({ title, pending, metric, format }) => (
              <Card key={title} className={`space-y-2 p-4 ${title === "CI pass rate" ? "border-primary/30 bg-primary/5" : ""}`}>
                <h4 className="text-sm text-muted-foreground">{title}</h4>
                {metric.value === null && repo.pending?.includes(pending) ? <LoadingSkeleton label={`Loading ${title}`} /> : <>
                  <p className="text-2xl font-semibold tabular-nums">{metric.value == null ? "—" : format(metric.value)}</p>
                  <p className="text-xs text-muted-foreground">{metric.detail}</p>
                </>}
                {metric.error && <p role="alert" className="text-xs text-destructive">{metric.error}</p>}
              </Card>
            ))}
          </div>
          <CiTiming repo={repo} />
          <CiOutcomes repo={repo} showDetails />
          <HistoryCharts repo={repo} onSelect={(since, until) => setInterval({ repository: repo.repository, since, until })} />
          <RepositoryActivity repo={repo} />
          <RepositoryDetails repo={repo} />
          <p className="text-xs text-muted-foreground">Last checked {new Date(repo.updatedAt).toLocaleString()}</p>
        </section>;
      })}
      {interval && <IntervalDialog key={JSON.stringify(interval)} selection={interval} onClose={() => setInterval(null)} />}
    </section>
  );
}

function DashboardPage() {
  return <div data-ci-dashboard-viewport className="h-full min-h-0 flex-1 overflow-y-auto">
    <div className="mx-auto w-full max-w-6xl p-4 md:p-6"><Dashboard /></div>
  </div>;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "ci-dashboard", title: "CI Dashboard", icon: "delivery-dashboard/pipeline", path: "dashboard", component: DashboardPage,
  });
});
