import { afterEach, expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { cacheMaxBytes, cleanupCache } from "./cache-cleanup";

afterEach(() => vi.useRealTimers());
async function setup() {
  const host = createFakePluginHost({ settings: { importBbRepositories: false } });
  await plugin(host.bb);
  return { ...host, database: host.bb.storage.database() };
}
const old = () => Date.now() - 8 * 86_400_000;

test("expires idle cache entries without expiring actively used 90-day history or extending freshness", async () => {
  const { database, harness } = await setup();
  try {
    for (const [key, used] of [["hot", Date.now()], ["cold", old()]] as const) {
      database.prepare("INSERT INTO github_responses VALUES (?, ?, ?, ?)").run(key, "{}", old(), used);
      database.prepare("INSERT INTO dashboard_snapshots (selection, configuration, data, history, refreshed_at) VALUES (?, ?, ?, ?, ?)").run(key, "config", "{}", null, used);
      database.prepare("INSERT INTO repository_history (repository, configuration, data, last_used_at) VALUES (?, ?, ?, ?)").run(key, "config", JSON.stringify({ checkedAt: old(), coverage: { since: "2026-07-26", until: "2026-10-24" } }), used);
    }
    expect(cleanupCache(database).removed).toBe(3);
    expect(database.prepare("SELECT cache_key, checked_at FROM github_responses").get()).toEqual({ cache_key: "hot", checked_at: expect.any(Number) });
    expect((database.prepare("SELECT checked_at FROM github_responses").get() as { checked_at: number }).checked_at).toBeLessThan(Date.now() - 7 * 86_400_000);
    expect(database.prepare("SELECT repository FROM repository_history").all()).toEqual([{ repository: "hot" }]);
    expect(database.prepare("SELECT selection FROM dashboard_snapshots").all()).toEqual([{ selection: "hot" }]);
  } finally { await harness.lifecycle.dispose(); }
});

test("removes repositories no longer configured from raw history, range snapshots and HTTP pages", async () => {
  const { database, harness } = await setup();
  try {
    for (const name of ["acme/widgets", "acme/removed"]) {
      database.prepare("INSERT INTO repository_history VALUES (?, ?, ?, ?)").run(name, "config", "{}", Date.now());
      database.prepare("INSERT INTO dashboard_snapshots (selection, configuration, data, refreshed_at) VALUES (?, ?, ?, ?)").run(name, "config", JSON.stringify({ repositories: [{ repository: name }] }), Date.now());
      for (const path of [`/repos/${name}/actions/runs?status=completed`, `/search/issues?q=${encodeURIComponent(`repo:${name} is:pr`)}`]) {
        database.prepare("INSERT INTO github_responses VALUES (?, ?, ?, ?)").run(JSON.stringify(["config", path]), "{}", Date.now(), Date.now());
      }
    }
    cleanupCache(database, ["ACME/WIDGETS"]);
    expect(database.prepare("SELECT repository FROM repository_history").all()).toEqual([{ repository: "acme/widgets" }]);
    expect(database.prepare("SELECT selection FROM dashboard_snapshots").all()).toEqual([{ selection: "acme/widgets" }]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM github_responses").get()).toEqual({ count: 2 });
  } finally { await harness.lifecycle.dispose(); }
});

test("evicts HTTP payloads before active history at the byte limit and reclaims SQLite disk pages", async () => {
  const { database, harness } = await setup();
  try {
    database.prepare("INSERT INTO repository_history VALUES (?, ?, ?, ?)").run("acme/widgets", "config", "active history", Date.now());
    database.prepare("INSERT INTO github_responses VALUES (?, zeroblob(?), ?, ?)").run("oversized", cacheMaxBytes + 1, Date.now(), old() + 2 * 86_400_000);
    const before = database.pragma("page_count", { simple: true }) as number;
    const result = cleanupCache(database, undefined, true);
    expect(result.bytes).toBeLessThanOrEqual(cacheMaxBytes);
    expect(result.removed).toBe(1);
    expect(database.prepare("SELECT data FROM repository_history").get()).toEqual({ data: "active history" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM github_responses").get()).toEqual({ count: 0 });
    expect(database.pragma("page_count", { simple: true }) as number).toBeLessThan(before);
  } finally { await harness.lifecycle.dispose(); }
});

test("count limits retain recently used entries even when their freshness timestamp is old", async () => {
  const { database, harness } = await setup();
  try {
    database.transaction(() => {
      for (let index = 0; index < 514; index++) database.prepare("INSERT INTO github_responses VALUES (?, ?, ?, ?)").run(String(index), "{}", Date.now() - index, index === 0 ? Date.now() : Date.now() - 1000 - index);
      for (let index = 0; index < 10; index++) database.prepare("INSERT INTO dashboard_snapshots (selection, configuration, data, refreshed_at) VALUES (?, ?, ?, ?)").run(String(index), "config", "{}", Date.now() - index);
    })();
    cleanupCache(database);
    expect(database.prepare("SELECT COUNT(*) AS count FROM github_responses").get()).toEqual({ count: 512 });
    expect(database.prepare("SELECT cache_key FROM github_responses WHERE cache_key = '0'").get()).toEqual({ cache_key: "0" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM dashboard_snapshots").get()).toEqual({ count: 8 });
  } finally { await harness.lifecycle.dispose(); }
});
