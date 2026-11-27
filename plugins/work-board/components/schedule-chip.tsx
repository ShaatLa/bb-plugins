import type { CardScheduledStart } from "../shared/contract";
import { formatStartTime } from "../schedule/when";

/** "Scheduled 02:00", "Scheduled 29 Nov 02:00" when it is not today; a problem reads "Start refused" or "Start unknown". A launched start shows no chip. */
export function scheduleChipText(start: CardScheduledStart, now = new Date()): string | null {
  if (start.state === "refused") return "Start refused";
  if (start.state === "unknown") return "Start unknown";
  if (start.state !== "scheduled" && start.state !== "launching") return null;
  const at = new Date(start.at);
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return at.toDateString() === now.toDateString() ? `Scheduled ${time}` : `Scheduled ${at.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}

export const scheduleChipTitle = (start: CardScheduledStart) =>
  `${start.state === "scheduled" || start.state === "launching" ? `Scheduled for ${formatStartTime(start.at)}` : `Start ${start.state} (scheduled ${formatStartTime(start.at)})`} · ${start.mode === "spawn_gate" ? "through Spawn Gate" : "from a preset"} · set by ${start.setter}${start.error ? ` · ${start.error}` : ""}`;

/** The card's scheduled start on the board and the list; the warning color marks a launch problem. */
export function ScheduleChip({ start }: { start?: CardScheduledStart }) {
  const text = start ? scheduleChipText(start) : null;
  if (!start || !text) return null;
  const problem = start.state === "refused" || start.state === "unknown";
  return <span data-schedule-state={start.state} className={`inline-flex max-w-full items-center rounded-full border px-1.5 py-0.5 text-2xs ${problem ? "border-warning/60 text-warning" : "border-border text-muted-foreground"}`} title={scheduleChipTitle(start)}><span className="truncate">{text}</span></span>;
}
