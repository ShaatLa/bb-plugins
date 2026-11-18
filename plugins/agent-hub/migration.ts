import type { BbPluginApi } from '@get-bb/plugin-sdk';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, copyFileSync, readFileSync, chmodSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { migrations } from './schema';
import { projectSchema } from './project-config';
import { preferencesSchema } from './preferences';

const marker = '_agent_hub_migration';
type Report = { ran: boolean; completedAt: string | null; kvKeys: string[]; secrets: string[]; error: string | null };
const emptyReport = (): Report => ({ ran: false, completedAt: null, kvKeys: [], secrets: [], error: null });
const paths = (bb: BbPluginApi) => ({ old: join(bb.server.experimental_dataDir, 'plugins/answers'), next: join(bb.server.experimental_dataDir, 'plugins/agent-hub') });
function count(db: Database.Database) {
 return db.prepare("SELECT 1 FROM sqlite_master WHERE name='items'").get() ? (db.prepare('SELECT count(*) n FROM items').get() as { n: number }).n : 0;
}
function report(db: Database.Database): Report {
 return db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(marker) ? JSON.parse((db.prepare(`SELECT value FROM ${marker}`).get() as { value: string }).value) : emptyReport();
}
export function needsMigration(bb: BbPluginApi) {
 return bb.pluginId === 'agent-hub' && existsSync(join(paths(bb).old, 'data.db'));
}
export async function migrateAnswers(bb: BbPluginApi) {
 const { old, next } = paths(bb), target = join(next, 'data.db'), staging = join(next, 'migration.db');
 mkdirSync(next, { recursive: true });
 if (existsSync(target)) {
  const current = new Database(target, { readonly: true });
  try {
   if (report(current).ran) return;
   if (count(current)) throw new Error('Migration deferred: new store already contains items; refusing to overwrite it');
  } finally { current.close(); }
 }
 const previous = new Map<string, unknown>(), copiedSecrets: string[] = [], secretNames: string[] = [];
 let source: Database.Database | undefined, staged: Database.Database | undefined;
 try {
  rmSync(staging, { force: true });
  source = new Database(join(old, 'data.db'), { readonly: true, fileMustExist: true });
  await source.backup(staging);
  source.close(); source = undefined;
  staged = new Database(staging);
  bb.storage.migrate(staged, migrations);
  const host = new Database(join(bb.server.experimental_dataDir, 'bb.db'), { readonly: true, fileMustExist: true });
  let values: Map<string, unknown>;
  try {
   values = host.transaction(() => {
    const rows = host.prepare("SELECT key,value FROM plugin_kv WHERE plugin_id='answers' AND (key='preferences' OR key LIKE 'config:project:%')").all() as { key: string; value: string }[];
    const result = new Map(rows.map(r => [r.key, JSON.parse(r.value)]));
    if (!result.has('preferences')) {
     const settings = host.prepare("SELECT key,value FROM plugin_settings WHERE plugin_id='answers'").all() as { key: string; value: string }[];
     result.set('preferences', preferencesSchema.parse(Object.fromEntries(settings.filter(r => Object.hasOwn(preferencesSchema.shape, r.key)).map(r => [r.key, JSON.parse(r.value)]))));
    }
    result.set('preferences', preferencesSchema.parse(result.get('preferences')));
    return result;
   })();
  } finally { host.close(); }
  for (const [key, value] of values) {
   if (key.startsWith('config:project:')) projectSchema.parse(value);
   previous.set(key, await bb.storage.kv.get(key));
   await bb.storage.kv.set(key, value);
  }
  if (existsSync(join(old, 'secrets'))) {
   mkdirSync(join(next, 'secrets'), { recursive: true, mode: 0o700 });
   for (const entry of readdirSync(join(old, 'secrets'), { withFileTypes: true })) {
    if (!entry.isFile()) throw new Error('Unexpected entry in legacy secrets directory');
    secretNames.push(entry.name);
    const dest = join(next, 'secrets', entry.name);
    if (existsSync(dest)) {
     if (readFileSync(dest).equals(readFileSync(join(old, 'secrets', entry.name)))) continue;
     throw new Error('Refusing to overwrite an existing secret');
    }
    copyFileSync(join(old, 'secrets', entry.name), dest); copiedSecrets.push(entry.name); chmodSync(dest, 0o600);
   }
  }
  const result: Report = { ran: true, completedAt: new Date().toISOString(), kvKeys: [...values.keys()], secrets: secretNames, error: null };
  staged.exec(`CREATE TABLE ${marker} (value TEXT NOT NULL)`);
  staged.prepare(`INSERT INTO ${marker} VALUES (?)`).run(JSON.stringify(result));
  staged.pragma('wal_checkpoint(TRUNCATE)'); staged.close(); staged = undefined;
  // The host has not opened its database yet, so publication cannot race its ingestion.
  rmSync(target + '-wal', { force: true }); rmSync(target + '-shm', { force: true });
  renameSync(staging, target);
 } catch (error) {
  for (const [key, value] of previous) {
   if (value === undefined) await bb.storage.kv.delete(key); else await bb.storage.kv.set(key, value);
  }
  for (const name of copiedSecrets) rmSync(join(next, 'secrets', name), { force: true });
  throw error;
 } finally {
  source?.close(); staged?.close();
  for (const suffix of ['', '-wal', '-shm']) rmSync(staging + suffix, { force: true });
 }
}
export function migrationStatus(bb: BbPluginApi, db: Database.Database, error: string | null) {
 const result = { ...report(db), error }, oldPath = join(paths(bb).old, 'data.db');
 let oldCount: number | null = null, matchingItemIds: string[] = [];
 if (existsSync(oldPath)) {
  const old = new Database(oldPath, { readonly: true, fileMustExist: true });
  try {
   oldCount = count(old);
   const ids = db.prepare('SELECT id FROM items ORDER BY id LIMIT 20').all() as { id: string }[];
   matchingItemIds = ids.filter(({ id }) => old.prepare('SELECT 1 FROM items WHERE id=?').get(id)).map(r => r.id);
  } finally { old.close(); }
 }
 return { ...result, oldItemCount: oldCount, newItemCount: count(db), matchingItemIds };
}
