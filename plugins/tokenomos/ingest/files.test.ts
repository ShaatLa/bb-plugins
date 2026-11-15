import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, copyFileSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../store/schema';
import { createStore } from '../store/write';
import { createClaudeSource } from './claude';
import { createCodexSource } from './codex';
import type { ThreadInfo, Batch } from './files';

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const id = '01a1d157-0ade-75d1-8e8f-0f548a9da5c4';
let dir: string, db: Database.Database, store: ReturnType<typeof createStore>;
const thread = (providerThreadId: string, extra: Partial<ThreadInfo> = {}): ThreadInfo => ({ threadId: 'thread', providerThreadId, provider: 'claude-code', projectId: 'project', createdAt: 0, isFork: false, cwd: null, ...extra });
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

it.each(['plain', 'zstd'])('finishes a single oversized %s line across the byte budget', async format => {
  const data = JSON.parse(fixture('claude.jsonl').split('\n')[0]); data.padding = 'x'.repeat(5 * 1024 * 1024);
  const path = join(dir, format === 'zstd' ? 'oversized.jsonl.zst' : 'oversized.jsonl');
  const content = JSON.stringify(data) + '\n'; writeFileSync(path, format === 'zstd' ? zstdCompressSync(Buffer.from(content)) : content);
  const { readFile, LIMIT } = await import('./files');
  const parse = (line: any) => ({ key: line.message.id, ts: Date.parse(line.timestamp), threadId: 'thread', projectId: 'project', provider: 'claude-code', model: 'test', tier: 'standard', tierRaw: '', promptTokens: 1, band: 0, conv: '', freshIn: 1, cacheRead: 0, cacheWriteShort: 0, cacheWriteLong: 0, output: 0, reasoning: 0, turnId: null, source: 'claude-file' as const, flags: 0 });
  let more = true, total = 0, runs = 0;
  while (more && runs++ < 10) { const batch = await readFile(db, path, thread('large'), parse, { remaining: LIMIT }); total += batch.rows.length; more = !!batch.more; apply(batch); }
  expect(more).toBe(false); expect(total).toBe(1);
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
