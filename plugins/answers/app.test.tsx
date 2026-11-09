// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { useComposer } from '@get-bb/plugin-sdk/app';
import { loadPluginApp, renderSlot as sdkRenderSlot } from '@get-bb/plugin-sdk/testing/app';
const renderSlot = ((slot: any, props: any, options: any = {}) => sdkRenderSlot(slot, props, { ...options, sdk: { ...options.sdk, threads: { ...options.sdk?.threads, queuedMessages: { list: () => Promise.resolve([]), ...options.sdk?.threads?.queuedMessages }, context: options.sdk?.threads?.context ?? (() => Promise.resolve({ usage: null })) } } })) as typeof sdkRenderSlot;
import { itemSchema, type Item } from './contract';

const item: Item = itemSchema.parse({snoozedUntil:null,failedAt:null,likelyInterim:false,options:null,taskKey:null,
  id: 'ans_one', kind: 'mine', threadId: 'thr_one', projectId: 'pr_one', threadTitle: 'A thread', projectName: 'A project', status: 'answered', question: 'What changed?', questionSeq: 10,
  requestId: null, turnId: null, candidate: null, candidateSeq: null, interim: null, interimSeq: null, answer: 'The answer', answerSeq: 20, answerSource: 'turn', resolveTurnId: null, note: null, readAt: null, pinned: false, dismissedAt: null, threadDeleted: false, createdAt: Date.now(), updatedAt: Date.now(),
});
// Most tests cover the classic conversation; the embedded bb chat has its own test.
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function pickView(slot: { getByRole: (...args: any[]) => HTMLElement }, label: string) {
  fireEvent.click(slot.getByRole('button', { name: /^View:/ }));
  fireEvent.click(slot.getByRole('menuitemradio', { name: new RegExp(`^${label}`) }));
}
async function setup(overrides: Record<string, (...args: any[]) => any> = {}) {
  const app = await loadPluginApp(() => import('./app'));
  const list = vi.fn(() => ({ items: [item], nextCursor: null }));
  const markRead = vi.fn(() => ({ ok: true }));
  const slot = renderSlot(app.navPanels[0]!, { subPath: '' }, { rpc: { recipients: () => ({ recipients: [] }), list, counts: () => ({ unread: 1, waiting: 0, forMe: 2 }), markRead, ...overrides } });
  pickView(slot, 'History');
  await slot.findByText(overrides.list ? /Quoted passage|What changed\?/ : 'What changed?');
  return { app, slot, list, markRead };
}

describe('Answers app', () => {
  it('shows inline comment passage and comment without plugin boilerplate', async () => {
    const question = '@short\nContext for @short (resolved by plugin "inline-comments"):\n\nThe user attached this passage from the conversation to their message:\n\n> Quoted passage\n\nTheir comment on it: My comment';
    const { slot } = await setup({ list: () => ({ items: [{ ...item, question }], nextCursor: null }) });
    expect(slot.getByText('Quoted passage')).toBeTruthy();
    expect(slot.getByText('My comment')).toBeTruthy();
    expect(slot.queryByText(/resolved by plugin/)).toBeNull();
  });

  it('names the dismiss action per item and hides it where it does nothing', async () => {
    const waiting = { ...item, id: 'ans_wait', status: 'waiting' as const, answer: null, question: 'Still open' };
    const setDismissed = vi.fn(() => ({ ok: true }));
    const { slot } = await setup({ list: () => ({ items: [item, waiting], nextCursor: null }), setDismissed });
    fireEvent.click(slot.getAllByRole('button', { name: 'More' })[1]!);
    expect(slot.getAllByRole('menuitem', { name: 'Stop waiting' })).toHaveLength(1);
    expect(slot.queryByRole('button', { name: 'Done' })).toBeNull();
    fireEvent.click(slot.getByRole('menuitem', { name: 'Stop waiting' }));
    await waitFor(() => expect(setDismissed).toHaveBeenCalledWith({ id: 'ans_wait', dismissed: true }));
  });
  it('keeps the selected view after the page is unmounted', async () => {
    const first = await setup();
    pickView(first.slot, 'Awaiting answer');
    first.slot.unmount();
    const again = renderSlot(first.app.navPanels[0]!, { subPath: '' }, { rpc: { recipients: () => ({ recipients: [] }), list: () => ({ items: [], nextCursor: null }), counts: () => ({ unread: 0, waiting: 0, forMe: 0, inbox: 0 }) } });
    expect(again.getByRole('button', { name: 'View: Awaiting answer' })).toBeTruthy();
    again.unmount();
  });
  it('reopens the page side panel tab the user left open', async () => {
    localStorage.setItem('bb-plugin-answers:page-panel-tab', 'tab-1');
    const app = await loadPluginApp(() => import('./app'));
    const selectTab = vi.fn(() => true);
    const slot = renderSlot(app.navPanels[0]!, { subPath: '' }, { rpc: { list: () => ({ items: [], nextCursor: null }), counts: () => ({ unread: 0, waiting: 0, forMe: 0 }) },
      experimental_panel: { selectTab }, experimental_panelTabs: { open: false, selectedKey: null, tabs: [{ key: 'tab-1' } as any] } });
    await waitFor(() => expect(selectTab).toHaveBeenCalledWith('tab-1'));
    slot.unmount();
  });
  it('registers navigation, thread tab and message action and renders the inbox', async () => {
    const { app, slot, list } = await setup();
    expect(app.navPanels[0]).toMatchObject({ title: 'Answers', icon: 'MessageQuestion' });
    expect(app.tabs[0]).toMatchObject({ title: 'My questions', context: { kind: 'thread' }, availability: 'fixed' });
    expect(app.messageActions.find(action => action.id === 'save')).toMatchObject({ title: 'Save to Answers' });
    expect(slot.getByText('The answer')).toBeTruthy();
    expect(slot.getByRole('button', { name: 'Reply' })).toBeTruthy();
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ view: 'all', limit: 50 }));
    pickView(slot, 'Awaiting answer');
    await waitFor(() => expect(list).toHaveBeenCalledWith(expect.objectContaining({ view: 'waiting' })));
  });
  it('marks an item or all items read and links to the answer sequence', async () => {
    const { slot, markRead } = await setup();
    fireEvent.click(slot.getByRole('button', { name: 'Mark read' }));
    await waitFor(() => expect(markRead).toHaveBeenCalledWith({ ids: ['ans_one'] }));
    expect(slot.getByRole('link', { name: 'Open in chat' }).getAttribute('href')).toBe('/projects/pr_one/threads/thr_one?msg=20');
    pickView(slot, 'Inbox'); fireEvent.click(slot.getByRole('button', { name: 'Mark all read' }));
    await waitFor(() => expect(markRead).toHaveBeenCalledWith({ all: true }));
  });
  it('disables replies while sending and reports queued delivery', async () => {
    let resolve!: (value: { delivery: string }) => void;
    const reply = vi.fn(() => new Promise(done => { resolve = done; }));
    const { slot } = await setup({ reply });
    fireEvent.click(slot.getByRole('button', { name: 'Reply' }));
    fireEvent.change(slot.getByRole('textbox', { name: 'Reply text' }), { target: { value: 'More details please' } });
    fireEvent.click(slot.getByRole('button', { name: 'Send reply' }));
    await waitFor(() => expect((slot.getByRole('button', { name: 'Send reply' }) as HTMLButtonElement).disabled).toBe(true));
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
  let counts = { unread: 2, waiting: 5, forMe: 3, inbox: 5 };
  const slot = renderSlot({ ...app.navPanels[0]!, component: Badge }, { subPath: '' }, { rpc: { counts: () => counts } });
  expect(await slot.findByText('5')).toBeTruthy();
  counts = { unread: 0, waiting: 5, forMe: 0, inbox: 0 };
  await act(async () => { await slot.behavior.experimental_invalidateRpc(['answers:counts']); });
  expect(await slot.findByText('No badge')).toBeTruthy();
});

it('saves selected message text using its message sequence', async () => {
  const { experimental_makePanelController } = await import('@get-bb/plugin-sdk/testing');
  const app = await loadPluginApp(() => import('./app'));
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, result: { id: 'ans_saved', created:true } }) }));
  vi.stubGlobal('fetch', fetch);
  await app.messageActions.find(action => action.id === 'save')!.run({ threadId: item.threadId, message: { id: 'msg_one', threadId: item.threadId, role: 'assistant', text: 'Full message', sourceSeqEnd: 25, experimental_messageSeq: 20 }, selectedText: 'Selected text', composer: null, experimental_panel: experimental_makePanelController() });
  expect(fetch).toHaveBeenCalledWith('/api/v1/plugins/answers/rpc/save', expect.objectContaining({ body: JSON.stringify({ threadId: item.threadId, seq: 20, role: 'assistant', text: 'Selected text' }) }));
});

const recipient = { threadId: item.threadId, threadTitle: 'Recipient', projectId: item.projectId, projectName: 'Project', unread: 1, lastAt: Date.now(), preview: 'Preview' };
async function inboxSetup(overrides: Record<string, (...args: any[]) => any> = {}) {
  const app = await loadPluginApp(() => import('./app'));
  const markThreadRead = vi.fn(() => ({ ok: true }));
  const slot = renderSlot(app.navPanels[0]!, { subPath: '' }, { rpc: {
    recipients: () => ({ recipients: [recipient] }), markThreadRead, list: () => ({ items: [item], nextCursor: null }), ...overrides,
  } });
  await slot.findByRole('listbox', { name: 'Recipients' }); await within(slot.getByRole('listbox', { name: 'Recipients' })).findAllByRole('option');
  fireEvent.click(within(slot.getByRole('listbox', { name: 'Recipients' })).getAllByRole('option')[0]!);
  await slot.findByText('The answer');
  return { slot, markThreadRead };
}
it('defaults to Inbox, marks the recipient read, retains selection and rebuilds loaded history after refresh', async () => {
  let updated = false;
  const older = { ...item, id: 'ans_older', question: 'Old deferred', answer: null, status: 'deferred' };
  const list = vi.fn((input: { cursor?: string }) => input.cursor ? { items: [{ ...older, answer: updated ? 'Resolved old answer' : null }], nextCursor: null } : { items: updated ? [{ ...item, id: 'ans_new', question: 'New question' }, item] : [item], nextCursor: updated ? '2|ans_one' : '1|ans_one' });
  const { slot, markThreadRead } = await inboxSetup({ list });
  expect(markThreadRead).not.toHaveBeenCalled();
  expect(slot.getByText('New').closest('li')!.nextElementSibling!.textContent).toContain('The answer');
  expect(within(slot.getByRole('listbox', { name: 'Recipients' })).getByRole('option').getAttribute('aria-selected')).toBe('true');
  fireEvent.click(slot.getByRole('button', { name: 'Load earlier' }));
  await slot.findByText('Old deferred');
  expect(slot.getAllByRole('listitem')[0]!.textContent).toContain('Old deferred');
  updated = true;
  await act(async () => { await slot.behavior.experimental_invalidateRpc(['answers:items']); });
  await slot.findByText('Resolved old answer');
  expect(list).toHaveBeenCalledWith(expect.objectContaining({ cursor: '2|ans_one' }));
  expect(slot.getAllByText('What changed?')).toHaveLength(1);
});
it('marks a conversation message read once its end reaches the screen, with no timer', async () => {
  const markRead = vi.fn(() => ({ ok: true }));
  const { slot } = await inboxSetup({ markRead });
  const card = slot.getByText('The answer').closest('li')!, root = card.closest<HTMLElement>('.overflow-auto')!;
  let cardTop = 0; // the card is 2000px tall, the scroll area 500px
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return (this === card ? { top: cardTop, bottom: cardTop + 2000, height: 2000 } : { top: 0, bottom: 500, height: 500 }) as DOMRect;
  });
  vi.useFakeTimers();
  try {
    const scrollTo = (top: number) => act(() => { cardTop = top; fireEvent.scroll(root); vi.advanceTimersByTime(50); });
    scrollTo(-1500);
    expect(markRead).not.toHaveBeenCalled(); // the open position has not settled yet
    act(() => { cardTop = 0; fireEvent.pointerDown(root); }); // touching the list settles it
    scrollTo(0); act(() => { vi.advanceTimersByTime(60000); });
    scrollTo(-1400);
    expect(markRead).not.toHaveBeenCalled(); // the end is still below the screen
    scrollTo(-1500);
  } finally { vi.useRealTimers(); }
  await waitFor(() => expect(markRead).toHaveBeenCalledWith({ ids: [item.id] }));
});
it('shows a double check on a read answer and a dot on an unread one', async () => {
  const { slot } = await inboxSetup({ list: () => ({ items: [{ ...item, id: 'ans_read', question: 'Read one', answer: 'Read answer', readAt: Date.now() }, item], nextCursor: null }) });
  expect(slot.getByRole('img', { name: /^Read / })).toBeTruthy();
  expect(slot.getAllByLabelText('Unread')).toHaveLength(1);
});
it('snapshots a quote draft through focus and refresh; Add to pool opens the pool tab', async () => {
  const poolAdd = vi.fn(() => ({ id: 'pool_new' }));
  const { slot } = await inboxSetup({ poolAdd });
  const body = slot.getByText('The answer').closest('[data-agent-body]')!;
  const range = document.createRange(); range.selectNodeContents(body);
  Object.defineProperty(range, 'getClientRects', { value: () => [{ left: 20, bottom: 30, width: 50, height: 10 }] });
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [{ left: 20, bottom: 30, width: 50, height: 10 }] });
  vi.spyOn(window, 'getSelection').mockReturnValue({ rangeCount: 1, isCollapsed: false, getRangeAt: () => range } as any);
  fireEvent.mouseUp(body);
  const text = slot.getByRole('textbox', { name: 'Quote reply text' }) as HTMLTextAreaElement;
  fireEvent.focus(text); fireEvent.change(text, { target: { value: 'Snapshot note' } });
  await act(async () => { await slot.behavior.experimental_invalidateRpc(['answers:items']); });
  expect(text.value).toBe('Snapshot note');
  fireEvent.blur(text, { relatedTarget: slot.getByRole('button', { name: 'Add to pool' }) });
  fireEvent.click(slot.getByRole('button', { name: 'Add to pool' }));
  await waitFor(() => expect(poolAdd).toHaveBeenCalledWith({ threadId: item.threadId, itemId: item.id, quote: 'The answer', quoteSeq: 20, note: 'Snapshot note' }));
  await waitFor(() => expect(slot.queryByRole('dialog')).toBeNull());
});
it('keeps the bottom composer mounted while the quote popup is open', async () => {
  const { slot } = await inboxSetup();
  const bottom = slot.getByRole('textbox', { name: 'Send message' });
  const body = slot.getByText('The answer').closest('[data-agent-body]')!;
  const range = document.createRange(); range.selectNodeContents(body);
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => ({ left: 20, bottom: 30 }) });
  vi.spyOn(window, 'getSelection').mockReturnValue({ rangeCount: 1, isCollapsed: false, getRangeAt: () => range } as any);
  fireEvent.mouseUp(body);
  expect(slot.getByRole('textbox', { name: 'Send message' })).toBe(bottom);
  expect(document.activeElement).toBe(slot.getByRole('textbox', { name: 'Quote reply text' }));
  fireEvent.keyDown(slot.getByRole('textbox', { name: 'Quote reply text' }), { key: 'Escape' });
  expect(slot.getByRole('textbox', { name: 'Send message' })).toBe(bottom);
});

it.each(['Escape', 'outside'])('closes quote draft on %s', async mode => {
  const { slot } = await inboxSetup();
  const body = slot.getByText('The answer').closest('[data-agent-body]')!;
  const range = document.createRange(); range.selectNodeContents(body);
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => ({ left: 20, bottom: 30 }) });
  vi.spyOn(window, 'getSelection').mockReturnValue({ rangeCount: 1, isCollapsed: false, getRangeAt: () => range } as any);
  fireEvent.mouseUp(body);
  const text = slot.getByRole('textbox', { name: 'Quote reply text' });
  if (mode === 'Escape') fireEvent.keyDown(text, { key: 'Escape' }); else fireEvent.blur(text, { relatedTarget: slot.getByRole('button', { name: /^View:/ }) });
  expect(slot.queryByRole('dialog')).toBeNull();
});
it.each([false, true])('Send all awaits dirty saves (failure=%s)', async failure => {
  const app = await loadPluginApp(() => import('./app'));
  let resolve!: (value: any) => void, reject!: (reason: Error) => void;
  const poolUpdate = vi.fn(() => new Promise((yes, no) => { resolve = yes; reject = no; }));
  const poolSend = vi.fn(() => ({ delivery: 'sent', sent: 1, keptEdited: 1 }));
  const entry = { id: 'pool_one', threadId: item.threadId, quote: 'Quote', quoteSeq: 20, itemId: item.id, note: '', attachments: [], revision: 0, createdAt: 1, updatedAt: 1 };
  const { Pools } = await import('./inbox');
  const slot = renderSlot({ component: Pools }, {}, { rpc: { pools: () => ({ pools: [{ threadId: item.threadId, threadTitle: 'Pool thread', projectId: null, entries: [entry] }] }), poolUpdate, poolSend } });
  const note = await slot.findByRole('textbox', { name: 'Pool note' });
  fireEvent.change(note, { target: { value: 'Dirty note' } });
  fireEvent.click(slot.getByRole('button', { name: 'Send all' }));
  await waitFor(() => expect(poolUpdate).toHaveBeenCalledWith({ id: 'pool_one', note: 'Dirty note', attachments: [], revision: 0 }));
  expect(poolSend).not.toHaveBeenCalled();
  expect((slot.getByRole('button', { name: 'Sending…' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { if (failure) reject(new Error('stale revision')); else resolve({ revision: 1 }); });
  if (failure) { expect(poolSend).not.toHaveBeenCalled(); expect((note as HTMLTextAreaElement).value).toBe('Dirty note'); }
  else { await waitFor(() => expect(poolSend).toHaveBeenCalled()); expect(await slot.findByText('Sent — 1 edited entries were not sent')).toBeTruthy(); }
});
it('reads the thread tab oldest first', async () => {
  const { AnswersPanel } = await import('./app');
  const older = { ...item, id: 'ans_old', question: 'Older question', createdAt: 1 }, newer = { ...item, id: 'ans_new', question: 'Newer question', createdAt: 2 };
  const slot = renderSlot({ component: () => <AnswersPanel threadId="thr_one" /> }, {}, { rpc: { pools: () => ({ pools: [] }), list: () => ({ items: [newer, older], nextCursor: null }) } });
  await slot.findByText('Newer question');
  const text = slot.getByRole('list', { name: 'Answers' }).textContent!;
  expect(text.indexOf('Older question')).toBeLessThan(text.indexOf('Newer question'));
  expect(slot.getByText('New').closest('li')!.nextElementSibling!.textContent).toContain('Older question');
  expect(slot.getAllByLabelText('Unread')).toHaveLength(2);
  expect(slot.queryByRole('button', { name: 'Reply' })).toBeNull();
  expect(slot.getByRole('list', { name: 'Answers' }).className).toContain('divide-y');
  expect(slot.getByRole('list', { name: 'Answers' }).closest('section')!.className).toContain('bg-background');
  pickView(slot, 'Asked of you');
  expect(slot.getByRole('button', { name: 'View: Asked of you' })).toBeTruthy();
});
it('adds selected chat text to the thread pool and opens My questions', async () => {
  const { experimental_makePanelController } = await import('@get-bb/plugin-sdk/testing');
  const app = await loadPluginApp(() => import('./app'));
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, result: { id: 'pool_added' } }) }));
  vi.stubGlobal('fetch', fetch); const openTab = vi.fn(() => true);
  await app.messageActions.find(action => action.id === 'pool')!.run({ threadId: item.threadId, message: { id: 'msg_one', threadId: item.threadId, role: 'assistant', text: 'Full', sourceSeqEnd: 25, experimental_messageSeq: 20 }, selectedText: 'Selected', composer: null, experimental_panel: experimental_makePanelController({ openTab }) });
  expect(fetch).toHaveBeenCalledWith('/api/v1/plugins/answers/rpc/poolAdd', expect.objectContaining({ body: JSON.stringify({ threadId: item.threadId, quote: 'Selected', quoteSeq: 20 }) }));
  expect(openTab).toHaveBeenCalledWith({ tab: { id: 'my-questions', context: { kind: 'thread' }, availability: 'fixed' } });
});
it('sends a chat comment as a quoted message to the thread and cancels on Esc', async () => {
  const app = await loadPluginApp(() => import('./app'));
  let composer!: ReturnType<typeof useComposer>;
  const send = vi.fn(async () => ({}));
  const Overlay = app.appOverlays.find(overlay => overlay.id === 'chat-comment')!.component;
  const slot = renderSlot({ component: () => { composer = useComposer(); return <Overlay />; } }, {}, { composer: { text: 'Existing', scope: { kind: 'thread', threadId: item.threadId } }, sdk: { threads: { send } } } as any);
  const action = app.messageActions.find(action => action.id === 'comment')!;
  const context = { threadId: item.threadId, message: { id: 'msg_one', threadId: item.threadId, role: 'assistant' as const, text: 'Full', sourceSeqEnd: 25, experimental_messageSeq: 20 }, selectedText: 'First\nSecond', composer, experimental_panel: {} as any };
  act(() => { void action.run(context); });
  const note = slot.getByRole('textbox', { name: 'Comment text' });
  fireEvent.change(note, { target: { value: 'My comment' } });
  fireEvent.keyDown(note, { key: 'Enter' });
  await waitFor(() => expect(send).toHaveBeenCalledWith({ threadId: item.threadId, mode: 'queue-if-active', input: [{ type: 'text', text: '> First\n> Second\n\nMy comment', mentions: [] }] }));
  await waitFor(() => expect(slot.queryByRole('dialog')).toBeNull());
  expect(slot.inspection.composer.text).toBe('Existing');
  act(() => { void action.run(context); });
  fireEvent.keyDown(slot.getByRole('textbox', { name: 'Comment text' }), { key: 'Escape' });
  expect(slot.queryByRole('dialog')).toBeNull();
  expect(send).toHaveBeenCalledTimes(1);
});

it('sends the snapshot to its original recipient after switching recipients', async () => {
  const quoteReply = vi.fn(() => ({ delivery: 'sent' }));
  const recipients = vi.fn((input: { selected?: string }) => ({ recipients: [recipient, { ...recipient, threadId: 'thr_two', threadTitle: 'Second recipient' }].filter(r => r.unread || r.threadId === input.selected) }));
  const { slot } = await inboxSetup({ recipients, quoteReply });
  const body = slot.getByText('The answer').closest('[data-agent-body]')!;
  const range = document.createRange(); range.selectNodeContents(body);
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [{ left: 10, bottom: 50, width: 30, height: 10 }] });
  vi.spyOn(window, 'getSelection').mockReturnValue({ rangeCount: 1, isCollapsed: false, getRangeAt: () => range } as any);
  fireEvent.mouseUp(body);
  fireEvent.change(slot.getByRole('textbox', { name: 'Quote reply text' }), { target: { value: 'Immediate note' } });
  fireEvent.pointerDown(within(slot.getByRole('listbox', { name: 'Recipients' })).getAllByRole('option')[1]!);
  fireEvent.click(within(slot.getByRole('listbox', { name: 'Recipients' })).getAllByRole('option')[1]!);
  expect(slot.getByRole('dialog')).toBeTruthy();
  fireEvent.click(slot.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(quoteReply).toHaveBeenCalledWith({ threadId: item.threadId, itemId: item.id, quote: 'The answer', text: 'Immediate note' }));
  await waitFor(() => expect(slot.queryByRole('dialog')).toBeNull());
});
it('renders stacked pools and preserves notes on uncertain delivery', async () => {
  const { Pools } = await import('./inbox');
  await loadPluginApp(() => import('./app'));
  const entry = { id: 'pool_one', threadId: item.threadId, quote: 'Quote', quoteSeq: 20, itemId: item.id, note: 'Saved note', attachments: [], revision: 2, createdAt: 1, updatedAt: 1 };
  const poolSend = vi.fn(() => { throw new Error('connection lost'); });
  const slot = renderSlot({ component: Pools }, {}, { rpc: { pools: () => ({ pools: [
    { threadId: item.threadId, threadTitle: 'First pool', projectId: null, entries: [entry] },
    { threadId: 'thr_two', threadTitle: 'Second pool', projectId: null, entries: [{ ...entry, id: 'pool_two', threadId: 'thr_two' }] },
  ] }), poolSend } });
  await slot.findByText('First pool'); expect(slot.getByText('Second pool')).toBeTruthy();
  fireEvent.click(slot.getAllByRole('button', { name: 'Send all' })[0]!);
  await slot.findByText(/Delivery uncertain/);
  expect((slot.getAllByRole('textbox', { name: 'Pool note' })[0] as HTMLTextAreaElement).value).toBe('Saved note');
  expect(poolSend).toHaveBeenCalledTimes(1);
});

it('uses the attention predicate for failed, snoozed and dismissed items', async () => {
  const { isUnread } = await import('./app');
  expect(isUnread({ ...item, status: 'waiting', failedAt: 1 })).toBe(true);
  expect(isUnread({ ...item, snoozedUntil: Date.now() + 1000 })).toBe(false);
  expect(isUnread({ ...item, dismissedAt: 1 })).toBe(false);
});
it('offers quick replies, interim actions and retry', async () => {
  const reply = vi.fn(() => ({ delivery: 'sent' })), keepWaiting = vi.fn(() => ({ ok: true })), retryTurn = vi.fn(() => ({ ok: true }));
  const { slot } = await setup({ list: () => ({ items: [{ ...item, id: 'ans_ask', kind: 'for_me', status: 'open', question: 'Choose?', answer: null, options: ['Yes', 'No'], recommended: 'Yes', recommendReason: 'Cheaper' }, { ...item, likelyInterim: true }, { ...item, id: 'ans_fail', question: 'Failed question?', status: 'waiting', answer: null, failedAt: 1 }], nextCursor: null }), reply, keepWaiting, retryTurn });
  expect(slot.getByText('Recommended: Cheaper')).toBeTruthy();
  fireEvent.click(slot.getByRole('button', { name: 'Yes (recommended)' }));
  await waitFor(() => expect(reply).toHaveBeenCalledWith({ id: 'ans_ask', text: 'Yes' }));
  fireEvent.click(slot.getByRole('button', { name: 'Keep waiting' }));
  await waitFor(() => expect(keepWaiting).toHaveBeenCalledWith({ id: item.id }));
  fireEvent.click(slot.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(retryTurn).toHaveBeenCalledWith({ id: 'ans_fail' }));
});
it('shows undo after bulk read and calls undoRead', async () => {
  const undoRead = vi.fn(() => ({ ok: true, count: 2 }));
  const { slot } = await setup({ markRead: () => ({ ok: true, batch: 'batch-one', count: 2 }), undoRead });
  pickView(slot, 'Inbox'); fireEvent.click(slot.getByRole('button', { name: 'Mark all read' }));
  expect(await slot.findByText(/Marked 2 read/)).toBeTruthy();
  fireEvent.click(slot.getByRole('button', { name: 'Undo' }));
  await waitFor(() => expect(undoRead).toHaveBeenCalledWith({ batch: 'batch-one' }));
});
it('marks grouped members read and acts on the last member', async () => {
  const { ItemCard } = await import('./app');
  const markRead = vi.fn(() => ({ ok: true })), setPinned = vi.fn(() => ({ ok: true }));
  const last = { ...item, id: 'ans_last', question: 'And this?' };
  const slot = renderSlot({ component: () => <ul><ItemCard item={item} members={[item, last]} /></ul> }, {}, { rpc: { markRead, setPinned } });
  fireEvent.click(slot.getByRole('button', { name: 'Mark read' }));
  await waitFor(() => expect(markRead).toHaveBeenCalledWith({ ids: [item.id, last.id] }));
  fireEvent.click(slot.getByRole('button', { name: 'More' })); fireEvent.click(slot.getByRole('menuitem', { name: 'Save' }));
  await waitFor(() => expect(setPinned).toHaveBeenCalledWith({ id: last.id, pinned: true }));
});
it('renders each member’s image and file attachments in its own bubble', async () => {
  const { ItemCard } = await import('./app');
  vi.stubGlobal('URL', {createObjectURL:vi.fn(()=>'blob:attachment'),revokeObjectURL:vi.fn()});
  const read = vi.fn(async ({path}:{path:string}) => ({bytes:new Uint8Array([1]),mimeType:path.endsWith('.png')?'image/png':'application/pdf',sizeBytes:1}));
  const first = {...item,attachments:[{type:'localImage' as const,path:'photo.png',name:'photo.png'}]};
  const second = {...item,id:'ans_file',question:'File question',attachments:[{type:'localFile' as const,path:'notes.pdf',name:'notes.pdf'}]};
  const slot = renderSlot({component:()=> <ul><ItemCard item={first} members={[first,second]} /></ul>},{},{rpc:{workBoardProjects:()=>({available:false,projects:[]})},sdk:{projects:{attachments:{read}}}});
  expect(await slot.findByRole('img',{name:'photo.png'})).toBeTruthy();
  const link = slot.getByRole('link',{name:'notes.pdf'});
  expect(link.getAttribute('download')).toBe('notes.pdf');
  expect(link.closest('.rounded-xl')?.textContent).toContain('File question');
  fireEvent.click(slot.getByRole('button',{name:'photo.png'}));
  expect(slot.getAllByRole('img',{name:'photo.png'})).toHaveLength(2);
  expect(read).toHaveBeenCalledTimes(2);
});
it('opens My questions with a saved notice and detects a dedupe hit', async () => {
  const { experimental_makePanelController } = await import('@get-bb/plugin-sdk/testing');
  const { app, slot } = await setup();
  const openTab = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, result: { id: 'ans_saved', created: false } }) })));
  await app.messageActions.find(action => action.id === 'save')!.run({ threadId: item.threadId, message: { id: 'msg_one', threadId: item.threadId, role: 'assistant', text: 'Full message', sourceSeqEnd: 25, experimental_messageSeq: 20 }, selectedText: undefined, composer: null, experimental_panel: experimental_makePanelController({ openTab }) });
  expect(await slot.findByText(/Already in Saved/)).toBeTruthy();
  expect(openTab).toHaveBeenCalledWith({ tab: { id: 'my-questions', context: { kind: 'thread' }, availability: 'fixed' } });
});
it('snoozes for the four local menu deadlines', async () => {
  const { ItemCard } = await import('./app');
  const snooze = vi.fn((_input: any) => ({ ok: true }));
  const slot = renderSlot({ component: () => <ul><ItemCard item={item} /></ul> }, {}, { rpc: { snooze } });
  for (const label of ['In 1 hour', 'This evening', 'Tomorrow 9:00', 'Next Monday 9:00']) {
    fireEvent.click(slot.getByRole('button', { name: 'More' }));
    fireEvent.click(slot.getByRole('menuitem', { name: 'Remind later' }));
    fireEvent.click(slot.getByRole('menuitem', { name: label }));
  }
  await waitFor(() => expect(snooze).toHaveBeenCalledTimes(4));
  for (const [index, call] of snooze.mock.calls.entries()) expect(call[0].until).toBeGreaterThan(Date.now() + (index === 0 ? 0 : 1000));
});
it('renders thread mentions in user questions through bb markdown', async () => {
  const { slot } = await setup({ list: () => ({ items: [item, { ...item, id: 'ans_mention', question: 'Send @thread:thr_abc123 the rules\nnow' }], nextCursor: null }) });
  const chip = (await slot.findAllByTestId('bb-markdown')).find(node => node.textContent === '@thread:thr_abc123');
  expect(chip).toBeTruthy();
  expect(chip!.parentElement!.textContent).toBe('Send @thread:thr_abc123 the rules\nnow');
});
it('shows a pasted bb thread link as that thread\'s mention pill', async () => {
  const { slot } = await setup({ list: () => ({ items: [item, { ...item, id: 'ans_link', question: 'See http://127.0.0.1:38886/projects/proj_x/threads/thr_abc123 please' }], nextCursor: null }) });
  await waitFor(() => expect(slot.getAllByTestId('bb-markdown').map(node => node.textContent)).toContain('@thread:thr_abc123'));
  expect(slot.container.textContent).not.toContain('127.0.0.1');
});
it('links task keys of known Work Board projects in user questions', async () => {
  const { slot } = await setup({ workBoardProjects: () => ({ available: true, projects: [{ id: 'p', name: 'Acme', prefix: 'ACM' }] }), list: () => ({ items: [item, { ...item, id: 'ans_task', question: 'See ACM-5, not GPT-6 or XACM-7, and [ACM-9](/plugins/work-board/work-board/task/ACM-9)' }], nextCursor: null }) });
  await waitFor(() => expect(slot.getAllByTestId('bb-markdown').map(node => node.textContent)).toContain('[ACM-5](/plugins/work-board/work-board/task/ACM-5)'));
  expect(slot.getAllByTestId('bb-markdown').map(node => node.textContent).filter(text => /ACM|GPT/.test(text!))).toEqual(['[ACM-5](/plugins/work-board/work-board/task/ACM-5)', '[ACM-9](/plugins/work-board/work-board/task/ACM-9)']);
});
it('shows bb’s working spinner instead of the waiting label', async () => {
  const { slot } = await setup({ list: () => ({ items: [{ ...item, status: 'waiting', answer: null }], nextCursor: null }) });
  await waitFor(() => expect(slot.container.querySelector('[data-thread-status-glyph="runtime"]')).toBeTruthy());
  expect(slot.queryByText('waiting', { selector: ':not(.sr-only)' })).toBeNull();
});
it('embeds bb\u2019s chat for the selected conversation and marks it read', async () => {
  const app = await loadPluginApp(() => import('./app'));
  const markThreadRead = vi.fn(() => ({ ok: true, batch: 'b', count: 1 }));
  const slot = renderSlot(app.navPanels[0]!, { subPath: '' }, { rpc: { recipients: () => ({ recipients: [{ threadId: 'thr_one', threadTitle: 'One', projectId: 'p', projectName: 'P', unread: 1, lastAt: 1, preview: 'x' }] }), list: () => ({ items: [], nextCursor: null }), counts: () => ({ unread: 1, waiting: 0, forMe: 0 }), markThreadRead }, settings: { chatMode: 'bb' } });
  fireEvent.click(await slot.findByRole('option'));
  const chat = await slot.findByTestId('bb-thread-chat');
  expect(chat.getAttribute('data-thread-id')).toBe('thr_one');
  expect(chat.getAttribute('data-variant')).toBe('full');
  await waitFor(() => expect(markThreadRead).toHaveBeenCalledWith({ threadId: 'thr_one' }));
});
it('keeps Reply on agent questions in the thread side panel', async () => {
  const { AnswersPanel } = await import('./app');
  const ask = { ...item, id: 'ans_ask', kind: 'for_me' as const, status: 'open' as const, question: 'Pick one?', answer: null };
  const slot = renderSlot({ component: () => <AnswersPanel threadId="thr_one" /> }, {}, { rpc: { pools: () => ({ pools: [] }), list: () => ({ items: [ask, item], nextCursor: null }) } });
  await slot.findByText('Pick one?');
  expect(slot.getAllByRole('button', { name: 'Reply' })).toHaveLength(1);
});

it('pool note Enter sends its entry after saving; Shift+Enter does not', async () => {
  const { Pools } = await import('./inbox');
  const poolUpdate = vi.fn(() => ({ revision: 1 }));
  const poolSend = vi.fn(() => ({ delivery: 'sent', sent: 1, keptEdited: 0 }));
  const entries = ['one', 'two'].map((id, index) => ({ id, threadId: item.threadId, quote: id, quoteSeq: 20, itemId: item.id, note: '', attachments: [], revision: 0, createdAt: index, updatedAt: index }));
  const slot = renderSlot({ component: Pools }, {}, { rpc: { pools: () => ({ pools: [{ threadId: item.threadId, threadTitle: 'Pool thread', projectId: null, entries }] }), poolUpdate, poolSend } });
  const [first, second] = await slot.findAllByRole('textbox', { name: 'Pool note' });
  fireEvent.keyDown(second!, { key: 'Enter', shiftKey: true });
  expect(poolSend).not.toHaveBeenCalled();
  fireEvent.change(first!, { target: { value: 'Dirty' } });
  fireEvent.keyDown(first!, { key: 'Enter' });
  await waitFor(() => expect(poolUpdate).toHaveBeenCalledWith({ id: 'one', note: 'Dirty', attachments: [], revision: 0 }));
  await waitFor(() => expect(poolSend).toHaveBeenCalledWith({ threadId: item.threadId, ids: ['one'] }));
});
it('passes per-entry steer and removes through composer actions', async () => {
  const { Pools } = await import('./inbox');
  const entry = { id: 'pool_one', threadId: item.threadId, quote: 'Quote', quoteSeq: 20, itemId: item.id, note: 'Ready', attachments: [], revision: 0, createdAt: 1, updatedAt: 1 };
  const poolSend = vi.fn(() => ({ delivery: 'sent', sent: 1, keptEdited: 0 }));
  const poolRemove = vi.fn(() => ({ ok: true }));
  const slot = renderSlot({ component: Pools }, {}, { rpc: { pools: () => ({ pools: [{ threadId: item.threadId, threadTitle: 'Pool thread', projectId: 'pr_one', entries: [entry] }] }), poolSend, poolRemove } });
  await slot.findByRole('textbox', { name: 'Pool note' });
  fireEvent.click(slot.getAllByRole('button', { name: 'More send options' })[0]!);
  fireEvent.click(slot.getByRole('menuitem', { name: 'Steer' }));
  await waitFor(() => expect(poolSend).toHaveBeenCalledWith({ threadId: item.threadId, ids: ['pool_one'], send: { mode: 'steer' } }));
  fireEvent.click(slot.getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(poolRemove).toHaveBeenCalledWith({ id: 'pool_one' }));
});
it('persists attachments added to a pool entry', async () => {
  const { Pools } = await import('./inbox');
  const entry = { id: 'pool_one', threadId: item.threadId, quote: '', quoteSeq: null, itemId: null, note: 'Ready', attachments: [], revision: 0, createdAt: 1, updatedAt: 1 };
  const poolUpdate = vi.fn(() => ({ revision: 1 }));
  const upload = vi.fn(async () => ({ type: 'localFile', path: 'file.txt', name: 'file.txt' }));
  const slot = renderSlot({ component: Pools }, {}, { rpc: { pools: () => ({ pools: [{ threadId: item.threadId, threadTitle: 'Pool thread', projectId: 'pr_one', entries: [entry] }] }), poolUpdate }, sdk: { projects: { attachments: { upload } } } } as any);
  await slot.findByRole('textbox', { name: 'Pool note' });
  fireEvent.change(slot.container.querySelector('input[type="file"]')!, { target: { files: [new File(['data'], 'file.txt', { type: 'text/plain' })] } });
  await waitFor(() => expect(poolUpdate).toHaveBeenCalledWith({ id: 'pool_one', note: 'Ready', attachments: [{ type: 'localFile', path: 'file.txt', name: 'file.txt' }], revision: 0 }), { timeout: 2000 });
});
it('splits quote lines from plain text in user messages', async () => {
  const { quoteSegments } = await import('./app');
  expect(quoteSegments('> 1. **Bold**\n\nMy note\n\n> 2. Next\n> line')).toEqual([{ quote:true, text:'1. **Bold**' }, { quote:false, text:'My note' }, { quote:true, text:'2. Next\nline' }]);
  expect(quoteSegments('plain only')).toEqual([{ quote:false, text:'plain only' }]);
});
