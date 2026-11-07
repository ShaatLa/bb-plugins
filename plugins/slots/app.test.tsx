// @vitest-environment jsdom
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { DEFAULT_SETTINGS, type StatusView } from "./contract";

const app = await loadPluginApp(() => import("./app"));
const at = Date.parse("2026-11-07T12:00:00Z");
const fixture: StatusView = {
  at, localHostId: "laptop", hostSettings: { laptop: DEFAULT_SETTINGS },
  titles: { owner: "Manager", holder: "QA checks", urgent: "Browser tests", normal: "Build agent" },
  gates: { laptop: { latest: { at: at - 5000, memFreePct: 42.5, load1: 8.2, passed: true }, streak: 1, lastCountedAt: at - 5000 } },
  pools: [
    { hostId: "laptop", pool: "heavy", capacity: 4,
      leases: [{ id: "lease-1", requestId: "request-1", hostId: "laptop", pool: "heavy", slotIndex: 0,
        ownerThreadId: "owner", holderThreadId: "holder", job: "Run geometry suite", estMs: 120_000,
        grantedAt: at - 60_000, expiresAt: at + 60_000, lastHeartbeatAt: at, warnedAt: null }],
      queue: [
        { id: "request-2", hostId: "laptop", pool: "heavy", threadId: "urgent", job: "Browser geometry", estMs: 180_000, priority: "urgent", createdAt: at - 30_000 },
        { id: "request-3", hostId: "laptop", pool: "heavy", threadId: "normal", job: "Build package", estMs: 60_000, priority: "normal", createdAt: at - 90_000 },
      ] },
    { hostId: "laptop", pool: "local-model", capacity: 1, leases: [], queue: [] },
  ],
  ports: [{ hostId: "laptop", threadId: "holder", port: 41001, createdAt: at }],
  audit: [
    { seq: 1, at: at - 30_000, type: "request", threadId: "urgent", pool: "heavy", hostId: "laptop" },
    { seq: 2, at: at - 10_000, type: "transfer", threadId: "holder", leaseId: "lease-1", reason: "QA handoff" },
    { seq: 3, at, type: "gate", readings: { at, memFreePct: 42.5, load1: 8.2 } },
  ],
};
const render = (status: () => unknown = () => ({ ok: true, data: fixture })) =>
  renderSlot(app.navPanels[0], { subPath: "" }, { rpc: { status } });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

test("registers a Slots navigation page and renders gate, leases, queue and audit from status RPC", async () => {
  expect(app.navPanels[0]).toMatchObject({ id: "slots", title: "Slots", path: "slots", icon: "Layers" });
  const slot = render();
  const gate = await slot.findByRole("region", { name: "Machine gate · laptop" });
  for (const text of ["42.5%", "Minimum 20%", "8.2", "Below 18", "Streak 1/2", "Sample passed", "Gate waiting"]) expect(within(gate).getByText(text)).toBeTruthy();
  expect(within(gate).getByText("5s ago").getAttribute("datetime")).toBe(new Date(at - 5000).toISOString());
  const pool = slot.getByRole("region", { name: "heavy · laptop" });
  expect(pool.textContent).toContain("Capacity 4 · 1 used · 3 free");
  for (const text of ["Slot 0", "Run geometry suite", "Port 41001"]) expect(within(pool).getByText(text)).toBeTruthy();
  expect(pool.textContent).toContain("Granted 1m 0s ago · Estimate 2m 0s · Expires in 1m 0s");
  expect(pool.textContent).toContain("Transferred to QA checks from Manager");
  fireEvent.click(within(pool).getByRole("button", { name: "Manager" }));
  expect(slot.inspection.navigateCalls).toContainEqual(expect.objectContaining({ method: "toThread", threadId: "owner" }));
  const queue = slot.getByRole("list", { name: "heavy queue on laptop" });
  expect(within(queue).getAllByRole("listitem").map(item => item.textContent)).toEqual([
    expect.stringContaining("urgentBrowser testsBrowser geometryEstimate 3m 0s · Waiting 30s"),
    expect.stringContaining("normalBuild agentBuild packageEstimate 1m 0s · Waiting 1m 30s"),
  ]);
  const events = slot.getByRole("region", { name: "Recent events" });
  expect(within(events).getAllByRole("listitem")[0].textContent).toContain("transfer");
  expect(events.textContent).toContain("QA handoff");
  expect(within(events).queryByText("gate")).toBeNull();
  expect(slot.inspection.rpcCalls[0]).toMatchObject({ method: "status", input: {} });
  expect(slot.inspection.sdkCalls).toHaveLength(0);
});

test("uses a short fallback title and navigates without fetching thread details", async () => {
  const slot = render(() => ({ ok: true, data: { ...fixture, titles: {} } }));
  const pool = await slot.findByRole("region", { name: "heavy · laptop" });
  fireEvent.click(within(pool).getAllByRole("button", { name: "thread" })[0]);
  expect(slot.inspection.navigateCalls).toContainEqual(expect.objectContaining({ method: "toThread", threadId: "holder" }));
  expect(slot.inspection.sdkCalls).toHaveLength(0);
});

test("shows accessible loading state", () => {
  const slot = render(() => new Promise(() => {}));
  expect(slot.getByRole("status", { name: "Loading Slots status…" }).getAttribute("aria-busy")).toBe("true");
});

test.each(["result", "transport"])("shows %s errors", async kind => {
  const slot = render(() => {
    if (kind === "transport") throw new Error("Connection unavailable");
    return { ok: false, error: { code: "not-found", message: "Connection unavailable" } };
  });
  expect((await slot.findByRole("alert")).textContent).toContain("Connection unavailable");
  expect(slot.queryByRole("status")).toBeNull();
});

test("renders empty pools, queue, events and missing gate sample", async () => {
  const slot = render(() => ({ ok: true, data: { ...fixture, gates: {}, pools: fixture.pools.map(pool => ({ ...pool, leases: [], queue: [] })), ports: [], audit: [] } }));
  await slot.findByText("No sample");
  expect(slot.getAllByText("No active leases.")).toHaveLength(2);
  expect(slot.getByText("No requests waiting.")).toBeTruthy();
  expect(slot.getByText("No recent events.")).toBeTruthy();
  expect(slot.getByText("Waiting for the first machine reading.")).toBeTruthy();
});

test("caps audit at the latest 15 events and displays failing metrics", async () => {
  const slot = render(() => ({ ok: true, data: { ...fixture,
    gates: { laptop: { latest: { at, memFreePct: 10, load1: 20, passed: false }, streak: 0, lastCountedAt: null } },
    audit: Array.from({ length: 20 }, (_, seq) => ({ seq, at: at - (20 - seq) * 1000, type: "release", reason: `Event ${seq}` })),
  } }));
  await slot.findByText("Sample failed");
  const events = slot.getByRole("region", { name: "Recent events" });
  const rows = within(events).getAllByRole("listitem");
  expect(rows).toHaveLength(15);
  expect(rows[0].textContent).toContain("Event 19");
  expect(rows[14].textContent).toContain("Event 5");
});

test("polls only while visible, preserves stale data on failure, advances server-relative time and cleans up", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(at + 3_600_000);
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const status = vi.fn().mockReturnValue({ ok: true, data: fixture });
  const slot = render(status);
  await act(async () => {});
  expect(slot.getByText(/Granted 1m 0s ago/)).toBeTruthy();
  await act(async () => { vi.advanceTimersByTime(1000); });
  expect(slot.getByText(/Granted 1m 1s ago/)).toBeTruthy();
  visibility.mockReturnValue("hidden");
  await act(async () => { vi.advanceTimersByTime(30_000); });
  expect(status).toHaveBeenCalledTimes(1);
  visibility.mockReturnValue("visible");
  status.mockRejectedValueOnce(new Error("Offline"));
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(slot.getByRole("alert").textContent).toContain("Showing the last successful status.");
  expect(slot.getByText("Run geometry suite")).toBeTruthy();
  status.mockImplementation(() => new Promise(() => {}));
  await act(async () => { vi.advanceTimersByTime(10_000); });
  await act(async () => { vi.advanceTimersByTime(30_000); });
  expect(status).toHaveBeenCalledTimes(3);
  expect(slot.getByText(/Expired 11s ago/)).toBeTruthy();
  slot.lifecycle.unmount();
  await act(async () => { vi.advanceTimersByTime(30_000); document.dispatchEvent(new Event("visibilitychange")); });
  expect(status).toHaveBeenCalledTimes(3);
});
