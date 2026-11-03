import type { TaskStatus } from "../shared/contract.js";
import { paletteColor } from "../shared/colors.js";
import { TASK_STATUSES, type StatusIconName, type StatusColor } from "../shared/statuses.js";
import { useTaskStatuses } from "../shell/task-statuses.js";
import { cn } from "@/lib/utils";
import { HugeiconsIcon } from "@hugeicons/react";
import Clock01Icon from "@hugeicons/core-free-icons/Clock01Icon";
import PauseIcon from "@hugeicons/core-free-icons/PauseIcon";
import PlayIcon from "@hugeicons/core-free-icons/PlayIcon";
import Search01Icon from "@hugeicons/core-free-icons/Search01Icon";
import TestTube01Icon from "@hugeicons/core-free-icons/TestTube01Icon";
import Bug01Icon from "@hugeicons/core-free-icons/Bug01Icon";
import Alert01Icon from "@hugeicons/core-free-icons/Alert01Icon";
import LockKeyIcon from "@hugeicons/core-free-icons/LockKeyIcon";
import Flag01Icon from "@hugeicons/core-free-icons/Flag01Icon";
import Rocket01Icon from "@hugeicons/core-free-icons/Rocket01Icon";
import StarIcon from "@hugeicons/core-free-icons/StarIcon";
import HourglassIcon from "@hugeicons/core-free-icons/HourglassIcon";
import CheckListIcon from "@hugeicons/core-free-icons/CheckListIcon";
import Archive01Icon from "@hugeicons/core-free-icons/Archive01Icon";

const CUSTOM_ICONS = {
  clock: Clock01Icon,
  pause: PauseIcon,
  play: PlayIcon,
  search: Search01Icon,
  testing: TestTube01Icon,
  bug: Bug01Icon,
  alert: Alert01Icon,
  lock: LockKeyIcon,
  flag: Flag01Icon,
  rocket: Rocket01Icon,
  star: StarIcon,
  hourglass: HourglassIcon,
  checklist: CheckListIcon,
  archive: Archive01Icon,
};

const STATUS_COLOR_CLASS: Record<TaskStatus, string> = {
  backlog: "text-subtle-foreground",
  todo: "text-subtle-foreground",
  in_progress: "text-attention",
  in_review: "text-timeline-accent",
  done: "text-success",
  canceled: "text-subtle-foreground",
};

export function StatusColorDot({ status, color }: { status: TaskStatus; color?: StatusColor }) {
  return <span aria-hidden className={cn("size-3.5 shrink-0 rounded-full bg-current", STATUS_COLOR_CLASS[status] ?? "text-timeline-accent")} style={{ color: paletteColor(color) }} />;
}

export function StatusIcon({
  status,
  className,
  projectId,
  icon,
  color,
}: {
  status: TaskStatus;
  className?: string;
  projectId?: string | null;
  icon?: StatusIconName;
  color?: StatusColor;
}) {
  const workflow = useTaskStatuses(projectId);
  const selected = icon ?? workflow.icon(status) ?? ((TASK_STATUSES as readonly string[]).includes(status) ? status : "todo");
  const selectedColor = paletteColor(color ?? workflow.color(status));
  const colorClass = STATUS_COLOR_CLASS[status] ?? "text-timeline-accent";
  if (Object.hasOwn(CUSTOM_ICONS, selected)) {
    return <HugeiconsIcon icon={CUSTOM_ICONS[selected as keyof typeof CUSTOM_ICONS]} aria-hidden style={{ color: selectedColor }} data-status-icon={status} data-status-glyph={selected} className={cn("size-3.5 shrink-0", colorClass, className)} />;
  }
  const ring = (dashed: boolean) => (
    <circle
      cx="7"
      cy="7"
      r="5.4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      {...(dashed ? { strokeDasharray: "1.8 2" } : {})}
    />
  );
  const disc = <circle cx="7" cy="7" r="6" fill="currentColor" />;
  return (
    <svg
      viewBox="0 0 14 14"
      aria-hidden
      style={{ color: selectedColor }}
      data-status-icon={status}
      data-status-glyph={selected}
      className={cn("size-3.5 shrink-0", colorClass, className)}
    >
      {!["backlog", "todo", "in_progress", "in_review", "done", "canceled"].includes(selected) ? <circle cx="7" cy="7" r="5.4" fill="none" stroke="currentColor" strokeWidth="1.6" /> : null}
      {selected === "backlog" ? ring(true) : null}
      {selected === "todo" ? ring(false) : null}
      {selected === "in_progress" ? (
        <>
          {ring(false)}
          <path d="M7 7 L7 2.4 A4.6 4.6 0 0 1 11.2 9.5 Z" fill="currentColor" />
        </>
      ) : null}
      {selected === "in_review" ? (
        <>
          {ring(false)}
          <path d="M7 7 L7 2.4 A4.6 4.6 0 1 1 6.99 2.4 Z" fill="currentColor" />
        </>
      ) : null}
      {selected === "done" ? (
        <>
          {disc}
          <path
            d="M4.4 7.2 l1.8 1.8 3.4-3.8"
            fill="none"
            stroke="var(--background)"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </>
      ) : null}
      {selected === "canceled" ? (
        <>
          {disc}
          <path
            d="M5 5 l4 4 M9 5 l-4 4"
            stroke="var(--background)"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </>
      ) : null}
    </svg>
  );
}

