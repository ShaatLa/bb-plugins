// @vitest-environment jsdom
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { DEFAULT_SETTINGS, SLOTS_CHANGED, type StatusView } from "./contract";

const app = await loadPluginApp(() => import("./app"));
const at = Date.parse("2026-11-07T12:00:00Z");
const fixture: StatusView = {
  at, localHostId: "laptop", hostSettings: { laptop: DEFAULT_SETTINGS },
  titles: { owner: "Manager", holder: "QA checks", urgent: "Browser tests", normal: "Build agent" },
  gates: { laptop: { latest: { at: at - 5000, memFreePct: 42.5, load1: 8.2, passed: true }, streak: 1, lastCountedAt: at - 5000 } },
  pools: [
    { hostId: "laptop", pool: "heavy", capacity: 4,
      leases: [{ id: "lease-1", requestId: "request-1", hostId: "laptop", pool: "heavy", slotIndex: 0,
        ownerThreadId: "owner", holderThreadId: "holder", job: "Run end-to-end suite", estMs: 120_000,
        grantedAt: at - 60_000, expiresAt: at + 60_000, lastHeartbeatAt: at, warnedAt: null }],
      queue: [
        { id: "request-2", hostId: "laptop", pool: "heavy", threadId: "urgent", job: "Browser tests", estMs: 180_000, priority: "urgent", createdAt: at - 30_000 },
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

test("renders summary, capacity cells, lease progress, queue and SDK thread navigation without host IDs", async () => {
  const slot = render();
  const machine = await slot.findByRole("region", { name: "Machine" });
  expect(machine.textContent).toContain("Checking… (1 of 2 checks)");
  expect(slot.getByRole("region", { name: "Memory free" }).textContent).toContain("43%needs at least 20%");
  expect(slot.getByRole("region", { name: "Load (1 min)" }).textContent).toContain("8.2limit 18");
  expect(slot.getByRole("region", { name: "Heavy slots" }).textContent).toContain("1 of 4 in use2 waiting");
  expect(slot.getByText("Free")).toBeTruthy();
  const pool = slot.getByRole("region", { name: "Heavy jobs" });
  const cells = within(pool).getByRole("img");
  expect(cells.children).toHaveLength(4);
  expect(cells.querySelectorAll('[data-held="true"]')).toHaveLength(1);
  expect(within(pool).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("60000");
  expect(pool.textContent).toContain("1m of 2m · expires in 1m");
  expect(pool.textContent).toContain("Transferred to QA checks from Manager");
  expect(within(pool).getByText("Port 41001")).toBeTruthy();
  fireEvent.click(within(pool).getByRole("button", { name: "Manager" }));
  expect(slot.inspection.navigateCalls).toContainEqual(expect.objectContaining({ method: "toThread", threadId: "owner" }));
  const queue = within(pool).getByRole("list", { name: "Heavy jobs queue" });
  expect(within(queue).getAllByRole("listitem").map(item => item.textContent)).toEqual([
    expect.stringContaining("#1Browser testsurgentBrowser testsEstimate 3m · waiting 30s"),
    expect.stringContaining("#2Build agentBuild packageEstimate 1m · waiting 1m"),
  ]);
  expect(slot.getByText("Next — waiting for the machine check")).toBeTruthy();
  expect(slot.container.innerHTML).not.toContain("laptop");
  expect(slot.inspection.sdkCalls).toHaveLength(0);
});

test.each([
  [42, 8, 2, "Ready for heavy work"],
  [42, 8, 1, "Checking… (1 of 2 checks)"],
  [42, 21.3, 0, "Busy — load 21.3 is above 18"],
  [42, 18, 0, "Busy — load 18.0 is at 18"],
  [14, 8, 0, "Low memory — 14% free, needs 20%"],
])("machine state for memory %s, load %s and %s checks", async (memFreePct, load1, streak, text) => {
  const slot = render(() => ({ ok: true, data: { ...fixture, gates: { laptop: { latest: { at, memFreePct, load1, passed: memFreePct >= 20 && load1 < 18 }, streak, lastCountedAt: at } } } }));
  expect(await slot.findByText(text)).toBeTruthy();
});

test.each([
  [20, 1, "Within limit", "Near limit"],
  [22, 16, "Near limit", "Near limit"],
  [19, 18, "Outside limit", "Outside limit"],
])("meters describe threshold status with text", async (memFreePct, load1, loadState, memoryState) => {
  const slot = render(() => ({ ok: true, data: { ...fixture, gates: { laptop: { latest: { at, memFreePct, load1, passed: true }, streak: 1, lastCountedAt: at } } } }));
  expect((await slot.findByRole("meter", { name: "Memory free" })).getAttribute("aria-valuetext")).toContain(memoryState.toLowerCase());
  expect(slot.getByRole("meter", { name: "Load (1 min)" }).getAttribute("aria-valuetext")).toContain(loadState.toLowerCase());
});

test.each(["auto", "manual"] as const)("explains %s queue waits", async grantMode => {
  const slot = render(() => ({ ok: true, data: { ...fixture, hostSettings: { laptop: { ...DEFAULT_SETTINGS, grantMode } }, gates: { laptop: { ...fixture.gates.laptop, streak: 2 } } } }));
  expect(await slot.findByText(grantMode === "manual" ? "Manual grant mode — waiting for the manager" : "Next — waiting for a free slot")).toBeTruthy();
});

test("shows display name once, in-use model, expiry warning and fallback thread navigation", async () => {
  const lease = { ...fixture.pools[0].leases[0], warnedAt: at };
  const slot = render(() => ({ ok: true, data: { ...fixture, localHostName: "Work machine", titles: {}, pools: [{ ...fixture.pools[0], leases: [lease] }, { ...fixture.pools[1], leases: [{ ...lease, pool: "local-model" }] }] } }));
  expect(await slot.findByText("Work machine")).toBeTruthy();
  expect(slot.getAllByText("Work machine")).toHaveLength(1);
  expect(slot.getByText("In use")).toBeTruthy();
  expect(slot.getAllByText(/expiry warning sent/)[0].className).toContain("text-amber");
  fireEvent.click(within(slot.getByRole("region", { name: "Heavy jobs" })).getAllByRole("button", { name: "thread" })[0]);
  expect(slot.inspection.navigateCalls).toContainEqual(expect.objectContaining({ method: "toThread", threadId: "holder" }));
});

test("human activity is collapsed by default, newest first and capped at 15", async () => {
  const slot = render(() => ({ ok: true, data: { ...fixture, audit: Array.from({ length: 20 }, (_, seq) => ({ seq, at: at - (20 - seq) * 1000, type: "capacity", reason: String(seq), hostId: "laptop" })) } }));
  const summary = await slot.findByText("Recent activity · 15");
  const details = summary.closest("details")!;
  expect(details.open).toBe(false);
  fireEvent.click(summary);
  expect(details.open).toBe(true);
  const rows = within(details).getAllByRole("listitem");
  expect(rows).toHaveLength(15);
  expect(rows[0].textContent).toBe("Capacity set to 19 slots1s ago");
  expect(rows[14].textContent).toContain("Capacity set to 5");
  expect(slot.container.innerHTML).not.toContain("laptop");
});

test("formats event sentences and compact durations", async () => {
  const { duration, eventSentence } = await import("./app");
  for (const [ms, text] of [[45000, "45s"], [2100000, "35m"], [4800000, "1h 20m"], [3600000, "1h"], [-1000, "0s"]] as const) expect(duration(ms)).toBe(text);
  const base = { at, seq: 1, threadId: "holder", hostId: "laptop", pool: "heavy" as const, leaseId: "lease-secret", requestId: "request-2" };
  for (const [type, reason, text] of [
    ["grant", undefined, "QA checks got a heavy slot"],
    ["request", undefined, "QA checks asked for a heavy slot (3m)"],
    ["release", "archived", "Lease released — thread archived"],
    ["capacity", "1", "Capacity set to 1 slot"],
    ["warn", undefined, "Expiry warning sent"],
    ["port", undefined, "Port 41000 leased"],
    ["transfer", "from holder-id", "Slot transferred to QA checks"],
    ["expire", undefined, "Lease expired"],
    ["revoke", undefined, "Lease revoked"],
    ["prioritize", "high", "Priority updated for QA checks"],
    ["port-release", undefined, "Port 41000 released"],
    ["unleased-load", undefined, "High checkout load without a heavy slot"],
    ["idle-lease", undefined, "Heavy slot held while its checkout stayed idle"],
    ["use-expired", undefined, "A wrapped run stopped renewing; its use expired"],
    ["use-dropped", undefined, "A lent slot returned to its owner; the borrower's runs were dropped"],
    ["unclaimed", undefined, "Slot released because no run claimed it"],
  ] as const) expect(eventSentence({ ...base, type, reason, port: 41000 }, fixture)).toBe(text);
  const slot = render();
  const summary = await slot.findByText("Recent activity · 2");
  fireEvent.click(summary);
  expect(slot.getByText("Slot transferred to QA checks").parentElement!.title).toBe("lease-1");
});

test("shows accessible loading state", () => {
  const slot = render(() => new Promise(() => {}));
  expect(slot.getByRole("status", { name: "Loading Slots status…" }).getAttribute("aria-busy")).toBe("true");
});

test.each(["result", "transport"])("shows %s errors without leaking host details", async kind => {
  const slot = render(() => {
    if (kind === "transport") throw new Error("host_laptop unavailable");
    return { ok: false, error: { code: "not-found", message: "host_laptop unavailable" } };
  });
  expect((await slot.findByRole("alert")).textContent).toContain("Unable to refresh status.");
  expect(slot.queryByRole("status")).toBeNull();
  expect(slot.container.innerHTML).not.toContain("host_laptop");
});

test("renders empty pools, queues, activity and missing machine reading", async () => {
  const slot = render(() => ({ ok: true, data: { ...fixture, gates: {}, pools: fixture.pools.map(pool => ({ ...pool, leases: [], queue: [] })), ports: [], audit: [] } }));
  expect(await slot.findByText("Checking… (waiting for the first reading)")).toBeTruthy();
  expect(slot.getByText("All 4 slots free")).toBeTruthy();
  expect(slot.getByText("Slot free")).toBeTruthy();
  expect(slot.getAllByText("Nothing waiting")).toHaveLength(2);
  fireEvent.click(slot.getByText("Recent activity · 0"));
  expect(slot.getByText("No recent activity.")).toBeTruthy();
});

test("handles a missing pool snapshot", async () => {
  const slot = render(() => ({ ok: true, data: { ...fixture, pools: [] } }));
  expect(await slot.findByText("No pools available.")).toBeTruthy();
});

test("refreshes via realtime and button, polls while visible, preserves stale data and cleans up", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(at + 3_600_000);
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const status = vi.fn().mockReturnValue({ ok: true, data: fixture });
  const slot = render(status);
  await act(async () => {});
  await act(async () => { vi.advanceTimersByTime(4000); });
  expect(slot.getByText("Updated 4s ago")).toBeTruthy();
  await slot.behavior.emitRealtime(SLOTS_CHANGED, { at });
  expect(status).toHaveBeenCalledTimes(2);
  await act(async () => { fireEvent.click(slot.getByRole("button", { name: "Refresh" })); });
  expect(status).toHaveBeenCalledTimes(3);
  visibility.mockReturnValue("hidden");
  await act(async () => { vi.advanceTimersByTime(30_000); });
  await slot.behavior.emitRealtime(SLOTS_CHANGED, { at });
  expect(status).toHaveBeenCalledTimes(3);
  visibility.mockReturnValue("visible");
  status.mockRejectedValueOnce(new Error("Offline"));
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(slot.getByRole("alert").textContent).toContain("Showing the last successful status.");
  expect(slot.getByText("Run end-to-end suite")).toBeTruthy();
  await act(async () => { vi.advanceTimersByTime(10_000); });
  expect(status).toHaveBeenCalledTimes(5);
  expect(slot.queryByRole("alert")).toBeNull();
  slot.lifecycle.unmount();
  await act(async () => { vi.advanceTimersByTime(30_000); document.dispatchEvent(new Event("visibilitychange")); });
  await slot.behavior.emitRealtime(SLOTS_CHANGED, { at });
  expect(status).toHaveBeenCalledTimes(5);
});

test("realtime received during a request fetches a fresh snapshot when it completes", async () => {
  let resolve!: (value: unknown) => void;
  const status = vi.fn().mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockReturnValue({ ok: true, data: fixture });
  const slot = render(status);
  await slot.behavior.emitRealtime(SLOTS_CHANGED, { at });
  await act(async () => { resolve({ ok: true, data: fixture }); });
  expect(status).toHaveBeenCalledTimes(2);
});

test.each([
  [1, "Slot free", "0 of 1 slot in use"],
  [4, "All 4 slots free", "0 of 4 slots in use"],
  [0, "No slots configured", "0 of 0 slots in use"],
])("uses correct empty-pool and accessible wording for capacity %s", async (capacity, text, label) => {
  const pool = { ...fixture.pools[1], capacity };
  const slot = render(() => ({ ok: true, data: { ...fixture, pools: [pool] } }));
  const card = (await slot.findByRole("img", { name: label })).closest<HTMLElement>('[role="region"]')!;
  expect(within(card).getByText(text)).toBeTruthy();
  expect(within(card).getByRole("img", { name: label })).toBeTruthy();
  expect(within(card).getByText("Nothing waiting")).toBeTruthy();
  if (capacity === 0) expect(within(slot.getAllByRole("region", { name: "Local model" })[0]).queryByText("Free")).toBeNull();
});

test.each([1, 2])("uses correct check wording for %s required checks", async gateSamples => {
  const slot = render(() => ({ ok: true, data: { ...fixture,
    hostSettings: { laptop: { ...DEFAULT_SETTINGS, gateSamples } },
    gates: { laptop: { ...fixture.gates.laptop, streak: 0 } },
  } }));
  expect(await slot.findByText(`Checking… (0 of ${gateSamples} ${gateSamples === 1 ? "check" : "checks"})`)).toBeTruthy();
});

test.each([0, 1, 4])("pluralizes capacity activity for %s slots", async capacity => {
  const { eventSentence } = await import("./app");
  expect(eventSentence({ seq: 1, at, type: "capacity", reason: String(capacity) }, fixture))
    .toBe(`Capacity set to ${capacity} ${capacity === 1 ? "slot" : "slots"}`);
});

test("refresh uses the BB ArrowReloadHorizontal icon and stays busy until success or failure", async () => {
  const status = vi.fn().mockReturnValue({ ok: true, data: fixture });
  const slot = render(status);
  await slot.findByText("Run end-to-end suite");
  const button = slot.getByRole("button", { name: "Refresh" }) as HTMLButtonElement;
  const icon = button.querySelector('[data-icon="ArrowReloadHorizontal"]')!;
  expect(icon).toBeTruthy();
  expect(icon.getAttribute("data-icon-fallback")).toBe("RotateCcw");
  expect(button.querySelector("svg")).toBeNull();
  for (const fails of [false, true]) {
    let finish!: () => void;
    status.mockImplementationOnce(() => new Promise((resolve, reject) => {
      finish = () => fails ? reject(new Error("Offline")) : resolve({ ok: true, data: fixture });
    }));
    fireEvent.click(button);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(icon.classList.contains("animate-spin")).toBe(true);
    expect(icon.classList.contains("motion-reduce:animate-none")).toBe(true);
    fireEvent.click(button);
    await act(async () => { finish(); });
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-busy")).toBe("false");
    expect(icon.classList.contains("animate-spin")).toBe(false);
  }
  expect(status).toHaveBeenCalledTimes(3);
});

test("keeps summary values compact and shows clamped-setting warnings", async () => {
  const slot = render(() => ({ ok: true, data: { ...fixture,
    settingsWarnings: ["Saved load limit 24 exceeds 18 CPU cores; using 18."] } }));
  expect(await slot.findByText("limit 18")).toBeTruthy();
  expect(slot.getByRole("region", { name: "Heavy slots" }).textContent).toContain("1 of 4 in use");
  expect(slot.getByRole("alert").textContent).toBe("Saved load limit 24 exceeds 18 CPU cores; using 18.");
  expect(slot.container.textContent).not.toContain("(auto)");
});

test("settings groups, bounded steppers, reset, events, picker selection and inline errors", async () => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } },
    close: { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } },
  });
  const values = { heavyCapacity: 4, localModelCapacity: 1, memFreeMinPct: 20, loadMax: 18, gateSamples: 2,
    gateIntervalSeconds: 15, leaseTtlMinutes: 30, heartbeatIntervalMinutes: 10, observerThreadId: "", observerEvents: "warn,expire",
    observerQueueWaitMinutes: 20, observerGateHoldMinutes: 15, portFrom: 41000, portTo: 41099, grantMode: "auto",
    watchPolicy: "warn", watchCores: 3, watchWindowSeconds: 120, idleLeaseMinutes: 30 };
  const write = vi.fn((input: unknown) => {
    const change = input as { values?: Record<string, unknown>; unset?: string[] };
    const key = change.unset?.[0] ?? Object.keys(change.values ?? {})[0];
    const value = change.unset ? null : change.values?.[key];
    if (key === "portFrom") return { ok: false, error: { code: "invalid-input", message: "Invalid port range" } };
    return { ok: true, data: { cores: 18, heavyDefault: 4, values: { ...values, [key]: value === null ? 4 : value } } };
  });
  const slot = renderSlot(app.settingsSections[0], {}, { rpc: {
    settingsRead: () => ({ ok: true, data: { cores: 18, heavyDefault: 4, values } }), settingsWrite: write,
    status: () => ({ ok: true, data: fixture }),
  }, sdk: { threads: { list: async () => [{ id: "manager", title: "Manager session", status: "idle" }] as any,
    get: async () => ({ title: "Manager session" }) as any } } });
  await slot.findByRole("region", { name: "Slots" });
  for (const name of ["Machine check", "Leases", "Load watch", "Manager / observer", "Grant mode", "Dev-server ports"]) expect(slot.getByRole("region", { name })).toBeTruthy();
  expect(slot.getByText(/Warns when processes in a session/)).toBeTruthy();
  await act(async () => { fireEvent.click(slot.getByRole("button", { name: "Reset Cores threshold to default" })); });
  expect(write).toHaveBeenLastCalledWith({ unset: ["watchCores"] });
  await act(async () => { fireEvent.change(slot.getByRole("combobox", { name: "Load watch policy" }), { target: { value: "off" } }); });
  expect(write).toHaveBeenLastCalledWith({ values: { watchPolicy: "off" } });
  write.mockClear();
  const heavy = slot.getByRole("spinbutton", { name: "Heavy jobs capacity" });
  fireEvent.change(heavy, { target: { value: "19" } });
  expect(write).not.toHaveBeenCalled();
  expect((heavy as HTMLInputElement).value).toBe("4");
  await act(async () => { fireEvent.click(slot.getByRole("button", { name: "Reset Heavy jobs capacity to default" })); });
  expect(write).toHaveBeenLastCalledWith({ unset: ["heavyCapacity"] });
  await act(async () => { fireEvent.click(slot.getByRole("switch", { name: "Expiry warning" })); });
  expect(write).toHaveBeenLastCalledWith({ values: { observerEvents: "expire" } });
  await act(async () => { fireEvent.click(slot.getByRole("button", { name: "Choose thread…" })); });
  await act(async () => { fireEvent.click(slot.getByRole("button", { name: /Manager session/ })); });
  expect(write).toHaveBeenLastCalledWith({ values: { observerThreadId: "manager" } });
  await act(async () => { fireEvent.change(slot.getByRole("spinbutton", { name: "From port" }), { target: { value: "42000" } }); });
  expect(slot.getByRole("alert").textContent).toBe("Invalid port range");
});
