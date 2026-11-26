import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from './server';
import type Database from 'better-sqlite3';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); });

function setup(reads: Record<string, number> = {}) {
  const calls: string[][] = [];
  const list = vi.fn(async (args?: any) => { const threadIds: string[] = args?.threadIds ?? []; calls.push(threadIds); return threadIds.map(id => makeThreadResponse({ id, title: id, projectId: 'p', lastReadAt: reads[id] ?? null } as any)); });
  const host = createFakePluginHost({ pluginId: 'agent-hub', sdk: { threads: { list, get: async ({ threadId }) => makeThreadResponse({ id: threadId, projectId: 'p' }), events: { list: async () => [] }, send: async () => ({ ok: true as const, delivery: 'sent' as const }) }, projects: { list: async () => [] } } });
  plugin(host.bb); cleanup.push(() => host.harness.lifecycle.dispose());
  return { harness: host.harness, db: host.bb.storage.database() as Database.Database, calls };
}
// An answered reply the owner has not read yet, at `at`.
const reply = (db: Database.Database, thread: string, at: number, id = `ans_${thread}_${at}`) => db.prepare("INSERT INTO items(id,kind,thread_id,status,question,answer,answered_at,created_at,updated_at) VALUES (?,'mine',?,'answered','Q','A',?,?,?)").run(id, thread, at, at, at);
const recipients = async (harness: ReturnType<typeof setup>['harness'], pinned: string[]) => await harness.behavior.callRpc('recipients', { pinned }) as { recipients: { threadId: string }[]; pinned: { threadId: string; unread: number; questions: number; preview: string }[] };

describe('recipients: pinned rows', () => {
  it('counts a pinned top-level thread that falls past the first 200 conversations', async () => {
    const { harness, db } = setup();
    reply(db, 'old', 1);
    for (let i = 0; i < 201; i++) reply(db, `new${i}`, 100 + i);
    const result = await recipients(harness, ['old']);
    expect(result.recipients.some(r => r.threadId === 'old')).toBe(false);
    expect(result.pinned).toMatchObject([{ threadId: 'old', unread: 1, preview: 'A' }]);
  });

  it('counts a pinned sub-session past the 200 sub-sessions of subUnread', async () => {
    const { harness, db } = setup();
    for (let i = 0; i < 201; i++) { db.prepare('INSERT INTO sub_threads VALUES (?)').run(`s${i}`); reply(db, `s${i}`, 100 + i); }
    db.prepare("INSERT INTO sub_threads VALUES ('pin')").run(); reply(db, 'pin', 1); reply(db, 'pin', 2);
    const result = await recipients(harness, ['pin']);
    expect(result.pinned).toMatchObject([{ threadId: 'pin', unread: 2 }]);
  });

  it('lists a pinned thread with only agent questions and one with no items', async () => {
    const { harness, db } = setup();
    db.prepare("INSERT INTO items(id,kind,thread_id,status,question,created_at,updated_at) VALUES ('ask','for_me','q','open','Which one?',5,5)").run();
    const result = await recipients(harness, ['q', 'empty']);
    expect(result.recipients).toEqual([]);
    expect(result.pinned).toMatchObject([{ threadId: 'q', unread: 1, questions: 1 }, { threadId: 'empty', unread: 0, preview: '' }]);
  });

  it('takes a bb read of a pinned thread, once, for both its main and pinned row', async () => {
    const { harness, db } = setup({ t: 5000 });
    reply(db, 't', 1000); reply(db, 't', 2000);
    const result = await recipients(harness, ['t']);
    expect(result.pinned).toMatchObject([{ threadId: 't', unread: 0 }]);
    expect(result.recipients).toMatchObject([{ threadId: 't', unread: 0 }]);
    expect(db.prepare('SELECT count(*) AS n FROM items WHERE read_at IS NULL').get()).toEqual({ n: 0 });
  });

  it('leaves out an archived or deleted pinned thread', async () => {
    const { harness, db } = setup();
    reply(db, 'arch', 1); db.prepare("INSERT INTO archived_threads VALUES ('arch')").run();
    reply(db, 'del', 1); db.prepare("UPDATE items SET thread_deleted=1 WHERE thread_id='del'").run();
    expect((await recipients(harness, ['arch', 'del'])).pinned).toEqual([]);
  });

  it('counts 250 pinned threads, reading bb in chunks of at most 200 ids', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `p${String(i).padStart(3, '0')}`);
    const { harness, db, calls } = setup({ p010: 9000 });
    // The 200 newest fill the main rows' read lookup, so p010 is read through the second chunk.
    ids.forEach((id, i) => reply(db, id, 100 + i));
    const result = await recipients(harness, ids);
    expect(result.pinned).toHaveLength(250);
    expect(result.pinned.find(r => r.threadId === 'p010')!.unread).toBe(0);
    expect(result.pinned.filter(r => r.unread === 1)).toHaveLength(249);
    expect(calls.map(c => c.length).filter(n => n > 200)).toEqual([]);
    for (const id of ids) expect(calls.some(c => c.includes(id))).toBe(true);
  });
});
