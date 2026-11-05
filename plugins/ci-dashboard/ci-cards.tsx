import { useState, type ReactNode } from "react";
import { UrlLink } from "@get-bb/plugin-sdk/app";
import type { Metrics } from "./metrics";
import { Card } from "./components/ui/card";
import { LoadingSkeleton, Skeleton } from "./components/ui/skeleton";
import { Button } from "./components/ui/button";
import type { JobSignals } from "./signals-panel";

function elapsed(ms: number | null) {
  if (ms === null) return "—";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
export function passRate(counts: { passed: number; eligible: number }) {
  return counts.eligible ? `${(100 * counts.passed / counts.eligible).toFixed(1)}%` : "—";
}
function unavailable(repo: Metrics) {
  return repo.pending?.includes("ci") ? "Loading CI details…" : (repo.ci.error || repo.ci.seriesError ? "CI details unavailable. See the CI summary." : "Refresh to load workflow details.");
}

type Signal = NonNullable<JobSignals["repo"]>["signals"][number];
const ago = (value: string, now: number) => {
  const minutes = Math.max(0, Math.floor((now - Date.parse(value)) / 60000));
  return minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.floor(minutes / 60)} h ago` : `${Math.floor(minutes / 1440)} d ago`;
};
const runMinutes = (ms: number) => `${Math.round(ms / 60000)} min`;
// Server titles carry internal wording; the card shows the plain one.
function signalTitle(signal: Signal) {
  const { pool, jobName, branch } = signal.where;
  if (signal.kind === "pool_stall") return `Runner pool stalled: ${pool}`;
  if (signal.kind === "runner_loss" && jobName) return `Runner lost${branch ? ` on ${branch}` : ""}: ${jobName}`;
  if (signal.kind === "mass_cancel") return `Many runners lost${pool ? ` in ${pool}` : ""}`;
  return signal.title;
}
const kindLabels: Record<Signal["kind"], string> = { pool_stall: "Stalled runner pools", runner_loss: "Runner losses", mass_cancel: "Mass runner losses", rerun_failed: "Reruns still failing", flake: "Flaky jobs", transient: "Network/tool errors", timeout: "Timeouts" };

export function CiSignals({ repo, signals }: { repo: Metrics; signals?: JobSignals }) {
  const data = repo.ciInsights;
  const ready = data;
  const jobRepo = signals?.repo;
  // One list: run-level alerts and open job-level signals, stalled pool first, then most severe, then newest.
  const rows = data ? [
    ...data.alerts.map((alert) => ({ key: `${alert.kind}:${alert.runId}`, href: `https://github.com/${repo.repository}/actions/runs/${alert.runId}`, rank: alert.kind === "main" ? 0 : 1, at: Date.parse(alert.createdAt),
      tone: alert.kind === "main" ? "text-destructive" : "text-amber-600 dark:text-amber-400",
      title: `${alert.name} · ${alert.branch}: ${alert.kind === "main" ? "latest run failed" : `${alert.consecutive} consecutive failures`}`,
      detail: `Run created ${new Date(alert.createdAt).toLocaleString()}${alert.kind === "main" && alert.consecutive >= 3 ? ` · ${alert.consecutive} consecutive failures` : ""}` })),
    ...(jobRepo?.signals ?? []).filter((signal) => signal.open && signal.severity !== "info").map((signal) => ({ key: signal.id, href: signal.where.url ?? `https://github.com/${repo.repository}/actions`,
      rank: signal.kind === "pool_stall" ? -1 : signal.severity === "critical" ? 0 : 1, at: Date.parse(signal.since), tone: signal.severity === "critical" ? "text-destructive" : "text-amber-600 dark:text-amber-400",
      title: signalTitle(signal), detail: `${signal.what} · Who acts: ${signals?.actors?.[signal.actor] ?? signal.actor} · ${ago(signal.since, signals?.now ?? Date.now())}` })),
  ].sort((a, b) => a.rank - b.rank || b.at - a.at) : [];
  return <section aria-label="CI signals" className="min-w-0 space-y-3">
    <div><h5 className="text-sm font-medium">Needs attention</h5><p className="mt-1 text-xs text-muted-foreground">Latest completed runs within {repo.range.label} · cancelled, skipped and deferred drafts excluded</p></div>
    {!ready ? repo.pending?.includes("ci") ? <LoadingSkeleton label="Loading CI signals" /> : <p className="text-sm text-muted-foreground">{unavailable(repo)}</p> : <>
      {data.identified < data.total && <p className="text-xs text-muted-foreground">Workflow details available for {data.identified} of {data.total} runs. Refresh to complete coverage.</p>}
      {!data.defaultBranch && <p className="text-xs text-muted-foreground">Default branch is unavailable; main-branch checks could not be evaluated.</p>}
      {rows.length ? <ul className="divide-y divide-border">{rows.slice(0, 5).map((row) => <li key={row.key} className="space-y-1 py-2 first:pt-0">
        <UrlLink href={row.href} className={`break-words text-sm hover:underline ${row.tone}`}>{row.title}</UrlLink>
        <p className="text-xs text-muted-foreground">{row.detail}</p>
      </li>)}</ul> : <p className="text-sm text-muted-foreground">{data.total === 0 ? "No completed runs in this range." : data.identified < data.total || !data.defaultBranch ? "No problems detected in the available workflow details." : "No failed latest default-branch runs or repeated failures in this range."}</p>}
      {rows.length > 5 && <p className="text-xs text-muted-foreground">Showing 5 of {rows.length} signals.</p>}
      {signals?.error && <p role="alert" className="text-sm text-destructive">Job-level signals failed to load. <Button variant="outline" size="sm" onClick={signals.retry}>Retry</Button></p>}
      {signals?.loading && <LoadingSkeleton label="Loading job-level signals"><Skeleton className="h-3 w-3/4" /></LoadingSkeleton>}
      <div className="grid grid-cols-2 gap-3 border-t border-border pt-3 text-sm">
        {data.main && <p>{data.defaultBranch}: <strong className="tabular-nums">{passRate(data.main)}</strong><span className="block text-xs text-muted-foreground">{data.main.eligible} counted runs</span></p>}
        <p>PR workflows: <strong className="tabular-nums">{passRate(data.pullRequests)}</strong><span className="block text-xs text-muted-foreground">{data.pullRequests.eligible} counted runs</span></p>
      </div>
    </>}
  </section>;
}

const outcomeLabels: Record<string, string> = { success: "passed", failure: "failed", cancelled: "cancelled", timed_out: "timed out", startup_failure: "failed to start" };

/** Right-column job-level part of the CI health card: failure causes plus secondary blocks that only render when they have rows. */
export function CiJobCauses({ repo, signals, part }: { repo: Metrics; signals: JobSignals; part: "causes" | "details" }) {
  const { repo: job, now } = signals;
  if (signals.loading) return part === "details" ? null : <LoadingSkeleton label="Loading failure causes" className="grid grid-cols-2 gap-3 space-y-0 border-t border-border pt-3">{[0, 1, 2, 3].map((key) => <div key={key} className="space-y-2"><Skeleton className="h-3 w-16" /><Skeleton className="h-6 w-12" /></div>)}</LoadingSkeleton>;
  if (!job) return null;
  const counts = job.failureCounts, n = (key: string) => (counts as Record<string, number>)[key] ?? 0;
  const causes = [["Runner losses", n("runner_loss")], ["Flaky jobs", n("flake")], ["Network/tool errors", n("transient")], ["Real failures", n("real")]] as const;
  const open = job.signals.filter((signal) => signal.open);
  const stalled = new Set(open.filter((signal) => signal.kind === "pool_stall").map((signal) => signal.where.pool));
  const pools = [...job.live.pools].sort((a, b) => Number(stalled.has(b.pool)) - Number(stalled.has(a.pool)));
  const idle = pools.filter((pool) => !pool.queued && !pool.inProgress && !stalled.has(pool.pool));
  const busy = pools.filter((pool) => !idle.includes(pool));
  const lossCount = Object.values(job.runnerLosses.byPool).reduce((sum, tally) => sum + tally.count, 0);
  const lossGroups = ([["By pool", job.runnerLosses.byPool], ["By job", job.runnerLosses.byJob]] as const).map(([label, table]) => [label, Object.entries(table).sort((a, b) => b[1].count - a[1].count).slice(0, 5)] as const).filter(([, rows]) => rows.length);
  const lower = open.filter((signal) => signal.severity === "info");
  const lowerKinds = Object.entries(lower.reduce<Record<string, number>>((acc, signal) => ({ ...acc, [signal.kind]: (acc[signal.kind] ?? 0) + 1 }), {}));
  const resolved = job.signals.filter((signal) => !signal.open && now - Date.parse(signal.until ?? signal.since) <= 7 * 86400000);
  const since = Date.parse(repo.range.since), covered = job.coverage ?? job.backfill.coveredSince;
  const days = Math.round((Date.parse(job.window.until) - Date.parse(job.window.since)) / 86400000);
  const block = (name: string, count: number, body: ReactNode) => count > 0 && <details className="space-y-2 border-t border-border pt-3"><summary className="cursor-pointer text-sm">{name} · {count}</summary>{body}</details>;
  if (part === "causes") return <section aria-label="Failure causes" className="space-y-3 border-t border-border pt-3">
      <h5 className="text-sm font-medium">Failure causes</h5>
      {job.error && !signals.error && <p role="alert" className="text-sm text-destructive">{job.error}</p>}
      <dl className="grid grid-cols-2 gap-3">{causes.map(([label, value]) => <div key={label}>
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd className={`text-lg font-semibold tabular-nums ${label === "Runner losses" && value > 0 ? "text-destructive" : ""}`}>{value.toLocaleString()}</dd>
      </div>)}</dl>
      <p className="text-xs text-muted-foreground">{(n("timeout") > 0 || n("unknown") > 0) && <>Also: {n("timeout")} timed out, {n("unknown")} without a recognizable cause · </>}Not counted: {n("superseded")} superseded by newer runs, {n("manual_cancel")} cancelled manually, {n("collateral_cancel")} cancelled with the run, {n("consequence")} aggregator jobs</p>
      {job.backfill.remaining > 0 && <p className="text-xs text-muted-foreground">Loading job history: {job.backfill.remaining.toLocaleString()} attempts left</p>}
      {job.backfill.remaining > 0 && covered && since < Date.parse(covered) && <p className="text-xs text-muted-foreground">Job-level causes cover {new Date(covered).toLocaleString()} onward — history is still loading</p>}
      {job.backfill.remaining === 0 && since < Date.parse(job.window.since) && <p className="text-xs text-muted-foreground">Job-level causes are kept for the last {days} days</p>}
    </section>;
  return <>
    {block("Runner pools", pools.length, <>
      {busy.map((pool) => <p key={pool.pool} className={`text-sm ${stalled.has(pool.pool) ? "text-destructive" : ""}`}>{pool.pool} — {pool.inProgress} running, {pool.queued} waiting</p>)}
      {idle.length > 0 && <p className="text-xs text-muted-foreground">Idle: {idle.map((pool) => pool.pool).join(", ")}</p>}
    </>)}
    {block("Runner losses", lossCount, lossGroups.map(([label, rows]) => <div key={label} className="space-y-2"><p className="text-xs text-muted-foreground">{label}</p>
      {rows.map(([name, tally]) => <p key={name} className="break-words text-sm">{name}<span className="block text-xs text-muted-foreground">{tally.count} losses · {runMinutes(tally.runnerMs)} of runner time</span></p>)}</div>))}
    {block("Reruns", job.reruns.length, job.reruns.slice(0, 10).map((run) => <p key={run.runId} className="text-sm">
      <UrlLink href={run.url} className="break-words hover:underline">{run.workflowName} #{run.runId}</UrlLink>
      <span className="block text-xs text-muted-foreground">{run.headBranch ?? "unknown branch"} · {run.outcomes.map((outcome) => outcomeLabels[outcome ?? ""] ?? "unknown").join(" → ")} · {runMinutes(run.repeatedRunnerMs)} repeated runner time</span>
    </p>))}
    {block("Lower-priority events", lower.length, lowerKinds.map(([kind, count]) => <p key={kind} className="text-sm">{kindLabels[kind as Signal["kind"]]}<span className="block text-xs text-muted-foreground">{count} open</span></p>))}
    {block("Resolved incidents", resolved.length, resolved.slice(0, 10).map((signal) => <p key={signal.id} className="text-sm">
      <UrlLink href={signal.where.url ?? `https://github.com/${repo.repository}/actions`} className="break-words hover:underline">{signalTitle(signal)}</UrlLink>
      <span className="block text-xs text-muted-foreground">{signal.what} · resolved {ago(signal.until ?? signal.since, now)}</span>
    </p>))}
    {block("Mass runner losses", job.massCancels.length, job.massCancels.map((incident) => <p key={incident.since} className="text-sm">
      {new Date(incident.since).toLocaleString()} – {new Date(incident.until).toLocaleString()}
      <span className="block text-xs text-muted-foreground">{incident.runners.join(", ")} · {incident.runIds.length} runs</span>
    </p>))}
  </>;
}

export function CiTiming({ repo }: { repo: Metrics }) {
  const data = repo.ciInsights;
  const [selectedWorkflow, setSelectedWorkflow] = useState<string | null>(null);
  const defaultWorkflow = data?.workflows.find((workflow) => workflow.name.trim().toLowerCase() === "ci");
  const selection = selectedWorkflow ?? (defaultWorkflow ? String(defaultWorkflow.id) : "all");
  const workflow = data?.workflows.find((row) => String(row.id) === selection);
  const timing = workflow?.timing ?? data?.timing;
  const successful = workflow?.passed ?? repo.ciOutcomes?.success ?? 0;
  const total = workflow?.total ?? data?.total ?? 0;
  return <Card role="region" aria-label="CI run timings" className="space-y-4 border-primary/20 p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h4 className="text-sm font-medium">CI run timings</h4><p className="mt-1 text-xs text-muted-foreground">{repo.range.label} · {workflow?.name ?? "All workflows"} · successful completed runs only</p></div>
      {data && <label className="flex items-center gap-2 text-xs text-muted-foreground">Summary workflow
        <select aria-label="Timing workflow" value={workflow ? String(workflow.id) : "all"} onChange={(event) => setSelectedWorkflow(event.target.value)} className="h-9 max-w-64 rounded-md border border-input bg-background px-3 text-sm text-foreground">
          <option value="all">All workflows</option>
          {data.workflows.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
        </select>
      </label>}
    </div>
    {!data || !timing ? repo.pending?.includes("ci") ? <LoadingSkeleton label="Loading CI timings" className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">{[0, 1, 2].map((key) => <div key={key} className="space-y-2"><Skeleton className="h-3 w-20" /><Skeleton className="h-8 w-24 max-w-full" /></div>)}</div>
      <Skeleton className="h-3 w-3/4" /><div className="grid grid-cols-1 gap-4 md:grid-cols-2"><Skeleton className="h-5 w-40" /><Skeleton className="h-5 w-40" /></div>
    </LoadingSkeleton> : <p className="text-sm text-muted-foreground">{unavailable(repo)}</p> : <>
      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3 sm:gap-6">{([
        ["Median", timing.medianMs], ["Average", timing.averageMs], ["P95", timing.p95Ms],
      ] as const).map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-xs text-muted-foreground" title={label === "P95" ? "95% of measured successful runs finish within this time or faster; about 5% take longer." : undefined}>{label}</dt><dd className="mt-1 break-words text-2xl font-semibold tracking-tight tabular-nums">{elapsed(value)}</dd></div>)}</dl>
      {!workflow && <p className="text-xs text-muted-foreground">Combined distribution across all workflows: frequent short automation runs can dominate the median. Select a workflow to compare like-for-like durations.</p>}
      <p className="text-xs text-muted-foreground">Total elapsed: {elapsed(timing.count ? timing.totalMs : null)}</p>
      <p className="text-xs text-muted-foreground">Timing available for {timing.count} of {successful} successful runs · {total - successful} non-successful runs excluded. Estimate from start to last update; reruns may inflate it. Totals add overlapping runs and are not billed runner time.</p>
      <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2">
      {data.workflows.length > 0 && <details className="border-t border-border pt-3">
        <summary className="cursor-pointer text-sm">By workflow · {data.workflows.length}</summary>
        <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground"><span>Slowest averages first</span><span>Average</span></div>
        <ul aria-label="Workflow timings" className="mt-2 space-y-2">{[...data.workflows].sort((a, b) => (b.timing.averageMs ?? -1) - (a.timing.averageMs ?? -1) || a.id - b.id).map((workflow) => <li key={workflow.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-2 rounded-md bg-muted/40 p-3">
          <UrlLink href={`https://github.com/${repo.repository}/actions/workflows/${workflow.id}`} className="min-w-0 break-words text-sm font-medium leading-snug hover:underline">{workflow.name}</UrlLink>
          <span className="whitespace-nowrap text-lg font-semibold tracking-tight tabular-nums">{elapsed(workflow.timing.averageMs)}</span>
          <div className="col-span-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>Median <span className="font-medium tabular-nums text-foreground">{elapsed(workflow.timing.medianMs)}</span></span>
            <span>P95 <span className="font-medium tabular-nums text-foreground">{elapsed(workflow.timing.p95Ms)}</span></span>
            <span className="tabular-nums">{workflow.timing.count}/{workflow.passed} successful timed</span>
            <span className="tabular-nums">{workflow.total - workflow.passed} excluded</span>
            <span className="tabular-nums">Total {elapsed(workflow.timing.count ? workflow.timing.totalMs : null)}</span>
          </div>
        </li>)}</ul>
      </details>}
      {data.slowRuns.length > 0 && <details className="border-t border-border pt-3">
        <summary className="cursor-pointer text-sm">Longest successful runs · all workflows · top {data.slowRuns.length}</summary>
        <ul aria-label="Longest CI runs" className="mt-3 space-y-2">{data.slowRuns.map((run) => <li key={run.id}>
          <UrlLink href={`https://github.com/${repo.repository}/actions/runs/${run.id}`} aria-label={`${run.name} · ${run.branch ?? "Unknown branch"} · #${run.id} · ${elapsed(run.durationMs)}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-2 rounded-md bg-muted/40 p-3 hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <span className="min-w-0 break-words text-sm font-medium leading-snug">{run.name}</span>
            <span className="whitespace-nowrap text-lg font-semibold tracking-tight tabular-nums">{elapsed(run.durationMs)}</span>
            <span className="col-span-2 flex min-w-0 items-baseline justify-between gap-3 text-xs text-muted-foreground"><span className="min-w-0 truncate" title={run.branch ?? "Unknown branch"}>{run.branch ?? "Unknown branch"}</span><span className="shrink-0 tabular-nums">#{run.id}</span></span>
          </UrlLink>
        </li>)}</ul>
      </details>}
      </div>
    </>}
  </Card>;
}
