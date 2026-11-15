import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createZstdDecompress } from 'node:zlib';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { bandOf, ESTIMATED, type UsageRow } from '../contract';
import type { Store } from '../store/write';
import { combine, outsideThread, readFile, exists, cooperation, LIMIT, MAX_JSON_BYTES, parseJsonLine, jsonFields, lineHead, stringField, type Batch, type FileSource, type ThreadInfo } from './files';
import { createCompactions, type FileCompaction } from './compactions';
import { normaliseTier } from './tiers';

async function decodeCodex(bytes: Buffer, signal?:AbortSignal) {
  const head = lineHead(bytes);
  if (!head.trimStart().startsWith('{')) throw new Error('Invalid transcript record');
  if (/"type"\s*:\s*"compacted"/.test(head)) {
    const timestamp = stringField(head,'timestamp');
    if (!timestamp) throw new Error('Incomplete Codex compaction header');
    const ordinal = /"ordinal"\s*:\s*(\d+)/.exec(head)?.[1];
    return {type:'compacted',timestamp,...(ordinal ? {ordinal:Number(ordinal)} : {})};
  }
  if (bytes.length>=MAX_JSON_BYTES && (bytes.indexOf('"token_usage_record"')>=0 || bytes.indexOf('"turn_context"')>=0)) {
    const f=await jsonFields(bytes,['type','timestamp','payload.usage','payload.response_id','payload.turn_id','payload.model','payload.service_tier'],signal);
    if (f.type!=='token_usage_record' && f.type!=='turn_context') return null;
    if (!f.timestamp || !f['payload.turn_id'] || (f.type==='token_usage_record' && (!f['payload.usage'] || !f['payload.response_id']))) throw new Error('Incomplete Codex usage fields');
    return {type:f.type,timestamp:f.timestamp,payload:{usage:f['payload.usage'],response_id:f['payload.response_id'],turn_id:f['payload.turn_id'],model:f['payload.model'],service_tier:f['payload.service_tier']}};
  }
  if (!/"type"\s*:\s*"(?:token_usage_record|turn_context)"/.test(head)) return null;
  return parseJsonLine(bytes);
}
function sessionMeta(bytes: Buffer) {
  if (bytes.length < MAX_JSON_BYTES) return parseJsonLine(bytes);
  const head = lineHead(bytes);
  if (!/"type"\s*:\s*"session_meta"/.test(head)) return null;
  const payload = {id:stringField(head,'id'),session_id:stringField(head,'session_id'),parent_thread_id:stringField(head,'parent_thread_id'),timestamp:stringField(head,'timestamp')};
  return {type:'session_meta',timestamp:payload.timestamp,payload};
}

type Entry = { rollout_path: string; id: string; root_session: string };
export function createCodexSource(o: { store: Store; db: Database; root?: string; archivedRoot?: string; now?: () => number }): FileSource {
  const root = o.root ?? join(homedir(), '.codex/sessions'), archived = o.archivedRoot ?? join(homedir(), '.codex/archived_sessions');
  const folders = new Map<string, number>();
  const listDirs = async (dir: string) => { try { return (await readdir(dir, { withFileTypes: true })).filter(x => x.isDirectory()).map(x => join(dir, x.name)); } catch (e: any) { if (e.code === 'ENOENT') return []; throw e; } };
  const first = async (path: string, signal?: AbortSignal) => {
    const input = createReadStream(path, { signal });
    const decoder = path.endsWith('.zst') ? createZstdDecompress() : null;
    if (decoder) { input.pipe(decoder); input.on('error', e => decoder.destroy(e)); }
    const stream = decoder ?? input, chunks: Buffer[] = []; let length=0, large:any=null, tail=''; const pause = cooperation(signal);
    try {
      for await (const raw of stream) {
        await pause(); const chunk = raw as Buffer, i = chunk.indexOf(10), part=i<0?chunk:chunk.subarray(0,i);
        length+=part.length;
        if (!large && length<MAX_JSON_BYTES) chunks.push(part);
        else {
          let scan=part;
          if (!large) { chunks.push(part); scan=Buffer.concat(chunks); large=sessionMeta(scan); chunks.length=0; if (!large) return null; }
          // IDs may follow a multi-megabyte instruction string; inspect bounded overlapping windows.
          for (let pos=0;pos<scan.length;pos+=8192) {
            await pause(); const head=tail+scan.toString('utf8',pos,Math.min(pos+8192,scan.length));
            for (const key of ['id','session_id','parent_thread_id','timestamp']) large.payload[key] ??= stringField(head,key);
            tail=head.slice(-2048);
          }
        }
        if (i>=0) return large ?? sessionMeta(Buffer.concat(chunks));
      }
      return null;
    } finally { input.destroy(); decoder?.destroy(); }
  };
  const refresh = async (signal?: AbortSignal) => {
    const dates: string[] = [], pause = cooperation(signal);
    for (const y of await listDirs(root)) for (const m of await listDirs(y)) for (const d of await listDirs(m)) { await pause(); dates.push(d); }
    for (const dir of [...dates, archived]) {
      await pause(); let mtime: number; try { mtime = (await stat(dir)).mtimeMs; } catch (e: any) { if (e.code === 'ENOENT') continue; throw e; }
      if (folders.get(dir) === mtime) continue;
      for (const name of await readdir(dir)) {
        await pause(); if (!/^rollout-.*\.jsonl(?:\.zst)?$/.test(name)) continue;
        const path = join(dir, name);
        if (o.db.prepare('SELECT 1 FROM codex_index WHERE rollout_path = ?').get(path)) continue;
        let meta: any; try { meta = await first(path, signal); } catch (e: any) { if (e instanceof SyntaxError || e.code === 'ENOENT') continue; throw e; }
        const p = meta?.payload;
        if (meta?.type !== 'session_meta' || !p?.id) continue;
        o.db.prepare('INSERT OR REPLACE INTO codex_index (rollout_path,id,root_session,parent_id,started_at) VALUES (?,?,?,?,?)').run(path, p.id, p.session_id ?? p.id, p.parent_thread_id ?? '', Date.parse(p.timestamp ?? meta.timestamp) || 0);
      }
      folders.set(dir, mtime);
    }
    for (const row of o.db.prepare('SELECT rollout_path FROM codex_index').all() as Array<{ rollout_path: string }>) { await pause(); if (!await exists(row.rollout_path)) o.db.prepare('DELETE FROM codex_index WHERE rollout_path = ?').run(row.rollout_path); }
  };
  const entries = (id: string) => o.db.prepare('SELECT rollout_path,id,root_session FROM codex_index WHERE root_session = ?').all(id) as Entry[];
  const flushEntries = async (t: ThreadInfo, files: Entry[], signal?: AbortSignal): Promise<Batch> => {
    const batches: Batch[] = [], budget = { remaining: LIMIT }, pause = cooperation(signal);
    for (const file of files) {
      await pause(); if (!budget.remaining) { batches.push({ rows: [], parseErrors: 0, more: true, commit() {} }); break; }
    const contexts = new Map<string, { model: string; tier: string }>();
    for (const row of o.db.prepare('SELECT turn_id,model,tier FROM codex_turn_context WHERE session_id = ?').all(file.id) as Array<{ turn_id: string; model: string; tier: string }>) { await pause(); contexts.set(row.turn_id, { model: row.model, tier: row.tier }); }
    const pending = new Map<string, { model: string; tier: string }>();
    const path = file.rollout_path;
    const stateKey = `codex-compaction:${file.id}`;
    const state = o.store.getCursor<{ before: number | null; pending: FileCompaction[] }>(stateKey) ?? { before: null, pending: [] };
    const resolved: FileCompaction[] = [];
    const batch = await readFile(o.db, path, {...t,providerThreadId:file.root_session}, (line): UsageRow | FileCompaction | null => {
      const p = line.payload;
      if (file.id === file.root_session) {
        if (line.type === 'compacted' && state.before !== null) {
          const marker: FileCompaction = { threadId: t.threadId, at: Date.parse(line.timestamp), before: state.before, after: null, conv: '', source: 'codex-file', key: `cxx:${file.id}:${line.ordinal ?? line.timestamp}` };
          if (!state.pending.some(m => m.key === marker.key)) state.pending.push(marker);
          return marker;
        }
        if (line.type === 'token_usage_record' && Number.isFinite(p?.usage?.input_tokens) && p.usage.input_tokens >= 0) {
          for (const marker of state.pending) resolved.push({ ...marker, after: p.usage.input_tokens });
          state.pending = []; state.before = p.usage.input_tokens;
        }
      }
      if (line.type === 'turn_context' && p?.turn_id) { const context = { model: p.model ?? 'unknown', tier: p.service_tier ?? '' }; contexts.set(p.turn_id, context); pending.set(p.turn_id, context); return null; }
      if (line.type !== 'token_usage_record' || !p?.response_id || !p.usage) return null;
      const u = p.usage, cacheRead = u.cached_input_tokens ?? 0, cacheWriteShort = u.cache_write_input_tokens ?? 0, freshIn = Math.max(0, (u.input_tokens ?? 0) - cacheRead - cacheWriteShort), output = u.output_tokens ?? 0;
      const ctx = contexts.get(p.turn_id), tierRaw = ctx?.tier ?? '', promptTokens = freshIn + cacheRead + cacheWriteShort;
      return { key: `cx:${p.response_id}`, ts: Date.parse(line.timestamp), threadId: t.threadId, projectId: t.projectId, provider: 'codex', model: ctx?.model ?? 'unknown', tier: normaliseTier(tierRaw), tierRaw, promptTokens, band: bandOf(promptTokens), conv: file.id === file.root_session ? '' : `child:${file.id}`, freshIn, cacheRead, cacheWriteShort, cacheWriteLong: 0, output, reasoning: u.reasoning_output_tokens ?? 0, turnId: p.turn_id ?? null, source: 'codex-file', flags: (!ctx || cacheWriteShort > 0) ? ESTIMATED : 0 };
    }, budget, signal, true, decodeCodex);
    const accepted = resolved.filter(m => (!t.isFork || m.at >= t.createdAt) && ((batch.compactions ?? []).some(b => b.key===m.key) || o.db.prepare('SELECT 1 FROM compaction_file WHERE key=?').get(m.key)));
    batches.push({ ...batch, compactions: [...new Map([...(batch.compactions ?? []), ...accepted].map(m => [m.key,m])).values()], commit() { batch.commit(); createCompactions(o.db,o.store,o.now ?? Date.now,false).upsert(accepted); o.store.setCursor(stateKey,state); const stmt = o.db.prepare('INSERT INTO codex_turn_context VALUES (?,?,?,?) ON CONFLICT(session_id,turn_id) DO UPDATE SET model=excluded.model,tier=excluded.tier'); for (const [id, c] of pending) stmt.run(file.id, id, c.model, c.tier); } });
    }
    return combine(batches);
  };
  return { async locate(t, signal) { await refresh(signal); return t.providerThreadIds.some(id=>entries(id).some(f=>f.id===id)); }, async flushThread(t, signal) { await refresh(signal); return flushEntries(t,[...new Map(t.providerThreadIds.flatMap(entries).map(f=>[f.rollout_path,f])).values()],signal); }, async scanOutside(known, since, signal) {
    await refresh(signal); const all = o.db.prepare('SELECT rollout_path,id,root_session FROM codex_index WHERE id = root_session').all() as Entry[];
    const batches: Batch[] = [], pause = cooperation(signal);
    for (const rootFile of all) { await pause(); if (!known.has(rootFile.id) && (await stat(rootFile.rollout_path)).mtimeMs >= since) batches.push(await flushEntries(outsideThread(rootFile.id, 'codex'), entries(rootFile.id), signal)); }
    return combine(batches);
  } };
}
