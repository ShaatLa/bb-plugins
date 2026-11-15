import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendUsage, listUsage, llamaCounts } from './usage-log.ts';

const entry = (model: string) => ({ source: 'tool' as const, threadId: 't', providerThreadId: null, model, engine: 'llama' as const, ...llamaCounts({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens: 6 }), durationMs: 5, ttftMs: 1 });
async function all(dir: string, after?: string, limit = 2, maxBytes?: number) {
  const seen: string[] = [];
  for (let cursor = after, page; (page = await listUsage(dir, cursor, limit, maxBytes)).nextCursor; cursor = page.nextCursor) { seen.push(...page.entries.map(e => e.model)); after = page.nextCursor; }
  return { seen, after };
}

test('pages oldest first, resumes from the cursor and returns null once caught up', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lm-usage-'));
  try {
    for (const model of ['a', 'b', 'c']) await appendUsage(dir, entry(model), () => {});
    const first = await all(dir);
    assert.deepEqual(first.seen, ['a', 'b', 'c']);
    assert.deepEqual((await listUsage(dir, first.after)).entries, []);
    assert.equal((await listUsage(dir, first.after)).nextCursor, null);
    // A half-written line from a shim is not returned until it is complete.
    await appendFile(join(dir, 'usage.jsonl'), '{"model":"half');
    assert.deepEqual((await all(dir, first.after)).seen, []);
    await appendFile(join(dir, 'usage.jsonl'), '"}\nnot json\n');
    await appendUsage(dir, entry('d'), () => {});
    assert.deepEqual((await all(dir, first.after)).seen, ['half', 'd']);
    const [one] = (await listUsage(dir, undefined, 1)).entries;
    assert.equal(one.promptTokens, 10); assert.equal(one.cachedTokens, 4); assert.equal(one.reasoningTokens, null); assert.match(one.id, /^[0-9a-f-]{36}$/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('rotation keeps one old file and a cursor inside it continues into the new one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lm-usage-'));
  try {
    // maxBytes 1: every append to a non-empty file rotates it first.
    await appendUsage(dir, entry('a'), () => {}, 1);
    await appendUsage(dir, entry('b'), () => {}, 1); // old=[a], current=[b]
    const { seen, after } = await all(dir, undefined, 1, 1e9);
    assert.deepEqual(seen, ['a', 'b']);
    await appendUsage(dir, entry('c'), () => {}, 1); // old=[b] (the cursor's file), current=[c]
    assert.deepEqual((await all(dir, after, 10, 1e9)).seen, ['c']);
    assert.deepEqual((await all(dir, 'bogus', 10, 1e9)).seen, ['b', 'c'], 'unknown cursor restarts from the oldest kept entry');
    await appendUsage(dir, entry('d'), () => {}, 1); // b dropped: old=[c], current=[d]
    assert.deepEqual((await all(dir, after, 10, 1e9)).seen, ['c', 'd'], 'a cursor into a dropped file restarts');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a journal write failure is logged, not thrown', async () => {
  const lines: string[] = [];
  await appendUsage('/nonexistent/dir', entry('a'), line => lines.push(line));
  assert.match(lines[0], /Usage journal write failed/);
});
