import type { Recurrence, Schedule, ScheduleRun } from "../../shared/scheduled";

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
// Mon-first order for the picker; values stay Sunday=0 like the contract.
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

export const RUN_STATE_LABELS: Record<ScheduleRun["state"], string> = {
  starting: "Starting",
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  canceled: "Canceled",
  skipped: "Skipped",
  failed: "Failed",
  delivery_unknown: "Delivery unknown",
  cancel_pending: "Cancel pending",
};

export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function supportedTimeZones(): string[] {
  const zones = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  return zones.includes("UTC") ? zones : ["UTC", ...zones];
}

/** Formats an instant in an explicit zone; the zone is always part of the text. */
export function formatInZone(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const text = new Intl.DateTimeFormat("en", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
  return `${text} (${timeZone})`;
}

export function describeRule(rule: Recurrence): string {
  switch (rule.kind) {
    case "daily":
      return `Daily at ${rule.time} · ${rule.timezone}`;
    case "weekly": {
      const days = WEEKDAY_ORDER.filter((day) => rule.weekdays.includes(day)).map((day) => WEEKDAY_LABELS[day]);
      return `Weekly on ${days.join(", ")} at ${rule.time} · ${rule.timezone}`;
    }
    case "once":
      return `Once on ${formatInZone(rule.at, rule.timezone)}`;
  }
}

function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second"));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** Converts a wall-clock `YYYY-MM-DDTHH:mm` in `timeZone` to a UTC ISO instant; null when malformed. */
export function zonedLocalToIso(local: string, timeZone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  // Date.UTC rolls 13th months / 25th hours over silently; a round trip catches that.
  if (new Date(wall).toISOString().slice(0, 16) !== local) return null;
  // Two passes settle the offset when the guess lands on the other side of a DST change.
  let instant = wall - zoneOffsetMs(wall, timeZone);
  instant = wall - zoneOffsetMs(instant, timeZone);
  const result = new Date(instant);
  return Number.isNaN(result.getTime()) ? null : result.toISOString();
}

/** Inverse of zonedLocalToIso, for pre-filling the one-time picker. */
export function isoToZonedLocal(iso: string, timeZone: string): string {
  const instant = new Date(iso).getTime();
  if (Number.isNaN(instant)) return "";
  return new Date(instant + zoneOffsetMs(instant, timeZone)).toISOString().slice(0, 16);
}

const ATTENTION_STATES: ReadonlySet<ScheduleRun["state"]> = new Set(["skipped", "failed", "delivery_unknown", "cancel_pending"]);

export interface RunActions {
  retry: boolean;
  resolve: boolean;
  cancel: boolean;
}

/** Which management actions a run offers. The server stays the authority; this only hides impossible buttons. */
export function runActions(run: ScheduleRun): RunActions {
  const live = !run.historical;
  return {
    retry: live && run.startedAt === null && (run.state === "failed" || run.state === "skipped" || run.state === "canceled"),
    resolve: run.resolvedAt === null && run.state !== "cancel_pending" && (ATTENTION_STATES.has(run.state) || run.state === "canceled"),
    cancel: live && (run.state === "queued" || run.state === "cancel_pending"),
  };
}

export function scheduleStatus(schedule: Schedule): "active" | "paused" | "finished" {
  if (!schedule.enabled) return "paused";
  return schedule.nextDueAt === null ? "finished" : "active";
}

export function describeTarget(schedule: Schedule, presetName: (id: string) => string | undefined): string {
  if (schedule.target.kind === "unassigned") return "Choose target";
  return schedule.target.kind === "thread"
    ? `Existing thread ${schedule.target.threadId}`
    : `New session · ${presetName(schedule.target.presetId) ?? "preset not found"}`;
}

export function describePush(run: ScheduleRun): string | null {
  if (run.pushState === "sent") return `Push sent${run.pushChannels.length > 0 ? ` (${run.pushChannels.join(", ")})` : ""}`;
  if (run.pushState === "failed") return `Push failed${run.pushError ? `: ${run.pushError}` : ""}`;
  return ATTENTION_STATES.has(run.state) ? "Push not sent" : null;
}

/** Scalar values of the applied-execution record, for a compact "what actually ran" line. */
export function executionSummary(run: ScheduleRun): string[] {
  return Object.entries(run.execution ?? {})
    .filter((entry): entry is [string, string | number | boolean] => ["string", "number", "boolean"].includes(typeof entry[1]))
    .slice(0, 5)
    .map(([key, value]) => `${key}: ${String(value)}`);
}

export function newIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
