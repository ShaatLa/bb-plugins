import { describe, expect, it } from "vitest";
import { isWithinGrace, localSlotKey, nextOccurrence, recurrenceSchema } from "./recurrence";

describe("scheduled recurrence", () => {
  it("honors weekly local time and spring DST transition", () => {
    expect(nextOccurrence({ kind: "weekly", time: "02:30", weekdays: [0], timezone: "America/New_York" }, new Date("2026-03-08T00:00:00Z"))?.toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });
  it("identifies both sides of a fall fold as one local slot", () => {
    expect(localSlotKey(new Date("2026-11-01T05:30:00Z"), "America/New_York")).toBe(localSlotKey(new Date("2026-11-01T06:30:00Z"), "America/New_York"));
  });
  it("bounds grace and rejects invalid recurrence input", () => {
    const due = new Date("2026-01-01T00:00:00Z");
    expect(isWithinGrace(due, new Date("2026-01-01T00:30:00Z"))).toBe(true);
    expect(isWithinGrace(due, new Date("2026-01-01T00:30:00.001Z"))).toBe(false);
    expect(recurrenceSchema.safeParse({ kind: "weekly", time: "12:00", weekdays: [], timezone: "UTC" }).success).toBe(false);
  });
});
