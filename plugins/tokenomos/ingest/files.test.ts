import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, copyFileSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
