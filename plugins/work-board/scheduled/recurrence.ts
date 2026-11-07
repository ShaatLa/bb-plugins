import { CronExpressionParser } from "cron-parser";
import { z } from "zod";

const timezoneSchema = z.string().refine((timezone) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}, "Invalid time zone");

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const recurrenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("daily"), time: timeSchema, timezone: timezoneSchema }).strict(),
  z.object({ kind: z.literal("weekly"), time: timeSchema, timezone: timezoneSchema, weekdays: z.array(z.number().int().min(0).max(6)).min(1).refine((days) => new Set(days).size === days.length) }).strict(),
  z.object({ kind: z.literal("once"), at: z.iso.datetime({ offset: true }), timezone: timezoneSchema }).strict(),
]);
export type Recurrence = z.infer<typeof recurrenceSchema>;

/** Returns the first occurrence strictly after the given instant. */
export function nextOccurrence(rule: Recurrence, after: Date): Date | null {
  const parsed = recurrenceSchema.parse(rule);
  if (!Number.isFinite(after.valueOf())) throw new Error("Invalid starting instant");
  if (parsed.kind === "once") {
    const at = new Date(parsed.at);
    return at > after ? at : null;
  }
  const [hour, minute] = parsed.time.split(":").map(Number);
  const days = parsed.kind === "weekly" ? parsed.weekdays.join(",") : "*";
  return CronExpressionParser.parse(`${minute} ${hour} * * ${days}`, {
    currentDate: after,
    tz: parsed.timezone,
  }).next().toDate();
}

/** Stable across both instants in a repeated local clock slot. */
export function localSlotKey(at: Date, timezone: string): string {
  timezoneSchema.parse(timezone);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

export function isWithinGrace(due: Date, now: Date): boolean {
  const age = now.valueOf() - due.valueOf();
  return age >= 0 && age <= 30 * 60_000;
}
