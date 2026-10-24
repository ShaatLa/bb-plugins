import { UrlLink } from "@get-bb/plugin-sdk/app";
import type { Metrics } from "./metrics";
import { Card } from "./components/ui/card";
import { LoadingSkeleton, Skeleton } from "./components/ui/skeleton";

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

export function CiSignals({ repo }: { repo: Metrics }) {
  const data = repo.ciInsights;
  const ready = data;
  return <section aria-label="CI signals" className="min-w-0 space-y-3">
    <div><h5 className="text-sm font-medium">Needs attention</h5><p className="mt-1 text-xs text-muted-foreground">Latest completed runs within {repo.range.label} · cancelled and skipped excluded</p></div>
    {!ready ? repo.pending?.includes("ci") ? <LoadingSkeleton label="Loading CI signals" /> : <p className="text-sm text-muted-foreground">{unavailable(repo)}</p> : <>
      {data.identified < data.total && <p className="text-xs text-muted-foreground">Workflow details available for {data.identified} of {data.total} runs. Refresh to complete coverage.</p>}
      {!data.defaultBranch && <p className="text-xs text-muted-foreground">Default branch is unavailable; main-branch checks could not be evaluated.</p>}
      {data.alerts.length ? <ul className="divide-y divide-border">{data.alerts.slice(0, 5).map((alert) => <li key={`${alert.kind}:${alert.runId}`} className="space-y-1 py-2 first:pt-0">
        <UrlLink href={`https://github.com/${repo.repository}/actions/runs/${alert.runId}`} className={`break-words text-sm hover:underline ${alert.kind === "main" ? "text-destructive" : "text-amber-600 dark:text-amber-400"}`}>
          {alert.name} · {alert.branch}: {alert.kind === "main" ? "latest run failed" : `${alert.consecutive} consecutive failures`}
        </UrlLink>
        <p className="text-xs text-muted-foreground">Run created {new Date(alert.createdAt).toLocaleString()}{alert.kind === "main" && alert.consecutive >= 3 ? ` · ${alert.consecutive} consecutive failures` : ""}</p>
      </li>)}</ul> : <p className="text-sm text-muted-foreground">{data.total === 0 ? "No completed runs in this range." : data.identified < data.total || !data.defaultBranch ? "No problems detected in the available workflow details." : "No failed latest default-branch runs or repeated failures in this range."}</p>}
      {data.alerts.length > 5 && <p className="text-xs text-muted-foreground">Showing 5 of {data.alerts.length} signals.</p>}
      <div className="grid grid-cols-2 gap-3 border-t border-border pt-3 text-sm">
        {data.main && <p>{data.defaultBranch}: <strong className="tabular-nums">{passRate(data.main)}</strong><span className="block text-xs text-muted-foreground">{data.main.eligible} counted runs</span></p>}
        <p>PR workflows: <strong className="tabular-nums">{passRate(data.pullRequests)}</strong><span className="block text-xs text-muted-foreground">{data.pullRequests.eligible} counted runs</span></p>
      </div>
    </>}
  </section>;
}

export function CiTiming({ repo }: { repo: Metrics }) {
  const data = repo.ciInsights;
  return <Card role="region" aria-label="CI run timings" className="space-y-4 border-primary/20 p-4 sm:p-5">
    <div><h4 className="text-sm font-medium">CI run timings</h4><p className="mt-1 text-xs text-muted-foreground">{repo.range.label} · completed runs, including cancelled and skipped</p></div>
    {!data ? repo.pending?.includes("ci") ? <LoadingSkeleton label="Loading CI timings" className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">{[0, 1, 2].map((key) => <div key={key} className="space-y-2"><Skeleton className="h-3 w-20" /><Skeleton className="h-8 w-24 max-w-full" /></div>)}</div>
      <Skeleton className="h-3 w-3/4" /><div className="grid grid-cols-1 gap-4 md:grid-cols-2"><Skeleton className="h-5 w-40" /><Skeleton className="h-5 w-40" /></div>
    </LoadingSkeleton> : <p className="text-sm text-muted-foreground">{unavailable(repo)}</p> : <>
      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3 sm:gap-6">{([
        ["Median", data.timing.medianMs], ["Average", data.timing.averageMs], ["P95", data.timing.p95Ms],
      ] as const).map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-xs text-muted-foreground" title={label === "P95" ? "95% of measured runs finish within this time or faster; about 5% take longer." : undefined}>{label}</dt><dd className="mt-1 break-words text-2xl font-semibold tracking-tight tabular-nums">{elapsed(value)}</dd></div>)}</dl>
      <p className="text-xs text-muted-foreground">Total elapsed: {elapsed(data.timing.count ? data.timing.totalMs : null)}</p>
      <p className="text-xs text-muted-foreground">Timing available for {data.timing.count} of {data.total} runs. Estimate from start to last update; reruns may inflate it. Totals add overlapping runs and are not billed runner time.</p>
      <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2">
      {data.workflows.length > 0 && <details className="border-t border-border pt-3">
        <summary className="cursor-pointer text-sm">By workflow · {data.workflows.length}</summary>
        <ul className="mt-2 divide-y divide-border">{[...data.workflows].sort((a, b) => b.timing.totalMs - a.timing.totalMs || a.id - b.id).map((workflow) => <li key={workflow.id} className="flex items-start justify-between gap-3 py-2 text-sm">
          <UrlLink href={`https://github.com/${repo.repository}/actions/workflows/${workflow.id}`} className="min-w-0 break-words hover:underline">{workflow.name}<span className="block text-xs text-muted-foreground">{workflow.timing.count}/{workflow.total} timed · avg {elapsed(workflow.timing.averageMs)} · P95 {elapsed(workflow.timing.p95Ms)}</span></UrlLink>
          <span className="shrink-0 tabular-nums">{elapsed(workflow.timing.count ? workflow.timing.totalMs : null)}</span>
        </li>)}</ul>
      </details>}
      {data.slowRuns.length > 0 && <details className="border-t border-border pt-3">
        <summary className="cursor-pointer text-sm">Longest runs · top {data.slowRuns.length}</summary>
        <ul className="mt-2 space-y-2">{data.slowRuns.map((run) => <li key={run.id} className="flex items-start justify-between gap-3 text-sm"><UrlLink href={`https://github.com/${repo.repository}/actions/runs/${run.id}`} className="min-w-0 break-words hover:underline">{run.name} · {run.branch ?? "Unknown branch"} · #{run.id}</UrlLink><span className="shrink-0 tabular-nums">{elapsed(run.durationMs)}</span></li>)}</ul>
      </details>}
      </div>
    </>}
  </Card>;
}
