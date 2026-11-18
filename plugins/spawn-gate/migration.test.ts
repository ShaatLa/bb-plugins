import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { migrateLegacyGate } from "./migration";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function legacyStore(enabled = false) {
  const dataDir = mkdtempSync(join(tmpdir(), "spawn-gate-migration-"));
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const oldPath = join(dataDir, "plugins", "agent-spawn-gate");
  mkdirSync(oldPath, { recursive: true });
  const source = new Database(join(oldPath, "data.db"));
  source.pragma("journal_mode = WAL");
  source.exec("CREATE TABLE admissions (thread TEXT PRIMARY KEY); INSERT INTO admissions VALUES ('thr_example')");
  cleanups.push(() => { source.close(); });
  const host = new Database(join(dataDir, "bb.db"));
  cleanups.push(() => { host.close(); });
  host.exec("CREATE TABLE plugins (id TEXT PRIMARY KEY, enabled INTEGER); CREATE TABLE plugin_kv (plugin_id TEXT, key TEXT, value TEXT)");
  host.prepare("INSERT INTO plugins VALUES ('agent-spawn-gate', ?)").run(Number(enabled));
  const insert = host.prepare("INSERT INTO plugin_kv VALUES ('agent-spawn-gate', ?, ?)");
  const settings = { enabled_proj_example: true, script_proj_example: "spawn.py" };
  insert.run("project-settings-v1", JSON.stringify(settings));
  insert.run("metrics-coverage-start", JSON.stringify("2025-01-01T00:00:00.000Z"));
  const { bb, harness } = createFakePluginHost({ pluginId: "spawn-gate", dataDir });
  cleanups.push(() => harness.lifecycle.dispose());
  return { bb, source, settings, target: join(dataDir, "plugins", "spawn-gate", "data.db") };
}

it("copies the legacy WAL and settings once and preserves local changes after migration", async () => {
  const { bb, source, settings, target } = legacyStore();
  await migrateLegacyGate(bb);
  const migrated = new Database(target, { readonly: true, fileMustExist: true });
  cleanups.push(() => { migrated.close(); });
  expect(migrated.prepare("SELECT thread FROM admissions").all()).toEqual([{ thread: "thr_example" }]);
  expect(await bb.storage.kv.get("project-settings-v1")).toEqual(settings);
  expect(await bb.storage.kv.get("metrics-coverage-start")).toBe("2025-01-01T00:00:00.000Z");
  await bb.storage.kv.set("project-settings-v1", { enabled_proj_example: false });
  await migrateLegacyGate(bb);
  expect(await bb.storage.kv.get("project-settings-v1")).toEqual({ enabled_proj_example: false });
  expect(source.prepare("SELECT 1 FROM sqlite_master WHERE name = '_spawn_gate_id_migration'").get()).toBeUndefined();
});

it("leaves an enabled legacy gate and conflicting destination data alone", async () => {
  const active = legacyStore(true);
  await expect(migrateLegacyGate(active.bb)).rejects.toThrow("Disable the legacy Spawn Gate");
  const stopped = legacyStore();
  const settings = { enabled_proj_example: false };
  await stopped.bb.storage.kv.set("project-settings-v1", settings);
  await expect(migrateLegacyGate(stopped.bb)).rejects.toThrow("overwrite an existing setting");
  expect(await stopped.bb.storage.kv.get("project-settings-v1")).toEqual(settings);
  expect(await stopped.bb.storage.kv.get("metrics-coverage-start")).toBeUndefined();
});

it("rolls back a partial settings write and retries without publishing a partial database", async () => {
  const { bb, settings, target } = legacyStore();
  const set = bb.storage.kv.set.bind(bb.storage.kv);
  const fail = vi.spyOn(bb.storage.kv, "set").mockImplementation(async (key, value) => {
    if (key === "metrics-coverage-start") throw new Error("example settings write failed");
    await set(key, value);
  });
  await expect(migrateLegacyGate(bb)).rejects.toThrow("example settings write failed");
  fail.mockRestore();
  expect(existsSync(target)).toBe(false);
  expect(await bb.storage.kv.get("project-settings-v1")).toBeUndefined();
  await migrateLegacyGate(bb);
  expect(existsSync(target)).toBe(true);
  expect(await bb.storage.kv.get("project-settings-v1")).toEqual(settings);
});
