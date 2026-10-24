import { expect, test } from "vitest";
import { presets, rangeInputSchema, resolveRange } from "./date-range";

const now = new Date("2026-10-20T12:00:00Z");

test.each(presets.filter((days) => days !== 1))("%i-day preset has the requested rolling duration and bounded chart buckets", (days) => {
  const range = resolveRange({ days }, now);
  expect(Date.parse(range.until) - Date.parse(range.since)).toBe(days * 86_400_000);
  expect(range.until).toBe(now.toISOString());
  expect(Math.ceil(days * 86_400_000 / range.bucketMs)).toBe(Math.min(days, Math.ceil(days / Math.ceil(days / 14))));
});

test("custom dates include both UTC days and cap today's endpoint at now", () => {
  expect(resolveRange({ start: "2024-02-29", end: "2024-03-01" }, now)).toMatchObject({
    since: "2024-02-29T00:00:00.000Z", until: "2024-03-01T23:59:59.999Z", label: "2024-02-29 – 2024-03-01",
  });
  expect(resolveRange({ start: "2026-10-20", end: "2026-10-20" }, now).until).toBe(now.toISOString());
  expect(resolveRange(null, now)).toEqual(resolveRange({ days: 7 }, now));
});

test("invalid, reversed, future, and unsupported ranges are rejected", () => {
  for (const input of [{ start: "2025-02-29", end: "2025-03-01" }, { days: 2 }, { days: 7, start: "2026-10-01" }]) {
    expect(rangeInputSchema.safeParse(input).success).toBe(false);
  }
  for (const input of [
    { start: "2026-10-20", end: "2026-10-19" }, { start: "2026-10-20", end: "2026-10-21" },
    { start: "1969-12-31", end: "2026-10-01" },
  ]) expect(() => resolveRange(input, now)).toThrow();
});


test.each(["2026-10-20T10:17:38Z", "2026-10-20T00:00:00Z", "2026-10-21T00:00:00Z"])("one day starts at UTC midnight (%s)", (timestamp) => {
  const current = new Date(timestamp);
  expect(resolveRange({ days: 1 }, current)).toEqual({
    since: `${timestamp.slice(0, 10)}T00:00:00.000Z`, until: current.toISOString(), label: "today", bucketMs: 14_400_000,
  });
});
