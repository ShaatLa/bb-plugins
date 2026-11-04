import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Icon } from "@/components/ui/icon";
import type { TaskActivity } from "../shared/task-activity.js";

const labels = { working: "Working", attached: "Attached", abandoned: "Брошена", error: "Ошибка", "waiting-owner": "Ждёт владельца", queued: "В очереди" } as const;
const icons = { abandoned: "Unlink", error: "AlertCircle", "waiting-owner": "CircleHelp", queued: "Clock" } as const;

export function TaskActivityIndicator({ activity, failureMarker = false }: { activity?: TaskActivity; failureMarker?: boolean }) {
  if (!activity?.state) return null;
  const { state, sessions, workingCount, attachedCount, terminalWarning, hasFailure } = activity;
  const detail = [
    ...sessions.map((session) => `${session.title || session.threadId} (${session.role === "parent" ? "Parent thread" : "Worker"}): ${labels[session.state]}`),
    ...(terminalWarning ? ["Внимание: работа продолжается на завершённой или отменённой карточке"] : []),
    ...(hasFailure ? ["Ошибка связанного треда"] : []),
  ].join("\n");
  const label = labels[state] + (state === "working" && attachedCount > 1 ? ` · ${workingCount}/${attachedCount}` : "");
  const color = state === "working" ? "text-success" : state === "error" ? "text-destructive" : state === "abandoned" ? "text-warning" : state === "waiting-owner" ? "text-warning" : "text-muted-foreground";
  return <TooltipProvider delayDuration={300}><Tooltip><TooltipTrigger asChild><span tabIndex={0} className={`inline-flex items-center gap-1 ${color}`} aria-label={`${label}${detail ? `: ${detail}` : ""}`}>
    {state === "working" ? <Icon name="LoaderCircle" aria-hidden className="size-3 animate-spin motion-reduce:animate-none" /> : state === "attached" ? <span aria-hidden className="size-1.5 rounded-full bg-current" /> : state === "error" && failureMarker ? null : <Icon name={icons[state]} aria-hidden className="size-3" />}
    {label}
    {hasFailure && state === "working" && !failureMarker ? <Icon name="AlertCircle" aria-hidden className="size-3 text-destructive" /> : null}
    {terminalWarning ? <Icon name="AlertTriangle" aria-hidden className="size-3 text-warning" /> : null}
  </span></TooltipTrigger><TooltipContent className="whitespace-pre-line !animate-none">{detail || label}</TooltipContent></Tooltip></TooltipProvider>;
}
