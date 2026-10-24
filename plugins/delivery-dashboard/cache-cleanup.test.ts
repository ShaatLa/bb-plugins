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

test("prunes records older than a year, invalidates whole aggregates and HTTP pages, and advances at UTC midnight", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-24T12:00:00Z"));
  const { database, harness } = await setup();
  try {
    const dates = ["2025-10-23T23:59:59.999Z", "2025-10-24T00:00:00.000Z", "2026-10-23T00:00:00.000Z"];
    const history = { checkedAt: Date.now() - 1000, metrics: { range: { since: dates[2] } }, coverage: { since: dates[0], until: dates[2] }, records: {
      deployments: dates.map((created_at) => ({ created_at })),
      runs: dates.map((created_at, id) => ({ id: id + 1, created_at, conclusion: "success" })),
      commits: dates.map((committedDate, id) => ({ committedDate, oid: String(id), additions: 1, deletions: 0 })), branch: "main", head: "head",
    } };
    for (const [name, data] of [["current", history], ["obsolete", { ...history, metrics: { range: { since: dates[0] } } }]] as const) {
      database.prepare("INSERT INTO repository_history VALUES (?, ?, ?, ?)").run(name, "config", JSON.stringify(data), Date.now());
      database.prepare("INSERT INTO dashboard_snapshots (selection, configuration, data, refreshed_at) VALUES (?, ?, ?, ?)").run(name, "config", JSON.stringify({ repositories: [data.metrics] }), Date.now());
    }
    const pages = [
      ["/repos/acme/widgets/actions/runs?created=2025-10-23..2026-10-23", { workflow_runs: [] }],
      ["/repos/acme/widgets/deployments?page=2", dates.map((created_at) => ({ created_at }))],
      ["/search/issues?q=repo:acme/widgets%20created:2025-10-23..2026-10-23", { total_count: 0 }],
      ["/repos/acme/widgets/actions/runs?created=2025-10-24..2026-10-23", { workflow_runs: [{ created_at: dates[1] }] }],
      ["/search/issues?q=repo:acme/widgets%20is:open", { items: [{ created_at: dates[0] }] }],
    ] as const;
    for (const [path, body] of pages) database.prepare("INSERT INTO github_responses VALUES (?, ?, ?, ?)").run(JSON.stringify(["config", path]), JSON.stringify({ body, hasNext: false, etag: "original" }), Date.now(), Date.now());
    expect(cleanupCache(database).removed).toBe(5);
    const retained = () => JSON.parse((database.prepare("SELECT data FROM repository_history WHERE repository = 'current'").get() as { data: string }).data);
    expect(retained()).toMatchObject({ checkedAt: history.checkedAt, coverage: { since: dates[1] }, records: { head: "head", branch: "main" } });
    expect(retained().records.deployments).toEqual(dates.slice(1).map((created_at) => ({ created_at })));
    expect(retained().records.runs).toHaveLength(2);
    expect(retained().records.commits).toHaveLength(2);
    expect(database.prepare("SELECT selection FROM dashboard_snapshots").all()).toEqual([{ selection: "current" }]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM github_responses").get()).toEqual({ count: 2 });
    vi.setSystemTime(new Date("2026-10-25T00:00:00Z"));
    cleanupCache(database);
    expect(retained().coverage.since).toBe("2025-10-25T00:00:00.000Z");
    expect(retained().records.commits).toHaveLength(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM github_responses").get()).toEqual({ count: 1 });
  } finally { await harness.lifecycle.dispose(); }
});

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
