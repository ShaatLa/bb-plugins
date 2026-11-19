import { DatabaseSync } from "node:sqlite";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { BbPluginApi, PluginSettingDescriptors } from "@get-bb/plugin-sdk";

const legacyId = "delivery-dashboard", markerKey = "migration";
type Settings = { experimental_set(values: Record<string, string | number | boolean | null>): Promise<unknown> };
type Row = { key: string; value: string };

export function legacyRegistered(dataDir: string) {
  const path = join(dataDir, "bb.db");
  if (!existsSync(path)) return false;
  const host = new DatabaseSync(path, { readOnly: true });
  try { return !!host.prepare("SELECT 1 FROM plugins WHERE id = ? AND removed_at IS NULL").get(legacyId); }
  finally { host.close(); }
}

export function snapshot(source: string, destination: string) {
  const db = new DatabaseSync(source, { readOnly: true });
  try { db.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`); chmodSync(destination, 0o600); }
  finally { db.close(); }
}

function initialized(path: string) {
  if (!existsSync(path)) return false;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return ["ci_jobs", "repository_history"].some((table) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
      && db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get());
  } finally { db.close(); }
}

// No host writes: only the new plugin's storage APIs and its not-yet-open database file.
export async function migrateId(bb: BbPluginApi, descriptors: PluginSettingDescriptors, settings: Settings): Promise<string | null> {
  const marker = await bb.storage.kv.get<{ from?: string; state?: string }>(markerKey);
  if (marker?.from === legacyId && marker.state === "done") return null;
  const dataDir = bb.server.experimental_dataDir, hostPath = join(dataDir, "bb.db");
  if (!existsSync(hostPath)) return null;
  const host = new DatabaseSync(hostPath, { readOnly: true });
  try {
    const legacy = host.prepare("SELECT enabled, removed_at FROM plugins WHERE id = ?").get(legacyId);
    if (!legacy) return null;
    function refuse(reason: string) { bb.log.warn(reason); return reason; }
    if (legacy.enabled === 1 && legacy.removed_at === null) return refuse("CI Dashboard migration blocked: disable delivery-dashboard, then reload ci-dashboard.");
    const ownDir = join(dataDir, "plugins", bb.pluginId), target = join(ownDir, "data.db");
    const retry = marker?.from === legacyId && marker.state === "started";
    if (!retry && ((await bb.storage.kv.list()).length || host.prepare("SELECT 1 FROM plugin_settings WHERE plugin_id = ? LIMIT 1").get(bb.pluginId)
      || host.prepare("SELECT 1 FROM plugin_kv WHERE plugin_id = ? LIMIT 1").get(bb.pluginId) || initialized(target))) {
      return refuse("CI Dashboard migration blocked: target already has initialized state; nothing was overwritten.");
    }
    const kv = host.prepare("SELECT key, value FROM plugin_kv WHERE plugin_id = ?").all(legacyId) as Row[];
    const rows = host.prepare("SELECT key, value FROM plugin_settings WHERE plugin_id = ?").all(legacyId) as Row[];
    const values: Record<string, string | number | boolean | null> = {};
    for (const { key, value } of rows) {
      const descriptor = Object.hasOwn(descriptors, key) ? descriptors[key] : undefined;
      if (!descriptor) { bb.log.warn(`CI Dashboard migration: skipped unknown setting ${key}.`); continue; }
      if (descriptor.type === "string" && descriptor.secret) continue;
      const parsed: unknown = JSON.parse(value);
      if (parsed !== null) {
        const type = descriptor.type === "select" || descriptor.type === "project" ? "string" : descriptor.type;
        if (typeof parsed !== type || (descriptor.type === "select" && !descriptor.options.includes(parsed as string))) throw new Error("Invalid legacy setting");
        if (descriptor.experimental_schema) {
          const validation = await descriptor.experimental_schema["~standard"].validate(parsed as never);
          if (validation.issues) throw new Error("Invalid legacy setting");
        }
      }
      values[key] = parsed as string | number | boolean | null;
    }
    await bb.storage.kv.set(markerKey, { from: legacyId, state: "started", at: new Date().toISOString() });
    const staging = join(ownDir, "migration");
    mkdirSync(staging, { recursive: true, mode: 0o700 }); chmodSync(staging, 0o700);
    const source = join(dataDir, "plugins", legacyId, "data.db"), backup = join(staging, "delivery-dashboard.db");
    const temporary = join(staging, "snapshot.tmp");
    if (existsSync(source)) {
      rmSync(temporary, { force: true });
      snapshot(source, temporary);
      renameSync(temporary, backup);
      const replacement = join(staging, "replacement.tmp");
      copyFileSync(backup, replacement); chmodSync(replacement, 0o600);
      for (const suffix of ["-wal", "-shm"]) rmSync(target + suffix, { force: true });
      renameSync(replacement, target);
    }
    // A started marker owns partial namespace writes, so retry replaces rather than merges them.
    if (retry) {
      for (const key of await bb.storage.kv.list()) if (key !== markerKey) await bb.storage.kv.delete(key);
      await settings.experimental_set(Object.fromEntries(Object.entries(descriptors).filter(([, d]) => !(d.type === "string" && d.secret)).map(([key]) => [key, null])));
    }
    for (const { key, value } of kv) {
      if (key === markerKey) throw new Error("Legacy migration marker conflicts with cut-over marker");
      await bb.storage.kv.set(key, JSON.parse(value));
    }
    await settings.experimental_set(values);
    const secrets = join(dataDir, "plugins", legacyId, "secrets");
    if (existsSync(secrets) && readdirSync(secrets).length) bb.log.warn("CI Dashboard migration: legacy secret file exists; set the token again in ci-dashboard.");
    await bb.storage.kv.set(markerKey, { from: legacyId, state: "done", at: new Date().toISOString() });
    if (existsSync(backup)) bb.log.info(`CI Dashboard migration backup: ${backup}`);
    return null;
  } finally { host.close(); }
}
