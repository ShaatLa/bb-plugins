import type { TaskPriority, TaskStatus } from "../../shared/contract.js";
import { cn } from "@/lib/utils";

export { StatusIcon } from "../../components/status-icon.js";

const PRIORITY_LIT_BARS: Record<Exclude<TaskPriority, "urgent">, number> = {
  high: 3,
  medium: 2,
  low: 1,
  none: 0,
};

export function PriorityIcon({
  priority,
  className,
}: {
  priority: TaskPriority;
  className?: string;
}) {
  if (priority === "urgent") {
    return (
      <svg
        viewBox="0 0 14 14"
        aria-hidden
        data-priority-icon={priority}
        className={cn("size-3.5 shrink-0", className)}
      >
        <rect width="14" height="14" rx="3" className="fill-warning" />
        <path
          d="M7 3.2v4.4"
          stroke="var(--canvas)"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <circle cx="7" cy="10.6" r="1.1" fill="var(--canvas)" />
      </svg>
    );
  }
  const lit = PRIORITY_LIT_BARS[priority];
  const bars = [
    { x: 1.5, height: 5 },
    { x: 5.5, height: 8 },
    { x: 9.5, height: 11 },
  ];
  return (
    <svg
      viewBox="0 0 14 14"
      aria-hidden
      data-priority-icon={priority}
      className={cn(
        "size-3.5 shrink-0",
        priority === "none" && "opacity-40",
        className,
      )}
    >
      {bars.map((bar, index) => (
        <rect
          key={bar.x}
          x={bar.x}
          y={13 - bar.height}
          width="3"
          height={bar.height}
          rx="1"
          className={index < lit ? "fill-muted-foreground" : "fill-muted"}
        />
      ))}
    </svg>
  );
}
