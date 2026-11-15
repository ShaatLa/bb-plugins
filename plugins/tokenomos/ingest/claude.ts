import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Database } from "better-sqlite3";
import { bandOf, type UsageRow } from "../contract";
import type { Store } from "../store/write";
import { combine, outsideThread, readFile, type FileSource, type ThreadInfo } from "./files";
import { normaliseTier } from "./tiers";

export function createClaudeSource(o: { store: Store; db: Database; root?: string; now?: () => number }): FileSource {
  const root = o.root ?? join(homedir(), ".claude/projects"), now = o.now ?? Date.now;
  let index = new Map<string, string>(), scanned = -Infinity;
  const directoryMtimes = new Map<string, number>();
  const dirs = () => { try { return readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => join(root, d.name)); } catch (e: any) { if (e.code === "ENOENT") return []; throw e; } };
  const scan = () => {
    const current = dirs();
    for (const dir of current) {
      const mtime = statSync(dir).mtimeMs;
      if (directoryMtimes.get(dir) === mtime) continue;
      for (const [id, path] of index) if (path.startsWith(dir + '/')) index.delete(id);
      for (const name of readdirSync(dir)) if (name.endsWith('.jsonl')) index.set(name.slice(0, -6), join(dir, name));
      directoryMtimes.set(dir, mtime);
    }
    for (const [id, path] of index) if (!current.some(dir => path.startsWith(dir + '/'))) index.delete(id);
    for (const dir of directoryMtimes.keys()) if (!current.includes(dir)) directoryMtimes.delete(dir);
    scanned = now();
  };
  const locatePath = (t: ThreadInfo) => {
    if (!t.providerThreadId) return undefined;
    if (t.cwd) { const p = join(root, t.cwd.replace(/[^A-Za-z0-9]/g, '-'), `${t.providerThreadId}.jsonl`); if (existsSync(p)) return p; }
    let p = index.get(t.providerThreadId);
    if ((!p || !existsSync(p)) && now() - scanned >= 60000) { scan(); p = index.get(t.providerThreadId); }
    return p && existsSync(p) ? p : undefined;
  };
  const flush = async (t: ThreadInfo) => {
    const path = locatePath(t); if (!path) return combine([]);
    const sub = join(path.slice(0, -6), 'subagents');
    const files = [path, ...(existsSync(sub) ? readdirSync(sub).filter(n => /^agent-.*\.jsonl$/.test(n)).map(n => join(sub, n)) : [])];
    return combine(files.map(p => readFile(o.db, p, t, (line): UsageRow | null => {
      const m = line.message, u = m?.usage;
      if (line.type !== 'assistant' || !u || !m.id || !line.requestId || m.model === '<synthetic>') return null;
      const freshIn = u.input_tokens ?? 0, cacheRead = u.cache_read_input_tokens ?? 0;
      const cacheWriteShort = u.cache_creation ? u.cache_creation.ephemeral_5m_input_tokens ?? 0 : u.cache_creation_input_tokens ?? 0;
      const cacheWriteLong = u.cache_creation?.ephemeral_1h_input_tokens ?? 0, output = u.output_tokens ?? 0;
      if (!(freshIn + cacheRead + cacheWriteShort + cacheWriteLong + output)) return null;
      const promptTokens = freshIn + cacheRead + cacheWriteShort + cacheWriteLong, tierRaw = u.speed ?? '';
      return { key: `cc:${m.id}:${line.requestId}`, ts: Date.parse(line.timestamp), threadId: t.threadId, projectId: t.projectId, provider: 'claude-code', model: m.model ?? 'unknown', tier: normaliseTier(tierRaw), tierRaw, promptTokens, band: bandOf(promptTokens), conv: p === path ? '' : `sub:${basename(p, '.jsonl')}`, freshIn, cacheRead, cacheWriteShort, cacheWriteLong, output, reasoning: u.output_tokens_details?.thinking_tokens ?? 0, turnId: null, source: 'claude-file', flags: 0 };
    })));
  };
  return { async locate(t) { return !!locatePath(t); }, flushThread: flush, async scanOutside(known, since) {
    scan(); const batches = [];
    for (const [id, path] of index) if (!known.has(id) && statSync(path).mtimeMs >= since) batches.push(await flush(outsideThread(id, 'claude-code')));
    return combine(batches);
  } };
}
