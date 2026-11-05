// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useActivityPoll } from "./activity-poll";

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
