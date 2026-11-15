import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Database } from "better-sqlite3";
import { bandOf, type UsageRow } from "../contract";
import type { Store } from "../store/write";
import { combine, outsideThread, readFile, exists, cooperation, LIMIT, parseJsonLine, MAX_JSON_BYTES, jsonFields, lineHead, stringField, type Batch, type FileSource, type ThreadInfo } from "./files";
import type { FileCompaction } from './compactions';
import { normaliseTier } from "./tiers";

async function decodeClaude(bytes: Buffer, signal?:AbortSignal) {
  const head = lineHead(bytes);
  if (!head.trimStart().startsWith('{')) throw new Error('Invalid transcript record');
  if (/"subtype"\s*:\s*"compact_boundary"/.test(head)) {
    const timestamp = stringField(head, 'timestamp');
    const metadata = /"compactMetadata"\s*:\s*(\{[^{}]{0,4096}\})/.exec(head)?.[1];
    if (!timestamp || !metadata) throw new Error('Incomplete Claude compaction header');
    return { type:'system', subtype:'compact_boundary', timestamp, compactMetadata:JSON.parse(metadata) };
  }
  if (bytes.length>=MAX_JSON_BYTES && bytes.indexOf('"assistant"')>=0 && bytes.indexOf('"usage"')>=0) {
    const f=await jsonFields(bytes,['type','timestamp','requestId','message.id','message.model','message.usage'],signal);
    if (f.type!=='assistant') return null;
    if (!f.timestamp || !f.requestId || !f['message.id'] || !f['message.model'] || !f['message.usage']) throw new Error('Incomplete Claude usage fields');
    return {type:f.type,timestamp:f.timestamp,requestId:f.requestId,message:{id:f['message.id'],model:f['message.model'],usage:f['message.usage']}};
  }
  if (!/"type"\s*:\s*"assistant"/.test(head)) return null;
  // Searching bytes avoids copying a large assistant body just to inspect its usage key.
  if (bytes.indexOf('"usage"') < 0) return null;
  return parseJsonLine(bytes);
}

export function createClaudeSource(o: { store: Store; db: Database; root?: string; now?: () => number }): FileSource {
  const root = o.root ?? join(homedir(), ".claude/projects"), now = o.now ?? Date.now;
  let index = new Map<string, string>(), scanned = -Infinity;
  const threadSessions = new Map<string,string>();
  const prepare = (t:ThreadInfo) => {
    if (!t.threadId) return;
    const ids=t.providerThreadIds.join();
    if (threadSessions.has(t.threadId) && threadSessions.get(t.threadId)!==ids) scanned=-Infinity;
    threadSessions.set(t.threadId,ids);
  };
  const directoryMtimes = new Map<string, number>();
  const dirs = async () => { try { return (await readdir(root, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => join(root, d.name)); } catch (e: any) { if (e.code === "ENOENT") return []; throw e; } };
  const scan = async (signal?: AbortSignal) => {
    const current = await dirs(), pause = cooperation(signal);
    for (const dir of current) {
      await pause(); const mtime = (await stat(dir)).mtimeMs;
      if (directoryMtimes.get(dir) === mtime) continue;
      for (const [id, path] of index) { await pause(); if (path.startsWith(dir + '/')) index.delete(id); }
      for (const name of await readdir(dir)) { await pause(); if (name.endsWith('.jsonl')) index.set(name.slice(0, -6), join(dir, name)); }
      directoryMtimes.set(dir, mtime);
    }
    for (const [id, path] of index) { await pause(); if (!current.some(dir => path.startsWith(dir + '/'))) index.delete(id); }
    for (const dir of directoryMtimes.keys()) { await pause(); if (!current.includes(dir)) directoryMtimes.delete(dir); }
    scanned = now();
  };
  const locatePath = async (t: ThreadInfo, signal?: AbortSignal) => {
    signal?.throwIfAborted(); if (!t.providerThreadId) return undefined;
    if (t.cwd) { const p = join(root, t.cwd.replace(/[^A-Za-z0-9]/g, '-'), `${t.providerThreadId}.jsonl`); if (await exists(p)) return p; }
    let p = index.get(t.providerThreadId);
    if ((!p || !await exists(p)) && now() - scanned >= 60000) { await scan(signal); p = index.get(t.providerThreadId); }
    return p && await exists(p) ? p : undefined;
  };
  const flushSession = async (t: ThreadInfo, budget:{remaining:number}, signal?: AbortSignal) => {
    const path = await locatePath(t, signal); if (!path) return combine([]);
    const sub = join(path.slice(0, -6), 'subagents');
    let names: string[] = []; try { names = await readdir(sub); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    const files = [path, ...names.filter(n => /^agent-.*\.jsonl$/.test(n)).map(n => join(sub, n))];
    const batches: Batch[] = [], pause = cooperation(signal);
    for (const p of files) {
      await pause(); if (!budget.remaining) { batches.push({ rows: [], parseErrors: 0, more: true, commit() {} }); break; }
      batches.push(await readFile(o.db, p, t, (line): UsageRow | FileCompaction | null => {
      if (p === path && line.type === 'system' && line.subtype === 'compact_boundary' && line.compactMetadata?.preTokens !== undefined) {
        return { threadId: t.threadId, at: Date.parse(line.timestamp), before: line.compactMetadata.preTokens, after: line.compactMetadata.postTokens ?? null, conv: '', source: 'claude-file', key: `ccx:${t.providerThreadId}:${line.timestamp}` };
      }
      const m = line.message, u = m?.usage;
      if (line.type !== 'assistant' || !u || !m.id || !line.requestId || m.model === '<synthetic>') return null;
      const freshIn = u.input_tokens ?? 0, cacheRead = u.cache_read_input_tokens ?? 0;
      const cacheWriteShort = u.cache_creation ? u.cache_creation.ephemeral_5m_input_tokens ?? 0 : u.cache_creation_input_tokens ?? 0;
      const cacheWriteLong = u.cache_creation?.ephemeral_1h_input_tokens ?? 0, output = u.output_tokens ?? 0;
      if (!(freshIn + cacheRead + cacheWriteShort + cacheWriteLong + output)) return null;
      const promptTokens = freshIn + cacheRead + cacheWriteShort + cacheWriteLong, tierRaw = u.speed ?? '';
      return { writeSplit:u.cache_creation != null && typeof u.cache_creation==='object' && ('ephemeral_5m_input_tokens' in u.cache_creation || 'ephemeral_1h_input_tokens' in u.cache_creation), providerThreadId:t.providerThreadId ?? '', key: `cc:${m.id}:${line.requestId}`, ts: Date.parse(line.timestamp), threadId: t.threadId, projectId: t.projectId, provider: 'claude-code', model: m.model ?? 'unknown', tier: normaliseTier(tierRaw), tierRaw, promptTokens, band: bandOf(promptTokens), conv: p === path ? '' : `sub:${basename(p, '.jsonl')}`, freshIn, cacheRead, cacheWriteShort, cacheWriteLong, output, reasoning: u.output_tokens_details?.thinking_tokens ?? 0, turnId: null, source: 'claude-file', flags: 0 };
      }, budget, signal, false, decodeClaude));
    }
    return combine(batches);
  };
  const flush = async (t:ThreadInfo, signal?:AbortSignal) => {
    prepare(t); const batches:Batch[]=[], budget={remaining:LIMIT};
    for (const id of t.providerThreadIds) {
      if (!budget.remaining) { batches.push({...combine([]),more:true}); break; }
      batches.push(await flushSession({...t,providerThreadId:id},budget,signal));
    }
    return combine(batches);
  };
  return { async locate(t, signal) { prepare(t); for (const id of t.providerThreadIds) if (await locatePath({...t,providerThreadId:id},signal)) return true; return false; }, flushThread: flush, async scanOutside(known, since, signal) {
    await scan(signal); const batches: Batch[] = [], pause = cooperation(signal);
    for (const [id, path] of index) { await pause(); if (!known.has(id) && (await stat(path)).mtimeMs >= since) batches.push(await flush(outsideThread(id, 'claude-code'), signal)); }
    return combine(batches);
  } };
}
