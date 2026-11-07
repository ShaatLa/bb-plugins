// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { loadPluginApp, renderSlot } from '@get-bb/plugin-sdk/testing/app';
import { itemSchema, type Item } from './contract';

const item: Item = itemSchema.parse({
  id: 'ans_one', kind: 'mine', threadId: 'thr_one', projectId: 'pr_one', threadTitle: 'A thread', projectName: 'A project', status: 'answered', question: 'What changed?', questionSeq: 10,
  requestId: null, turnId: null, candidate: null, candidateSeq: null, interim: null, interimSeq: null, answer: 'The answer', answerSeq: 20, answerSource: 'turn', resolveTurnId: null, note: null, readAt: null, pinned: false, dismissedAt: null, threadDeleted: false, createdAt: Date.now(), updatedAt: Date.now(),
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function setup(overrides: Record<string, (...args: any[]) => any> = {}) {
  const app = await loadPluginApp(() => import('./app'));
  const list = vi.fn(() => ({ items: [item], nextCursor: null }));
  const markRead = vi.fn(() => ({ ok: true }));
  const slot = renderSlot(app.navPanels[0]!, { subPath: '' }, { rpc: { list, counts: () => ({ unread: 1, waiting: 0, forMe: 2 }), markRead, ...overrides } });
  await slot.findByText('What changed?');
  return { app, slot, list, markRead };
}

describe('Answers app', () => {
  it('registers navigation, thread tab and message action and renders the inbox', async () => {
    const { app, slot, list } = await setup();
    expect(app.navPanels[0]).toMatchObject({ title: 'Answers', icon: 'MessageQuestion' });
    expect(app.tabs[0]).toMatchObject({ title: 'My questions', context: { kind: 'thread' }, availability: 'action' });
    expect(app.messageActions[0]).toMatchObject({ title: 'Save to Answers' });
    expect(slot.getByText('The answer')).toBeTruthy();
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ view: 'unread', limit: 50 }));
    fireEvent.click(slot.getByRole('button', { name: 'Waiting' }));
    await waitFor(() => expect(list).toHaveBeenCalledWith(expect.objectContaining({ view: 'waiting' })));
  });
  it('marks an item or all items read and links to the answer sequence', async () => {
    const { slot, markRead } = await setup();
    fireEvent.click(slot.getByRole('button', { name: 'Mark read' }));
    await waitFor(() => expect(markRead).toHaveBeenCalledWith({ ids: ['ans_one'] }));
    expect(slot.getByRole('link', { name: 'Open in chat' }).getAttribute('href')).toBe('/projects/pr_one/threads/thr_one?msg=20');
    fireEvent.click(slot.getByRole('button', { name: 'Mark all read' }));
    await waitFor(() => expect(markRead).toHaveBeenCalledWith({ all: true }));
  });
  it('disables replies while sending and reports queued delivery', async () => {
    let resolve!: (value: { delivery: string }) => void;
    const reply = vi.fn(() => new Promise(done => { resolve = done; }));
    const { slot } = await setup({ reply });
    fireEvent.click(slot.getByRole('button', { name: 'Reply' }));
    fireEvent.change(slot.getByRole('textbox', { name: 'Reply text' }), { target: { value: 'More details please' } });
    fireEvent.click(slot.getByRole('button', { name: 'Send reply' }));
    await waitFor(() => expect((slot.getByRole('button', { name: 'Sending…' }) as HTMLButtonElement).disabled).toBe(true));
    expect((slot.getByRole('button', { name: 'Reply' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(slot.getByRole('textbox', { name: 'Reply text' }), { key: 'Enter', metaKey: true });
    expect(reply).toHaveBeenCalledTimes(1);
    await act(async () => { resolve({ delivery: 'queued' }); });
    expect(await slot.findByText('Queued')).toBeTruthy();
  });
  it('preserves a failed reply and never automatically retries', async () => {
    const reply = vi.fn(() => { throw new Error('Connection lost'); });
    const { slot } = await setup({ reply });
    fireEvent.click(slot.getByRole('button', { name: 'Reply' }));
    const text = slot.getByRole('textbox', { name: 'Reply text' }) as HTMLTextAreaElement;
    fireEvent.change(text, { target: { value: 'My reply' } });
    fireEvent.keyDown(text, { key: 'Enter', metaKey: true });
    expect(await slot.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Delivery uncertain'));
    expect(text.value).toBe('My reply');
    expect(reply).toHaveBeenCalledTimes(1);
  });
});

it('loads the next cursor and refreshes through the items tag', async () => {
  const list = vi.fn((input: { cursor?: string }) => input.cursor ? { items: [{ ...item, id: 'ans_two', question: 'Next question' }], nextCursor: null } : { items: [item], nextCursor: '1|ans_one' });
  const { slot } = await setup({ list });
  fireEvent.click(slot.getByRole('button', { name: 'Load more' }));
  expect(await slot.findByText('Next question')).toBeTruthy();
  expect(list).toHaveBeenCalledWith(expect.objectContaining({ cursor: '1|ans_one' }));
  const calls = list.mock.calls.length;
  await act(async () => { await slot.behavior.experimental_invalidateRpc(['answers:items']); });
  await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(calls));
});

it('shows the badge sum and clears a zero badge on counts invalidation', async () => {
  const app = await loadPluginApp(() => import('./app'));
  const useBadge = app.navPanels[0]!.experimental_useBadge!;
  function Badge() { const badge = useBadge(); return <span>{badge?.count ?? 'No badge'}</span>; }
  let counts = { unread: 2, waiting: 5, forMe: 3 };
  const slot = renderSlot({ ...app.navPanels[0]!, component: Badge }, { subPath: '' }, { rpc: { counts: () => counts } });
  expect(await slot.findByText('5')).toBeTruthy();
  counts = { unread: 0, waiting: 5, forMe: 0 };
  await act(async () => { await slot.behavior.experimental_invalidateRpc(['answers:counts']); });
  expect(await slot.findByText('No badge')).toBeTruthy();
});

it('saves selected message text using its message sequence', async () => {
  const { experimental_makePanelController } = await import('@get-bb/plugin-sdk/testing');
  const app = await loadPluginApp(() => import('./app'));
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, result: { id: 'ans_saved' } }) }));
  vi.stubGlobal('fetch', fetch);
  await app.messageActions[0]!.run({ threadId: item.threadId, message: { id: 'msg_one', threadId: item.threadId, role: 'assistant', text: 'Full message', sourceSeqEnd: 25, experimental_messageSeq: 20 }, selectedText: 'Selected text', composer: null, experimental_panel: experimental_makePanelController() });
  expect(fetch).toHaveBeenCalledWith('/api/v1/plugins/answers/rpc/save', expect.objectContaining({ body: JSON.stringify({ threadId: item.threadId, seq: 20, role: 'assistant', text: 'Selected text' }) }));
});
