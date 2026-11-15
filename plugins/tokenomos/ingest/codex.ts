import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { bandOf, ESTIMATED, type UsageRow } from '../contract';
import type { Store } from '../store/write';
import { combine, outsideThread, readFile, type Batch, type FileSource, type ThreadInfo } from './files';
import { normaliseTier } from './tiers';

type Entry = { rollout_path: string; id: string; root_session: string };
export function createCodexSource(o: { store: Store; db: Database; root?: string; archivedRoot?: string; now?: () => number }): FileSource {
  const root = o.root ?? join(homedir(), '.codex/sessions'), archived = o.archivedRoot ?? join(homedir(), '.codex/archived_sessions');
  const folders = new Map<string, number>();
  const listDirs = (dir: string) => { try { return readdirSync(dir, { withFileTypes: true }).filter(x => x.isDirectory()).map(x => join(dir, x.name)); } catch (e: any) { if (e.code === 'ENOENT') return []; throw e; } };
  const first = (path: string) => {
    const fd = openSync(path, 'r'); let s = '';
    try { const buf = Buffer.alloc(8192); let n; while ((n = readSync(fd, buf, 0, buf.length, null))) { s += buf.toString('utf8', 0, n); const i = s.indexOf('\n'); if (i >= 0) return JSON.parse(s.slice(0, i)); } return null; } finally { closeSync(fd); }
  };
  const refresh = () => {
    const dates = listDirs(root).flatMap(listDirs).flatMap(listDirs);
    for (const dir of [...dates, archived]) {
      let mtime: number; try { mtime = statSync(dir).mtimeMs; } catch (e: any) { if (e.code === 'ENOENT') continue; throw e; }
      if (folders.get(dir) === mtime) continue;
      for (const name of readdirSync(dir)) {
        if (!/^rollout-.*\.jsonl$/.test(name)) continue;
        const path = join(dir, name);
        if (o.db.prepare('SELECT 1 FROM codex_index WHERE rollout_path = ?').get(path)) continue;
        let meta: any; try { meta = first(path); } catch (e: any) { if (e instanceof SyntaxError || e.code === 'ENOENT') continue; throw e; }
        const p = meta?.payload;
        if (meta?.type !== 'session_meta' || !p?.id) continue;
        o.db.prepare('INSERT OR REPLACE INTO codex_index (rollout_path,id,root_session,parent_id,started_at) VALUES (?,?,?,?,?)').run(path, p.id, p.session_id ?? p.id, p.parent_thread_id ?? '', Date.parse(p.timestamp ?? meta.timestamp) || 0);
      }
      folders.set(dir, mtime);
    }
    for (const row of o.db.prepare('SELECT rollout_path FROM codex_index').all() as Array<{ rollout_path: string }>) if (!existsSync(row.rollout_path)) o.db.prepare('DELETE FROM codex_index WHERE rollout_path = ?').run(row.rollout_path);
  };
  const entries = (id: string) => o.db.prepare('SELECT rollout_path,id,root_session FROM codex_index WHERE root_session = ?').all(id) as Entry[];
  const flushEntries = (t: ThreadInfo, files: Entry[]): Batch => combine(files.map(file => {
    const contexts = new Map<string, { model: string; tier: string }>();
    for (const row of o.db.prepare('SELECT turn_id,model,tier FROM codex_turn_context WHERE session_id = ?').all(file.id) as Array<{ turn_id: string; model: string; tier: string }>) contexts.set(row.turn_id, { model: row.model, tier: row.tier });
    const pending = new Map<string, { model: string; tier: string }>();
    const batch = readFile(o.db, file.rollout_path, t, (line): UsageRow | null => {
      const p = line.payload;
      if (line.type === 'turn_context' && p?.turn_id) { const context = { model: p.model ?? 'unknown', tier: p.service_tier ?? '' }; contexts.set(p.turn_id, context); pending.set(p.turn_id, context); return null; }
      if (line.type !== 'token_usage_record' || !p?.response_id || !p.usage) return null;
      const u = p.usage, cacheRead = u.cached_input_tokens ?? 0, cacheWriteShort = u.cache_write_input_tokens ?? 0, freshIn = Math.max(0, (u.input_tokens ?? 0) - cacheRead - cacheWriteShort), output = u.output_tokens ?? 0;
      const ctx = contexts.get(p.turn_id), tierRaw = ctx?.tier ?? '', promptTokens = freshIn + cacheRead + cacheWriteShort;
      return { key: `cx:${p.response_id}`, ts: Date.parse(line.timestamp), threadId: t.threadId, projectId: t.projectId, provider: 'codex', model: ctx?.model ?? 'unknown', tier: normaliseTier(tierRaw), tierRaw, promptTokens, band: bandOf(promptTokens), conv: file.id === file.root_session ? '' : `child:${file.id}`, freshIn, cacheRead, cacheWriteShort, cacheWriteLong: 0, output, reasoning: u.reasoning_output_tokens ?? 0, turnId: p.turn_id ?? null, source: 'codex-file', flags: (!ctx || cacheWriteShort > 0) ? ESTIMATED : 0 };
    }, true);
    return { ...batch, commit() { batch.commit(); const stmt = o.db.prepare('INSERT INTO codex_turn_context VALUES (?,?,?,?) ON CONFLICT(session_id,turn_id) DO UPDATE SET model=excluded.model,tier=excluded.tier'); for (const [id, c] of pending) stmt.run(file.id, id, c.model, c.tier); } };
  }));
  return { async locate(t) { refresh(); return !!t.providerThreadId && entries(t.providerThreadId).some(f => f.id === t.providerThreadId); }, async flushThread(t) { refresh(); return flushEntries(t, t.providerThreadId ? entries(t.providerThreadId) : []); }, async scanOutside(known, since) {
    refresh(); const all = o.db.prepare('SELECT rollout_path,id,root_session FROM codex_index WHERE id = root_session').all() as Entry[];
    const batches: Batch[] = [];
    for (const rootFile of all) if (!known.has(rootFile.id) && statSync(rootFile.rollout_path).mtimeMs >= since) batches.push(flushEntries(outsideThread(rootFile.id, 'codex'), entries(rootFile.id)));
    return combine(batches);
  } };
}
