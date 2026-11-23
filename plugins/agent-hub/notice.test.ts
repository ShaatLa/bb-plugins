import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import Database from 'better-sqlite3';
import plugin from './server';
import { createDriver } from './driver';
import { applyEvents } from './ingest';
import { NOTICE_THREAD, NOTICE_MAX_BYTES } from './contract';
import { migrations } from './schema';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); vi.useRealTimers(); });
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => resolve = r); return { promise, resolve }; };

type Over = { get?: (a: { threadId: string }) => Promise<unknown>; settings?: Record<string, string>; list?: (a: any) => Promise<any[]> };
function setup(over: Over = {}) {
  const pushes: any[] = [], calls: { pluginId: string; input: any }[] = [];
  const host = createFakePluginHost({ pluginId: 'agent-hub', settings: over.settings ?? {}, sdk: {
    threads: { list: over.list ?? (async () => []), get: (over.get ?? (async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, projectId: 'proj_example', title: 'Manager' }))) as any, events: { list: async () => [] } },
    projects: { list: async () => [{ id: 'proj_example', name: 'Example project' }] },
    plugins: { callRpc: async ({ pluginId, input }: any) => {
      calls.push({ pluginId, input });
      if (pluginId === 'push-notifications') { pushes.push(input); return { channels: ['desktop'] }; }
      return { ok: true, task: { key: 'EXA-1' } };
    } },
  } } as any);
  plugin(host.bb); cleanup.push(() => host.harness.lifecycle.dispose());
  const db = host.bb.storage.database();
  const call = (input: Record<string, unknown> = {}) => host.harness.behavior.callRpc('notice', { source: 'example-plugin', tickId: 'tick-1', projectId: 'proj_example', title: 'Check report', markdown: '# Report\n\nbody', ...input }) as Promise<{ id: string; created: boolean }>;
  const rpc = (method: string, input: unknown = {}) => host.harness.behavior.callRpc(method as any, input as any) as Promise<any>;
  return { ...host, db, call, rpc, pushes, calls };
}
const items = (db: Database.Database) => db.prepare('SELECT * FROM items').all() as any[];

describe('notice RPC', () => {
  it('stores a notice as an unread attention update on the manager thread', async () => {
    const h = setup();
    const result = await h.call({ threadId: 'thr_manager' });
    expect(result).toEqual({ id: expect.stringMatching(/^ans_/), created: true });
    expect(items(h.db)).toMatchObject([{ id: result.id, kind: 'update', status: 'answered', thread_id: 'thr_manager', project_id: 'proj_example', question: 'Check report', answer: '# Report\n\nbody', asks: 1, read_at: null, trigger_kind: 'plugin', trigger_source: 'example-plugin' }]);
    const list = await h.rpc('list', { view: 'unread' });
    expect(list.items).toMatchObject([{ id: result.id, notice: { source: 'example-plugin', managerThreadId: 'thr_manager', truncated: false }, trigger: { kind: 'plugin', sourceId: 'example-plugin' } }]);
  });

  it('is idempotent on (source, tickId): same id, created false, first body kept, not resurrected after reading', async () => {
    const h = setup();
    const first = await h.call({ threadId: 'thr_manager' });
    await h.rpc('markRead', { ids: [first.id] });
    const again = await h.call({ threadId: 'thr_manager', markdown: 'second body', title: 'Other' });
    expect(again).toEqual({ id: first.id, created: false });
    expect(h.db.prepare('SELECT count(*) AS n FROM notices').get()).toEqual({ n: 1 });
    expect(items(h.db)).toMatchObject([{ answer: '# Report\n\nbody', question: 'Check report' }]);
    expect(items(h.db)[0].read_at).not.toBeNull();
    expect((await h.rpc('noticeBody', { id: first.id })).markdown).toBe('# Report\n\nbody');
    expect(await h.rpc('counts')).toMatchObject({ inbox: 0 });
  });

  it('two concurrent calls with one key store exactly one notice, the committed body', async () => {
    const gate = deferred<void>();
    const h = setup({ get: async ({ threadId }) => { await gate.promise; return makeThreadResponse({ id: threadId, projectId: 'proj_example' }); } });
    const a = h.call({ threadId: 'thr_manager', markdown: 'body A' }), b = h.call({ threadId: 'thr_manager', markdown: 'body B' });
    await vi.waitFor(() => expect(h.harness.inspection.sdk.callsTo('threads.get')).toHaveLength(2));
    gate.resolve();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.id).toBe(rb.id);
    expect([ra.created, rb.created].sort()).toEqual([false, true]);
    expect(h.db.prepare('SELECT count(*) AS n FROM notices').get()).toEqual({ n: 1 });
    expect(items(h.db)).toHaveLength(1);
    const stored = (h.db.prepare('SELECT body FROM notices').get() as { body: string }).body;
    expect(items(h.db)[0].answer).toBe(stored);
    expect(['body A', 'body B']).toContain(stored);
  });

  it('keeps ("a|b","c") and ("a","b|c") apart', async () => {
    const h = setup();
    const one = await h.call({ source: 'a|b', tickId: 'c' }), two = await h.call({ source: 'a', tickId: 'b|c' });
    expect(one.id).not.toBe(two.id);
    expect([one.created, two.created]).toEqual([true, true]);
    expect(items(h.db)).toHaveLength(2);
  });

  describe('refusals', () => {
    it.each([
      ['markdown over 1 MiB in bytes', { markdown: '€'.repeat(Math.floor(NOTICE_MAX_BYTES / 3) + 1) }],
      ['empty markdown', { markdown: '' }],
      ['empty title', { title: '   ' }],
      ['title over 200 characters', { title: 'x'.repeat(201) }],
      ['missing projectId', { projectId: undefined }],
      ['missing source', { source: undefined }],
      ['missing tickId', { tickId: '' }],
    ])('refuses %s with a validation error and stores nothing', async (_name, input) => {
      const h = setup();
      await expect(h.call(input)).rejects.toMatchObject({ code: 'invalid_input' });
      expect(h.db.prepare('SELECT count(*) AS n FROM notices').get()).toEqual({ n: 0 });
      expect(items(h.db)).toEqual([]);
    });
    it('accepts a body of exactly 1 MiB, previews it and serves it whole', async () => {
      const h = setup(), body = 'a'.repeat(NOTICE_MAX_BYTES);
      const { id } = await h.call({ markdown: body });
      const [item] = (await h.rpc('list', { view: 'unread' })).items;
      expect(item.answer.length).toBeLessThan(21000);
      expect(item).toMatchObject({ id, notice: { truncated: true, bytes: NOTICE_MAX_BYTES } });
      expect((await h.rpc('noticeBody', { id })).markdown).toBe(body);
    });
    it('ignores unknown keys', async () => {
      const h = setup();
      await expect(h.call({ extra: 'later field' })).resolves.toMatchObject({ created: true });
    });
  });

  it('stores a notice without a threadId on the placeholder, listed apart from chats', async () => {
    const h = setup();
    const { id } = await h.call();
    expect(items(h.db)).toMatchObject([{ id, thread_id: NOTICE_THREAD, project_id: 'proj_example' }]);
    expect((await h.rpc('list', { view: 'unread', notices: true })).items.map((i: any) => i.id)).toEqual([id]);
    expect((await h.rpc('recipients', {})).recipients).toEqual([]);
    expect(await h.rpc('counts')).toMatchObject({ inbox: 1, forMe: 0 });
  });

  describe('an unusable manager', () => {
    const cases: [string, Over, (db: Database.Database) => void][] = [
      ['archived', { get: async ({ threadId }) => makeThreadResponse({ id: threadId, archivedAt: 5 }) }, () => {}],
      ['deleted', { get: async ({ threadId }) => makeThreadResponse({ id: threadId, deletedAt: 5 } as any) }, () => {}],
      ['a sub thread', { get: async ({ threadId }) => makeThreadResponse({ id: threadId, parentThreadId: 'thr_parent' }) }, () => {}],
      ['not found', { get: async () => { throw { status: 404 }; } }, () => {}],
      ['known archived', {}, db => db.prepare("INSERT INTO archived_threads VALUES ('thr_manager')").run()],
      ['known sub thread', {}, db => db.prepare("INSERT INTO sub_threads VALUES ('thr_manager')").run()],
    ];
    it.each(cases)('%s: stored thread-less with the intended manager kept', async (_name, over, prepare) => {
      const h = setup(over); prepare(h.db);
      await h.call({ threadId: 'thr_manager' });
      expect(items(h.db)).toMatchObject([{ thread_id: NOTICE_THREAD, read_at: null }]);
      expect(h.db.prepare('SELECT manager_thread_id FROM notices').get()).toEqual({ manager_thread_id: 'thr_manager' });
      expect(await h.rpc('counts')).toMatchObject({ inbox: 1 });
    });
    it('another lookup error stores nothing and a retry with the same key stores once', async () => {
      let fail = true;
      const h = setup({ get: async ({ threadId }) => { if (fail) throw new Error('host unreachable'); return makeThreadResponse({ id: threadId }); } });
      await expect(h.call({ threadId: 'thr_manager' })).rejects.toMatchObject({ code: 'handler_error' });
      expect(h.db.prepare('SELECT count(*) AS n FROM notices').get()).toEqual({ n: 0 });
      fail = false;
      expect(await h.call({ threadId: 'thr_manager' })).toMatchObject({ created: true });
      expect(await h.call({ threadId: 'thr_manager' })).toMatchObject({ created: false });
      expect(items(h.db)).toHaveLength(1);
    });
  });

  describe('a manager that becomes unusable later', () => {
    it('an archive found without an event (reconcile) moves the notice to the placeholder, still counted', async () => {
      const h = setup();
      const { id } = await h.call({ threadId: 'thr_manager' });
      h.db.prepare("INSERT INTO threads_state(thread_id,last_seq,updated_at) VALUES ('thr_manager',1,0)").run();
      h.harness.sdk.stub('threads.list', async () => [makeThreadResponse({ id: 'thr_manager', archivedAt: 1 })]);
      const driver = createDriver(h.bb, h.db, () => {}); cleanup.push(() => driver.dispose());
      await driver.reconcile();
      expect(h.db.prepare('SELECT thread_id FROM items WHERE id=?').get(id)).toEqual({ thread_id: NOTICE_THREAD });
      expect(await h.rpc('counts')).toMatchObject({ inbox: 1 });
    });
    it('a thread found to be a sub thread moves it too', async () => {
      const h = setup();
      const { id } = await h.call({ threadId: 'thr_manager' });
      h.db.prepare("INSERT OR IGNORE INTO sub_threads VALUES ('thr_manager')").run();
      expect(h.db.prepare('SELECT thread_id FROM items WHERE id=?').get(id)).toEqual({ thread_id: NOTICE_THREAD });
      expect(await h.rpc('counts')).toMatchObject({ inbox: 1 });
    });
    it('a deleted thread keeps its notice', async () => {
      const h = setup();
      const { id } = await h.call({ threadId: 'thr_manager' });
      await h.harness.behavior.emitThreadEvent('thread.deleted', { thread: makeThreadResponse({ id: 'thr_manager' }) });
      expect(h.db.prepare('SELECT thread_id,thread_deleted FROM items WHERE id=?').get(id)).toEqual({ thread_id: NOTICE_THREAD, thread_deleted: 0 });
      expect(await h.rpc('counts')).toMatchObject({ inbox: 1 });
    });
    it('editing a message in the thread does not delete it', async () => {
      const h = setup();
      const { id } = await h.call({ threadId: 'thr_manager' });
      h.db.prepare("INSERT INTO items(id,kind,thread_id,status,question,question_seq,created_at,updated_at) VALUES ('ans_mine','mine','thr_manager','waiting','Q',5,1,1)").run();
      applyEvents(h.db, 'thr_manager', [{ seq: 1, type: 'system/operation', data: { operation: 'edit_message', metadata: { cutoffSequence: 5 } } }]);
      expect(items(h.db).map(i => i.id)).toEqual([id]);
    });
  });

  describe('the placeholder is never looked up', () => {
    it('list, recipients and reconcile leave its notices in place when the thread lookup says not found', async () => {
      const h = setup({ get: async () => { throw { status: 404 }; } });
      const { id } = await h.call();
      h.db.prepare("INSERT INTO threads_state(thread_id,last_seq,last_error,updated_at) VALUES (?,0,'boom',0)").run(NOTICE_THREAD);
      await h.rpc('list', { view: 'all', threadId: NOTICE_THREAD, order: 'activity' });
      await h.rpc('recipients', { selected: NOTICE_THREAD });
      const driver = createDriver(h.bb, h.db, () => {}); cleanup.push(() => driver.dispose());
      h.harness.sdk.stub('threads.list', async () => []);
      await driver.reconcile(); await driver.schedule(NOTICE_THREAD); await driver.deleteThread(NOTICE_THREAD);
      await expect(driver.withThread(NOTICE_THREAD, () => 1)).rejects.toThrow('thread not found');
      expect(items(h.db).map(i => i.id)).toEqual([id]);
      expect(h.harness.inspection.sdk.callsTo('threads.get')).toHaveLength(0);
    });
  });

  describe('reading', () => {
    it("bb's own read of the manager thread does not clear it; marking it read does", async () => {
      const h = setup({ list: async () => [makeThreadResponse({ id: 'thr_manager', lastReadAt: Date.now() + 60000 })] });
      const { id } = await h.call({ threadId: 'thr_manager' });
      expect(await h.rpc('counts')).toMatchObject({ inbox: 1 });
      await h.rpc('recipients', {});
      expect(await h.rpc('markThreadRead', { threadId: 'thr_manager' })).toMatchObject({ count: 0 });
      expect(await h.rpc('counts')).toMatchObject({ inbox: 1 });
      await h.rpc('markRead', { ids: [id] });
      expect(await h.rpc('counts')).toMatchObject({ inbox: 0 });
    });
    it('counts, the chat list badge and the Questions count move by one', async () => {
      const h = setup({ list: async () => [makeThreadResponse({ id: 'thr_manager', title: 'Manager' })] });
      await h.call({ threadId: 'thr_manager' });
      expect(await h.rpc('counts')).toMatchObject({ inbox: 1, forMe: 0, unread: 1 });
      expect((await h.rpc('recipients', {})).recipients).toMatchObject([{ threadId: 'thr_manager', unread: 1 }]);
    });
  });

  describe('push', () => {
    const notice = (h: ReturnType<typeof setup>, input: Record<string, unknown> = {}) => h.call(input);
    const flushAll = async () => { await vi.advanceTimersByTimeAsync(12000); };
    it('one push with the notice title, project and source, and the thread when there is one', async () => {
      vi.useFakeTimers(); const h = setup({ settings: { notify: 'all' } }); await vi.advanceTimersByTimeAsync(100);
      await notice(h, { threadId: 'thr_manager' }); await flushAll();
      expect(h.pushes).toEqual([{ title: 'Check report', body: 'Example project · example-plugin', threadId: 'thr_manager' }]);
    });
    it('a thread-less notice and a batch of two carry no threadId', async () => {
      vi.useFakeTimers(); const h = setup({ settings: { notify: 'questions' } }); await vi.advanceTimersByTimeAsync(100);
      await notice(h); await flushAll();
      expect(h.pushes).toEqual([{ title: 'Check report', body: 'Example project · example-plugin' }]);
      h.pushes.length = 0;
      await notice(h, { tickId: 'tick-2' }); await notice(h, { tickId: 'tick-3' }); await flushAll();
      expect(h.pushes).toHaveLength(1); expect(h.pushes[0]).not.toHaveProperty('threadId'); expect(h.pushes[0].title).toBe('2 new in Agent Hub');
    });
    it('holds a notice in quiet hours and summarizes it after', async () => {
      vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-09T12:00:00'));
      const h = setup({ settings: { notify: 'all', quietHours: '12:00-12:05' } }); await vi.advanceTimersByTimeAsync(100);
      await notice(h); await vi.advanceTimersByTimeAsync(20000);
      expect(h.pushes).toEqual([]);
      await vi.advanceTimersByTimeAsync(6 * 60000);
      expect(h.pushes).toEqual([{ title: 'Agent Hub', body: 'While you were away: 1 new in 1 threads' }]);
    });
    it('pushes at level asked', async () => {
      vi.useFakeTimers(); const h = setup({ settings: { notify: 'asked' } }); await vi.advanceTimersByTimeAsync(100);
      await notice(h); await flushAll();
      expect(h.pushes).toHaveLength(1);
    });
    it('sends nothing at level off', async () => {
      vi.useFakeTimers(); const h = setup({ settings: { notify: 'off' } }); await vi.advanceTimersByTimeAsync(100);
      await notice(h); await flushAll();
      expect(h.pushes).toEqual([]);
    });
  });

  it('Create task from a thread-less notice sends no thread link and no requester', async () => {
    const h = setup();
    const { id } = await h.call();
    await h.rpc('createTask', { id, projectId: 'proj_example' });
    const sent = h.calls.find(c => c.pluginId === 'work-board')!.input;
    expect(sent).not.toHaveProperty('requesterThreadId'); expect(sent.description).not.toContain('Open thread');
    const real = (await h.call({ tickId: 'tick-2', threadId: 'thr_manager' })).id;
    await h.rpc('createTask', { id: real, projectId: 'proj_example' });
    const second = h.calls.filter(c => c.pluginId === 'work-board')[1]!.input;
    expect(second).toMatchObject({ requesterThreadId: 'thr_manager' }); expect(second.description).toContain('Open thread');
  });
});

it('appends the notices migration and keeps its placeholder literal in step with the constant', () => {
  const entry = migrations.find(m => m.includes('CREATE TABLE notices'))!;
  expect(migrations.indexOf(entry)).toBe(migrations.length - 1);
  expect(entry).toContain(`'${NOTICE_THREAD}'`);
  const db = new Database(':memory:'); db.exec(migrations.join('\n'));
  expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'notices_rehome_%'").get()).toEqual({ n: 2 });
});
