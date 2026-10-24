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
