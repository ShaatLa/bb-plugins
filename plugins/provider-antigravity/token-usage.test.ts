import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, appendFile, stat, rename, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listTokenUsage, tokenUsageContract, tokenUsageShimSource } from './token-usage.ts';

test('step usage includes cache, keeps reasoning inside output, and never throws on write failure', async () => {
  const rows: any[] = [];
  const run = new Function('appendFile', 'join', 'dataDir', 'process', 'stat', 'rename', tokenUsageShimSource + `
    const session={id:'acp-session',conversationId:'native-conversation'};
    const step={state:'DONE',step_index:4,duration_seconds:1.863959,usage:{input_tokens:2255,output_tokens:21,thinking_tokens:20,cache_read_tokens:7555}};
    recordUsage(session,step,'gemini-3.8-flash-low');
    recordUsage(session,{...step,state:'ACTIVE'},'gemini-3.8-flash-low');
    recordUsage(session,{...step,usage:{}},'gemini-3.8-flash-low');
    return usageWrites;
  `);
  await run(async (_file: string, text: string) => { rows.push(JSON.parse(text)); }, path.join, '/tmp', { env: { BB_THREAD_ID: 'thr_fixture' } }, async () => ({size:0}), async () => {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].promptTokens, 9810);
  assert.equal(rows[0].cachedTokens, 7555);
  assert.equal(rows[0].completionTokens, 21);
  assert.equal(rows[0].reasoningTokens, 20);
  assert.equal(rows[0].threadId, 'thr_fixture');
  assert.equal(rows[0].providerThreadId, 'acp-session');
  assert.equal(rows[0].id, 'acp-session:native-conversation:4');
  assert.equal(rows[0].durationMs, 1864);
  await run(async () => { throw Error('disk full'); }, path.join, '/tmp', { env: {} }, async () => ({size:0}), async () => {});
});

test('usage.list sorts, deduplicates, pages past the last entry and tolerates incomplete writes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agy-token-test-'));
  const file = path.join(dir, 'usage.jsonl');
  const entry = { id:'a',ts:1,source:'thread',threadId:null,providerThreadId:'session',model:'gemini-test',promptTokens:12,cachedTokens:5,completionTokens:4,reasoningTokens:null,durationMs:null };
  try {
    assert.deepEqual(await listTokenUsage(file, null), { entries: [], nextCursor: null });
    await writeFile(file, [JSON.stringify({...entry,id:'b',ts:2}), 'broken', JSON.stringify(entry), JSON.stringify(entry), '{partial'].join('\n'));
    const first = await listTokenUsage(file, { limit:1 });
    assert.deepEqual(first.entries, [entry]); assert.ok(first.nextCursor);
    const second = await listTokenUsage(file, { after:first.nextCursor, limit:1000 });
    assert.equal(second.entries[0].id, 'b'); assert.ok(second.nextCursor);
    assert.deepEqual(await listTokenUsage(file, { after:second.nextCursor }), { entries:[],nextCursor:null });
    assert.equal(tokenUsageContract['usage.list'].input.parse({})?.limit, 200);
    assert.throws(() => tokenUsageContract['usage.list'].input.parse({ limit:1001 }));
    await assert.rejects(() => listTokenUsage(file, { after:'invalid' }));
  } finally { await rm(dir, { recursive:true,force:true }); }
});


test('rotates above 8 MiB, retains one archive, and restarts a rotated-away cursor', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agy-token-rotation-'));
  const file = path.join(dir, 'usage.jsonl');
  const run = new Function('appendFile', 'join', 'dataDir', 'process', 'stat', 'rename', 'index', tokenUsageShimSource + `
    recordUsage({id:'session',conversationId:'conversation'},
      {state:'DONE',step_index:index,usage:{input_tokens:1,output_tokens:1,cache_read_tokens:0}},'gemini-test');
    return usageWrites;
  `);
  const write = (index: number) => run(appendFile, path.join, dir, {env:{}}, stat, rename, index);
  try {
    await write(0);
    const first = await listTokenUsage(file, null);
    assert.ok(first.nextCursor);
    // Whitespace pads the real file to the threshold without adding a record.
    await appendFile(file, ' '.repeat(8*1024*1024-(await stat(file)).size));
    assert.equal((await stat(file)).size, 8*1024*1024);
    assert.deepEqual(await readdir(dir), ['usage.jsonl']);
    await appendFile(file, '\n');
    await write(1);
    assert.deepEqual(await readdir(dir), ['usage.1.jsonl']);
    assert.equal((await listTokenUsage(file, {after:first.nextCursor})).entries[0].id, 'session:conversation:1');
    await write(2);
    const retained = await listTokenUsage(file, null);
    assert.equal(retained.entries.length, 3);
    await appendFile(file, '\n' + ' '.repeat(8*1024*1024) + '\n');
    await write(3);
    assert.deepEqual(await readdir(dir), ['usage.1.jsonl']);
    const restarted = await listTokenUsage(file, {after:first.nextCursor});
    assert.deepEqual(restarted.entries.map(e => e.id), ['session:conversation:2', 'session:conversation:3']);
    assert.ok(restarted.nextCursor);
    assert.deepEqual(await listTokenUsage(file, {after:restarted.nextCursor}), {entries:[],nextCursor:null});
  } finally { await rm(dir, {recursive:true,force:true}); }
});
