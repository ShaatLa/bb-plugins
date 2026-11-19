import { useEffect, useState } from "react";
import { experimental_copyToClipboard } from "@get-bb/plugin-sdk/app";
import type { Task } from "../../shared/contract.js";
import { taskPlanMarkdownLink } from "../../shared/task-link.js";
import { formatRelativeTime } from "../activity/time.js";
import { usePlanOverview } from "./data.js";
import { useOpenPlan } from "./open.js";
import { PlanStateChip } from "./state-chip.js";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** The "Plan" card of the task detail: version, state, last summary and meta; the whole card opens the plan tab. */
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
  const noteCounts = overview.data?.noteCounts;
  const counts = noteCounts
    ? [
        noteCounts.open ? `${noteCounts.open} open note${noteCounts.open === 1 ? "" : "s"}` : "",
        noteCounts.draft ? `${noteCounts.draft} draft` : "",
        noteCounts.addressed ? `${noteCounts.addressed} addressed` : "",
      ].filter(Boolean)
    : [];
  const frame = "relative rounded-lg border bg-card p-3 shadow-2xs";
  return (
    <section aria-label="Plan" className="my-4">
      {overview.data === undefined ? (
        <div className={cn(frame, "border-border")}>
          {overview.error ? <p role="alert" className="text-sm text-destructive">{overview.error}</p> : <p className="text-sm text-muted-foreground">Loading plan…</p>}
        </div>
      ) : plan === null ? (
        <div className={cn(frame, "flex flex-wrap items-center gap-x-3 gap-y-2 border-dashed border-border")}>
          <Icon name="FileText" fallback="File" className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-sm text-muted-foreground">No plan yet</p>
            <p className="text-xs text-muted-foreground">Agents create it with <code>bb work-board plan set</code>.</p>
          </div>
          {!task.archivedAt ? <Button size="sm" variant="outline" className="h-6 px-2 text-2xs" onClick={() => openPlan(task.key, { edit: true })}>Write plan</Button> : null}
        </div>
      ) : (
        <div className={cn(frame, "border-border transition-colors hover:border-input")}>
          {/* A stretched button makes the whole card the target; the copy button sits above it. */}
          <button
            type="button"
            aria-label={`Open plan for ${task.key}`}
            className="absolute inset-0 rounded-lg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={() => openPlan(task.key)}
          />
          <div className="flex items-center gap-2">
            <Icon name="FileText" fallback="File" className="size-4 shrink-0 text-muted-foreground" />
            <h3 className="text-sm font-medium">Plan</h3>
            <PlanStateChip state={plan.state} />
            <span className="ml-auto text-xs text-muted-foreground">v{plan.version}</span>
            <span role="status" className="text-xs text-muted-foreground">{copied === "done" ? "Link copied" : copied === "failed" ? "Could not copy" : ""}</span>
            <TooltipProvider delayDuration={300}>
              <Tooltip disableHoverableContent>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="relative z-10 size-7 shrink-0 text-muted-foreground hover:text-foreground"
                    aria-label="Copy link"
                    onClick={(event) => {
                      event.stopPropagation();
                      void copyLink();
                    }}
                  >
                    <Icon name="Copy" fallback="Paperclip" className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Copy link</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          {last?.summary ? <p className="mt-2 line-clamp-2 text-sm [overflow-wrap:anywhere]">{last.summary}</p> : null}
          <p className="mt-1 text-xs text-muted-foreground">
            Updated by {plan.updatedBy.name} · <time dateTime={plan.updatedAt} title={plan.updatedAt}>{formatRelativeTime(plan.updatedAt, Date.now())}</time>
            {counts.length ? <span data-testid="note-counts"> · {counts.join(" · ")}</span> : null}
          </p>
        </div>
      )}
    </section>
  );
}
