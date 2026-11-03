import type {
  TaskPriority,
  TaskPullRequest,
  TaskStatus,
  TaskThread,
} from "../../shared/contract.js";
import type { IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export { StatusIcon } from "../../components/status-icon.js";

export function PriorityIcon({
  priority,
  className,
}: {
  priority: TaskPriority;
  className?: string;
}) {
  if (priority === "urgent") {
    return (
      <span
        aria-hidden
        className={cn(
          "flex size-3.5 shrink-0 items-center justify-center rounded-xs bg-warning text-2xs font-extrabold",
          className,
        )}
        style={{ color: "var(--canvas)" }}
      >
        !
      </span>
    );
  }
  const lit =
    priority === "high"
      ? 3
      : priority === "medium"
        ? 2
        : priority === "low"
          ? 1
          : 0;
  const heights = [5, 8, 11];
  return (
    <svg
      viewBox="0 0 14 14"
      aria-hidden
      className={cn(
        "size-3.5 shrink-0",
        priority === "none" ? "opacity-40" : undefined,
        className,
      )}
    >
      {heights.map((height, index) => (
        <rect
          key={index}
          x={1.5 + index * 4.5}
          y={12.5 - height}
          width="3"
          height={height}
          rx="1"
          fill={index < lit ? "var(--muted-foreground)" : "var(--muted)"}
        />
      ))}
    </svg>
  );
}

export const THREAD_STATUS_META: Record<
  TaskThread["liveStatus"],
  { label: string; dotClassName: string; textClassName: string }
> = {
  starting: {
    label: "Starting",
    dotClassName: "bg-attention animate-pulse",
    textClassName: "text-attention",
  },
  working: {
    label: "Working",
    dotClassName: "bg-success animate-pulse",
    textClassName: "text-success",
  },
  idle: {
    label: "Idle",
    dotClassName: "bg-muted-foreground",
    textClassName: "text-muted-foreground",
  },
  completed: {
    label: "Completed",
    dotClassName: "bg-muted",
    textClassName: "text-muted-foreground",
  },
  failed: {
    label: "Failed",
    dotClassName: "bg-destructive",
    textClassName: "text-destructive",
  },
};

export const PR_STATE_META: Record<
  TaskPullRequest["state"],
  { label: string; icon: IconName; textClassName: string }
> = {
  open: {
    label: "Open",
    icon: "GitPullRequestArrow",
    textClassName: "text-success",
  },
  draft: {
    label: "Draft",
    icon: "GitPullRequestDraft",
    textClassName: "text-muted-foreground",
  },
  merged: {
    label: "Merged",
    icon: "GitMerge",
    textClassName: "text-pr-merged",
  },
  closed: {
    label: "Closed",
    icon: "GitPullRequestClosed",
    textClassName: "text-destructive",
  },
};

export function isActiveThread(thread: TaskThread): boolean {
  return thread.liveStatus === "starting" || thread.liveStatus === "working";
}

export function formatRelativeTime(iso: string): string {
  const then = new Date(iso).valueOf();
  if (Number.isNaN(then)) return "";
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function formatDueDate(dueDate: string): string {
  const parsed = new Date(`${dueDate}T00:00:00`);
  if (Number.isNaN(parsed.valueOf())) return dueDate;
  const sameYear = parsed.getFullYear() === new Date().getFullYear();
  return parsed.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}
