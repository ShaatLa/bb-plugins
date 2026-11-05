import { mountDraftSettingsDisclosure } from "./settings-disclosure";
import { draftSettingLabels } from "./draft-deferrals";
// @vitest-environment jsdom
import { act, fireEvent, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { Metrics } from "./metrics";
import { summarizeCi } from "./ci-insights";
import { duration, when } from "./ci-cards";
import { minimumDate, resolveRange } from "./date-range";
import { loadPluginApp, renderSlot as renderSdkSlot } from "@get-bb/plugin-sdk/testing/app";

const renderSlot: typeof renderSdkSlot = (registration, props, options) => renderSdkSlot(registration, props, {
  ...options, rpc: { signals: () => ({ repositories: [], actors: { owner_sre: "SRE", pr_author: "Author", lead: "Lead", manager: "Manager" } }), navigationBadge: () => ({ count: 0, critical: 0 }), ...options?.rpc },
});

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

test("CI cards show actionable failures, workflow breakdown and overall and individual timing", async () => {
  vi.resetModules();
  const isolated = await loadPluginApp(() => import("./app"));
  const ciInsights = summarizeCi([1, 2, 3].map((id) => ({ id, workflow_id: 42, name: "Unit tests", head_branch: "main", event: "push", conclusion: "failure",
    created_at: `2026-10-20T0${id}:00:00Z`, run_started_at: `2026-10-20T0${id}:00:00Z`, updated_at: `2026-10-20T0${id}:02:00Z`,
  })).concat([{ id: 4, workflow_id: 43, name: "Slower workflow", head_branch: "main", event: "push", conclusion: "success",
    created_at: "2026-10-20T04:00:00Z", run_started_at: "2026-10-20T04:00:00Z", updated_at: "2026-10-20T04:05:00Z" }, { id: 5, workflow_id: 42, name: "Unit tests", head_branch: "main", event: "push", conclusion: "success",
    created_at: "2026-10-19T23:00:00Z", run_started_at: "2026-10-19T23:00:00Z", updated_at: "2026-10-19T23:02:00Z" }]), "main");
  const slot = renderSlot(isolated.navPanels[0], { subPath: "" }, { rpc: { snapshot: () => null, metrics: () => ({ ...data, repositories: [{ ...repo, ciInsights, ciOutcomes: { success: 2, failure: 3 } }] }) }, settings: {} });
  try {
    const attention = await slot.findByRole("region", { name: "CI health" });
    expect(slot.queryByRole("region", { name: "CI needs attention" })).toBeNull();
    expect(slot.getByText("— 3 failed · 25% passed")).toBeTruthy();
    const timings = slot.getByRole("region", { name: "CI run timings" });
    const order = [timings, attention, slot.getByRole("region", { name: "Repository activity in the last 7 days" }),
      slot.getByRole("heading", { name: "CI pass rate over time" }), slot.getByRole("region", { name: "PRs awaiting review" })];
    for (let index = 1; index < order.length; index++) expect(order[index - 1].compareDocumentPosition(order[index]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(timings.textContent).toContain("7m 0s");
    expect(timings.textContent).toContain("Timing available for 2 of 2 successful runs · 3 non-successful runs excluded");
    expect(slot.getByRole("link", { name: /Unit tests · main · #5/ }).getAttribute("href")).toBe("https://github.com/acme/widgets/actions/runs/5");
    const workflows = slot.getByRole("list", { name: "Workflow timings" });
    expect(workflows.querySelector("li a")?.textContent).toBe("Slower workflow");
    const unit = workflows.querySelector('a[href$="/actions/workflows/42"]');
    expect(unit?.closest("li")?.textContent).toContain("Total 2m 0s");
    expect(unit?.closest("li")?.querySelector(".text-lg")?.textContent).toBe("2m 0s");
  } finally { slot.lifecycle.unmount(); }
});

test("timing summary separates CI from frequent short automation without refetching", async () => {
  const started = "2026-10-20T00:00:00Z";
  const ciInsights = summarizeCi([10, 14, 16, 1000, 1100].map((seconds, index) => ({
    id: index + 1, workflow_id: index < 3 ? 2 : 1, name: index < 3 ? "Docs check" : "CI",
    head_branch: "main", event: "push", conclusion: "success", created_at: started, run_started_at: started,
    updated_at: new Date(Date.parse(started) + seconds * 1000).toISOString(),
  })), "main");
  const metrics = vi.fn(() => ({ ...data, repositories: [{ ...repo, ciInsights, ciOutcomes: { success: 5 } }] }));
  const slot = renderSlot(app.navPanels[0], { subPath: "" }, { rpc: { snapshot: () => null, metrics }, settings: {} });
  try {
    const card = await slot.findByRole("region", { name: "CI run timings" });
    const median = () => within(card).getByText("Median", { selector: "dt" }).nextElementSibling?.textContent;
    expect(median()).toBe("17m 30s");
    expect(card.textContent).toContain("Timing available for 2 of 2 successful runs");
    const calls = metrics.mock.calls.length;
    const select = within(card).getByRole("combobox", { name: "Timing workflow" });
    fireEvent.change(select, { target: { value: "all" } });
    expect(median()).toBe("16s");
    expect(card.textContent).toContain("frequent short automation runs can dominate the median");
    expect(card.textContent).toContain("Timing available for 5 of 5 successful runs");
    fireEvent.change(select, { target: { value: "2" } });
    expect(median()).toBe("14s");
    expect(card.textContent).toContain("Timing available for 3 of 3 successful runs");
    expect(metrics.mock.calls.length).toBe(calls);
    fireEvent.click(slot.getByRole("button", { name: "Refresh" }));
    await act(async () => {});
    expect(median()).toBe("14s");
  } finally { slot.lifecycle.unmount(); }
});

test("chart expansion is reciprocal, restores the same charts and persists through a data refresh", async () => {
  vi.resetModules();
  const isolated = await loadPluginApp(() => import("./app"));
  const slot = renderSlot(isolated.navPanels[0], { subPath: "" }, { rpc: { snapshot: () => null, metrics: () => data }, settings: {} });
  try {
    const ci = await slot.findByRole("figure", { name: "CI pass rate over time" });
    const deployments = slot.getByRole("figure", { name: "Deployment throughput" });
    const group = slot.getByRole("group", { name: "History charts" });
    fireEvent.click(slot.getByRole("button", { name: "Expand CI pass rate over time" }));
    expect(slot.getByRole("button", { name: "Restore CI pass rate over time" }).getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(slot.getByRole("button", { name: "Restore CI pass rate over time" }));
    expect(slot.queryByRole("figure", { name: "Deployment throughput" })).toBeNull();
    expect(deployments.closest("[inert]")?.getAttribute("aria-hidden")).toBe("true");
    expect(group.className).toContain("xl:grid-cols-[minmax(0,1fr)_minmax(0,0fr)]");
    expect(group.className).toContain("transition-[grid-template-columns,gap]");
    fireEvent.click(slot.getByRole("button", { name: "Refresh" }));
    await act(async () => {});
    expect(slot.getByRole("button", { name: "Restore CI pass rate over time" })).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Restore CI pass rate over time" }));
    expect(slot.getByRole("figure", { name: "Deployment throughput" })).toBe(deployments);
    expect(slot.getByRole("figure", { name: "CI pass rate over time" })).toBe(ci);
    fireEvent.click(slot.getByRole("button", { name: "Expand Deployment throughput" }));
    expect(slot.queryByRole("figure", { name: "CI pass rate over time" })).toBeNull();
    expect(group.className).toContain("xl:grid-cols-[minmax(0,0fr)_minmax(0,1fr)]");
    fireEvent.click(slot.getByRole("button", { name: "Restore Deployment throughput" }));
    expect(slot.getByRole("figure", { name: "CI pass rate over time" })).toBe(ci);
    expect(slot.getByRole("figure", { name: "Deployment throughput" })).toBe(deployments);
  } finally { slot.lifecycle.unmount(); }
});

test("progressive loading skeletons clear independently while ready cards and errors remain readable", async () => {
  vi.resetModules();
  const isolated = await loadPluginApp(() => import("./app"));
  let finish!: (value: typeof data) => void;
  const slot = renderSlot(isolated.navPanels[0], { subPath: "" }, { rpc: { snapshot: () => null, metrics: () => new Promise<typeof data>((resolve) => { finish = resolve; }) }, settings: {} });
  try {
    await act(async () => {});
    const empty = { value: null, detail: "Loading…", series: null, error: null, seriesError: null };
    const partial: Metrics & { projectName: null } = { ...repo, pending: ["ci", "deployments"], ci: empty, deployments: empty, ciOutcomes: null };
    const progress = (metrics: typeof partial, startedAt: number) => slot.behavior.emitRealtime("metrics-progress", { selection: JSON.stringify({ days: 7 }), startedAt, metrics });
    await progress(partial, 1);
    for (const name of ["Loading CI pass rate", "Loading Deploy frequency", "Loading CI timings", "Loading CI outcomes…", "Loading CI pass rate over time", "Loading Deployment throughput"]) {
      const skeleton = slot.getByRole("status", { name });
      expect(skeleton.getAttribute("aria-busy")).toBe("true");
      expect(skeleton.querySelector(".animate-pulse[aria-hidden=true]")?.classList.contains("motion-reduce:animate-none")).toBe(true);
    }
    expect(slot.getByRole("heading", { name: "Open pull requests" }).parentElement?.textContent).toContain("12");
    await progress({ ...partial, ci: metric, ciOutcomes: repo.ciOutcomes, pending: ["deployments"] }, 2);
    expect(slot.queryByRole("status", { name: "Loading CI pass rate" })).toBeNull();
    expect(slot.getByText("12.0%")).toBeTruthy();
    expect(slot.getByRole("status", { name: "Loading Deploy frequency" })).toBeTruthy();
    await progress({ ...partial, deployments: { ...empty, detail: "Unavailable", error: "GitHub returned 403. Check access." }, pending: ["ci"] }, 3);
    expect(slot.queryByRole("status", { name: "Loading Deploy frequency" })).toBeNull();
    expect(slot.getAllByText("GitHub returned 403. Check access.").length).toBeGreaterThan(0);
    await act(async () => { finish(data); });
    expect(slot.queryByRole("status", { name: /^Loading/ })).toBeNull();
  } finally { slot.lifecycle.unmount(); }
});

test("slow refresh progress preserves cached cards, charts and timings instead of restoring skeletons", async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(repo.updatedAt));
  const isolated = await loadPluginApp(() => import("./app"));
  const ciInsights = summarizeCi([{ id: 1, workflow_id: 1, name: "CI", head_branch: "main", event: "push", conclusion: "success",
    created_at: "2026-10-20T00:00:00Z", run_started_at: "2026-10-20T00:00:00Z", updated_at: "2026-10-20T00:10:00Z" }], "main");
  const cached = { ...data, repositories: [{ ...repo, ciInsights }] };
  let finish!: (value: typeof cached) => void;
  const slot = renderSlot(isolated.navPanels[0], { subPath: "" }, { rpc: { snapshot: () => cached, metrics: () => new Promise<typeof cached>((resolve) => { finish = resolve; }) }, settings: {} });
  try {
    await act(async () => {});
    fireEvent.click(slot.getByRole("button", { name: "Refresh" }));
    await act(async () => {});
    const empty = { value: null, detail: "Loading…", series: null, error: null, seriesError: null };
    await slot.behavior.emitRealtime("metrics-progress", { selection: JSON.stringify({ days: 7 }), startedAt: 1, metrics: {
      ...repo, updatedAt: "2026-10-20T12:01:00Z", ci: empty, ciOutcomes: null, deployments: empty,
      pullRequests: { ...metric, value: 25 }, pending: ["ci", "deployments", "commitActivity"],
      commitActivity: { commits: null, additions: null, deletions: null, branch: null, error: null },
    } });
    await act(async () => { await vi.advanceTimersByTimeAsync(11_000); });
    expect(slot.queryByRole("status", { name: /^Loading/ })).toBeNull();
    expect(slot.getByText("12.0%")).toBeTruthy();
    expect(slot.getByText("12.0 / day")).toBeTruthy();
    expect(slot.getByRole("heading", { name: "Open pull requests" }).parentElement?.textContent).toContain("25");
    expect(slot.getByRole("region", { name: "CI run timings" }).textContent).toContain("10m 0s");
    expect(slot.getByRole("figure", { name: "CI pass rate over time" }).querySelector("button")).toBeTruthy();
    await act(async () => { finish({ ...cached, repositories: [{ ...cached.repositories[0], ci: { ...metric, value: 96 } }] }); });
    expect(slot.getByText("96.0%")).toBeTruthy();
    expect(slot.getByRole("button", { name: "Refresh" }).getAttribute("aria-busy")).toBe("false");
  } finally { slot.lifecycle.unmount(); }
});

test("progress renders ready cards before the full RPC and rejects older or other-range events", async () => {
  vi.resetModules();
  const isolated = await loadPluginApp(() => import("./app"));
  let finish!: (value: typeof data) => void;
  const metrics = vi.fn(() => new Promise<typeof data>((resolve) => { finish = resolve; }));
  const slot = renderSlot(isolated.navPanels[0], { subPath: "" }, { rpc: { snapshot: () => null, metrics }, settings: {} });
  try {
    await act(async () => {});
    const ready = { ...repo, ci: { ...metric, value: 87 }, pending: ["commitActivity"] };
    await slot.behavior.emitRealtime("metrics-progress", { selection: JSON.stringify({ days: 7 }), startedAt: 2, metrics: ready });
    expect(slot.getByText("87.0%")).toBeTruthy();
    expect(slot.queryByText("Loading GitHub metrics…")).toBeNull();
    await slot.behavior.emitRealtime("metrics-progress", { selection: JSON.stringify({ days: 7 }), startedAt: 1, metrics: { ...ready, ci: { ...metric, value: 13 } } });
    await slot.behavior.emitRealtime("metrics-progress", { selection: JSON.stringify({ days: 90 }), startedAt: 3, metrics: { ...ready, ci: { ...metric, value: 14 } } });
    expect(slot.getByText("87.0%")).toBeTruthy();
    expect(slot.queryByText("13.0%")).toBeNull();
    expect(slot.queryByText("14.0%")).toBeNull();
    await act(async () => { finish(data); });
    expect(slot.getByText("12.0%")).toBeTruthy();
  } finally { slot.lifecycle.unmount(); }
});

test("a fresh local calculation stays visible while its missing PR count loads", async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(repo.updatedAt));
  const isolated = await loadPluginApp(() => import("./app"));
  const partial = { ...data, repositories: [{ ...repo, pending: ["pullRequestsCreated"], pullRequestsCreated: { ...metric, value: null, detail: "Loading created PR count…" } }] };
  let finish!: (value: typeof data) => void;
  const metrics = vi.fn(() => new Promise<typeof data>((resolve) => { finish = resolve; }));
  const slot = renderSlot(isolated.navPanels[0], { subPath: "" }, { rpc: { snapshot: () => partial, metrics }, settings: {} });
  try {
    await act(async () => {});
    expect(slot.getByText("12.0%")).toBeTruthy();
    expect(slot.getByRole("status", { name: "Loading PRs created" }).getAttribute("aria-busy")).toBe("true");
    expect(metrics).toHaveBeenCalledTimes(1);
    await act(async () => { finish(data); });
    expect(slot.queryByRole("status", { name: "Loading PRs created" })).toBeNull();
  } finally { slot.lifecycle.unmount(); }
});

test("side-card details load only when expanded, reuse the response and allow retry", async () => {
  vi.resetModules();
  const isolated = await loadPluginApp(() => import("./app"));
  const result = { checkedAt: repo.updatedAt, items: [{ id: 1, title: "Tests · broken build", createdAt: repo.updatedAt, state: "failure", url: "https://github.com/acme/widgets/actions/runs/1", compareUrl: null }] };
  const cardDetails = vi.fn().mockRejectedValueOnce(new Error("private error")).mockResolvedValue(result);
  let refreshed = false;
  const slot = renderSlot(isolated.navPanels[0], { subPath: "" }, { rpc: { snapshot: () => null, metrics: () => refreshed ? { ...data, repositories: [{ ...repo, updatedAt: "2026-10-20T13:00:00Z" }] } : data, cardDetails }, settings: {} });
  try {
    const summary = await slot.findByText("Latest failed runs");
    const details = summary.closest("details")!;
    expect(cardDetails).not.toHaveBeenCalled();
    details.open = true;
    fireEvent(details, new Event("toggle"));
    await act(async () => {});
    expect(cardDetails).toHaveBeenLastCalledWith({ kind: "ci", repository: repo.repository, since: repo.range.since, until: repo.range.until });
    expect(slot.getByRole("alert").textContent).not.toContain("private error");
    fireEvent.click(slot.getByRole("button", { name: "Retry details" }));
    expect((await slot.findByRole("link", { name: "Tests · broken build" })).getAttribute("href")).toBe(result.items[0].url);
    details.open = false;
    fireEvent(details, new Event("toggle"));
    details.open = true;
    fireEvent(details, new Event("toggle"));
    await act(async () => {});
    expect(cardDetails).toHaveBeenCalledTimes(2);
    const compareUrl = "https://github.com/acme/widgets/compare/old...new";
    cardDetails.mockResolvedValue({ ...result, items: [{ ...result.items[0], title: "main · abc1234", state: "success", compareUrl }] });
    const production = slot.getByText("Recent production deployments").closest("details")!;
    production.open = true;
    fireEvent(production, new Event("toggle"));
    expect((await slot.findByRole("link", { name: "Changes since previous deployment" })).getAttribute("href")).toBe(compareUrl);
    expect(cardDetails).toHaveBeenLastCalledWith({ kind: "production", repository: repo.repository, environment: "production" });
    refreshed = true; fireEvent.click(slot.getByRole("button", { name: "Refresh" })); await act(async () => {});
    expect(slot.getByText("Latest failed runs").closest("details")).toBe(details);
    expect(slot.getByText("Recent production deployments").closest("details")).toBe(production);
    expect(cardDetails).toHaveBeenCalledTimes(3);
  } finally { slot.lifecycle.unmount(); }
});

test("today shows six four-hour bars, clips current details and disables future hours", async () => {
  const restore = mockNativeDialog();
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-20T10:17:38Z"));
  const isolated = await loadPluginApp(() => import("./app"));
  const range = resolveRange({ days: 1 });
  const todayMetric = { ...metric, series: Array.from({ length: 6 }, (_, index) => ({
    date: new Date(Date.parse(range.since) + (index + 1) * range.bucketMs).toISOString(), value: index + 1,
  })) };
  const today = { ...data, repositories: [{ ...repo, range, updatedAt: range.until, deployments: todayMetric, ci: todayMetric }] };
  const interval = vi.fn().mockResolvedValue({ ...today.repositories[0], range: { ...range, label: "selected interval" } });
  const slot = renderSlot(isolated.navPanels[0], { subPath: "" }, { rpc: { snapshot: () => null, metrics: () => today, interval }, settings: {} });
  try {
    await act(async () => {});
    fireEvent.change(slot.getByRole("combobox", { name: "Date range" }), { target: { value: "1" } });
    await act(async () => {});
    expect(slot.getByText("Today")).toBeTruthy();
    expect(slot.getByRole("region", { name: "Repository activity today" })).toBeTruthy();
    for (const title of ["Deployment throughput", "CI pass rate over time"]) {
      const bars = slot.getAllByRole("button", { name: new RegExp(`^${title} ·`) });
      expect(bars).toHaveLength(6);
      bars.forEach((bar, index) => {
        expect(bar.getAttribute("aria-label")).toContain(`${String(index * 4).padStart(2, "0")}:00`);
        expect(bar.hasAttribute("disabled")).toBe(index >= 3);
        if (index >= 3) expect(bar.textContent).toBe("—");
      });
    }
    fireEvent.click(slot.getByRole("button", { name: /Deployment throughput · 08:00/ }));
    await act(async () => {});
    expect(interval).toHaveBeenLastCalledWith({ repository: repo.repository, since: "2026-10-20T08:00:00.000Z", until: range.until });
    fireEvent.click(slot.getByRole("button", { name: "Close" }));
    fireEvent.click(slot.getByRole("button", { name: /CI pass rate over time · 00:00/ }));
    await act(async () => {});
    expect(interval).toHaveBeenLastCalledWith({ repository: repo.repository, since: range.since, until: "2026-10-20T03:59:59.999Z" });
  } finally { slot.lifecycle.unmount(); restore(); }
});

test("a fresh snapshot from yesterday refreshes after UTC midnight", async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-21T00:00:05Z"));
  const isolated = await loadPluginApp(() => import("./app"));
  const yesterday = { ...data, repositories: [{ ...repo, range: resolveRange({ days: 1 }, new Date("2026-10-20T23:59:59Z")), updatedAt: "2026-10-20T23:59:59Z" }] };
  const metrics = vi.fn().mockResolvedValue(data);
  const snapshot = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(yesterday);
  const slot = renderSlot(isolated.navPanels[0], { subPath: "" }, { rpc: { snapshot, metrics }, settings: { refreshSeconds: 300 } });
  try {
    await act(async () => {});
    fireEvent.change(slot.getByRole("combobox", { name: "Date range" }), { target: { value: "1" } });
    await act(async () => {});
    expect(metrics).toHaveBeenLastCalledWith({ days: 1 });
    expect(metrics).toHaveBeenCalledTimes(2);
  } finally { slot.lifecycle.unmount(); }
});

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
    expect(repositoryLink.querySelector('[data-icon="ExternalLink"][aria-hidden="true"]')).not.toBeNull();
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
  expect(app.navPanels[0]).toMatchObject({ title: "CI Dashboard", path: "dashboard", icon: "delivery-dashboard/pipeline" });
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
    expect(await slot.findByRole("region", { name: "CI health" })).toBeTruthy();
    expect(slot.getByText("Cancelled")).toBeTruthy();
    expect(slot.getByRole("link", { name: "View deployment" }).querySelector('[data-icon="ExternalLink"][aria-hidden="true"]')).not.toBeNull();
    expect(slot.getByText("Skipped")).toBeTruthy();
    expect(slot.getByText("3d 6h open")).toBeTruthy();
    expect(slot.getByRole("link", { name: "#17 Needs review" }).getAttribute("href")).toBe("https://github.com/acme/widgets/pull/17");
    expect(slot.getByRole("link", { name: "View deployment" }).getAttribute("href")).toBe("https://github.com/acme/widgets/actions/runs/1");
    expect(slot.getByText("Created 2h ago")).toBeTruthy();
    expect(slot.getByText("No reviews yet · excludes drafts · oldest 5")).toBeTruthy();
    const reviewLink = new URL(slot.getByRole("link", { name: "View review queue" }).getAttribute("href")!);
    expect(reviewLink.searchParams.get("q")).toBe("is:pr is:open draft:false review:none");
  } finally { slot.lifecycle.unmount(); }
});

test("empty review and production sections do not claim data is unavailable", async () => {
  const slot = renderSlot(app.navPanels[0], { subPath: "" }, {
    rpc: { snapshot: () => null, metrics: () => ({ ...data, repositories: [{ ...repo, ciOutcomes: {}, reviewQueue: { total: 0, items: [], error: null }, production: { deployment: null, error: null } }] }) }, settings: {},
  });
  try {
    expect(await slot.findByText("No production deployment found.")).toBeTruthy();
    expect(slot.getByText("No unreviewed PRs.")).toBeTruthy();
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
    const refreshButton = slot.getByRole("button", { name: "Refresh" });
    const refreshIcon = refreshButton.querySelector('svg[data-refresh-icon]');
    expect(refreshIcon).not.toBeNull();
    expect(refreshIcon?.classList.contains("animate-spin")).toBe(false);
    expect(refreshButton.textContent).toBe("");
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(metrics).toHaveBeenCalledTimes(2);
    expect(slot.getByRole("region", { name: "acme/widgets" })).toBe(originalCards);
    expect(slot.getByText("12.0 / day")).toBeTruthy();
    expect(slot.getByRole("button", { name: "Refresh" }).hasAttribute("disabled")).toBe(true);
    expect(slot.getByRole("button", { name: "Refresh" }).getAttribute("aria-busy")).toBe("true");
    expect(refreshButton.querySelector('svg[data-refresh-icon]')).toBe(refreshIcon);
    expect(refreshIcon?.classList.contains("animate-spin")).toBe(true);
    expect(refreshIcon?.classList.contains("motion-reduce:animate-none")).toBe(true);
    expect(slot.getByRole("button", { name: "Refresh" }).textContent?.trim()).toBe("");
    expect(slot.getByRole("region", { name: "GitHub CI metrics" }).getAttribute("aria-busy")).toBe("false");
    expect(slot.queryByText(/Loading|Refreshing/)).toBeNull();
    await act(async () => { finish(data); });
    expect(slot.getByRole("button", { name: "Refresh" }).getAttribute("aria-busy")).toBe("false");
    expect(refreshButton.querySelector('svg[data-refresh-icon]')).toBe(refreshIcon);
    expect(refreshIcon?.classList.contains("animate-spin")).toBe(false);
    expect(refreshButton.textContent).toBe("");
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
    expect(slot.queryByRole("region", { name: "Repository activity today" })).toBeNull();
    metrics.mockImplementation(() => new Promise(() => {}));
    fireEvent.change(slot.getByRole("combobox", { name: "Date range" }), { target: { value: "1" } });
    expect(slot.getByRole("region", { name: "Repository activity today" })).toBeTruthy();
    fireEvent.change(slot.getByRole("combobox", { name: "Date range" }), { target: { value: "3" } });
    expect(slot.getByRole("region", { name: "Repository activity in the last 3 days" })).toBeTruthy();
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
    expect(slot.getByLabelText("From date").getAttribute("min")).toBe(minimumDate());
    fireEvent.change(slot.getByLabelText("From date"), { target: { value: "2024-10-20" } });
    fireEvent.click(slot.getByRole("button", { name: "Apply dates" }));
    expect(slot.getByRole("alert").textContent).toContain("past year");
    expect(metrics).toHaveBeenCalledTimes(1);
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
    expect(loading.getAttribute("aria-busy")).toBe("true");
    expect(loading.querySelector(".animate-pulse[aria-hidden=true]")).not.toBeNull();
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
    const container = plot.closest("[data-ci-dashboard-viewport]")!;
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
    expect((await slot.findByRole("status", { name: "Loading GitHub metrics…" })).querySelector(".animate-pulse[aria-hidden=true]")).not.toBeNull();
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
  const deploymentData = { ...data, repositories: [{ ...repo, repository: "acme/widgets" }] };
  let finish!: (value: { url: string }) => void;
  const deployProduction = vi.fn(() => new Promise<{ url: string }>((resolve) => { finish = resolve; }));
  const slot = renderSlot(app.navPanels[0], { subPath: "" }, {
    rpc: { snapshot: () => null, metrics: () => deploymentData, deployProduction }, settings: { repository: "acme/widgets", productionRepository: "acme/widgets", productionWorkflow: "deploy.yaml", productionRef: "release" },
  });
  try {
    const deploy = await slot.findByRole("button", { name: "Deploy to production" });
    fireEvent.click(deploy);
    expect(slot.getByRole("group", { name: "Confirm production deployment" }).textContent).toContain("acme/widgets from release");
    expect(deployProduction).not.toHaveBeenCalled();
    fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
    expect(slot.queryByRole("group", { name: "Confirm production deployment" })).toBeNull();
    expect(deployProduction).not.toHaveBeenCalled();
    fireEvent.click(deploy);
    fireEvent.click(slot.getByRole("button", { name: "Start deployment" }));
    await act(async () => {});
    expect(slot.getByRole("button", { name: "Requesting…" }).hasAttribute("disabled")).toBe(true);
    expect(deployProduction).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ url: "https://github.com/acme/widgets/actions/runs/123" }); });
    expect(slot.getByText("Production workflow requested.")).toBeTruthy();
    expect(slot.getByRole("link", { name: "View workflow" }).getAttribute("href")).toContain("/actions/runs/123");
    expect(slot.queryByRole("button", { name: "Deploy to production" })).toBeNull();
  } finally { slot.lifecycle.unmount(); }
});

test("the deploy action stays hidden until a repository and workflow are configured for this repository", async () => {
  for (const settings of [{ repository: "acme/widgets" }, { repository: "acme/widgets", productionRepository: "acme/widgets" }, { repository: "acme/widgets", productionRepository: "acme/other", productionWorkflow: "deploy.yaml" }] as Record<string, string>[]) {
    const slot = renderSlot(app.navPanels[0], { subPath: "" }, { rpc: { snapshot: () => null, metrics: () => ({ ...data, repositories: [{ ...repo, repository: "acme/widgets" }] }), deployProduction: vi.fn() }, settings });
    try {
      await slot.findByText("Latest production deployment");
      expect(slot.queryByRole("button", { name: "Deploy to production" })).toBeNull();
    } finally { slot.lifecycle.unmount(); }
  }
});

test("unconfirmed production requests explain how to check status without exposing error content", async () => {
  const slot = renderSlot(app.navPanels[0], { subPath: "" }, {
    rpc: { snapshot: () => null, metrics: () => ({ ...data, repositories: [{ ...repo, repository: "acme/widgets" }] }), deployProduction: () => { throw new Error("private-token"); } },
    settings: { repository: "acme/widgets", productionRepository: "acme/widgets", productionWorkflow: "deploy.yaml" },
  });
  try {
    fireEvent.click(await slot.findByRole("button", { name: "Deploy to production" }));
    fireEvent.click(slot.getByRole("button", { name: "Start deployment" }));
    const alert = await slot.findByRole("alert");
    expect(alert.textContent).toContain("Check the production workflow");
    expect(alert.textContent).not.toContain("private-token");
    expect(slot.getByRole("button", { name: "Start deployment" }).hasAttribute("disabled")).toBe(false);
  } finally { slot.lifecycle.unmount(); }
});

test("an older persisted snapshot cannot restore a removed CI limit error over fresh cached history", async () => {
  vi.resetModules();
  const isolated = await loadPluginApp(() => import("./app"));
  const legacyMessage = "CI history and outcome breakdown are unavailable above 1,000 runs in the selected range.";
  const legacy = { ...data, repositories: [{ ...repo, updatedAt: "2026-10-19T12:00:00Z", ci: { ...metric, series: null, seriesError: legacyMessage }, ciOutcomes: null }] };
  let finish!: (value: typeof data) => void;
  const metrics = vi.fn().mockResolvedValueOnce(data).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const options = { rpc: { snapshot: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(legacy), metrics }, settings: { repository: "acme/widgets" } };
  const first = renderSlot(isolated.navPanels[0], { subPath: "" }, options);
  await first.findByText("12.0 / day");
  first.lifecycle.unmount();
  const reopened = renderSlot(isolated.navPanels[0], { subPath: "" }, options);
  try {
    await act(async () => {});
    expect(reopened.queryAllByText(legacyMessage)).toHaveLength(0);
    expect(reopened.getByRole("group", { name: /CI pass rate over time:.*Oct 14/ })).toBeTruthy();
    await act(async () => { finish(data); });
  } finally { reopened.lifecycle.unmount(); }
});

test("switching back to a loaded range renders immediately without a snapshot RPC", async () => {
  vi.resetModules();
  const isolated = await loadPluginApp(() => import("./app"));
  const month = { ...data, repositories: [{ ...repo, range: resolveRange({ days: 30 }), ci: { ...metric, value: 75 } }] };
  const metrics = vi.fn().mockResolvedValueOnce(data).mockResolvedValueOnce(month).mockImplementation(() => new Promise(() => {}));
  const snapshot = vi.fn(() => null);
  const slot = renderSlot(isolated.navPanels[0], { subPath: "" }, { rpc: { snapshot, metrics }, settings: {} });
  try {
    await slot.findByRole("region", { name: "Repository activity in the last 7 days" });
    fireEvent.change(slot.getByRole("combobox", { name: "Date range" }), { target: { value: "30" } });
    await slot.findByRole("region", { name: "Repository activity in the last 30 days" });
    expect(snapshot).toHaveBeenCalledTimes(2);
    fireEvent.change(slot.getByRole("combobox", { name: "Date range" }), { target: { value: "7" } });
    expect(slot.getByRole("region", { name: "Repository activity in the last 7 days" })).toBeTruthy();
    expect(slot.getByText("12.0%")).toBeTruthy();
    await act(async () => {});
    fireEvent.change(slot.getByRole("combobox", { name: "Date range" }), { target: { value: "30" } });
    expect(slot.getByRole("region", { name: "Repository activity in the last 30 days" })).toBeTruthy();
    expect(slot.getByText("75.0%")).toBeTruthy();
    await act(async () => {});
    expect(snapshot).toHaveBeenCalledTimes(2);
  } finally { slot.lifecycle.unmount(); }
});

test("fresh range snapshots skip GitHub collection until expiry while Refresh forces collection", async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
  const isolated = await loadPluginApp(() => import("./app"));
  const fresh = { ...data, repositories: [{ ...repo, updatedAt: new Date().toISOString() }] };
  const month = { ...fresh, repositories: [{ ...fresh.repositories[0], range: resolveRange({ days: 30 }), ci: { ...metric, value: 75 } }] };
  const metrics = vi.fn(async () => fresh);
  const snapshot = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(month);
  const slot = renderSlot(isolated.navPanels[0], { subPath: "" }, { rpc: { snapshot, metrics }, settings: { refreshSeconds: 30 } });
  try {
    await act(async () => {});
    expect(metrics).toHaveBeenCalledTimes(1);
    fireEvent.change(slot.getByRole("combobox", { name: "Date range" }), { target: { value: "30" } });
    await act(async () => {});
    expect(slot.getByText("75.0%")).toBeTruthy();
    expect(metrics).toHaveBeenCalledTimes(1);
    fireEvent.change(slot.getByRole("combobox", { name: "Date range" }), { target: { value: "7" } });
    expect(slot.getByText("12.0%")).toBeTruthy();
    await act(async () => {});
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(metrics).toHaveBeenCalledTimes(1);
    fireEvent.click(slot.getByRole("button", { name: "Refresh" }));
    await act(async () => {});
    expect(metrics).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(metrics).toHaveBeenCalledTimes(3);
  } finally { slot.lifecycle.unmount(); }
});


test("draft settings start collapsed, keep native inputs and clean up on navigation and unload", async () => {
  const host = document.createElement("div");
  function fields() {
    const form = document.createElement("div");
    for (const label of Object.values(draftSettingLabels)) {
      const row = document.createElement("div"), inner = document.createElement("div"), input = document.createElement("input");
      input.setAttribute("aria-label", label); inner.append(input); row.append(inner); form.append(row);
    }
    return form;
  }
  let form = fields(); host.append(form); document.body.append(host);
  const controller = new AbortController();
  const dispose = mountDraftSettingsDisclosure(controller.signal);
  try {
    const input = form.querySelector("input")!;
    const changed = vi.fn(); input.addEventListener("input", changed);
    let button = form.querySelector("button")!;
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(input.parentElement?.parentElement?.style.display).toBe("none");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(input.parentElement?.parentElement?.style.display).toBe("");
    fireEvent.input(input, { target: { value: "Renamed step" } });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(form.querySelector("input")).toBe(input);
    fireEvent.click(button);
    expect(input.parentElement?.parentElement?.style.display).toBe("none");
    const replacement = fields(); form.replaceWith(replacement); form = replacement;
    await act(async () => {});
    expect(host.querySelectorAll("button")).toHaveLength(1);
    button = form.querySelector("button")!;
    expect(button.getAttribute("aria-expanded")).toBe("false");
    controller.abort();
    expect(form.querySelector("button")).toBeNull();
    expect(form.querySelector("input")?.parentElement?.parentElement?.style.display).toBe("");
    expect(form.querySelector("input")?.parentElement?.parentElement?.style.borderInlineStart).toBe("");
  } finally { dispose(); host.remove(); }
});

// --- CI health card: problems with Investigate/Dismiss, everything else in one "Details" ---
const ago = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString();
const problem = (id: string, severity: "critical" | "warning", minutes: number, extra: Record<string, unknown> = {}) =>
  ({ id, severity, title: `Title ${id}`, what: `What ${id}.`, impact: "", where: { url: `https://github.com/acme/widgets/actions/runs/${id.length}` }, since: ago(minutes), handled: null, ...extra });
const jobSignal = (id: string, kind: string, severity: string, minutes: number, where: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ id, kind, severity, title: `server ${id}`, what: `what ${id}`, impact: "", where, since: ago(minutes), until: null, actor: "owner_sre", open: true, ...extra });
const jobRepo = (extra: Record<string, unknown> = {}) => ({
  repository: "acme/widgets", updatedAt: ago(1), error: null, projectId: "proj-1", live: { pools: [
    { pool: "idle-pool", queued: 0, inProgress: 0, oldestQueuedAt: null, lastStartedAt: null, queuedRunIds: [] },
    { pool: "self-hosted", queued: 0, inProgress: 12, oldestQueuedAt: null, lastStartedAt: null, queuedRunIds: [] },
    { pool: "stuck-pool", queued: 3, inProgress: 0, oldestQueuedAt: ago(30), lastStartedAt: null, queuedRunIds: [1] }], truncated: false, polledAt: null },
  problems: [
    problem("pool_stall:stuck-pool", "critical", 5, { title: "Runner pool stalled: stuck-pool", what: "3 jobs wait for a runner." }),
    problem("runner_loss:90", "warning", 12.5, { title: "Runner lost on main: Integration tests", what: "The runner stopped mid-job.", where: { url: "https://github.com/acme/widgets/actions/runs/9/job/90" } }),
  ],
  signals: [
    jobSignal("runner_loss:90", "runner_loss", "warning", 12.5, { jobName: "Integration tests", branch: "main", url: "https://github.com/acme/widgets/actions/runs/9/job/90" }),
    jobSignal("pool_stall:stuck-pool", "pool_stall", "critical", 5, { pool: "stuck-pool" }),
    jobSignal("flake:1", "flake", "info", 30, { jobName: "Unit tests" }),
    jobSignal("old", "runner_loss", "warning", 120, { jobName: "Lint", branch: "main" }, { open: false, until: ago(60) }),
  ],
  window: { since: "2026-10-16T12:00:00.000Z", until: "2026-10-30T12:00:00.000Z" },
  failureCounts: { runner_loss: 2, flake: 1, transient: 3, real: 4, timeout: 1, superseded: 5, manual_cancel: 6, collateral_cancel: 7, consequence: 8, unknown: 0 },
  runnerLosses: { byPool: { "self-hosted": { count: 2, runnerMs: 51 * 60000 } }, byJob: { "Integration tests": { count: 2, runnerMs: 51 * 60000 } }, byDay: {} },
  massCancels: [{ since: "2026-10-19T12:00:00.000Z", until: "2026-10-19T12:01:00.000Z", runners: ["r1", "r2", "r3"], runIds: [1, 2], jobs: 3 }],
  failures: [], reruns: [{ runId: 7, workflowName: "CI", headSha: "a", headBranch: "feature", attempts: 2, outcomes: ["failure", "success"], finalConclusion: "success", repeatedRunnerMs: 4 * 60000, url: "https://github.com/acme/widgets/actions/runs/7" }],
  backfill: { remaining: 0, failed: 0, pausedUntil: null, coveredSince: "2026-10-16T12:00:00.000Z" },
  ...extra,
});
const actors = { owner_sre: "Runner owner / SRE", pr_author: "Author", lead: "Lead", manager: "Manager" };
const failingMain = () => summarizeCi([1, 2, 3].map((id) => ({ id, workflow_id: 42, name: "Unit tests", head_branch: "main", event: "push", conclusion: "failure",
  created_at: `2026-10-20T0${id}:00:00Z`, run_started_at: `2026-10-20T0${id}:00:00Z`, updated_at: `2026-10-20T0${id}:02:00Z` })), "main");
type Extra = { rpc?: Record<string, unknown>; sdk?: Record<string, unknown> };
const healthSlot = (signals: (input: unknown) => unknown, ciInsights: unknown = failingMain(), panels = app.navPanels, extra: Extra = {}) => renderSlot(panels[0], { subPath: "" }, {
  rpc: { snapshot: () => null, signals, metrics: () => ({ ...data, repositories: [{ ...repo, ciInsights, ciOutcomes: { success: 2, failure: 3 } }] }), ...extra.rpc }, settings: {},
  sdk: { ...extra.sdk, threads: { get: async () => ({ title: null }), ...(extra.sdk?.threads as object) } } as never });
// The panel module remembers the last signals answer per repository, so tests that assert a first render start from a fresh module.
const freshPanels = async () => { vi.resetModules(); return (await loadPluginApp(() => import("./app"))).navPanels; };
const withProblems = (problems: unknown[], extra: Record<string, unknown> = {}) => () => ({ repositories: [jobRepo({ problems, ...extra })], actors });
const problemRows = (card: HTMLElement) => Array.from(within(card).getByRole("list", { name: "Problems" }).querySelectorAll<HTMLElement>(":scope > li"));
const threads = [{ id: "thr_a", title: "Fix flaky tests", status: "idle", deletedAt: null, archivedAt: null, visibility: "visible" }, { id: "thr_b", title: "Runner migration", status: "running", deletedAt: null, archivedAt: null, visibility: "visible" }];

test("the header says All good, or counts the problems that need attention and turns red when one is critical", async () => {
  vi.resetModules();
  const states: [unknown[], string, boolean][] = [[[], "All good", false], [[problem("a", "warning", 5)], "1 problem needs attention", false],
    [[problem("a", "warning", 5), problem("b", "critical", 6), problem("c", "critical", 7, { handled: { state: "dismissed", at: ago(1) } })], "2 problems need attention", true]];
  for (const [problems, text, critical] of states) {
    const slot = healthSlot(withProblems(problems), failingMain(), (await loadPluginApp(() => import("./app"))).navPanels);
    try {
      const card = await slot.findByRole("region", { name: "CI health" });
      const header = await within(card).findByText(text);
      expect(header.className).toContain(critical ? "text-destructive" : text === "All good" ? "text-muted-foreground" : "font-medium");
      expect(header.className.includes("text-destructive")).toBe(critical);
    } finally { slot.lifecycle.unmount(); }
  }
});

test("unhandled problems are listed with severity, plain title, age and one sentence, at most five until Show all; investigating ones sit under Handled", async () => {
  const problems = [problem("investigating", "critical", 1, { handled: { state: "investigating", threadId: "thr_a", at: ago(1) } }),
    ...["p1", "p2", "p3", "p4", "p5", "p6"].map((id, index) => problem(id, index === 0 ? "critical" : "warning", 10 + index))];
  const slot = healthSlot(withProblems(problems), failingMain(), app.navPanels, { sdk: { threads: { get: async () => ({ title: "Fix flaky tests" }) } } });
  try {
    const card = await slot.findByRole("region", { name: "CI health" });
    await within(card).findByText("6 problems need attention");
    expect(problemRows(card).map((row) => row.querySelector("a")?.textContent)).toEqual(["Title p1", "Title p2", "Title p3", "Title p4", "Title p5"]);
    const first = problemRows(card)[0];
    expect(first.querySelector("p")?.textContent).toMatch(/^Critical Title p1 · 10 min ago$/);
    expect(first.querySelectorAll("p")[1].textContent).toBe("What p1.");
    expect(first.querySelector("a")?.getAttribute("href")).toBe("https://github.com/acme/widgets/actions/runs/2");
    expect(problemRows(card)[1].querySelector("p")?.textContent).toMatch(/^Warning Title p2/);
    fireEvent.click(within(card).getByRole("button", { name: "Show all 6" }));
    expect(problemRows(card).map((row) => row.querySelector("a")?.textContent)).toEqual(["Title p1", "Title p2", "Title p3", "Title p4", "Title p5", "Title p6"]);
    const handled = within(card).getByText("Handled · 1").closest("details")!;
    expect(handled.open).toBe(false);
    expect(within(handled).getByRole("list", { name: "Handled problems" }).textContent).toContain("Title investigating");
    expect(within(card).getByRole("button", { name: "Show fewer" }).getAttribute("aria-expanded")).toBe("true");
  } finally { slot.lifecycle.unmount(); }
});

test("Investigate opens a menu: New session starts a session through the RPC and refreshes the list", async () => {
  const investigate = vi.fn(async () => ({ threadId: "thr_new" }));
  const signals = vi.fn(withProblems([problem("a", "critical", 5)]));
  const slot = healthSlot(signals, failingMain(), app.navPanels, { rpc: { investigate } });
  try {
    const card = await slot.findByRole("region", { name: "CI health" });
    const trigger = await within(card).findByRole("button", { name: "Investigate: Title a" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    const menu = within(card).getByRole("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["New session", "Existing session…"]);
    expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "New session" }));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "Existing session…" }));
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(within(card).queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    const calls = signals.mock.calls.length;
    fireEvent.click(within(card).getByRole("menuitem", { name: "New session" }));
    await vi.waitFor(() => expect(investigate).toHaveBeenCalledWith({ repository: "acme/widgets", id: "a" }));
    await vi.waitFor(() => expect(signals.mock.calls.length).toBeGreaterThan(calls));
    expect(within(card).queryByRole("menu")).toBeNull();
  } finally { slot.lifecycle.unmount(); }
});

test("without a linked BB project New session is disabled with a hint, and a failed action is reported", async () => {
  const investigate = vi.fn(async () => { throw new Error("The session could not be started."); });
  const slot = healthSlot(withProblems([problem("a", "critical", 5)], { projectId: null }), failingMain(), app.navPanels, { rpc: { investigate } });
  try {
    const card = await slot.findByRole("region", { name: "CI health" });
    fireEvent.click(await within(card).findByRole("button", { name: "Investigate: Title a" }));
    const item = within(card).getByRole("menuitem", { name: "New session" }) as HTMLButtonElement;
    expect(item.disabled).toBe(true);
    expect(document.getElementById(item.getAttribute("aria-describedby")!)?.textContent).toBe("No BB project is linked to this repository.");
    expect(within(card).getByRole("menuitem", { name: "Existing session…" })).toBeTruthy();
    expect(investigate).not.toHaveBeenCalled();
  } finally { slot.lifecycle.unmount(); }
  const linked = healthSlot(withProblems([problem("a", "critical", 5)]), failingMain(), app.navPanels, { rpc: { investigate } });
  try {
    const card = await linked.findByRole("region", { name: "CI health" });
    fireEvent.click(await within(card).findByRole("button", { name: "Investigate: Title a" }));
    fireEvent.click(within(card).getByRole("menuitem", { name: "New session" }));
    expect((await within(card).findByRole("alert")).textContent).toBe("The session could not be started.");
  } finally { linked.lifecycle.unmount(); }
});

test("Existing session… opens a picker of the project's sessions and sends the problem to the chosen one", async () => {
  const restoreDialog = mockNativeDialog();
  const investigate = vi.fn(async () => ({ threadId: "thr_b" }));
  const list = vi.fn(async () => threads);
  const signals = vi.fn(withProblems([problem("a", "critical", 5)]));
  const slot = healthSlot(signals, failingMain(), app.navPanels, { rpc: { investigate }, sdk: { threads: { list } } });
  try {
    const card = await slot.findByRole("region", { name: "CI health" });
    const trigger = await within(card).findByRole("button", { name: "Investigate: Title a" });
    fireEvent.click(trigger);
    fireEvent.click(within(card).getByRole("menuitem", { name: "Existing session…" }));
    const dialog = await slot.findByRole("dialog", { name: "Send to existing session" });
    expect(list).toHaveBeenCalledWith({ archived: false, limit: 50, offset: 0, projectId: "proj-1" });
    expect(within(dialog).getByText(/“Title a” is sent/)).toBeTruthy();
    expect(await within(dialog).findAllByRole("button", { name: /Fix flaky tests|Runner migration/ })).toHaveLength(2);
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Filter sessions" }), { target: { value: "migration" } });
    expect(within(dialog).queryByRole("button", { name: /Fix flaky tests/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: /Runner migration/ }));
    await vi.waitFor(() => expect(investigate).toHaveBeenCalledWith({ repository: "acme/widgets", id: "a", threadId: "thr_b" }));
    await vi.waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
  } finally { slot.lifecycle.unmount(); restoreDialog(); }
});

test("a picker error stays in the dialog, and closing it returns focus to Investigate", async () => {
  const restoreDialog = mockNativeDialog();
  const investigate = vi.fn(async () => { throw new Error("Thread is archived."); });
  const slot = healthSlot(withProblems([problem("a", "critical", 5)], { projectId: null }), failingMain(), app.navPanels, { rpc: { investigate }, sdk: { threads: { list: vi.fn(async () => threads) } } });
  try {
    const card = await slot.findByRole("region", { name: "CI health" });
    const trigger = await within(card).findByRole("button", { name: "Investigate: Title a" });
    fireEvent.click(trigger);
    fireEvent.click(within(card).getByRole("menuitem", { name: "Existing session…" }));
    const dialog = await slot.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: /Fix flaky tests/ }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("Thread is archived.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(slot.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  } finally { slot.lifecycle.unmount(); restoreDialog(); }
});

test("an investigating problem shows the session title as a link instead of the buttons", async () => {
  const handled = { state: "investigating", threadId: "thr_a", at: ago(1) };
  const slot = healthSlot(withProblems([problem("a", "critical", 5, { handled }), problem("b", "warning", 6)]), failingMain(), app.navPanels, { sdk: { threads: { get: vi.fn(async () => ({ title: "Fix flaky tests" })) } } });
  try {
    const card = await slot.findByRole("region", { name: "CI health" });
    const link = await within(card).findByRole("button", { name: "Fix flaky tests" });
    expect(link.closest("li")?.textContent).toContain("Investigating in Fix flaky tests");
    expect(within(link.closest("li") as HTMLElement).queryByRole("button", { name: /Investigate:|Dismiss:/ })).toBeNull();
    expect(within(problemRows(card)[0]).getByRole("button", { name: "Dismiss: Title b" })).toBeTruthy();
    expect(within(card).getByText("1 problem needs attention")).toBeTruthy();
    fireEvent.click(link);
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "thr_a" });
  } finally { slot.lifecycle.unmount(); }
});

test("Dismiss moves a problem under a collapsed Dismissed section where Restore brings it back", async () => {
  vi.resetModules();
  let dismissed = false;
  const problemAction = vi.fn(async (input: { action: string }) => { dismissed = input.action === "dismiss"; return { handled: null }; });
  const signals = () => ({ repositories: [jobRepo({ problems: [problem("a", "critical", 5, dismissed ? { handled: { state: "dismissed", at: ago(0) } } : {})] })], actors });
  const slot = healthSlot(signals, failingMain(), (await loadPluginApp(() => import("./app"))).navPanels, { rpc: { problemAction } });
  try {
    const card = await slot.findByRole("region", { name: "CI health" });
    fireEvent.click(await within(card).findByRole("button", { name: "Dismiss: Title a" }));
    await vi.waitFor(() => expect(problemAction).toHaveBeenCalledWith({ repository: "acme/widgets", id: "a", action: "dismiss" }));
    await within(card).findByText("All good");
    expect(within(card).queryByRole("list", { name: "Problems" })).toBeNull();
    const section = within(card).getByText("Handled · 1").closest("details")!;
    expect(section.open).toBe(false);
    fireEvent.click(within(section).getByRole("button", { name: "Restore: Title a" }));
    await vi.waitFor(() => expect(problemAction).toHaveBeenLastCalledWith({ repository: "acme/widgets", id: "a", action: "restore" }));
    await within(card).findByText("1 problem needs attention");
    expect(within(card).queryByText(/Handled ·/)).toBeNull();
  } finally { slot.lifecycle.unmount(); }
});

test("Details keeps only the overview open; every other section is a closed <details> with its count and hint", async () => {
  const slot = healthSlot(() => ({ repositories: [jobRepo()], actors }), failingMain(), await freshPanels());
  try {
    const card = await slot.findByRole("region", { name: "CI health" });
    const causes = await within(card).findByRole("region", { name: "Failure causes" });
    const details = Array.from(card.querySelectorAll(":scope > details"));
    expect(details).toHaveLength(1);
    const [all] = details as HTMLDetailsElement[];
    expect(all.open).toBe(false);
    expect(all.querySelector(":scope > summary")?.textContent).toBe("Details");
    expect(all.contains(within(card).getByRole("region", { name: "CI problems" }))).toBe(false);
    expect(all.contains(within(card).getByText("Passed"))).toBe(true);
    expect(Array.from(all.querySelectorAll("h5")).map((heading) => heading.textContent)).toEqual(["Outcomes", "Failure causes"]);
    const names = ["Pass rates", "Top failing workflows", "Runner pools", "Runner losses", "Reruns", "Lower-priority events", "Resolved incidents", "Mass runner losses"];
    const sections = names.map((name) => { const section = within(card).getByRole("region", { name }); expect(all.contains(section)).toBe(true); return section; });
    // Each nested section is a closed <details> with a real <summary>; "Latest failed runs" is the last, lazy one.
    expect(sections.map((section) => (section.querySelector("details") as HTMLDetailsElement).open)).toEqual(names.map(() => false));
    expect(Array.from(all.querySelectorAll("summary")).map((summary) => summary.textContent)).toEqual([
      "Details", "Pass rates — main 0% · PRs —", "Top failing workflows · 1 — worst: Unit tests", "Runner pools · 3 — 1 stalled", "Runner losses · 2 — mostly Integration tests",
      "Reruns · 1 — all passed after rerun", "Lower-priority events · 1", "Resolved incidents · 1", "Mass runner losses · 1", "Latest failed runs"]);
    expect(card.textContent).not.toContain("Needs attention");
    const text = (name: string) => within(card).getByRole("region", { name }).textContent;
    const values: Record<string, Element | null> = Object.fromEntries(Array.from(causes.querySelectorAll("dl > div")).map((row) => [row.querySelector("dt")?.textContent, row.querySelector("dd")]));
    expect(Object.entries(values).map(([key, dd]) => [key, dd?.textContent])).toEqual([["Runner losses", "2"], ["Flaky jobs", "1"], ["Network/tool errors", "3"], ["Real failures", "4"]]);
    expect(values["Runner losses"]?.className).toContain("text-destructive");
    expect(causes.textContent).toContain("Excluded: 5 superseded by newer runs, 6 cancelled manually, 7 cancelled with the run, 8 aggregator jobs, 1 timed out");
    expect(causes.textContent).not.toContain("recognizable cause");
    expect(causes.textContent).toContain("Job-level causes are kept for the last 14 days");
    expect(text("Runner pools")).toContain("stuck-pool · 0 running · 3 waiting");
    expect(text("Runner pools")!.indexOf("stuck-pool")).toBeLessThan(text("Runner pools")!.indexOf("self-hosted"));
    expect(text("Runner pools")).toContain("self-hosted · 12 running · 0 waiting");
    expect(text("Runner pools")).toContain("Idle: idle-pool");
    expect(within(card).getByText(/stuck-pool · 0 running/).className).toContain("text-destructive");
    expect(text("Runner losses")).toContain("By pool");
    expect(text("Runner losses")).toContain("Integration tests — 2 losses · 51 min runner time");
    expect(text("Reruns")).toContain("CI #7 (feature) failed → passed · 4 min repeated");
    expect(within(card).getByRole("link", { name: "CI #7" })).toBeTruthy();
    expect(text("Lower-priority events")).toContain("Flaky jobs — 1 open");
    expect(text("Resolved incidents")).toMatch(/Runner lost on main: Lint — resolved (59 min|1 h) ago/);
    expect(text("Resolved incidents")).not.toContain("what old");
    expect(text("Top failing workflows")).toContain("Unit tests — 3 failed · 0% passed");
    const mass = within(card).getByRole("region", { name: "Mass runner losses" });
    expect(mass.textContent).toMatch(/Oct 19, \d\d:\d\d–\d\d:\d\d · 3 runners · 2 runs/);
    expect(mass.textContent).not.toContain("r1");
    expect(mass.querySelector("p")?.getAttribute("title")).toBe("Runners: r1, r2, r3");
  } finally { slot.lifecycle.unmount(); }
});

test("Excluded lists only non-zero items and disappears when all are zero", async () => {
  const some = jobRepo({ failureCounts: { superseded: 1200, refused: 3, timeout: 2 } });
  const none = jobRepo({ failureCounts: { real: 1 } });
  for (const [repository, expected] of [[some, "Excluded: 1,200 superseded by newer runs, 3 refused by design, 2 timed out"], [none, null]] as const) {
    const slot = healthSlot(() => ({ repositories: [repository], actors }), failingMain(), await freshPanels());
    try {
      const causes = await within(await slot.findByRole("region", { name: "CI health" })).findByRole("region", { name: "Failure causes" });
      if (expected) expect(causes.textContent).toContain(expected); else expect(causes.textContent).not.toContain("Excluded");
      if (expected) expect(causes.textContent).not.toContain("cancelled");
    } finally { slot.lifecycle.unmount(); }
  }
});

test("duration and time helpers", () => {
  expect([0, 45000, 32 * 60000, 65 * 60000, 120 * 60000].map(duration)).toEqual(["0 s", "45 s", "32 min", "1 h 5 min", "2 h"]);
  const now = new Date(2026, 10, 5, 12, 0).getTime();
  expect([new Date(2026, 10, 5, 8, 5), new Date(2026, 10, 4, 18, 16), new Date(2026, 10, 3, 14, 5)].map((date) => when(date.toISOString(), now)))
    .toEqual(["today 08:05", "yesterday 18:16", "Nov 3, 14:05"]);
});

test("empty secondary blocks are not rendered and the zero causes stay in plain style", async () => {
  const empty = jobRepo({ live: { pools: [], truncated: false, polledAt: null }, signals: [], problems: [], runnerLosses: { byPool: {}, byJob: {}, byDay: {} }, massCancels: [], reruns: [], failureCounts: {},
    window: { since: "2026-10-01T00:00:00.000Z", until: "2026-10-15T00:00:00.000Z" } });
  const slot = healthSlot(() => ({ repositories: [empty], actors }), { ...failingMain(), alerts: [] }, await freshPanels());
  try {
    const card = await slot.findByRole("region", { name: "CI health" });
    const causes = await within(card).findByRole("region", { name: "Failure causes" });
    expect(Array.from(causes.querySelectorAll("dd")).map((dd) => dd.textContent)).toEqual(["0", "0", "0", "0"]);
    expect(causes.querySelector("dd")?.className).not.toContain("text-destructive");
    expect(Array.from(card.querySelectorAll("section[aria-label]")).map((section) => section.getAttribute("aria-label"))).toEqual(["CI problems", "Outcomes", "Failure causes", "Pass rates", "Top failing workflows"]);
    expect(causes.textContent).not.toContain("Job-level causes");
    expect(within(card).getByText("All good")).toBeTruthy();
  } finally { slot.lifecycle.unmount(); }
});

test("CI health explains a range older than the job history and the running backfill", async () => {
  const loading = jobRepo({ backfill: { remaining: 4640, failed: 0, pausedUntil: null, coveredSince: "2026-10-18T00:00:00.000Z" } });
  const slot = healthSlot(() => ({ repositories: [loading], actors }), failingMain(), await freshPanels());
  try {
    await vi.waitFor(() => expect(slot.getByRole("region", { name: "Failure causes" }).textContent).toContain("Loading job history: 4,640 attempts left"));
    expect(slot.getByRole("region", { name: "Failure causes" }).textContent).toMatch(/Job-level causes cover .* onward — history is still loading/);
  } finally { slot.lifecycle.unmount(); }
});

test("a failing signals request keeps the run-level card and offers one retry", async () => {
  vi.resetModules(); // fresh module: no cached job-level answer from an earlier test
  const signals = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ repositories: [jobRepo()], actors });
  const slot = healthSlot(signals, failingMain(), (await loadPluginApp(() => import("./app"))).navPanels);
  try {
    const card = await slot.findByRole("region", { name: "CI health" });
    const retry = await within(card).findByRole("button", { name: "Retry" });
    expect(within(card).getAllByRole("alert")).toHaveLength(1);
    expect(within(card).getByText("Passed")).toBeTruthy();
    expect(within(card).queryByRole("region", { name: "Failure causes" })).toBeNull();
    fireEvent.click(retry);
    expect(await within(card).findByRole("region", { name: "Failure causes" })).toBeTruthy();
    expect(within(card).queryByRole("alert")).toBeNull();
    expect(within(card).getByText("2 problems need attention")).toBeTruthy();
  } finally { slot.lifecycle.unmount(); }
});

test("with no open problems the outcomes overview sits in the card; with problems it moves into Details", async () => {
  for (const [problems, inside] of [[[], false], [[problem("a", "warning", 5)], true]] as const) {
    const slot = healthSlot(withProblems([...problems]));
    try {
      const card = await slot.findByRole("region", { name: "CI health" });
      const outcomes = await within(card).findByRole("region", { name: "Outcomes" });
      expect(!!outcomes.closest("details")).toBe(inside);
    } finally { slot.lifecycle.unmount(); }
  }
});
