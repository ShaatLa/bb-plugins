import { useRef, useState } from "react";
import { productionTarget } from "./production";
import type { rpcContract } from "./server";
import { Button } from "./components/ui/button";
import { UrlLink, useRpc } from "@get-bb/plugin-sdk/app";
import type { Metrics } from "./metrics";
import { Card } from "./components/ui/card";

function ageLabel(timestamp: string, checkedAt: string) {
  const hours = Math.max(0, Math.floor((Date.parse(checkedAt) - Date.parse(timestamp)) / 3_600_000));
  if (hours < 1) return "<1h";
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d${hours % 24 ? ` ${hours % 24}h` : ""}`;
}

const labels: Record<string, string> = {
  success: "Passed", failure: "Failed", cancelled: "Cancelled", skipped: "Skipped", timed_out: "Timed out",
  action_required: "Action required", neutral: "Neutral", stale: "Stale", startup_failure: "Startup failed", unknown: "Unknown",
};

export function RepositoryDetails({ repo }: { repo: Metrics }) {
  const { reviewQueue, production } = repo;
  const deployment = production.deployment;
  return <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
    <CiOutcomes repo={repo} />
    <Card role="region" aria-label="PRs awaiting review" className="space-y-3 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-medium">PRs awaiting review</h4>
        {reviewQueue.total !== null && <span className="text-xs text-muted-foreground">{reviewQueue.total} total</span>}
      </div>
      <p className="text-xs text-muted-foreground">No reviews yet · excludes drafts · oldest 5</p>
      {reviewQueue.error ? <p role="alert" className="text-sm text-destructive">{reviewQueue.error}</p>
        : reviewQueue.total === 0 ? <p className="text-sm text-muted-foreground">No unreviewed PRs.</p>
        : <ul className="divide-y divide-border">{reviewQueue.items.map((pr) => <li key={pr.number} className="flex items-start justify-between gap-3 py-2 first:pt-0">
          <UrlLink href={pr.url} className="min-w-0 break-words text-sm hover:underline">#{pr.number} {pr.title}</UrlLink>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground" title={`Opened ${new Date(pr.createdAt).toLocaleString()}`}>{ageLabel(pr.createdAt, repo.updatedAt)} open</span>
        </li>)}</ul>}
      <UrlLink href={`https://github.com/${repo.repository}/pulls?q=${encodeURIComponent("is:pr is:open draft:false review:none")}`} className="inline-block text-xs text-muted-foreground hover:underline">View review queue ↗</UrlLink>
    </Card>
    <Card role="region" aria-label="Latest production deployment" className="space-y-3 p-4">
      <h4 className="text-sm font-medium">Latest production deployment</h4>
      {production.error ? <p role="alert" className="text-sm text-destructive">{production.error}</p>
        : deployment ? <>
          <span className={`inline-block rounded-md border px-2 py-1 text-xs ${deployment.state === "success" ? "border-emerald-500/30 text-emerald-500" : ["failure", "error"].includes(deployment.state) ? "border-destructive/30 text-destructive" : "border-border text-muted-foreground"}`}>{deployment.state.replaceAll("_", " ")}</span>
          <p className="break-all text-sm">{deployment.environment} · {deployment.ref}</p>
          <p className="text-xs text-muted-foreground" title={new Date(deployment.createdAt).toLocaleString()}>Created {ageLabel(deployment.createdAt, repo.updatedAt)} ago</p>
          <p className="text-xs text-muted-foreground">Updated {new Date(deployment.updatedAt).toLocaleString()}</p>
          <UrlLink href={deployment.url} className="inline-block text-sm hover:underline">View deployment ↗</UrlLink>
        </> : <p className="text-sm text-muted-foreground">No production deployment found.</p>}
      {repo.repository.toLowerCase() === productionTarget.repository && <ProductionDeployButton />}
    </Card>
  </div>;
}


function ProductionDeployButton() {
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
    <p>Production workflow requested.</p><UrlLink href={url} className="hover:underline">View workflow ↗</UrlLink>
  </div>;
  return <div className="space-y-3 border-t border-border pt-3">
    <Button ref={trigger} size="sm" variant="outline" disabled={pending} aria-expanded={confirm} onClick={() => setConfirm(true)}>Deploy production</Button>
    {confirm && <div role="group" aria-label="Confirm production deployment" className="space-y-3">
      <p className="break-all text-sm">Deploy {productionTarget.repository} from {productionTarget.ref}?</p>
      <p className="text-xs text-muted-foreground">Starts the Production workflow with its existing checks and approvals.</p>
      {error && <p role="alert" className="text-sm text-destructive">Request not confirmed. Check the Production workflow and Actions write access before retrying.</p>}
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
    { label: "PRs created", value: repo.pullRequestsCreated.value, prefix: "", tone: "", detail: "All states · includes drafts" },
    { label: "Commits", value: activity.commits, prefix: "", tone: "", detail: activity.branch ? `${activity.branch} history` : "Default branch history" },
    { label: "Lines added", value: activity.additions, prefix: "+", tone: "text-emerald-500", detail: "Cumulative commit additions" },
    { label: "Lines deleted", value: activity.deletions, prefix: "−", tone: "text-destructive", detail: "Cumulative commit deletions" },
  ];
  return <Card role="region" aria-label={`Repository activity in the ${repo.range.label}`} className="space-y-3 p-4">
    <h4 className="text-sm font-medium">Activity · {repo.range.label}</h4>
    <dl className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 8rem), 1fr))" }}>
      {statistics.map((stat) => <div key={stat.label} className="min-w-0">
        <dt className="text-xs text-muted-foreground">{stat.label}</dt>
        <dd className="mt-1">
          <span className={`text-2xl font-semibold tabular-nums ${stat.tone}`}>{stat.value === null ? "—" : `${stat.prefix}${stat.value.toLocaleString()}`}</span>
          <p className="mt-1 break-words text-xs text-muted-foreground">{stat.detail}</p>
        </dd>
      </div>)}
    </dl>
    {repo.pullRequestsCreated.error && <p role="alert" className="text-xs text-destructive">PR activity: {repo.pullRequestsCreated.error}</p>}
    {activity.error && <p role="alert" className="text-xs text-destructive">Commit activity: {activity.error}</p>}
  </Card>;
}

export function CiOutcomes({ repo }: { repo: Metrics }) {
  return <Card role="region" aria-label="CI outcomes" className="space-y-3 p-4">
      <div><h4 className="text-sm font-medium">CI outcomes</h4><p className="mt-1 text-xs text-muted-foreground">Completed workflow runs · {repo.range.label}</p></div>
      {repo.ciOutcomes ? <dl className="grid grid-cols-2 gap-3">
        {Object.entries({ success: 0, failure: 0, cancelled: 0, skipped: 0, ...repo.ciOutcomes }).map(([state, count]) => <div key={state}>
          <dt className="text-xs text-muted-foreground">{labels[state] ?? state.replaceAll("_", " ")}</dt>
          <dd className={`text-lg font-semibold tabular-nums ${state === "success" ? "text-emerald-500" : state === "failure" || state === "timed_out" ? "text-destructive" : ""}`}>{count.toLocaleString()}</dd>
        </div>)}
      </dl> : <p className="text-sm text-muted-foreground">{repo.ci.error || repo.ci.seriesError || "Outcome breakdown is unavailable."}</p>}
    </Card>;
}
