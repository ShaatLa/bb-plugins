// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useActivityPoll, useAdvisoryRecheck } from "./activity-poll";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
it("polls visible sessions only when no request is in flight and cleans up", () => {
  vi.useFakeTimers();
  const refresh = vi.fn();
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const { rerender, unmount } = renderHook(({ fetching, sessions }) => useActivityPoll(refresh, fetching, sessions), { initialProps: { fetching: false, sessions: true } });
  act(() => vi.advanceTimersByTime(5000));
  expect(refresh).toHaveBeenCalledTimes(1);
  rerender({ fetching: true, sessions: true });
  act(() => vi.advanceTimersByTime(5000));
  visibility.mockReturnValue("hidden");
  rerender({ fetching: false, sessions: true });
  act(() => vi.advanceTimersByTime(5000));
  rerender({ fetching: false, sessions: false });
  visibility.mockReturnValue("visible");
  act(() => vi.advanceTimersByTime(5000));
  unmount();
  expect(refresh).toHaveBeenCalledTimes(1);
});
it("rechecks only cards with expired advice, once per expiry, and waits for a hidden view to be shown", () => {
  vi.useFakeTimers();
  const recheck = vi.fn();
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const at = (ms: number) => new Date(Date.now() + ms).toISOString();
  const rows = [{ taskId: "a", advisories: [{ validUntil: at(60_000) }] }, { taskId: "b", advisories: [{ validUntil: at(600_000) }] }, { taskId: "c" }];
  const { rerender, unmount } = renderHook(({ rows }) => useAdvisoryRecheck(rows, recheck), { initialProps: { rows } });
  act(() => vi.advanceTimersByTime(59_999));
  expect(recheck).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(2));
  expect(recheck).toHaveBeenCalledWith(["a"]);
  // A clock-skewed answer that is already expired waits for the floor instead of looping.
  rerender({ rows: [{ taskId: "a", advisories: [{ validUntil: at(-1) }] }, rows[1]!] });
  act(() => vi.advanceTimersByTime(14_000));
  expect(recheck).toHaveBeenCalledTimes(1);
  visibility.mockReturnValue("hidden");
  act(() => vi.advanceTimersByTime(1_001));
  expect(recheck).toHaveBeenCalledTimes(1);
  visibility.mockReturnValue("visible");
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(recheck).toHaveBeenLastCalledWith(["a"]);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});
