// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ThreadHealth } from "../shared/contract.js";
import { ThreadHealthMarkers } from "./thread-health-markers";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const idleHealth: ThreadHealth = {
  failed: [],
  idle: { threadId: "thr_i", since: "2026-10-28T08:00:00.000Z", thresholdMinutes: 45 },
};

it("drives every idle clock from one shared interval and clears it on unmount", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-28T08:52:00.000Z"));
  const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
  const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
  const minuteTicks = () => setIntervalSpy.mock.calls.filter(([, ms]) => ms === 60_000);

  const { getAllByRole, unmount } = render(
    <>
      {Array.from({ length: 20 }, (_, index) => (
        <ThreadHealthMarkers key={index} health={idleHealth} />
      ))}
    </>,
  );
  expect(getAllByRole("img", { name: "Thread idle 52 min, task not updated" })).toHaveLength(20);
  expect(minuteTicks()).toHaveLength(1);

  act(() => vi.advanceTimersByTime(60_000));
  expect(getAllByRole("img", { name: "Thread idle 53 min, task not updated" })).toHaveLength(20);

  unmount();
  expect(clearIntervalSpy).toHaveBeenCalledWith(setIntervalSpy.mock.results[0]!.value);
});

it("starts no interval for markers without an idle thread", () => {
  vi.useFakeTimers();
  const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
  render(<ThreadHealthMarkers health={{ failed: [], idle: null }} />);
  expect(setIntervalSpy.mock.calls.filter(([, ms]) => ms === 60_000)).toHaveLength(0);
});
