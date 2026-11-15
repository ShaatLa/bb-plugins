import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, copyFileSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MIGRATIONS } from '../store/schema';
import { createStore } from '../store/write';
import { createClaudeSource } from './claude';
import { createCodexSource } from './codex';
import type { ThreadInfo, Batch } from './files';

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const id = '01a1d157-0ade-75d1-8e8f-0f548a9da5c4';
let dir: string, db: Database.Database, store: ReturnType<typeof createStore>;
const thread = (providerThreadId: string, extra: Partial<ThreadInfo> = {}): ThreadInfo => ({ threadId: 'thread', providerThreadId, providerThreadIds:[providerThreadId], provider: 'claude-code', projectId: 'project', createdAt: 0, isFork: false, cwd: null, ...extra });
const apply = (b: Batch) => db.transaction(() => { store.applyRows(b.rows); b.commit(); })();
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tokenomos-')); db = new Database(':memory:'); for (const sql of [...MIGRATIONS]) db.exec(sql); store = createStore(db); });
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

describe('Claude transcripts', () => {
  it('locates, keeps the last chunk, holds partial lines, replays safely and reads subagents', async () => {
    const cwd = '/some/project', project = join(dir, '-some-project'); mkdirSync(join(project, 'session', 'subagents'), { recursive: true });
    const path = join(project, 'session.jsonl'), chunks = fixture('claude.jsonl').trimEnd().split('\n');
    const last = JSON.parse(chunks[1]); last.message.usage.output_tokens += 7; chunks[1] = JSON.stringify(last);
    writeFileSync(path, chunks[0] + '\n' + chunks[1].slice(0, 30));
    const source = createClaudeSource({ db, store, root: dir }); const t = thread('session', { cwd });
    expect(await source.locate(t)).toBe(true);
    let b = await source.flushThread(t); expect(b.rows).toHaveLength(1); apply(b);
    appendFileSync(path, chunks[1].slice(30) + '\n');
    b = await source.flushThread(t); expect(b.rows).toHaveLength(1); expect(b.rows[0].ts).toBe(Date.parse(last.timestamp)); expect(b.rows[0].output).toBe(last.message.usage.output_tokens); apply(b);
    expect(db.prepare('SELECT count(*) n FROM usage_raw').get()).toEqual({ n: 1 });
    appendFileSync(path, chunks[1] + '\n'); b = await source.flushThread(t); expect(b.rows).toHaveLength(1); apply(b);
    writeFileSync(join(project, 'session', 'subagents', 'agent-test.jsonl'), fixture('subagent.jsonl'));
    b = await source.flushThread(t); expect(b.rows.some(r => r.conv === 'sub:agent-test')).toBe(true); apply(b);
    db.prepare('DELETE FROM usage_raw').run(); writeFileSync(path, chunks.join('\n') + '\n');
    b = await source.flushThread(t); expect(b.rows).toHaveLength(0); apply(b);
    expect(await createClaudeSource({ db, store, root: dir }).locate(thread('session'))).toBe(true);
  });
  it('skips copied fork history even before its parent, and excludes known outside sessions', async () => {
    const project = join(dir, 'project'); mkdirSync(project); writeFileSync(join(project, 'session.jsonl'), fixture('claude.jsonl'));
    const source = createClaudeSource({ db, store, root: dir });
    expect((await source.flushThread(thread('session', { isFork: true, createdAt: Date.now() + 1e12 }))).rows).toHaveLength(0);
    expect((await source.scanOutside(new Set(['session']), 0)).rows).toHaveLength(0);
    expect((await source.scanOutside(new Set(), 0)).rows[0].projectId).toBe('~outside');
  });
});

describe('Codex transcripts', () => {
  it('attributes guardian, tracks cache writes and preserves cursor across archive move', async () => {
    const sessions = join(dir, 'sessions'), date = join(sessions, '2026', '11', '12'), archive = join(dir, 'archive'); mkdirSync(date, { recursive: true }); mkdirSync(archive);
    const name = `rollout-root-${id}.jsonl`, root = join(date, name); let rootLines = fixture('codex-root.jsonl').trimEnd().split('\n');
    const record = JSON.parse(rootLines[2]); record.payload.usage.cached_input_tokens = 100; record.payload.usage.cache_write_input_tokens = 200; rootLines[2] = JSON.stringify(record);
    writeFileSync(root, rootLines.join('\n') + '\n');
    writeFileSync(join(date, 'rollout-guardian.jsonl'), fixture('codex-child.jsonl'));
    const source = createCodexSource({ db, store, root: sessions, archivedRoot: archive }); const t = thread(id, { provider: 'codex' });
    expect(await source.locate(t)).toBe(true);
    let b = await source.flushThread(t); expect(b.rows).toHaveLength(2); const main = b.rows.find(r => !r.conv)!;
    expect(main.freshIn).toBe(record.payload.usage.input_tokens - 300); expect(main.cacheWriteShort).toBe(200);
    expect(b.rows.find(r => r.conv.startsWith('child:'))?.threadId).toBe('thread'); apply(b);
    copyFileSync(root, join(archive, name)); unlinkSync(root); b = await source.flushThread(t); expect(b.rows).toHaveLength(0); apply(b);
    expect(db.prepare('SELECT path FROM file_cursor WHERE path = ?').get(join(archive, name))).toBeTruthy();
    expect((await source.scanOutside(new Set([id]), 0)).rows).toHaveLength(0);
  });
});

describe('incremental records', () => {
  it('counts malformed JSON and restores turn context after a restart', async () => {
    const sessions = join(dir, 'sessions'), date = join(sessions, '2026', '11', '12'), archive = join(dir, 'archive'); mkdirSync(date, { recursive: true }); mkdirSync(archive);
    const path = join(date, 'rollout-root.jsonl'), lines = fixture('codex-root.jsonl').trimEnd().split('\n');
    writeFileSync(path, lines.slice(0, 2).join('\n') + '\nnot-json\n');
    let source = createCodexSource({ db, store, root: sessions, archivedRoot: archive }); const t = thread(id);
    let b = await source.flushThread(t); expect(b.parseErrors).toBe(1); apply(b);
    appendFileSync(path, lines[2] + '\n'); source = createCodexSource({ db, store, root: sessions, archivedRoot: archive });
    b = await source.flushThread(t); expect(b.rows[0].model).toBe(JSON.parse(lines[1]).payload.model); apply(b);
  });
  it('finds unknown Codex roots outside bb and skips fork history', async () => {
    const sessions = join(dir, 'sessions'), archive = join(dir, 'archive'); mkdirSync(sessions); mkdirSync(archive);
    writeFileSync(join(archive, 'rollout-root.jsonl'), fixture('codex-root.jsonl'));
    const source = createCodexSource({ db, store, root: sessions, archivedRoot: archive });
    expect((await source.flushThread(thread(id, { isFork: true, createdAt: Date.now() + 1e12 }))).rows).toHaveLength(0);
    const outside = await source.scanOutside(new Set(), 0); expect(outside.rows[0].threadId).toBe(''); expect(outside.rows[0].projectId).toBe('~outside');
  });
});


describe('compressed Codex transcripts', () => {
  it('preserves the cursor when a plain rollout is compressed and archived', async () => {
    const sessions = join(dir, 'sessions'), date = join(sessions, '2026', '11', '12'), archive = join(dir, 'archive');
    mkdirSync(date, { recursive: true }); mkdirSync(archive);
    const name = `rollout-root-${id}.jsonl`, path = join(date, name), archived = join(archive, name + '.zst');
    const content = fixture('codex-root.jsonl'); writeFileSync(path, content);
    const source = createCodexSource({ db, store, root: sessions, archivedRoot: archive }); const t = thread(id, { provider: 'codex' });
    let batch = await source.flushThread(t); expect(batch.rows).toHaveLength(1); apply(batch);
    db.prepare('DELETE FROM usage_raw').run();
    writeFileSync(archived, zstdCompressSync(Buffer.from(content))); unlinkSync(path);
    expect(await source.locate(t)).toBe(true);
    batch = await source.flushThread(t); expect(batch.rows).toHaveLength(0); apply(batch);
    const cursor = db.prepare('SELECT "offset", watermark_ts FROM file_cursor WHERE path = ?').get(archived) as { offset: number; watermark_ts: number };
    expect(cursor.offset).toBe(Buffer.byteLength(content)); expect(cursor.watermark_ts).toBeGreaterThan(0);
    expect((await source.flushThread(t)).rows).toHaveLength(0);
    const record = JSON.parse(content.trimEnd().split('\n').at(-1)!); record.payload.response_id += '-new'; record.timestamp = new Date(cursor.watermark_ts + 1000).toISOString();
    writeFileSync(archived, zstdCompressSync(Buffer.from(content + JSON.stringify(record) + '\n')));
    batch = await source.flushThread(t); expect(batch.rows.map(r => r.key)).toEqual([`cx:${record.payload.response_id}`]); apply(batch);
  });
  it('indexes compressed files in dated session folders', async () => {
    const sessions = join(dir, 'sessions'), date = join(sessions, '2026', '11', '12'), archive = join(dir, 'archive');
    mkdirSync(date, { recursive: true }); mkdirSync(archive);
    writeFileSync(join(date, 'rollout-compressed.jsonl.zst'), zstdCompressSync(Buffer.from(fixture('codex-root.jsonl'))));
    const source = createCodexSource({ db, store, root: sessions, archivedRoot: archive });
    expect(await source.locate(thread(id))).toBe(true);
    const batch = await source.flushThread(thread(id)); expect(batch.rows).toHaveLength(1); apply(batch);
    expect((await source.scanOutside(new Set([id]), 0)).rows).toHaveLength(0);
  });
});

describe('bounded asynchronous ingestion', () => {
  it.each(['plain', 'zstd'])('consumes a large %s transcript over multiple flushes', async (format) => {
    const project = join(dir, 'project'); mkdirSync(project);
    const sourceLines = fixture('claude.jsonl').trimEnd().split('\n'), base = JSON.parse(sourceLines[0]);
    const lines = Array.from({ length: 5000 }, (_, i) => JSON.stringify({ ...base, timestamp: new Date(Date.parse(base.timestamp) + i).toISOString(), message: { ...base.message, id: `message-${i}` }, padding: 'x'.repeat(1100) })).join('\n') + '\n';
    expect(Buffer.byteLength(lines)).toBeGreaterThan(5 * 1024 * 1024);
    // The shared reader also handles compressed streams; Codex supplies their normal entry point.
    const path = join(project, format === 'zstd' ? 'large.jsonl.zst' : 'large.jsonl');
    writeFileSync(path, format === 'zstd' ? zstdCompressSync(Buffer.from(lines)) : lines);
    const { readFile, LIMIT } = await import('./files');
    const parse = (line: any) => ({ key: line.message.id, ts: Date.parse(line.timestamp), threadId: 'thread', projectId: 'project', provider: 'claude-code', model: 'test', tier: 'standard', tierRaw: '', promptTokens: 1, band: 0, conv: '', freshIn: 1, cacheRead: 0, cacheWriteShort: 0, cacheWriteLong: 0, output: 0, reasoning: 0, turnId: null, source: 'claude-file' as const, flags: 0 });
    let more = true, runs = 0, total = 0;
    while (more && runs < 10) { const b = await readFile(db, path, thread('large'), parse, { remaining: LIMIT }); total += b.rows.length; more = !!b.more; apply(b); runs++; }
    expect(runs).toBeGreaterThan(2); expect(more).toBe(false); expect(total).toBe(5000);
    expect(db.prepare('SELECT count(*) n FROM usage_raw').get()).toEqual({ n: 5000 });
  });
  it('honors an already aborted signal', async () => {
    const signal = AbortSignal.abort();
    await expect(createClaudeSource({ db, store, root: dir }).locate(thread('x'), signal)).rejects.toThrow();
    await expect(createCodexSource({ db, store, root: dir, archivedRoot: dir }).locate(thread('x'), signal)).rejects.toThrow();
  });
  it('does not use synchronous filesystem or compression calls in ingest modules', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    for (const name of await readdir(import.meta.dirname)) if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      expect(await readFile(join(import.meta.dirname, name), 'utf8'), name).not.toMatch(/Sync\s*\(/);
    }
  });
});

it.each(['plain', 'zstd'])('skips and counts a single oversized %s JSON line across the byte budget', async format => {
  const data = JSON.parse(fixture('claude.jsonl').split('\n')[0]); data.padding = 'x'.repeat(5 * 1024 * 1024);
  const path = join(dir, format === 'zstd' ? 'oversized.jsonl.zst' : 'oversized.jsonl');
  const content = JSON.stringify(data) + '\n'; writeFileSync(path, format === 'zstd' ? zstdCompressSync(Buffer.from(content)) : content);
  const { readFile, LIMIT } = await import('./files');
  const parse = (line: any) => ({ key: line.message.id, ts: Date.parse(line.timestamp), threadId: 'thread', projectId: 'project', provider: 'claude-code', model: 'test', tier: 'standard', tierRaw: '', promptTokens: 1, band: 0, conv: '', freshIn: 1, cacheRead: 0, cacheWriteShort: 0, cacheWriteLong: 0, output: 0, reasoning: 0, turnId: null, source: 'claude-file' as const, flags: 0 });
  let more = true, total = 0, errors = 0, runs = 0;
  while (more && runs++ < 10) { const batch = await readFile(db, path, thread('large'), parse, { remaining: LIMIT }); total += batch.rows.length; errors += batch.parseErrors; more = !!batch.more; apply(batch); }
  expect(more).toBe(false); expect(total).toBe(0); expect(errors).toBe(1);
});

it('resumes a compressed cursor after cancellation without replaying rows', async () => {
  const base = JSON.parse(fixture('claude.jsonl').split('\n')[0]);
  const content = Array.from({ length: 3500 }, (_, i) => JSON.stringify({ ...base, timestamp: new Date(Date.parse(base.timestamp) + i).toISOString(), message: { ...base.message, id: `resume-${i}` }, padding: 'x'.repeat(800) })).join('\n') + '\n';
  const path = join(dir, 'resume.jsonl.zst'); writeFileSync(path, zstdCompressSync(Buffer.from(content)));
  const { readFile, LIMIT } = await import('./files');
  const parse = (line: any) => ({ key: line.message.id, ts: Date.parse(line.timestamp), threadId: 'thread', projectId: 'project', provider: 'claude-code', model: 'test', tier: 'standard', tierRaw: '', promptTokens: 1, band: 0, conv: '', freshIn: 1, cacheRead: 0, cacheWriteShort: 0, cacheWriteLong: 0, output: 0, reasoning: 0, turnId: null, source: 'claude-file' as const, flags: 0 });
  const controller = new AbortController(); let batch = await readFile(db, path, thread('resume'), parse, { remaining: LIMIT }, controller.signal); expect(batch.more).toBe(true); apply(batch); controller.abort();
  let more = true, runs = 0;
  while (more && runs++ < 8) { batch = await readFile(db, path, thread('resume'), parse, { remaining: LIMIT }); more = !!batch.more; apply(batch); }
  expect(more).toBe(false); expect(db.prepare('SELECT count(*) n FROM usage_raw').get()).toEqual({ n: 3500 });
});

describe('transcript compaction markers', () => {
  it('uses exact Claude sizes, merges a bb event, preserves Idle Compact, and never resurrects expired markers', async () => {
    const project=join(dir,'project'); mkdirSync(join(project,'session','subagents'),{recursive:true});
    const text=fixture('claude-compaction.jsonl'), marker=JSON.parse(text), at=Date.parse(marker.timestamp), path=join(project,'session.jsonl');
    writeFileSync(path,text); writeFileSync(join(project,'session','subagents','agent-test.jsonl'),text);
    db.prepare("INSERT INTO compactions(id,thread_id,at,seq,origin) VALUES ('bbc:e','thread',?,10,'idle-compact')").run(at+1000);
    const source=createClaudeSource({db,store,root:dir}); const batch=await source.flushThread(thread('session'));
    expect(batch.compactions).toEqual([{threadId:'thread',at,before:151966,after:14803,conv:'',source:'claude-file',key:`ccx:session:${marker.timestamp}`}]); apply(batch);
    expect(db.prepare('SELECT id,before_tokens,after_tokens,before_known,after_known,origin FROM compactions').all()).toEqual([{id:'bbc:e',before_tokens:151966,after_tokens:14803,before_known:1,after_known:1,origin:'idle-compact'}]);
    db.prepare('DELETE FROM compactions').run(); writeFileSync(path,text+'\n'); apply(await source.flushThread(thread('session')));
    expect(db.prepare('SELECT * FROM compactions').all()).toEqual([]);
  });
  it('skips copied Claude markers before a fork', async () => {
    const project=join(dir,'project');mkdirSync(project);writeFileSync(join(project,'session.jsonl'),fixture('claude-compaction.jsonl'));
    const source=createClaudeSource({db,store,root:dir});const batch=await source.flushThread(thread('session',{isFork:true,createdAt:Date.now()}));
    expect(batch.compactions).toEqual([]);apply(batch);expect(db.prepare('SELECT * FROM compactions').all()).toEqual([]);
  });
  it('gets Codex prompt sizes on either side, resolves after a restart, and excludes native children', async () => {
    const lines=fixture('codex-compaction.jsonl').trimEnd().split('\n'), meta=JSON.parse(lines[0]), session=meta.payload.id;
    const date=join(dir,'2026','11','09');mkdirSync(date,{recursive:true});const path=join(date,'rollout-main.jsonl');
    writeFileSync(path,lines.slice(0,-1).join('\n')+'\n');
    const child=JSON.parse(lines[0]);child.payload={...child.payload,id:'native-child',session_id:session,parent_thread_id:session};
    writeFileSync(join(date,'rollout-child.jsonl'),[JSON.stringify(child),...lines.slice(1)].join('\n')+'\n');
    const options={db,store,root:dir,archivedRoot:join(dir,'archive')};
    let source=createCodexSource(options), batch=await source.flushThread(thread(session,{provider:'codex'}));
    expect(batch.compactions).toHaveLength(1);expect(batch.compactions![0]).toMatchObject({before:335606,after:null,conv:'',source:'codex-file'});apply(batch);
    expect(db.prepare('SELECT before_known,after_known FROM compactions').all()).toEqual([{before_known:1,after_known:0}]);
    appendFileSync(path,lines.at(-1)+'\n');source=createCodexSource(options);batch=await source.flushThread(thread(session,{provider:'codex'}));
    expect(batch.compactions![0]).toMatchObject({before:335606,after:50367});apply(batch);
    expect(db.prepare('SELECT before_tokens,after_tokens,before_known,after_known FROM compactions').all()).toEqual([{before_tokens:335606,after_tokens:50367,before_known:1,after_known:1}]);
    expect((await source.flushThread(thread(session,{provider:'codex'}))).compactions).toEqual([]);
  });
});

it.each(['claude','codex'])('filters 5 MiB %s records and preserves bounded compaction metadata under 50 ms slices',async(provider)=>{
 const big='x'.repeat(5*1024*1024),stamp='2026-11-10T14:16:45.660Z';
 const date=join(dir,'2026','11','10');mkdirSync(date,{recursive:true});
 let source:ReturnType<typeof createClaudeSource>, t:ThreadInfo;
 if(provider==='claude'){
   const base=JSON.parse(fixture('claude.jsonl').split('\n')[0]);
   const ignored={type:'user',message:{content:big}};
   const hugeUsage={type:'assistant',message:{content:big,id:base.message.id,model:base.message.model,usage:{input_tokens:123,cache_read_input_tokens:456,output_tokens:78}},requestId:base.requestId,timestamp:base.timestamp};
   const marker={type:'system',subtype:'compact_boundary',timestamp:stamp,compactMetadata:{preTokens:100,postTokens:10},padding:big};
   writeFileSync(join(date,'session.jsonl'),[ignored,hugeUsage,marker].map(x=>JSON.stringify(x)).join('\n')+'\n');
   source=createClaudeSource({db,store,root:join(dir,'2026','11')});t=thread('session');
 }else{
   const lines=fixture('codex-compaction.jsonl').trimEnd().split('\n').map(x=>JSON.parse(x));
   const meta={...lines[0],payload:{base_instructions:big,...lines[0].payload}};
   const ignored={type:'response_item',payload:{content:big}};
   const marker={...lines[2],payload:{replacement_history:big}};
   const hugeUsage={...lines[1],payload:{tool_result:big,...lines[1].payload,usage:{input_tokens:1000,cached_input_tokens:200,cache_write_input_tokens:50,output_tokens:300,reasoning_output_tokens:7}}};
   writeFileSync(join(date,'rollout-large.jsonl'),[meta,ignored,hugeUsage,marker,lines[3]].map(x=>JSON.stringify(x)).join('\n')+'\n');
   source=createCodexSource({db,store,root:dir,archivedRoot:join(dir,'archive')});t=thread(lines[0].payload.id,{provider:'codex'});
 }
 const parse=JSON.parse;let maxParse=0,maxGap=0,oversizedParses=0,last=performance.now();
 const spy=vi.spyOn(JSON,'parse').mockImplementation((text,...rest)=>{
   if(Buffer.byteLength(text)>=1024*1024)oversizedParses++;
   const start=performance.now();const value=parse(text,...rest);maxParse=Math.max(maxParse,performance.now()-start);return value;
 });
 const timer=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-last);last=now;},1);
 let errors=0,rows=0,markers=0;
 try{
   expect(await source.locate(t)).toBe(true);
   let more=true,runs=0;
   while(more && runs++<30){const b=await source.flushThread(t);errors+=b.parseErrors;rows+=b.rows.length;markers+=b.compactions?.length??0;apply(b);more=!!b.more;}
   expect(more).toBe(false);expect(errors).toBe(0);expect(rows).toBe(provider==='claude'?1:2);expect(markers).toBeGreaterThan(0);
   const paid=db.prepare('SELECT fresh_in,cache_read,cache_write_short,output FROM usage_raw ORDER BY ts LIMIT 1').get();
   expect(paid).toEqual(provider==='claude'?{fresh_in:123,cache_read:456,cache_write_short:0,output:78}:{fresh_in:750,cache_read:200,cache_write_short:50,output:300});
   await new Promise<void>(resolve=>setTimeout(resolve,1));
 }finally{clearInterval(timer);spy.mockRestore();}
 console.log(`${provider} 5 MiB records: max parse ${maxParse.toFixed(2)} ms; max slice ${maxGap.toFixed(2)} ms`);
 expect(oversizedParses).toBe(0);expect(maxParse).toBeLessThan(50);expect(maxGap).toBeLessThan(50);
});

it('reads two initial Claude sessions and subagents, then a later session with independent cursors',async()=>{
 const project=join(dir,'project');mkdirSync(project);
 const original=JSON.parse(fixture('claude.jsonl').split('\n')[0]);
 const line=(id:string)=>JSON.stringify({...original,message:{...original.message,id}})+'\n';
 writeFileSync(join(project,'first.jsonl'),line('msg-first'));writeFileSync(join(project,'earlier.jsonl'),line('msg-earlier'));
 mkdirSync(join(project,'first','subagents'),{recursive:true});writeFileSync(join(project,'first','subagents','agent-one.jsonl'),line('msg-child'));
 const source=createClaudeSource({db,store,root:dir});
 const info=thread('first',{providerThreadIds:['first','earlier']});let b=await source.flushThread(info);expect(b.rows).toHaveLength(3);apply(b);
 writeFileSync(join(project,'second.jsonl'),line('msg-second'));
 info.providerThreadIds.push('second');
 expect(await source.locate(info)).toBe(true);b=await source.flushThread(info);
 expect(b.rows.map(r=>r.key)).toEqual([`cc:msg-second:${original.requestId}`]);apply(b);
 expect((await source.flushThread(info)).rows).toEqual([]);
 expect(db.prepare('SELECT root_session,COUNT(*) n FROM file_cursor GROUP BY root_session ORDER BY root_session').all()).toEqual([{root_session:'earlier',n:1},{root_session:'first',n:2},{root_session:'second',n:1}]);
 expect(db.prepare('SELECT COUNT(*) n FROM usage_raw').get()).toEqual({n:4});
});
it('reads both Codex roots and native children, including a root added later',async()=>{
 const date=join(dir,'2026','11','10');mkdirSync(date,{recursive:true});
 const lines=fixture('codex-root.jsonl').trimEnd().split('\n').map(x=>JSON.parse(x));
 const write=(session:string,response:string,root=session)=>{
   const copy=structuredClone(lines);copy[0].payload={...copy[0].payload,id:session,session_id:root};
   for(const l of copy)if(l.type==='token_usage_record')l.payload.response_id=response;
   writeFileSync(join(date,`rollout-${session}.jsonl`),copy.map(x=>JSON.stringify(x)).join('\n')+'\n');
 };
 write('first','resp-first');write('child','resp-child','first');write('earlier','resp-earlier');
 const source=createCodexSource({db,store,root:dir,archivedRoot:join(dir,'archive')});
 const info=thread('first',{provider:'codex',providerThreadIds:['first','earlier']});let b=await source.flushThread(info);expect(b.rows).toHaveLength(3);apply(b);
 write('second','resp-second');info.providerThreadIds.push('second');expect(await source.locate(info)).toBe(true);
 b=await source.flushThread(info);expect(b.rows.map(r=>r.key)).toEqual(['cx:resp-second']);apply(b);
 expect((await source.flushThread(info)).rows).toEqual([]);
 expect(db.prepare('SELECT root_session,COUNT(*) n FROM file_cursor GROUP BY root_session ORDER BY root_session').all()).toEqual([{root_session:'earlier',n:1},{root_session:'first',n:2},{root_session:'second',n:1}]);
 expect(db.prepare('SELECT COUNT(*) n FROM usage_raw').get()).toEqual({n:4});
});
it.each(['claude','codex'])('locates any available %s session when another session file is missing',async(provider)=>{
 const folder=provider==='claude'?join(dir,'project'):join(dir,'2026','11','10');mkdirSync(folder,{recursive:true});
 let existing:string;
 if(provider==='claude'){existing='present';writeFileSync(join(folder,'present.jsonl'),fixture('claude.jsonl'));}
 else{existing=id;writeFileSync(join(folder,'rollout-present.jsonl'),fixture('codex-root.jsonl'));}
 const source=provider==='claude'?createClaudeSource({db,store,root:dir}):createCodexSource({db,store,root:dir,archivedRoot:join(dir,'archive')});
 const info=thread('missing',{providerThreadIds:['missing',existing]});
 expect(await source.locate(info)).toBe(true);const b=await source.flushThread(info);expect(b.rows.length).toBeGreaterThan(0);apply(b);
});
it('extracts usage through nested tool inputs without mistaking strings or nested ids for metadata',async()=>{
 const {jsonFields}=await import('./files');
 const data={type:'assistant',message:{content:[{id:'tool',input:{text:'\\\\\\" } ] { "usage": {"input_tokens":9999}, "id":"fake"',nested:[1,{quoted:'braces { } and escaped \\"'}]}}],id:'msg_real',model:'m',usage:{input_tokens:123,details:{cached:45}}},requestId:'request',timestamp:'2026-11-15T12:00:00Z'};
 expect(await jsonFields(Buffer.from(JSON.stringify(data)),['message.id','message.usage','requestId'])).toEqual({'message.id':'msg_real','message.usage':{input_tokens:123,details:{cached:45}},requestId:'request'});
 const controller=new AbortController();controller.abort();
 await expect(jsonFields(Buffer.from(JSON.stringify(data)),['message.usage'],controller.signal)).rejects.toThrow();
});
it('persists explicit Claude write-split provenance and the provider session',async()=>{
 const project=join(dir,'project');mkdirSync(project);
 const base=JSON.parse(fixture('claude.jsonl').split('\n')[0]);
 base.message.usage.cache_creation={ephemeral_5m_input_tokens:10,ephemeral_1h_input_tokens:0};
 writeFileSync(join(project,'session.jsonl'),JSON.stringify(base)+'\n');
 const source=createClaudeSource({db,store,root:dir});apply(await source.flushThread(thread('session')));
 expect(db.prepare('SELECT write_split,provider_thread_id FROM usage_raw').get()).toEqual({write_split:1,provider_thread_id:'session'});
});
