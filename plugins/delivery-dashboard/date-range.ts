import { z } from "zod";

export const presets = [1, 3, 7, 14, 30, 90] as const;
export const rangeInputSchema = z.union([
  z.null(),
  z.object({ days: z.union(presets.map((days) => z.literal(days))) }).strict(),
  z.object({ start: z.iso.date(), end: z.iso.date() }).strict(),
]);
export type RangeInput = z.infer<typeof rangeInputSchema>;
export const rangeSchema = z.object({
  since: z.iso.datetime(), until: z.iso.datetime(), label: z.string(),
  bucketMs: z.number().positive(),
});
export type DateRange = z.infer<typeof rangeSchema>;
const day = 86_400_000;

export function resolveRange(input: RangeInput, now = new Date()): DateRange {
  const selection = rangeInputSchema.parse(input) ?? { days: 7 };
  let until = now.getTime();
  let since: number;
  let label: string;
  if ("days" in selection) {
    since = selection.days === 1 ? Math.floor(until / day) * day : until - selection.days * day;
    label = selection.days === 1 ? "today" : `last ${selection.days} days`;
  } else {
    const today = now.toISOString().slice(0, 10);
    if (selection.start < "1970-01-01" || selection.start > selection.end || selection.end > today) {
      throw new Error("Choose dates from 1970 through today, with the start on or before the end.");
    }
    since = Date.parse(`${selection.start}T00:00:00.000Z`);
    until = Math.min(until, Date.parse(`${selection.end}T23:59:59.999Z`));
    label = `${selection.start} – ${selection.end}`;
  }
  const duration = Math.max(1, until - since);
  // Keep long ranges readable; the final bucket may be shorter than the others.
  const bucketMs = label === "today" ? 4 * 3_600_000 : "days" in selection && selection.days === 3 ? day / 2
    : duration <= day ? 3_600_000 : Math.ceil(duration / (14 * day)) * day;
  return { since: new Date(since).toISOString(), until: new Date(until).toISOString(), label, bucketMs };
}
