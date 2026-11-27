import { Temporal } from "@js-temporal/polyfill";
import type { Config } from "./contract";

export const minute = 60_000;
const local = (at: number, zone: string) => Temporal.Instant.fromEpochMilliseconds(at).toZonedDateTimeISO(zone);
export const dateIn = (at: number, zone: string) => local(at, zone).toPlainDate().toString();
export function timeOn(date: string, time: string, zone: string) {
  const dt = Temporal.PlainDate.from(date).toPlainDateTime(time);
  const at = dt.toZonedDateTime(zone);
  if (at.toPlainDateTime().equals(dt)) return at.epochMilliseconds;
  // During a spring-forward gap, use the first real local instant after the gap.
  return dt.toZonedDateTime(zone, { disambiguation: "earlier" })
    .getTimeZoneTransition("next")?.epochMilliseconds ?? at.epochMilliseconds;
}
export function cutoff(now: number, zone: string, range: "week" | "month" | "quarter") {
  const duration = range === "week" ? { days: 7 } : { months: range === "month" ? 1 : 3 };
  return local(now, zone).subtract(duration).epochMilliseconds;
}
export function occurrence(now: number, cfg: Config) {
  const current = local(now, cfg.timeZone).toPlainDate();
  const scheduled = timeOn(current.toString(), cfg.scheduleTime, cfg.timeZone);
  return scheduled <= now ? current.toString() : current.subtract({ days: 1 }).toString();
}
