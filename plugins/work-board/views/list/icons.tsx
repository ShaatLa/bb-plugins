import type { TaskPriority, TaskStatus } from "../../shared/contract.js";
import { cn } from "@/lib/utils";

export { StatusIcon } from "../../components/status-icon.js";

const ACTIVE_BARS: Record<Exclude<TaskPriority, "urgent">, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
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
        className={cn("size-3.5 shrink-0 text-warning", className)}
      >
        <rect
          x="0.5"
          y="0.5"
          width="13"
          height="13"
          rx="3"
          fill="currentColor"
        />
        <rect
          x="6.2"
          y="3"
          width="1.6"
          height="5.2"
          rx="0.8"
          fill="var(--background)"
        />
        <circle cx="7" cy="10.6" r="1" fill="var(--background)" />
      </svg>
    );
  }
  const active = ACTIVE_BARS[priority];
  const bars = [
    { x: 1.5, y: 8, height: 5 },
    { x: 5.5, y: 5, height: 8 },
    { x: 9.5, y: 2, height: 11 },
  ];
  return (
    <svg
      viewBox="0 0 14 14"
      aria-hidden
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
          y={bar.y}
          width="3"
          height={bar.height}
          rx="1"
          className={index < active ? "fill-muted-foreground" : "fill-muted"}
        />
      ))}
    </svg>
  );
}
