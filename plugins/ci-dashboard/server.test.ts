import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createFakePluginHost, experimental_scanPublicSdkOnly, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { compress } from "./cache-cleanup";
import { ciReportSchema } from "./agent-ci";
import { loadMetrics, type HistoricalRecords, type Metrics } from "./metrics";
import { resolveGithubToken } from "./auth";
import { githubRepository, repositoriesSettingSchema } from "./repositories";
import { resolveRange } from "./date-range";
import { createJobStore } from "./ci-jobs";
import { zip } from "./test-support";

vi.mock("./auth", () => ({ resolveGithubToken: vi.fn() }));

const recent = "2026-10-19T12:00:00Z";
let fetchMock = vi.fn<(input: string, options?: RequestInit) => Promise<Response>>();
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
  fetchMock = vi.fn(async (input: string, options?: RequestInit) => {
    const url = new URL(input);
    if (url.pathname === "/graphql") return Response.json({ data: { repository: { defaultBranchRef: { name: "main", target: {
      oid: "head", history: { totalCount: 2, nodes: [
        { oid: "head", additions: 100, deletions: 10, committedDate: recent },
        { oid: "previous", additions: 20, deletions: 5, committedDate: recent },
      ], pageInfo: { hasNextPage: false, endCursor: null } },
    } } } } });
    if (url.pathname === "/search/issues" && url.searchParams.get("q")?.includes("created:")) return Response.json({ total_count: 9, incomplete_results: false });
    if (url.pathname.includes("/statuses")) return Response.json([{ state: "success", created_at: recent, log_url: "https://github.com/acme/widgets/actions/runs/1" }]);
    if (url.pathname.endsWith("/deployments")) return Response.json([{ id: 1, created_at: recent, environment: "production", production_environment: true, ref: "main" }]);
    if (url.pathname === "/search/issues") return url.searchParams.get("q")?.includes("review:none")
      ? Response.json({ total_count: 1, incomplete_results: false, items: [{ number: 17, title: "Needs review", created_at: "2026-10-17T06:00:00Z" }] })
      : Response.json({ total_count: 42, incomplete_results: false });
    return Response.json({ total_count: url.searchParams.get("status") === "success" ? 8 : ["cancelled", "skipped"].includes(url.searchParams.get("status")!) ? 0 : 10,
      workflow_runs: Array.from({ length: 10 }, (_, index) => ({ id: index + 1, created_at: recent, conclusion: index < 8 ? "success" : "failure" })),
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(resolveGithubToken).mockImplementation(async (token) => ({ token: token || "system-token", source: token ? "plugin" : "gh" }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
// History rows are stored gzip-compressed; legacy rows are plain JSON text.
const unpack = (data: string | Uint8Array) => JSON.parse(typeof data === "string" ? data : gunzipSync(data).toString("utf8"));
const load = () => loadMetrics("acme/widgets", "private-token", new AbortController().signal);

test("today aggregates cached records into six midnight-aligned four-hour buckets", async () => {
  const source = await load();
  vi.setSystemTime(new Date("2026-10-20T10:17:38Z"));
  const dates = ["2026-10-19T23:59:59Z", "2026-10-20T00:00:00Z", "2026-10-20T03:59:59Z", "2026-10-20T04:00:00Z", "2026-10-20T08:12:00Z", "2026-10-20T12:00:00Z"];
  const result = await loadMetrics("acme/widgets", "token", new AbortController().signal, resolveRange({ days: 1 }), {
    metrics: source, records: {
      deployments: dates.map((created_at) => ({ created_at })),
      runs: dates.map((created_at, id) => ({ id, created_at, conclusion: id === 4 ? "failure" : "success" })),
      commits: dates.map((committedDate, id) => ({ oid: String(id), committedDate, additions: 10, deletions: 2 })), branch: "main",
    },
  });
  expect(result.deployments.value).toBe(4);
  expect(result.deployments.series?.map((point) => point.value)).toEqual([2, 1, 1, 0, 0, 0]);
  expect(result.deployments.series?.map((point) => point.date)).toEqual([4, 8, 12, 16, 20, 24].map((hour) => new Date(Date.parse(result.range.since) + hour * 3_600_000).toISOString()));
  expect(result.ci.value).toBe(75);
  expect(result.ci.series?.map((point) => point.value)).toEqual([100, 100, 0, null, null, null]);
  expect(result.commitActivity).toMatchObject({ commits: 4, additions: 40, deletions: 8 });
  expect(new URL(fetchMock.mock.calls.at(-1)![0]).searchParams.get("q")).toContain("created:2026-10-20T00:00:00.000Z..2026-10-20T10:17:38.000Z");
});

test("workflow metadata survives persistence and powers contained ranges without more history requests", async () => {
  const normal = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input: string) => {
    const response = await normal(input);
    if (!new URL(input).pathname.endsWith("/actions/runs")) return response;
    const body = await response.json();
    return Response.json({ ...body, workflow_runs: body.workflow_runs.map((run: Record<string, unknown>) => ({ ...run,
      workflow_id: 42, name: "Tests", head_branch: "main", event: "push", run_started_at: recent, updated_at: "2026-10-19T12:02:00Z",
    })) });
  });
  const { bb, harness } = createFakePluginHost({ settings: { repository: "acme/widgets", importBbRepositories: false } });
  try {
    await plugin(bb);
    const result = await harness.behavior.callRpc("metrics", { days: 7 }) as { repositories: Metrics[] };
    expect(result).toMatchObject({ repositories: [{ ciInsights: { identified: 10, defaultBranch: "main", timing: { basis: "success", count: 8, totalMs: 960_000 } } }] });
    fetchMock.mockClear();
    const legacy = structuredClone(result);
    delete legacy.repositories[0].ciInsights!.timing.basis;
    Object.assign(legacy.repositories[0].ciInsights!.timing, { count: 10, totalMs: 1_200_000 });
    const database = bb.storage.database();
    database.prepare("UPDATE dashboard_snapshots SET data = ?").run(JSON.stringify({ ...legacy, authSource: "gh", discoveryError: null }));
    const previous = unpack((database.prepare("SELECT data FROM repository_history").get() as { data: Buffer }).data);
    previous.metrics.ciInsights = legacy.repositories[0].ciInsights;
    database.prepare("UPDATE repository_history SET data = ?").run(JSON.stringify(previous));
    const rebuilt = await harness.behavior.callRpc("snapshot", { days: 7 });
    expect(rebuilt).toMatchObject({ repositories: [{ updatedAt: result.repositories[0].updatedAt, ciInsights: { timing: { basis: "success", count: 8, totalMs: 960_000 } } }] });
    const saved = JSON.parse((database.prepare("SELECT data FROM dashboard_snapshots WHERE selection = ?").get(JSON.stringify({ days: 7 })) as { data: string }).data);
    expect(saved.repositories[0].ciInsights.timing.basis).toBe("success");
    expect(fetchMock).not.toHaveBeenCalled();
    const local = await harness.behavior.callRpc("snapshot", { days: 3 });
    expect(local).toMatchObject({ repositories: [{ ciInsights: result.repositories[0].ciInsights }] });
    expect(fetchMock).not.toHaveBeenCalled();
    const stored = unpack((bb.storage.database().prepare("SELECT data FROM repository_history").get() as { data: Buffer }).data);
    expect(stored.records.runs[0]).toMatchObject({ workflow_id: 42, run_started_at: recent });
  } finally { await harness.lifecycle.dispose(); }
});

test("agent CI access is read-only, uses the local cache, marks stale data and supports explicit refresh", async () => {
  const { bb, harness } = createFakePluginHost({ settings: { repository: "acme/widgets", token: "private-token", importBbRepositories: false } });
  try {
    await plugin(bb);
    const cold = ciReportSchema.parse(JSON.parse(await harness.behavior.callAgentTool("ci_dashboard_metrics", {}) as string));
    expect(cold).toMatchObject({ source: "collection", repositories: [{ repository: "acme/widgets", stale: false, ageSeconds: 0, passRate: { value: 80 }, ciOutcomes: { success: 8, failure: 2 } }] });
    fetchMock.mockClear();
    vi.mocked(resolveGithubToken).mockClear();
    vi.setSystemTime(new Date("2026-10-20T12:10:00Z"));
    const cached = ciReportSchema.parse(JSON.parse(await harness.behavior.callAgentTool("ci_dashboard_metrics", { repository: "ACME/WIDGETS" }) as string));
    expect(cached).toMatchObject({ source: "cache", repositories: [{ stale: true, ageSeconds: 600, updatedAt: "2026-10-20T12:00:00.000Z" }] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(resolveGithubToken).not.toHaveBeenCalled();
    expect(await harness.behavior.callRpc("ci", { repository: "acme/widgets" })).toEqual(cached);
    expect(JSON.stringify(cached)).not.toContain("private-token");
    expect(JSON.stringify(cached)).not.toContain("authSource");
    expect(JSON.stringify(cached)).not.toContain("commitActivity");
    for (const input of [{ repository: "acme/unknown" }, { selection: { start: "2025-10-19", end: "2026-10-20" } }, { selection: { days: 365 } }, { refresh: "true" }]) {
      await expect(harness.behavior.callAgentTool("ci_dashboard_metrics", input)).rejects.toThrow();
    }
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(harness.behavior.callAgentTool("ci_dashboard_metrics", {}, { signal: AbortSignal.abort() })).rejects.toThrow();
    const fresh = ciReportSchema.parse(JSON.parse(await harness.behavior.callAgentTool("ci_dashboard_metrics", { refresh: true }) as string));
    expect(fresh).toMatchObject({ source: "collection", repositories: [{ stale: false, updatedAt: "2026-10-20T12:10:00.000Z" }] });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.some(([url]) => url.includes("/dispatches"))).toBe(false);
  } finally { await harness.lifecycle.dispose(); }
});

test("a GitHub timeout or dropped connection is named as transient and logged with its cause", async () => {
  const normal = fetchMock.getMockImplementation()!;
  for (const failure of [new DOMException("The operation was aborted due to timeout", "TimeoutError"), new TypeError("fetch failed")]) {
    fetchMock.mockImplementation(async (input: string) => { if (input.includes("/deployments")) throw failure; return normal(input); });
    const warnings: string[] = [];
    const result = await loadMetrics("acme/widgets", "private-token", new AbortController().signal, undefined, undefined, undefined, { onWarning: (message) => warnings.push(message) });
    expect(result.deployments.error).toBe("GitHub did not respond in time or the connection dropped. The next refresh retries.");
    expect(warnings).toContain(`deployments: ${failure.name}: ${failure.message}`);
  }
});

test("counts paginated deployments inside the seven-day window and calculates all metrics", async () => {
  const normal = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input: string) => {
    const url = new URL(input);
    if (!url.pathname.endsWith("/deployments")) return normal(input);
    if (url.searchParams.get("page") === "1") return Response.json(
      Array.from({ length: 14 }, () => ({ created_at: recent })),
      { headers: { link: '<https://api.github.com/repos/acme/widgets/deployments?page=2>; rel="next"' } },
    );
    return Response.json([{ created_at: recent }, { created_at: "2026-10-01T00:00:00Z" }, { created_at: "2026-10-21T00:00:00Z" }]);
  });
  const result = await load();
  expect(result.deployments.value).toBe(15 / 7);
  expect(result.pullRequests.value).toBe(42);
  expect(result.ci.value).toBe(80);
  expect(result.deployments.series?.map((point) => point.value)).toEqual([0, 0, 0, 0, 0, 0, 15, 0]);
  expect(result.ci.series?.map((point) => point.value)).toEqual([null, null, null, null, null, null, 80, null]);
  expect(JSON.stringify(result)).not.toContain("private-token");
  expect(fetchMock.mock.calls.some(([url]) => url.includes("page=2"))).toBe(true);
});

test("zero deployments and no completed runs do not manufacture a CI rate", async () => {
  fetchMock.mockImplementation(async (url: string) => url.includes("actions/runs")
    ? Response.json({ total_count: 0, workflow_runs: [] }) : url.includes("search/issues")
      ? Response.json({ total_count: 0, incomplete_results: false }) : Response.json([]));
  const result = await load();
  expect(result.deployments.value).toBe(0);
  expect(result.pullRequests.value).toBe(0);
  expect(result.ci.value).toBeNull();
  expect(result.ci.error).toBeNull();
  expect(result.ci.series?.every((point) => point.value === null)).toBe(true);
  expect(result.deployments.series?.every((point) => point.value === 0)).toBe(true);
});

test("API failures remain local to a metric and never expose response bodies", async () => {
  const normal = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url: string) => url.includes("deployments")
    ? new Response("private-token", { status: 403 }) : normal(url));
  const result = await load();
  expect(result.deployments.error).toContain("rate limit");
  expect(result.pullRequests.value).toBe(42);
  expect(result.ci.value).toBe(80);
  expect(JSON.stringify(result)).not.toContain("private-token");
});

test("incomplete searches and malformed responses are unavailable, not zero", async () => {
  fetchMock.mockImplementation(async (url: string) => url.includes("search/issues")
    ? Response.json({ total_count: 5, incomplete_results: true }) : Response.json({ unexpected: true }));
  const result = await load();
  expect(result.pullRequests.error).toContain("incomplete");
  expect(result.deployments.value).toBeNull();
  expect(result.ci.error).toBeTruthy();
});

test("repeated deployment pages report an error instead of looping or understating the rate", async () => {
  const normal = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url: string) => url.includes("deployments")
    ? Response.json(Array.from({ length: 100 }, () => ({ created_at: recent })), { headers: { link: '<https://api.github.com/next>; rel="next"' } })
    : normal(url));
  const result = await load();
  expect(result.deployments.value).toBeNull();
  expect(result.deployments.error).toContain("repeated");
});

test("real SDK validates settings and RPC, re-reads settings, and aborts on disposal", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "delivery-dashboard", settings: { repository: "acme/widgets", token: "private-token", importBbRepositories: false },
  });
  try {
    await plugin(bb);
    await expect(harness.behavior.setSettings({ refreshSeconds: 1 })).rejects.toThrow();
    await expect(harness.behavior.setSettings({ repository: "https://evil.example/repo" })).rejects.toThrow();
    const result = await harness.behavior.callRpc("metrics", null);
    expect(result).toMatchObject({ repositories: [{ pullRequests: { value: 42 } }] });
    await harness.behavior.setSettings({ repository: "acme/other" });
    expect(await harness.behavior.callRpc("metrics", null)).toMatchObject({ repositories: [{ repository: "acme/other" }] });
    const options = (fetchMock.mock.calls as unknown as [string, RequestInit][])[0][1];
    expect(options.headers).toHaveProperty("Authorization", "Bearer private-token");
    expect(options.signal?.aborted).toBe(false);
    await harness.lifecycle.dispose();
    expect(options.signal?.aborted).toBe(true);
  } finally { await harness.lifecycle.dispose(); }
});

test("plugin only imports public SDK surfaces", async () => {
  const result = await experimental_scanPublicSdkOnly(process.cwd(), { allow: [/^(react|@radix-ui\/react-slot|class-variance-authority|clsx|tailwind-merge|vitest|@testing-library\/react)$/] });
  expect(result.violations).toEqual([]);
  expect(result.privateDependencies).toEqual([]);
});


test("imports GitHub remotes from BB, merges manual repos, and de-duplicates case-insensitively", async () => {
  const project = (id: string, remote: string | null) => ({
    id, name: id, kind: "standard" as const, gitRemoteUrl: remote, createdAt: 0, updatedAt: 0, sources: [],
  });
  const projects = [project("p1", "git@github.com:acme/widgets.git"), project("p2", "https://github.com/Acme/Other.git"),
    project("p3", "https://gitlab.com/acme/ignored.git"), project("p4", null)];
  const { bb, harness } = createFakePluginHost({
    pluginId: "delivery-dashboard", settings: { repository: "acme/WIDGETS, acme/manual\nacme/manual" },
    sdk: { projects: { list: async () => projects } },
  });
  try {
    await plugin(bb);
    const result = await harness.behavior.callRpc("metrics", null);
    expect(result).toMatchObject({ authSource: "gh", discoveryError: null, repositories: [
      { repository: "acme/widgets", projectName: "p1" }, { repository: "acme/manual", projectName: null }, { repository: "Acme/Other", projectName: "p2" },
    ] });
    expect(harness.inspection.sdk.callsTo("projects.list")).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("system-token");
    expect(fetchMock.mock.calls[0][1]?.headers).toHaveProperty("Authorization", "Bearer system-token");
    await harness.behavior.setSettings({ importBbRepositories: false });
    expect(await harness.behavior.callRpc("metrics", null)).toMatchObject({ repositories: [
      { repository: "acme/WIDGETS", projectName: null }, { repository: "acme/manual", projectName: null },
    ] });
    expect(harness.inspection.sdk.callsTo("projects.list")).toHaveLength(1);
  } finally { await harness.lifecycle.dispose(); }
});

test("discovery errors are visible and do not block manually configured repositories", async () => {
  const { bb, harness } = createFakePluginHost({
    settings: { repository: "acme/manual" },
    sdk: { projects: { list: async () => { throw new Error("offline"); } } },
  });
  try {
    await plugin(bb);
    expect(await harness.behavior.callRpc("metrics", null)).toMatchObject({
      discoveryError: expect.stringContaining("Unable to discover"), repositories: [{ repository: "acme/manual" }],
    });
  } finally { await harness.lifecycle.dispose(); }
});

test("accepts supported GitHub URL formats and rejects other hosts and invalid lists", () => {
  for (const remote of ["git@github.com:acme/widgets.git", "https://github.com/acme/widgets/", "ssh://git@github.com/acme/widgets.git", "git://github.com/acme/widgets.git"]) {
    expect(githubRepository(remote)).toBe("acme/widgets");
  }
  for (const remote of ["https://github.com.evil.test/acme/widgets", "https://github.com/acme/widgets?foo=1", "file:///acme/widgets", null]) {
    expect(githubRepository(remote)).toBeNull();
  }
  expect(repositoriesSettingSchema.safeParse("acme/widgets, acme/other\nacme/third").success).toBe(true);
  expect(repositoriesSettingSchema.safeParse("acme/widgets, invalid").success).toBe(false);
});


test("groups boundary timestamps into UTC calendar days, the first and last partial", async () => {
  const normal = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input: string) => input.includes("/deployments")
    ? Response.json([
      { created_at: "2026-10-20T12:00:00Z" }, { created_at: "2026-10-19T11:59:59Z" },
      { created_at: "2026-10-14T12:00:00Z" }, { created_at: "2026-10-13T12:00:00Z" },
      { created_at: "2026-10-13T11:59:59Z" },
    ]) : normal(input));
  const result = await load();
  expect(result.deployments.series?.map((point) => point.value)).toEqual([1, 1, 0, 0, 0, 0, 1, 1]);
  expect(result.deployments.series?.[0].date).toBe("2026-10-14T00:00:00.000Z");
  expect(result.deployments.series?.[7].date).toBe("2026-10-20T12:00:00.000Z");
  expect(result.deployments.value).toBe(4 / 7);
});

test("paginates completed CI history and calculates each day's success percentage", async () => {
  const normal = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input: string) => {
    const url = new URL(input);
    if (!url.pathname.endsWith("/actions/runs")) return normal(input);
    if (url.searchParams.get("status") === "success") return Response.json({ total_count: 2 });
    const first = url.searchParams.get("page") === "1";
    return Response.json({ total_count: 101, workflow_runs: first
      ? Array.from({ length: 100 }, (_, index) => ({ id: index + 1, created_at: recent, conclusion: index < 50 ? "success" : "failure" }))
      : [{ id: 101, created_at: "2026-10-14T12:00:00Z", conclusion: "success" }],
    }, first ? { headers: { link: '<https://api.github.com/next>; rel="next"' } } : undefined);
  });
  const result = await load();
  expect(result.ci.value).toBeCloseTo(5100 / 101);
  expect(result.ci.series?.map((point) => point.value)).toEqual([null, 100, null, null, null, null, 50, null]);
  expect(result.ci.seriesError).toBeNull();
});

test("splits large CI searches and ignores GitHub's truncated 2,500 total", async () => {
  const normal = fetchMock.getMockImplementation()!;
  const start = Date.parse("2026-10-13T12:00:00Z");
  const runs = Array.from({ length: 5001 }, (_, index) => ({
    id: index + 1, created_at: new Date(start + index * 100_000).toISOString(),
    conclusion: index % 2 === 0 ? "success" : "failure",
  }));
  fetchMock.mockImplementation(async (input: string) => {
    const url = new URL(input);
    if (!url.pathname.endsWith("/actions/runs")) return normal(input);
    expect(url.searchParams.get("status")).toBe("completed");
    const [since, until] = url.searchParams.get("created")!.split("..").map(Date.parse);
    const selected = runs.filter((row) => Date.parse(row.created_at) >= since && Date.parse(row.created_at) <= until);
    const page = Number(url.searchParams.get("page"));
    expect(page).toBeLessThanOrEqual(10);
    return Response.json({ total_count: Math.min(2500, selected.length), workflow_runs: selected.slice((page - 1) * 100, page * 100) },
      page * 100 < selected.length ? { headers: { link: '<https://api.github.com/next>; rel="next"' } } : undefined);
  });
  const result = await load();
  expect(result.ci.value).toBeCloseTo(2501 / 5001 * 100);
  expect(result.ci.detail).toContain("2501 of 5001");
  expect(result.ciOutcomes).toEqual({ success: 2501, failure: 2500 });
  expect(result.ci.seriesError).toBeNull();
  expect(result.ci.series?.filter((point) => point.value !== null).length).toBeGreaterThan(1);
});

test("large CI sibling windows start together within the shared request budget", async () => {
  const normal = fetchMock.getMockImplementation()!;
  const start = Date.parse("2026-10-13T12:00:00Z");
  const runs = Array.from({ length: 2000 }, (_, id) => ({ id: id + 1, created_at: new Date(start + id * 300_000).toISOString(), conclusion: "success" }));
  let children = 0, first = true, release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  fetchMock.mockImplementation(async (input, options) => {
    const url = new URL(input);
    if (!url.pathname.endsWith("/actions/runs")) return normal(input, options);
    const page = Number(url.searchParams.get("page"));
    const [since, until] = url.searchParams.get("created")!.split("..").map(Date.parse);
    if (first) first = false;
    else if (page === 1 && children < 2) {
      if (++children === 2) release();
      await gate;
    }
    const selected = runs.filter((run) => Date.parse(run.created_at) >= since && Date.parse(run.created_at) <= until);
    return Response.json({ total_count: selected.length, workflow_runs: selected.slice((page - 1) * 100, page * 100) }, page * 100 < selected.length ? { headers: { link: '<https://api.github.com/next>; rel="next"' } } : undefined);
  });
  try {
    const result = await load();
    expect(children).toBe(2);
    expect(result.ciOutcomes).toEqual({ success: 2000 });
    expect(result.ci.value).toBe(100);
  } finally { release(); }
});

test("a CI count change during pagination retries only that window once", async () => {
  const normal = fetchMock.getMockImplementation()!;
  let changed = false;
  fetchMock.mockImplementation(async (input, options) => {
    const url = new URL(input);
    if (!url.pathname.endsWith("/actions/runs")) return normal(input, options);
    const page = Number(url.searchParams.get("page"));
    if (page === 2) changed = true;
    const count = changed ? 102 : 101;
    return Response.json({ total_count: count, workflow_runs: Array.from({ length: page === 1 ? 100 : 2 }, (_, index) => ({ id: (page - 1) * 100 + index + 1, created_at: recent, conclusion: "success" })) }, page === 1 ? { headers: { link: '<https://api.github.com/next>; rel="next"' } } : undefined);
  });
  const result = await load();
  expect(result.ciOutcomes).toEqual({ success: 102 });
  expect(result.ci.error).toBeNull();
  expect(result.ci.seriesError).toBeNull();
  expect(fetchMock.mock.calls.filter(([url]) => url.includes("/actions/runs?"))).toHaveLength(4);
});

test("failed large CI searches never report a pass rate from capped counts", async () => {
  const normal = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input: string) => input.includes("actions/runs")
    ? Response.json({ total_count: 2500, workflow_runs: [] }) : normal(input));
  const result = await load();
  expect(result.ci.value).toBeNull();
  expect(result.ciOutcomes).toBeNull();
  expect(result.ci.error).toContain("complete CI history");
  expect(fetchMock.mock.calls.filter(([url]) => url.includes("status=success"))).toHaveLength(0);
});

test("loads over 1,000 deployments and discovers older production without a scan cap", async () => {
  const normal = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input: string) => {
    const url = new URL(input);
    if (!url.pathname.endsWith("/deployments")) return normal(input);
    const page = Number(url.searchParams.get("page"));
    return Response.json(Array.from({ length: page < 12 ? 100 : 1 }, (_, index) => ({
      id: (page - 1) * 100 + index + 1, created_at: recent, environment: page < 12 ? "preview" : "production",
      production_environment: page === 12, ref: "main",
    })), page < 12 ? { headers: { link: '<https://api.github.com/next>; rel="next"' } } : undefined);
  });
  const result = await load();
  expect(result.deployments.value).toBe(1101 / 7);
  expect(result.deployments.error).toBeNull();
  expect(result.production.deployment?.environment).toBe("production");
  expect(fetchMock.mock.calls.filter(([url]) => new URL(url).pathname.endsWith("/deployments"))).toHaveLength(12);
});

test("shares at most four concurrent GitHub requests across repositories", async () => {
  const normal = fetchMock.getMockImplementation()!;
  let active = 0, peak = 0;
  fetchMock.mockImplementation(async (input, options) => {
    active++;
    peak = Math.max(peak, active);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      return await normal(input, options);
    } finally { active--; }
  });
  await Promise.all([load(), loadMetrics("acme/other", "private-token", new AbortController().signal)]);
  expect(peak).toBe(4);
});

test("does not render an incomplete CI history when counts change during pagination", async () => {
  const normal = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input: string) => input.includes("actions/runs")
    ? Response.json({ total_count: new URL(input).searchParams.get("status") === "success" ? 2 : ["cancelled", "skipped"].includes(new URL(input).searchParams.get("status")!) ? 1 : 5,
      workflow_runs: [{ id: 1, created_at: recent, conclusion: "success" }] }) : normal(input));
  const result = await load();
  expect(result.ci.value).toBeCloseTo(200 / 3);
  expect(result.ci.series).toBeNull();
  expect(result.ci.seriesError).toBeTruthy();
});


test("CI summary, chart, and breakdown use the same runs instead of racing a second success query", async () => {
  const normal = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input: string) => {
    if (!input.includes("actions/runs")) return normal(input);
    if (new URL(input).searchParams.get("status") === "success") throw new Error("Independent success count must not be fetched");
    return Response.json({ total_count: 6, workflow_runs: ["success", "failure", "cancelled", "skipped", "timed_out", null].map((conclusion, i) => ({ id: i + 1, created_at: conclusion === "cancelled" ? "2026-10-14T12:00:00Z" : recent, conclusion })) });
  });
  const result = await load();
  expect(result.ci.value).toBe(25);
  expect(result.ci.detail).toContain("1 of 4 runs passed");
  expect(result.ci.series?.map((point) => point.value)).toEqual([null, null, null, null, null, null, 25, null]);
  expect(result.ciOutcomes).toEqual({ success: 1, failure: 1, cancelled: 1, skipped: 1, timed_out: 1, unknown: 1 });
  expect(result.ci.seriesError).toBeNull();
});

test("review queue returns the oldest PRs with canonical links and incomplete results stay unavailable", async () => {
  const result = await load();
  expect(result.reviewQueue).toMatchObject({ total: 1, error: null, items: [{ number: 17, title: "Needs review", createdAt: "2026-10-17T06:00:00Z", url: "https://github.com/acme/widgets/pull/17" }] });
  const url = new URL(fetchMock.mock.calls.find(([url]) => new URL(url).searchParams.get("q")?.includes("review:none"))![0]);
  expect(url.searchParams.get("q")).toBe("repo:acme/widgets is:pr is:open draft:false review:none");
  expect(url.searchParams.get("sort")).toBe("created");
  expect(url.searchParams.get("order")).toBe("asc");
  expect(url.searchParams.get("per_page")).toBe("5");
  const normal = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input: string) => input.includes("search/issues") && new URL(input).searchParams.get("q")?.includes("review:none")
    ? Response.json({ total_count: 1, incomplete_results: true, items: [] }) : normal(input));
  expect((await load()).reviewQueue).toMatchObject({ total: null, items: [], error: expect.stringContaining("incomplete") });
});

test("latest production deployment uses its newest status, including production-named unflagged environments", async () => {
  const normal = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input: string) => {
    if (new URL(input).pathname.endsWith("/deployments")) return Response.json([
      { id: 3, created_at: recent, environment: "preview", production_environment: false, ref: "feature" },
      { id: 2, created_at: recent, environment: "production", production_environment: false, ref: "v2" },
    ]);
    if (input.includes("/2/statuses")) return Response.json([{ state: "failure", created_at: recent, log_url: "https://example.com/deploy/2" }]);
    return normal(input);
  });
  const result = await load();
  expect(result.production).toMatchObject({ error: null, deployment: { environment: "production", state: "failure", ref: "v2", url: "https://example.com/deploy/2" } });
  expect(fetchMock.mock.calls.filter(([url]) => new URL(url).pathname.endsWith("/deployments"))).toHaveLength(1);
});

test("production discovery paginates beyond the seven-day metric window and accepts production flags", async () => {
  const normal = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input: string) => {
    const url = new URL(input);
    if (!url.pathname.endsWith("/deployments")) return normal(input);
    const first = url.searchParams.get("page") === "1";
    return Response.json([{ id: first ? 2 : 1, created_at: "2026-10-01T00:00:00Z", environment: first ? "preview" : "release", production_environment: !first, ref: "v1" }],
      first ? { headers: { link: '<https://api.github.com/next>; rel="next"' } } : {});
  });
  const result = await load();
  expect(result.deployments.value).toBe(0);
  expect(result.production.deployment).toMatchObject({ environment: "release", ref: "v1" });
});

test("production statuses never expose unsafe URLs and missing status remains unknown", async () => {
  const normal = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input: string) => input.includes("/statuses")
    ? Response.json([{ state: "success", created_at: recent, log_url: "javascript:alert(1)" }]) : normal(input));
  expect((await load()).production.deployment?.url).toBe("https://github.com/acme/widgets/deployments");
  fetchMock.mockImplementation(async (input: string) => input.includes("/statuses") ? Response.json([]) : normal(input));
  expect((await load()).production.deployment?.state).toBe("unknown");
});

test("no production or pending reviews is distinct from an API error", async () => {
  const normal = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input: string) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/deployments")) return Response.json([]);
    if (url.pathname === "/search/issues" && url.searchParams.get("q")?.includes("review:none")) return Response.json({ total_count: 0, incomplete_results: false, items: [] });
    return normal(input);
  });
  const result = await load();
  expect(result.production).toEqual({ deployment: null, error: null });
  expect(result.reviewQueue).toEqual({ total: 0, items: [], error: null });
});


test("counts PRs created in the seven-day window independently of current open PRs", async () => {
  const result = await load();
  expect(result.pullRequestsCreated.value).toBe(9);
  expect(result.pullRequests.value).toBe(42);
  const query = fetchMock.mock.calls.map(([url]) => new URL(url).searchParams.get("q")).find((q) => q?.includes("created:"));
  expect(query).toContain("created:2026-10-13T12:00:00.000Z..2026-10-20T12:00:00.000Z");
  expect(query).not.toContain("is:open");
  expect(result.commitActivity).toEqual({ commits: 2, additions: 120, deletions: 15, branch: "main", error: null });
});

test("commit API errors cannot turn valid PR and CI counts into zero or leak response details", async () => {
  const normal = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => url.endsWith("/graphql")
    ? Response.json({ errors: [{ message: "private-token" }], data: { repository: null } }) : normal(url, options));
  const result = await load();
  expect(result.commitActivity.commits).toBeNull();
  expect(result.commitActivity.additions).toBeNull();
  expect(result.commitActivity.error).toContain("GitHub could not load");
  expect(result.pullRequestsCreated.value).toBe(9);
  expect(result.ci.value).toBe(80);
  expect(JSON.stringify(result)).not.toContain("private-token");
});

test("custom range scopes deployment frequency, CI, created PRs, and commit statistics consistently", async () => {
  const { resolveRange } = await import("./date-range");
  const range = resolveRange({ start: "2026-10-19", end: "2026-10-19" });
  const normal = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input, options) => {
    if (new URL(input).pathname.endsWith("/deployments")) return Response.json([
      { id: 3, created_at: "2026-10-20T00:00:00Z", environment: "production", production_environment: true, ref: "latest" },
      ...["2026-10-19T23:59:59Z", "2026-10-19T00:00:00Z", "2026-10-18T23:59:59Z"].map((created_at, i) => ({ id: i + 4, created_at, environment: "preview", production_environment: false, ref: "main" })),
    ]);
    return normal(input, options);
  });
  const result = await loadMetrics("acme/widgets", "token", new AbortController().signal, range);
  expect(result.range).toEqual(range);
  expect(result.deployments.value).toBeCloseTo(2);
  expect(result.deployments.series?.reduce((sum, p) => sum + (p.value ?? 0), 0)).toBe(2);
  expect(result.production.deployment?.ref).toBe("latest");
  expect(result.pullRequests.value).toBe(42);
  const urls = fetchMock.mock.calls.map(([url]) => new URL(url));
  expect(urls.find((url) => url.pathname.endsWith("/actions/runs"))?.searchParams.get("created")).toBe(`${range.since}..${range.until}`);
  expect(urls.find((url) => url.searchParams.get("q")?.includes("created:"))?.searchParams.get("q")).toContain(`created:${range.since}..${range.until}`);
  const graphql = fetchMock.mock.calls.find(([url]) => url.endsWith("/graphql"));
  expect(JSON.parse(graphql![1]!.body as string).variables).toMatchObject({ since: range.since, until: range.until });
  expect(result.commitActivity.commits).toBe(2);
});

test("RPC accepts presets and rejects invalid custom dates before making GitHub requests", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "delivery-dashboard", settings: { repository: "acme/widgets", importBbRepositories: false } });
  try {
    await plugin(bb);
    const result = await harness.behavior.callRpc("metrics", { days: 90 });
    expect(result).toMatchObject({ repositories: [{ range: { since: "2026-07-22T12:00:00.000Z", until: "2026-10-20T12:00:00.000Z" } }] });
    fetchMock.mockClear();
    for (const input of [{ days: 2 }, { start: "2026-10-21", end: "2026-10-20" }, { start: "2025-02-29", end: "2025-03-01" }, { start: "2025-10-19", end: "2026-10-20" }]) {
      await expect(harness.behavior.callRpc("metrics", input)).rejects.toThrow();
      await expect(harness.behavior.callRpc("snapshot", input)).rejects.toThrow();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  } finally { await harness.lifecycle.dispose(); }
});

test("bar interval RPC validates endpoints and requests statistics for just the selected repository", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "delivery-dashboard", settings: { token: "private-token" } });
  const input = { repository: "acme/widgets", since: "2026-10-19T00:00:00.000Z", until: "2026-10-19T23:59:59.999Z" };
  try {
    await plugin(bb);
    const result = await harness.behavior.callRpc("interval", input);
    expect(result).toMatchObject({ repository: input.repository, range: { since: input.since, until: input.until }, commitActivity: { commits: 2 }, ci: { value: 80 } });
    expect(JSON.stringify(result)).not.toContain("private-token");
    const urls = fetchMock.mock.calls.map(([url]) => new URL(url));
    expect(urls.find((url) => url.pathname.endsWith("/actions/runs"))?.searchParams.get("created")).toBe(`${input.since}..${input.until}`);
    expect(urls.find((url) => url.searchParams.get("q")?.includes("created:"))?.searchParams.get("q")).toContain(`created:${input.since}..${input.until}`);
    const graphql = fetchMock.mock.calls.find(([url]) => url.endsWith("/graphql"));
    expect(JSON.parse(graphql![1]!.body as string).variables).toMatchObject({ since: input.since, until: input.until });
    fetchMock.mockClear();
    for (const change of [
      { repository: "../../secret" }, { since: "invalid" }, { since: "2026-10-20T00:00:00.000Z" },
      { until: "2026-10-21T00:00:00.000Z" }, { since: "2025-10-19T23:59:59.999Z" },
    ]) await expect(harness.behavior.callRpc("interval", { ...input, ...change })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  } finally { await harness.lifecycle.dispose(); }
});


test("loads CI pages in parallel with independent request deadlines", async () => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation((delay) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), delay);
    return controller.signal;
  });
  const normal = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input, options) => {
    const url = new URL(input);
    if (!url.pathname.endsWith("/actions/runs")) return normal(input, options);
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    options?.signal?.throwIfAborted();
    const page = Number(url.searchParams.get("page"));
    return Response.json({ total_count: 201, workflow_runs: Array.from({ length: page < 3 ? 100 : 1 }, (_, index) => ({ id: (page - 1) * 100 + index + 1, created_at: recent, conclusion: "success" })) },
      page < 3 ? { headers: { link: '<https://api.github.com/next>; rel="next"' } } : undefined);
  });
  try {
    let result: Awaited<ReturnType<typeof load>> | undefined;
    const pending = load().then((value) => { result = value; });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(result?.ci.value).toBe(100);
    await pending;
    expect(result!.ciOutcomes).toEqual({ success: 201 });
    expect(result!.ci.error).toBeNull();
    expect(result!.ci.seriesError).toBeNull();
  } finally { vi.restoreAllMocks(); }
});


test("reads persisted snapshots without GitHub and invalidates them on settings changes", async () => {
  let { bb, harness } = createFakePluginHost({
    pluginId: "delivery-dashboard", settings: { repository: "acme/widgets", token: "private-token", importBbRepositories: false },
  });
  try {
    await plugin(bb);
    expect(await harness.behavior.callRpc("snapshot", null)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    const result = await harness.behavior.callRpc("metrics", null);
    ({ bb, harness } = await harness.lifecycle.reload(plugin));
    fetchMock.mockClear();
    vi.mocked(resolveGithubToken).mockClear();
    expect(await harness.behavior.callRpc("snapshot", { days: 7 })).toEqual(result);
    expect(await harness.behavior.callRpc("snapshot", { days: 90 })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(resolveGithubToken).not.toHaveBeenCalled();
    const rows = bb.storage.database().prepare("SELECT * FROM dashboard_snapshots").all();
    expect(JSON.stringify(rows)).not.toContain("private-token");
    await harness.behavior.setSettings({ token: "different-token" });
    expect(await harness.behavior.callRpc("snapshot", null)).toBeNull();
  } finally { await harness.lifecycle.dispose(); }
});

test("coalesces simultaneous refreshes of the same range", async () => {
  const { bb, harness } = createFakePluginHost({ settings: { repository: "acme/widgets", importBbRepositories: false } });
  try {
    await plugin(bb);
    const [first, second] = await Promise.all([
      harness.behavior.callRpc("metrics", null), harness.behavior.callRpc("metrics", { days: 7 }),
    ]);
    expect(first).toEqual(second);
    expect(fetchMock.mock.calls.filter(([url]) => url.includes("actions/runs"))).toHaveLength(1);
  } finally { await harness.lifecycle.dispose(); }
});

test("an old in-flight refresh cannot replace a snapshot after settings change", async () => {
  const { bb, harness } = createFakePluginHost({ settings: { repository: "acme/widgets", importBbRepositories: false } });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const normal = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input, options) => {
    if (new URL(input).pathname === "/graphql") await gate;
    return normal(input, options);
  });
  try {
    await plugin(bb);
    const old = harness.behavior.callRpc("metrics", null);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    fetchMock.mockImplementation(normal);
    await harness.behavior.setSettings({ repository: "acme/other" });
    const latest = await harness.behavior.callRpc("metrics", null);
    release();
    await old;
    expect(await harness.behavior.callRpc("snapshot", null)).toEqual(latest);
  } finally { release(); await harness.lifecycle.dispose(); }
});

test("the background service warms the default snapshot and stops on disposal", async () => {
  const { bb, harness } = createFakePluginHost({ settings: { repository: "acme/widgets", importBbRepositories: false } });
  try {
    await plugin(bb);
    const old = Date.now() - 8 * 86_400_000;
    bb.storage.database().prepare("INSERT INTO github_responses (cache_key, data, checked_at, last_used_at) VALUES (?, ?, ?, ?)").run("expired", "{}", old, old);
    vi.setSystemTime(new Date(Date.now() + 3_600_001));
    const service = harness.behavior.runService("snapshot-refresh");
    await vi.waitFor(async () => expect(await harness.behavior.callRpc("snapshot", null)).not.toBeNull());
    expect(bb.storage.database().prepare("SELECT cache_key FROM github_responses WHERE cache_key = 'expired'").get()).toBeUndefined();
    service.controller.abort();
    await service.done;
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  } finally { await harness.lifecycle.dispose(); }
});

test("repository history survives range-snapshot eviction and is shared by concurrent periods", async () => {
  const { bb, harness } = createFakePluginHost({ settings: { repository: "acme/widgets acme/other", importBbRepositories: false } });
  try {
    await plugin(bb);
    await harness.behavior.callRpc("metrics", { days: 90 });
    bb.storage.database().prepare("DELETE FROM dashboard_snapshots").run();
    fetchMock.mockClear();
    expect(await harness.behavior.callRpc("snapshot", { days: 30 })).toMatchObject({ authSource: "gh", repositories: ["acme/widgets", "acme/other"].map((repository) => ({ repository, ci: { value: 80 }, pending: ["pullRequestsCreated"] })) });
    expect(fetchMock).not.toHaveBeenCalled();
    await Promise.all([harness.behavior.callRpc("metrics", { days: 7 }), harness.behavior.callRpc("metrics", { days: 30 })]);
    expect(fetchMock.mock.calls.every(([url]) => new URL(url).pathname === "/search/issues")).toBe(true);
    expect(bb.storage.database().prepare("SELECT COUNT(*) AS count FROM repository_history").get()).toEqual({ count: 2 });
    bb.storage.database().prepare("DELETE FROM repository_history WHERE repository = ?").run("acme/other");
    bb.storage.database().prepare("DELETE FROM dashboard_snapshots").run();
    fetchMock.mockClear();
    expect(await harness.behavior.callRpc("snapshot", { days: 30 })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  } finally { await harness.lifecycle.dispose(); }
});

test("legacy history is promoted before refresh so a failed CI update cannot erase usable records", async () => {
  const { bb, harness } = createFakePluginHost({ settings: { repository: "acme/widgets", importBbRepositories: false } });
  try {
    await plugin(bb);
    await harness.behavior.callRpc("metrics", { days: 90 });
    bb.storage.database().prepare("DELETE FROM repository_history").run();
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, options) => new URL(input).pathname.endsWith("/actions/runs") ? new Response("private error", { status: 403 }) : normal(input, options));
    vi.setSystemTime(Date.now() + 61_000); // a forced refresh within a minute of a full collection is answered from it
    expect(await harness.behavior.callRpc("metrics", { selection: { days: 90 }, force: true })).toMatchObject({ repositories: [{ ci: { value: null, error: expect.stringContaining("403") } }] });
    fetchMock.mockClear();
    expect(await harness.behavior.callRpc("snapshot", { days: 30 })).toMatchObject({ repositories: [{ ci: { value: 80, error: null } }] });
    expect(fetchMock).not.toHaveBeenCalled();
  } finally { await harness.lifecycle.dispose(); }
});

test("ready metrics publish while commits are blocked and settings invalidate all repository caches", async () => {
  const { bb, harness } = createFakePluginHost({ settings: { repository: "acme/widgets", importBbRepositories: false } });
  const normal = fetchMock.getMockImplementation()!;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  fetchMock.mockImplementation(async (input, options) => {
    if (new URL(input).pathname === "/graphql") await gate;
    return normal(input, options);
  });
  try {
    await plugin(bb);
    const result = harness.behavior.callRpc("metrics", { days: 7 });
    await vi.waitFor(() => expect(harness.inspection.realtimeSignals).toEqual(expect.arrayContaining([expect.objectContaining({ channel: "metrics-progress", payload: expect.objectContaining({ metrics: expect.objectContaining({ ci: expect.objectContaining({ value: 80 }), pending: expect.arrayContaining(["commitActivity"]) }) }) })])));
    release();
    await result;
    await harness.behavior.setSettings({ repository: "acme/other" });
    expect(bb.storage.database().prepare("SELECT COUNT(*) AS count FROM repository_history").get()).toEqual({ count: 0 });
    expect(bb.storage.database().prepare("SELECT COUNT(*) AS count FROM github_responses").get()).toEqual({ count: 0 });
  } finally { release(); await harness.lifecycle.dispose(); }
});


const production = { productionRepository: "acme/widgets", productionWorkflow: "deploy.yaml" };
test("production dispatch refuses until a target is configured and requires it in the dashboard repositories", async () => {
  const { bb, harness } = createFakePluginHost({ settings: { repository: "acme/gadgets", importBbRepositories: false } });
  try {
    await plugin(bb);
    await expect(harness.behavior.callRpc("deployProduction", { repository: "evil/repo", ref: "feature", workflow: "other.yaml" })).rejects.toThrow();
    await expect(harness.behavior.callRpc("deployProduction", null)).rejects.toThrow("not configured");
    await harness.behavior.setSettings({ productionRepository: "acme/widgets" });
    await expect(harness.behavior.callRpc("deployProduction", null)).rejects.toThrow("not configured");
    await harness.behavior.setSettings({ ...production });
    await expect(harness.behavior.callRpc("deployProduction", null)).rejects.toThrow("must be included");
    expect(fetchMock).not.toHaveBeenCalled();
    await harness.behavior.setSettings({ repository: "acme/widgets" });
    fetchMock.mockResolvedValueOnce(Response.json({ workflow_run_id: 123 }));
    expect(await harness.behavior.callRpc("deployProduction", null)).toEqual({ url: "https://github.com/acme/widgets/actions/runs/123" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally { await harness.lifecycle.dispose(); }
});

test("production dispatch accepts the target repository discovered from a BB project", async () => {
  const { bb, harness } = createFakePluginHost({
    settings: production,
    sdk: { projects: { list: async () => [{ id: "widgets", name: "Widgets", kind: "standard", gitRemoteUrl: "git@github.com:acme/widgets.git", createdAt: 0, updatedAt: 0, sources: [] }] } },
  });
  try {
    await plugin(bb);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await harness.behavior.callRpc("deployProduction", null)).toMatchObject({ url: expect.stringContaining("deploy.yaml") });
  } finally { await harness.lifecycle.dispose(); }
});

test("overlapping production dispatches send only one request", async () => {
  const { bb, harness } = createFakePluginHost({ settings: { repository: "acme/widgets", importBbRepositories: false, ...production } });
  let finish!: (response: Response) => void;
  fetchMock.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  try {
    await plugin(bb);
    const first = harness.behavior.callRpc("deployProduction", null);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await expect(harness.behavior.callRpc("deployProduction", null)).rejects.toThrow("already in progress");
    finish(new Response(null, { status: 204 }));
    await first;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally { await harness.lifecycle.dispose(); }
});


test.each([
  ["cancelled", "cancelled"],
  ["skipped", "skipped"],
  ["cancelled", "skipped"],
])("histories containing only omitted outcomes have no pass rate (%s, %s)", async (first, second) => {
  const normal = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input: string) => input.includes("actions/runs")
    ? Response.json({ total_count: 2, workflow_runs: [first, second].map((conclusion, index) => ({ id: index + 1, created_at: recent, conclusion })) }) : normal(input));
  const result = await load();
  expect(result.ci.value).toBeNull();
  expect(result.ci.error).toBeNull();
  expect(result.ci.seriesError).toBeNull();
  expect(result.ci.series?.every((point) => point.value === null)).toBe(true);
  expect(result.ci.detail).toContain("No completed runs");
  expect(result.ciOutcomes).toEqual(first === second ? { [first]: 2 } : { [first]: 1, [second]: 1 });
});


test("derives narrower and custom ranges from persisted raw history without downloading history again", async () => {
  let { bb, harness } = createFakePluginHost({
    pluginId: "delivery-dashboard", settings: { repository: "acme/widgets", token: "private-token", importBbRepositories: false },
  });
  try {
    await plugin(bb);
    await harness.behavior.callRpc("metrics", { days: 90 });
    ({ bb, harness } = await harness.lifecycle.reload(plugin));
    fetchMock.mockClear();
    const narrower = await harness.behavior.callRpc("snapshot", { days: 30 });
    expect(narrower).toMatchObject({ repositories: [{
      range: { label: "last 30 days", since: "2026-09-20T12:00:00.000Z", until: "2026-10-20T12:00:00.000Z" },
      deployments: { value: 1 / 30 }, commitActivity: { commits: 2, additions: 120, deletions: 15 },
      ci: { value: 80 }, ciOutcomes: { success: 8, failure: 2 },
    }] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(narrower).toMatchObject({ repositories: [{ pending: ["pullRequestsCreated"], pullRequestsCreated: { value: null, error: null } }] });
    expect(await harness.behavior.callRpc("metrics", { days: 30 })).toMatchObject({ repositories: [{ pullRequestsCreated: { value: 9 }, pending: [] }] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get("q")).toContain("created:2026-09-20T12:00:00.000Z..2026-10-20T12:00:00.000Z");
    fetchMock.mockClear();
    expect(await harness.behavior.callRpc("snapshot", { days: 30 })).toMatchObject({ repositories: [{ pullRequestsCreated: { value: 9 } }] });
    expect(fetchMock).not.toHaveBeenCalled();
    const threeDays = await harness.behavior.callRpc("snapshot", { days: 3 });
    expect(threeDays).toMatchObject({ repositories: [{
      range: { bucketMs: 43_200_000, since: "2026-10-17T12:00:00.000Z", until: "2026-10-20T12:00:00.000Z" },
      deployments: { value: 1 / 3, series: [0, 0, 0, 0, 1, 0].map((value) => ({ value })) },
      ci: { value: 80, series: [null, null, null, null, 80, null].map((value) => ({ value })) },
    }] });
    const custom = await harness.behavior.callRpc("snapshot", { start: "2026-10-19", end: "2026-10-19" });
    expect(custom).toMatchObject({ repositories: [{ deployments: { value: expect.closeTo(1) }, commitActivity: { commits: 2 }, ci: { value: 80 } }] });
    const empty = await harness.behavior.callRpc("snapshot", { start: "2026-10-18", end: "2026-10-18" });
    expect(empty).toMatchObject({ repositories: [{ deployments: { value: 0 }, commitActivity: { commits: 0, additions: 0, deletions: 0 }, ci: { value: null }, ciOutcomes: {} }] });
    fetchMock.mockClear();
    expect(await harness.behavior.callRpc("snapshot", { start: "2026-07-01", end: "2026-07-02" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  } finally { await harness.lifecycle.dispose(); }
});


test("confirmed deferred drafts are separate outcomes and never depress pass rates or chart buckets", async () => {
  const baseline = await loadMetrics("acme/widgets", "token", new AbortController().signal);
  const rows = [
    { id: 1, created_at: recent, conclusion: "success", name: "CI", event: "pull_request", workflow_id: 1, head_branch: "main" },
    { id: 2, created_at: recent, conclusion: "failure", name: "CI", event: "pull_request", workflow_id: 1, head_branch: "draft", run_attempt: 1 },
    { id: 3, created_at: recent, conclusion: "failure", name: "CI", event: "pull_request", workflow_id: 1, head_branch: "real", run_attempt: 1 },
  ];
  const request = vi.fn(async (path: string) => ({ hasNext: false, body: { total_count: 1, jobs: [{ id: 1, name: "CI summary", conclusion: "failure", steps: [{ name: path.includes("/2/") ? "Draft gate" : "Build", conclusion: "failure" }] }] } }));
  const records = { deployments: [], commits: [], branch: "main", runs: rows };
  const result = await loadMetrics("acme/widgets", "token", new AbortController().signal, baseline.range, { metrics: baseline, records }, undefined, { request, draftRules: { workflow: "CI", job: "CI summary", step: "Draft gate" } });
  expect(result.ciOutcomes).toEqual({ success: 1, deferred_draft: 1, failure: 1 });
  expect(result.ci.value).toBe(50);
  expect(result.ci.series?.find((point) => point.value !== null)?.value).toBe(50);
  expect(request.mock.calls.filter(([path]) => path.includes("/jobs?"))).toHaveLength(2);
  request.mockClear();
  await loadMetrics("acme/widgets", "token", new AbortController().signal, baseline.range, { metrics: baseline, records }, undefined, { request });
  expect(request.mock.calls.filter(([path]) => path.includes("/jobs?"))).toHaveLength(0);
});


test("custom draft recognition settings replace defaults and invalidate old counting results", async () => {
  const original = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input, options) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/actions/runs")) return Response.json({ total_count: 1, workflow_runs: [{
      id: 77, created_at: recent, conclusion: "failure", name: "Verification", event: "pull_request", workflow_id: 1, head_branch: "feature", run_attempt: 1,
    }] });
    if (url.pathname.includes("/jobs")) return Response.json({ total_count: 1, jobs: [{ id: 1, name: "Gate", conclusion: "failure", steps: [{ name: "Draft guard", conclusion: "failure" }] }] });
    return original(input, options);
  });
  const { bb, harness } = createFakePluginHost({ settings: { repository: "acme/widgets", importBbRepositories: false } });
  try {
    await plugin(bb);
    const before = await harness.behavior.callRpc("metrics", null);
    expect(before).toMatchObject({ repositories: [{ ci: { value: 0 }, ciOutcomes: { failure: 1 } }] });
    await expect(harness.behavior.setSettings({ draftStep: "  " })).rejects.toThrow();
    await harness.behavior.setSettings({ draftWorkflow: "Verification", draftJob: "Gate", draftStep: "Draft guard" });
    expect(await harness.behavior.callRpc("snapshot", null)).toBeNull();
    expect(await harness.behavior.callRpc("metrics", null)).toMatchObject({ repositories: [{ ci: { value: null }, ciOutcomes: { deferred_draft: 1 } }] });
    expect(await harness.behavior.callRpc("interval", { repository: "acme/widgets", since: "2026-10-19T00:00:00Z", until: "2026-10-20T00:00:00Z" })).toMatchObject({ ciOutcomes: { deferred_draft: 1 } });
    expect(await harness.behavior.callRpc("cardDetails", { kind: "ci", repository: "acme/widgets", since: "2026-10-19T00:00:00Z", until: "2026-10-20T00:00:00Z" })).toMatchObject({ items: [] });
  } finally { await harness.lifecycle.dispose(); }
});

// --- job-level signals (ci-signals background service) ---
const live = (queuedJobs: object[], handlers: Record<string, (url: URL) => object> = {}) => {
  const normal = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input: string, options?: RequestInit) => {
    const url = new URL(input);
    const status = url.searchParams.get("status");
    if (url.pathname === "/repos/acme/widgets/actions/runs" && (status === "queued" || status === "in_progress")) return Response.json({ workflow_runs: status === "queued" && queuedJobs.length ? [{ id: 900, name: "CI", event: "push", head_branch: "main", head_sha: "abc", run_attempt: 1, pull_requests: [] }] : [] });
    if (url.pathname === "/repos/acme/widgets/actions/runs/900/jobs") return Response.json({ jobs: queuedJobs });
    for (const [path, handler] of Object.entries(handlers)) if (url.pathname === path) return Response.json(handler(url));
    return normal(input, options);
  });
};
const queuedJob = { id: 9001, name: "Unit tests", status: "queued", conclusion: null, created_at: "2026-10-20T11:40:00Z", started_at: null, completed_at: null, labels: ["self-hosted"], runner_name: null, runner_group_name: null, steps: [] };
const signalsHost = (push: (...args: never[]) => unknown = async () => ({ ok: true })) => createFakePluginHost({
  pluginId: "delivery-dashboard", settings: { repository: "acme/widgets", importBbRepositories: false },
  sdk: { plugins: { callRpc: push as never } },
});
type SignalsResult = { actors: Record<string, string>; repositories: { updatedAt: string | null; error: string | null; signals: { id: string; severity: string; open: boolean }[]; live: { pools: { pool: string; queued: number }[] }; failures: unknown[]; failureCounts: Record<string, number>; backfill: { remaining: number; coveredSince: string | null } }[] };
const updatedAt = async (harness: { behavior: { callRpc(method: string, input?: unknown): Promise<unknown> } }) => ((await harness.behavior.callRpc("signals", null)) as SignalsResult).repositories[0]?.updatedAt ?? null;

test("a stalled pool opens one critical signal, pushes once and is readable through RPC, badge and the stall view", async () => {
  live([queuedJob]);
  const { bb, harness } = signalsHost();
  try {
    await plugin(bb);
    expect(await harness.behavior.callRpc("signals", null)).toMatchObject({ repositories: [{ repository: "acme/widgets", updatedAt: null, signals: [], backfill: { remaining: 0, coveredSince: null } }] });
    let service = harness.behavior.runService("ci-signals");
    await vi.waitFor(async () => expect(await updatedAt(harness)).not.toBeNull());
    service.controller.abort(); await service.done;
    const result = await harness.behavior.callRpc("signals", null) as SignalsResult;
    expect(result.actors).toEqual({ owner_sre: "Runner owner / SRE", pr_author: "PR author", lead: "Lead", manager: "Manager" });
    expect(result.repositories[0]).toMatchObject({ error: null, live: { pools: [{ pool: "self-hosted", queued: 1 }] },
      signals: [{ id: "pool_stall:self-hosted", severity: "critical", open: true, kind: "pool_stall", actor: "owner_sre", since: "2026-10-20T11:40:00.000Z" }], failures: [] });
    expect(Object.keys(result.repositories[0].failureCounts)).toHaveLength(11);
    expect(await harness.behavior.callRpc("navigationBadge", null)).toEqual({ count: 1, critical: 1 });
    expect(harness.inspection.realtimeSignals).toEqual(expect.arrayContaining([expect.objectContaining({ channel: "signals-changed" })]));
    const pushes = () => harness.inspection.sdk.callsTo("plugins.callRpc");
    expect(pushes()).toHaveLength(1);
    expect(pushes()[0][0]).toMatchObject({ pluginId: "push-notifications", method: "notifications.send", input: { title: "Runner pool stalled: self-hosted", body: expect.stringContaining(" · Runner owner / SRE") } });

    const stall = await harness.behavior.callRpc("ci", { view: "stall" }) as { repositories: Record<string, unknown>[] };
    expect(stall.repositories[0]).toMatchObject({ repository: "acme/widgets", live: { pools: [{ pool: "self-hosted", queued: 1, queuedRunIds: [900] }] }, signals: [{ id: "pool_stall:self-hosted" }] });
    expect(Object.keys(stall.repositories[0]).sort()).toEqual(["backfill", "error", "live", "poolTimings", "poolTimingsByEvent", "repository", "signals", "updatedAt", "window"]);
    expect(stall.repositories[0]).toMatchObject({ poolTimings: {}, poolTimingsByEvent: {} });
    // The pools view is gone.
    await expect(harness.behavior.callRpc("ci", { view: "pools" })).rejects.toThrow();
    expect((await harness.behavior.callRpc("ci", { view: "failures" }) as { repositories: Record<string, unknown>[] }).repositories[0]).toMatchObject({ failures: [], failureCounts: expect.any(Object) });

    // The next loop sees the same stall: the incident is already open, so no second push.
    const first = await updatedAt(harness);
    vi.setSystemTime(new Date(Date.now() + 61_000));
    service = harness.behavior.runService("ci-signals");
    await vi.waitFor(async () => expect(await updatedAt(harness)).not.toBe(first));
    service.controller.abort(); await service.done;
    expect(pushes()).toHaveLength(1);
    expect((await harness.behavior.callRpc("signals", null) as SignalsResult).repositories[0].signals).toHaveLength(1);
    // Open incidents survive a reload because they live in kv.
    const reloaded = (await harness.lifecycle.reload(plugin)).harness;
    expect((await reloaded.behavior.callRpc("signals", null) as SignalsResult).repositories[0].signals).toMatchObject([{ id: "pool_stall:self-hosted", open: true }]);
  } finally { await harness.lifecycle.dispose(); }
});

test("the refusalSteps setting classifies gate refusals as refused and drops the run-level alert", async () => {
  const job = (id: number) => ({ id, name: "Release gate", status: "completed", conclusion: "failure", created_at: "2026-10-19T12:00:00Z", started_at: "2026-10-19T12:01:00Z", completed_at: "2026-10-19T12:05:00Z", labels: ["self-hosted"], runner_name: "runner-1", runner_group_name: null,
    steps: [{ name: "Admit release candidate", conclusion: "failure" }] });
  const base = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input: string, options?: RequestInit) => {
    const response = await base(input, options);
    if (!new URL(input).pathname.endsWith("/actions/runs")) return response;
    const body = await response.json();
    return Response.json({ ...body, workflow_runs: body.workflow_runs.map((run: Record<string, unknown>) => ({ ...run, workflow_id: 42, name: "CI", event: "push", head_branch: "main", head_sha: `sha${run.id}`, run_attempt: 1, pull_requests: [], conclusion: "failure" })) });
  });
  live([], Object.fromEntries(Array.from({ length: 10 }, (_, index) => [[`/repos/acme/widgets/actions/runs/${index + 1}/attempts/1/jobs`, () => ({ jobs: [job((index + 1) * 10)] })], [`/repos/acme/widgets/check-runs/${(index + 1) * 10}/annotations`, () => []]]).flat()));
  const run = async (settings: object) => {
    const { bb, harness } = createFakePluginHost({ pluginId: "delivery-dashboard", settings: { repository: "acme/widgets", importBbRepositories: false, ...settings } });
    try {
      await plugin(bb);
      await harness.behavior.callRpc("metrics", { days: 7 });
      // Each loop stores a batch of jobs and re-analyses at most every five minutes, so run three loops.
      for (let loop = 0; loop < 3; loop++) {
        const before = await updatedAt(harness);
        vi.setSystemTime(new Date(Date.now() + 301_000));
        const service = harness.behavior.runService("ci-signals");
        await vi.waitFor(async () => expect(await updatedAt(harness)).not.toBe(before));
        service.controller.abort(); await service.done;
      }
      expect(bb.storage.database().prepare("SELECT COUNT(*) AS n FROM ci_jobs").get()).toEqual({ n: 10 });
      return { counts: ((await harness.behavior.callRpc("signals", null)) as SignalsResult).repositories[0].failureCounts, badge: await harness.behavior.callRpc("navigationBadge", null) };
    } finally { await harness.lifecycle.dispose(); }
  };
  expect(await run({ refusalSteps: "Admit release candidate" })).toMatchObject({ counts: { refused: 10, real: 0 }, badge: { count: 0, critical: 0 } });
  fetchMock.mockClear();
  expect(await run({})).toMatchObject({ counts: { refused: 0 }, badge: { count: 1, critical: 1 } });
});

test("a failing push is logged and does not stop the loop", async () => {
  live([queuedJob]);
  const { bb, harness } = signalsHost(async () => { throw new Error("push offline"); });
  try {
    await plugin(bb);
    const service = harness.behavior.runService("ci-signals");
    await vi.waitFor(async () => expect(await updatedAt(harness)).not.toBeNull());
    service.controller.abort(); await service.done;
    expect(harness.inspection.logEntries).toEqual(expect.arrayContaining([expect.objectContaining({ level: "warn", message: expect.stringContaining("push offline") })]));
    expect((await harness.behavior.callRpc("signals", null) as SignalsResult).repositories[0]).toMatchObject({ error: null, signals: [{ severity: "critical" }] });
  } finally { await harness.lifecycle.dispose(); }
});

test("the budgeted backfill stores job rows from run metadata and classifies them without pushing stale incidents", async () => {
  const job = (id: number, conclusion: string) => ({ id, name: "Unit tests", status: "completed", conclusion, created_at: "2026-10-19T12:00:00Z", started_at: "2026-10-19T12:01:00Z", completed_at: "2026-10-19T12:05:00Z", labels: ["self-hosted"], runner_name: "runner-1", runner_group_name: null, steps: [] });
  const base = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input: string, options?: RequestInit) => {
    const response = await base(input, options);
    if (!new URL(input).pathname.endsWith("/actions/runs")) return response;
    const body = await response.json();
    return Response.json({ ...body, workflow_runs: body.workflow_runs.map((run: Record<string, unknown>) => ({ ...run, workflow_id: 42, name: "CI", event: "push", head_branch: "main", head_sha: `sha${run.id}`, run_attempt: 1, pull_requests: [{ id: 5, number: 7 }] })) });
  });
  live([], {
    ...Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`/repos/acme/widgets/actions/runs/${index + 1}/attempts/1/jobs`, () => ({ jobs: [job((index + 1) * 10, index >= 8 ? "failure" : "success")] })])),
    ...Object.fromEntries([90, 100].map((id) => [`/repos/acme/widgets/check-runs/${id}/annotations`, () => [{ annotation_level: "failure", title: null, message: "The runner has received a shutdown signal." }]])),
  });
  const { bb, harness } = signalsHost();
  try {
    await plugin(bb);
    await harness.behavior.callRpc("metrics", { days: 7 });
    const database = bb.storage.database();
    const stored = unpack((database.prepare("SELECT data FROM repository_history").get() as { data: Buffer }).data);
    expect(stored.records.runs[0]).toMatchObject({ head_sha: expect.stringMatching(/^sha/), pull_requests: [7] });
    expect(database.prepare("SELECT cache_key FROM github_responses WHERE cache_key LIKE '%ci-metadata-v3%'").all().length).toBeGreaterThan(0);
    const service = harness.behavior.runService("ci-signals");
    await vi.waitFor(async () => expect(((await harness.behavior.callRpc("signals", null)) as SignalsResult).repositories[0].failures).toHaveLength(2));
    service.controller.abort(); await service.done;
    const repository = (await harness.behavior.callRpc("signals", null) as SignalsResult).repositories[0];
    expect(repository).toMatchObject({ error: null, failureCounts: { runner_loss: 2, real: 0 }, backfill: { remaining: 0, failed: 0, coveredSince: "2026-10-19T12:00:00Z" },
      signals: expect.arrayContaining([expect.objectContaining({ id: "runner_loss:90", severity: "warning", where: expect.objectContaining({ pullRequests: [7], branch: "main", url: "https://github.com/acme/widgets/actions/runs/9/job/90" }) })]) });
    expect(database.prepare("SELECT COUNT(*) AS n FROM ci_jobs").get()).toEqual({ n: 10 });
    // Warnings on main are only pushed while fresh; these completed a day ago.
    expect(harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(0);
    // The runner losses completed a day ago, past the event window; only the run-level alert of the red default branch remains.
    expect(await harness.behavior.callRpc("navigationBadge", null)).toEqual({ count: 1, critical: 1 });
    const problems = (await harness.behavior.callRpc("signals", null) as { repositories: { problems: { id: string; severity: string; title: string; handled: unknown }[] }[] }).repositories[0].problems;
    expect(problems.map((problem) => problem.id)).toEqual([expect.stringMatching(/^run:main:\d+$/)]);
    expect(problems[0]).toMatchObject({ severity: "critical", title: "CI · main: latest run failed", handled: null });
    const summary = await harness.behavior.callRpc("ci", { repository: "acme/widgets" }) as { repositories: { signals: { open: { id: string }[]; pools: unknown[]; backfill: { remaining: number } } }[] };
    expect(summary.repositories[0]).toMatchObject({ ciInsights: expect.anything(), signals: { open: expect.arrayContaining([expect.objectContaining({ id: "runner_loss:90" })]), pools: [], backfill: { remaining: 0 } } });
    expect(ciReportSchema.safeParse(summary).success).toBe(true);
    // Run-level alerts are problems too, and the summary view shows who handles each one.
    await harness.behavior.callRpc("problemAction", { repository: "acme/widgets", id: problems[0].id, action: "dismiss" });
    const handledSummary = await harness.behavior.callRpc("ci", { repository: "acme/widgets" }) as { repositories: { signals: { problems: { id: string; handled: { state: string } | null }[] } }[] };
    expect(handledSummary.repositories[0].signals.problems).toMatchObject([{ id: problems[0].id, handled: { state: "dismissed" } }]);
    expect(await harness.behavior.callRpc("navigationBadge", null)).toEqual({ count: 0, critical: 0 });
    await expect(harness.behavior.callRpc("signals", { repository: "acme/unknown" })).rejects.toThrow("not configured");
    // A range cuts the job-level numbers from memory (no GitHub calls), keeps open signals and reports the history coverage.
    const calls = fetchMock.mock.calls.length;
    const ranged = async (range: object) => (await harness.behavior.callRpc("signals", { repository: "acme/widgets", ...range }) as SignalsResult).repositories[0] as SignalsResult["repositories"][number] & { coverage?: string | null };
    const inside = await ranged({ since: "2026-10-19T00:00:00Z", until: "2026-10-20T00:00:00Z" });
    expect(inside).toMatchObject({ failureCounts: { runner_loss: 2 }, coverage: "2026-10-19T12:00:00Z" });
    const outside = await ranged({ since: "2026-10-20T00:00:00Z", until: "2026-10-21T00:00:00Z" });
    expect(outside).toMatchObject({ failureCounts: { runner_loss: 0 }, failures: [], coverage: "2026-10-19T12:00:00Z" });
    expect(outside.signals.filter((item) => item.open)).toHaveLength(2);
    expect(fetchMock.mock.calls.length).toBe(calls);
  } finally { await harness.lifecycle.dispose(); }
});

test("signals settings keep job data and caches while dashboard settings still clear cached GitHub data", async () => {
  const { bb, harness } = signalsHost();
  try {
    await plugin(bb);
    const database = bb.storage.database();
    database.prepare("INSERT INTO ci_jobs VALUES ('acme/widgets', 1, 1, 1, '2026-10-19T12:00:00Z', NULL, 'failure', 'sha', '{}')").run();
    database.prepare("INSERT INTO github_responses (cache_key, data, checked_at, last_used_at) VALUES ('k', '{}', 1, 1)").run();
    await harness.behavior.setSettings({ stallMinutes: 20, actorLead: "Tech lead" });
    expect(database.prepare("SELECT COUNT(*) AS n FROM github_responses WHERE cache_key = 'k'").get()).toEqual({ n: 1 });
    expect((await harness.behavior.callRpc("signals", null) as SignalsResult).actors.lead).toBe("Tech lead");
    await harness.behavior.setSettings({ refreshSeconds: 60 });
    expect(database.prepare("SELECT COUNT(*) AS n FROM github_responses").get()).toEqual({ n: 0 });
    expect(database.prepare("SELECT COUNT(*) AS n FROM ci_jobs").get()).toEqual({ n: 1 });
  } finally { await harness.lifecycle.dispose(); }
});

// --- performance: stable history keys, rare revalidation, cheap probes, compressed writes ---
const DAY = 86_400_000;
const historyHost = (from = "2026-10-01T00:00:00.000Z") => {
  const normal = fetchMock.getMockImplementation()!;
  const step = DAY / 400, start = Date.parse(from);
  const runs = Array.from({ length: Math.floor((Date.parse("2026-10-20T12:00:00Z") - start) / step) }, (_, index) => ({ id: index + 1, created_at: new Date(start + index * step).toISOString(), conclusion: "success" }));
  fetchMock.mockImplementation(async (input: string, options?: RequestInit) => {
    const url = new URL(input);
    if (!url.pathname.endsWith("/actions/runs")) return normal(input, options);
    const [since, until] = url.searchParams.get("created")!.split("..").map(Date.parse);
    const selected = runs.filter((run) => Date.parse(run.created_at) >= since && Date.parse(run.created_at) <= until).reverse();
    const per = Number(url.searchParams.get("per_page")), page = Number(url.searchParams.get("page"));
    return Response.json({ total_count: Math.min(2500, selected.length), workflow_runs: selected.slice((page - 1) * per, page * per) },
      page * per < selected.length ? { headers: { link: '<https://api.github.com/next>; rel="next"' } } : undefined);
  });
  return { runs, from };
};
async function historyCycle(from: string, state: { records?: HistoricalRecords; checked: Map<string, number>; until?: string }) {
  const until = new Date().toISOString();
  let records: HistoricalRecords | undefined;
  fetchMock.mockClear();
  await loadMetrics("acme/widgets", "token", new AbortController().signal, resolveRange(null), undefined, (value) => { records = value; }, {
    partitionCi: true, previous: state.records, historyRange: { since: from, until, label: "repository history", bucketMs: DAY },
    reuse: { coverage: { since: from, until: state.until ?? until }, checked: state.checked },
  });
  const urls = fetchMock.mock.calls.map(([url]) => new URL(url)).filter((url) => url.pathname.endsWith("/actions/runs"));
  Object.assign(state, { records: records!, until });
  return { records: records!, until, urls, keys: new Set(urls.map((url) => url.search)), ends: urls.map((url) => url.searchParams.get("created")!.split("..")[1]) };
}

test("only windows ending at now change cache keys between cycles, so closed history revalidates with 304s", async () => {
  const { runs, from } = historyHost();
  const state = { checked: new Map<string, number>() };
  const first = await historyCycle(from, state);
  expect(first.records.runs).toHaveLength(runs.length);
  vi.setSystemTime(Date.now() + 300_000);
  const second = await historyCycle(from, state);
  expect(second.records.runs).toHaveLength(runs.length);
  const fresh = second.urls.filter((url) => !first.keys.has(url.search));
  // Weekly windows used to end at `now` for the open week, so every split point and page moved each cycle.
  expect(fresh.every((url) => url.searchParams.get("created")!.endsWith(`..${second.until}`))).toBe(true);
  expect(fresh.length).toBeLessThanOrEqual(5);
});

test("windows older than 48 h are revalidated hourly and recent ones every cycle, without losing runs", async () => {
  const { runs, from } = historyHost();
  const state = { checked: new Map<string, number>() };
  await historyCycle(from, state);
  const old = (cycle: { ends: string[]; until: string }) => cycle.ends.filter((end) => Date.parse(end) < Date.parse(cycle.until) - 2 * DAY);
  vi.setSystemTime(Date.now() + 300_000);
  const second = await historyCycle(from, state);
  expect(old(second)).toHaveLength(0);
  expect(second.ends.length).toBeGreaterThan(0);
  expect(second.records.runs).toHaveLength(runs.length);
  vi.setSystemTime(Date.now() + 3_600_000);
  const third = await historyCycle(from, state);
  expect(old(third).length).toBeGreaterThan(0);
  expect(third.records.runs).toHaveLength(runs.length);
});

test("once history is known to be large, the total_count probe asks for one row instead of a full page", async () => {
  const { from } = historyHost();
  const state = { checked: new Map<string, number>() };
  const range = (cycle: Awaited<ReturnType<typeof historyCycle>>) => cycle.urls.filter((url) => url.searchParams.get("created") === `${from}..${cycle.until}`);
  const cold = await historyCycle(from, state);
  expect(range(cold).map((url) => url.searchParams.get("per_page"))).toContain("100");
  vi.setSystemTime(Date.now() + 300_000);
  const warm = await historyCycle(from, state);
  expect(range(warm).map((url) => url.searchParams.get("per_page"))).toEqual(["1"]);
});

test("history rows are stored compressed, legacy JSON text stays readable, and repeated cycles write far fewer bytes", async () => {
  const normal = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input: string, options?: RequestInit) => {
    if (!new URL(input).pathname.endsWith("/actions/runs")) return normal(input, options);
    const page = Number(new URL(input).searchParams.get("page"));
    return Response.json({ total_count: 800, workflow_runs: Array.from({ length: 100 }, (_, index) => {
      const id = (page - 1) * 100 + index + 1;
      return { id, created_at: recent, conclusion: id % 9 ? "success" : "failure", workflow_id: 42, name: "CI", head_branch: "main", event: "push", run_started_at: recent, updated_at: recent, run_attempt: 1, head_sha: `sha${id}`, pull_requests: [] };
    }) }, page < 8 ? { headers: { link: '<https://api.github.com/next>; rel="next"' } } : undefined);
  });
  const { bb, harness } = createFakePluginHost({ settings: { repository: "acme/widgets", importBbRepositories: false } });
  try {
    await plugin(bb);
    const database = bb.storage.database();
    let plain = 0, stored = 0;
    const prepare = database.prepare.bind(database);
    vi.spyOn(database, "prepare").mockImplementation(((text: string) => {
      const statement = prepare(text), run = statement.run.bind(statement);
      if (/^(INSERT INTO (repository_history|dashboard_snapshots)|UPDATE repository_history SET data)/.test(text)) statement.run = ((...args: unknown[]) => {
        for (const arg of args) {
          if (arg instanceof Uint8Array) { stored += arg.length; plain += gunzipSync(arg).length; }
          else if (typeof arg === "string") { stored += Buffer.byteLength(arg); plain += Buffer.byteLength(arg); }
        }
        return run(...args);
      }) as typeof statement.run;
      return statement;
    }) as typeof database.prepare);
    for (let cycle = 0; cycle < 3; cycle++) {
      vi.setSystemTime(Date.now() + 301_000);
      await harness.behavior.callRpc("metrics", null);
    }
    expect(stored * 4).toBeLessThan(plain);
    const row = database.prepare("SELECT typeof(data) AS data FROM repository_history").get();
    expect(row).toEqual({ data: "blob" });
    expect(database.prepare("SELECT typeof(history) AS history FROM dashboard_snapshots").get()).toEqual({ history: "blob" });
    // A legacy plain-JSON row is still read: the range snapshot is rebuilt from it without GitHub.
    const legacy = unpack((database.prepare("SELECT data FROM repository_history").get() as { data: Buffer }).data);
    database.prepare("UPDATE repository_history SET data = ?").run(JSON.stringify(legacy));
    database.prepare("UPDATE dashboard_snapshots SET history = ?").run(JSON.stringify({ "acme/widgets": legacy.records }));
    database.prepare("DELETE FROM dashboard_snapshots").run();
    fetchMock.mockClear();
    expect(await harness.behavior.callRpc("snapshot", { days: 3 })).toMatchObject({ repositories: [{ repository: "acme/widgets" }] });
    expect(fetchMock).not.toHaveBeenCalled();
  } finally { await harness.lifecycle.dispose(); }
});

test("a contained range served from fresh history does not rewrite the stored history", async () => {
  const { bb, harness } = createFakePluginHost({ settings: { repository: "acme/widgets", importBbRepositories: false } });
  try {
    await plugin(bb);
    const database = bb.storage.database();
    const sql: string[] = [];
    const prepare = database.prepare.bind(database);
    vi.spyOn(database, "prepare").mockImplementation(((text: string) => (sql.push(text), prepare(text))) as typeof database.prepare);
    await harness.behavior.callRpc("metrics", { days: 90 });
    expect(sql.filter((text) => text.startsWith("INSERT INTO repository_history"))).toHaveLength(1);
    await harness.behavior.callRpc("metrics", { days: 7 });
    expect(sql.filter((text) => text.startsWith("UPDATE repository_history SET data"))).toHaveLength(0);
  } finally { await harness.lifecycle.dispose(); }
});

test("the interval popup is answered from stored history inside its coverage and only falls back to GitHub outside it", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "delivery-dashboard", settings: { repository: "acme/widgets", importBbRepositories: false } });
  const input = { repository: "acme/widgets", since: "2026-10-19T00:00:00.000Z", until: "2026-10-19T23:59:59.999Z" };
  try {
    await plugin(bb);
    await harness.behavior.callRpc("metrics", { days: 90 });
    fetchMock.mockClear();
    expect(await harness.behavior.callRpc("interval", input)).toMatchObject({ repository: "acme/widgets", range: { since: input.since, until: input.until }, ci: { value: 80 }, commitActivity: { commits: 2 }, pullRequestsCreated: { value: 9 } });
    // Only the interval-specific created-PR count needs GitHub.
    expect(fetchMock.mock.calls.map(([url]) => new URL(url)).map((url) => `${url.pathname}${url.searchParams.get("q")?.includes("created:") ? "?created" : ""}`)).toEqual(["/search/issues?created"]);
    fetchMock.mockClear();
    await harness.behavior.callRpc("interval", { ...input, since: "2026-07-01T00:00:00.000Z" });
    expect(fetchMock.mock.calls.some(([url]) => new URL(url).pathname.endsWith("/actions/runs"))).toBe(true);
  } finally { await harness.lifecycle.dispose(); }
});

test("a forced refresh right after a full collection returns it instead of collecting again", async () => {
  const { bb, harness } = createFakePluginHost({ settings: { repository: "acme/widgets", importBbRepositories: false } });
  try {
    await plugin(bb);
    const force = { selection: { days: 7 }, force: true } as const;
    const first = await harness.behavior.callRpc("metrics", force);
    const requests = fetchMock.mock.calls.length;
    expect(await harness.behavior.callRpc("metrics", force)).toEqual(first);
    expect(fetchMock.mock.calls).toHaveLength(requests);
    vi.setSystemTime(Date.now() + 61_000);
    await harness.behavior.callRpc("metrics", force);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(requests);
  } finally { await harness.lifecycle.dispose(); }
});

test("startup removes cache rows that can never be read again and logs the count", async () => {
  const { bb, harness } = createFakePluginHost({ settings: { repository: "acme/widgets", importBbRepositories: false } });
  try {
    await plugin(bb);
    const path = "/repos/acme/widgets/actions/runs?created=2026-10-01T00%3A00%3A00.000Z..2026-10-20T11%3A47%3A23.412Z&status=completed&per_page=100&page=1";
    const insert = (scope: string, checked: number) => bb.storage.database().prepare("INSERT INTO github_responses (cache_key, data, checked_at, last_used_at) VALUES (?, '{}', ?, ?)").run(JSON.stringify([scope, path]), checked, checked);
    insert("config:ci-metadata-v2", Date.now());
    insert("config:ci-metadata-v3", Date.now() - 2 * 3_600_000);
    insert("other:ci-metadata-v3", Date.now());
    const reloaded = await harness.lifecycle.reload(plugin);
    expect(reloaded.bb.storage.database().prepare("SELECT cache_key FROM github_responses").all().map((row) => (JSON.parse((row as { cache_key: string }).cache_key) as string[])[0])).toEqual(["other:ci-metadata-v3"]);
    expect(reloaded.harness.inspection.logEntries).toEqual(expect.arrayContaining([expect.objectContaining({ message: "Purged 2 unreachable cached GitHub responses." })]));
  } finally { await harness.lifecycle.dispose(); }
});

// --- ci-signals: analysis cadence, persisted view, badge payload ---
const resultWrites = (kv: { set: unknown }) => vi.mocked(kv.set as (key: string, value: unknown) => Promise<void>).mock.calls.filter(([key]) => key === "result:acme/widgets").length;
async function signalsPass(harness: ReturnType<typeof signalsHost>["harness"], advance = 61_000) {
  const before = await updatedAt(harness);
  vi.setSystemTime(new Date(Date.now() + advance));
  const service = harness.behavior.runService("ci-signals");
  await vi.waitFor(async () => expect(await updatedAt(harness)).not.toBe(before));
  service.controller.abort(); await service.done;
}

test("the analysis is recomputed every five minutes even while the backfill keeps storing rows", async () => {
  const job = (id: number) => ({ id, name: "Unit tests", status: "completed", conclusion: "success", created_at: "2026-10-19T12:00:00Z", started_at: "2026-10-19T12:01:00Z", completed_at: "2026-10-19T12:05:00Z", labels: ["self-hosted"], runner_name: "runner-1", runner_group_name: null, steps: [] });
  live([], Object.fromEntries(Array.from({ length: 10 }, (_, index) => [[`/repos/acme/widgets/actions/runs/${index + 1}/attempts/1/jobs`, () => ({ jobs: [job((index + 1) * 10)] })], [`/repos/acme/widgets/check-runs/${(index + 1) * 10}/annotations`, () => []]]).flat()));
  const { bb, harness } = createFakePluginHost({ pluginId: "delivery-dashboard", settings: { repository: "acme/widgets", importBbRepositories: false, jobBudgetPerHour: 100 } });
  const set = vi.spyOn(bb.storage.kv, "set");
  try {
    await plugin(bb);
    await harness.behavior.callRpc("metrics", { days: 7 });
    await signalsPass(harness, 0);
    expect(resultWrites(bb.storage.kv)).toBe(1);
    const database = bb.storage.database();
    const stored = () => (database.prepare("SELECT COUNT(*) AS n FROM ci_jobs").get() as { n: number }).n;
    const afterFirst = stored();
    await signalsPass(harness);
    expect(stored()).toBeGreaterThan(afterFirst);
    // Rows were stored again, but the minute-old analysis is reused and the stored view is untouched.
    expect(resultWrites(bb.storage.kv)).toBe(1);
    await signalsPass(harness, 301_000);
    expect(resultWrites(bb.storage.kv)).toBe(2);
    expect(set).toHaveBeenCalled();
  } finally { await harness.lifecycle.dispose(); }
});

test("pool-only changes publish the badge numbers but do not rewrite the stored view", async () => {
  live([queuedJob]);
  const { bb, harness } = signalsHost();
  vi.spyOn(bb.storage.kv, "set");
  try {
    await plugin(bb);
    await signalsPass(harness, 0);
    expect(resultWrites(bb.storage.kv)).toBe(1);
    live([queuedJob, { ...queuedJob, id: 9002 }]);
    await signalsPass(harness);
    const pools = ((await harness.behavior.callRpc("signals", null)) as SignalsResult).repositories[0].live.pools;
    expect(pools[0].queued).toBe(2);
    expect(resultWrites(bb.storage.kv)).toBe(1);
    const published = harness.inspection.realtimeSignals.filter((signal) => signal.channel === "signals-changed");
    expect(published.length).toBeGreaterThanOrEqual(2);
    for (const signal of published) expect(signal.payload).toEqual({ count: 1, critical: 1 });
    expect(await harness.behavior.callRpc("navigationBadge", null)).toEqual({ count: 1, critical: 1 });
  } finally { await harness.lifecycle.dispose(); }
});

// --- problems: handled state, badge, hand-off to BB sessions ---
const linkedProject = { id: "proj-1", name: "Widgets", kind: "standard", gitRemoteUrl: "git@github.com:acme/widgets.git", createdAt: 0, updatedAt: 0, sources: [] };
function problemsHost(linked = true) {
  const spawn = vi.fn(async (_args: unknown) => ({ id: "thr_new" })), send = vi.fn(async (_args: unknown) => ({}));
  const host = createFakePluginHost({ pluginId: "delivery-dashboard", settings: { repository: "acme/widgets", importBbRepositories: linked },
    sdk: { projects: { list: async () => [linkedProject] }, threads: { spawn, send } as never, plugins: { callRpc: (async () => ({ ok: true })) as never } } });
  return { ...host, spawn, send };
}
type ProblemsResult = { repositories: { projectId: string | null; problems: { id: string; severity: string; title: string; handled: { state: string; threadId?: string } | null }[] }[] };
const problemsOf = async (harness: { behavior: { callRpc(method: string, input?: unknown): Promise<unknown> } }) => (await harness.behavior.callRpc("signals", null) as ProblemsResult).repositories[0];
async function stalledPass(harness: ReturnType<typeof problemsHost>["harness"]) {
  const service = harness.behavior.runService("ci-signals");
  await vi.waitFor(async () => expect((await problemsOf(harness)).problems).toHaveLength(1));
  service.controller.abort(); await service.done;
}
const stallId = "pool_stall:self-hosted";

test("dismissing and restoring a problem moves the badge, publishes the new counts and survives a reload", async () => {
  live([queuedJob]);
  const { bb, harness } = problemsHost();
  try {
    await plugin(bb);
    await stalledPass(harness);
    expect(await problemsOf(harness)).toMatchObject({ projectId: "proj-1", problems: [{ id: stallId, severity: "critical", title: "Runner pool stalled: self-hosted", handled: null }] });
    expect(await harness.behavior.callRpc("navigationBadge", null)).toEqual({ count: 1, critical: 1 });
    await expect(harness.behavior.callRpc("problemAction", { repository: "acme/widgets", id: "flake:nothing", action: "dismiss" })).rejects.toThrow("no longer open");
    await expect(harness.behavior.callRpc("problemAction", { repository: "acme/unknown", id: stallId, action: "dismiss" })).rejects.toThrow("not configured");
    await harness.behavior.callRpc("problemAction", { repository: "acme/widgets", id: stallId, action: "dismiss" });
    expect((await problemsOf(harness)).problems[0].handled).toMatchObject({ state: "dismissed" });
    expect(await harness.behavior.callRpc("navigationBadge", null)).toEqual({ count: 0, critical: 0 });
    expect(harness.inspection.realtimeSignals.filter((signal) => signal.channel === "signals-changed").at(-1)?.payload).toEqual({ count: 0, critical: 0 });
    // The handled state is read from storage after a restart.
    const reloaded = (await harness.lifecycle.reload(plugin)).harness;
    expect(await reloaded.behavior.callRpc("navigationBadge", null)).toEqual({ count: 0, critical: 0 });
    await reloaded.behavior.callRpc("problemAction", { repository: "acme/widgets", id: stallId, action: "restore" });
    expect((await problemsOf(reloaded)).problems[0].handled).toBeNull();
    expect(await reloaded.behavior.callRpc("navigationBadge", null)).toEqual({ count: 1, critical: 1 });
    expect(reloaded.inspection.realtimeSignals.filter((signal) => signal.channel === "signals-changed").at(-1)?.payload).toEqual({ count: 1, critical: 1 });
  } finally { await harness.lifecycle.dispose(); }
});

test("investigate without a thread spawns a session in the linked project with a seed prompt and marks the problem investigating", async () => {
  live([queuedJob]);
  const { bb, harness, spawn, send } = problemsHost();
  try {
    await plugin(bb);
    await stalledPass(harness);
    expect(await harness.behavior.callRpc("investigate", { repository: "acme/widgets", id: stallId })).toEqual({ threadId: "thr_new" });
    expect(send).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
    const args = spawn.mock.calls[0][0] as { projectId: string; title: string; prompt: string; providerId?: string; model?: string };
    expect(args).toMatchObject({ projectId: "proj-1", title: "Investigate: Runner pool stalled: self-hosted" });
    expect(args.providerId).toBeUndefined(); expect(args.model).toBeUndefined();
    for (const fact of ["Problem: Runner pool stalled: self-hosted (critical)", "What happened:", "Impact:", "- Repository: acme/widgets", "- Pool: self-hosted", "Since: 2026-10-20T11:40:00.000Z",
      "ci_dashboard_metrics tool (view: signals | stall | losses | failures | reruns, or ref=<ref>", "## Refs", "drill down with ci_dashboard_metrics ref=<ref>: pool:self-hosted", "bb plugin rpc call delivery-dashboard ci", "## Pool stall", "Queued runs:", "Find the root cause and report back.",
      "Do not re-run workflows, cancel runs or change CI configuration unless the owner asks."]) expect(args.prompt).toContain(fact);
    expect((await problemsOf(harness)).problems[0].handled).toMatchObject({ state: "investigating", threadId: "thr_new" });
    expect(await harness.behavior.callRpc("navigationBadge", null)).toEqual({ count: 0, critical: 0 });
    const agent = await harness.behavior.callRpc("ci", { view: "signals" }) as { repositories: { problems: { id: string; handled: unknown }[] }[] };
    expect(agent.repositories[0].problems).toMatchObject([{ id: stallId, handled: { state: "investigating", threadId: "thr_new" } }]);
  } finally { await harness.lifecycle.dispose(); }
});

test("investigate on a job problem sends the stored job evidence and makes no GitHub request", async () => {
  live([], Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`/repos/acme/widgets/actions/runs/${index + 1}/attempts/1/jobs`, () => ({ jobs: [] })])));
  const { bb, harness, spawn } = problemsHost();
  try {
    await plugin(bb);
    await harness.behavior.callRpc("metrics", { days: 7 });
    const synthetic = (jobId: number, completedAt: string, over: object = {}) => ({ repository: "acme/widgets", runId: 500 + jobId, attempt: 1, jobId, workflowName: "CI", jobName: "Build", event: "push", headBranch: "main", headSha: "abc123", pullRequests: [7],
      status: "completed", conclusion: "failure", labels: ["self-hosted"], pool: "self-hosted", runnerName: "runner-a", runnerGroup: "default", createdAt: "2026-10-20T10:50:00Z", startedAt: "2026-10-20T10:51:00Z", completedAt,
      failedSteps: [], annotations: [{ level: "failure" as const, title: "", message: "The runner has received a shutdown signal: synthetic detail" }], logExcerpt: "log line alpha\nlog line beta", carried: false, ...over });
    const store = createJobStore(bb.storage.database());
    store.saveAttempt("acme/widgets", 501, 1, [synthetic(1, "2026-10-20T11:30:00Z")], true);
    store.saveAttempt("acme/widgets", 502, 1, [synthetic(2, "2026-10-20T11:00:00Z")], true);
    const service = harness.behavior.runService("ci-signals");
    await vi.waitFor(async () => expect((await problemsOf(harness)).problems.map((problem) => problem.id)).toContain("runner_loss:1"));
    service.controller.abort(); await service.done;
    await harness.behavior.setSettings({ investigateNotes: "Rerun limit: once per commit.\nIncident log: https://example.invalid/incidents" });
    const requests = fetchMock.mock.calls.length;
    await harness.behavior.callRpc("investigate", { repository: "acme/widgets", id: "runner_loss:1" });
    expect(fetchMock.mock.calls.length).toBe(requests);
    const { prompt } = spawn.mock.calls[0][0] as { prompt: string };
    for (const fact of ["Problem id: runner_loss:1", "Job URL: https://github.com/acme/widgets/actions/runs/501/job/1", "synthetic detail", "| log line alpha", "| log line beta", "Classification: runner_loss",
      'Runner losses on runner runner-a: 2', "Live pool poll", "gh run view <runId> --repo acme/widgets --log-failed",
      "Code looks broken: no", "- runner_loss: let the next run supersede it", "/day)", "- production: ref main", "## Team notes\nRerun limit: once per commit.\nIncident log: https://example.invalid/incidents"]) expect(prompt).toContain(fact);
    expect(prompt.indexOf("## Verdict")).toBeLessThan(prompt.indexOf("## Problem"));
    expect(prompt.length).toBeLessThanOrEqual(12_000);
  } finally { await harness.lifecycle.dispose(); }
});

test("investigate with a thread sends the seed prompt to it, queueing when it is busy", async () => {
  live([queuedJob]);
  const { bb, harness, spawn, send } = problemsHost();
  try {
    await plugin(bb);
    await stalledPass(harness);
    expect(await harness.behavior.callRpc("investigate", { repository: "acme/widgets", id: stallId, threadId: "thr_existing" })).toEqual({ threadId: "thr_existing" });
    expect(spawn).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith({ threadId: "thr_existing", mode: "queue-if-active", input: [{ type: "text", text: expect.stringContaining("Problem: Runner pool stalled: self-hosted"), mentions: [] }] });
    expect((await problemsOf(harness)).problems[0].handled).toMatchObject({ state: "investigating", threadId: "thr_existing" });
    // A failed send leaves the problem unhandled.
    await harness.behavior.callRpc("problemAction", { repository: "acme/widgets", id: stallId, action: "restore" });
    send.mockRejectedValueOnce(new Error("thread is gone"));
    await expect(harness.behavior.callRpc("investigate", { repository: "acme/widgets", id: stallId, threadId: "thr_gone" })).rejects.toThrow("thread is gone");
    expect((await problemsOf(harness)).problems[0].handled).toBeNull();
  } finally { await harness.lifecycle.dispose(); }
});

test("a repository without a linked BB project cannot start a new session but can use an existing one", async () => {
  live([queuedJob]);
  const { bb, harness, spawn, send } = problemsHost(false);
  try {
    await plugin(bb);
    await stalledPass(harness);
    expect((await problemsOf(harness)).projectId).toBeNull();
    await expect(harness.behavior.callRpc("investigate", { repository: "acme/widgets", id: stallId })).rejects.toThrow("No BB project is linked to acme/widgets");
    expect(spawn).not.toHaveBeenCalled();
    expect((await problemsOf(harness)).problems[0].handled).toBeNull();
    await harness.behavior.callRpc("investigate", { repository: "acme/widgets", id: stallId, threadId: "thr_existing" });
    expect(send).toHaveBeenCalledTimes(1);
  } finally { await harness.lifecycle.dispose(); }
});

test("handled entries are pruned once their problem closes, and the stored map is capped at 200", async () => {
  live([queuedJob]);
  const { bb, harness } = problemsHost();
  try {
    await plugin(bb);
    await stalledPass(harness);
    const stored = Object.fromEntries(Array.from({ length: 205 }, (_, index) => [`old:${index}`, { state: "dismissed", at: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString() }]));
    await bb.storage.kv.set("handled:acme/widgets", stored);
    const reloaded = await harness.lifecycle.reload(plugin);
    await reloaded.harness.behavior.callRpc("problemAction", { repository: "acme/widgets", id: stallId, action: "dismiss" });
    const kept = (await reloaded.bb.storage.kv.get<Record<string, unknown>>("handled:acme/widgets"))!;
    expect(Object.keys(kept)).toHaveLength(200);
    expect(kept[stallId]).toBeDefined(); expect(kept["old:0"]).toBeUndefined();
    // The pool recovers: the next pass closes the incident and drops every entry whose problem is no longer open.
    live([]);
    const before = await updatedAt(reloaded.harness);
    vi.setSystemTime(new Date(Date.now() + 61_000));
    const service = reloaded.harness.behavior.runService("ci-signals");
    await vi.waitFor(async () => expect(await updatedAt(reloaded.harness)).not.toBe(before));
    service.controller.abort(); await service.done;
    expect((await problemsOf(reloaded.harness)).problems).toEqual([]);
    expect(await reloaded.bb.storage.kv.get("handled:acme/widgets")).toEqual({});
  } finally { await harness.lifecycle.dispose(); }
});

// --- agent claims: ci_dashboard_manage, automatic releases, observer echo ---
function claimsHost(settings: object = {}) {
  const send = vi.fn(async (_args: unknown) => ({}));
  const get = vi.fn(async ({ threadId }: { threadId: string }): Promise<{ id: string; archivedAt: number | null }> => {
    if (threadId === "thr_missing") throw new Error("404 thread not found");
    return { id: threadId, archivedAt: threadId === "thr_archived" ? 1 : null };
  });
  const host = createFakePluginHost({ pluginId: "delivery-dashboard", settings: { repository: "acme/widgets", importBbRepositories: false, observerThreads: "thr_observer", ...settings },
    sdk: { threads: { send, get } as never, plugins: { callRpc: (async () => ({ ok: true })) as never } } });
  return { ...host, send, get };
}
const STALL_TITLE = "Runner pool stalled: self-hosted";
const claimTool = async (harness: { behavior: { callAgentTool(name: string, input: unknown, context?: { threadId: string }): Promise<unknown> } }, input: object, threadId = "thr_manager") =>
  JSON.parse(await harness.behavior.callAgentTool("ci_dashboard_manage", { id: stallId, ...input }, { threadId }) as string) as { repository: string; id: string; handled: Record<string, unknown> | null };
const observerLines = (send: { mock: { calls: unknown[][] } }) => sentTo(send, "thr_observer");

test("ci_dashboard_manage problem actions: take (default and delegated thread), fix_pending, release and dismiss change the status and are not echoed to observers", async () => {
  live([queuedJob]);
  const { bb, harness, send } = claimsHost();
  try {
    await plugin(bb);
    await stalledPass(harness);
    // The observer line for the stall names the problem id the agent can claim.
    const lines = observerLines(send);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(new RegExp(`^\\*\\*CI Dashboard\\*\\* Pool self-hosted stalled · 1 queued, no job start for \\d+ min · problem \`${stallId}\` · inspect \`pool:self-hosted\`$`));
    expect(lines[1].length).toBeLessThanOrEqual(400);
    expect(await harness.behavior.callRpc("navigationBadge", null)).toEqual({ count: 1, critical: 1 });
    // take defaults to the calling thread ...
    expect(await claimTool(harness, { action: "take" })).toEqual({ repository: "acme/widgets", id: stallId, handled: { state: "investigating", threadId: "thr_manager", by: "agent", at: expect.any(String) } });
    expect(await harness.behavior.callRpc("navigationBadge", null)).toEqual({ count: 0, critical: 0 });
    // ... or the worker the caller delegates to.
    expect((await claimTool(harness, { action: "take", threadId: "thr_worker" })).handled).toMatchObject({ state: "investigating", threadId: "thr_worker", by: "agent" });
    // fix_pending needs a ref and keeps the worker thread when none is passed.
    await expect(claimTool(harness, { action: "fix_pending" })).rejects.toThrow("needs ref");
    await expect(claimTool(harness, { action: "fix_pending", ref: "x".repeat(81) })).rejects.toThrow();
    expect((await claimTool(harness, { action: "fix_pending", ref: "#12" })).handled).toMatchObject({ state: "fix_pending", ref: "#12", threadId: "thr_worker", by: "agent" });
    expect((await claimTool(harness, { action: "fix_pending", ref: "FIX-1", threadId: "thr_other" })).handled).toMatchObject({ ref: "FIX-1", threadId: "thr_other" });
    // The agent read path carries the new state and ref.
    const agent = await harness.behavior.callRpc("ci", { view: "signals" }) as { repositories: { problems: { id: string; handled: unknown }[] }[] };
    expect(agent.repositories[0].problems).toMatchObject([{ id: stallId, handled: { state: "fix_pending", ref: "FIX-1" } }]);
    expect((await problemsOf(harness)).problems[0].handled).toMatchObject({ state: "fix_pending", ref: "FIX-1" });
    expect((await claimTool(harness, { action: "release" })).handled).toBeNull();
    expect((await problemsOf(harness)).problems[0].handled).toBeNull();
    expect((await claimTool(harness, { action: "dismiss" })).handled).toMatchObject({ state: "dismissed", by: "agent" });
    // Refusals: archived or unknown threads, a bad id, an unknown or closed problem, an unknown repository.
    await expect(claimTool(harness, { action: "take", threadId: "thr_archived" })).rejects.toThrow("archived");
    await expect(claimTool(harness, { action: "take", threadId: "thr_missing" })).rejects.toThrow("does not exist");
    await expect(claimTool(harness, { action: "take", threadId: "not-a-thread" })).rejects.toThrow("not a BB thread id");
    await expect(claimTool(harness, { action: "take", id: "flake:nothing" })).rejects.toThrow("flake:nothing is not open");
    await expect(claimTool(harness, { action: "release", id: "flake:nothing" })).rejects.toThrow("is not open");
    await expect(claimTool(harness, { action: "take", repository: "acme/unknown" })).rejects.toThrow("not configured");
    expect((await problemsOf(harness)).problems[0].handled).toMatchObject({ state: "dismissed" });
    // Nothing the agent did reached the observer.
    expect(observerLines(send)).toHaveLength(2);
  } finally { await harness.lifecycle.dispose(); }
});

test("ci_dashboard_manage problem actions need a repository only when several are configured", async () => {
  live([queuedJob]);
  const { bb, harness } = claimsHost({ repository: "acme/widgets, acme/gadgets" });
  try {
    await plugin(bb);
    await expect(claimTool(harness, { action: "take" })).rejects.toThrow("Several repositories are configured; pass repository");
  } finally { await harness.lifecycle.dispose(); }
});

test("ci_dashboard_metrics ref=...: drills down from the local store, ignores view, and rejects unknown refs and ambiguous repositories", async () => {
  live([queuedJob]);
  const { bb, harness } = claimsHost();
  try {
    await plugin(bb);
    await stalledPass(harness);
    const ref = async (value: string, extra: object = {}) => JSON.parse(await harness.behavior.callAgentTool("ci_dashboard_metrics", { ref: value, ...extra }) as string);
    const problem = await ref(stallId, { view: "failures" });
    expect(problem).toMatchObject({ ref: stallId, kind: "problem", next: [`ci_dashboard_manage action=take id=${stallId}`], related: expect.arrayContaining(["pool:self-hosted"]) });
    expect(JSON.stringify(problem).length).toBeLessThanOrEqual(4096);
    expect(await ref("pool:self-hosted")).toMatchObject({ kind: "pool", facts: { queued: 1, openStall: true } });
    expect(await harness.behavior.callRpc("ci", { ref: "pool:self-hosted" })).toMatchObject({ kind: "pool" });
    await expect(ref("job:1")).rejects.toThrow("Job 1 is not known");
    await expect(ref("whatever")).rejects.toThrow(/Accepted forms: job:<jobId>/);
    // The index view hands out the same refs the drill-down accepts.
    expect((JSON.parse(await harness.behavior.callAgentTool("ci_dashboard_metrics", { view: "problems" }) as string).repositories[0].problems[0])).toMatchObject({ id: stallId, refs: ["pool:self-hosted"] });
  } finally { await harness.lifecycle.dispose(); }
  const several = claimsHost({ repository: "acme/widgets, acme/gadgets" });
  try {
    await plugin(several.bb);
    await expect(several.harness.behavior.callAgentTool("ci_dashboard_metrics", { ref: "pool:self-hosted" })).rejects.toThrow("Several repositories are configured; pass repository");
  } finally { await several.harness.lifecycle.dispose(); }
});

test("ci_dashboard_manage is the only write tool: problem actions need an id, and the old tool names are gone", async () => {
  live([queuedJob]);
  const { bb, harness } = claimsHost();
  try {
    await plugin(bb);
    await stalledPass(harness);
    await expect(harness.behavior.callAgentTool("ci_dashboard_manage", { action: "take" }, { threadId: "thr_manager" })).rejects.toThrow("action=take needs id");
    await expect(harness.behavior.callAgentTool("ci_dashboard_manage", { action: "bogus" }, { threadId: "thr_manager" })).rejects.toThrow();
    expect(JSON.parse(await harness.behavior.callAgentTool("ci_dashboard_manage", { action: "list" }, { threadId: "thr_manager" }) as string)).toMatchObject({ observerThreads: ["thr_observer"] });
    for (const old of ["ci_dashboard_problem", "ci_dashboard_observe"]) await expect(harness.behavior.callAgentTool(old, { action: "list" })).rejects.toThrow();
  } finally { await harness.lifecycle.dispose(); }
});

test("an archived or deleted investigating thread releases its claim with exactly one echo; fix_pending claims and other threads are untouched", async () => {
  live([queuedJob]);
  const { bb, harness, send } = claimsHost();
  try {
    await plugin(bb);
    await stalledPass(harness);
    const echoes = () => observerLines(send).filter((line) => line.includes("Claim dropped"));
    await claimTool(harness, { action: "take", threadId: "thr_worker" });
    expect((await harness.behavior.emitThreadEvent("thread.archived", { thread: makeThreadResponse({ id: "thr_unrelated" }) })).errors).toEqual([]);
    expect((await problemsOf(harness)).problems[0].handled).toMatchObject({ state: "investigating" });
    expect(echoes()).toEqual([]);
    expect((await harness.behavior.emitThreadEvent("thread.archived", { thread: makeThreadResponse({ id: "thr_worker" }) })).errors).toEqual([]);
    expect((await problemsOf(harness)).problems[0].handled).toBeNull();
    expect(echoes()).toEqual([`${PREFIX} Claim dropped · ${STALL_TITLE} · problem \`${stallId}\` · thread archived`]);
    // Archiving it again changes nothing and repeats nothing.
    await harness.behavior.emitThreadEvent("thread.archived", { thread: makeThreadResponse({ id: "thr_worker" }) });
    expect(echoes()).toHaveLength(1);
    // A fix_pending claim outlives the worker thread that opened the PR.
    await claimTool(harness, { action: "fix_pending", ref: "#12", threadId: "thr_worker" });
    await harness.behavior.emitThreadEvent("thread.archived", { thread: makeThreadResponse({ id: "thr_worker" }) });
    expect((await problemsOf(harness)).problems[0].handled).toMatchObject({ state: "fix_pending", ref: "#12" });
    // A deleted thread releases too; the badge counts the problem again.
    await claimTool(harness, { action: "take", threadId: "thr_gone" });
    await harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: "thr_gone" }) });
    expect(echoes()).toEqual([expect.stringContaining("thread archived"), `${PREFIX} Claim dropped · ${STALL_TITLE} · problem \`${stallId}\` · thread deleted`]);
    expect(await harness.behavior.callRpc("navigationBadge", null)).toEqual({ count: 1, critical: 1 });
  } finally { await harness.lifecycle.dispose(); }
});

test("a claim older than claimTimeoutHours is released with one echo; 0 means never", async () => {
  live([queuedJob]);
  const { bb, harness, send } = claimsHost();
  const echoes = () => observerLines(send).filter((line) => line.includes("Claim dropped"));
  try {
    await plugin(bb);
    await stalledPass(harness);
    await claimTool(harness, { action: "take", threadId: "thr_worker" });
    await signalsPass(harness, 23 * 3_600_000);
    expect((await problemsOf(harness)).problems[0].handled).toMatchObject({ state: "investigating" });
    expect(echoes()).toEqual([]);
    await signalsPass(harness, 2 * 3_600_000);
    expect((await problemsOf(harness)).problems[0].handled).toBeNull();
    expect(echoes()).toEqual([`${PREFIX} Claim dropped · ${STALL_TITLE} · problem \`${stallId}\` · no resolution within 24 h`]);
    await signalsPass(harness);
    expect(echoes()).toHaveLength(1);
    // fix_pending expires the same way, counted from its own time.
    await claimTool(harness, { action: "fix_pending", ref: "#12" });
    await signalsPass(harness, 25 * 3_600_000);
    expect((await problemsOf(harness)).problems[0].handled).toBeNull();
    expect(echoes()).toHaveLength(2);
    // 0 = never.
    await harness.behavior.setSettings({ claimTimeoutHours: 0 });
    await claimTool(harness, { action: "take", threadId: "thr_worker" });
    await signalsPass(harness, 100 * 3_600_000);
    expect((await problemsOf(harness)).problems[0].handled).toMatchObject({ state: "investigating" });
    expect(echoes()).toHaveLength(2);
    await expect(harness.behavior.setSettings({ claimTimeoutHours: -1 })).rejects.toThrow();
  } finally { await harness.lifecycle.dispose(); }
});

test("a problem that resolves closes its claim silently", async () => {
  live([queuedJob]);
  const { bb, harness, send } = claimsHost();
  try {
    await plugin(bb);
    await stalledPass(harness);
    await claimTool(harness, { action: "fix_pending", ref: "FIX-1" });
    const before = observerLines(send).length;
    live([]);
    await signalsPass(harness);
    expect((await problemsOf(harness)).problems).toEqual([]);
    expect(await bb.storage.kv.get("handled:acme/widgets")).toEqual({});
    expect(observerLines(send)).toHaveLength(before);
  } finally { await harness.lifecycle.dispose(); }
});

// --- retention ---
const storedHistory = (bb: { storage: { database(): ReturnType<ReturnType<typeof createFakePluginHost>["bb"]["storage"]["database"]> } }) => {
  const row = bb.storage.database().prepare("SELECT data FROM repository_history").get() as { data: Uint8Array };
  return JSON.parse(gunzipSync(row.data).toString("utf8")) as { coverage: { since: string }; records: { runs: { id: number; created_at: string }[] } };
};
async function deepHistory(deepAgoDays: number | null) {
  const { bb, harness } = createFakePluginHost({ settings: { repository: "acme/widgets", importBbRepositories: false } });
  if (deepAgoDays !== null) await bb.storage.kv.set("deep-range-at", Date.now() - deepAgoDays * 86_400_000);
  await plugin(bb);
  await harness.behavior.callRpc("metrics", { days: 90 });
  const db = bb.storage.database(), row = db.prepare("SELECT data FROM repository_history").get() as { data: Uint8Array };
  const history = JSON.parse(gunzipSync(row.data).toString("utf8"));
  history.coverage.since = "2026-01-05T00:00:00.000Z";
  history.records.runs.push({ ...history.records.runs[0], id: 999_999, created_at: "2026-02-01T00:00:00Z" });
  db.prepare("UPDATE repository_history SET data = ?").run(compress(JSON.stringify(history)));
  await harness.behavior.callRpc("metrics", { days: 7 });
  return { bb, harness };
}
test("history deeper than 90 days is trimmed back once no deep range was requested for a week", async () => {
  const { bb, harness } = await deepHistory(8);
  try {
    expect(storedHistory(bb).coverage.since).toBe("2026-07-22T00:00:00.000Z");
    expect(storedHistory(bb).records.runs.some((run) => run.id === 999_999)).toBe(false);
  } finally { await harness.lifecycle.dispose(); }
});
test("deep history is kept while a deep range was requested within the week, and a fresh install gets a full grace period", async () => {
  for (const ago of [2, null]) {
    const { bb, harness } = await deepHistory(ago);
    try {
      expect(storedHistory(bb).coverage.since).toBe("2026-01-05T00:00:00.000Z");
      expect(storedHistory(bb).records.runs.some((run) => run.id === 999_999)).toBe(true);
    } finally { await harness.lifecycle.dispose(); }
  }
});
test("requesting a range older than 90 days renews the deep-history clock, a 90-day preset does not", async () => {
  const { bb, harness } = createFakePluginHost({ settings: { repository: "acme/widgets", importBbRepositories: false } });
  try {
    await plugin(bb);
    const stored = async () => bb.storage.kv.get<number>("deep-range-at");
    await vi.waitFor(async () => expect(await stored()).toBeDefined());
    const first = (await stored())!;
    vi.setSystemTime(new Date(first + 2 * 3_600_000));
    await harness.behavior.callRpc("metrics", { days: 90 });
    expect(await stored()).toBe(first);
    await harness.behavior.callRpc("metrics", { start: "2026-01-10", end: "2026-01-20" });
    expect(await stored()).toBe(first + 2 * 3_600_000);
  } finally { await harness.lifecycle.dispose(); }
});
test("hourly retention deletes jobs and kv state of repositories that are no longer configured, caps job data and logs disk use", async () => {
  const { bb, harness } = createFakePluginHost({ settings: { repository: "acme/widgets", importBbRepositories: false } });
  try {
    await plugin(bb);
    await harness.behavior.callRpc("metrics", { days: 7 });
    const db = bb.storage.database();
    for (const repo of ["acme/widgets", "gone/repo"]) {
      db.prepare("INSERT INTO ci_jobs VALUES (?, 1, 1, 1, '2026-10-19T10:00:00Z', NULL, 'success', 'x', '{}')").run(repo);
      db.prepare("INSERT INTO ci_attempts (repository, run_id, attempt, completed, fetched_at, created_at) VALUES (?, 1, 1, 1, 0, '2026-10-19T10:00:00Z')").run(repo);
      await bb.storage.kv.set(`result:${repo}`, {}); await bb.storage.kv.set(`incidents:${repo}`, { open: [], recent: [] });
    }
    const service = harness.behavior.runService("snapshot-refresh");
    await vi.waitFor(async () => expect(await bb.storage.kv.list("incidents:")).toEqual(["incidents:acme/widgets"]));
    service.controller.abort(); await service.done;
    expect(await bb.storage.kv.list("result:")).toEqual(["result:acme/widgets"]);
    expect(db.prepare("SELECT repository FROM ci_jobs").all()).toEqual([{ repository: "acme/widgets" }]);
    expect(db.prepare("SELECT repository FROM ci_attempts").all()).toEqual([{ repository: "acme/widgets" }]);
    expect(harness.inspection.logEntries).toEqual(expect.arrayContaining([expect.objectContaining({ message: expect.stringMatching(/^Storage: total [\d.]+ MB \(jobs [\d.]+, history [\d.]+, http cache [\d.]+, snapshots [\d.]+, free pages [\d.]+\)$/) })]));
  } finally { await harness.lifecycle.dispose(); }
});

test("metrics progress reports CI listing progress while ci is pending and drops it once ci settles", async () => {
  const { runs, from } = historyHost();
  const events: Metrics[] = [];
  const final = await loadMetrics("acme/widgets", "token", new AbortController().signal, resolveRange(null), undefined, undefined, {
    partitionCi: true, historyRange: { since: from, until: new Date().toISOString(), label: "repository history", bucketMs: DAY }, onProgress: (metrics) => events.push(structuredClone(metrics)),
  });
  const loading = events.filter((metrics) => metrics.loading);
  expect(loading.length).toBeGreaterThan(2);
  expect(loading.every((metrics) => metrics.pending?.includes("ci"))).toBe(true);
  const last = loading[loading.length - 1].loading!;
  expect(last).toEqual({ runs: expect.any(Number), done: last.total, total: last.total });
  expect(last.runs).toBeLessThanOrEqual(runs.length);
  expect(loading[0].loading).toMatchObject({ runs: 0, done: 0 });
  expect(events.filter((metrics) => !metrics.pending?.includes("ci")).every((metrics) => !("loading" in metrics))).toBe(true);
  expect("loading" in final).toBe(false);
});

test("the server publishes at most one listing-progress event per 2 s and keeps pending changes", async () => {
  historyHost("2026-10-10T00:00:00.000Z");
  const { bb, harness } = createFakePluginHost({ settings: { repository: "acme/widgets", importBbRepositories: false } });
  try {
    await plugin(bb);
    await harness.behavior.callRpc("metrics", { days: 14 });
    const published = harness.inspection.realtimeSignals.filter((signal) => signal.channel === "metrics-progress").map((signal) => (signal.payload as { metrics: Metrics }).metrics);
    const ticks = published.filter((metrics) => metrics.loading && metrics.pending?.includes("ci"));
    // The fake clock is frozen, so every tick after the first with the same pending set must be dropped.
    const keys = new Set(ticks.map((metrics) => metrics.pending!.join()));
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    expect(ticks.length).toBe(keys.size);
    expect(published.some((metrics) => !metrics.pending?.includes("ci") && !metrics.loading)).toBe(true);
  } finally { await harness.lifecycle.dispose(); }
});

// --- observer threads: classified CI events pushed to subscribed BB threads ---
const prOf = (id: number) => id - 894;
const runMeta = (id: number) => ({ id, name: "CI", event: "merge_group", head_branch: `gh-readonly-queue/main/pr-${prOf(id)}-abc`, head_sha: `sha${id}`, run_attempt: 1, pull_requests: [], status: "in_progress", conclusion: null, created_at: "2026-10-20T11:50:00Z" });
const liveRow = (id: number) => ({ id: id * 10 + 1, name: "Unit tests", status: "in_progress", conclusion: null, created_at: "2026-10-20T11:50:00Z", started_at: "2026-10-20T11:51:00Z", completed_at: null, labels: ["self-hosted"], runner_name: "runner-1", runner_group_name: null, steps: [] });
const doneRow = (id: number, name: string, conclusion: string, over: object = {}) => ({ id, name, status: "completed", conclusion, created_at: "2026-10-20T11:50:00Z", started_at: "2026-10-20T11:51:00Z", completed_at: "2026-10-20T12:00:40Z", labels: ["self-hosted"], runner_name: "runner-1", runner_group_name: null,
  steps: conclusion === "failure" && !("noSteps" in over) ? [{ name: "Run tests", conclusion: "failure" }] : [], ...over });
// 901: real failure, 902: runner lost, 903: green. All three leave the live poll after the first pass.
const finishedJobs: Record<number, object[]> = { 901: [doneRow(9011, "Unit tests", "failure")], 902: [doneRow(9021, "Integration", "failure", { noSteps: true, runner_name: "runner-lost-1" })], 903: [doneRow(9031, "Unit tests", "success")] };
const finishedNotes: Record<number, object[]> = { 9011: [{ annotation_level: "failure", title: null, message: "Process completed with exit code 1.\nenv:\n  API_TOKEN: hunter2-secret" }], 9021: [{ annotation_level: "failure", title: null, message: "The runner has received a shutdown signal to terminate." }] };
function ciScenario() {
  // `removals`: PR number -> createdAt of its RemovedFromMergeQueueEvent (null: none); `lookupFails` answers the timeline query with a GraphQL error. `lookups` lists the PRs asked about.
  const state = { running: [901, 902, 903], deployments: [] as object[], deploymentStatus: [] as object[], reports: [] as { name: string; data: string }[],
    removals: { 7: "2026-10-20T12:00:30Z", 8: "2026-10-20T12:00:30Z" } as Record<number, string | null>, reasons: {} as Record<number, string>, states: {} as Record<number, string>, lookupFails: false, lookups: [] as number[] };
  const normal = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input: string, options?: RequestInit) => {
    const url = new URL(input), path = url.pathname.replace("/repos/acme/widgets", ""), status = url.searchParams.get("status");
    let found: RegExpMatchArray | null;
    if (url.pathname === "/graphql" && String(options?.body).includes("REMOVED_FROM_MERGE_QUEUE_EVENT")) {
      const number = JSON.parse(String(options!.body)).variables.number as number;
      state.lookups.push(number);
      if (state.lookupFails) return Response.json({ errors: [{ message: "boom" }] });
      const createdAt = state.removals[number];
      return Response.json({ data: { repository: { pullRequest: { state: state.states[number] ?? "OPEN", timelineItems: { nodes: createdAt ? [{ createdAt, reason: state.reasons[number] ?? "FAILED_CHECKS" }] : [] } } } } });
    }
    if (path === "/actions/runs" && (status === "queued" || status === "in_progress")) return Response.json({ workflow_runs: status === "in_progress" ? state.running.map(runMeta) : [] });
    if ((found = path.match(/^\/actions\/runs\/(\d+)\/jobs$/))) return Response.json({ jobs: [liveRow(Number(found[1]))] });
    if ((found = path.match(/^\/actions\/runs\/(\d+)\/attempts\/1\/jobs$/))) return Response.json({ jobs: finishedJobs[Number(found[1])] ?? [] });
    if ((found = path.match(/^\/actions\/runs\/(\d+)$/))) return Response.json({ ...runMeta(Number(found[1])), status: "completed", conclusion: found[1] === "903" ? "success" : "failure" });
    if ((found = path.match(/^\/check-runs\/(\d+)\/annotations$/))) return Response.json(finishedNotes[Number(found[1])] ?? []);
    if (path === "/actions/runs/901/artifacts") return Response.json({ artifacts: state.reports.map((report, index) => ({ id: 70 + index, name: report.name, size_in_bytes: 300, created_at: "2026-10-20T12:00:50Z" })) });
    if ((found = url.pathname.match(/^\/repos\/acme\/widgets\/actions\/artifacts\/(\d+)\/zip$/))) return new Response(new Uint8Array(zip([{ name: "report.xml", data: state.reports[Number(found[1]) - 70]!.data }])));
    if (state.deployments.length && path === "/deployments") return Response.json(state.deployments);
    if (state.deployments.length && path.match(/^\/deployments\/\d+\/statuses$/)) return Response.json(state.deploymentStatus);
    return normal(input, options);
  });
  return state;
}
function observerHost(settings: object = {}, threadsOverride: object = {}) {
  const send = vi.fn(async (_args: unknown) => ({}));
  const get = vi.fn(async ({ threadId }: { threadId: string }): Promise<{ id: string; archivedAt: number | null }> => ({ id: threadId, archivedAt: null }));
  const host = createFakePluginHost({ pluginId: "delivery-dashboard", settings: { repository: "acme/widgets", importBbRepositories: false, observerThreads: "thr_observer", ...settings },
    sdk: { threads: { send, get, ...threadsOverride } as never, plugins: { callRpc: (async () => ({ ok: true })) as never } } });
  return { ...host, send, get };
}
const sentTo = (send: { mock: { calls: unknown[][] } }, threadId?: string) => send.mock.calls.map(([args]) => args as { threadId: string; mode: string; originPluginId: string; input: { text: string }[] }).filter((call) => !threadId || call.threadId === threadId).map((call) => call.input[0].text);
const RUNS = "https://github.com/acme/widgets/actions/runs";
const PREFIX = "**CI Dashboard**";

test("observer: a merge queue removal and a runner loss reach the thread one loop after the runs finish; green runs and repeats send nothing", async () => {
  const scenario = ciScenario();
  let { bb, harness, send } = observerHost();
  try {
    await plugin(bb);
    // Poll N: the three runs are in progress. The thread subscribes and gets its confirmation, no history.
    await signalsPass(harness, 0);
    expect(sentTo(send)).toEqual([expect.stringMatching(/^\*\*CI Dashboard\*\* Subscribed to CI events for acme\/widgets: merge queue removals, runner losses, default-branch red, pool stalls, mass cancels, deployments; quiet window 30 min$/)]);
    expect(send.mock.calls[0][0]).toMatchObject({ threadId: "thr_observer", mode: "queue-if-active", originPluginId: "delivery-dashboard", input: [{ type: "text", mentions: [] }] });
    // Poll N+1: they are gone from the live list; the very same loop fetches them, stores their jobs and announces the failures.
    scenario.running = [];
    fetchMock.mockClear();
    await signalsPass(harness);
    const paths = fetchMock.mock.calls.map(([url]) => new URL(url).pathname.replace("/repos/acme/widgets", ""));
    for (const id of [901, 902, 903]) expect(paths.filter((path) => path === `/actions/runs/${id}`)).toHaveLength(1);
    expect(paths).toContain("/actions/runs/901/attempts/1/jobs");
    expect(paths).toContain("/actions/runs/902/attempts/1/jobs");
    expect(paths).not.toContain("/actions/runs/903/attempts/1/jobs");
    const lines = sentTo(send).slice(1);
    expect(lines.sort()).toEqual([
      `${PREFIX} PR #7 removed from merge queue · Unit tests: real · inspect \`queue:901:1\` · [run 901](${RUNS}/901)`,
      `${PREFIX} PR #8 removed from merge queue · Integration: runner_loss (1 on this head) · inspect \`queue:902:1\` · [run 902](${RUNS}/902)`,
    ].sort());
    // The removals were confirmed against each PR's merge queue timeline, once per PR; the queue runner loss rides inside PR #8's line.
    expect([...new Set(scenario.lookups)].sort()).toEqual([7, 8]);
    const asked = scenario.lookups.length;
    for (const line of sentTo(send)) { expect(line).not.toContain("hunter2"); expect(line).not.toContain("env:"); expect(line).not.toContain("API_TOKEN"); expect(line.length).toBeLessThanOrEqual(400); }
    const count = sentTo(send).length;
    // Nothing repeats on the next loops ...
    await signalsPass(harness);
    await signalsPass(harness, 301_000);
    expect(sentTo(send)).toHaveLength(count);
    // Sent keys are not looked up again.
    expect(scenario.lookups).toHaveLength(asked);
    // ... nor after a restart (sent keys are persisted; the analysis is rebuilt from the stored jobs) ...
    ({ bb, harness } = await harness.lifecycle.reload(plugin));
    await signalsPass(harness, 301_000);
    expect(sentTo(send)).toHaveLength(count);
    // ... and a thread that subscribes now gets its confirmation but none of the earlier events.
    const call = async (input: object, threadId = "thr_caller") => JSON.parse(await harness.behavior.callAgentTool("ci_dashboard_manage", input, { threadId }) as string);
    expect(await call({ action: "subscribe", threadId: "thr_late" })).toMatchObject({ observerThreads: ["thr_observer", "thr_late"] });
    await signalsPass(harness, 301_000);
    expect(sentTo(send, "thr_late")).toEqual([expect.stringContaining("Subscribed to CI events")]);
    expect(sentTo(send, "thr_observer")).toHaveLength(count);
  } finally { await harness.lifecycle.dispose(); }
});

test("observer: with removals switched off nothing is sent for a confirmed removal, its runner loss included", async () => {
  const scenario = ciScenario();
  const { bb, harness, send } = observerHost({ observeQueueRemoval: false, runnerLossLimit: 3 });
  try {
    await plugin(bb);
    await signalsPass(harness, 0);
    scenario.running = [];
    await signalsPass(harness);
    expect(sentTo(send).slice(1)).toEqual([]);
  } finally { await harness.lifecycle.dispose(); }
});

test("observer: a removal GitHub does not confirm is held, then given up with no standalone runner loss line", async () => {
  const scenario = ciScenario();
  scenario.removals[8] = null; // PR #8 never left the queue
  const { bb, harness, send } = observerHost({ runnerLossLimit: 3 });
  try {
    await plugin(bb);
    await signalsPass(harness, 0);
    scenario.running = [];
    await signalsPass(harness);
    // PR #7 is confirmed at once; PR #8 and its loss are held, nothing is said about the queued PR yet.
    expect(sentTo(send).slice(1)).toEqual([`${PREFIX} PR #7 removed from merge queue · Unit tests: real · inspect \`queue:901:1\` · [run 901](${RUNS}/901)`]);
    // Within the grace period the lookup is repeated.
    scenario.lookups.length = 0;
    await signalsPass(harness, 301_000);
    expect(scenario.lookups).toEqual([8]);
    expect(sentTo(send)).toHaveLength(2);
    // After 15 minutes the removal is given up; a merge queue loss never stands alone.
    await signalsPass(harness, 16 * 60_000);
    expect(sentTo(send)).toHaveLength(2);
    // The lookup does not repeat.
    scenario.lookups.length = 0;
    await signalsPass(harness, 301_000);
    await signalsPass(harness, 301_000);
    expect(sentTo(send)).toHaveLength(2);
    expect(scenario.lookups).toEqual([]);
  } finally { await harness.lifecycle.dispose(); }
});

for (const merged of ["reason", "state"] as const) test(`observer: a PR that merged is not announced as removed (merged ${merged})`, async () => {
  const scenario = ciScenario();
  // GitHub records a RemovedFromMergeQueueEvent when the PR merges, too.
  if (merged === "reason") scenario.reasons[7] = "MERGED"; else scenario.states[7] = "MERGED";
  const { bb, harness, send } = observerHost();
  try {
    await plugin(bb);
    await signalsPass(harness, 0);
    scenario.running = [];
    await signalsPass(harness);
    expect(sentTo(send).slice(1).map((line) => line.slice(PREFIX.length + 1, PREFIX.length + 8))).toEqual(["PR #8 r"]);
  } finally { await harness.lifecycle.dispose(); }
});

test("observer: a removal confirmed by a removal event from before the group started is not a removal", async () => {
  const scenario = ciScenario();
  scenario.removals[7] = "2026-10-20T11:30:00Z"; // an older removal of the same PR; the group started at 11:51
  const { bb, harness, send } = observerHost();
  try {
    await plugin(bb);
    await signalsPass(harness, 0);
    scenario.running = [];
    await signalsPass(harness);
    expect(sentTo(send).slice(1).map((line) => line.slice(PREFIX.length + 1, PREFIX.length + 8))).toEqual(["PR #8 r"]);
  } finally { await harness.lifecycle.dispose(); }
});

// PR #8 stayed queued: its last removal event predates the group run (the group was rebuilt after the entry ahead left), so the runner loss in run 902 is no removal.
for (const cancelled of [false, true]) test(`observer: a queue runner loss whose PR was last removed before the group started stays quiet, with no standalone loss line ${cancelled ? "(group cancelled)" : "(group not cancelled)"}`, async () => {
  const scenario = ciScenario();
  scenario.removals[8] = "2026-10-20T11:30:00Z"; // the group started at 11:51
  const original = finishedJobs[902]!;
  if (cancelled) finishedJobs[902] = [...original, doneRow(9022, "E2E", "cancelled", { noSteps: true })];
  const { bb, harness, send } = observerHost({ runnerLossLimit: 3 });
  try {
    await plugin(bb);
    await signalsPass(harness, 0);
    scenario.running = [];
    await signalsPass(harness);
    await signalsPass(harness, 301_000);
    // PR #7 only, neither a removal nor a loss for PR #8, within the grace period and after it.
    expect(sentTo(send).slice(1)).toEqual([`${PREFIX} PR #7 removed from merge queue · Unit tests: real · inspect \`queue:901:1\` · [run 901](${RUNS}/901)`]);
    await signalsPass(harness, 16 * 60_000);
    await signalsPass(harness, 301_000);
    expect(sentTo(send).slice(2)).toEqual([]);
    expect(sentTo(send).some((line) => line.includes("PR #8"))).toBe(false);
  } finally { finishedJobs[902] = original; await harness.lifecycle.dispose(); }
});

test("observer: a failed timeline lookup sends no removal", async () => {
  const scenario = ciScenario();
  scenario.lookupFails = true;
  const { bb, harness, send } = observerHost();
  try {
    await plugin(bb);
    await signalsPass(harness, 0);
    scenario.running = [];
    await signalsPass(harness);
    expect(scenario.lookups.length).toBeGreaterThan(0);
    // No confirmation, no removal: only the subscription notice went out.
    expect(sentTo(send).slice(1)).toEqual([]);
  } finally { await harness.lifecycle.dispose(); }
});

test("observer: failed test names come from the configured artifacts, FAILED entries only", async () => {
  const scenario = ciScenario();
  scenario.reports = [{ name: "test-results-unit", data: '<testsuite><testcase classname="cart.Spec" name="passes"/><testcase classname="cart.Spec" name="removes item"><failure message="boom">env:\n  API_TOKEN: hunter2-secret</failure></testcase></testsuite>' }, { name: "coverage", data: "<html>hunter2-secret</html>" }];
  const { bb, harness, send } = observerHost({ flakeArtifacts: "test-results-*" });
  try {
    await plugin(bb);
    await signalsPass(harness, 0);
    scenario.running = [];
    await signalsPass(harness);
    const queue = sentTo(send).find((line) => line.includes("PR #7"))!;
    expect(queue).toBe(`${PREFIX} PR #7 removed from merge queue · Unit tests: real · failed tests: cart.Spec.removes item · inspect \`queue:901:1\` · [run 901](${RUNS}/901)`);
    // The runner loss has no test report to read.
    expect(sentTo(send).find((line) => line.includes("PR #8"))).not.toContain("failed tests");
    for (const line of sentTo(send)) expect(line).not.toContain("hunter2");
  } finally { await harness.lifecycle.dispose(); }
});

test("observer: batching holds events and sends one digest after the interval", async () => {
  const scenario = ciScenario();
  const { bb, harness, send } = observerHost({ observerBatchMinutes: 5 });
  try {
    await plugin(bb);
    await signalsPass(harness, 0);
    scenario.running = [];
    await signalsPass(harness);
    expect(sentTo(send)).toHaveLength(1);
    await signalsPass(harness, 301_000);
    const digest = sentTo(send)[1]!.split("\n");
    expect(digest[0]).toBe(`${PREFIX} 2 CI events`);
    expect(digest.slice(1).every((line) => line.startsWith("- "))).toBe(true);
    expect(sentTo(send)).toHaveLength(2);
  } finally { await harness.lifecycle.dispose(); }
});

test("observer: a deployment is announced once, when its status becomes final after the type was switched on", async () => {
  const scenario = ciScenario();
  scenario.running = [];
  scenario.deployments = [{ id: 31, environment: "staging", sha: "deadbeefcafe", created_at: "2026-10-20T11:59:00Z" }];
  scenario.deploymentStatus = [{ state: "in_progress", created_at: "2026-10-20T11:59:30Z" }];
  const { bb, harness, send } = observerHost();
  try {
    await plugin(bb);
    await signalsPass(harness, 0);
    scenario.deploymentStatus = [{ state: "success", created_at: "2026-10-20T12:00:30Z", log_url: `${RUNS}/55` }];
    await signalsPass(harness);
    expect(sentTo(send).slice(1)).toEqual([`${PREFIX} Deploy staging success · \`deadbee\` · deployment 31 · [run 55](${RUNS}/55)`]);
    await signalsPass(harness);
    expect(sentTo(send)).toHaveLength(2);
  } finally { await harness.lifecycle.dispose(); }
});

test("observer: a deployment that finished before the type was switched on is history", async () => {
  const scenario = ciScenario();
  scenario.running = [];
  scenario.deployments = [{ id: 32, environment: "staging", sha: "deadbeefcafe", created_at: "2026-10-20T11:00:00Z" }];
  scenario.deploymentStatus = [{ state: "success", created_at: "2026-10-20T11:30:00Z" }];
  const { bb, harness, send } = observerHost();
  try {
    await plugin(bb);
    await signalsPass(harness, 0);
    await signalsPass(harness);
    expect(sentTo(send)).toHaveLength(1);
  } finally { await harness.lifecycle.dispose(); }
});

test("ci_dashboard_manage observer actions subscribe, replaces, unsubscribes and lists, defaulting to the calling thread, and refuses archived or unknown threads", async () => {
  const { bb, harness, send, get } = observerHost({ observerThreads: "" });
  get.mockImplementation(async ({ threadId }: { threadId: string }) => {
    if (threadId === "thr_missing") throw new Error("404 thread not found");
    return { id: threadId, archivedAt: threadId === "thr_archived" ? 1 : null };
  });
  try {
    await plugin(bb);
    const call = async (input: object, threadId = "thr_caller") => JSON.parse(await harness.behavior.callAgentTool("ci_dashboard_manage", input, { threadId }) as string);
    expect(await call({ action: "list" })).toEqual({ observerThreads: [], events: ["merge queue removals", "runner losses", "default-branch red", "pool stalls", "mass cancels", "deployments"], quietMinutes: 30, batchMinutes: 0 });
    expect(await call({ action: "subscribe" })).toMatchObject({ observerThreads: ["thr_caller"] });
    expect(sentTo(send, "thr_caller")).toEqual([expect.stringContaining("Subscribed to CI events for acme/widgets")]);
    // Subscribing again changes nothing and repeats nothing.
    await call({ action: "subscribe" });
    expect(sentTo(send)).toHaveLength(1);
    expect(await call({ action: "subscribe", threadId: "thr_other" })).toMatchObject({ observerThreads: ["thr_caller", "thr_other"] });
    expect(await call({ action: "replace" }, "thr_manager")).toMatchObject({ observerThreads: ["thr_manager"] });
    expect(sentTo(send, "thr_manager")).toHaveLength(1);
    expect(await call({ action: "unsubscribe" }, "thr_manager")).toMatchObject({ observerThreads: [] });
    expect(await call({ action: "unsubscribe", threadId: "thr_nobody" })).toMatchObject({ observerThreads: [] });
    // Subscribing again after leaving is a new subscription with its own confirmation.
    await call({ action: "subscribe" }, "thr_manager");
    expect(sentTo(send, "thr_manager")).toHaveLength(2);
    await expect(call({ action: "subscribe", threadId: "thr_archived" })).rejects.toThrow("archived");
    await expect(call({ action: "replace", threadId: "thr_missing" })).rejects.toThrow("does not exist");
    await expect(call({ action: "subscribe", threadId: "not-a-thread" })).rejects.toThrow("not a BB thread id");
    await expect(call({ action: "bogus" })).rejects.toThrow();
    expect(await call({ action: "list" })).toMatchObject({ observerThreads: ["thr_manager"] });
    // The tool writes the same setting the settings UI shows, and the setting is validated.
    await expect(harness.behavior.setSettings({ observerThreads: "nonsense" })).rejects.toThrow();
  } finally { await harness.lifecycle.dispose(); }
});

test("a changed observerThreads setting takes effect without a reload: confirmation at once, events from the next loop only to the new list", async () => {
  const scenario = ciScenario();
  const { bb, harness, send } = observerHost({ observerThreads: "thr_old" });
  try {
    await plugin(bb);
    await signalsPass(harness, 0);
    expect(sentTo(send, "thr_old")).toHaveLength(1);
    await harness.behavior.setSettings({ observerThreads: "thr_new" });
    await vi.waitFor(() => expect(sentTo(send, "thr_new")).toEqual([expect.stringContaining("Subscribed to CI events")]));
    scenario.running = [];
    await signalsPass(harness);
    expect(sentTo(send, "thr_new")).toHaveLength(1 + 2);
    expect(sentTo(send, "thr_old")).toHaveLength(1);
  } finally { await harness.lifecycle.dispose(); }
});

test("an archived or deleted thread is removed from the observers", async () => {
  const { bb, harness } = observerHost({ observerThreads: "thr_a, thr_b, thr_c" });
  try {
    await plugin(bb);
    const list = async () => JSON.parse(await harness.behavior.callAgentTool("ci_dashboard_manage", { action: "list" }, { threadId: "thr_x" }) as string).observerThreads;
    expect(await list()).toEqual(["thr_a", "thr_b", "thr_c"]);
    expect((await harness.behavior.emitThreadEvent("thread.archived", { thread: makeThreadResponse({ id: "thr_b" }) })).errors).toEqual([]);
    expect(await list()).toEqual(["thr_a", "thr_c"]);
    await harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: "thr_a" }) });
    expect(await list()).toEqual(["thr_c"]);
    await harness.behavior.emitThreadEvent("thread.archived", { thread: makeThreadResponse({ id: "thr_unrelated" }) });
    expect(await list()).toEqual(["thr_c"]);
    expect(harness.inspection.logEntries.filter((entry) => entry.message.includes("thr_b removed"))).toHaveLength(1);
  } finally { await harness.lifecycle.dispose(); }
});

test("a failing send is logged once per thread and never retried; a vanished thread is dropped", async () => {
  const scenario = ciScenario();
  const offline = vi.fn(async (_args: unknown) => { throw new Error("bridge offline"); });
  const failing = observerHost({}, { send: offline });
  try {
    await plugin(failing.bb);
    await signalsPass(failing.harness, 0);
    scenario.running = [];
    await signalsPass(failing.harness);
    await signalsPass(failing.harness, 301_000);
    // One confirmation plus two events, each tried exactly once, one log line for the thread.
    expect(offline).toHaveBeenCalledTimes(3);
    expect(failing.harness.inspection.logEntries.filter((entry) => entry.level === "warn" && entry.message.includes("thr_observer failed: bridge offline"))).toHaveLength(1);
  } finally { await failing.harness.lifecycle.dispose(); }
  const vanished = observerHost({}, { send: vi.fn(async () => { throw new Error("GitHub-free 404: thread not found"); }) });
  try {
    await plugin(vanished.bb);
    await signalsPass(vanished.harness, 0);
    expect(JSON.parse(await vanished.harness.behavior.callAgentTool("ci_dashboard_manage", { action: "list" }, { threadId: "thr_x" }) as string).observerThreads).toEqual([]);
    expect(vanished.harness.inspection.logEntries.filter((entry) => entry.message.includes("thr_observer removed from observer threads"))).toHaveLength(1);
  } finally { await vanished.harness.lifecycle.dispose(); }
});

test("with no observer thread nothing is sent and the fast path still stores the finished runs", async () => {
  const scenario = ciScenario();
  const { bb, harness, send } = observerHost({ observerThreads: "" });
  try {
    await plugin(bb);
    await signalsPass(harness, 0);
    scenario.running = [];
    await signalsPass(harness);
    expect(send).not.toHaveBeenCalled();
    expect(bb.storage.database().prepare("SELECT COUNT(*) AS n FROM ci_jobs").get()).toEqual({ n: 2 });
    expect(bb.storage.database().prepare("SELECT COUNT(*) AS n FROM ci_jobs WHERE run_id = 903").get()).toEqual({ n: 0 });
  } finally { await harness.lifecycle.dispose(); }
});
