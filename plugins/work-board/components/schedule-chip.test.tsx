// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ScheduleChip, scheduleChipText } from "./schedule-chip";

afterEach(cleanup);
const base = { mode: "spawn_gate" as const, setter: "thr_example" };

it("reads Scheduled with the time today, and the date when it is not today", () => {
  const now = new Date(2026, 10, 28, 12, 0);
  expect(scheduleChipText({ ...base, state: "scheduled", at: new Date(2026, 10, 28, 23, 30).toISOString() }, now)).toBe(`Scheduled ${new Date(2026, 10, 28, 23, 30).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}`);
  expect(scheduleChipText({ ...base, state: "scheduled", at: new Date(2026, 10, 29, 2, 0).toISOString() }, now)).toMatch(/^Scheduled .+ \d{2}:\d{2}$/);
  expect(scheduleChipText({ ...base, state: "scheduled", at: new Date(2026, 10, 29, 2, 0).toISOString() }, now)).not.toBe(scheduleChipText({ ...base, state: "scheduled", at: new Date(2026, 10, 28, 2, 0).toISOString() }, now));
});

it("shows a launch problem in the warning color and nothing for a launched start", () => {
  render(<><ScheduleChip start={{ ...base, state: "refused", at: "2026-11-29T02:00:00.000Z", error: "over pace" }} /><ScheduleChip start={{ ...base, state: "unknown", at: "2026-11-29T02:00:00.000Z" }} /><ScheduleChip start={{ ...base, state: "launched", at: "2026-11-29T02:00:00.000Z", threadId: "thr_launched" }} /></>);
  expect(screen.getByText("Start refused").parentElement?.className).toContain("text-warning");
  expect(screen.getByText("Start refused").parentElement?.getAttribute("title")).toContain("over pace");
  expect(screen.getByText("Start unknown")).toBeTruthy();
  expect(document.querySelectorAll("[data-schedule-state]")).toHaveLength(2);
});
