// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, act } from '@testing-library/react';
import { loadPluginApp, renderSlot } from '@get-bb/plugin-sdk/testing/app';
import { rpcContract, ITEMS_TAG, RECIPIENTS_TAG } from './contract';
import { COMPOSE_KEY, DRAFTS_EVENT } from './drafts';
afterEach(() => { vi.useRealTimers(); cleanup(); localStorage.clear(); history.replaceState(null, '', '/'); });
const row = (unread: number) => ({ threadId: 'thr_example', threadTitle: 'example', projectId: null, projectName: null, unread, questions: 0, lastAt: Date.now(), preview: 'x' });
const props = { activeThreadId: null, activeProjectId: null, isCompactViewport: false, searchQuery: '', onNavigate: () => {} };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const other = { list: () => ({ items: [], nextCursor: null }), counts: () => ({ unread: 1, waiting: 0, forMe: 0, inbox: 1 }) };
const fakeClock = () => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
async function mount(recipients: () => unknown) {
  const app = await loadPluginApp(() => import('./app'));
  const slot = renderSlot(app.threadLists[0]!, props, { experimental_rpcContract: rpcContract, rpc: { recipients, ...other } });
  await slot.findAllByLabelText('1 unread');
  return slot;
}
const threeThreadsUnread = (slot: Awaited<ReturnType<typeof mount>>) => vi.waitFor(() => expect(slot.queryAllByLabelText('3 unread').length).toBeGreaterThan(0));
// bb refetches on focus or reconnect only while its realtime socket is not connected, so a missed invalidation needs the page's own refetch.
it('refreshes the list without any invalidation arriving', async () => {
  fakeClock();
  let server = 1;
  const slot = await mount(() => ({ recipients: [row(server)], asking: [] }));
  server = 3;
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  await threeThreadsUnread(slot);
});
it('keeps polling while unrelated re-renders stream in', async () => {
  fakeClock();
  let server = 1;
  const slot = await mount(() => ({ recipients: [row(server)], asking: [] }));
  server = 3;
  for (let i = 0; i < 20; i++) { localStorage.setItem(COMPOSE_KEY, JSON.stringify({ thr_other: { text: String(i) } })); window.dispatchEvent(new Event(DRAFTS_EVENT)); await act(async () => { await vi.advanceTimersByTimeAsync(500); }); }
  await threeThreadsUnread(slot);
});
it('recovers from a read that never answers', async () => {
  fakeClock();
  let server = 1, hang = false; const hung: (() => void)[] = [];
  const slot = await mount(() => hang ? new Promise(resolve => hung.push(() => resolve({ recipients: [row(server)], asking: [] }))) : { recipients: [row(server)], asking: [] });
  hang = true; server = 3;
  await act(async () => { await vi.advanceTimersByTimeAsync(3500); }); // the poll starts a read that hangs
  hang = false;
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  await threeThreadsUnread(slot);
  hung.forEach(release => release());
});
it('reads once per window with three mounts and leaves a slow read after a hang to finish', async () => {
  fakeClock();
  const app = await loadPluginApp(() => import('./app')), Contacts = app.threadLists[0]!.component as () => JSX.Element;
  let server = 1, calls = 0, mode: 'ok' | 'hang' | 'slow' = 'ok', release = () => {}; const hung: (() => void)[] = [];
  const handler = () => { calls++; if (mode === 'hang') return new Promise(resolve => hung.push(() => resolve({ recipients: [row(1)], asking: [] }))); const snapshot = server; if (mode === 'ok') return { recipients: [row(snapshot)], asking: [] }; return new Promise(resolve => { release = () => resolve({ recipients: [row(snapshot)], asking: [] }); }); };
  const slot = renderSlot({ ...app.threadLists[0]!, component: () => <><Contacts /><Contacts /><Contacts /></> } as never, props, { experimental_rpcContract: rpcContract, rpc: { recipients: handler, ...other } });
  await slot.findAllByLabelText('1 unread');
  const idle = calls; await act(async () => { await vi.advanceTimersByTimeAsync(3500); });
  expect(calls - idle).toBeLessThanOrEqual(1);
  const base = calls; mode = 'hang'; server = 3;
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); }); mode = 'slow'; // the poll starts a read that hangs
  await act(async () => { await vi.advanceTimersByTimeAsync(25_000); });
  expect(calls - base).toBe(2); // the hung read and one reissue; the slow read is not cancelled again
  await act(async () => { release(); });
  await threeThreadsUnread(slot);
  hung.forEach(done => done());
});
// A 1.2 s read starts every 3 s, so it must finish before the next invalidation lands.
it('shows new unread counts when a 1.2 s read runs under recipient invalidations 3 s apart', async () => {
  let server = 1, slow = false;
  const slot = await mount(async () => { const snapshot = server; if (slow) await sleep(1200); return { recipients: [row(snapshot)], asking: [] }; });
  slow = true; server = 3;
  await slot.experimental_invalidateRpc([RECIPIENTS_TAG]);
  await slot.experimental_invalidateRpc([RECIPIENTS_TAG]);
  await threeThreadsUnread(slot);
}, 15000);
// A read slower than the invalidation gap is restarted by the SDK every time, so the list never settles; this test goes last because its overlapping act() calls upset the next test.
it('shows new unread counts while items keep being invalidated during a slow read', async () => {
  let server = 1;
  const slot = await mount(async () => { const snapshot = server; await sleep(200); return { recipients: [row(snapshot)], asking: [] }; });
  server = 3;
  const pending: Promise<unknown>[] = [slot.experimental_invalidateRpc(['answers:recipients'])];
  const timer = setInterval(() => pending.push(slot.experimental_invalidateRpc([ITEMS_TAG]).catch(() => {})), 150);
  try { await act(async () => { await sleep(2500); }); expect(slot.queryAllByLabelText('3 unread').length).toBeGreaterThan(0); } finally { clearInterval(timer); await Promise.all(pending); }
}, 15000);
