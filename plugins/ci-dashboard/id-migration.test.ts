import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { migrateId } from "./id-migration";
import plugin, { settingDescriptors } from "./server";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function fixture(enabled = 0, legacy = true, defineSettings = true) {
  const root = mkdtempSync(join(tmpdir(), "ci-id-test-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const old = join(root, "plugins/delivery-dashboard"); mkdirSync(old, { recursive: true });
  const db = new DatabaseSync(join(root, "bb.db"));
  db.exec("CREATE TABLE plugins (id TEXT, enabled INTEGER, removed_at TEXT); CREATE TABLE plugin_kv (plugin_id TEXT, key TEXT, value TEXT); CREATE TABLE plugin_settings (plugin_id TEXT, key TEXT, value TEXT)");
  if (legacy) db.prepare("INSERT INTO plugins VALUES (?, ?, NULL)").run("delivery-dashboard", enabled);
  const keys = ["observers", "prSubscriptions", "deep-range-at", "result:acme/widgets", "incidents:acme/widgets", "handled:acme/widgets", "observer:acme/widgets"];
  for (const key of keys) db.prepare("INSERT INTO plugin_kv VALUES (?, ?, ?)").run("delivery-dashboard", key, JSON.stringify({ preserved: key }));
  for (const [key, value] of Object.entries({ repository: "acme/widgets", actorLead: "Lead", observeDefaultRed: false, refreshSeconds: 60 })) db.prepare("INSERT INTO plugin_settings VALUES (?, ?, ?)").run("delivery-dashboard", key, JSON.stringify(value));
  db.prepare("INSERT INTO plugin_kv VALUES (?, ?, ?)").run("another-plugin", "unrelated", "false");
  const source = new DatabaseSync(join(old, "data.db"));
  source.exec("PRAGMA journal_mode=WAL; CREATE TABLE ci_jobs (id INTEGER); INSERT INTO ci_jobs VALUES (42); CREATE TABLE repository_history (repository TEXT); INSERT INTO repository_history VALUES ('acme/widgets')");
  cleanups.push(() => source.close());
  const { bb, harness } = createFakePluginHost({ pluginId: "ci-dashboard", dataDir: root });
  cleanups.push(() => harness.lifecycle.dispose()); cleanups.push(() => db.close());
  const settings = defineSettings ? bb.settings.define(settingDescriptors) : undefined!;
  const run = () => migrateId(bb, settingDescriptors, settings);
  return { root, old, db, source, bb, harness, settings, run, keys, target: join(root, "plugins/ci-dashboard/data.db") };
}

test("legacy enabled refuses without any target writes", async () => {
  const f = fixture(1);
  expect(await f.run()).toContain("disable delivery-dashboard, then reload ci-dashboard");
  expect(await f.bb.storage.kv.list()).toEqual([]); expect(existsSync(f.target)).toBe(false);
});
test("no legacy installation is a no-op", async () => {
  const f = fixture(0, false); expect(await f.run()).toBeNull();
  expect(await f.bb.storage.kv.list()).toEqual([]); expect(existsSync(f.target)).toBe(false);
});
test("copies WAL database, every KV key, declared settings and finishes marker last", async () => {
  const f = fixture();
  f.db.prepare("INSERT INTO plugin_settings VALUES (?, ?, ?)").run("delivery-dashboard", "unknown", "true");
  expect(await f.run()).toBeNull();
  const handle = new DatabaseSync(f.target, { readOnly: true });
  try { expect(handle.prepare("SELECT * FROM ci_jobs").all()).toEqual([{ id: 42 }]); } finally { handle.close(); }
  for (const key of f.keys) expect(await f.bb.storage.kv.get(key)).toEqual({ preserved: key });
  expect(await f.bb.storage.kv.get("unrelated")).toBeUndefined();
  expect(await f.settings.get()).toMatchObject({ repository: "acme/widgets", actorLead: "Lead", observeDefaultRed: false, refreshSeconds: 60 });
  expect(await f.bb.storage.kv.get("migration")).toMatchObject({ from: "delivery-dashboard", state: "done" });
  expect(f.harness.logEntries.some(row => row.message.includes("skipped unknown setting unknown"))).toBe(true);
  expect(statSync(f.target).mode & 0o777).toBe(0o600);
  expect(statSync(join(f.root, "plugins/ci-dashboard/migration")).mode & 0o777).toBe(0o700);
  expect(existsSync(f.target + "-wal")).toBe(false);
  f.source.exec("INSERT INTO ci_jobs VALUES (43)"); await f.run();
  const done = new DatabaseSync(f.target, { readOnly: true });
  try { expect(done.prepare("SELECT COUNT(*) AS n FROM ci_jobs").get()).toEqual({ n: 1 }); } finally { done.close(); }
});
test.each(["kv", "settings", "database"])("initialized target %s aborts without overwrite", async kind => {
  const f = fixture();
  if (kind === "kv") await f.bb.storage.kv.set("keep", true);
  if (kind === "settings") f.db.prepare("INSERT INTO plugin_settings VALUES (?, ?, ?)").run("ci-dashboard", "repository", '"acme/other"');
  if (kind === "database") { mkdirSync(join(f.root, "plugins/ci-dashboard")); const db = new DatabaseSync(f.target); db.exec("CREATE TABLE ci_jobs (id INTEGER); INSERT INTO ci_jobs VALUES (99)"); db.close(); }
  expect(await f.run()).toContain("initialized state");
  expect(await f.bb.storage.kv.get("migration")).toBeUndefined();
  if (kind === "kv") expect(await f.bb.storage.kv.get("keep")).toBe(true);
  if (kind === "database") { const db = new DatabaseSync(f.target); expect(db.prepare("SELECT id FROM ci_jobs").get()).toEqual({ id: 99 }); db.close(); }
});
test("started marker redoes the whole migration and removes partial writes", async () => {
  const f = fixture(); await f.run();
  await f.bb.storage.kv.set("migration", { from: "delivery-dashboard", state: "started" });
  await f.bb.storage.kv.set("partial", true); await f.settings.experimental_set({ actorManager: "Partial" });
  f.source.exec("INSERT INTO ci_jobs VALUES (43)");
  expect(await f.run()).toBeNull(); expect(await f.bb.storage.kv.get("partial")).toBeUndefined();
  expect((await f.settings.get()).actorManager).toBe("Manager");
  const db = new DatabaseSync(f.target); try { expect(db.prepare("SELECT COUNT(*) AS n FROM ci_jobs").get()).toEqual({ n: 2 }); } finally { db.close(); }
});
test("legacy secret file only produces a notice", async () => {
  const f = fixture(); mkdirSync(join(f.old, "secrets")); writeFileSync(join(f.old, "secrets/token"), "synthetic", { mode: 0o600 });
  await f.run(); expect((await f.settings.get()).token).toBeUndefined();
  expect(existsSync(join(f.root, "plugins/ci-dashboard/secrets"))).toBe(false);
  expect(f.harness.logEntries.some(row => row.message.includes("set the token again"))).toBe(true);
});
test("midway failure leaves started marker and retry succeeds", async () => {
  const f = fixture();
  const write = vi.spyOn(f.settings, "experimental_set").mockRejectedValueOnce(new Error("synthetic failure"));
  await expect(f.run()).rejects.toThrow("synthetic failure");
  expect(await f.bb.storage.kv.get("migration")).toMatchObject({ state: "started" });
  write.mockRestore(); expect(await f.run()).toBeNull();
  expect(await f.bb.storage.kv.get("migration")).toMatchObject({ state: "done" });
});
test("invalid declared setting fails before any copy", async () => {
  const f = fixture(); f.db.prepare("UPDATE plugin_settings SET value = ? WHERE key = ?").run("2", "refreshSeconds");
  await expect(f.run()).rejects.toThrow("Invalid legacy setting"); expect(existsSync(f.target)).toBe(false);
});
test("server services and observers wait for migration and stay inert on refusal", async () => {
  const f = fixture(1, true, false), get = f.bb.storage.kv.get.bind(f.bb.storage.kv);
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(f.bb.storage.kv, "get").mockImplementation(async key => { if (key === "migration") await wait; return get(key); });
  const open = vi.spyOn(f.bb.storage, "database"), fetch = vi.spyOn(globalThis, "fetch");
  const loading = plugin(f.bb);
  const refresh = f.harness.behavior.runService("snapshot-refresh"), signals = f.harness.behavior.runService("ci-signals");
  await expect(f.harness.behavior.callRpc("manage", { action: "list" })).rejects.toThrow("migration is in progress");
  await expect(f.harness.behavior.callAgentTool("ci_dashboard_metrics", {})).rejects.toThrow("migration is in progress");
  expect(open).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  release(); await loading; await Promise.all([refresh.done, signals.done]);
  await expect(f.harness.behavior.callRpc("manage", { action: "list" })).rejects.toThrow("disable delivery-dashboard");
  expect(open).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  fetch.mockRestore();
});
