import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createFakePluginHost, experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { loadMetrics } from "./metrics";
import { resolveGithubToken } from "./auth";
import { githubRepository, repositoriesSettingSchema } from "./repositories";
import { resolveRange } from "./date-range";

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
  expect(result.deployments.series?.map((point) => point.value)).toEqual([0, 0, 0, 0, 0, 0, 15]);
  expect(result.ci.series?.map((point) => point.value)).toEqual([null, null, null, null, null, null, 80]);
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


test("groups boundary timestamps into seven rolling 24-hour deployment periods", async () => {
  const normal = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input: string) => input.includes("/deployments")
    ? Response.json([
      { created_at: "2026-10-20T12:00:00Z" }, { created_at: "2026-10-19T11:59:59Z" },
      { created_at: "2026-10-14T12:00:00Z" }, { created_at: "2026-10-13T12:00:00Z" },
      { created_at: "2026-10-13T11:59:59Z" },
    ]) : normal(input));
  const result = await load();
  expect(result.deployments.series?.map((point) => point.value)).toEqual([1, 1, 0, 0, 0, 1, 1]);
  expect(result.deployments.series?.[6].date).toBe("2026-10-20T12:00:00.000Z");
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
  expect(result.ci.series?.map((point) => point.value)).toEqual([null, 100, null, null, null, null, 50]);
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
  expect(result.ci.detail).toContain("1 of 4 completed workflow runs · cancelled and skipped excluded");
  expect(result.ci.series?.map((point) => point.value)).toEqual([null, null, null, null, null, null, 25]);
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
    for (const input of [{ days: 2 }, { start: "2026-10-21", end: "2026-10-20" }, { start: "2025-02-29", end: "2025-03-01" }]) {
      await expect(harness.behavior.callRpc("metrics", input)).rejects.toThrow();
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
      { until: "2026-10-21T00:00:00.000Z" }, { since: "1969-12-31T00:00:00.000Z" },
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
    const service = harness.behavior.runService("snapshot-refresh");
    await vi.waitFor(async () => expect(await harness.behavior.callRpc("snapshot", null)).not.toBeNull());
    service.controller.abort();
    await service.done;
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  } finally { await harness.lifecycle.dispose(); }
});


test("production dispatch requires Anvil in current settings and accepts no caller-selected target", async () => {
  const { bb, harness } = createFakePluginHost({ settings: { repository: "acme/widgets", importBbRepositories: false } });
  try {
    await plugin(bb);
    await expect(harness.behavior.callRpc("deployProduction", { repository: "evil/repo", ref: "feature", workflow: "other.yaml" })).rejects.toThrow();
    await expect(harness.behavior.callRpc("deployProduction", null)).rejects.toThrow("Anvil must be included");
    expect(fetchMock).not.toHaveBeenCalled();
    await harness.behavior.setSettings({ repository: "simple-life-app/anvil" });
    fetchMock.mockResolvedValueOnce(Response.json({ workflow_run_id: 123 }));
    expect(await harness.behavior.callRpc("deployProduction", null)).toEqual({ url: "https://github.com/simple-life-app/anvil/actions/runs/123" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally { await harness.lifecycle.dispose(); }
});

test("production dispatch accepts Anvil discovered from a BB project", async () => {
  const { bb, harness } = createFakePluginHost({
    sdk: { projects: { list: async () => [{ id: "anvil", name: "Anvil", kind: "standard", gitRemoteUrl: "git@github.com:simple-life-app/anvil.git", createdAt: 0, updatedAt: 0, sources: [] }] } },
  });
  try {
    await plugin(bb);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await harness.behavior.callRpc("deployProduction", null)).toMatchObject({ url: expect.stringContaining("production.yaml") });
  } finally { await harness.lifecycle.dispose(); }
});

test("overlapping production dispatches send only one request", async () => {
  const { bb, harness } = createFakePluginHost({ settings: { repository: "simple-life-app/anvil", importBbRepositories: false } });
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
  expect(result.ci.detail).toContain("No completed runs after excluding cancelled and skipped");
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
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL(fetchMock.mock.calls[0][0]).pathname).toBe("/search/issues");
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get("q")).toContain("created:2026-09-20T12:00:00.000Z..2026-10-20T12:00:00.000Z");
    fetchMock.mockClear();
    expect(await harness.behavior.callRpc("snapshot", { days: 30 })).toEqual(narrower);
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
