// @vitest-environment jsdom
import { expect, test, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { useSignalsBadge } from "./signals-panel";

test("badge displays count and critical tone", async () => {
  function Badge() { const badge = useSignalsBadge(); return <span>{badge && `${badge.count} ${badge.tone}`}</span>; }
  const slot = renderSlot({ component: Badge }, {}, { rpc: { navigationBadge: () => ({ count: 3, critical: 1 }) } });
  try { expect(await slot.findByText("3 critical")).toBeTruthy(); } finally { slot.lifecycle.unmount(); }
});

test("badge takes the numbers from the realtime payload and calls the RPC only on mount or without a payload", async () => {
  function Badge() { const badge = useSignalsBadge(); return <span>{badge ? `${badge.count} ${badge.tone}` : "none"}</span>; }
  const navigationBadge = vi.fn().mockReturnValue({ count: 3, critical: 1 });
  const slot = renderSlot({ component: Badge }, {}, { rpc: { navigationBadge } });
  try {
    expect(await slot.findByText("3 critical")).toBeTruthy();
    await vi.waitFor(() => expect(navigationBadge.mock.calls.length).toBeGreaterThan(0));
    const mounted = navigationBadge.mock.calls.length;
    await slot.behavior.emitRealtime("signals-changed", { count: 5, critical: 0 });
    expect(await slot.findByText("5 neutral")).toBeTruthy();
    await slot.behavior.emitRealtime("signals-changed", { count: 0, critical: 0 });
    expect(await slot.findByText("none")).toBeTruthy();
    expect(navigationBadge).toHaveBeenCalledTimes(mounted);
    await slot.behavior.emitRealtime("signals-changed", {});
    await vi.waitFor(() => expect(navigationBadge).toHaveBeenCalledTimes(mounted + 1));
    expect(await slot.findByText("3 critical")).toBeTruthy();
  } finally { slot.lifecycle.unmount(); }
});
