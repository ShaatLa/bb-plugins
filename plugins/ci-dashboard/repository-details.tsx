import { useRef, useState } from "react";
import { productionTargetFrom, type ProductionTarget } from "./production";
import type { rpcContract } from "./server";
import { Button } from "./components/ui/button";
import { experimental_Icon as Icon, UrlLink, useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import type { Metrics } from "./metrics";
import { Card } from "./components/ui/card";
import { Summary } from "./components/ui/summary";
import { LoadingSkeleton, Skeleton } from "./components/ui/skeleton";
import { CiJobCauses, CiRunNotes, Disclosure, percent } from "./ci-cards";
import { CiProblems, ProblemsBadge } from "./ci-problems-view";
import { useRepositorySignals, type JobSignals } from "./signals-panel";
import { CardDetailsView } from "./card-details-view";

function ageLabel(timestamp: string, checkedAt: string) {
  const hours = Math.max(0, Math.floor((Date.parse(checkedAt) - Date.parse(timestamp)) / 3_600_000));
  if (hours < 1) return "<1h";
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d${hours % 24 ? ` ${hours % 24}h` : ""}`;
}

const labels: Record<string, string> = {
  deferred_draft: "Deferred: draft", success: "Passed", failure: "Failed", cancelled: "Cancelled", skipped: "Skipped", timed_out: "Timed out",
  action_required: "Action required", neutral: "Neutral", stale: "Stale", startup_failure: "Startup failed", unknown: "Unknown",
};

export function RepositoryDetails({ repo }: { repo: Metrics }) {
  const { reviewQueue, production } = repo;
  const deployment = production.deployment;
  const target = productionTargetFrom(useSettings().values);
  return <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-2">
    <Card role="region" aria-label="PRs awaiting review" className="space-y-3 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-medium">PRs awaiting review</h4>
        {reviewQueue.total !== null && <span className="text-xs text-muted-foreground">{reviewQueue.total} total</span>}
      </div>
      <p className="text-xs text-muted-foreground">No reviews yet · excludes drafts</p>
      {repo.pending?.includes("reviewQueue") && reviewQueue.total === null ? <LoadingSkeleton label="Loading review queue…" /> : reviewQueue.error ? <p role="alert" className="text-sm text-destructive-text">{reviewQueue.error}</p>
        : reviewQueue.total === 0 ? <p className="text-sm text-muted-foreground">No unreviewed PRs.</p>
        : <ul className="divide-y divide-border">{reviewQueue.items.map((pr) => <li key={pr.number} className="flex items-start justify-between gap-3 py-2 first:pt-0">
          <UrlLink href={pr.url} className="min-w-0 break-words text-sm hover:underline">#{pr.number} {pr.title}</UrlLink>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground" title={`Opened ${new Date(pr.createdAt).toLocaleString()}`}>{ageLabel(pr.createdAt, repo.updatedAt)} open</span>
        </li>)}</ul>}
      <UrlLink href={`https://github.com/${repo.repository}/pulls?q=${encodeURIComponent("is:pr is:open draft:false review:none")}`} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline">View review queue<Icon name="ExternalLink" aria-hidden className="size-3 shrink-0" /></UrlLink>
    </Card>
    <Card role="region" aria-label="Latest production deployment" className="space-y-3 p-4">
      <h4 className="text-sm font-medium">Latest production deployment</h4>
      {repo.pending?.includes("production") && !deployment ? <LoadingSkeleton label="Loading production deployment…" /> : production.error ? <p role="alert" className="text-sm text-destructive-text">{production.error}</p>
        : deployment ? <>
          <span className={`inline-block rounded-md border px-2 py-1 text-xs ${deployment.state === "success" ? "border-success/30 bg-success/10 text-diff-added" : ["failure", "error"].includes(deployment.state) ? "border-destructive/30 text-destructive-text" : "border-border text-muted-foreground"}`}>{deployment.state.replaceAll("_", " ")}</span>
          <p className="break-all text-sm">{deployment.environment} · {deployment.ref}</p>
          <p className="text-xs text-muted-foreground" title={new Date(deployment.createdAt).toLocaleString()}>Created {ageLabel(deployment.createdAt, repo.updatedAt)} ago</p>
          <p className="text-xs text-muted-foreground">Updated {new Date(deployment.updatedAt).toLocaleString()}</p>
          <UrlLink href={deployment.url} className="inline-flex items-center gap-1 text-sm hover:underline">View deployment<Icon name="ExternalLink" aria-hidden className="size-3.5 shrink-0" /></UrlLink>
          <CardDetailsView key={`${repo.repository}:${deployment.environment}`} input={{ kind: "production", repository: repo.repository, environment: deployment.environment }} />
        </> : <p className="text-sm text-muted-foreground">No production deployment found.</p>}
      {target?.repository.toLowerCase() === repo.repository.toLowerCase() && <ProductionDeployButton target={target} />}
    </Card>
  </div>;
}


function ProductionDeployButton({ target }: { target: ProductionTarget }) {
  const rpc = useRpc<typeof rpcContract>();
  const trigger = useRef<HTMLButtonElement>(null);
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  async function deploy() {
    if (pending) return;
    setPending(true);
    setError(false);
    try { setUrl((await rpc.call("deployProduction")).url); }
    catch { setError(true); }
    finally { setPending(false); }
  }
  if (url) return <div role="status" className="space-y-2 text-sm">
    <p>Production workflow requested.</p><UrlLink href={url} className="inline-flex items-center gap-1 hover:underline">View workflow<Icon name="ExternalLink" aria-hidden className="size-3.5 shrink-0" /></UrlLink>
  </div>;
  return <div className="space-y-3 border-t border-border pt-3">
    <Button ref={trigger} size="sm" variant="outline" disabled={pending} aria-expanded={confirm} onClick={() => setConfirm(true)}>Deploy to production</Button>
    {confirm && <div role="group" aria-label="Confirm production deployment" className="space-y-3">
      <p className="break-all text-sm">Deploy {target.repository} from {target.ref}?</p>
      {error && <p role="alert" className="text-sm text-destructive-text">Request not confirmed. Check the production workflow and Actions write access before retrying.</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" autoFocus disabled={pending} onClick={() => { setConfirm(false); setError(false); trigger.current?.focus(); }}>Cancel</Button>
        <Button size="sm" disabled={pending} aria-busy={pending} onClick={() => void deploy()}>{pending ? "Requesting…" : "Start deployment"}</Button>
      </div>
    </div>}
  </div>;
}


export function RepositoryActivity({ repo }: { repo: Metrics }) {
  const activity = repo.commitActivity;
  const statistics = [
    { label: "PRs created", value: repo.pullRequestsCreated.value, prefix: "", tone: "", detail: "Includes drafts" },
    { label: "Commits", value: activity.commits, prefix: "", tone: "", detail: activity.branch ? `${activity.branch} history` : "Default branch history" },
    { label: "Lines added", value: activity.additions, prefix: "+", tone: "text-diff-added", detail: "" },
    { label: "Lines deleted", value: activity.deletions, prefix: "−", tone: "text-diff-removed", detail: "" },
  ];
  return <Card role="region" aria-label={`Repository activity ${repo.range.label === "today" ? "today" : `in the ${repo.range.label}`}`} className="space-y-3 p-4">
    <h4 className="text-sm font-medium">Activity · {repo.range.label}</h4>
    <dl className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 8rem), 1fr))" }}>
      {statistics.map((stat) => <div key={stat.label} className="min-w-0">
        <dt className="text-xs text-muted-foreground">{stat.label}</dt>
        <dd className="mt-1">
          {stat.value === null && repo.pending?.includes(stat.label === "PRs created" ? "pullRequestsCreated" : "commitActivity") ? <LoadingSkeleton label={`Loading ${stat.label}`} /> : <><span className={`text-2xl font-semibold tabular-nums ${stat.tone}`}>{stat.value === null ? "—" : `${stat.prefix}${stat.value.toLocaleString()}`}</span>
          <p className="mt-1 break-words text-xs text-muted-foreground">{repo.pending?.includes(stat.label === "PRs created" ? "pullRequestsCreated" : "commitActivity") ? "Updating…" : stat.detail}</p></>}
        </dd>
      </div>)}
    </dl>
    {repo.pullRequestsCreated.error && <p role="alert" className="text-xs text-destructive-text">PR activity: {repo.pullRequestsCreated.error}</p>}
    {activity.error && <p role="alert" className="text-xs text-destructive-text">Commit activity: {activity.error}</p>}
  </Card>;
}

export function CiOutcomes({ repo, showDetails = false }: { repo: Metrics; showDetails?: boolean }) {
  return showDetails ? <CiHealth repo={repo} /> : <CiOutcomesCard repo={repo} />;
}

function CiHealth({ repo }: { repo: Metrics }) {
  return <CiOutcomesCard repo={repo} signals={useRepositorySignals(repo.repository, repo.range)} />;
}

function CiOutcomesCard({ repo, signals }: { repo: Metrics; signals?: JobSignals }) {
  const outcomes = repo.pending?.includes("ci") && !repo.ciOutcomes ? <LoadingSkeleton label="Loading CI outcomes…" className="grid grid-cols-2 gap-3 space-y-0">{[0, 1, 2, 3].map((key) => <div key={key} className="space-y-2"><Skeleton className="h-3 w-16" /><Skeleton className="h-6 w-12" /></div>)}</LoadingSkeleton> : repo.ciOutcomes ? <dl className="grid grid-cols-2 gap-3">
    {Object.entries({ success: 0, failure: 0, cancelled: 0, skipped: 0, ...repo.ciOutcomes }).map(([state, count]) => <div key={state}>
      <dt className="text-xs text-muted-foreground">{labels[state] ?? state.replaceAll("_", " ")}</dt>
      <dd className={`text-lg font-semibold tabular-nums ${state === "success" ? "text-diff-added" : state === "failure" || state === "timed_out" ? "text-destructive-text" : ""}`}>{count.toLocaleString()}</dd>
    </div>)}
  </dl> : <p className="text-sm text-muted-foreground">{repo.ci.error || repo.ci.seriesError || "Outcome breakdown is unavailable."}</p>;
  if (!signals) return <Card role="region" aria-label="CI outcomes" className="space-y-4 p-4"><div><h4 className="text-sm font-medium">CI outcomes</h4></div>{outcomes}</Card>;
  const failing = !repo.pending?.includes("ci") && repo.ciInsights?.workflows.filter((workflow) => workflow.failed > 0).sort((a, b) => b.failed - a.failed).slice(0, 3);
  const overview = <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-2">
    <section aria-label="Outcomes" className="space-y-3"><h5 className="text-sm font-medium">Outcomes</h5>{outcomes}</section>
    <CiJobCauses repo={repo} signals={signals} part="causes" />
  </div>;
  // With no open problems the overview has the space to itself; otherwise problems come first and it moves into Details.
  const allGood = signals.repo?.problems.every((problem) => problem.handled) ?? false;
  return <Card role="region" aria-label="CI health" className="space-y-4 p-4">
    <div><h4 className="flex flex-wrap items-center gap-2 text-sm font-medium">CI health <ProblemsBadge signals={signals} /></h4></div>
    <CiProblems repository={repo.repository} signals={signals} />
    {allGood && overview}
    <details className="border-t border-border pt-3">
      <Summary className="text-sm">Details</Summary>
      <div className="mt-3 space-y-3">
        {!allGood && overview}
        <CiRunNotes repo={repo} />
        {failing && failing.length > 0 && <Disclosure name="Top failing workflows" count={failing.length} hint={`worst: ${failing[0].name}`}>
          {failing.map((workflow) => <p key={workflow.id} className="text-sm">
            <UrlLink href={`https://github.com/${repo.repository}/actions/runs/${workflow.failureId}`} className="break-words hover:underline">{workflow.name}</UrlLink>
            <span className="text-xs text-muted-foreground"> — {workflow.failed.toLocaleString()} failed · {percent(workflow)} passed</span>
          </p>)}
        </Disclosure>}
        <CiJobCauses repo={repo} signals={signals} part="details" />
        <CardDetailsView key={`${repo.repository}:${repo.range.since}:${repo.range.until}`} input={{ kind: "ci", repository: repo.repository, since: repo.range.since, until: repo.range.until }} />
      </div>
    </details>
  </Card>;
}
