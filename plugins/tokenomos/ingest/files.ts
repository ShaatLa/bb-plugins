// Call commit() in the same transaction immediately after applying the returned rows.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { setImmediate as yieldNow } from 'node:timers/promises';
import { createZstdDecompress } from 'node:zlib';
import type { Database } from 'better-sqlite3';
import type { UsageRow } from '../contract';
import { createCompactions, type FileCompaction } from './compactions';
import { createStore } from '../store/write';

export type ThreadInfo = { threadId: string; providerThreadId: string | null; providerThreadIds: string[]; provider: string; projectId: string; createdAt: number; isFork: boolean; cwd: string | null };
export type Batch = { rows: UsageRow[]; compactions?: FileCompaction[]; parseErrors: number; more?: boolean; commit(): void };
export interface FileSource {
  locate(t: ThreadInfo, signal?: AbortSignal): Promise<boolean>;
  flushThread(t: ThreadInfo, signal?: AbortSignal): Promise<Batch>;
  scanOutside(knownSessions: Set<string>, sinceTs: number, signal?: AbortSignal): Promise<{ rows: UsageRow[]; compactions?: FileCompaction[]; more?: boolean; commit(): void }>;
}
export const MAX_JSON_BYTES = 1024 * 1024;
export function parseJsonLine(bytes: Buffer): any {
  if (bytes.length >= MAX_JSON_BYTES) throw new Error('Transcript JSON exceeds the synchronous parse limit');
  return JSON.parse(bytes.toString('utf8'));
}
// Metadata strings are decoded individually; large transcript bodies never reach JSON.parse.
export function stringField(head: string, name: string): string | undefined {
  const value = new RegExp('"' + name + '"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")').exec(head)?.[1];
  return value === undefined ? undefined : JSON.parse(value);
}
export const lineHead = (bytes: Buffer) => bytes.toString('utf8', 0, Math.min(bytes.length, 8192));
// Read only selected object paths; skip bodies without allocating strings or parsing their JSON.
export async function jsonFields(bytes: Buffer, paths: string[], signal?: AbortSignal): Promise<Record<string,any>> {
  const found:Record<string,any> = {}, pause=cooperation(signal);
  const whitespace = async (pos:number) => {
    while (pos<bytes.length && (bytes[pos]===32 || bytes[pos]===9 || bytes[pos]===13 || bytes[pos]===10)) {
      if ((pos & 4095)===0) await pause(); pos++;
    }
    return pos;
  };
  const stringEnd = async (start:number) => {
    let pos=start+1;
    for (;;) {
      await pause(); const end=Math.min(pos+65536,bytes.length), relative=bytes.subarray(pos,end).indexOf(34);
      if (relative<0) { pos=end; if (pos>=bytes.length) throw new Error('Unterminated transcript string'); continue; }
      const quote=pos+relative;
      let back=quote-1; while (back>=start && bytes[back]===92) { if ((back & 4095)===0) await pause(); back--; }
      if ((quote-back-1)%2===0) return quote+1;
      pos=quote+1;
    }
  };
  const valueEnd = async (start:number) => {
    if (bytes[start]===34) return stringEnd(start);
    if (bytes[start]===123 || bytes[start]===91) {
      let depth=0;
      for (let pos=start;pos<bytes.length;pos++) {
        if ((pos & 4095)===0) await pause();
        const c=bytes[pos];
        if (c===34) { pos=await stringEnd(pos)-1; continue; }
        if (c===123 || c===91) depth++;
        if ((c===125 || c===93) && --depth===0) return pos+1;
      }
      throw new Error('Unterminated transcript object');
    }
    let pos=start;
    while (pos<bytes.length && ![44,125,93,32,9,10,13].includes(bytes[pos])) { if ((pos & 4095)===0) await pause(); pos++; }
    return pos;
  };
  const object = async (start:number, prefix:string):Promise<number> => {
    let pos=await whitespace(start+1);
    while (pos<bytes.length && bytes[pos]!==125) {
      await pause(); if (bytes[pos]!==34) throw new Error('Invalid transcript field');
      const end=await stringEnd(pos);
      const key=end-pos<=512 ? JSON.parse(bytes.toString('utf8',pos,end)) as string : '';
      pos=await whitespace(end); if (bytes[pos++]!==58) throw new Error('Invalid transcript field');
      pos=await whitespace(pos); const path=prefix ? `${prefix}.${key}` : key;
      if (paths.includes(path)) {
        const end=await valueEnd(pos);
        if (end-pos>65536) throw new Error(`Transcript field ${path} exceeds metadata limit`);
        found[path]=JSON.parse(bytes.toString('utf8',pos,end)); pos=end;
      } else if (bytes[pos]===123 && paths.some(p=>p.startsWith(path+'.'))) pos=await object(pos,path);
      else pos=await valueEnd(pos);
      pos=await whitespace(pos);
      if (bytes[pos]===125) return pos+1;
      if (bytes[pos++]!==44) throw new Error('Invalid transcript object');
      pos=await whitespace(pos);
    }
    if (bytes[pos]!==125) throw new Error('Unterminated transcript object');
    return pos+1;
  };
  const start=await whitespace(0); if (bytes[start]!==123) throw new Error('Invalid transcript object');
  await object(start,''); signal?.throwIfAborted(); return found;
}

export const LIMIT = 2 * 1024 * 1024;
export function cooperation(signal?: AbortSignal) {
  let last = performance.now();
  return async () => { signal?.throwIfAborted(); if (performance.now() - last >= 8) { await yieldNow(); signal?.throwIfAborted(); last = performance.now(); } };
}
export async function exists(path: string) { try { await stat(path); return true; } catch (e: any) { if (e.code === 'ENOENT') return false; throw e; } }
type Cursor = { path: string; inode: number; size: number; mtime: number; offset: number; head_hash: string; watermark_ts: number; thread_id: string; root_session: string; compaction_watermark_ts: number };

type StreamState = { input: ReturnType<typeof createReadStream>; decoder: ReturnType<typeof createZstdDecompress>; iterator: AsyncIterator<any>; pending: Buffer; head: Buffer; position: number; done: boolean; signature: string; signal?: AbortSignal; abort?: () => void };
const streams = new Map<string, StreamState>();
const partial = new Map<string, { signature: string; offset: number; bytes: Buffer }>();
function closeStream(path: string) { const state = streams.get(path); if (state) { if (state.abort) state.signal?.removeEventListener('abort', state.abort); state.input.destroy(); state.decoder.destroy(); streams.delete(path); } }
async function compressedRange(path: string, offset: number, limit: number, signature: string, signal?: AbortSignal) {
  let state = streams.get(path);
  if (state && (state.signature !== signature || state.position > offset)) { closeStream(path); state = undefined; }
  if (!state) {
    const input = createReadStream(path), decoder = createZstdDecompress();
    input.pipe(decoder); input.on('error', e => decoder.destroy(e)); decoder.on('error', () => {});
    state = { input, decoder, iterator: decoder[Symbol.asyncIterator](), pending: Buffer.alloc(0), head: Buffer.alloc(0), position: 0, done: false, signature };
    streams.set(path, state);
  }
  const current = state;
  if (current.abort) current.signal?.removeEventListener('abort', current.abort);
  current.signal = signal; current.abort = () => closeStream(path);
  signal?.addEventListener('abort', current.abort, { once: true });
  const pause = cooperation(signal); let spent = 0;
  try {
    while (spent < limit && (current.position < offset || current.pending.length < limit - spent) && !current.done) {
      await pause();
      if (current.pending.length && current.position < offset) {
        const n = Math.min(current.pending.length, offset - current.position, limit - spent);
        current.pending = current.pending.subarray(n); current.position += n; spent += n; continue;
      }
      const next = await current.iterator.next();
      signal?.throwIfAborted();
      if (next.done) { current.done = true; break; }
      const chunk: Buffer = next.value;
      if (current.head.length < 4096) current.head = Buffer.concat([current.head, chunk.subarray(0, 4096 - current.head.length)]);
      current.pending = Buffer.concat([current.pending, chunk]);
    }
    if (current.position < offset) return { bytes: Buffer.alloc(0), head: current.head, more: !current.done, spent, skip: true, commit() {} };
    const bytes = current.pending.subarray(0, limit - spent);
    return { bytes, head: current.head, more: !current.done || current.pending.length > bytes.length, spent: spent + bytes.length, skip: false,
      commit(end: number) { current.pending = current.pending.subarray(end); current.position += end; if (current.done && !current.pending.length) closeStream(path); } };
  } catch (e) { closeStream(path); throw e; }
}
function oGetComplete(db: Database, name: string): string | null {
  const row = db.prepare('SELECT value FROM cursor WHERE name = ?').get(name) as { value: string } | undefined;
  return row ? JSON.parse(row.value) : null;
}
export async function readFile(db: Database, path: string, t: ThreadInfo, parse: (line: any) => UsageRow | FileCompaction | null, budget: { remaining: number }, signal?: AbortSignal, move = false, decode: (bytes: Buffer, signal?:AbortSignal) => any = parseJsonLine): Promise<Batch> {
  signal?.throwIfAborted(); const st = await stat(path); const compressed = path.endsWith('.zst');
  let old = db.prepare('SELECT *, "offset" AS offset FROM file_cursor WHERE path = ?').get(path) as Cursor | undefined;
  if (!old && move) {
    const candidates = db.prepare('SELECT *, "offset" AS offset FROM file_cursor WHERE root_session = ?').all(t.providerThreadId ?? '') as Cursor[];
    const pause = cooperation(signal);
    for (const c of candidates) { await pause(); if (basename(c.path).replace(/\.zst$/, '') === basename(path).replace(/\.zst$/, '') && !await exists(c.path)) { old = c; break; } }
  }
  const unchanged = old?.path === path && old.inode === st.ino && old.size === st.size && old.mtime === Math.trunc(st.mtimeMs * 1000);
  if (unchanged && !compressed && old!.offset >= st.size) return combine([]);
  const completedName = `file-zstd-complete:${path}`;
  const completed = compressed && oGetComplete(db, completedName);
  if (unchanged && completed === `${st.ino}:${st.size}:${st.mtimeMs}:${old!.offset}`) return combine([]);
  const handle = compressed ? null : await open(path, 'r');
  try {
    let head: Buffer, bytes: Buffer, hasMore: boolean;
    let compressedCommit: ((end: number) => void) | undefined, skipped = 0;
    const signature = `${st.ino}:${st.size}:${st.mtimeMs}`;
    let offset = old?.offset ?? 0;
    const saved = partial.get(path);
    let carry = saved && saved.signature === signature && saved.offset === offset ? saved.bytes : Buffer.alloc(0);
    if (!carry.length) partial.delete(path);
    if (compressed) {
      // A changed archive must be replayed, retaining its watermark.
      if (old && old.path === path && !unchanged) { offset = 0; carry = Buffer.alloc(0); }
      const range = await compressedRange(path, offset + carry.length, budget.remaining, signature, signal);
      head = range.head; bytes = range.bytes; hasMore = range.more; compressedCommit = range.commit; skipped = range.spent - bytes.length;
      if (range.skip) { budget.remaining -= range.spent; return { ...combine([]), more: range.more }; }
    } else {
      head = Buffer.alloc(Math.min(st.size, 4096)); await handle!.read(head, 0, head.length, 0);
      bytes = Buffer.alloc(0); hasMore = false;
    }
    const hash = (length: number) => createHash('sha1').update(head.subarray(0, Math.min(length, 4096))).digest('hex');
    const sameHead = !old || hash(old.path.endsWith('.zst') ? 4096 : old.size) === old.head_hash;
    const moved = old && old.path !== path && sameHead && (compressed || st.size >= old.offset);
    if (old && (!sameHead || (!moved && old.inode !== st.ino) || (!compressed && st.size < old.offset))) {
      offset = 0; carry = Buffer.alloc(0); partial.delete(path);
      if (compressed) { closeStream(path); const range = await compressedRange(path, 0, budget.remaining, signature, signal); bytes = range.bytes; hasMore = range.more; compressedCommit = range.commit; skipped = range.spent - bytes.length; }
    }
    if (!compressed) {
      bytes = Buffer.alloc(Math.min(budget.remaining, Math.max(0, st.size - offset - carry.length)));
      const r = await handle!.read(bytes, 0, bytes.length, offset + carry.length); bytes = bytes.subarray(0, r.bytesRead); hasMore = offset + carry.length + bytes.length < st.size;
    }
    budget.remaining -= bytes.length + skipped;
    const newBytes = bytes.length;
    if (carry.length) bytes = Buffer.concat([carry, bytes]);
    const end = bytes.lastIndexOf(10) + 1, watermark = old?.watermark_ts ?? 0;
    let max = watermark, parseErrors = 0, pos = 0; const rows = new Map<string, UsageRow>(), pause = cooperation(signal);
    const markers = new Map<string, FileCompaction>();
    let markerMax = old?.compaction_watermark_ts ?? 0;
    const existsRow = db.prepare('SELECT 1 FROM usage_raw WHERE key = ?');
    while (pos < end) {
      const next = bytes.indexOf(10, pos); const raw = bytes.subarray(pos, next); pos = next + 1;
      await pause(); let line: any;
      try { line = await decode(raw,signal); } catch (error) { signal?.throwIfAborted(); parseErrors++; continue; }
      if (line === null) continue;
      const row = parse(line);
      if (row && 'before' in row) {
        if (!Number.isFinite(row.at) || !Number.isFinite(row.before) || row.before < 0 || (row.after !== null && (!Number.isFinite(row.after) || row.after < 0)) || (t.isFork && row.at < t.createdAt)) continue;
        if (row.at <= (old?.compaction_watermark_ts ?? 0) && !db.prepare('SELECT 1 FROM compaction_file WHERE key=?').get(row.key)) continue;
        markers.set(row.key, row); markerMax = Math.max(markerMax, row.at); continue;
      }
      if (!row || !Number.isFinite(row.ts) || (t.isFork && row.ts < t.createdAt)) continue;
      if (row.ts <= watermark && !existsRow.get(row.key) && !rows.has(row.key)) continue;
      rows.set(row.key, row); max = Math.max(max, row.ts);
    }
    signal?.throwIfAborted(); const headHash = hash(compressed ? 4096 : st.size);
    return { rows: [...rows.values()], compactions: [...markers.values()], parseErrors, more: hasMore, commit() {
      createCompactions(db, createStore(db), Date.now, false).upsert([...markers.values()]);
      if (!end && hasMore) {
        partial.set(path, { signature, offset, bytes });
        compressedCommit?.(newBytes);
      } else {
        partial.delete(path);
        compressedCommit?.(Math.max(0, end - carry.length));
      }
      if (compressed && !hasMore) {
        closeStream(path);
        db.prepare('INSERT INTO cursor(name,value) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value').run(completedName, JSON.stringify(`${st.ino}:${st.size}:${st.mtimeMs}:${offset + end}`));
      }
      if (old && moved) db.prepare('DELETE FROM file_cursor WHERE path = ?').run(old.path);
      db.prepare(`INSERT INTO file_cursor (path,inode,size,mtime,"offset",head_hash,watermark_ts,thread_id,root_session)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET inode=excluded.inode,size=excluded.size,mtime=excluded.mtime,
        "offset"=excluded."offset",head_hash=excluded.head_hash,watermark_ts=excluded.watermark_ts,thread_id=excluded.thread_id,root_session=excluded.root_session`)
        .run(path, st.ino, st.size, Math.trunc(st.mtimeMs * 1000), offset + end, headHash, max, t.threadId, t.providerThreadId ?? '');
      db.prepare('UPDATE file_cursor SET compaction_watermark_ts=? WHERE path=?').run(markerMax,path);
    } };
  } finally { await handle?.close(); }
}
export function combine(batches: Batch[]): Batch {
  return { rows: batches.flatMap(b => b.rows), compactions: batches.flatMap(b => b.compactions ?? []), parseErrors: batches.reduce((n, b) => n + b.parseErrors, 0), more: batches.some(b => b.more), commit() { for (const b of batches) b.commit(); } };
}
export const outsideThread = (id: string, provider: string): ThreadInfo => ({ threadId: '', providerThreadId: id, providerThreadIds:[id], provider, projectId: '~outside', createdAt: 0, isFork: false, cwd: null });
