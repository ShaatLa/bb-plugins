import { useEffect, useState } from "react";
import { experimental_copyToClipboard } from "@get-bb/plugin-sdk/app";
import type { Task } from "../../shared/contract.js";
import { taskPlanMarkdownLink } from "../../shared/task-link.js";
import { formatRelativeTime } from "../activity/time.js";
import { usePlanOverview } from "./data.js";
import { useOpenPlan } from "./open.js";
import { PlanStateChip } from "./state-chip.js";
import { Button } from "@/components/ui/button";

/** The "Plan" section of the task detail: a summary line and buttons; the plan itself opens in its own tab. */
export function PlanCard({ task }: { task: Task }) {
  const overview = usePlanOverview(task.id);
  const openPlan = useOpenPlan();
  const [copied, setCopied] = useState<"done" | "failed" | null>(null);
  useEffect(() => {
    if (copied === null) return;
    const timer = window.setTimeout(() => setCopied(null), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const plan = overview.data?.plan ?? null;
  const last = overview.data?.versions.at(-1);
  const copyLink = async () => {
    try {
      setCopied((await experimental_copyToClipboard({ text: taskPlanMarkdownLink(task.key) })) ? "done" : "failed");
    } catch {
      setCopied("failed");
    }
  };
  return (
    <section aria-label="Plan" className="my-4 space-y-2">
      <h3 className="text-sm font-medium">Plan</h3>
      {overview.data === undefined ? (
        overview.error ? <p role="alert" className="text-sm text-destructive">{overview.error}</p> : <p className="text-sm text-muted-foreground">Loading plan…</p>
      ) : plan === null ? (
        <>
          <p className="text-sm text-muted-foreground">No plan yet</p>
          <p className="text-xs text-muted-foreground">Agents create it with <code>bb work-board plan set</code>.</p>
          {!task.archivedAt ? <Button size="sm" variant="outline" onClick={() => openPlan(task.key, { edit: true })}>Write plan</Button> : null}
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">v{plan.version}</span>
            <PlanStateChip state={plan.state} />
            <span className="text-xs text-muted-foreground">
              updated by {plan.updatedBy.name} <time dateTime={plan.updatedAt} title={plan.updatedAt}>{formatRelativeTime(plan.updatedAt, Date.now())}</time>
            </span>
          </div>
          {last?.summary ? <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{last.summary}</p> : null}
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => openPlan(task.key)}>Open plan</Button>
            <Button size="sm" variant="ghost" onClick={() => void copyLink()}>Copy link</Button>
            <span role="status" className="self-center text-xs text-muted-foreground">{copied === "done" ? "Link copied" : copied === "failed" ? "Could not copy" : ""}</span>
          </div>
        </>
      )}
    </section>
  );
}
