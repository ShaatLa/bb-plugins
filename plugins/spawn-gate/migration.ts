import type { BbPluginApi } from "@get-bb/plugin-sdk";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

const legacyId = "agent-spawn-gate";
const marker = "_spawn_gate_id_migration";
const readOnly = { readonly: true, fileMustExist: true };

function legacySettings(dataDir: string) {
  const host = new Database(join(dataDir, "bb.db"), readOnly);
  try {
    return host.transaction(() => {
      const legacy = host.prepare("SELECT enabled FROM plugins WHERE id = ?").get(legacyId) as { enabled: number } | undefined;
      if (legacy?.enabled) throw new Error("Disable the legacy Spawn Gate plugin before migrating");
      return host.prepare("SELECT key, value FROM plugin_kv WHERE plugin_id = ? AND key IN ('project-settings-v1', 'metrics-coverage-start')")
        .all(legacyId) as { key: string; value: string }[];
    })();
  } finally {
    host.close();
  }
}

export async function migrateLegacyGate(bb: BbPluginApi) {
  if (bb.pluginId !== "spawn-gate") return;
  const dataDir = bb.server.experimental_dataDir;
  const sourcePath = join(dataDir, "plugins", legacyId, "data.db");
  if (!existsSync(sourcePath)) return;
  const directory = join(dataDir, "plugins", bb.pluginId);
  const target = join(directory, "data.db");
  if (existsSync(target)) {
    const current = new Database(target, readOnly);
    try {
      if (current.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(marker)) return;
      throw new Error("Spawn Gate migration would overwrite an existing database");
    } finally {
      current.close();
    }
  }
  const settings = legacySettings(dataDir).map(({ key, value }) => [key, JSON.parse(value)] as const);
  const missing: (readonly [string, unknown])[] = [];
  for (const [key, value] of settings) {
    const current = await bb.storage.kv.get(key);
    if (current === undefined) missing.push([key, value] as const);
    else if (!isDeepStrictEqual(current, value)) throw new Error("Spawn Gate migration would overwrite an existing setting");
  }

  mkdirSync(directory, { recursive: true });
  const staging = mkdtempSync(join(directory, "migration-"));
  const backup = join(staging, "data.db");
  const added: string[] = [];
  try {
    const old = new Database(sourcePath, readOnly);
    try {
      await old.backup(backup);
    } finally {
      old.close();
    }
    const copy = new Database(backup);
    try {
      copy.pragma("journal_mode = DELETE");
      copy.exec(`CREATE TABLE ${marker} (completedAt TEXT NOT NULL)`);
      copy.prepare(`INSERT INTO ${marker} VALUES (?)`).run(new Date().toISOString());
    } finally {
      copy.close();
    }
    for (const [key, value] of missing) {
      await bb.storage.kv.set(key, value);
      added.push(key);
    }
    // Publish before the host opens the new database or registers gate hooks.
    renameSync(backup, target);
  } catch (error) {
    for (const key of added) await bb.storage.kv.delete(key);
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  bb.log.info("Migrated Spawn Gate settings and database from agent-spawn-gate");
}
