import { describe, expect, it } from "vitest";
import type { ScheduleRun } from "../../shared/scheduled";
import { describeRule, describePush, formatInZone, isoToZonedLocal, runActions, zonedLocalToIso } from "./lib";

function run(overrides: Partial<ScheduleRun>): ScheduleRun {
  return {
    id: "00000000-0000-4000-8000-000000000001", scheduleId: "00000000-0000-4000-8000-000000000002", projectId: "P1", scheduleTitle: "Nightly", occurrenceKey: "k",
    scheduledFor: "2026-11-09T08:00:00.000Z", state: "failed", taskId: null, threadId: null, queueId: null, requestId: null, reason: null, startedAt: null, finishedAt: null,
    resolvedAt: null, createdAt: "2026-11-09T08:00:00.000Z", updatedAt: "2026-11-09T08:00:00.000Z", pushState: "not_attempted", pushChannels: [], pushError: null,
    execution: null, overlapRunIds: [], missCount: 1, historical: false, ...overrides,
  };
}

describe("time zone conversion for the one-time picker", () => {
  it.each([
    ["2026-01-15T09:00", "America/New_York", "2026-01-15T14:00:00.000Z"],
    ["2026-06-01T12:00", "Asia/Kolkata", "2026-06-01T06:30:00.000Z"],
    // Berlin spring forward: 03:30 already is CEST (+02:00).
    ["2026-03-29T03:30", "Europe/Berlin", "2026-03-29T01:30:00.000Z"],
    ["2026-07-01T00:00", "UTC", "2026-07-01T00:00:00.000Z"],
  ])("%s in %s", (local, zone, iso) => {
    expect(zonedLocalToIso(local, zone)).toBe(iso);
    expect(isoToZonedLocal(iso, zone)).toBe(local);
  });
  it("rejects malformed input instead of guessing", () => {
    expect(zonedLocalToIso("", "UTC")).toBeNull();
    expect(zonedLocalToIso("2026-13-40T99:99", "UTC")).toBeNull();
  });
  it("always names the zone in displayed times", () => {
    expect(formatInZone("2026-01-15T14:00:00.000Z", "America/New_York")).toContain("(America/New_York)");
    expect(describeRule({ kind: "weekly", time: "09:00", timezone: "Europe/Berlin", weekdays: [0, 1, 3] })).toBe("Weekly on Mon, Wed, Sun at 09:00 · Europe/Berlin");
  });
});

describe("run actions", () => {
  it("offers retry/dismiss for unresolved failures and hides them for imported history", () => {
    expect(runActions(run({ state: "failed" }))).toEqual({ retry: true, resolve: true, cancel: false });
    expect(runActions(run({ state: "failed", historical: true }))).toEqual({ retry: false, resolve: true, cancel: false });
    expect(runActions(run({ state: "failed", resolvedAt: "2026-11-10T00:00:00.000Z" })).resolve).toBe(false);
  });
  it("offers cancel for queued work only and never dismisses active runs", () => {
    expect(runActions(run({ state: "queued" }))).toEqual({ retry: false, resolve: false, cancel: true });
    expect(runActions(run({ state: "running" }))).toEqual({ retry: false, resolve: false, cancel: false });
    expect(runActions(run({ state: "cancel_pending" })).cancel).toBe(true);
  });
  it("reports push delivery truthfully", () => {
    expect(describePush(run({ state: "failed" }))).toBe("Push not sent");
    expect(describePush(run({ state: "failed", pushState: "failed", pushError: "no devices" }))).toBe("Push failed: no devices");
    expect(describePush(run({ state: "skipped", pushState: "sent", pushChannels: ["web", "mobile"] }))).toBe("Push sent (web, mobile)");
    expect(describePush(run({ state: "completed" }))).toBeNull();
  });
});
