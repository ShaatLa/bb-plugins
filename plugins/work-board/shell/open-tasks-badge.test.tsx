// @vitest-environment jsdom
import { act, cleanup } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, expect, it, vi } from "vitest";
import { useOpenTasksBadge } from "./open-tasks-badge.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const TASK_ID = "01HZZZZZZZZZZZZZZZZZZZZZT1";
const badgeCount = (count: number, timeBased = false) => ({ count, counts: { open: count }, criteria: ["open"], timeBased });

function renderBadge(timeBased = false) {
  function Probe() {
    useOpenTasksBadge();
    return null;
  }
  const navigationBadge = vi.fn(() => badgeCount(3, timeBased));
  const slot = renderSlot({ component: Probe } as never, {}, { rpc: { navigationBadge } as never });
  const refreshes = () => navigationBadge.mock.calls.length;
  return { slot, refreshes };
}

const emitTaskChange = (slot: ReturnType<typeof renderBadge>["slot"]) =>
  slot.behavior.emitRealtime("tasks:changed", { taskId: TASK_ID, projectId: PROJECT_ID });

it("collapses an event burst into one trailing navigation badge refresh", async () => {
  vi.useFakeTimers();
  const { slot, refreshes } = renderBadge();
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(refreshes()).toBe(1);

  await emitTaskChange(slot);
  await emitTaskChange(slot);
  await emitTaskChange(slot);
  await act(() => vi.advanceTimersByTimeAsync(199));
  expect(refreshes()).toBe(1);
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(refreshes()).toBe(2);
});

it("still refreshes during a steady event stream, at most about once per second", async () => {
  vi.useFakeTimers();
  const { slot, refreshes } = renderBadge();
  await act(() => vi.advanceTimersByTimeAsync(0));
  for (let step = 0; step < 10; step += 1) {
    await emitTaskChange(slot);
    await act(() => vi.advanceTimersByTimeAsync(100));
  }
  expect(refreshes()).toBeGreaterThanOrEqual(2);
});

it("defers refreshes while hidden and refreshes once on becoming visible", async () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const { slot, refreshes } = renderBadge();
  await act(() => vi.advanceTimersByTimeAsync(0));

  visibility.mockReturnValue("hidden");
  await emitTaskChange(slot);
  await emitTaskChange(slot);
  await act(() => vi.advanceTimersByTimeAsync(1_000));
  expect(refreshes()).toBe(1);

  visibility.mockReturnValue("visible");
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(refreshes()).toBe(2);
});

it("skips the time-based interval while hidden", async () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const { refreshes } = renderBadge(true);
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(refreshes()).toBe(1);

  visibility.mockReturnValue("hidden");
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(refreshes()).toBe(1);

  visibility.mockReturnValue("visible");
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(refreshes()).toBe(2);
});
