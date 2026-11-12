import { ciRunSchema } from "./ci-insights";
import { afterEach, expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createGitHubCache } from "./github-cache";

afterEach(() => vi.unstubAllGlobals());

test("conditional pages survive reload, reuse 304 bodies, and replace changed run outcomes", async () => {
  const { bb, harness } = createFakePluginHost();
  const database = bb.storage.database();
  database.prepare("CREATE TABLE github_responses (cache_key TEXT PRIMARY KEY, data TEXT NOT NULL, checked_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL DEFAULT 0)").run();
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ total_count: 1, workflow_runs: [{ id: 1, created_at: "2026-10-19T00:00:00Z", conclusion: "failure", unused: "large response" }] }, { headers: { etag: '"first"', link: '<https://api.github.com/next>; rel="next"' } }))
    .mockResolvedValueOnce(new Response(null, { status: 304 }))
    .mockResolvedValueOnce(Response.json({ total_count: 1, workflow_runs: [{ id: 1, created_at: "2026-10-19T00:00:00Z", conclusion: "success" }] }, { headers: { etag: '"second"' } }));
  vi.stubGlobal("fetch", fetchMock);
  try {
    const controller = new AbortController();
    const path = "/repos/acme/widgets/actions/runs?created=fixed&page=1";
    const first = await createGitHubCache(database)("config", "private-token", controller.signal, 300_000, false, () => true)(path);
    const reloaded = createGitHubCache(database)("config", "private-token", controller.signal, 300_000, false, () => true);
    expect(await reloaded(path)).toEqual(first);
    expect(fetchMock.mock.calls[1][1].headers["If-None-Match"]).toBe('"first"');
    expect(await reloaded(path)).toMatchObject({ body: { workflow_runs: [{ conclusion: "success" }] }, hasNext: false });
    const stored = database.prepare("SELECT data FROM github_responses").get() as { data: string };
    expect(stored.data).not.toContain("private-token");
    expect(stored.data).not.toContain("large response");
  } finally { await harness.lifecycle.dispose(); }
});

test("current-state TTL shares requests across ranges, force revalidates, and invalidated writes are rejected", async () => {
  const { bb, harness } = createFakePluginHost();
  const database = bb.storage.database();
  database.prepare("CREATE TABLE github_responses (cache_key TEXT PRIMARY KEY, data TEXT NOT NULL, checked_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL DEFAULT 0)").run();
  const fetchMock = vi.fn().mockImplementation(async () => Response.json({ total_count: 7, unused_sensitive: "do-not-store" }, { headers: { etag: '"same"' } }));
  vi.stubGlobal("fetch", fetchMock);
  try {
    const cache = createGitHubCache(database);
    const signal = new AbortController().signal;
    const regular = cache("config", "token", signal, 300_000, false, () => true);
    const path = "/search/issues?q=is:open";
    await Promise.all([regular(path), regular(path)]);
    await regular(path);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await cache("config", "token", signal, 300_000, true, () => true)(path);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await cache("invalidated", "token", signal, 300_000, true, () => false)(path);
    expect(database.prepare("SELECT COUNT(*) AS count FROM github_responses").get()).toEqual({ count: 1 });
    expect(JSON.stringify(database.prepare("SELECT data FROM github_responses").all())).not.toContain("do-not-store");
  } finally { await harness.lifecycle.dispose(); }
});

test("upgrades slim CI pages without reusing legacy ETags and retains diagnostic fields through 304", async () => {
  const { bb, harness } = createFakePluginHost();
  const database = bb.storage.database();
  database.prepare("CREATE TABLE github_responses (cache_key TEXT PRIMARY KEY, data TEXT NOT NULL, checked_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL)").run();
  const path = "/repos/acme/widgets/actions/runs?created=fixed&page=1";
  database.prepare("INSERT INTO github_responses VALUES (?, ?, ?, ?)").run(JSON.stringify(["config", path]), JSON.stringify({ body: { total_count: 0, workflow_runs: [] }, hasNext: false, etag: "legacy" }), Date.now(), Date.now());
  const run = { id: 1, created_at: "2026-10-19T00:00:00Z", conclusion: "failure", name: "Tests", workflow_id: 42, head_branch: "main", event: "push", run_started_at: "2026-10-19T00:00:00Z", updated_at: "2026-10-19T00:01:00Z" };
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ total_count: 1, workflow_runs: [{ ...run, unused: "do-not-store" }] }, { headers: { etag: "enriched" } })).mockResolvedValueOnce(new Response(null, { status: 304 }));
  vi.stubGlobal("fetch", fetchMock);
  try {
    const request = () => createGitHubCache(database)("config", undefined, new AbortController().signal, 300_000, true, () => true)(path);
    expect(await request()).toMatchObject({ body: { workflow_runs: [run] } });
    expect(fetchMock.mock.calls[0][1].headers["If-None-Match"]).toBeUndefined();
    expect(await request()).toMatchObject({ body: { workflow_runs: [run] } });
    expect(fetchMock.mock.calls[1][1].headers["If-None-Match"]).toBe("enriched");
    expect(JSON.stringify(database.prepare("SELECT data FROM github_responses").all())).not.toContain("do-not-store");
  } finally { await harness.lifecycle.dispose(); }
});

function cacheDatabase() {
  const { bb, harness } = createFakePluginHost();
  const database = bb.storage.database();
  database.prepare("CREATE TABLE github_responses (cache_key TEXT PRIMARY KEY, data TEXT NOT NULL, checked_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL DEFAULT 0)").run();
  const sql: string[] = [];
  const prepare = database.prepare.bind(database);
  vi.spyOn(database, "prepare").mockImplementation(((text: string) => (sql.push(text), prepare(text))) as typeof database.prepare);
  return { database, harness, sql };
}

test("a 304 only refreshes check times: the stored body is not rewritten and nothing is evicted", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { database, harness, sql } = cacheDatabase();
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ total_count: 1, workflow_runs: [{ id: 1, created_at: "2026-10-19T00:00:00Z" }] }, { headers: { etag: '"a"' } })).mockResolvedValue(new Response(null, { status: 304 }));
  vi.stubGlobal("fetch", fetchMock);
  try {
    const request = createGitHubCache(database)("config", "token", new AbortController().signal, 300_000, false, () => true);
    const path = "/repos/acme/widgets/actions/runs?created=fixed&page=1";
    const body = await request(path);
    const before = database.prepare("SELECT data, checked_at FROM github_responses").get() as { data: string; checked_at: number };
    sql.length = 0;
    vi.setSystemTime(Date.now() + 300_000);
    expect(await request(path)).toEqual(body);
    expect(fetchMock.mock.calls[1][1].headers["If-None-Match"]).toBe('"a"');
    expect(sql.filter((text) => /^(INSERT|DELETE)/.test(text))).toEqual([]);
    const after = database.prepare("SELECT data, checked_at, last_used_at FROM github_responses").get() as { data: string; checked_at: number; last_used_at: number };
    expect(after.data).toBe(before.data);
    expect(after.checked_at).toBe(before.checked_at + 300_000);
    expect(after.last_used_at).toBe(after.checked_at);
  } finally { vi.useRealTimers(); await harness.lifecycle.dispose(); }
});

test("reads touch last_used_at at most every ten minutes", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { database, harness, sql } = cacheDatabase();
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => Response.json({ total_count: 7 })));
  try {
    const request = createGitHubCache(database)("config", "token", new AbortController().signal, 3 * 3_600_000, false, () => true);
    const path = "/search/issues?q=is:open";
    await request(path);
    sql.length = 0;
    for (const minutes of [2, 3, 4]) { vi.setSystemTime(Date.now() + minutes * 60_000); await request(path); }
    expect(sql.filter((text) => text.startsWith("UPDATE"))).toHaveLength(0);
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await request(path);
    expect(sql.filter((text) => text.startsWith("UPDATE"))).toHaveLength(1);
  } finally { vi.useRealTimers(); await harness.lifecycle.dispose(); }
});

test("the LRU trim runs only after 64 new keys push the table past 576 rows", async () => {
  const { database, harness, sql } = cacheDatabase();
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => Response.json([])));
  try {
    const request = createGitHubCache(database)("config", "token", new AbortController().signal, 300_000, false, () => true);
    for (let index = 0; index < 700; index++) await request(`/repos/acme/widgets/deployments?page=${index}`);
    expect(sql.filter((text) => text.startsWith("DELETE"))).toHaveLength(1);
    expect((database.prepare("SELECT COUNT(*) AS n FROM github_responses").get() as { n: number }).n).toBe(572);
  } finally { await harness.lifecycle.dispose(); }
});

test("stored workflow runs keep their display title and stored deployments keep environment, ref and sha", async () => {
  const { bb, harness } = createFakePluginHost();
  const database = bb.storage.database();
  database.prepare("CREATE TABLE github_responses (cache_key TEXT PRIMARY KEY, data TEXT NOT NULL, checked_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL)").run();
  const run = { id: 1, created_at: "2026-10-19T00:00:00Z", conclusion: "failure", display_title: "Add retry to uploads (#123)" };
  const deployment = { id: 5, environment: "staging", production_environment: false, ref: "main", sha: "a".repeat(40), created_at: "2026-10-19T00:00:00Z" };
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ total_count: 1, workflow_runs: [{ ...run, unused: "do-not-store" }] })).mockResolvedValueOnce(Response.json([{ ...deployment, payload: "do-not-store" }]));
  vi.stubGlobal("fetch", fetchMock);
  try {
    const request = createGitHubCache(database)("config", undefined, new AbortController().signal, 300_000, true, () => true);
    expect(await request("/repos/acme/widgets/actions/runs?created=fixed&page=1")).toMatchObject({ body: { workflow_runs: [run] } });
    expect(await request("/repos/acme/widgets/deployments?per_page=100&page=1")).toMatchObject({ body: [deployment] });
    expect(JSON.stringify(database.prepare("SELECT data FROM github_responses").all())).not.toContain("do-not-store");
    expect(ciRunSchema.parse(run).display_title).toBe(run.display_title);
  } finally { vi.unstubAllGlobals(); await harness.lifecycle.dispose(); }
});

test("volatile requests deduplicate without persisting while stable keys retain ETags", async () => {
  const { database, harness } = cacheDatabase();
  const fetchMock = vi.fn().mockImplementation(async () => Response.json({ total_count: 0 }, { headers: { etag: '"a"' } }));
  vi.stubGlobal("fetch", fetchMock);
  try {
    const request = createGitHubCache(database)("config", undefined, new AbortController().signal, 300_000, false, () => true);
    await Promise.all([request("/volatile", undefined, { volatile: true }), request("/volatile", undefined, { volatile: true })]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(database.prepare("SELECT COUNT(*) AS n FROM github_responses").get()).toEqual({ n: 0 });
    await request("/stable");
    expect(database.prepare("SELECT COUNT(*) AS n FROM github_responses").get()).toEqual({ n: 1 });
  } finally { await harness.lifecycle.dispose(); }
});
