import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { HugeiconsIcon } from "@hugeicons/react";
import Loading03Icon from "@hugeicons/core-free-icons/Loading03Icon";
import Unlink01Icon from "@hugeicons/core-free-icons/Unlink01Icon";
import AlertCircleIcon from "@hugeicons/core-free-icons/AlertCircleIcon";
import HelpCircleIcon from "@hugeicons/core-free-icons/HelpCircleIcon";
import Clock01Icon from "@hugeicons/core-free-icons/Clock01Icon";
import Alert01Icon from "@hugeicons/core-free-icons/Alert01Icon";
import { ACTIVITY_LABELS as labels, type TaskActivity } from "../shared/task-activity.js";

const icons = { abandoned: Unlink01Icon, error: AlertCircleIcon, "waiting-owner": HelpCircleIcon, queued: Clock01Icon } as const;

export function TaskActivityIndicator({ activity, failureMarker = false }: { activity?: TaskActivity; failureMarker?: boolean }) {
  if (!activity?.state) return null;
  const { state, sessions, workingCount, attachedCount, terminalWarning, hasFailure } = activity;
  const detail = [
    ...(activity.diagnostics ? [activity.diagnostics.explanation] : []),
    ...sessions.map((session) => `${session.title || session.threadId} (${session.role === "parent" ? "Parent thread" : "Worker"}): ${labels[session.state]}`),
    ...(terminalWarning ? ["Warning: work continues on a done or canceled card"] : []),
    ...(hasFailure ? ["Linked thread failed"] : []),
  ].join("\n");
  const label = labels[state] + (state === "working" && attachedCount > 1 ? ` · ${workingCount}/${attachedCount}` : "");
  const color = state === "working" ? "text-success" : state === "error" ? "text-destructive" : state === "abandoned" ? "text-warning" : state === "waiting-owner" ? "text-warning" : "text-muted-foreground";
  return <TooltipProvider delayDuration={300}><Tooltip><TooltipTrigger asChild><span tabIndex={0} className={`inline-flex items-center gap-1 ${color}`} aria-label={`${label}${detail ? `: ${detail}` : ""}`}>
    {state === "working" ? <HugeiconsIcon icon={Loading03Icon} aria-hidden className="size-3 animate-spin motion-reduce:animate-none" /> : state === "attached" ? <span aria-hidden className="size-1.5 rounded-full bg-current" /> : state === "error" && failureMarker ? null : <HugeiconsIcon icon={icons[state]} aria-hidden className="size-3" />}
    {label}
    {hasFailure && state === "working" && !failureMarker ? <HugeiconsIcon icon={AlertCircleIcon} aria-hidden className="size-3 text-destructive" /> : null}
    {terminalWarning ? <HugeiconsIcon icon={Alert01Icon} aria-hidden className="size-3 text-warning" /> : null}
  </span></TooltipTrigger><TooltipContent className="whitespace-pre-line !animate-none">{detail || label}</TooltipContent></Tooltip></TooltipProvider>;
}
