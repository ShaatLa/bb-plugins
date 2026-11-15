import { appendFile, open, rename, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';

// Token usage journal read by other plugins (Tokenomos). Counts are exactly as llama/Splash report them:
// promptTokens includes cachedTokens, completionTokens includes reasoningTokens. No prompt or reply text is stored.
export type UsageEntry = {
  id: string; ts: number; source: 'thread' | 'tool' | 'cli'; threadId: string | null; providerThreadId: string | null;
  model: string; engine: 'splash' | 'llama'; promptTokens: number; cachedTokens: number; completionTokens: number;
  reasoningTokens: number | null; durationMs: number | null; ttftMs: number | null;
};
export const usageRpcContract = defineRpcContract({
  'usage.list': {
    input: z.object({ after: z.string().max(500).optional(), limit: z.number().int().positive().max(1000).optional() }).nullish(),
    output: z.custom<{ entries: UsageEntry[]; nextCursor: string | null }>(),
    experimental_description: 'Token usage of local model requests (threads, local_models_ask, bb local-models ask), oldest first. promptTokens includes cachedTokens; completionTokens includes reasoningTokens (as llama reports them). Pass nextCursor back as after; null means caught up (keep the previous cursor). An unknown or rotated-away cursor restarts from the oldest kept entry: dedupe on id.',
  },
});

const CURRENT = 'usage.jsonl', OLD = 'usage.1.jsonl', MAX_BYTES = 8 * 1024 * 1024, MAX_READ = 1024 * 1024;
// Only this (server) process rotates; shims just append. Serialized, so two rotations cannot clobber usage.1.jsonl.
let rotating = Promise.resolve();
function rotate(dir: string, maxBytes: number) {
  return rotating = rotating.then(async () => {
    if (((await stat(join(dir, CURRENT)).catch(() => null))?.size ?? 0) > maxBytes) await rename(join(dir, CURRENT), join(dir, OLD));
  }).catch(() => {});
}

export function llamaCounts(usage: any) {
  return {
    promptTokens: Number(usage?.prompt_tokens) || 0, cachedTokens: Number(usage?.prompt_tokens_details?.cached_tokens) || 0,
    completionTokens: Number(usage?.completion_tokens) || 0, reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? null,
  };
}

// Best effort: a journal problem must never fail or slow the request it describes.
export async function appendUsage(dir: string, entry: Omit<UsageEntry, 'id' | 'ts'>, log: (line: string) => void, maxBytes = MAX_BYTES) {
  try {
    await rotate(dir, maxBytes);
    await appendFile(join(dir, CURRENT), JSON.stringify({ id: randomUUID(), ts: Date.now(), ...entry }) + '\n', { mode: 0o600 });
  } catch (error) { log('Usage journal write failed: ' + String(error)); }
}

// The cursor names a file by inode, which survives the rotation rename, plus a byte offset into it.
const encode = (ino: number, offset: number) => Buffer.from(JSON.stringify([ino, offset])).toString('base64url');
function decode(cursor: string | undefined) {
  try { const [ino, offset] = JSON.parse(Buffer.from(cursor ?? '', 'base64url').toString()); return Number.isSafeInteger(ino) && Number.isSafeInteger(offset) && offset >= 0 ? { ino, offset } : null; }
  catch { return null; }
}

// Entries oldest first. nextCursor is the position after the returned entries; it is null only when nothing new
// was returned, so a caller keeps the last non-null cursor and pages until null.
export async function listUsage(dir: string, after?: string, limit = 200, maxBytes = MAX_BYTES) {
  await rotate(dir, maxBytes);
  const files = await Promise.all([OLD, CURRENT].map(async name => ({ path: join(dir, name), info: await stat(join(dir, name)).catch(() => null) })));
  const cursor = decode(after);
  // An unknown cursor (rotated away, or none) restarts from the oldest kept entry; callers dedupe on id.
  let index = files.findIndex(file => file.info && cursor && file.info.ino === cursor.ino), offset = index >= 0 ? cursor!.offset : 0;
  if (index < 0) index = files[0].info ? 0 : 1;
  const entries: UsageEntry[] = [];
  let last: { ino: number; offset: number } | null = null;
  for (; index < files.length && entries.length < limit; index++, offset = 0) {
    const { path, info } = files[index];
    if (!info || offset >= info.size) { if (info) last = { ino: info.ino, offset: Math.min(offset, info.size) }; continue; }
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(info.size - offset, MAX_READ));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      let start = 0;
      // Only whole lines: a shim may be mid-append on the last one.
      for (let end = buffer.indexOf(10, 0); end >= 0 && end < bytesRead && entries.length < limit; end = buffer.indexOf(10, start)) {
        try { entries.push(JSON.parse(buffer.subarray(start, end).toString('utf8'))); } catch { /* skip a corrupt line */ }
        start = end + 1;
      }
      offset += start; last = { ino: info.ino, offset };
      // shortcut: a page stops at 1 MB of one file; raise MAX_READ if lines ever approach that size.
      if (entries.length >= limit || bytesRead === MAX_READ && offset < info.size) break;
    } finally { await handle.close(); }
  }
  return { entries, nextCursor: entries.length && last ? encode(last.ino, last.offset) : null };
}
