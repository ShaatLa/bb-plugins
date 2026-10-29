import { mountDraftSettingsDisclosure } from "./settings-disclosure";
import { draftSettingLabels } from "./draft-deferrals";
// @vitest-environment jsdom
import { act, fireEvent, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { Metrics } from "./metrics";
import { summarizeCi } from "./ci-insights";
import { minimumDate, resolveRange } from "./date-range";
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
    expect(attention.textContent).toContain("3 consecutive failures");
    expect(slot.getByRole("link", { name: "Unit tests · main: latest run failed" }).getAttribute("href")).toBe("https://github.com/acme/widgets/actions/runs/3");
    expect(slot.getByText("3 failed · 25.0% passed · 4 counted runs")).toBeTruthy();
    const timings = slot.getByRole("region", { name: "CI run timings" });
    const order = [timings, attention, slot.getByRole("heading", { name: "CI pass rate over time" }),
      slot.getByRole("region", { name: "Repository activity in the last 7 days" }), slot.getByRole("region", { name: "PRs awaiting review" })];
    for (let index = 1; index < order.length; index++) expect(order[index - 1].compareDocumentPosition(order[index]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(attention.contains(slot.getByRole("region", { name: "CI signals" }))).toBe(true);
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
    id: index + 1, workflow_id: index < 3 ? 2 : 1, name: index < 3 ? "PR metadata" : "CI",
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
  const slot = renderSlot(isolated.navPanels[0], { subPath: "" }, { rpc: { snapshot: () => null, metrics: () => data, cardDetails }, settings: {} });
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
    expect(slot.getByRole("link", { name: "View workflow" }).getAttribute("href")).toContain("/actions/runs/123");
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
  } finally { dispose(); host.remove(); }
});
