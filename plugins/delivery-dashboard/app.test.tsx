// @vitest-environment jsdom
import { act, fireEvent } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { resolveRange } from "./date-range";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));
const metric = { value: 12, detail: "Fixture metric", error: null, seriesError: null,
  series: Array.from({ length: 7 }, (_, index) => ({ date: `2026-10-${14 + index}T12:00:00.000Z`, value: index + 1 })),
};
const repo = { projectName: null, range: resolveRange(null, new Date("2026-10-20T12:00:00Z")), repository: "acme/widgets", updatedAt: "2026-10-20T12:00:00Z", deployments: metric, pullRequests: metric, ci: metric,
  ciOutcomes: { success: 12, failure: 2, cancelled: 5, skipped: 3 },
  pullRequestsCreated: { ...metric, value: 9 },
  commitActivity: { commits: 23, additions: 1234, deletions: 567, branch: "main", error: null },
  reviewQueue: { total: 1, error: null, items: [{ number: 17, title: "Needs review", createdAt: "2026-10-17T06:00:00Z", url: "https://github.com/acme/widgets/pull/17" }] },
  production: { error: null, deployment: { environment: "production", state: "success", ref: "v2", createdAt: "2026-10-20T10:00:00Z", updatedAt: "2026-10-20T11:00:00Z", url: "https://github.com/acme/widgets/actions/runs/1" } },
};
const data = { repositories: [repo], authSource: "gh", discoveryError: null };
afterEach(() => vi.useRealTimers());

test("sidebar page discovers repositories without manual configuration and shows the empty state", async () => {
  const metrics = vi.fn().mockResolvedValue({ ...data, repositories: [] });
  const slot = renderSlot(app.navPanels[0], { subPath: "" }, { rpc: { snapshot: () => null, metrics }, settings: {} });
  try {
    expect(await slot.findByText(/No GitHub repositories found/)).toBeTruthy();
    expect(metrics).toHaveBeenCalledTimes(1);
  } finally { slot.lifecycle.unmount(); }
});

test("refreshes on interval, keeps stale data on failure, supports retry, and stops after unmount", async () => {
  vi.useFakeTimers();
  const metrics = vi.fn().mockResolvedValue(data);
  const slot = renderSlot(app.navPanels[0], { subPath: "" }, {
    rpc: { snapshot: () => null, metrics }, settings: { repository: "acme/widgets", refreshSeconds: 30 },
  });
  try {
    await act(async () => {});
    expect(slot.getByText("12.0 / day")).toBeTruthy();
    expect(slot.getByText("12.0%")).toBeTruthy();
    expect(metrics).toHaveBeenCalledTimes(1);
    metrics.mockRejectedValueOnce(new Error("offline"));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(slot.getByRole("alert").textContent).toContain("out of date");
    expect(slot.getByText("12.0 / day")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Refresh" }));
    await act(async () => {});
    expect(metrics).toHaveBeenCalledTimes(3);
    expect(slot.queryByRole("alert")).toBeNull();
  } finally { slot.lifecycle.unmount(); }
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(metrics).toHaveBeenCalledTimes(3);
});


test("renders imported and additional repositories independently", async () => {
  const openUrl = vi.fn(() => true);
  const slot = renderSlot(app.navPanels[0], { subPath: "" }, {
    rpc: { snapshot: () => null, metrics: () => ({ ...data, repositories: [repo, { ...repo, repository: "acme/other", projectName: "release platform", pullRequests: { ...metric, value: 7 } }] }) }, settings: {}, openUrl,
  });
  try {
    expect(await slot.findByRole("region", { name: "acme/widgets" })).toBeTruthy();
    expect(slot.getByRole("region", { name: "acme/other" })).toBeTruthy();
    expect(slot.getAllByText("7").length).toBeGreaterThan(0);
    expect(slot.queryByText("GitHub CLI authorization")).toBeNull();
    expect(slot.getByRole("heading", { name: "Widgets" })).toBeTruthy();
    expect(slot.getByRole("heading", { name: "Release platform" })).toBeTruthy();
    const repositoryLink = slot.getByRole("link", { name: "Widgets" });
    expect(repositoryLink.getAttribute("href")).toBe("https://github.com/acme/widgets");
    fireEvent.click(repositoryLink);
    expect(openUrl).toHaveBeenLastCalledWith("https://github.com/acme/widgets");
    fireEvent.click(slot.getByRole("link", { name: "Release platform" }));
    expect(openUrl).toHaveBeenLastCalledWith("https://github.com/acme/other");
    expect(slot.getAllByText("Last 7 days")).toHaveLength(2);
    expect(slot.getAllByText(/13.*20 Oct 2026/)).toHaveLength(2);
    expect(slot.queryByText("Date range")).toBeNull();
  } finally { slot.lifecycle.unmount(); }
});


test("registers only a sidebar page and renders accessible charts from real series", async () => {
  expect(app.homepageSections).toHaveLength(0);
  expect(app.navPanels[0]).toMatchObject({ title: "Delivery dashboard", path: "dashboard", icon: "Package" });
  const slot = renderSlot(app.navPanels[0], { subPath: "" }, { rpc: { snapshot: () => null, metrics: () => data }, settings: {} });
  try {
    expect(await slot.findByRole("figure", { name: "Deployment throughput" })).toBeTruthy();
    expect(slot.getByRole("figure", { name: "CI pass rate over time" })).toBeTruthy();
    expect(slot.getByRole("group", { name: /Deployment throughput:.*Oct 14: 1/ })).toBeTruthy();
  } finally { slot.lifecycle.unmount(); }
});

test("unavailable history is explained without showing an invented chart", async () => {
  const slot = renderSlot(app.navPanels[0], { subPath: "" }, {
    rpc: { snapshot: () => null, metrics: () => ({ ...data, repositories: [{ ...repo, ci: { ...metric, series: null, seriesError: "History limit exceeded" } }] }) }, settings: {},
  });
  try {
    expect(await slot.findByText("History limit exceeded")).toBeTruthy();
    expect(slot.getAllByRole("group", { name: /Deployment throughput:|CI pass rate over time:/ })).toHaveLength(1);
    expect(slot.getByText("12.0%")).toBeTruthy();
  } finally { slot.lifecycle.unmount(); }
});


test("renders CI outcomes, review ages, and a linked production deployment", async () => {
  const slot = renderSlot(app.navPanels[0], { subPath: "" }, { rpc: { snapshot: () => null, metrics: () => data }, settings: {} });
  try {
    expect(await slot.findByRole("region", { name: "CI outcomes" })).toBeTruthy();
    expect(slot.getByText("Cancelled")).toBeTruthy();
    expect(slot.getByText("Skipped")).toBeTruthy();
    expect(slot.getByText("3d 6h open")).toBeTruthy();
    expect(slot.getByRole("link", { name: "#17 Needs review" }).getAttribute("href")).toBe("https://github.com/acme/widgets/pull/17");
    expect(slot.getByRole("link", { name: "View deployment ↗" }).getAttribute("href")).toBe("https://github.com/acme/widgets/actions/runs/1");
    expect(slot.getByText("Created 2h ago")).toBeTruthy();
  } finally { slot.lifecycle.unmount(); }
});

test("empty review and production sections do not claim data is unavailable", async () => {
  const slot = renderSlot(app.navPanels[0], { subPath: "" }, {
    rpc: { snapshot: () => null, metrics: () => ({ ...data, repositories: [{ ...repo, ciOutcomes: {}, reviewQueue: { total: 0, items: [], error: null }, production: { deployment: null, error: null } }] }) }, settings: {},
  });
  try {
    expect(await slot.findByText("No production deployment found.")).toBeTruthy();
    expect(slot.getByText("No PRs awaiting required review.")).toBeTruthy();
    expect(slot.queryByRole("alert")).toBeNull();
  } finally { slot.lifecycle.unmount(); }
});


test("renders created PRs, commits, and cumulative added and deleted lines", async () => {
  const slot = renderSlot(app.navPanels[0], { subPath: "" }, { rpc: { snapshot: () => null, metrics: () => data }, settings: {} });
  try {
    expect(await slot.findByRole("region", { name: "Repository activity in the last 7 days" })).toBeTruthy();
    for (const label of ["PRs created", "Commits", "Lines added", "Lines deleted", "+1,234", "−567", "main history"]) expect(slot.getByText(label)).toBeTruthy();
  } finally { slot.lifecycle.unmount(); }
});

test("missing commit authorization shows unavailable values while created PRs remain visible", async () => {
  const slot = renderSlot(app.navPanels[0], { subPath: "" }, {
    rpc: { snapshot: () => null, metrics: () => ({ ...data, repositories: [{ ...repo, commitActivity: { commits: null, additions: null, deletions: null, branch: null, error: "GitHub authorization is required" } }] }) }, settings: {},
  });
  try {
    expect(await slot.findByText("Commit activity: GitHub authorization is required")).toBeTruthy();
    expect(slot.getByText("PRs created")).toBeTruthy();
    expect(slot.queryByText("+0")).toBeNull();
  } finally { slot.lifecycle.unmount(); }
});


test("pending interval and manual refreshes leave the same cards visible without a loading state", async () => {
  vi.resetModules();
  const isolatedApp = await loadPluginApp(() => import("./app"));
  vi.useFakeTimers();
  let finish!: (value: typeof data) => void;
  const pending = new Promise<typeof data>((resolve) => { finish = resolve; });
  const metrics = vi.fn().mockResolvedValueOnce(data).mockReturnValueOnce(pending).mockReturnValueOnce(pending);
  const slot = renderSlot(isolatedApp.navPanels[0], { subPath: "" }, {
    rpc: { snapshot: () => null, metrics }, settings: { repository: "acme/widgets", refreshSeconds: 30 },
  });
  try {
    await act(async () => {});
    const originalCards = slot.getByRole("region", { name: "acme/widgets" });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(metrics).toHaveBeenCalledTimes(2);
    expect(slot.getByRole("region", { name: "acme/widgets" })).toBe(originalCards);
    expect(slot.getByText("12.0 / day")).toBeTruthy();
    expect(slot.getByRole("button", { name: "Refresh" }).hasAttribute("disabled")).toBe(true);
    expect(slot.getByRole("button", { name: "Refresh" }).getAttribute("aria-busy")).toBe("true");
    expect(slot.getByRole("button", { name: "Refresh" }).querySelector("svg")).not.toBeNull();
    expect(slot.getByRole("button", { name: "Refresh" }).textContent?.trim()).toBe("");
    expect(slot.getByRole("region", { name: "GitHub delivery metrics" }).getAttribute("aria-busy")).toBe("false");
    expect(slot.queryByText(/Loading|Refreshing/)).toBeNull();
    await act(async () => { finish(data); });
    expect(slot.getByRole("button", { name: "Refresh" }).getAttribute("aria-busy")).toBe("false");
    expect(slot.getByRole("button", { name: "Refresh" }).querySelector("svg")).toBeNull();
    expect(slot.getByRole("button", { name: "Refresh" }).textContent).toBe("Refresh");
    fireEvent.click(slot.getByRole("button", { name: "Refresh" }));
    await act(async () => {});
    expect(metrics).toHaveBeenCalledTimes(3);
    expect(slot.getByRole("region", { name: "acme/widgets" })).toBe(originalCards);
  } finally { slot.lifecycle.unmount(); }
});

test("returning from the sidebar shows cached values immediately while retrying and keeps them on failure", async () => {
  vi.resetModules();
  const isolatedApp = await loadPluginApp(() => import("./app"));
  let reject!: (reason: Error) => void;
  const pending = new Promise<never>((_resolve, fail) => { reject = fail; });
  const metrics = vi.fn().mockResolvedValueOnce(data).mockReturnValueOnce(pending);
  const options = { rpc: { snapshot: () => null, metrics }, settings: { repository: "acme/widgets" } };
  const first = renderSlot(isolatedApp.navPanels[0], { subPath: "" }, options);
  await first.findByText("12.0 / day");
  first.lifecycle.unmount();
  const second = renderSlot(isolatedApp.navPanels[0], { subPath: "" }, options);
  try {
    expect(second.getByText("12.0 / day")).toBeTruthy();
    expect(second.getByRole("figure", { name: "Deployment throughput" })).toBeTruthy();
    expect(second.queryByText(/Loading|Refreshing/)).toBeNull();
    await act(async () => { reject(new Error("offline")); });
    expect(second.getByText("12.0 / day")).toBeTruthy();
    expect(second.getByRole("alert").textContent).toContain("out of date");
  } finally { second.lifecycle.unmount(); }
});

test("presets preserve displayed data while updating and ignore superseded responses", async () => {
  vi.resetModules();
  const isolated = await loadPluginApp(() => import("./app"));
  let finishDay!: (value: unknown) => void;
  const metrics = vi.fn().mockResolvedValue(data);
  const slot = renderSlot(isolated.navPanels[0], { subPath: "" }, { rpc: { snapshot: () => null, metrics }, settings: {} });
  try {
    await act(async () => {});
    expect(metrics).toHaveBeenLastCalledWith({ days: 7 });
    const activity = slot.getByRole("region", { name: "Repository activity in the last 7 days" });
    metrics.mockImplementationOnce(() => new Promise((resolve) => { finishDay = resolve; }));
    fireEvent.change(slot.getByRole("combobox", { name: "Date range" }), { target: { value: "1" } });
    await act(async () => {});
    expect(metrics).toHaveBeenLastCalledWith({ days: 1 });
    expect(slot.getByRole("region", { name: "Repository activity in the last 7 days" })).toBe(activity);
    expect(slot.queryByText(/Updating date range/)).toBeNull();
    expect(slot.getByRole("button", { name: "Refresh" }).getAttribute("aria-busy")).toBe("true");
    const threeDays = { ...data, repositories: [{ ...repo, range: resolveRange({ days: 3 }) }] };
    metrics.mockResolvedValue(threeDays);
    fireEvent.change(slot.getByRole("combobox", { name: "Date range" }), { target: { value: "3" } });
    await act(async () => {});
    expect(metrics).toHaveBeenLastCalledWith({ days: 3 });
    expect(slot.getByRole("region", { name: "Repository activity in the last 3 days" })).toBeTruthy();
    await act(async () => { finishDay({ ...data, repositories: [{ ...repo, range: resolveRange({ days: 1 }) }] }); });
    expect(slot.queryByRole("region", { name: "Repository activity in the last 1 day" })).toBeNull();
    slot.lifecycle.unmount();
    const reopened = renderSlot(isolated.navPanels[0], { subPath: "" }, { rpc: { snapshot: () => null, metrics }, settings: {} });
    try { expect((reopened.getByRole("combobox", { name: "Date range" }) as HTMLSelectElement).value).toBe("3"); }
    finally { await act(async () => {}); reopened.lifecycle.unmount(); }
  } finally { slot.lifecycle.unmount(); }
});

test("custom dates apply explicitly and invalid dates keep the current results", async () => {
  vi.resetModules();
  const isolated = await loadPluginApp(() => import("./app"));
  const metrics = vi.fn().mockResolvedValue(data);
  const slot = renderSlot(isolated.navPanels[0], { subPath: "" }, { rpc: { snapshot: () => null, metrics }, settings: {} });
  try {
    await act(async () => {});
    fireEvent.change(slot.getByRole("combobox", { name: "Date range" }), { target: { value: "custom" } });
    fireEvent.change(slot.getByLabelText("From date"), { target: { value: "2026-10-10" } });
    fireEvent.change(slot.getByLabelText("Through date"), { target: { value: "2026-10-01" } });
    fireEvent.click(slot.getByRole("button", { name: "Apply dates" }));
    expect(slot.getByRole("alert").textContent).toContain("start on or before");
    expect(metrics).toHaveBeenCalledTimes(1);
    fireEvent.change(slot.getByLabelText("Through date"), { target: { value: "2026-10-12" } });
    fireEvent.click(slot.getByRole("button", { name: "Apply dates" }));
    await act(async () => {});
    expect(metrics).toHaveBeenLastCalledWith({ start: "2026-10-10", end: "2026-10-12" });
    expect(slot.queryByRole("alert")).toBeNull();
  } finally { slot.lifecycle.unmount(); }
});

// jsdom does not implement the native dialog lifecycle; browser verification covers focus and Escape.
function mockNativeDialog() {
  const showModal = HTMLDialogElement.prototype.showModal, close = HTMLDialogElement.prototype.close;
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  return () => { HTMLDialogElement.prototype.showModal = showModal; HTMLDialogElement.prototype.close = close; };
}

test("both charts open interval statistics, with non-overlapping boundaries and accessible dismissal", async () => {
  const restore = mockNativeDialog();
  const interval = vi.fn().mockResolvedValue({ ...repo, range: { ...repo.range, label: "selected interval" } });
  const slot = renderSlot(app.navPanels[0], { subPath: "" }, { rpc: { snapshot: () => null, metrics: () => data, interval }, settings: {} });
  try {
    const plot = await slot.findByRole("group", { name: /Deployment throughput:/ });
    const buttons = Array.from(plot.querySelectorAll("button"));
    fireEvent.click(buttons[0]);
    await act(async () => {});
    expect(interval).toHaveBeenLastCalledWith({ repository: "acme/widgets", since: repo.range.since, until: "2026-10-14T11:59:59.999Z" });
    const dialog = slot.getByRole("dialog", { name: "Interval statistics" });
    expect(dialog.textContent).toContain("Deployments");
    expect(dialog.textContent).not.toContain("acme/widgets");
    expect(dialog.textContent).toMatch(/13.*14 Oct 2026/);
    expect(dialog.textContent).toContain("CI outcomes");
    expect(dialog.textContent).toContain("+1,234");
    expect(dialog.textContent).toContain("−567");
    fireEvent.click(dialog.querySelector("button")!);
    expect(slot.queryByRole("dialog")).toBeNull();
    fireEvent.click(buttons[1]);
    await act(async () => {});
    expect(interval).toHaveBeenLastCalledWith({ repository: "acme/widgets", since: "2026-10-14T12:00:00.000Z", until: "2026-10-15T11:59:59.999Z" });
    fireEvent(slot.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(slot.queryByRole("dialog")).toBeNull();
    const ci = slot.getByRole("group", { name: /CI pass rate over time:/ });
    fireEvent.click(ci.querySelector("button:last-child")!);
    await act(async () => {});
    expect(interval).toHaveBeenLastCalledWith({ repository: "acme/widgets", since: "2026-10-19T12:00:00.000Z", until: "2026-10-20T12:00:00.000Z" });
  } finally { slot.lifecycle.unmount(); restore(); }
});

test("interval failure can be retried without hiding the dashboard, and empty bars remain clickable", async () => {
  const restore = mockNativeDialog();
  const interval = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ ...repo, commitActivity: { ...repo.commitActivity, commits: null, additions: null, deletions: null, error: "Commit history unavailable" } });
  const emptyMetric = { ...metric, series: metric.series.map((point) => ({ ...point, value: 0 })) };
  const slot = renderSlot(app.navPanels[0], { subPath: "" }, { rpc: { snapshot: () => null, metrics: () => ({ ...data, repositories: [{ ...repo, deployments: emptyMetric, ci: { ...emptyMetric, series: emptyMetric.series.map((point) => ({ ...point, value: null })) } }] }), interval }, settings: {} });
  try {
    const plot = await slot.findByRole("group", { name: /CI pass rate over time:/ });
    fireEvent.click(plot.querySelector("button")!);
    await act(async () => {});
    expect(slot.getByRole("dialog").textContent).toContain("Unable to load interval statistics");
    expect(slot.getByText("12.0 / day")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Retry" }));
    await act(async () => {});
    expect(interval).toHaveBeenCalledTimes(2);
    expect(slot.getByRole("dialog").textContent).toContain("Commit history unavailable");
    expect(slot.getByText("12.0 / day")).toBeTruthy();
  } finally { slot.lifecycle.unmount(); restore(); }
});

test("popup tracks the visible viewport on zoom, resize, and pan, and removes its listeners", async () => {
  const restore = mockNativeDialog();
  const viewport = Object.assign(new EventTarget(), { width: 320, height: 480, offsetLeft: 20, offsetTop: 40 });
  vi.stubGlobal("visualViewport", viewport);
  const remove = vi.spyOn(viewport, "removeEventListener");
  const slot = renderSlot(app.navPanels[0], { subPath: "" }, { rpc: { snapshot: () => null, metrics: () => data, interval: () => new Promise(() => {}) }, settings: {} });
  try {
    const plot = await slot.findByRole("group", { name: /Deployment throughput:/ });
    fireEvent.click(plot.querySelector("button")!);
    const dialog = slot.getByRole("dialog") as HTMLDialogElement;
    const loading = slot.getByRole("status", { name: "Loading interval statistics" });
    expect(loading.textContent?.trim()).toBe("");
    expect(loading.querySelector("svg")).not.toBeNull();
    expect(dialog.style.maxWidth).toBe("288px");
    expect(dialog.style.maxHeight).toBe("448px");
    expect(dialog.style.left).toBe("180px");
    expect(dialog.style.top).toBe("280px");
    Object.assign(viewport, { width: 240, height: 360 });
    viewport.dispatchEvent(new Event("resize"));
    expect(dialog.style.maxWidth).toBe("208px");
    expect(dialog.style.maxHeight).toBe("328px");
    Object.assign(viewport, { offsetLeft: 80, offsetTop: 100 });
    viewport.dispatchEvent(new Event("scroll"));
    expect(dialog.style.left).toBe("200px");
    expect(dialog.style.top).toBe("280px");
    fireEvent(slot.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(remove).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(remove).toHaveBeenCalledWith("scroll", expect.any(Function));
  } finally { slot.lifecycle.unmount(); vi.unstubAllGlobals(); remove.mockRestore(); restore(); }
});

test("popup stays inside its dashboard pane beside a native browser and tracks split resizing", async () => {
  const restore = mockNativeDialog();
  vi.stubGlobal("visualViewport", Object.assign(new EventTarget(), { width: 1440, height: 900, offsetLeft: 0, offsetTop: 0 }));
  let resize!: ResizeObserverCallback;
  const observe = vi.fn(), disconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { resize = callback; }
    observe = observe;
    disconnect = disconnect;
  });
  const slot = renderSlot(app.navPanels[0], { subPath: "" }, { rpc: { snapshot: () => null, metrics: () => data, interval: () => new Promise(() => {}) }, settings: {} });
  try {
    const plot = await slot.findByRole("group", { name: /Deployment throughput:/ });
    const container = plot.closest("[data-delivery-dashboard-viewport]")!;
    const bounds = vi.spyOn(container, "getBoundingClientRect").mockReturnValue(new DOMRect(280, 40, 600, 800));
    fireEvent.click(plot.querySelector("button")!);
    const dialog = slot.getByRole("dialog") as HTMLDialogElement;
    expect(observe).toHaveBeenCalledWith(container);
    expect(dialog.style.left).toBe("580px");
    expect(dialog.style.maxWidth).toBe("568px");
    expect(dialog.style.top).toBe("440px");
    expect(dialog.style.maxHeight).toBe("768px");
    bounds.mockReturnValue(new DOMRect(280, 40, 400, 800));
    resize([], {} as ResizeObserver);
    expect(dialog.style.left).toBe("480px");
    expect(dialog.style.maxWidth).toBe("368px");
    fireEvent(slot.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(disconnect).toHaveBeenCalledOnce();
  } finally { slot.lifecycle.unmount(); vi.unstubAllGlobals(); restore(); }
});


test("shows an explicit status until the first GitHub metrics arrive", async () => {
  vi.resetModules();
  const isolatedApp = await loadPluginApp(() => import("./app"));
  let finish!: (value: typeof data) => void;
  const pending = new Promise<typeof data>((resolve) => { finish = resolve; });
  const slot = renderSlot(isolatedApp.navPanels[0], { subPath: "" }, {
    rpc: { snapshot: () => null, metrics: () => pending }, settings: { repository: "acme/widgets" },
  });
  try {
    expect(await slot.findByText("Loading GitHub metrics…")).toBeTruthy();
    await act(async () => { finish(data); });
    expect(slot.queryByText("Loading GitHub metrics…")).toBeNull();
    expect(slot.getByText("12.0 / day")).toBeTruthy();
  } finally { slot.lifecycle.unmount(); }
});


test("shows a server snapshot in a fresh window while GitHub is still pending", async () => {
  vi.resetModules();
  const isolated = await loadPluginApp(() => import("./app"));
  let reject!: (error: Error) => void;
  const metrics = vi.fn(() => new Promise<never>((_resolve, fail) => { reject = fail; }));
  const slot = renderSlot(isolated.navPanels[0], { subPath: "" }, {
    rpc: { snapshot: () => data, metrics }, settings: { repository: "acme/widgets" },
  });
  try {
    await act(async () => {});
    expect(slot.getByText("12.0 / day")).toBeTruthy();
    expect(slot.queryByText("Loading GitHub metrics…")).toBeNull();
    expect(metrics).toHaveBeenCalledTimes(1);
    await act(async () => { reject(new Error("offline")); });
    expect(slot.getByText("12.0 / day")).toBeTruthy();
    expect(slot.getByRole("alert").textContent).toContain("out of date");
  } finally { slot.lifecycle.unmount(); }
});


test("production dispatch needs confirmation, supports cancel, and links the requested run", async () => {
  const deploymentData = { ...data, repositories: [{ ...repo, repository: "simple-life-app/anvil" }] };
  let finish!: (value: { url: string }) => void;
  const deployProduction = vi.fn(() => new Promise<{ url: string }>((resolve) => { finish = resolve; }));
  const slot = renderSlot(app.navPanels[0], { subPath: "" }, {
    rpc: { snapshot: () => null, metrics: () => deploymentData, deployProduction }, settings: { repository: "simple-life-app/anvil" },
  });
  try {
    const deploy = await slot.findByRole("button", { name: "Deploy production" });
    fireEvent.click(deploy);
    expect(slot.getByRole("group", { name: "Confirm production deployment" }).textContent).toContain("simple-life-app/anvil from main");
    expect(deployProduction).not.toHaveBeenCalled();
    fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
    expect(slot.queryByRole("group", { name: "Confirm production deployment" })).toBeNull();
    expect(deployProduction).not.toHaveBeenCalled();
    fireEvent.click(deploy);
    fireEvent.click(slot.getByRole("button", { name: "Start deployment" }));
    await act(async () => {});
    expect(slot.getByRole("button", { name: "Requesting…" }).hasAttribute("disabled")).toBe(true);
    expect(deployProduction).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ url: "https://github.com/simple-life-app/anvil/actions/runs/123" }); });
    expect(slot.getByText("Production workflow requested.")).toBeTruthy();
    expect(slot.getByRole("link", { name: "View workflow ↗" }).getAttribute("href")).toContain("/actions/runs/123");
    expect(slot.queryByRole("button", { name: "Deploy production" })).toBeNull();
  } finally { slot.lifecycle.unmount(); }
});

test("unconfirmed production requests explain how to check status without exposing error content", async () => {
  const slot = renderSlot(app.navPanels[0], { subPath: "" }, {
    rpc: { snapshot: () => null, metrics: () => ({ ...data, repositories: [{ ...repo, repository: "simple-life-app/anvil" }] }), deployProduction: () => { throw new Error("private-token"); } },
    settings: { repository: "simple-life-app/anvil" },
  });
  try {
    fireEvent.click(await slot.findByRole("button", { name: "Deploy production" }));
    fireEvent.click(slot.getByRole("button", { name: "Start deployment" }));
    const alert = await slot.findByRole("alert");
    expect(alert.textContent).toContain("Check the Production workflow");
    expect(alert.textContent).not.toContain("private-token");
    expect(slot.getByRole("button", { name: "Start deployment" }).hasAttribute("disabled")).toBe(false);
  } finally { slot.lifecycle.unmount(); }
});
