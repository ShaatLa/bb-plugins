import { Markdown } from "@get-bb/plugin-sdk/app";
import type { Proposal, ReviewRound, ReviewStage, ReviewSummary } from "./contract";

const stageNames: Record<ReviewStage, string> = { hypothesis: "Hypothesis", result: "Result" };
const labels: Record<ReviewRound["status"], string> = {
  pending: "Awaiting reviewer", approved: "Approved", changes_requested: "Changes requested", superseded: "Needs a new review",
};

export function reviewBadge(proposal: Proposal, summary: ReviewSummary | undefined) {
  if (!summary || ["kept", "reverted", "withdrawn"].includes(proposal.state)) return;
  const stage = proposal.state === "proposed" || (!summary.legacy && summary.hypothesis?.status !== "approved")
    ? "hypothesis" : "result";
  const current = summary[stage];
  return `${stageNames[stage]} · ${current ? labels[current.status] : "Review required"}`;
}

export function ReviewPanel({ className, summary, rounds, date }: {
  className: string; summary: ReviewSummary; rounds: ReviewRound[]; date: (value: number) => string;
}) {
  return <section className={className} aria-label="Independent review">
    <h3 className="text-base font-semibold">Independent review</h3>
    <dl className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
      <div><dt className="text-xs text-muted-foreground">Reviewer</dt>
        <dd className="break-all">{summary.reviewerId ?? "Unassigned"}</dd></div>
      {(Object.keys(stageNames) as ReviewStage[]).map(stage => <div key={stage}>
        <dt className="text-xs text-muted-foreground">{stageNames[stage]}</dt>
        <dd>{summary[stage] ? labels[summary[stage].status] : "Not submitted"}</dd>
      </div>)}
    </dl>
    {summary.legacy && <p className="text-sm text-muted-foreground">
      This experiment began before hypothesis reviews were introduced. A result review is required to keep it.
    </p>}
    {rounds.map(round => {
      const { experiment, stage } = round.snapshot;
      const current = summary[stage];
      const status = current?.version === round.version ? current.status : round.status;
      return <details key={`${stage}:${round.version}`} className="rounded-md border border-border-hairline p-3">
        <summary className="cursor-pointer text-sm font-medium">
          {stageNames[stage]} v{round.version} · {labels[status]}
        </summary>
        <div className="mt-2 space-y-3 break-words">
          <p className="text-xs text-muted-foreground">
            {round.submittedBy} submitted {date(round.submittedAt)} · Reviewer {round.reviewerId}
          </p>
          {status === "pending" && round.delivery !== "sent" &&
            <p className="text-sm text-muted-foreground">Delivery · {round.delivery}</p>}
          {round.feedback && <div className="rounded-md bg-muted/35 p-2.5">
            <p className="text-xs font-medium">
              Reviewer feedback{round.verdict && ` · ${labels[round.verdict]}`}{round.decidedAt && ` · ${date(round.decidedAt)}`}
            </p>
            <Markdown content={round.feedback} />
          </div>}
          {round.snapshot.stage === "result" && <>
            <div><h4 className="font-medium">Conclusion</h4><Markdown content={round.snapshot.conclusion} /></div>
            <ul className="space-y-2">{round.snapshot.observations.map(observation => <li key={observation.seq}
              className="rounded-md border border-border-hairline p-2">
              <p className="text-xs text-muted-foreground">Observation #{observation.seq} · {date(observation.at)}</p>
              {observation.observation.value !== undefined && <p>{observation.observation.value} {observation.unit}</p>}
              {observation.observation.note && <Markdown content={observation.observation.note} />}
              <ReviewLinks links={observation.observation.evidence} />
            </li>)}</ul>
          </>}
          <div className="space-y-1">
            <h4 className="font-medium">{experiment.title}</h4>
            <Markdown content={experiment.hypothesis} />
            <p className="font-medium">Incident · {experiment.entry.title}</p>
            <Markdown content={experiment.entry.failure} />
            <Markdown content={experiment.entry.gap} />
            <ReviewLinks links={[...experiment.entry.links, ...experiment.links]} />
            <p className="font-medium">Metric</p>
            <Markdown content={experiment.metric.definition} />
            {experiment.metric.baseline !== undefined &&
              <p>Baseline · {experiment.metric.baseline} {experiment.metric.unit}</p>}
            {experiment.metric.target !== undefined &&
              <p>Target · {experiment.metric.target} {experiment.metric.unit}</p>}
            {experiment.metric.command && <p>Metric command · <code>{experiment.metric.command}</code></p>}
            <p className="font-medium">Rollback condition</p>
            <Markdown content={experiment.rollbackCondition} />
          </div>
        </div>
      </details>;
    })}
  </section>;
}

function ReviewLinks({ links }: { links?: string[] }) {
  return links?.length ? <ul className="space-y-1">
    {[...new Set(links)].map(link => <li key={link}>
      <a className="break-all underline" href={link} target="_blank" rel="noreferrer">{link}</a>
    </li>)}
  </ul> : null;
}
