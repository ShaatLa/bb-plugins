// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
const change = (element: Element, init: { target: { value?: string; files?: File[] } }) => { if (element.getAttribute('contenteditable') !== null) { (element as HTMLElement).dataset.testValue = init.target.value ?? ''; fireEvent.input(element); } else fireEvent.change(element, init); };
import { renderSlot as sdkRenderSlot } from '@get-bb/plugin-sdk/testing/app';
const renderSlot = ((slot: any, props: any, options: any = {}) => sdkRenderSlot(slot, props, { ...options, sdk: { ...options.sdk, projects: { ...options.sdk?.projects, attachments: { read: () => new Promise(() => {}), ...options.sdk?.projects?.attachments } }, threads: { ...options.sdk?.threads, queuedMessages: { list: () => Promise.resolve([]), ...options.sdk?.threads?.queuedMessages }, context: options.sdk?.threads?.context ?? (() => Promise.resolve({ usage: null })) } } })) as typeof sdkRenderSlot;
const cards = vi.hoisted(() => ({ renders: 0, byThread: {} as Record<string, number> }));
// The harness fixes sidebar threads at render; a test that needs a sidebar change sets sidebarOverride.threads and re-renders.
const sidebarOverride = vi.hoisted(() => ({ threads: undefined as any[] | undefined }));
vi.mock('@get-bb/plugin-sdk/app', async importOriginal => { const actual = await importOriginal<typeof import('@get-bb/plugin-sdk/app')>(); return { ...actual, ThreadChat: ({threadId}: any) => <div data-thread-chat={threadId}>Raw thread transcript</div>, experimental_PermissionModePicker: ({ value, onChange }: any) => <button data-permission-picker onClick={() => onChange('full')}>{value}</button>, experimental_ProviderModelPicker: ({ value, onChange, allowProviderChange, routing }: any) => <button data-model-picker data-routing={JSON.stringify(routing)} data-provider-change={String(allowProviderChange)} onClick={() => onChange({ providerId: allowProviderChange && value.model === 'handoff-current' ? 'provider_other' : value.providerId, model: 'model-chosen', reasoningLevel: 'high', serviceTier: 'priority' })}>{value.model}</button>, experimental_useSidebarThreads: () => { const sidebar = actual.experimental_useSidebarThreads(); return sidebarOverride.threads ? { ...sidebar, threads: sidebarOverride.threads } : sidebar; } }; });
vi.mock('./app', async importOriginal => { const app = await importOriginal<typeof import('./app')>(); return { ...app, ItemCard: (props: Parameters<typeof app.ItemCard>[0]) => { cards.renders++; cards.byThread[props.item.threadId]=(cards.byThread[props.item.threadId] ?? 0)+1; return app.ItemCard(props); } }; });
import { receivePage, History, Inbox, groupItems, followTo, atEnd } from './inbox';
import { VOICE_BUSY } from './composer';
import { itemSchema, type Item } from './contract';
const base: Item = itemSchema.parse({ id:'ans_one', kind:'mine', threadId:'thr_one', projectId:'pr_one', threadTitle:'One', projectName:'Project', status:'answered', question:'Question one', questionSeq:1, requestId:null, turnId:null, candidate:null, candidateSeq:null, interim:null, interimSeq:null, answer:'Answer one', answerSeq:2, answerSource:'turn', resolveTurnId:null, note:null, snoozedUntil:null, failedAt:null, likelyInterim:false, options:null, taskKey:null, readAt:null, pinned:false, dismissedAt:null, threadDeleted:false, createdAt:Date.now(), updatedAt:Date.now() });
const one = { threadId:'thr_one', threadTitle:'One', projectId:'pr_one', projectName:'Project', unread:1, lastAt:Date.now(), preview:'Answer one' };
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
function setup(options: { recipients?: typeof one[]; list?: (input: any) => any; send?: (input: any) => any; queuedMessages?: any; interactions?: any; context?: any; sidebarThreads?: any; rpc?: any; plugins?: any; props?: Record<string, unknown>; events?: any; providers?: any; editMessage?: (input: any) => any; defaultExecutionOptions?: any; promptHistory?: any; spawn?: any } = {}) {
  const send = vi.fn(options.send ?? (() => Promise.resolve({}))), list = vi.fn(options.list ?? (() => ({ items:[base], nextCursor:null })));
  const slot = renderSlot({ component: Inbox }, options.props ?? {}, { rpc: { recipients: () => ({ recipients: options.recipients ?? [one] }), list, markRead: () => ({ ok:true }), markThreadRead: () => ({ ok:true }), ...options.rpc }, sdk: { providers: options.providers, threads: { send, spawn: options.spawn, promptHistory: options.promptHistory, defaultExecutionOptions: options.defaultExecutionOptions, events: options.events, editMessage: options.editMessage, queuedMessages: options.queuedMessages, interactions: options.interactions, context: options.context }, ...(options.plugins ? { plugins: options.plugins } : {}) }, sidebarThreads: options.sidebarThreads } as any);
  const recipients = within(slot.getByRole('listbox', { name:'Recipients' }));
  return { slot, recipients, send, list };
}
it('shows a renamed thread at once from bb\'s live sidebar title', async () => {
  const idle = { projectId:'pr_one', parentThreadId:null, parentNotifications:'all', archivedAt:null, pinnedAt:null, sectionId:null, isUnread:false, status:'idle', runtimeStatus:'idle', queuedWork:'none', hasPendingInteraction:false, indicator:'none', activity:{ workflows:0, backgroundAgents:0, backgroundCommands:0, planMode:false }, environment:{ id:'env', path:'/x' } };
  const { recipients } = setup({ sidebarThreads: { threads:[{ ...idle, id:'thr_one', title:'Renamed' }], projects:[] } });
  expect(await recipients.findByText('Renamed')).toBeTruthy();
  expect(recipients.queryByText('One')).toBeNull();
});
it('previews a contact with sub-sessions as their tally: direct and nested, working and idle', async () => {
  const idle = { projectId:'pr_one', parentThreadId:null, parentNotifications:'all', archivedAt:null, pinnedAt:null, sectionId:null, isUnread:false, status:'idle', runtimeStatus:'idle', queuedWork:'none', hasPendingInteraction:false, indicator:'none', activity:{ workflows:0, backgroundAgents:0, backgroundCommands:0, planMode:false }, environment:{ id:'env', path:'/x' } };
  const busy = { ...idle, status:'active', runtimeStatus:'active', indicator:'runtime' };
  const { slot, recipients } = setup({ sidebarThreads: { threads:[{ ...idle, id:'thr_one', title:'One' }, { ...busy, id:'thr_a', title:'Lead A', parentThreadId:'thr_one' }, { ...idle, id:'thr_b', title:'Idle B', parentThreadId:'thr_one' }, { ...busy, id:'thr_c', title:'Nested C', parentThreadId:'thr_a' }], projects:[] } });
  expect(await recipients.findByText('2 sub + 1 nested · 2 working · 1 idle')).toBeTruthy();
  const contact = recipients.getByRole('option', { name:/One/ });
  fireEvent.click(contact); expect(recipients.queryByRole('list', { name:'Sub-sessions of One' })).toBeNull();
  fireEvent.click(recipients.getByRole('button', { name:'Show sub-sessions' }));
  const subs = within(recipients.getByRole('list', { name:'Sub-sessions of One' }));
  expect(subs.getAllByRole('listitem').map(li => [li.textContent, !!within(li).queryByRole('img', { name:'Working' }), li.querySelector('button')!.style.paddingLeft])).toEqual([['Lead A', true, '32px'], ['Nested C', true, '56px'], ['Idle B', false, '32px']]);
  expect(subs.queryAllByRole('option')).toHaveLength(0); expect(subs.queryAllByRole('button')).toHaveLength(3);
  // Unbroken guides as bb draws them: a level's line runs under its parent's icon down to the middle of its last child.
  expect(subs.getAllByRole('listitem').map(li => Array.from(li.querySelectorAll<HTMLElement>('[data-guide]'), g => `${g.style.left} ${g.classList.contains('h-1/2') ? 'half' : 'full'}`))).toEqual([['24px full'], ['24px full', '40px half'], ['24px half']]);
  fireEvent.contextMenu(subs.getByText('Nested C'));
  fireEvent.click(await slot.findByRole('menuitem', { name:'Copy ID' }));
  await waitFor(() => expect(slot.experimental_clipboardWrites).toEqual([{ text:'thr_c' }]));
  fireEvent.click(recipients.getByRole('button', { name:'Hide sub-sessions' }));
  expect(recipients.queryByRole('list', { name:'Sub-sessions of One' })).toBeNull();
});
it('badges a contact avatar with its thread\'s agent provider', async () => {
  const idle = { projectId:'pr_one', parentThreadId:null, parentNotifications:'all', archivedAt:null, pinnedAt:null, sectionId:null, isUnread:false, status:'idle', runtimeStatus:'idle', queuedWork:'none', hasPendingInteraction:false, indicator:'none', activity:{ workflows:0, backgroundAgents:0, backgroundCommands:0, planMode:false }, environment:{ id:'env', path:'/x' } };
  const { recipients } = setup({ sidebarThreads: { threads:[{ ...idle, id:'thr_one', title:'Renamed', providerId:'codex' }], projects:[] } });
  expect(await recipients.findByTitle('codex')).toBeTruthy();
});
it('mutes read rows, shows the caught-up line, and previews failures', async () => {
  const { slot, recipients } = setup({ recipients:[{ ...one, unread:0, preview:'Turn failed: Question one' }] });
  expect(await recipients.findByText('Turn failed: Question one')).toBeTruthy();
  expect(slot.queryByText('All caught up')).toBeNull();
  expect(recipients.queryByLabelText(/unread/)).toBeNull();
  expect(recipients.getByRole('option').className).toContain('opacity-50');
});
it('sends through browser SDK without originPluginId and passes draft submission', async () => {
  const { slot, recipients, send } = setup(); fireEvent.click(await recipients.findByRole('option'));
  const editor = await slot.findByRole('textbox', { name:'Send message' });
  change(editor, { target:{ value:'Hello' } }); fireEvent.click(slot.getByRole('button', { name:'More send options' })); fireEvent.click(slot.getByRole('menuitem', { name:'Save draft' }));
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(send.mock.calls[0]![0]).toMatchObject({ threadId:'thr_one', pluginSubmission:{ pluginId:'agent-hub', data:{ kind:'draft' } } });
  expect(send.mock.calls[0]![0]).not.toHaveProperty('originPluginId');
});
it('keeps a failed draft and edits made during a pending send', async () => {
  let reject!: (error: Error) => void;
  const { slot, recipients, send } = setup({ send: () => new Promise((_, no) => { reject = no; }) }); fireEvent.click(await recipients.findByRole('option'));
  const editor = await slot.findByRole('textbox', { name:'Send message' }); change(editor, { target:{ value:'First' } }); fireEvent.click(slot.getByRole('button', { name:'Send message' }));
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
  await act(async () => { reject(new Error('Offline')); });
  expect(editor.textContent).toBe('First');
  await waitFor(() => expect(localStorage.getItem('bb-plugin-answers:page:compose')).toContain('First'));
  expect(slot.getByRole('alert').textContent).toContain('Delivery uncertain');
});
it('jumps directly to a search result without fetching intermediate pages', async () => {
  const old = { ...base, id:'ans_old', question:'Ancient question', answer:'Ancient answer' };
  const { slot, recipients, list } = setup({ list: input => input.query ? { items:[old], nextCursor:null } : input.anchor ? { items:[old], nextCursor:null, newerCursor:'1|ans_old' } : { items:[base], nextCursor:'1|ans_one' } });
  fireEvent.click(await recipients.findByRole('option')); await slot.findByText('Answer one');
  fireEvent.click(slot.getByRole('button', { name:'Search conversation' })); change(slot.getByRole('textbox', { name:'Search conversation' }), { target:{ value:'Ancient' } });
  fireEvent.click(await slot.findByRole('option', { name:/Ancient answer/ }));
  await waitFor(() => expect(list).toHaveBeenCalledWith(expect.objectContaining({ anchor:'ans_old' })));
  await waitFor(() => expect(document.querySelector('[data-history-ids~="ans_old"]')?.hasAttribute('data-flash')).toBe(true));
  expect(list.mock.calls.some(([input]) => input.cursor)).toBe(false);
  expect(slot.getByRole('button', {name:'Load newer'})).toBeTruthy();
});

it('retains a newer edit after the sent snapshot resolves', async () => {
  let resolve!: (value: object) => void;
  const { slot, recipients } = setup({ send: () => new Promise(done => { resolve = done; }) }); fireEvent.click(await recipients.findByRole('option'));
  const editor = await slot.findByRole('textbox', { name:'Send message' }); change(editor, { target:{ value:'First' } }); fireEvent.click(slot.getByRole('button', { name:'Send message' }));
  change(editor, { target:{ value:'Second' } }); await act(async () => { resolve({}); });
  expect(editor.textContent).toBe('Second'); await waitFor(() => expect(localStorage.getItem('bb-plugin-answers:page:compose')).toContain('Second'));
});
it('keeps a send tied to its original thread after switching', async () => {
  let resolve!: (value: object) => void; const two = { ...one, threadId:'thr_two', threadTitle:'Two', preview:'Second preview' };
  const { slot, recipients, send } = setup({ recipients:[one, two], send: () => new Promise(done => { resolve = done; }) });
  fireEvent.click((await recipients.findAllByRole('option'))[0]!); const editor = await slot.findByRole('textbox', { name:'Send message' });
  change(editor, { target:{ value:'For one' } }); fireEvent.click(slot.getByRole('button', { name:'Send message' }));
  fireEvent.click(recipients.getAllByRole('option')[1]!); change(slot.getByRole('textbox', { name:'Send message' }), { target:{ value:'For two' } });
  await act(async () => { resolve({}); }); expect(send.mock.calls[0]![0].threadId).toBe('thr_one');
  expect(slot.getByRole('textbox', { name:'Send message' }).textContent).toBe('For two');
});
it.each([
  ['at the newest message', { top:5, depth:1, bottom:true }, 1000],
  ['scrolled up', { top:5, depth:1 }, 5],
] as const)('reopens a chat the reader left %s there', async (_, saved, expected) => {
  localStorage.setItem('bb-plugin-answers:page:scroll', JSON.stringify({ thr_one: saved }));
  const tops = new WeakMap<Element, number>();
  const spies = [
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1000),
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(function (this: HTMLElement) { return tops.get(this) ?? 0; }),
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function (this: HTMLElement, value: number) { tops.set(this, value); }),
  ];
  try {
    const { slot, recipients } = setup({ list: () => ({ items:[{ ...base, readAt:1 }], nextCursor:null }) }); fireEvent.click(await recipients.findByRole('option'));
    await slot.findByRole('list', { name:'History' });
    await waitFor(() => expect(tops.get(document.querySelector('[aria-label=History]')!.closest('.overflow-auto')!)).toBe(expected));
  } finally { spies.forEach(spy => spy.mockRestore()); localStorage.removeItem('bb-plugin-answers:page:scroll'); }
});
it('counts a reader a few lines short of the bottom as left at the end (13px off reopened an hour back)', () => {
  const view = (top: number) => ({ scrollHeight: 2000, clientHeight: 800, scrollTop: top }) as HTMLElement;
  expect(atEnd(view(1200))).toBe(true); expect(atEnd(view(1187))).toBe(true); expect(atEnd(view(1000))).toBe(true);
  expect(atEnd(view(900))).toBe(false);
});
it('reopens a chat the reader left scrolled up at their place, not at a New divider below it', async () => {
  localStorage.setItem('bb-plugin-answers:page:scroll', JSON.stringify({ thr_one: { top:5, depth:1, anchor:'ans_old', offset:0 } }));
  const tops = new WeakMap<Element, number>();
  const spies = [
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(function (this: HTMLElement) { return tops.get(this) ?? 0; }),
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function (this: HTMLElement, value: number) { tops.set(this, value); }),
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) { return this.hasAttribute('data-new') ? 700 : 0; }),
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) { return { top: this.dataset.historyIds === 'ans_old' ? 300 : 0, bottom:0, left:0, right:0, width:0, height:0 } as DOMRect; }),
  ];
  try {
    const old = { ...base, id:'ans_old', question:'Old one', readAt:1, createdAt:1, answeredAt:1 }, fresh = { ...base, id:'ans_new', question:'New one', questionSeq:5, answer:'Unread reply', readAt:null, createdAt:2, answeredAt:2 };
    const { slot, recipients } = setup({ list: () => ({ items:[fresh, old], nextCursor:null }) }); fireEvent.click(await recipients.findByRole('option'));
    await slot.findByText('Unread reply');
    expect(document.querySelector('[data-new]')).not.toBeNull();
    await waitFor(() => expect(tops.get(document.querySelector('[aria-label=History]')!.closest('.overflow-auto')!)).toBe(300));
  } finally { spies.forEach(spy => spy.mockRestore()); localStorage.removeItem('bb-plugin-answers:page:scroll'); }
});
it('keeps the card a scrolled-up reader is on in place when something above it changes height', async () => {
  const observers: (() => void)[] = [];
  vi.stubGlobal('ResizeObserver', class { constructor(private callback: () => void) { observers.push(() => this.callback()); } observe() {} disconnect() {} });
  const tops = new WeakMap<Element, number>(); let cardTop = 100;
  const spies = [
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500),
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400),
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(2000),
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(function (this: HTMLElement) { return tops.get(this) ?? 0; }),
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function (this: HTMLElement, value: number) { tops.set(this, value); }),
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) { const top = this.dataset.historyIds === 'ans_two' ? cardTop : 0; return { top, bottom: this.dataset.historyIds === 'ans_two' ? top + 50 : 0, left:0, right:0, width:0, height:0 } as DOMRect; }),
  ];
  try {
    const items = [{ ...base, id:'ans_two', question:'Second', readAt:1, createdAt:2, answeredAt:2 }, { ...base, readAt:1 }];
    const { slot, recipients } = setup({ list: () => ({ items, nextCursor:null }) }); fireEvent.click(await recipients.findByRole('option'));
    await slot.findByText('Second');
    const view = document.querySelector('[aria-label=History]')!.closest('.overflow-auto') as HTMLElement;
    fireEvent.wheel(view); tops.set(view, 0); fireEvent.scroll(view); // the reader takes over, scrolled up (1500px from the end)
    await new Promise(resolve => setTimeout(resolve, 30));
    cardTop = 160; act(() => observers.forEach(run => run())); // a card above grew by 60px
    expect(tops.get(view)).toBe(60);
  } finally { spies.forEach(spy => spy.mockRestore()); vi.unstubAllGlobals(); }
});
// A turn's row wraps the owner's message (with its image), the work log and the answer: the image growing from its pill must not move the text the reader is on.
it.each([
  ['an image above the reading line grows', -300, 0, 0, 0, 160],
  ['a reader at the bottom follows the growth to the newest', -300, 0, 1500, 1500, 1660],
  ['an image below the reading line grows', -300, 2, 0, 0, 0],
  ['an image in a row whose top is in view grows', 100, 0, 0, 0, 0],
])('keeps a scrolled-up reader\'s text in place when %s', async (_name, rowTop, grower, start, _from, expected) => {
  const observers: (() => void)[] = [];
  vi.stubGlobal('ResizeObserver', class { constructor(private callback: () => void) { observers.push(() => this.callback()); } observe() {} disconnect() {} });
  const tops = new WeakMap<Element, number>(), heights = [200, 300, 300, 300]; let grown = 0;
  const spies = [
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500),
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400),
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => 2000 + grown),
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(function (this: HTMLElement) { return tops.get(this) ?? 0; }),
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function (this: HTMLElement, value: number) { tops.set(this, value); }),
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const rect = (top: number, height: number) => ({ top, bottom: top + height, left:0, right:0, width:0, height }) as DOMRect;
      if (this.dataset.historyIds === 'ans_two') return rect(rowTop, heights.reduce((sum, height) => sum + height, 0));
      const row = this.parentElement?.parentElement, index = Array.from(this.parentElement?.children ?? []).indexOf(this);
      if (row?.dataset.historyIds === 'ans_two') return rect(rowTop + heights.slice(0, index).reduce((sum, height) => sum + height, 0), heights[index] ?? 0);
      return rect(0, 0);
    }),
  ];
  try {
    const items = [{ ...base, id:'ans_two', question:'Second', answer:'Answer two', attachments:[{ type:'localImage' as const, path:'/pic.png', name:'pic.png' }], readAt:1, createdAt:2, answeredAt:2 }, { ...base, readAt:1 }];
    const { slot, recipients } = setup({ list: () => ({ items, nextCursor:null }) }); fireEvent.click(await recipients.findByRole('option'));
    await slot.findByText('Answer two');
    const view = document.querySelector('[aria-label=History]')!.closest('.overflow-auto') as HTMLElement;
    fireEvent.wheel(view); tops.set(view, start); fireEvent.scroll(view); // the reader takes over
    await new Promise(resolve => setTimeout(resolve, 30));
    heights[grower]! += 160; grown = 160; act(() => observers.forEach(run => run()));
    expect(tops.get(view)).toBe(expected);
  } finally { spies.forEach(spy => spy.mockRestore()); vi.unstubAllGlobals(); }
});
it('groups consecutive questions with a shared answer', async () => {
  const other = { ...base, id:'ans_two', question:'Question two', questionSeq:3, answer:'Shared answer', turnId:'turn_one', answerSeq:4 };
  const first = { ...base, answer:'Shared answer', turnId:'turn_one', answerSeq:4 };
  const { slot, recipients } = setup({ list: () => ({ items:[other, first], nextCursor:null }) }); fireEvent.click(await recipients.findByRole('option'));
  await slot.findByText('Shared answer'); expect(slot.getAllByText('Shared answer')).toHaveLength(1);
  expect(document.querySelectorAll('[data-history-ids]')).toHaveLength(1);
});
it('shows the owner\'s reply to an agent question once: as the message it sent, not again under the question', async () => {
  const ask = { ...base, id:'ans_ask', kind:'for_me' as const, status:'replied' as const, question:'Pick one?', questionSeq:2, answer:'Take B', createdAt:1 };
  const sent = { ...base, id:'ans_sent', question:'> Pick one?\n\nTake B', questionSeq:3, answer:null, status:'waiting' as const, createdAt:2 };
  const { slot, recipients } = setup({ list: () => ({ items:[sent, ask], nextCursor:null }) }); fireEvent.click(await recipients.findByRole('option'));
  await slot.findAllByText('Pick one?');
  expect(document.body.textContent!.split('Take B')).toHaveLength(2);
});
// 11:01 deferred question, 11:24 child update, 11:30 the answer.
const asked = Date.now() - 3600000, minute = 60000;
const late = { ...base, id:'ans_q', question:'Deferred question', interim:'Working on it', answer:'Final answer', createdAt:asked, answeredAt:asked + 29 * minute };
const between = { ...base, id:'ans_upd', kind:'update' as const, question:'', questionSeq:null, answer:'Child report', createdAt:asked + 23 * minute, answeredAt:asked + 23 * minute };
const before = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
it('shows a question and its steer deferred by one turn together, with the interim reply once', async () => {
  const mate = (id: string, question: string, n: number) => ({ ...base, id, question, questionSeq:n, status:'deferred' as const, turnId:'u', answer:null, answerSeq:null, answeredAt:null, interim:'Looking into it', interimSeq:9, createdAt:asked + n * minute });
  const { slot, recipients } = setup({ list: () => ({ items:[mate('ans_s', 'Also check files', 2), mate('ans_q', 'It crashes', 1)], nextCursor:null }) }); fireEvent.click(await recipients.findByRole('option'));
  await slot.findByText('It crashes'); expect(slot.getByText('Also check files')).toBeTruthy();
  expect(slot.getAllByText('Looking into it')).toHaveLength(1);
});
it('shows one reply that answers an older question and a new one once, echoing the older question as a bubble', async () => {
  const older = { ...base, id:'ans_old', question:'Older question', questionSeq:1, answer:'Shared reply', answerSeq:50, createdAt:asked, answeredAt:asked + 40 * minute };
  const newer = { ...base, id:'ans_new', question:'New question', questionSeq:5, answer:'Shared reply', answerSeq:50, createdAt:asked + 39 * minute, answeredAt:asked + 40 * minute };
  const { slot, recipients } = setup({ list: () => ({ items:[newer, older, between], nextCursor:null }) }); fireEvent.click(await recipients.findByRole('option'));
  await slot.findByText('New question');
  expect(slot.getAllByText('Shared reply')).toHaveLength(1);
  const home = document.querySelector('[data-history-ids="ans_new ans_old:answer"]')!;
  expect(home.querySelector('button[title="Go to the question"]')?.textContent).toBe('Older question');
});
it('echoes a quoted reply with a mention as the owner\'s words, the mention drawn like in the full bubble', async () => {
  const older = { ...base, id:'ans_old', question:'> **Tasks / Work Board** | No\n\nCan we ask @thread:thr_fpf to do it?', questionSeq:1, answer:'Shared reply', answerSeq:50, createdAt:asked, answeredAt:asked + 40 * minute };
  const newer = { ...base, id:'ans_new', question:'New question', questionSeq:5, answer:'Shared reply', answerSeq:50, createdAt:asked + 39 * minute, answeredAt:asked + 40 * minute };
  const { slot, recipients } = setup({ list: () => ({ items:[newer, older, between], nextCursor:null }) }); fireEvent.click(await recipients.findByRole('option'));
  await slot.findByText('New question');
  const echo = document.querySelector('button[title="Go to the question"]')!;
  expect(echo.textContent).not.toContain('**'); expect(echo.textContent).not.toContain('>');
  // The mention goes through bb's Markdown (a pill in the app), not as bare text.
  expect(echo.querySelector('[data-testid="bb-markdown"]')?.textContent).toBe('@thread:thr_fpf'); expect(echo.textContent).toBe('Can we ask @thread:thr_fpf to do it?');
});
it('notes the files of an echoed question on its bubble', async () => {
  const older = { ...base, id:'ans_old', question:'Older question', questionSeq:1, attachments:[{ type:'localFile' as const, path:'a.log', name:'a.log' }, { type:'localFile' as const, path:'b.log', name:'b.log' }], answer:'Shared reply', answerSeq:50, createdAt:asked, answeredAt:asked + 40 * minute };
  const newer = { ...base, id:'ans_new', question:'New question', questionSeq:5, answer:'Shared reply', answerSeq:50, createdAt:asked + 39 * minute, answeredAt:asked + 40 * minute };
  const { slot, recipients } = setup({ list: () => ({ items:[newer, older, between], nextCursor:null }) }); fireEvent.click(await recipients.findByRole('option'));
  await slot.findByText('New question');
  expect(document.querySelector('button[title="Go to the question"]')?.textContent).toBe('Older question· 2 files');
});
it('shows the robot at the end of the chat while the agent works with nothing of the owner pending', async () => {
  const thread = { id:'thr_one', projectId:'pr_one', parentThreadId:null, parentNotifications:'all', archivedAt:null, pinnedAt:null, sectionId:null, isUnread:false, status:'active', runtimeStatus:'active', queuedWork:'none', hasPendingInteraction:false, indicator:'runtime', activity:{ workflows:0, backgroundAgents:0, backgroundCommands:0, planMode:false } };
  const { slot, recipients } = setup({ sidebarThreads:{ threads:[thread], projects:[] } }); fireEvent.click(await recipients.findByRole('option'));
  await slot.findByText('Question one');
  expect(slot.getByRole('img', { name:'The agent is working' })).toBeTruthy();
  // Its line says what the robot acts out, not a generic "Working".
  expect(slot.getByRole('button', { name:/^Thinking · / })).toBeTruthy();
});
it('offers Copy and Save under the owner\'s own message, like bb', async () => {
  const save = vi.fn(() => ({ id:'ans_saved', created:true })), writeText = vi.fn(async () => {});
  Object.assign(navigator, { clipboard: { writeText } });
  const { slot, recipients } = setup({ list: () => ({ items:[{ ...base, questionSeq:7 }], nextCursor:null }), rpc: { save } }); fireEvent.click(await recipients.findByRole('option'));
  await slot.findByText('Question one');
  fireEvent.click(slot.getAllByRole('button', { name:'Copy' })[0]!);
  await slot.findByRole('button', { name: 'Copied' });
  expect(slot.inspection.experimental_clipboardWrites).toContainEqual({ text: 'Question one' });
  fireEvent.click(slot.getByRole('button', { name:'Save to Agent Hub' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ threadId:'thr_one', seq:7, role:'user', text:'Question one' })));
});
it('edits a sent message as bb does: Edit opens "Editing message" in the composer and submits through threads.editMessage', async () => {
  const editMessage = vi.fn(async () => ({ ok:true, operationId:'op', requestSequence:9 }));
  const { slot, recipients } = setup({ list: () => ({ items:[{ ...base, questionSeq:7 }], nextCursor:null }), editMessage }); fireEvent.click(await recipients.findByRole('option'));
  await slot.findByText('Question one');
  fireEvent.click(slot.getByRole('button', { name:'Edit message' }));
  expect(slot.getByText('Editing message')).toBeTruthy();
  fireEvent.click(slot.getByRole('button', { name:'Submit edit' }));
  await waitFor(() => expect(editMessage).toHaveBeenCalledWith(expect.objectContaining({ threadId:'thr_one', expectedRequestSequence:7, input:[expect.objectContaining({ type:'text', text:'Question one' })] })));
  await waitFor(() => expect(slot.queryByText('Editing message')).toBeNull());
});
it('puts an interim reply above the final answer in the same card, under "Answered below" instead of a clock', async () => {
  const { slot, recipients } = setup({ list: () => ({ items:[late], nextCursor:null }) }); fireEvent.click(await recipients.findByRole('option'));
  const interim = await slot.findByText('Working on it'), answer = slot.getByText('Final answer'), mark = slot.getByText('Answered below');
  expect(before(mark, interim) && before(interim, answer)).toBe(true);
  expect(slot.queryByLabelText('Interim reply')).toBeNull(); expect(mark.closest('button')).toBeNull();
});
it('drops the interim clock once the owner marks the owed answer as answered', async () => {
  const owed = { ...base, id:'ans_q', status:'deferred' as const, interim:'Working on it', answer:null };
  for (const [item, clock] of [[owed, true], [{ ...owed, status:'answered' as const, answerSource:'user' as const }, false]] as const) {
    const { slot, recipients } = setup({ list: () => ({ items:[{ ...base, id:'ans_next', question:'Next one', createdAt:base.createdAt + 1000 }, item], nextCursor:null }) }); fireEvent.click(await recipients.findByRole('option'));
    await slot.findByText('Working on it');
    expect(!!slot.queryByLabelText('Interim reply')).toBe(clock);
    cleanup();
  }
});
it('splits a late answer from its question when an update arrived in between', async () => {
  const { slot, recipients } = setup({ list: () => ({ items:[late, between], nextCursor:null }) }); fireEvent.click(await recipients.findByRole('option'));
  await slot.findByText('Final answer');
  const question = document.querySelector('[data-history-ids="ans_q"]')!, update = document.querySelector('[data-history-ids="ans_upd"]')!, answer = document.querySelector('[data-history-ids="ans_q:answer"]')!;
  expect(before(question, update) && before(update, answer)).toBe(true);
  expect(question.textContent).toContain('Working on it'); expect(question.textContent).not.toContain('Final answer');
  // "Answered below" carries the arrow; the interim reply under it drops the clock that would repeat it.
  expect(within(question as HTMLElement).queryByLabelText('Interim reply')).toBeNull();
  expect(within(answer as HTMLElement).queryByText('Working on it')).toBeNull();
  fireEvent.click(within(question as HTMLElement).getByRole('button', { name:'Answered below' }));
  await waitFor(() => expect(answer.hasAttribute('data-flash')).toBe(true));
  fireEvent.click(within(answer as HTMLElement).getByRole('button', { name:'Deferred question' }));
  await waitFor(() => expect(question.hasAttribute('data-flash')).toBe(true));
  expect(within(answer as HTMLElement).getByRole('button', { name:'More' })).toBeTruthy(); expect(within(question as HTMLElement).queryByRole('button', { name:'More' })).toBeNull();
});
it('keeps an immediately answered question paired', async () => {
  const quick = { ...late, interim:null, answeredAt:asked + minute };
  const { slot, recipients } = setup({ list: () => ({ items:[between, quick], nextCursor:null }) }); fireEvent.click(await recipients.findByRole('option'));
  await slot.findByText('Final answer');
  expect(document.querySelector('[data-history-ids="ans_q"]')!.textContent).toContain('Final answer');
  expect(document.querySelector('[data-history-ids="ans_q:answer"]')).toBeNull(); expect(slot.queryByText('Answered below')).toBeNull();
});
it('shows only the quoted answer while its question is beyond the loaded window, and the question once loaded', async () => {
  const { slot, recipients } = setup({ list: input => input.cursor ? { items:[], nextCursor:null } : { items:[late, between], nextCursor:`${between.createdAt}|ans_upd` } }); fireEvent.click(await recipients.findByRole('option'));
  await slot.findByText('Final answer');
  expect(document.querySelector('[data-history-ids="ans_q"]')).toBeNull();
  expect(within(document.querySelector('[data-history-ids="ans_q:answer"]') as HTMLElement).getByRole('button', { name:'Deferred question' })).toBeTruthy();
  fireEvent.click(slot.getByRole('button', { name:'Load earlier' }));
  await waitFor(() => expect(document.querySelector('[data-history-ids="ans_q"]')).not.toBeNull());
});
const quiet = (n: number, answer: string, asks = false) => ({ ...between, id:`ans_u${n}`, answer, asks, createdAt:asked + n * minute, answeredAt:asked + n * minute });
// The owner's later message, so the quiet run is not the chat's latest message (that one always shows in full).
const after = { ...base, id:'ans_after', question:'Thanks', createdAt:asked + 9 * minute, answeredAt:asked + 9 * minute };
it('puts a message that joined the turn answering the owner above the owner\'s message, keeping the question and answer together', async () => {
  const { conversation } = await import('./inbox');
  const mine = { ...base, id:'ans_mine', turnId:'turn-1', status:'waiting', answer:null, answerSeq:null, createdAt:asked, answeredAt:null };
  const joined = { ...between, id:'ans_joined', turnId:'turn-1', answer:null, createdAt:asked + minute, answeredAt:asked + minute };
  const other = { ...between, id:'ans_other', turnId:null, answer:null, createdAt:asked + 2 * minute, answeredAt:asked + 2 * minute };
  const shape = (entries: any[]) => entries.map(e => `${e.part ?? ''}${e.group.map((i: any) => i.id).join('+')}`);
  expect(shape(conversation([[mine], [joined], [other]] as any, false, [], false, null, false).entries)).toEqual(['ans_joined', 'ans_mine', 'ans_other']);
  const done = { ...mine, status:'answered', answer:'Answer', answerSeq:9, answeredAt:asked + 3 * minute };
  expect(shape(conversation([[done], [joined]] as any, false, [], true, null, false).entries)).toEqual(['ans_joined', 'ans_mine']);
  const replied = { ...joined, id:'ans_replied', answer:'Steer reply', answeredAt:done.answeredAt };
  expect(shape(conversation([[done], [replied]] as any, false, [], true, null, false).entries)).toEqual(['ans_mine', 'ans_replied']);
});
it('keeps a message that joined the owner\'s turn at its own time when other messages came after the question, so the New divider is not far above them', async () => {
  const { conversation } = await import('./inbox');
  const mine = { ...base, id:'ans_mine', turnId:'turn-1', status:'answered', answer:'Answer', answerSeq:9, createdAt:asked, answeredAt:asked + 9 * minute, readAt:1 };
  const other = { ...between, id:'ans_other', turnId:'turn-2', answer:null, createdAt:asked + minute, answeredAt:asked + minute, readAt:1 };
  const joined = { ...between, id:'ans_joined', turnId:'turn-1', answer:null, createdAt:asked + 5 * minute, answeredAt:asked + 5 * minute, readAt:null };
  const shape = (entries: any[]) => entries.map(e => `${e.part ?? ''}${e.group.map((i: any) => i.id).join('+')}`);
  expect(shape(conversation([[other], [mine], [joined]] as any, false, [], false, null, false).entries)).toEqual(['question' + 'ans_mine', 'ans_other', 'ans_joined', 'answerans_mine']);
  // Still waiting (no split), and a message with no turn blocks like one of another turn.
  const waiting = { ...mine, status:'waiting', answer:null, answerSeq:null, answeredAt:null };
  expect(shape(conversation([[waiting], [other], [joined]] as any, false, [], false, null, false).entries)).toEqual(['ans_mine', 'ans_other', 'ans_joined']);
  expect(shape(conversation([[waiting], [{ ...other, turnId:null }], [joined]] as any, false, [], false, null, false).entries)).toEqual(['ans_mine', 'ans_other', 'ans_joined']);
});
it('opens a chat with the New divider right above the unread message that joined the owner\'s turn, below the read messages that came before it', async () => {
  const mine = { ...base, id:'ans_mine', turnId:'turn-1', status:'answered', answer:'Answer', answerSeq:9, createdAt:asked, answeredAt:asked + 9 * minute, readAt:1 };
  const other = { ...base, id:'ans_other', question:'Other question', questionSeq:3, turnId:'turn-2', answer:'Other answer', answerSeq:4, createdAt:asked + minute, answeredAt:asked + minute, readAt:1 };
  const joined = { ...between, id:'ans_joined', turnId:'turn-1', answer:null, createdAt:asked + 5 * minute, answeredAt:asked + 5 * minute, readAt:null };
  const { slot, recipients } = setup({ list: () => ({ items:[mine, joined, other], nextCursor:null }) }); fireEvent.click(await recipients.findByRole('option'));
  await slot.findByRole('list', { name:'History' });
  await waitFor(() => expect(document.querySelector('[data-new]')).not.toBeNull());
  const order = Array.from(document.querySelectorAll('[data-new], [data-history-ids]')).flatMap(node => node.hasAttribute('data-new') ? ['new'] : node.getAttribute('data-history-ids')!.split(' '));
  expect(order.indexOf('new')).toBe(order.indexOf('ans_joined') - 1); expect(order.indexOf('ans_other')).toBeLessThan(order.indexOf('new'));
});
it('does not fold the last update shown in full back into its group when a turn starts (a queued message sent)', async () => {
  const { conversation } = await import('./inbox');
  const run = [[quiet(1, 'One')], [quiet(2, 'Two')], [quiet(3, 'Long final report')]] as any;
  const shape = (entries: any[]) => entries.map(e => e.updates ? `group ${e.group.length}` : e.group[0].id);
  expect(shape(conversation(run, false, [], true).entries)).toEqual(['group 2', 'ans_u3']);
  expect(shape(conversation(run, false, [], false, 'ans_u3').entries)).toEqual(['group 2', 'ans_u3']);
  expect(shape(conversation(run, false, [], false, null).entries)).toEqual(['group 3']);
});
it('keeps the last update open in the chat when the agent starts working again', async () => {
  const idle = { id:'thr_one', title:'One', projectId:'pr_one', parentThreadId:null, parentNotifications:'all', archivedAt:null, pinnedAt:null, sectionId:null, isUnread:false, status:'idle', runtimeStatus:'idle', queuedWork:'none', hasPendingInteraction:false, indicator:'none', activity:{ workflows:0, backgroundAgents:0, backgroundCommands:0, planMode:false }, environment:{ id:'env', path:'/x' } };
  const { slot, recipients } = setup({ sidebarThreads:{ threads:[idle], projects:[] }, list: () => ({ items:[quiet(3, 'Long final report'), quiet(2, 'Second report'), quiet(1, 'First report')], nextCursor:null }) });
  fireEvent.click(await recipients.findByRole('option', { name:/One/ }));
  await waitFor(() => expect(document.querySelector('[data-history-ids="ans_u3"]')).not.toBeNull());
  try {
    sidebarOverride.threads = [{ ...idle, status:'active', runtimeStatus:'active', indicator:'runtime' }];
    slot.rerender(<Inbox />);
    await act(async () => { await Promise.resolve(); });
    expect(document.querySelector('[data-history-ids="ans_u3"]')).not.toBeNull();
  } finally { sidebarOverride.threads = undefined; }
});
it('keeps the latest quiet update in its group while the chat still works', async () => {
  const idle = { projectId:'pr_one', parentThreadId:null, parentNotifications:'all', archivedAt:null, pinnedAt:null, sectionId:null, isUnread:false, status:'idle', runtimeStatus:'idle', queuedWork:'none', hasPendingInteraction:false, indicator:'none', activity:{ workflows:0, backgroundAgents:0, backgroundCommands:0, planMode:false }, environment:{ id:'env', path:'/x' } };
  const { slot, recipients } = setup({ sidebarThreads: { threads:[{ ...idle, id:'thr_one', title:'One' }, { ...idle, id:'thr_kid', parentThreadId:'thr_one', status:'active', runtimeStatus:'active', indicator:'runtime' }], projects:[] }, list: () => ({ items:[quiet(3, 'Third report'), quiet(2, 'Second report'), quiet(1, 'First report')], nextCursor:null }) });
  fireEvent.click(await recipients.findByRole('option', { name:/One/ }));
  await slot.findByRole('button', { name:/3 background updates/ });
  expect(document.querySelector('[data-history-ids="ans_u3"]')).toBeNull();
});
it('keeps the chat\'s latest message, a quiet update after a run of them, in full outside the group', async () => {
  const { slot, recipients } = setup({ list: () => ({ items:[quiet(3, 'Final report'), quiet(2, 'Second report'), quiet(1, 'First report')], nextCursor:null }) }); fireEvent.click(await recipients.findByRole('option'));
  await slot.findByText('Final report');
  expect(Array.from(document.querySelectorAll('[data-update-group]'), node => node.getAttribute('data-history-ids'))).toEqual(['ans_u1 ans_u2']);
  expect(document.querySelector('[data-history-ids="ans_u3"]')).not.toBeNull();
});
it('collapses consecutive quiet updates into one group with a preview of the latest, and expands it on click', async () => {
  const { slot, recipients } = setup({ list: () => ({ items:[after, quiet(3, 'Third **report**'), quiet(2, 'Second report'), quiet(1, 'First report')], nextCursor:null }) }); fireEvent.click(await recipients.findByRole('option'));
  const toggle = await slot.findByRole('button', { name:/3 background updates/ });
  expect(document.querySelectorAll('[data-update-group]')).toHaveLength(1); expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(document.querySelector('[data-history-ids="ans_u1 ans_u2 ans_u3"]')).not.toBeNull();
  expect(slot.getByText('Third report')).toBeTruthy(); expect(slot.queryByText('First report')).toBeNull();
  fireEvent.click(toggle);
  expect(await slot.findByText('First report')).toBeTruthy(); expect(slot.getByText('Second report')).toBeTruthy(); expect(toggle.getAttribute('aria-expanded')).toBe('true');
  fireEvent.click(slot.getByRole('button', { name:'Collapse background updates' }));
  expect(toggle.getAttribute('aria-expanded')).toBe('false'); expect(slot.queryByText('First report')).toBeNull();
});
it('keeps the conversation up when an older page lands before the newest (cache on return)', async () => {
  const { unbroken } = await import('./inbox') as any;
  const a = { items:[base], nextCursor:'1|ans_one' }, b = { items:[], nextCursor:null }, sparse: any[] = []; sparse[1] = b;
  expect(unbroken([...sparse])).toEqual([]); expect(unbroken([a, undefined, b])).toEqual([a]); const whole = [a, b]; expect(unbroken(whole)).toBe(whole);
});
it('loads earlier pages by itself while the loaded window holds only quiet updates', async () => {
  const { recipients, list } = setup({ list: input => input.cursor ? { items:[base], nextCursor:null } : { items:[quiet(2, 'Second report'), quiet(1, 'First report')], nextCursor:'1|ans_u1' } }); fireEvent.click(await recipients.findByRole('option'));
  await waitFor(() => expect(list.mock.calls.some(([input]: any[]) => input.cursor === '1|ans_u1')).toBe(true));
});
it('walks the robot under a plugin\'s message while the agent works on it (a Work Board report, a CI notice)', async () => {
  const update = { ...base, id:'ans_plug', kind:'update' as const, status:'waiting' as const, question:'**EXA-1 · READY** from a lead', questionSeq:null, answer:null, answerSeq:null, trigger:{ kind:'plugin' as const, sourceId:'work-board', sourceTitle:null } };
  const { slot, recipients } = setup({ list: () => ({ items:[update], nextCursor:null }) });
  fireEvent.click(await recipients.findByRole('option'));
  await slot.findByText(/READY/);
  expect(within(document.querySelector('[data-history-ids="ans_plug"]') as HTMLElement).getByRole('img', { name:'Working on the message' })).toBeTruthy();
});
it('quotes the message a plugin sent under its caption, like another thread\'s, the reply below', async () => {
  const update = { ...base, id:'ans_plug', kind:'update' as const, question:'**CI Dashboard** · `Deploy finished` main\n- Run: 42', questionSeq:null, answer:'Deployed', answerSeq:7, trigger:{ kind:'plugin' as const, sourceId:'delivery-dashboard', sourceTitle:null } };
  const { slot, recipients } = setup({ list: () => ({ items:[update], nextCursor:null }) });
  fireEvent.click(await recipients.findByRole('option'));
  await slot.findByText('Deployed');
  const quote = document.querySelector('[data-history-ids="ans_plug"] [data-agent-message]') as HTMLElement;
  expect(quote.textContent).toContain('Deploy finished'); expect(quote.textContent).toContain('Run: 42');
  expect(document.querySelector('[data-history-ids="ans_plug"] [data-update-caption]')).toBeTruthy();
  expect(document.querySelector('[data-history-ids="ans_plug"] [data-bubble-row]')).toBeNull();
});
it('names the plugin as "Message from" its pill and drops the plugin\'s own leading tag', async () => {
  const update = { ...base, id:'ans_plug', kind:'update' as const, question:'[answers] Call `agent_hub_report` now.', questionSeq:null, answer:'Done', answerSeq:7, trigger:{ kind:'plugin' as const, sourceId:'agent-hub', sourceTitle:null } };
  const { slot, recipients } = setup({ list: () => ({ items:[update], nextCursor:null }), // The brand list is cached per module, so it also carries the brand a later test reads.
    plugins: { list: async () => ({ plugins:[{ id:'agent-hub', name:'Agent Hub', icon:'MessageQuestion' }, { id:'concurrency-limit', name:'Concurrency limit', icon:'Gauge' }] }) } });
  fireEvent.click(await recipients.findByRole('option'));
  await waitFor(() => expect(document.querySelector('[data-history-ids="ans_plug"] [data-update-caption]')?.textContent).toMatch(/^Message from Agent Hub/));
  expect(document.querySelector('[data-history-ids="ans_plug"] [data-agent-message]')?.textContent).toBe('Call `agent_hub_report` now.');
});
it('keeps an opened updates group open after leaving the screen and coming back', async () => {
  const list = () => ({ items:[after, quiet(3, 'Third report'), quiet(2, 'Second report'), quiet(1, 'First report')], nextCursor:null });
  const first = setup({ list }); fireEvent.click(await first.recipients.findByRole('option'));
  fireEvent.click(await first.slot.findByRole('button', { name:/3 background updates/ }));
  expect(await first.slot.findByText('First report')).toBeTruthy();
  first.slot.unmount?.(); cleanup();
  const again = setup({ list }); fireEvent.click(await again.recipients.findByRole('option'));
  expect(await again.slot.findByText('First report')).toBeTruthy();
  expect((await again.slot.findByRole('button', { name:/3 background updates/ })).getAttribute('aria-expanded')).toBe('true');
});
it('keeps an update that asks the owner as a full message that splits the run', async () => {
  const { slot, recipients } = setup({ list: () => ({ items:[after, quiet(5, 'Five'), quiet(4, 'Four'), quiet(3, 'Merge now?', true), quiet(2, 'Two'), quiet(1, 'One')], nextCursor:null }) }); fireEvent.click(await recipients.findByRole('option'));
  await slot.findByText('Merge now?');
  expect(Array.from(document.querySelectorAll('[data-update-group]'), node => node.getAttribute('data-history-ids'))).toEqual(['ans_u1 ans_u2', 'ans_u4 ans_u5']);
  expect(document.querySelector('[data-history-ids="ans_u3"] [data-update-group]')).toBeNull();
});
it('shows an update as the agent message under a caption naming the finished child, without an owner bubble', async () => {
  const child = { id:'thr_child', title:'Child task', projectId:'pr_one', parentThreadId:'thr_one', parentNotifications:'all', archivedAt:null, pinnedAt:null, sectionId:null, isUnread:false, status:'idle', runtimeStatus:'idle', queuedWork:'none', hasPendingInteraction:false, indicator:'none', activity:{ workflows:0, backgroundAgents:0, backgroundCommands:0, planMode:false }, environment:{ id:'env', path:'/x' } };
  const update = { ...base, id:'ans_upd', kind:'update' as const, question:'[bb system] @thread:thr_child completed: ok', questionSeq:null, answer:'Child report', answerSeq:7, trigger:{ kind:'system' as const, sourceId:'thr_child' } };
  const { slot, recipients } = setup({ list: () => ({ items:[update], nextCursor:null }), sidebarThreads: { threads:[child], projects:[] } });
  fireEvent.click(await recipients.findByRole('option'));
  await slot.findByText('Child report');
  const card = document.querySelector('[data-history-ids="ans_upd"]')!, caption = card.querySelector('[data-update-caption]')!;
  expect(caption.textContent).toMatch(/^Child task finished/);
  expect(within(caption as HTMLElement).getByRole('link', { name:'Child task' }).getAttribute('href')).toBe('/projects/pr_one/threads/thr_child');
  expect(slot.queryByText(/bb system/)).toBeNull();
  expect(within(card as HTMLElement).queryByRole('button', { name:'Reply' })).toBeNull();
});
it('shows Reply only on agent questions and keeps open ones out of the conversation', async () => {
  const open = { ...base, id:'ans_open', kind:'for_me' as const, status:'open' as const, question:'Still open?', answer:null, answerSeq:null, options:['Yes'] };
  const agentQuestion = { ...open, id:'ans_agent', status:'replied' as const, question:'Choose?', answer:'Yes' };
  const { slot, recipients } = setup({ list: () => ({ items:[open, agentQuestion, base], nextCursor:null }) });
  fireEvent.click(await recipients.findByRole('option'));
  await slot.findByText('Choose?');
  expect(within(document.querySelector('[data-history-ids="ans_one"]')!).queryByRole('button', { name:'Reply' })).toBeNull();
  expect(within(document.querySelector('[data-history-ids="ans_agent"]')!).getByRole('button', { name:'Reply' })).toBeTruthy();
  expect(within(slot.getByRole('list', { name:'History' })).queryByText('Still open?')).toBeNull();
});
it('keeps the contact list and hides the previous conversation while switching', async () => {
  let release!: () => void;
  const two = { ...one, threadId:'thr_two', threadTitle:'Two', preview:'Answer two' };
  const { slot, recipients } = setup({ recipients:[one, two], list: (input: any) => input.threadId === 'thr_two' && input.view !== 'for_me'
    ? new Promise(resolve => { release = () => resolve({ items:[{ ...base, id:'ans_two', threadId:'thr_two', question:'Question two', answer:'Answer two' }], nextCursor:null }); })
    : { items:[base], nextCursor:null } });
  fireEvent.click((await recipients.findAllByRole('option'))[0]!);
  expect(await slot.findByText('Question one')).toBeTruthy();
  fireEvent.click(recipients.getAllByRole('option')[1]!);
  expect(recipients.getAllByRole('option')).toHaveLength(2);
  expect(slot.getByText('Question one').closest('[inert]')).toBeTruthy();
  await act(async () => { release(); });
  expect(await slot.findByText('Question two')).toBeTruthy();
  expect(slot.getByText('Question one').closest('[inert]')).toBeTruthy();
});
it('wraps a contact in bb’s thread menu when bb lists the thread', async () => {
  const idle = { projectId:'pr_one', parentThreadId:null, parentNotifications:'all', archivedAt:null, pinnedAt:null, sectionId:null, isUnread:false, status:'idle', runtimeStatus:'idle', queuedWork:'none', hasPendingInteraction:false, indicator:'none', activity:{ workflows:0, backgroundAgents:0, backgroundCommands:0, planMode:false }, environment:{ id:'env', path:'/x' } };
  // The contact itself is idle; its running sub-thread makes it busy, as a collapsed row does in bb's sidebar.
  const thread = { ...idle, id:'thr_one' } as any, child = { ...idle, id:'thr_child', parentThreadId:'thr_one', runtimeStatus:'active', indicator:'runtime' } as any;
  const slot = renderSlot({ component: Inbox }, {}, { rpc: { recipients: () => ({ recipients: [one, { ...one, threadId:'thr_other', threadTitle:'Other' }] }), list: () => ({ items:[base], nextCursor:null }) }, sidebarThreads: { threads:[thread, child] } } as any);
  const menus = await slot.findAllByTestId('bb-thread-actions-context-menu');
  expect(menus.map(menu => menu.getAttribute('data-thread-id'))).toEqual(['thr_one']);
  expect(within(menus[0]!).getByRole('option').textContent).toContain('One');
  expect(within(slot.getByRole('listbox', { name:'Recipients' })).getAllByRole('option')).toHaveLength(2);
  expect(within(menus[0]!).getByRole('option').querySelector('[data-thread-status-glyph="runtime"]')).toBeTruthy();
  expect(slot.container.querySelectorAll('[data-thread-status-glyph]')).toHaveLength(1);
});
it('groups contacts under project headers when the setting is on', async () => {
  const rows = [{ ...one, threadId:'thr_a', threadTitle:'A', projectId:'pa', projectName:'Acme' }, { ...one, threadId:'thr_b', threadTitle:'B', projectId:'pb', projectName:'Plugins' }, { ...one, threadId:'thr_c', threadTitle:'C', projectId:'pa', projectName:'Acme' }];
  const slot = renderSlot({ component: Inbox }, {}, { rpc: { getPreferences: () => ({ groupByProject: true }), recipients: () => ({ recipients: rows }), list: () => ({ items:[], nextCursor:null }) } } as any);
  const list = slot.getByRole('listbox', { name:'Recipients' });
  await within(list).findAllByRole('option');
  expect(Array.from(list.querySelectorAll('p, [role=option]')).map(node => node.tagName === 'P' ? node.textContent : node.querySelector('.truncate')!.textContent)).toEqual(['Acme', 'A', 'C', 'Plugins', 'B']);
});
it('starts a new thread in a project from its header', async () => {
  const rows = [{ ...one, threadId:'thr_a', threadTitle:'A', projectId:'pa', projectName:'Acme' }];
  const slot = renderSlot({ component: Inbox }, {}, { rpc: { getPreferences: () => ({ groupByProject: true }), recipients: () => ({ recipients: rows }), list: () => ({ items:[], nextCursor:null }) } } as any);
  fireEvent.click(await slot.findByRole('button', { name:'New thread in Acme' }));
  expect(slot.inspection.navigateCalls).toContainEqual({ method:'toCompose', options:{ projectId:'pa', focusPrompt:true } });
});
it('resizes the contact column with the keyboard and remembers the width', async () => {
  const { slot } = setup();
  const handle = slot.getByRole('separator', { name:'Resize contacts' });
  expect(handle.getAttribute('aria-valuenow')).toBe('230');
  fireEvent.keyDown(handle, { key:'ArrowRight' });
  expect(handle.getAttribute('aria-valuenow')).toBe('246');
  await waitFor(() => expect(localStorage.getItem('bb-plugin-answers:page:contacts-width')).toBe('246'));
  for (let i = 0; i < 40; i++) fireEvent.keyDown(handle, { key:'ArrowLeft' });
  expect(handle.getAttribute('aria-valuenow')).toBe('170');
  fireEvent.doubleClick(handle);
  expect(handle.getAttribute('aria-valuenow')).toBe('230');
});

it('orders project groups and saves a dragged order in plugin settings', async () => {
  const rows = [{ ...one, threadId:'thr_a', threadTitle:'A', projectId:'pa', projectName:'Acme' }, { ...one, threadId:'thr_b', threadTitle:'B', projectId:'pb', projectName:'Plugins' }];
  const setPreferences = vi.fn(() => ({ ok:true }));
  const slot = renderSlot({ component: Inbox }, {}, { rpc: { getPreferences: () => ({ groupByProject: true, projectOrder: 'gone,pb' }), recipients: () => ({ recipients: rows }), list: () => ({ items:[], nextCursor:null }), setPreferences }, sidebarThreads: { threads: [], projects: [{ id:'personal', name:'Personal', isPersonal:true }, { id:'pb', name:'Plugins', isPersonal:false }, { id:'pa', name:'Acme', isPersonal:false }] } } as any);
  const list = slot.getByRole('listbox', { name:'Recipients' });
  await within(list).findAllByRole('option');
  const headers = () => Array.from(list.querySelectorAll('p')).map(node => node.textContent);
  expect(headers()).toEqual(['Plugins', 'Acme']);
  fireEvent.dragStart(within(list).getByText('Acme'), { dataTransfer: { setData: () => {}, effectAllowed: '' } });
  const plugins = within(list).getByRole('group', { name:'Plugins' });
  fireEvent.dragOver(plugins, { clientY: -1 });
  fireEvent.drop(plugins, { clientY: -1 });
  expect(headers()).toEqual(['Acme', 'Plugins']);
  await waitFor(() => expect(setPreferences).toHaveBeenCalledWith({ projectOrder:'pa,pb' }));
});

it('shows a pending bubble until the matching newest item arrives, and skips drafts', async () => {
  let items = [base];
  const { slot, recipients } = setup({ list: () => ({ items, nextCursor:null }) }); fireEvent.click(await recipients.findByRole('option'));
  const editor = await slot.findByRole('textbox', { name:'Send message' });
  change(editor, { target:{ value:'New message' } }); fireEvent.click(slot.getByRole('button', { name:'Send message' }));
  expect(slot.container.textContent).not.toContain('Sending…'); expect(slot.getAllByText('New message').length).toBeGreaterThan(0);
  items = [{ ...base, id:'ans_new', question:'New message' }, base];
  await act(async () => { fireEvent.click(recipients.getByRole('option')); });
  await waitFor(() => expect(slot.queryByText('Sending…')).toBeNull());
  change(editor, { target:{ value:'Draft only' } }); fireEvent.click(slot.getByRole('button', { name:'More send options' })); fireEvent.click(slot.getByRole('menuitem', { name:'Save draft' }));
  expect(slot.queryByText('Sending…')).toBeNull();
});
it('empties the composer on Send at once and shows the message before bb answers', async () => {
  let resolve!: (value: object) => void;
  const { slot, recipients } = setup({ send: () => new Promise(done => { resolve = done; }) }); fireEvent.click(await recipients.findByRole('option'));
  const editor = await slot.findByRole('textbox', { name:'Send message' }); change(editor, { target:{ value:'Right away' } }); fireEvent.click(slot.getByRole('button', { name:'Send message' }));
  expect(editor.textContent).toBe(''); expect(slot.getByText('Right away')).toBeTruthy();
  await act(async () => { resolve({ ok:true, delivery:'sent' }); });
  expect(editor.textContent).toBe('');
});
it('shows a message bb will queue in the queue card at once, until the queue brings its row', async () => {
  const thread = { id:'thr_one', title:'One', projectId:'pr_one', parentThreadId:null, parentNotifications:'all', archivedAt:null, pinnedAt:null, sectionId:null, isUnread:false, status:'active', runtimeStatus:'active', queuedWork:'none', hasPendingInteraction:false, indicator:'runtime', activity:{ workflows:0, backgroundAgents:0, backgroundCommands:0, planMode:false }, environment:{ id:'env', path:'/x' } };
  let resolve!: (value: object) => void, rows: object[] = [];
  const { slot, recipients } = setup({ sidebarThreads: { threads:[thread], projects:[] }, send: () => new Promise(done => { resolve = done; }), queuedMessages: { list: () => Promise.resolve(rows) } }); fireEvent.click(await recipients.findByRole('option'));
  const editor = await slot.findByRole('textbox', { name:'Send message' }); change(editor, { target:{ value:'Later one' } }); fireEvent.click(slot.getByRole('button', { name:'Send message' }));
  expect(editor.textContent).toBe('');
  await waitFor(() => expect(slot.container.querySelector('[data-queue-pending]')?.textContent).toBe('Later one'));
  rows = [{ id:'q1', threadId:'thr_one', content:[{ type:'text', text:'Later one', mentions:[] }], createdAt:Date.now(), updatedAt:1 }];
  await act(async () => { resolve({ ok:true, delivery:'queued' }); });
  await waitFor(() => expect(slot.container.querySelector('[data-queue-row="q1"]')).toBeTruthy());
  expect(slot.container.querySelector('[data-queue-pending]')).toBeNull();
});
it('drops the pending bubble when bb queues the message, since the queue card shows it', async () => {
  const { slot, recipients } = setup({ send: () => Promise.resolve({ ok:true, delivery:'queued' }) }); fireEvent.click(await recipients.findByRole('option'));
  change(await slot.findByRole('textbox', { name:'Send message' }), { target:{ value:'Queued one' } }); fireEvent.click(slot.getByRole('button', { name:'Send message' }));
  await waitFor(() => expect(slot.queryByRole('button', { name:'Toggle queued messages' })).toBeNull());
});
it('shows a quoted queued reply as the quote line and the message line', async () => {
  const row = { id:'q1', threadId:'thr_one', content:[{ type:'text', text:'> Quoted passage\n\nMy reply', mentions:[] }], updatedAt:1 };
  const { slot, recipients } = setup({ queuedMessages: { list: () => Promise.resolve([row]) } }); fireEvent.click(await recipients.findByRole('option'));
  const card = await slot.findByRole('region', { name:'Queued messages' });
  expect(within(card).getByText('Quoted passage')).toBeTruthy(); expect(within(card).getByText('My reply')).toBeTruthy();
});
it('renders queued messages and sends or deletes them through the SDK', async () => {
  const row = { id:'q1', threadId:'thr_one', content:[{ type:'text', text:'Waiting text', mentions:[] }], updatedAt:1 };
  // bb keeps this one queued (the thread cannot take it now), so the row comes back to be deleted.
  const sendNow = vi.fn(() => Promise.resolve({ ok:true, delivery:'queued' })), remove = vi.fn(() => Promise.resolve({}));
  const { slot, recipients } = setup({ queuedMessages: { list: () => Promise.resolve([row]), send:sendNow, delete:remove } }); fireEvent.click(await recipients.findByRole('option'));
  expect(await slot.findByText('Waiting text')).toBeTruthy();
  fireEvent.click(slot.getByRole('button', { name:'Send queued message 1 now' })); await waitFor(() => expect(sendNow).toHaveBeenCalledWith({ threadId:'thr_one', queuedMessageId:'q1', mode:'auto' }));
  fireEvent.click(await slot.findByRole('button', { name:'Delete queued message 1' })); await waitFor(() => expect(remove).toHaveBeenCalledWith({ threadId:'thr_one', queuedMessageId:'q1' }));
});
it('drops a queued row bb already sent: deleting it answers 404 quietly and rereads the queue', async () => {
  const row = { id:'q1', threadId:'thr_one', content:[{ type:'text', text:'Already sent', mentions:[] }], createdAt:1, updatedAt:1 };
  let rows = [row];
  const remove = vi.fn(() => { rows = []; return Promise.reject(Object.assign(new Error('HTTP 404: Queued message not found'), { status:404 })); });
  const { slot, recipients } = setup({ queuedMessages: { list: () => Promise.resolve(rows), delete:remove } }); fireEvent.click(await recipients.findByRole('option'));
  fireEvent.click(await slot.findByRole('button', { name:'Delete queued message 1' }));
  await waitFor(() => expect(slot.queryByText('Already sent')).toBeNull());
  expect(slot.queryByText(/Queued message not found/)).toBeNull();
});
it('rereads the queue when the chat already recorded a queued row\'s message after it was queued', async () => {
  const row = { id:'q1', threadId:'thr_one', content:[{ type:'text', text:'Sent meanwhile', mentions:[] }], createdAt:1, updatedAt:1 };
  let reads = 0;
  const list = vi.fn(() => Promise.resolve(++reads === 1 ? [row] : []));
  const { slot, recipients } = setup({ list: () => ({ items:[{ ...base, id:'ans_sent', question:'Sent meanwhile', questionSeq:9, createdAt:5 }], nextCursor:null }), queuedMessages: { list } }); fireEvent.click(await recipients.findByRole('option'));
  await waitFor(() => expect(list.mock.calls.length).toBeGreaterThanOrEqual(2));
  await waitFor(() => expect(slot.queryByRole('region', { name:'Queued messages' })).toBeNull());
});
it('hides a queued row as soon as the chat records its message, before the queue drops it; a repeat of the same text stays', async () => {
  const row = (id: string, createdAt: number) => ({ id, threadId:'thr_one', content:[{ type:'text', text:'Sent meanwhile', mentions:[] }], createdAt, updatedAt:createdAt });
  const { slot, recipients } = setup({ list: () => ({ items:[{ ...base, id:'ans_sent', question:'Sent meanwhile', questionSeq:9, createdAt:5 }], nextCursor:null }), queuedMessages: { list: () => Promise.resolve([row('q1', 1), row('q2', 2)]) } }); fireEvent.click(await recipients.findByRole('option'));
  await waitFor(() => expect(slot.container.querySelector('[data-queue-row="q2"]')).toBeTruthy());
  await waitFor(() => expect(slot.container.querySelector('[data-queue-row="q1"]')).toBeNull());
});
it('hides a queued row whose recorded message spells its mention or line break differently', async () => {
  const row = { id:'q1', threadId:'thr_one', content:[{ type:'text', text:'@thread:thr_example#msg=7', mentions:[] }, { type:'text', text:'Why twice?', mentions:[] }], createdAt:1, updatedAt:1 };
  const { slot, recipients } = setup({ list: () => ({ items:[{ ...base, id:'ans_sent', question:'@thread:thr_example#msg=7 Why twice?', questionSeq:9, createdAt:5 }], nextCursor:null }), queuedMessages: { list: () => Promise.resolve([row, { ...row, id:'q2', content:[{ type:'text', text:'Why twice?', mentions:[] }], createdAt:2 }]) } }); fireEvent.click(await recipients.findByRole('option'));
  await waitFor(() => expect(slot.container.querySelector('[data-queue-row="q2"]')).toBeTruthy());
  await waitFor(() => expect(slot.container.querySelector('[data-queue-row="q1"]')).toBeNull());
});
it('drops a queued row bb already sent: Send now answers 404 quietly and the row does not come back', async () => {
  const row = { id:'q1', threadId:'thr_one', content:[{ type:'text', text:'Already sent', mentions:[] }], createdAt:1, updatedAt:1 };
  let rows = [row];
  const sendNow = vi.fn(() => { rows = []; return Promise.reject(Object.assign(new Error('HTTP 404: Queued message not found'), { status:404 })); });
  const { slot, recipients } = setup({ queuedMessages: { list: () => Promise.resolve(rows), send:sendNow } }); fireEvent.click(await recipients.findByRole('option'));
  fireEvent.click(await slot.findByRole('button', { name:'Send queued message 1 now' }));
  await waitFor(() => expect(sendNow).toHaveBeenCalled());
  await waitFor(() => expect(slot.queryByText('Already sent')).toBeNull());
  expect(slot.queryByText(/Queued message not found/)).toBeNull();
});
it('says why a queued message is held, as bb does', async () => {
  const row = { id:'q1', threadId:'thr_one', content:[{ type:'text', text:'Held text', mentions:[] }], updatedAt:1, waitingOn:{ kind:'plugin', pluginId:'concurrency-limit', reason:'14 of 14 running on host Mac' } };
  const { slot, recipients } = setup({ queuedMessages: { list: () => Promise.resolve([row]) }, plugins: { list: async () => ({ plugins:[{ id:'concurrency-limit', name:'Concurrency limit', icon:'Gauge' }] }) } }); fireEvent.click(await recipients.findByRole('option'));
  expect(await slot.findByText('Held by Concurrency limit · 14 of 14 running on host Mac')).toBeTruthy();
});
it('shows a plugin\'s queued message with the plugin icon instead of bb\'s header and the From line', async () => {
  const row = { id:'q1', threadId:'thr_one', originPluginId:'concurrency-limit', content:[{ type:'text', text:'[bb message from plugin:concurrency-limit]\n\n`Needs attention` · 2 to review', mentions:[] }], updatedAt:1 };
  const { slot, recipients } = setup({ queuedMessages: { list: () => Promise.resolve([row]) }, plugins: { list: async () => ({ plugins:[{ id:'concurrency-limit', name:'Concurrency limit', icon:'Gauge' }] }) } }); fireEvent.click(await recipients.findByRole('option'));
  expect(await slot.findByRole('img', { name:'From Concurrency limit' })).toBeTruthy();
  const preview = slot.container.querySelector('[data-queue-row="q1"]')!;
  expect(preview.textContent).not.toContain('[bb message from');
  expect(preview.textContent).toContain('Needs attention');
  expect(preview.textContent).not.toMatch(/From\s*Concurrency limit/);
});
it('slides a queue card in once: coming back to its chat draws it in place, a new one after it left slides again', async () => {
  const first = { ...one, threadId:'thr_slide' }, two = { ...one, threadId:'thr_two', threadTitle:'Two' };
  let rows: Record<string, any[]> = { thr_slide:[{ id:'q1', threadId:'thr_slide', content:[{ type:'text', text:'Queued one', mentions:[] }], updatedAt:1 }], thr_two:[] };
  const { slot, recipients } = setup({ recipients:[first, two], queuedMessages: { list: ({ threadId }: any) => Promise.resolve(rows[threadId]), delete: async () => { rows = { ...rows, thr_slide:[] }; return {}; } } });
  const card = () => slot.getByRole('button', { name:'Toggle queued messages' }).closest('.grid') as HTMLElement;
  fireEvent.click((await recipients.findAllByRole('option'))[0]!);
  await slot.findByRole('button', { name:'Toggle queued messages' }); expect(card().className).toContain('starting:');
  fireEvent.click(recipients.getAllByRole('option')[1]!); await waitFor(() => expect(slot.queryByRole('button', { name:'Toggle queued messages' })).toBeNull());
  fireEvent.click(recipients.getAllByRole('option')[0]!);
  await slot.findByRole('button', { name:'Toggle queued messages' }); expect(card().className).not.toContain('starting:');
  // The queue empties, the card slides away; a message queued after that slides in again.
  fireEvent.click(slot.getByRole('button', { name:/^Delete/ }));
  await waitFor(() => expect(slot.queryByRole('button', { name:'Toggle queued messages' })).toBeNull(), { timeout:1000 });
  rows = { ...rows, thr_slide:[{ id:'q2', threadId:'thr_slide', content:[{ type:'text', text:'Queued one', mentions:[] }], updatedAt:2 }] };
  fireEvent.click(recipients.getAllByRole('option')[1]!); fireEvent.click(recipients.getAllByRole('option')[0]!);
  await slot.findByRole('button', { name:'Toggle queued messages' }); expect(card().className).toContain('starting:');
});
it('offers bb\'s Scroll to latest button once the last message is out of sight below, and scrolls there', async () => {
  const { slot, recipients } = setup(); fireEvent.click(await recipients.findByRole('option'));
  await slot.findByRole('list', { name:'History' }); const button = document.querySelector('[aria-label="Scroll to latest"]') as HTMLElement;
  expect(button.className).toContain('invisible');
  const view = slot.getByRole('list', { name:'History' }).closest('.overflow-auto') as HTMLElement, last = slot.getByRole('list', { name:'History' }).lastElementChild as HTMLElement;
  Object.defineProperty(view, 'clientHeight', { configurable:true, value:500 }); // a shown chat (a hidden one, 0 high, is left alone)
  Object.defineProperty(view, 'scrollHeight', { configurable:true, value:1500 }); let top = 1000; Object.defineProperty(view, 'scrollTop', { configurable:true, get:() => top, set:v => { top = v; } });
  view.getBoundingClientRect = () => ({ top:0, bottom:500 }) as DOMRect; last.getBoundingClientRect = () => ({ top:900, bottom:1000 }) as DOMRect;
  const scrollTo = vi.fn(); view.scrollTo = scrollTo as any;
  // At the very end the button stays hidden even if the last row still measures below the stack (a stack settling).
  fireEvent.scroll(view); await new Promise(r => setTimeout(r, 50)); expect(button.className).toContain('invisible');
  top = 0; fireEvent.scroll(view);
  await waitFor(() => expect(button.className).not.toContain('invisible'));
  fireEvent.click(button); expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior:'smooth' }));
  last.getBoundingClientRect = () => ({ top:300, bottom:450 }) as DOMRect; fireEvent.scroll(view);
  await waitFor(() => expect(button.className).toContain('invisible'));
});
it('moves a queued message sent now straight from the queue into the chat', async () => {
  const row = { id:'q1', threadId:'thr_one', content:[{ type:'text', text:'Steer me', mentions:[] }], updatedAt:1, sendAt:Date.now() + 3600000, state:'scheduled' };
  let rows = [row], finish = (_: unknown) => {};
  const sendNow = vi.fn(() => { rows = []; return new Promise(resolve => { finish = resolve; }); });
  const { slot, recipients } = setup({ queuedMessages: { list: () => Promise.resolve(rows), send:sendNow } }); fireEvent.click(await recipients.findByRole('option'));
  await slot.findByText('Steer me');
  fireEvent.click(slot.getByRole('button', { name:'Send queued message 1 now' }));
  // Before bb even answers, the row is gone from the queue and the message stands in the chat.
  await waitFor(() => expect(slot.queryByRole('region', { name:'Queued messages' })?.textContent ?? '').not.toContain('Steer me'));
  expect(slot.getByText('Steer me')).toBeTruthy();
  finish({ ok:true, delivery:'sent' });
  await waitFor(() => expect(sendNow).toHaveBeenCalled());
});
it('keeps a delivered queued message in the queue card until the chat records it', async () => {
  const row = { id:'q1', threadId:'thr_one', content:[{ type:'text', text:'Waiting text', mentions:[] }], updatedAt:1 };
  let rows = [row], emptied = 0;
  const sendNow = vi.fn(() => { rows = []; return Promise.resolve({}); });
  const list = () => { if (!rows.length) emptied++; return Promise.resolve(rows); };
  const { slot, recipients } = setup({ queuedMessages: { list, send:sendNow } }); fireEvent.click(await recipients.findByRole('option'));
  expect(await slot.findByText('Waiting text')).toBeTruthy();
  fireEvent.click(slot.getByRole('button', { name:'Send queued message 1 now' })); await waitFor(() => expect(emptied).toBeGreaterThan(0));
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(slot.getByText('Waiting text')).toBeTruthy();
});
it('drops a delivered bb notice from the queue card at once, as the chat never records it as a message', async () => {
  let rows: unknown[] = [{ id:'q1', threadId:'thr_one', content:[{ type:'text', text:'[bb system] raw report', mentions:[] }], systemNotice:{ kind:'child-completed', subject:{ kind:'thread', threadId:'child0', threadName:'Child 0' } }, updatedAt:1 }];
  const sendNow = vi.fn(() => { rows = []; return Promise.resolve({}); });
  const { slot, recipients } = setup({ queuedMessages: { list: () => Promise.resolve(rows), send:sendNow } }); fireEvent.click(await recipients.findByRole('option'));
  await waitFor(() => expect(slot.container.querySelector('[data-queued-message-system-notice]')).toBeTruthy());
  fireEvent.click(slot.getByRole('button', { name:'Send queued message 1 now' }));
  await waitFor(() => expect(slot.container.querySelector('[data-queued-message-system-notice]')).toBeNull());
});
it('shows bb system notice icon and text for completed and failed children', async () => {
  const rows = (['child-completed', 'child-failed'] as const).map((kind, n) => ({ id:`q${n}`, threadId:'thr_one', content:[{ type:'text', text:'[bb system] raw report', mentions:[] }], systemNotice:{ kind, subject:{ kind:'thread', threadId:`child${n}`, threadName:`Child ${n}` } }, updatedAt:1 }));
  const { slot, recipients } = setup({ queuedMessages:{ list: () => Promise.resolve(rows) } }); fireEvent.click(await recipients.findByRole('option'));
  const notices = await waitFor(() => { const nodes = slot.container.querySelectorAll('[data-queued-message-system-notice]'); expect(nodes).toHaveLength(2); return nodes; });
  expect(Array.from(notices).map(node => [node.getAttribute('title'), node.querySelector('[data-icon]')?.getAttribute('data-icon')])).toEqual([['Child 0 finished', 'CircleCheck'], ['Child 1 failed', 'CircleX']]);
  expect(slot.queryByText('[bb system] raw report')).toBeNull();
});
it('shows the thread\'s pending bb form in the bottom stack, keeping the composer and footer', async () => {
  const thread = { id:'thr_one', title:'One', projectId:'pr_one', parentThreadId:null, parentNotifications:'all', archivedAt:null, pinnedAt:null, sectionId:null, isUnread:false, status:'active', runtimeStatus:'active', queuedWork:'none', hasPendingInteraction:true, indicator:'none', activity:{ workflows:0, backgroundAgents:0, backgroundCommands:0, planMode:false }, environment:{ id:'env', path:'/x', branchName:'main' } };
  const question = { id:'i1', threadId:'thr_one', status:'pending', payload:{ kind:'user_question', questions:[{ id:'q1', prompt:'Choose?', shortLabel:'Choice', required:true, multiSelect:false, allowFreeText:false, options:[{ value:'a', label:'Alpha' }] }] } };
  const list = vi.fn(() => Promise.resolve([question]));
  const { slot, recipients } = setup({ sidebarThreads:{ threads:[thread], projects:[] }, interactions:{ list } }); fireEvent.click(await recipients.findByRole('option'));
  const composer = (await slot.findByRole('textbox', { name:'Send message' })).closest('form')!;
  expect(composer.parentElement?.hidden).toBe(false);
  expect(slot.getByText('main')).toBeTruthy();
  await waitFor(() => expect(slot.container.querySelector('[data-pending-question-card]')?.closest('[data-promptbox-shell]')).toBeTruthy());
  expect(slot.getByRole('button', { name:/Alpha/ })).toBeTruthy();
  expect(list).toHaveBeenCalledWith({ threadId:'thr_one' });
});
it('answers an open agent question of the conversation from the bottom stack, outside the history', async () => {
  const open = { ...base, id:'ans_open', kind:'for_me' as const, status:'open' as const, question:'Ship it?', answer:null, answerSeq:null, options:['Yes', 'No'], recommended:'Yes' };
  const reply = vi.fn(() => ({ ok:true, delivery:'sent' }));
  const { slot, recipients, list } = setup({ list: (input: any) => ({ items: input.view === 'for_me' ? [open] : [base], nextCursor:null }), rpc: { reply } });
  fireEvent.click(await recipients.findByRole('option'));
  const card = await slot.findByRole('region', { name:'Questions for you' });
  expect(card.closest('[data-promptbox-shell]')?.closest('[data-composer-stack]')).toBeTruthy();
  expect(within(card).getByText('Question for you')).toBeTruthy();
  expect(within(slot.getByRole('list', { name:'History' })).queryByText('Ship it?')).toBeNull();
  expect(list).toHaveBeenCalledWith(expect.objectContaining({ view:'for_me', threadId:'thr_one' }));
  fireEvent.click(within(card).getByRole('button', { name:/^Yes/ }));
  await waitFor(() => expect(reply).toHaveBeenCalledWith(expect.objectContaining({ id:'ans_open', text:'Yes' })));
  expect(slot.getByRole('textbox', { name:'Send message' })).toBeTruthy();
});
it('takes an answered question out of the stack and shows it answered in the chat before bb delivers the reply; a failed one comes back', async () => {
  const open = { ...base, id:'ans_open', kind:'for_me' as const, status:'open' as const, question:'Ship it?', answer:null, answerSeq:null, options:['Yes', 'No'] };
  let reject!: (error: Error) => void;
  const reply = vi.fn(() => new Promise((_, no) => { reject = no; }));
  const { slot, recipients } = setup({ list: (input: any) => ({ items: input.view === 'for_me' ? [open] : [base, open], nextCursor:null }), rpc: { reply } });
  fireEvent.click(await recipients.findByRole('option'));
  fireEvent.click(within(await slot.findByRole('region', { name:'Questions for you' })).getByRole('button', { name:/^Yes/ }));
  expect(slot.queryByRole('region', { name:'Questions for you' })).toBeNull();
  expect(within(slot.getByRole('list', { name:'History' })).getByText('Ship it?')).toBeTruthy();
  await act(async () => { reject(new Error('Offline')); });
  const card = await slot.findByRole('region', { name:'Questions for you' });
  expect(within(card).getByRole('alert').textContent).toContain('Offline');
  expect(within(slot.getByRole('list', { name:'History' })).queryByText('Ship it?')).toBeNull();
});
it('starts reading a contact\'s first page when the pointer goes down on it, with the input the chat then reads', async () => {
  const two = { ...one, threadId:'thr_two', threadTitle:'Two', preview:'Second preview' };
  const { recipients, list } = setup({ recipients:[one, two] });
  const row = (await recipients.findAllByRole('option'))[1]!;
  fireEvent.pointerDown(row);
  await waitFor(() => expect(list).toHaveBeenCalledWith(expect.objectContaining({ view:'all', threadId:'thr_two', order:'activity', limit:20 })));
  // The test host's reads are never fresh; bb's stay fresh for 2 s, so there the click reuses this read.
});
it('marks a contact whose thread waits for input', async () => {
  const idle = { projectId:'pr_one', parentThreadId:null, parentNotifications:'all', archivedAt:null, pinnedAt:null, sectionId:null, isUnread:false, status:'idle', runtimeStatus:'idle', queuedWork:'none', hasPendingInteraction:true, indicator:'none', activity:{ workflows:0, backgroundAgents:0, backgroundCommands:0, planMode:false }, environment:{ id:'env', path:'/x' } };
  const two = { ...one, threadId:'thr_two', threadTitle:'Two' };
  const { recipients } = setup({ recipients:[one, two], sidebarThreads:{ threads:[{ ...idle, id:'thr_one', title:'One' }, { ...idle, id:'thr_two', title:'Two', hasPendingInteraction:false }], projects:[] }, interactions:{ list: () => Promise.resolve([]) } });
  const [first, second] = await recipients.findAllByRole('option');
  expect(within(first!).getByLabelText('Needs input').getAttribute('data-icon')).toBe('CircleQuestion');
  expect(within(second!).queryByLabelText('Needs input')).toBeNull();
});
it('renews the edit hold lease while the queued message is being edited', async () => {
  const row = { id:'q1', threadId:'thr_one', content:[{ type:'text', text:'Waiting text', mentions:[] }], updatedAt:7 };
  const hold = vi.fn(() => Promise.resolve({ leaseMs:200 }));
  const { slot, recipients } = setup({ queuedMessages: { list: () => Promise.resolve([row]), experimental_holdForEdit:hold, experimental_releaseEditHold: () => Promise.resolve({}) } }); fireEvent.click(await recipients.findByRole('option'));
  fireEvent.click(await slot.findByRole('button', { name:'Edit queued message 1' }));
  await slot.findByRole('textbox', { name:'Edit queued message' });
  await waitFor(() => expect(hold.mock.calls.length).toBeGreaterThanOrEqual(3));
});
it('edits queued text and attachments through the composer, holding it while edited', async () => {
  const row = { id:'q1', threadId:'thr_one', content:[{ type:'text', text:'Waiting text', mentions:[] }, { type:'localFile', path:'/old', name:'old.txt' }], model:'opus', reasoningLevel:'high', serviceTier:'default', permissionMode:'auto', updatedAt:7 };
  const hold = vi.fn(() => Promise.resolve({})), update = vi.fn(() => Promise.resolve({})), release = vi.fn(() => Promise.resolve({}));
  const { slot, recipients } = setup({ sidebarThreads: { threads:[{ id:'thr_one', title:'One', projectId:'pr_one', providerId:'provider_example', status:'idle', activity:{ workflows:0, backgroundAgents:0, backgroundCommands:0, planMode:false } }], projects:[] }, queuedMessages: { list: () => Promise.resolve([row]), experimental_holdForEdit:hold, update, experimental_releaseEditHold:release } }); fireEvent.click(await recipients.findByRole('option'));
  fireEvent.click(await slot.findByRole('button', { name:'Edit queued message 1' }));
  const editor = await slot.findByRole('textbox', { name:'Edit queued message' });
  expect(hold).toHaveBeenCalledWith({ threadId:'thr_one', queuedMessageId:'q1' });
  expect(slot.getByText('old.txt')).toBeTruthy();
  // The thread's permission mode is chosen in the main composer; the queued editor keeps the row's own.
  expect(editor.closest('[data-queued-message-inline-editor]')!.querySelector('[data-permission-picker]')).toBeNull();
  change(editor, { target:{ value:'Changed text' } }); fireEvent.click(slot.getByRole('button', { name:'Remove old.txt' })); fireEvent.click(slot.getByRole('button', { name:'Confirm queued message edit' }));
  await waitFor(() => expect(update).toHaveBeenCalledWith({ threadId:'thr_one', queuedMessageId:'q1', expectedUpdatedAt:7, model:'opus', reasoningLevel:'high', serviceTier:'default', permissionMode:'auto', input:[{ type:'text', text:'Changed text', mentions:[] }] }));
  await waitFor(() => expect(release).toHaveBeenCalledWith({ threadId:'thr_one', queuedMessageId:'q1' }));
  fireEvent.click(slot.getByRole('button', { name:'Edit queued message 1' })); fireEvent.keyDown(await slot.findByRole('textbox', { name:'Edit queued message' }), { key:'Escape' });
  await waitFor(() => expect(release).toHaveBeenCalledTimes(2)); expect(update).toHaveBeenCalledTimes(1);
});
it('edits a queued quote reply with the quote as a bar and only the note in the editor, keeping the quote on save', async () => {
  const row = { id:'q1', threadId:'thr_one', content:[{ type:'text', text:'> Quoted line\n> second\n\nMy note', mentions:[] }], model:'opus', reasoningLevel:'high', serviceTier:'default', permissionMode:'auto', updatedAt:7 };
  const update = vi.fn(() => Promise.resolve({}));
  const { slot, recipients } = setup({ queuedMessages: { list: () => Promise.resolve([row]), experimental_holdForEdit: () => Promise.resolve({}), update, experimental_releaseEditHold: () => Promise.resolve({}) } }); fireEvent.click(await recipients.findByRole('option'));
  fireEvent.click(await slot.findByRole('button', { name:'Edit queued message 1' }));
  const editor = await slot.findByRole('textbox', { name:'Edit queued message' });
  expect(editor.textContent).toBe('My note'); expect(slot.getByText(/Quoted line/)).toBeTruthy();
  change(editor, { target:{ value:'New note' } }); fireEvent.click(slot.getByRole('button', { name:'Confirm queued message edit' }));
  await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ input:[expect.objectContaining({ type:'text', text:'> Quoted line\n> second\n\nNew note' })] })));
});
it('shows attachment count without a raw queue state', async () => {
  const row = { id:'q1', threadId:'thr_one', content:[{ type:'text', text:'Attached', mentions:[] }, { type:'localFile', path:'/one', name:'one.txt' }, { type:'localImage', path:'/two' }], state:'waiting', updatedAt:7 };
  const { slot, recipients } = setup({ queuedMessages:{ list: () => Promise.resolve([row]) } }); fireEvent.click(await recipients.findByRole('option'));
  expect(await slot.findByLabelText('2 attachments')).toBeTruthy();
  expect(slot.queryByText('waiting')).toBeNull();
});
it('collapses the queue and remembers the choice', async () => {
  const row = { id:'q1', threadId:'thr_one', content:[{ type:'text', text:'Waiting text', mentions:[] }], updatedAt:7 };
  const { slot, recipients } = setup({ queuedMessages:{ list: () => Promise.resolve([row]) } }); fireEvent.click(await recipients.findByRole('option'));
  expect(await slot.findByText('Waiting text')).toBeTruthy();
  fireEvent.click(slot.getByRole('button', { name:'Collapse queued messages' }));
  expect(slot.queryByText('Waiting text')).toBeNull();
  await waitFor(() => expect(localStorage.getItem('bb-plugin-answers:page:queue-collapsed')).toBe('true'));
  fireEvent.click(slot.getByRole('button', { name:'Toggle queued messages' }));
  expect(await slot.findByText('Waiting text')).toBeTruthy();
  await waitFor(() => expect(localStorage.getItem('bb-plugin-answers:page:queue-collapsed')).toBe('false'));
});
it('shows the scheduled time and changes it through the SDK', async () => {
  const row = { id:'q1', threadId:'thr_one', content:[{ type:'text', text:'Later text', mentions:[] }], updatedAt:7, sendAt:Date.now() + 2 * 86400000, state:'scheduled' };
  const update = vi.fn(() => Promise.resolve({}));
  const { slot, recipients } = setup({ queuedMessages:{ list: () => Promise.resolve([row]), update } }); fireEvent.click(await recipients.findByRole('option'));
  expect(await slot.findByText(/Scheduled for/)).toBeTruthy(); expect(slot.getByText(/in 2d/)).toBeTruthy();
  fireEvent.click(slot.getByRole('button', { name:'Change when queued message 1 sends' }));
  const was = new Date(row.sendAt - new Date(row.sendAt).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  expect((slot.getByLabelText('Send at') as HTMLInputElement).value).toBe(was);
  expect(slot.getByLabelText('Send at').closest('section[aria-label="Queued messages"]')).toBeNull();
  const at = new Date(Date.now() + 3 * 86400000); at.setSeconds(0, 0);
  const local = new Date(at.getTime() - at.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  change(slot.getByLabelText('Send at'), { target:{ value:local } }); fireEvent.click(slot.getByRole('button', { name:'Schedule' }));
  await waitFor(() => expect(update).toHaveBeenCalledWith({ threadId:'thr_one', queuedMessageId:'q1', expectedUpdatedAt:7, sendAt:at.getTime() }));
});
it('reorders queued messages with keyboard neighbours', async () => {
  const rows = ['q1','q2','q3'].map(id => ({ id, threadId:'thr_one', content:[{ type:'text', text:id, mentions:[] }], updatedAt:7 }));
  const reorder = vi.fn(() => Promise.resolve(rows));
  const { slot, recipients } = setup({ queuedMessages:{ list: () => Promise.resolve(rows), reorder } }); fireEvent.click(await recipients.findByRole('option'));
  fireEvent.keyDown(await slot.findByRole('button', { name:'Reorder queued message 2' }), { key:'ArrowUp' });
  await waitFor(() => expect(reorder).toHaveBeenCalledWith({ threadId:'thr_one', queuedMessageId:'q2', previousQueuedMessageId:null, nextQueuedMessageId:'q1' }));
  fireEvent.keyDown(slot.getByRole('button', { name:'Reorder queued message 2' }), { key:'ArrowDown' });
  await waitFor(() => expect(reorder).toHaveBeenCalledWith({ threadId:'thr_one', queuedMessageId:'q2', previousQueuedMessageId:'q3', nextQueuedMessageId:null }));
});
it('lines scheduled messages up by send time and asks before moving one in time', async () => {
  const at = (minutes: number) => { const d = new Date(Date.now() + minutes * 60000); d.setSeconds(0, 0); return d.getTime(); };
  const row = (id: string, sendAt?: number) => ({ id, threadId:'thr_one', content:[{ type:'text', text:id, mentions:[] }], updatedAt:7, ...(sendAt ? { sendAt, state:'scheduled' } : {}) });
  const rows: any[] = [row('late', at(60)), row('now'), row('soon', at(30))];
  const update = vi.fn(({ queuedMessageId, sendAt }: any) => { rows.find(item => item.id === queuedMessageId).sendAt = sendAt; return Promise.resolve({}); }), reorder = vi.fn(() => Promise.resolve(rows));
  const { slot, recipients } = setup({ queuedMessages:{ list: () => Promise.resolve(rows.map(item => ({ ...item }))), update, reorder } }); fireEvent.click(await recipients.findByRole('option'));
  await slot.findByText('late');
  const order = () => Array.from(slot.container.querySelectorAll('[aria-label^="Reorder queued message"]')).map(handle => handle.closest('li')!.textContent!.match(/now|soon|late/)![0]);
  expect(order()).toEqual(['now', 'soon', 'late']);
  fireEvent.keyDown(slot.getByRole('button', { name:'Reorder queued message 3' }), { key:'ArrowUp' });
  const dialog = await slot.findByRole('dialog', { name:'Change send time' });
  // While the owner decides, the dropped row stays lifted at its drop place; Cancel lets it go back.
  expect(order()).toEqual(['now', 'late', 'soon']); expect(slot.container.querySelector('[data-lifted]')?.textContent).toContain('late');
  // The queue list clips its rows, so the popover lives outside it.
  expect(dialog.closest('section[aria-label="Queued messages"]')).toBeNull();
  fireEvent.click(within(dialog).getByRole('button', { name:'Cancel' }));
  expect(slot.queryByRole('dialog', { name:'Change send time' })).toBeNull(); expect(update).not.toHaveBeenCalled(); expect(reorder).not.toHaveBeenCalled();
  expect(order()).toEqual(['now', 'soon', 'late']); expect(slot.container.querySelector('[data-lifted]')).toBeNull();
  // 'late' moved above 'soon' leads it now: the default lands 3 minutes before, the menu offers more.
  fireEvent.keyDown(slot.getByRole('button', { name:'Reorder queued message 3' }), { key:'ArrowUp' });
  const moved = await slot.findByRole('dialog', { name:'Change send time' });
  // Labels say how far 'late' itself moves: from 60 minutes out to 27 is −33 min.
  expect(within(moved).getByRole('button', { name:/^Yes/ }).textContent).toContain('−33 min');
  fireEvent.click(within(moved).getByRole('button', { name:'Other send times' }));
  fireEvent.click(slot.getByRole('menuitem', { name:/−40 min/ }));
  await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ queuedMessageId:'late', sendAt:at(30) - 10 * 60000 })));
  // The held row settles once its new time arrives (the next step reads that time).
  await waitFor(() => expect(slot.getByText('late').closest('li')!.textContent).toContain('in 20m'));
  expect(order()).toEqual(['now', 'late', 'soon']);
  // An unscheduled message dropped below a scheduled one gets a time after it.
  fireEvent.keyDown(slot.getByRole('button', { name:'Reorder queued message 1' }), { key:'ArrowDown' });
  fireEvent.click(within(await slot.findByRole('dialog', { name:'Change send time' })).getByRole('button', { name:/^Yes/ }));
  await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ queuedMessageId:'now', sendAt:at(20) + 3 * 60000 })));
  expect(reorder).not.toHaveBeenCalled();
});
it('keeps a moved message between its new neighbours when they are closer than three minutes', async () => {
  const minute = (n: number) => { const d = new Date(Date.now() + n * 60000); d.setSeconds(0, 0); return d.getTime(); };
  const row = (id: string, sendAt: number) => ({ id, threadId:'thr_one', content:[{ type:'text', text:id, mentions:[] }], updatedAt:7, sendAt, state:'scheduled' });
  const rows = [row('a', minute(30)), row('b', minute(33)), row('c', minute(40))];
  const update = vi.fn(() => Promise.resolve({}));
  const { slot, recipients } = setup({ queuedMessages:{ list: () => Promise.resolve(rows), update } }); fireEvent.click(await recipients.findByRole('option'));
  fireEvent.keyDown(await slot.findByRole('button', { name:'Reorder queued message 3' }), { key:'ArrowUp' });
  const yes = within(await slot.findByRole('dialog', { name:'Change send time' })).getByRole('button', { name:/^Yes/ });
  expect(yes.textContent).toContain('−9 min');
  fireEvent.click(yes);
  await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  const sendAt = (update.mock.calls[0] as any)[0].sendAt;
  expect(sendAt).toBeGreaterThan(minute(30)); expect(sendAt).toBeLessThan(minute(33));
});
it('moves a message ahead of one due within minutes to halfway there', async () => {
  const soon = Date.now() + 2 * 60000, late = Date.now() + 60 * 60000;
  const rows = [{ id:'soon', threadId:'thr_one', content:[{ type:'text', text:'soon', mentions:[] }], updatedAt:7, sendAt:soon, state:'scheduled' }, { id:'late', threadId:'thr_one', content:[{ type:'text', text:'late', mentions:[] }], updatedAt:7, sendAt:late, state:'scheduled' }];
  const update = vi.fn(() => Promise.resolve({}));
  const { slot, recipients } = setup({ queuedMessages:{ list: () => Promise.resolve(rows), update } }); fireEvent.click(await recipients.findByRole('option'));
  fireEvent.keyDown(await slot.findByRole('button', { name:'Reorder queued message 2' }), { key:'ArrowUp' });
  const dialog = await slot.findByRole('dialog', { name:'Change send time' });
  expect(within(dialog).queryByRole('button', { name:'Other send times' })).toBeNull();
  fireEvent.click(within(dialog).getByRole('button', { name:/^Yes/ }));
  await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  const sendAt = (update.mock.calls[0] as any)[0].sendAt;
  expect(sendAt).toBeGreaterThan(Date.now()); expect(sendAt).toBeLessThan(soon);
});
it('shows sidebar project, worktree branch, and context remaining', async () => {
  const thread = { id:'thr_one', projectId:'pr_one', environment:{ name:'Checkout', branchName:'answers/3g', isWorktree:true }, parentThreadId:null, parentNotifications:'all', archivedAt:null, pinnedAt:null, sectionId:null, isUnread:false, status:'idle', runtimeStatus:'idle', queuedWork:'none', hasPendingInteraction:false, indicator:'none', activity:{ workflows:0, backgroundAgents:0, backgroundCommands:0, planMode:false } };
  const { slot, recipients } = setup({ sidebarThreads:{ threads:[thread], projects:[{ id:'pr_one', name:'Plugins' }] }, context: () => Promise.resolve({ usage:{ usedTokens:380, modelContextWindow:1000, estimated:false } }) }); fireEvent.click(await recipients.findByRole('option'));
  expect(await slot.findByText('Plugins')).toBeTruthy(); expect(slot.getByText('answers/3g').parentElement!.getAttribute('title')).toBe('Worktree'); fireEvent.click(await slot.findByRole('button', { name:'Context window 38% used' })); expect(slot.getByRole('dialog', { name:'Context window' }).textContent).toContain('62% left');
});

it('keeps the context ring through a failed read or one without usage', async () => {
  let visible = true;
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible ? 'visible' : 'hidden');
  const context = vi.fn(async () => ({ usage:{ usedTokens:380, modelContextWindow:1000, estimated:false } }) as any);
  const thread = { id:'thr_one', projectId:'pr_one', parentThreadId:null, parentNotifications:'all', archivedAt:null, pinnedAt:null, sectionId:null, isUnread:false, status:'idle', runtimeStatus:'idle', queuedWork:'none', hasPendingInteraction:false, indicator:'none', activity:{ workflows:0, backgroundAgents:0, backgroundCommands:0, planMode:false } };
  const { slot, recipients } = setup({ context, sidebarThreads:{ threads:[thread], projects:[] } }); fireEvent.click(await recipients.findByRole('option'));
  expect(await slot.findByRole('button', { name:'Context window 38% used' })).toBeTruthy();
  const reread = async (answer: () => Promise<any>) => { context.mockImplementationOnce(answer); visible = false; act(() => { document.dispatchEvent(new Event('visibilitychange')); }); visible = true; act(() => { document.dispatchEvent(new Event('visibilitychange')); }); await waitFor(() => expect(context.mock.results.at(-1)?.type).toBe('return')); await act(async () => { await Promise.resolve(); }); };
  const calls = context.mock.calls.length;
  await reread(async () => { throw new Error('busy'); });
  await reread(async () => ({ usage:null }));
  expect(context.mock.calls.length).toBe(calls + 2);
  expect(slot.getByRole('button', { name:'Context window 38% used' })).toBeTruthy();
});
it('winds the context ring down to 0 after a compaction instead of dropping it', async () => {
  let compactedAt: number | null = null;
  const context = vi.fn(async () => ({ usage:{ usedTokens:380, modelContextWindow:1000, estimated:false } }) as any);
  const thread = { id:'thr_one', projectId:'pr_one', parentThreadId:null, parentNotifications:'all', archivedAt:null, pinnedAt:null, sectionId:null, isUnread:false, status:'idle', runtimeStatus:'idle', queuedWork:'none', hasPendingInteraction:false, indicator:'none', activity:{ workflows:0, backgroundAgents:0, backgroundCommands:0, planMode:false } };
  const { slot, recipients } = setup({ context, rpc: { contextStamp: () => ({ stamp: compactedAt ? 1 : 0, compactedAt }) }, sidebarThreads:{ threads:[thread], projects:[] } }); fireEvent.click(await recipients.findByRole('option'));
  expect(await slot.findByRole('button', { name:'Context window 38% used' })).toBeTruthy();
  context.mockImplementation(async () => ({ usage:null }));
  compactedAt = Date.now() + 1000;
  await act(async () => { await slot.behavior.experimental_invalidateRpc(['answers:context']); });
  expect(await slot.findByRole('button', { name:'Context window 0% used' })).toBeTruthy();
});
it('pauses queue and context polling while hidden and refetches when visible', async () => {
  let visible = true;
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible ? 'visible' : 'hidden');
  const queue = vi.fn(async () => [{ id:'q1', threadId:'thr_one', content:[], sendAt:null, updatedAt:1 }]);
  const context = vi.fn(async () => ({ usage:null }));
  const thread = { id:'thr_one', projectId:'pr_one', parentThreadId:null, parentNotifications:'all', archivedAt:null, pinnedAt:null, sectionId:null, isUnread:false, status:'active', runtimeStatus:'active', queuedWork:'none', hasPendingInteraction:false, indicator:'runtime', activity:{ workflows:0, backgroundAgents:0, backgroundCommands:0, planMode:false } };
  const { slot, recipients } = setup({ queuedMessages:{ list:queue }, context, sidebarThreads:{ threads:[thread], projects:[] } });
  fireEvent.click(await recipients.findByRole('option'));
  await waitFor(() => expect(queue).toHaveBeenCalledOnce());
  await waitFor(() => expect(context).toHaveBeenCalledOnce());
  vi.useFakeTimers();
  try {
    act(() => { visible = false; document.dispatchEvent(new Event('visibilitychange')); });
    await act(async () => { vi.advanceTimersByTime(60000); });
    expect(queue).toHaveBeenCalledOnce(); expect(context).toHaveBeenCalledOnce();
    act(() => { visible = true; document.dispatchEvent(new Event('visibilitychange')); });
    await act(async () => {});
    expect(queue).toHaveBeenCalledTimes(2); expect(context).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); slot.unmount(); }
});

it('follows new content at the bottom to its end, a long reply too', () => {
  // View 600 tall; the content was 2000 tall with the reader at the bottom.
  expect(followTo(1400, 2100, 600)).toBe(1500); // a short arrival: back to the bottom
  expect(followTo(1400, 4000, 600)).toBe(3400); // a long reply: to its end
  expect(followTo(1400, 2000, 500)).toBe(1500); // the view shrank (keyboard): the bottom edge is kept
});
it('offers Stop only while the chat’s own turn runs, not for its background work', async () => {
  const idle = { id:'thr_one', projectId:'pr_one', parentThreadId:null, parentNotifications:'all', archivedAt:null, pinnedAt:null, sectionId:null, isUnread:false, status:'idle', runtimeStatus:'idle', queuedWork:'none', hasPendingInteraction:false, indicator:'background-command', activity:{ workflows:0, backgroundAgents:0, backgroundCommands:1, planMode:0 } };
  const first = setup({ sidebarThreads:{ threads:[idle], projects:[] } });
  fireEvent.click(await first.recipients.findByRole('option'));
  await first.slot.findByRole('button', { name:'Send message' });
  expect(first.slot.queryByRole('button', { name:'Stop' })).toBeNull();
  first.slot.unmount();
  const second = setup({ sidebarThreads:{ threads:[{ ...idle, status:'active', runtimeStatus:'active', indicator:'runtime' }], projects:[] } });
  fireEvent.click(await second.recipients.findByRole('option'));
  expect(await second.slot.findByRole('button', { name:'Stop' })).toBeTruthy();
});

it('keeps settled older pages without refetching them on item invalidation', async () => {
  const { slot, recipients, list } = setup({ list: input => input.cursor ? { items:[{ ...base, id:'ans_old', question:'Old question' }], nextCursor:null } : { items:[base], nextCursor:'1|ans_one' } });
  fireEvent.click(await recipients.findByRole('option'));
  fireEvent.click(await slot.findByRole('button', { name:'Load earlier' }));
  await slot.findByText('Old question');
  const olderCalls = () => list.mock.calls.filter(([input]) => input.cursor === '1|ans_one').length;
  expect(olderCalls()).toBe(1);
  await act(async () => { await slot.behavior.experimental_invalidateRpc(['answers:items']); });
  expect(olderCalls()).toBe(1);
  expect(slot.getByText('Old question')).toBeTruthy();
});

it('never polls provider usage', async () => {
  const usageLimits = vi.fn(async () => ({}));
  const slot = renderSlot({ component: Inbox }, {}, { rpc: { recipients: () => ({ recipients:[one] }), list: () => ({ items:[], nextCursor:null }) }, sdk: { system:{ usageLimits } } } as any);
  await slot.findByRole('listbox', { name:'Recipients' });
  vi.useFakeTimers();
  try { await act(async () => { vi.advanceTimersByTime(600000); }); expect(usageLimits).not.toHaveBeenCalled(); }
  finally { vi.useRealTimers(); slot.unmount(); }
});
it('does not re-render the history cards while typing in the composer or when the sidebar updates', async () => {
  const items = ['one', 'two', 'three'].map((name, i) => ({ ...base, id:`ans_${name}`, question:`Question ${name}`, answer:`Answer ${name}`, createdAt:1000 + i, answeredAt:1000 + i }));
  const { slot, recipients } = setup({ list: () => ({ items, nextCursor:null }) }); fireEvent.click(await recipients.findByRole('option'));
  await slot.findByText('Answer three'); await waitFor(() => expect(slot.getAllByRole('textbox', { name:'Send message' })).toHaveLength(1));
  const editor = slot.getByRole('textbox', { name:'Send message' });
  await act(async () => { await new Promise(done => setTimeout(done, 50)); });
  const settled = cards.renders; expect(settled).toBeGreaterThanOrEqual(3);
  for (const value of ['H', 'He', 'Hel', 'Hell', 'Hello']) change(editor, { target:{ value } });
  await waitFor(() => expect(localStorage.getItem('bb-plugin-answers:page:compose') ?? '').toContain('Hello'));
  expect(cards.renders).toBe(settled);
});
it('polls the queue every 5 s while a row is scheduled, else every 30 s', async () => {
  let visible = true;
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible ? 'visible' : 'hidden');
  const draft: any = { id:'q1', threadId:'thr_one', content:[], sendAt:null, updatedAt:1 };
  const queue = vi.fn(async () => [draft]);
  const thread = { id:'thr_one', projectId:'pr_one', parentThreadId:null, parentNotifications:'all', archivedAt:null, pinnedAt:null, sectionId:null, isUnread:false, status:'active', runtimeStatus:'active', queuedWork:'none', hasPendingInteraction:false, indicator:'runtime', activity:{ workflows:0, backgroundAgents:0, backgroundCommands:0, planMode:false } };
  const { slot, recipients } = setup({ queuedMessages:{ list:queue }, sidebarThreads:{ threads:[thread], projects:[] } });
  fireEvent.click(await recipients.findByRole('option'));
  await waitFor(() => expect(queue).toHaveBeenCalledOnce());
  vi.useFakeTimers();
  try {
    // Toggling visibility re-runs the queue effects under fake timers, so any poll they start is controlled here.
    act(() => { visible = false; document.dispatchEvent(new Event('visibilitychange')); });
    act(() => { visible = true; document.dispatchEvent(new Event('visibilitychange')); });
    await act(async () => {}); await act(async () => {});
    const idle = queue.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(29000); });
    expect(queue.mock.calls.length).toBe(idle);
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(queue.mock.calls.length).toBe(idle + 1);
    queue.mockImplementation(async () => [{ ...draft, sendAt: Date.now() + 600000 }]);
    act(() => { visible = false; document.dispatchEvent(new Event('visibilitychange')); });
    act(() => { visible = true; document.dispatchEvent(new Event('visibilitychange')); });
    await act(async () => {}); await act(async () => {});
    const scheduled = queue.mock.calls.length;
    for (let tick = 0; tick < 3; tick++) await act(async () => { vi.advanceTimersByTime(5000); });
    expect(queue.mock.calls.length - scheduled).toBe(3);
  } finally { vi.useRealTimers(); slot.unmount(); }
});
it('refetches only the recipients when a thread is read in bb', async () => {
  const thread = { id:'thr_one', projectId:'pr_one', parentThreadId:null, parentNotifications:'all', archivedAt:null, pinnedAt:null, sectionId:null, isUnread:false, status:'idle', runtimeStatus:'idle', queuedWork:'none', hasPendingInteraction:false, indicator:'none', activity:{ workflows:0, backgroundAgents:0, backgroundCommands:0, planMode:false } };
  const recipientsRpc = vi.fn(() => ({ recipients: [one] }));
  const { slot, recipients, list } = setup({ rpc: { recipients: recipientsRpc }, sidebarThreads: { threads:[thread], projects:[] } });
  fireEvent.click(await recipients.findByRole('option'));
  await waitFor(() => expect(list).toHaveBeenCalled());
  const beforeRecipients = recipientsRpc.mock.calls.length, beforeList = list.mock.calls.length;
  try {
    sidebarOverride.threads = [{ ...thread, isUnread: true }];
    slot.rerender(<Inbox />);
    await waitFor(() => expect(recipientsRpc.mock.calls.length).toBe(beforeRecipients + 1));
    expect(list).toHaveBeenCalledTimes(beforeList);
  } finally { sidebarOverride.threads = undefined; }
});
it('marks an open thread read without re-fetching what the server invalidation already refreshes', async () => {
  const markThreadRead = vi.fn(() => ({ ok: true, batch: null, count: 0 })), onBulkRead = vi.fn();
  const recipientsRpc = vi.fn(() => ({ recipients: [one] }));
  // Inbox calls markThreadRead only when a host passes onBulkRead, as the Answers panel does.
  const { recipients, list } = setup({ props: { onBulkRead }, rpc: { markThreadRead, recipients: recipientsRpc } });
  fireEvent.click(await recipients.findByRole('option'));
  await waitFor(() => expect(list).toHaveBeenCalled());
  const beforeList = list.mock.calls.length, beforeRecipients = recipientsRpc.mock.calls.length;
  fireEvent.click(recipients.getByRole('option'));
  await waitFor(() => expect(markThreadRead).toHaveBeenCalledWith({ threadId: 'thr_one' }));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(list).toHaveBeenCalledTimes(beforeList); expect(recipientsRpc).toHaveBeenCalledTimes(beforeRecipients);
});
it('keeps only the 50 most recently edited non-empty drafts', async () => {
  const drafts = Object.fromEntries(Array.from({ length: 55 }, (_, i) => [`thr_${i}`, { text: `Draft ${i}`, files: [] }]));
  localStorage.setItem('bb-plugin-answers:page:compose', JSON.stringify({ ...drafts, thr_empty: { text: '', files: [] } }));
  setup();
  const saved = JSON.parse(localStorage.getItem('bb-plugin-answers:page:compose') ?? '{}');
  expect(Object.keys(saved)).toHaveLength(50);
  expect(saved).toHaveProperty('thr_54'); expect(saved).not.toHaveProperty('thr_4'); expect(saved).not.toHaveProperty('thr_empty');
});

it('groups a waiting question with the steers its turn took into one card', () => {
  const waiting = { ...base, status:'waiting' as const, turnId:'t1', answer:null, answerSeq:null };
  const groups = groupItems([waiting, { ...waiting, id:'ans_two', questionSeq:3 }, { ...waiting, id:'ans_three', turnId:'t2', questionSeq:5 }]);
  expect(groups.map(group => group.map(item => item.id))).toEqual([['ans_one', 'ans_two'], ['ans_three']]);
});
it('quotes another thread\'s message under its caption while the turn works on it', async () => {
  const update = { ...base, id:'ans_tell', kind:'update' as const, status:'waiting' as const, question:'[bb message from thread:thr_m] Task from the owner', questionSeq:null, answer:null, answerSeq:null, trigger:{ kind:'agent' as const, sourceId:'thr_m', sourceTitle:'Manager' } };
  const { slot, recipients } = setup({ list: () => ({ items:[update], nextCursor:null }) });
  fireEvent.click(await recipients.findByRole('option'));
  const quote = await waitFor(() => { const node = document.querySelector('[data-history-ids="ans_tell"] [data-agent-message]'); expect(node).toBeTruthy(); return node as HTMLElement; });
  expect(quote.textContent).toBe('Task from the owner');
  // Dimmed like the other robots, never at full strength.
  expect(slot.getByLabelText('Working on the message').closest('.opacity-60')).toBeTruthy();
});

it('shows owed answers, collapses, jumps and confirms answered', async () => {
  const old = { ...base, id:'ans_old', status:'deferred' as const, question:'Older **question**', answer:null, interim:'Working', createdAt:Date.now()-3600000 };
  let owed = [{id:old.id,question:old.question,createdAt:old.createdAt,interim:true}];
  const settleOwed = vi.fn(() => { owed=[]; return {ok:true}; });
  const {slot,recipients} = setup({list:()=>({items:[base,old],nextCursor:null}),rpc:{owed:()=>({items:owed}),settleOwed}});
  fireEvent.click(await recipients.findByRole('option'));
  const card = within(await slot.findByRole('region',{name:'Answers owed'}));
  expect(card.getByText('1 answer owed')).toBeTruthy(); expect(card.getByText('1h')).toBeTruthy(); expect(card.getByText('Older question')).toBeTruthy();
  fireEvent.click(card.getByRole('button',{name:'Toggle answers owed'})); expect(card.queryByRole('button',{name:'Jump'})).toBeNull();
  fireEvent.click(card.getByRole('button',{name:'Toggle answers owed'}));
  fireEvent.click(card.getByRole('button',{name:'Jump'}));
  await waitFor(()=>expect(document.querySelector('[data-history-ids~="ans_old"]')?.hasAttribute('data-flash')).toBe(true));
  fireEvent.click(card.getByRole('button',{name:'Answered'}));
  await waitFor(()=>expect(settleOwed).toHaveBeenCalledWith({id:'ans_old',action:'answered'}));
  await waitFor(()=>expect(slot.queryByRole('region',{name:'Answers owed'})).toBeNull());
});
it('holds the owed card back while the chat or its background work still runs', async () => {
  const thread = { id:'thr_one', projectId:'pr_one', parentThreadId:null, parentNotifications:'all', archivedAt:null, pinnedAt:null, sectionId:null, isUnread:false, status:'idle', runtimeStatus:'idle', queuedWork:'none', hasPendingInteraction:false, indicator:'background-command', activity:{ workflows:0, backgroundAgents:0, backgroundCommands:1, planMode:0 } };
  const owed = { owed:()=>({items:[{id:'ans_old',question:'Older',createdAt:Date.now()-3600000,interim:true}]}) };
  const first = setup({list:()=>({items:[base],nextCursor:null}),rpc:owed,sidebarThreads:{threads:[thread],projects:[]}});
  fireEvent.click(await first.recipients.findByRole('option')); await first.slot.findByRole('button',{name:'Send message'});
  expect(first.slot.queryByRole('region',{name:'Answers owed'})).toBeNull();
  first.slot.unmount();
  const second = setup({list:()=>({items:[base],nextCursor:null}),rpc:owed,sidebarThreads:{threads:[{...thread,indicator:'none',activity:{...thread.activity,backgroundCommands:0}}],projects:[]}});
  fireEvent.click(await second.recipients.findByRole('option'));
  expect(await second.slot.findByRole('region',{name:'Answers owed'})).toBeTruthy();
});
it('dismisses owed rows and excludes the newest card already showing its robot', async () => {
  const latest = {...base,status:'deferred' as const,answer:null,interim:'Working'};
  const rows=[{id:'ans_old',question:'Older',createdAt:Date.now(),interim:false},{id:base.id,question:base.question,createdAt:base.createdAt,interim:true}];
  const settleOwed=vi.fn(()=>({ok:true}));
  const {slot,recipients}=setup({list:()=>({items:[latest],nextCursor:null}),rpc:{owed:()=>({items:rows}),settleOwed}});
  fireEvent.click(await recipients.findByRole('option')); await slot.findByText('Working');
  const card=within(await slot.findByRole('region',{name:'Answers owed'}));
  await waitFor(()=>expect(card.getByText('1 answer owed')).toBeTruthy());
  expect(card.queryByText(base.question)).toBeNull();
  fireEvent.click(card.getByRole('button',{name:'Dismiss'}));
  await waitFor(()=>expect(settleOwed).toHaveBeenCalledWith({id:'ans_old',action:'dismissed'}));
});

it('keeps the newest deferred question visible when it has no interim robot', async () => {
  const latest = {...base,status:'deferred' as const,answer:null,interim:null};
  const {slot,recipients}=setup({list:()=>({items:[latest],nextCursor:null}),rpc:{owed:()=>({items:[{id:base.id,question:base.question,createdAt:base.createdAt,interim:false}]})}});
  fireEvent.click(await recipients.findByRole('option'));
  const card=within(await slot.findByRole('region',{name:'Answers owed'}));
  expect(card.getByText('1 answer owed')).toBeTruthy();
  expect(card.getByRole('button',{name:'Jump'})).toBeTruthy();
});

it('keeps a newly revealed history row mounted on subsequent renders', () => {
  const onJump = () => {}, first = { group: [base] };
  const slot = renderSlot({ component: History }, { groups: [first], flash: null, markId: null, settled: true, onJump });
  const added = { group: [{ ...base, id: 'ans_reveal', kind: 'for_me' as const, question: 'New agent question' }] };
  slot.rerender(<History groups={[first, added]} flash={null} markId={null} settled onJump={onJump} />);
  const row = slot.container.querySelector('[data-history-ids="ans_reveal"]');
  expect(row).toBeTruthy();
  slot.rerender(<History groups={[first, added]} flash="ans_reveal" markId={null} settled onJump={onJump} />);
  expect(slot.container.querySelector('[data-history-ids="ans_reveal"]')).toBe(row);
});

it('does not slide in a switched chat\'s rows while the previous chat\'s rows are still shown at mount', () => {
  const onJump = () => {}, slid = (slot: ReturnType<typeof renderSlot>) => slot.container.querySelectorAll('.starting\\:translate-y-full').length;
  const old = { group: [{ ...base, kind: 'update' as const, id: 'ans_old' }] }, mine = (id: string) => ({ group: [{ ...base, kind: 'update' as const, id, threadId: 'thr_two' }] });
  const slot = renderSlot({ component: History }, { threadId: 'thr_two', groups: [old], flash: null, markId: null, settled: true, onJump });
  slot.rerender(<History threadId="thr_two" groups={[mine('ans_a'), mine('ans_b')]} flash={null} markId={null} settled onJump={onJump} />);
  expect(slid(slot)).toBe(0);
  slot.rerender(<History threadId="thr_two" groups={[mine('ans_a'), mine('ans_b'), mine('ans_c')]} flash={null} markId={null} settled onJump={onJump} />);
  expect(slid(slot)).toBe(1);
});

it('ignores identical page deliveries without dropping other pages', () => {
  const page = { items: [base], nextCursor: 'older' }, older = { items: [], nextCursor: null };
  const old = { threadId: 'thr_one', pages: [page, older] };
  expect(receivePage(old, 'thr_one', 0, page)).toBe(old);
  expect(receivePage(old, 'thr_two', 0, page)).not.toBe(old);
  expect(receivePage(old, 'thr_one', 0, { ...page }).pages).toEqual([page, older]);
});

it('coalesces scroll anchor scans within an animation frame', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  try {
    const { slot, recipients } = setup(); fireEvent.click(await recipients.findByRole('option'));
    await slot.findByText('Answer one');
    const view = slot.getByRole('list', { name: 'History' }).closest('.overflow-auto') as HTMLElement;
    vi.spyOn(view, 'clientHeight', 'get').mockReturnValue(500);
    const scan = vi.spyOn(view, 'querySelectorAll');
    fireEvent.scroll(view); fireEvent.scroll(view); fireEvent.scroll(view);
    expect(scan.mock.calls.filter(([selector]) => selector.includes('[data-history-ids]'))).toHaveLength(0);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    expect(scan.mock.calls.filter(([selector]) => selector.includes('[data-history-ids]'))).toHaveLength(1);
  } finally { vi.unstubAllGlobals(); }
});

it('measures every history card before freezing any on width resize', async () => {
  const callbacks: (() => void)[] = [];
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { callbacks.push(callback); } observe() {} disconnect() {} });
  let width = 400;
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
  try {
    const { slot, recipients } = setup(); fireEvent.click(await recipients.findByRole('option')); await slot.findByText('Answer one');
    const rows = Array.from(slot.getByRole('list', { name: 'History' }).children) as HTMLElement[];
    let measured = 0;
    rows.forEach(row => Object.defineProperty(row, 'offsetHeight', { get: () => { if (measured < rows.length) expect(rows.every(card => !card.style.contentVisibility)).toBe(true); measured++; return 100; } }));
    width = 300;
    act(() => callbacks.forEach(run => run()));
    expect(measured).toBeGreaterThanOrEqual(rows.length);
    expect(rows.every(row => row.style.contentVisibility === 'auto')).toBe(true);
  } finally { vi.unstubAllGlobals(); }
});

it('flips a growing quote popup and fits it to a narrowed chat', async () => {
  const observers: { callback: () => void; nodes: Element[] }[] = [];
  vi.stubGlobal('ResizeObserver', class { entry; constructor(callback: () => void) { this.entry = { callback, nodes: [] as Element[] }; observers.push(this.entry); } observe(node: Element) { this.entry.nodes.push(node); } disconnect() {} });
  let width = 600, popupHeight = 50;
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function(this: HTMLElement) { return this.getAttribute('role') === 'dialog' ? popupHeight : 0; });
  const rect = { top: 300, bottom: 320, left: 20, right: 100, width: 80, height: 20 } as DOMRect;
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [rect] });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => rect });
  try {
    const { slot, recipients } = setup(); fireEvent.click(await recipients.findByRole('option')); await slot.findByText('Answer one');
    const body = slot.container.querySelector('[data-agent-body]')!;
    const range = document.createRange(); range.selectNodeContents(body); window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    fireEvent.mouseUp(body); fireEvent.click(slot.getByRole('button', { name: 'Comment' }));
    const popup = await slot.findByRole('dialog', { name: 'Quote reply' });
    const top = parseFloat(popup.style.top);
    popupHeight = 200;
    act(() => observers.filter(o => o.nodes.includes(popup)).forEach(o => o.callback()));
    expect(parseFloat(popup.style.top)).toBeLessThan(top);
    width = 300;
    act(() => observers.filter(o => !o.nodes.includes(popup)).forEach(o => o.callback()));
    await waitFor(() => expect(popup.style.width).toBe('284px'));
  } finally { window.getSelection()?.removeAllRanges(); vi.unstubAllGlobals(); }
});

it('does not redraw the queue preview while typing', async () => {
  let reads = 0;
  const row = { id: 'q_memo', threadId: 'thr_one', updatedAt: 1, get content() { reads++; return [{ type: 'text', text: 'Stable preview', mentions: [] }]; } };
  const { slot, recipients } = setup({ queuedMessages: { list: async () => [row] } });
  fireEvent.click(await recipients.findByRole('option'));
  await slot.findByText('Stable preview');
  await act(async () => {});
  const before = reads;
  change(slot.getByRole('textbox', { name: 'Send message' }), { target: { value: 'Typing' } });
  expect(reads).toBe(before);
});

it('rereads the queue after deletion without refreshing history', async () => {
  let rows = [{ id: 'q_no_refresh', threadId: 'thr_one', content: [{ type: 'text', text: 'Delete without refresh', mentions: [] }], updatedAt: 1 }];
  const queueList = vi.fn(async () => rows);
  const { slot, recipients, list } = setup({ queuedMessages: { list: queueList, delete: async () => { rows = []; } } });
  fireEvent.click(await recipients.findByRole('option')); await slot.findByText('Delete without refresh'); await slot.findAllByText('Answer one');
  const calls = list.mock.calls.length, queueCalls = queueList.mock.calls.length;
  fireEvent.click(slot.getByRole('button', { name: 'Delete queued message 1' }));
  await waitFor(() => expect(queueList.mock.calls.length).toBeGreaterThan(queueCalls));
  expect(list.mock.calls.length).toBe(calls);
});

it('keeps a dragged queue row inside the visible list', async () => {
  const { keepInList } = await import('./inbox');
  const rect = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 100, width: 100, height: bottom - top });
  const args = (y: number) => ({ transform: { x: 12, y, scaleX: 1, scaleY: 1 }, draggingNodeRect: rect(100, 140), scrollableAncestorRects: [rect(50, 200)] }) as any;
  expect(keepInList(args(30))).toMatchObject({ x: 0, y: 30 });
  expect(keepInList(args(500))).toMatchObject({ y: 60 });
  expect(keepInList(args(-500))).toMatchObject({ y: -50 });
});

it('shows a sub-session title without a top-level contact', async () => {
  localStorage.setItem('bb-plugin-answers:page:selected', JSON.stringify('thr_example_child'));
  const { slot } = setup({ recipients: [], list: () => ({ items:[{...base,threadId:'thr_example_child',threadTitle:'Child session'}],nextCursor:null }) });
  await waitFor(() => expect(slot.container.querySelector('[data-chat-column]')?.textContent).toContain('Child session'));
  expect(slot.queryByText('Untitled thread')).toBeNull();
});
it('gives the history and the composer back the scroll bar width on the right, so both sides of the chat read the same', async () => {
  const { slot, recipients } = setup();
  fireEvent.click(await recipients.findByRole('option'));
  const history = await slot.findByRole('list', { name:'History' });
  expect(history.closest<HTMLElement>('[data-chat-column]')!.style.getPropertyValue('--scrollbar')).toMatch(/^\d+px$/);
  expect(history.className.split(' ')).toEqual(expect.arrayContaining(['pl-4', 'pr-[max(0px,calc(1rem-var(--scrollbar,0px)))]']));
  // The composer stack keeps the same 1rem on both sides (no scroll bar in jsdom, so the full 16px on the right).
  const stack = slot.container.querySelector<HTMLElement>('[data-composer-stack]')!;
  expect(stack.className.split(' ')).toContain('pl-4'); expect(stack.style.paddingRight).toBe('16px');
});

it.each(['send', 'steer', 'draft', 'schedule'])('keeps model choices per thread and passes execution for %s', async mode => {
  const two = { ...one, threadId: 'thr_two', threadTitle: 'Two' };
  const thread = { activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: false }, projectId: 'pr_one', providerId: 'provider_example', status: 'idle', environment: { id: 'env_example' } };
  const { slot, recipients, send } = setup({ defaultExecutionOptions: async () => ({ permissionMode: 'auto' }), recipients: [one, two], sidebarThreads: { threads: [{ ...thread, id: 'thr_one', title: 'One' }, { ...thread, id: 'thr_two', title: 'Two' }], projects: [] }, events: { list: () => Promise.resolve([{ data: { execution: { model: 'model-current', reasoningLevel: 'medium', serviceTier: 'default' } } }]) } });
  fireEvent.click((await recipients.findAllByRole('option'))[0]);
  const picker = await slot.findByRole('button', { name: 'model-current' });
  expect(picker.closest('[data-composer-toolbar]')).toBeTruthy();
  expect(picker.getAttribute('data-provider-change')).toBe('true');
  expect(JSON.parse(picker.getAttribute('data-routing')!)).toEqual({ kind: 'environment', environmentId: 'env_example' });
  fireEvent.click(await slot.findByRole('button', { name:'auto' }));
  fireEvent.click(picker);
  fireEvent.click(recipients.getAllByRole('option')[1]);
  await slot.findByRole('button', { name: 'model-current' });
  expect(slot.queryByRole('button', { name: 'model-chosen' })).toBeNull();
  expect(await slot.findByRole('button', { name:'auto' })).toBeTruthy();
  fireEvent.click(recipients.getAllByRole('option')[0]);
  await slot.findByRole('button', { name: 'model-chosen' });
  change(slot.getByRole('textbox', { name: 'Send message' }), { target: { value: 'Hello' } });
  if (mode === 'send') fireEvent.click(slot.getByRole('button', { name: 'Send message' }));
  else {
    fireEvent.click(slot.getByRole('button', { name: 'More send options' }));
    fireEvent.click(slot.getByRole('menuitem', { name: mode === 'steer' ? 'Steer' : mode === 'draft' ? 'Save draft' : 'Send later…' }));
    if (mode === 'schedule') { change(slot.getByLabelText('Send at'), { target: { value: '2099-01-01T12:00' } }); fireEvent.click(slot.getByRole('button', { name: 'Schedule' })); }
  }
  await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ permissionMode:'full', model: 'model-chosen', reasoningLevel: 'high', serviceTier: 'priority' })));
  expect(slot.getByRole('button', { name: 'model-chosen' })).toBeTruthy();
  await waitFor(() => expect(JSON.parse(localStorage.getItem('bb-plugin-answers:page:compose')!).thr_one.execution.model).toBe('model-chosen'));
});
it('uses the provider default for a thread without a previous execution', async () => {
  const { slot, recipients, send } = setup({ sidebarThreads: { threads: [{ activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: false }, id: 'thr_one', title: 'One', providerId: 'provider_example', projectId: 'pr_one', status: 'idle', host: { id: 'host_example' } }], projects: [] }, events: { list: () => Promise.resolve([]) }, providers: { models: () => Promise.resolve({ models: [{ model: 'model-default', isDefault: true, defaultReasoningEffort: 'medium' }] }) } });
  fireEvent.click(await recipients.findByRole('option'));
  const picker = await slot.findByRole('button', { name: 'model-default' });
  expect(JSON.parse(picker.getAttribute('data-routing')!)).toEqual({ kind: 'host', hostId: 'host_example' });
  expect(slot.container.querySelector('[data-permission-picker]')).toBeNull();
  change(slot.getByRole('textbox', { name:'Send message' }), { target:{ value:'Hello' } });
  fireEvent.click(slot.getByRole('button', { name:'Send message' }));
  await waitFor(() => expect(send).toHaveBeenCalled());
  expect(send.mock.calls[0][0]).not.toHaveProperty('permissionMode');
});
it('keeps the queue drag handle visible without hover, so touch screens and light themes show it', async () => {
  const row = { id:'q1', threadId:'thr_one', content:[{ type:'text', text:'Queued note', mentions:[] }], sendAt:null, updatedAt:1 };
  const { slot, recipients } = setup({ queuedMessages:{ list: async () => [row] } });
  fireEvent.click(await recipients.findByRole('option'));
  const handle = await slot.findByRole('button', { name:'Reorder queued message 1' });
  expect(handle.querySelector('[data-icon="DragDropVertical"], svg')!.getAttribute('class') ?? '').not.toMatch(/(^|\s)opacity-0(\s|$)/);
});

async function selectPassage(options: Parameters<typeof setup>[0] = {}) {
  const result = setup(options); fireEvent.click(await result.recipients.findByRole('option')); await result.slot.findByText('Answer one');
  const body = result.slot.container.querySelector<HTMLElement>('[data-agent-body]')!;
  const range = document.createRange(); range.selectNodeContents(body);
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => ({ top: 20, bottom: 40, left: 20 }) });
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
  fireEvent.mouseUp(body); return { ...result, body };
}
it('shows selection actions without opening a dialog or moving focus', async () => {
  const before = document.activeElement, { slot } = await selectPassage();
  expect(slot.getByRole('toolbar', { name: 'Selected passage' })).toBeTruthy();
  for (const name of ['Add to chat', 'Add to reply pool', 'Comment', 'Save']) expect(within(slot.getByRole('toolbar')).getByRole('button', { name })).toBeTruthy();
  expect(slot.queryByRole('dialog', { name: 'Quote reply' })).toBeNull(); expect(document.activeElement).toBe(before);
});
it('opens the selected quote only on Comment', async () => {
  const { slot } = await selectPassage(); fireEvent.click(slot.getByRole('button', { name: 'Comment' }));
  expect(within(slot.getByRole('dialog', { name: 'Quote reply' })).getByText('Answer one')).toBeTruthy();
});
it('adds a selection directly to the pool with its source', async () => {
  const poolAdd = vi.fn(() => ({ id: 'pool_example' })); const { slot } = await selectPassage({ rpc: { poolAdd } });
  fireEvent.click(slot.getByRole('button', { name: 'Add to reply pool' }));
  await waitFor(() => expect(poolAdd).toHaveBeenCalledWith({ threadId: 'thr_one', itemId: 'ans_one', quoteSeq: 2, quote: 'Answer one', note: '' }));
});
it('saves the selected assistant passage', async () => {
  const save = vi.fn(() => ({ ok: true })); const { slot } = await selectPassage({ rpc: { save } });
  fireEvent.click(within(slot.getByRole('toolbar')).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith({ threadId: 'thr_one', seq: 2, role: 'assistant', text: 'Answer one' }));
  expect((await slot.findByRole('status')).textContent).toBe('Saved');
});
it('hides selection Save without a sequence', async () => {
  const { slot, body } = await selectPassage(); delete body.dataset.seq; fireEvent.mouseUp(body);
  expect(within(slot.getByRole('toolbar')).queryByRole('button', { name: 'Save' })).toBeNull();
});
it('appends a Markdown quote to the existing thread draft and focuses it', async () => {
  const { slot, body } = await selectPassage(); const editor = slot.getByRole('textbox', { name: 'Send message' });
  change(editor, { target: { value: 'Existing' } }); fireEvent.mouseUp(body);
  fireEvent.click(slot.getByRole('button', { name: 'Add to chat' }));
  await waitFor(() => expect(JSON.parse(localStorage.getItem('bb-plugin-answers:page:compose')!).thr_one.text).toBe('Existing\n\n> Answer one\n\n'));
  expect(document.activeElement).toBe(editor);
});
it.each(['collapse', 'Escape'])('dismisses the bar on %s', async mode => {
  const { slot, body } = await selectPassage(); expect(slot.getByRole('toolbar', { name: 'Selected passage' })).toBeTruthy();
  if (mode === 'Escape') fireEvent.keyDown(body, { key: 'Escape' }); else { window.getSelection()!.removeAllRanges(); fireEvent.mouseUp(body); }
  expect(slot.queryByRole('toolbar', { name: 'Selected passage' })).toBeNull();
});
it('portals the desktop chat header and inline search into the page toolbar', async () => {
  const title = document.createElement('div'), search = document.createElement('div'), actions = document.createElement('div');
  const toolbar = document.createElement('div'); toolbar.append(title, search, actions); document.body.append(toolbar);
  try {
    const { slot, recipients } = setup({ props: { toolbarTargets: { title, search, actions } } }); fireEvent.click(await recipients.findByRole('option')); await slot.findByText('Answer one');
    expect(title.textContent).toContain('One');
    expect(slot.queryByRole('button', { name: 'Open thread' })).toBeNull();
    expect(slot.container.querySelector('[data-conversation-header]')).toBeNull();
    fireEvent.click(within(search).getByRole('button', { name: 'Search conversation' }));
    expect(within(search).getByRole('textbox', { name: 'Search conversation' })).toBeTruthy();
  } finally { toolbar.remove(); }
});
it('keeps phone search inline before the thread actions without an Open thread link', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  try {
    const { slot, recipients } = setup(); fireEvent.click(await recipients.findByRole('option')); await slot.findByText('Answer one');
    const search = slot.getByRole('button', { name: 'Search conversation' }); fireEvent.click(search);
    const input = slot.getByRole('textbox', { name: 'Search conversation' });
    expect(input.parentElement).toBe(search.parentElement);
    expect(slot.queryByRole('button', { name: 'Open thread' })).toBeNull();
    expect(slot.container.querySelector('[data-conversation-header]')).toBeNull();
  } finally { vi.unstubAllGlobals(); }
});

it('reaches selection actions with Tab from a selected message', async () => {
  const { slot } = await selectPassage(); fireEvent.keyDown(document, { key: 'Tab' });
  expect(document.activeElement).toBe(within(slot.getByRole('toolbar')).getByRole('button', { name: 'Add to chat' }));
});
it('captures touch selections through the debounced selectionchange listener', async () => {
  const { slot, body } = await selectPassage(); fireEvent.keyDown(body, { key: 'Escape' });
  expect(slot.queryByRole('toolbar')).toBeNull(); fireEvent(document, new Event('selectionchange'));
  expect(await slot.findByRole('toolbar', { name: 'Selected passage' })).toBeTruthy();
});

it('recalls prompt history with Up and restores the current draft with Down', async () => {
 const promptHistory=vi.fn(async () => [{id:'prompt_example',createdAt:1,input:[{type:'text',text:'Previous prompt',mentions:[]},{type:'localFile',path:'/example.txt',name:'example.txt'}]}]);
 const {slot,recipients}=setup({promptHistory}); fireEvent.click(await recipients.findByRole('option'));
 const editor=slot.getByRole('textbox',{name:'Send message'}); editor.focus();
 fireEvent.keyDown(editor,{key:'ArrowUp'});
 await waitFor(() => expect(editor.textContent).toBe('Previous prompt'));
 expect(slot.getByText('example.txt')).toBeTruthy();
 const selection=window.getSelection()!,range=document.createRange(); range.setStart(editor,0); range.collapse(true); selection.removeAllRanges(); selection.addRange(range);
 fireEvent.keyDown(editor,{key:'ArrowDown'});
 await waitFor(() => expect(editor.textContent).toBe(''));
 expect(slot.queryByText('example.txt')).toBeNull(); expect(promptHistory).toHaveBeenCalledWith({threadId:'thr_one',limit:'100'});
});

it('hands off to a new thread with source metadata and selects it; cancel restores the provider', async () => {
 const spawn=vi.fn(async()=>({id:'thr_new_example'}));
 const {slot,recipients,send}=setup({spawn,sidebarThreads:{threads:[{id:'thr_one',title:'One',displayTitle:'One',projectId:'pr_one',providerId:'provider_example',status:'idle',activity:{workflows:0,backgroundAgents:0,backgroundCommands:0,planMode:false},environment:{id:'env_example'}}],projects:[]},events:{list:async()=>[{data:{execution:{model:'handoff-current',reasoningLevel:'medium'}}}]}});
 fireEvent.click(await recipients.findByRole('option'));
 fireEvent.click(await slot.findByRole('button',{name:'handoff-current'}));
 expect(await slot.findByText('Handoff to new thread')).toBeTruthy();
 fireEvent.click(slot.getByRole('button',{name:'Exit handoff'}));
 expect(slot.queryByText('Handoff to new thread')).toBeNull();
 fireEvent.click(await slot.findByRole('button',{name:'handoff-current'}));
 change(slot.getByRole('textbox',{name:'Send message'}),{target:{value:'Continue the work'}});
 fireEvent.click(slot.getByRole('button',{name:'Send message'}));
 await waitFor(()=>expect(spawn).toHaveBeenCalledWith(expect.objectContaining({projectId:'pr_one',environment:{type:'reuse',environmentId:'env_example'},providerId:'provider_other',model:'model-chosen',reasoningLevel:'high',serviceTier:'priority',input:[{type:'text',text:'Continue from @thread:thr_one\n\nContinue the work',mentions:[{start:14,end:29,resource:{kind:'thread',threadId:'thr_one',projectId:'pr_one',label:'One'}}]}]})));
 expect(send).not.toHaveBeenCalled();
 await waitFor(()=>expect(localStorage.getItem('bb-plugin-answers:page:selected')).toContain('thr_new_example'));
});

it('opens the selected full transcript and returns to the mounted feed at its scroll position', async () => {
  const {slot,recipients} = setup();
  fireEvent.click(await recipients.findByRole('option')); await slot.findByText('Answer one');
  const feed = slot.getByRole('list', {name:'History'}), scroller = feed.closest('.overflow-auto') as HTMLElement;
  scroller.scrollTop = 123;
  fireEvent.click(slot.getByRole('button', {name:'Full transcript'}));
  expect(slot.getByRole('region', {name:'Full transcript'}).querySelector('[data-thread-chat]')?.getAttribute('data-thread-chat')).toBe('thr_one');
  expect(scroller.getAttribute('aria-hidden')).toBe('true');
  fireEvent.click(slot.getByRole('button', {name:'Back to Agent Hub'}));
  await waitFor(() => expect(scroller.scrollTop).toBe(123));
  expect(slot.getByRole('list', {name:'History'})).toBe(feed);
  expect(slot.queryByRole('region', {name:'Full transcript'})).toBeNull();
});
it('puts a steer straight into the running turn card instead of a separate sending row', async () => {
  const running = { ...base, id:'ans_running', status:'waiting' as const, question:'First ask', turnId:'turn_example', answer:null, answerSeq:null, answerSource:null };
  const thread = { activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: false }, projectId: 'pr_one', providerId: 'provider_example', status: 'active', environment: { id: 'env_example' } };
  const { slot, recipients } = setup({ list: () => ({ items:[running], nextCursor:null }), send: () => new Promise(() => {}), sidebarThreads: { threads: [{ ...thread, id: 'thr_one', title: 'One' }], projects: [] } });
  fireEvent.click((await recipients.findAllByRole('option'))[0]);
  await slot.findByText('First ask');
  change(slot.getByRole('textbox', { name: 'Send message' }), { target: { value: 'Also check this' } });
  fireEvent.click(slot.getByRole('button', { name: 'More send options' }));
  fireEvent.click(slot.getByRole('menuitem', { name: 'Steer' }));
  const bubble = await waitFor(() => slot.getAllByText('Also check this').find(node => !node.closest('[role=textbox]'))!);
  expect(bubble.closest('[aria-label="Sending"]')).toBeNull();
  expect(bubble.closest('li')).toBe(slot.getByText('First ask').closest('li'));
});
it.each([false,true])('selection action preference %s preserves the selection',async selectionActions=>{
 const {slot}=await selectPassage({rpc:{getPreferences:()=>({selectionActions})}});
 expect(!!slot.queryByRole('toolbar',{name:'Selected passage'})).toBe(selectionActions);
 expect(window.getSelection()!.toString()).toContain('Answer one');
});
it.each([false,true])('background grouping preference %s changes cards',async groupBackgroundUpdates=>{
 const {slot,recipients}=setup({rpc:{getPreferences:()=>({groupBackgroundUpdates})},list:()=>({items:[quiet(3,'Final report'),quiet(2,'Second report'),quiet(1,'First report')],nextCursor:null})});
 fireEvent.click(await recipients.findByRole('option'));
 await slot.findByText('Final report');
 expect(!!slot.container.querySelector('[data-update-group]')).toBe(groupBackgroundUpdates);
 if(!groupBackgroundUpdates) {expect(slot.getByText('First report')).toBeTruthy();expect(slot.getByText('Second report')).toBeTruthy();}
});

it('restores the thread\'s permission mode too when the owner leaves a handoff', async () => {
 const {slot,recipients}=setup({defaultExecutionOptions:async()=>({permissionMode:'auto'}),sidebarThreads:{threads:[{id:'thr_one',title:'One',displayTitle:'One',projectId:'pr_one',providerId:'provider_example',status:'idle',activity:{workflows:0,backgroundAgents:0,backgroundCommands:0,planMode:false},environment:{id:'env_example'}}],projects:[]},events:{list:async()=>[{data:{execution:{model:'handoff-current',reasoningLevel:'medium'}}}]}});
 fireEvent.click(await recipients.findByRole('option'));
 fireEvent.click(await slot.findByRole('button',{name:'handoff-current'}));
 fireEvent.click(await slot.findByRole('button',{name:'auto'}));
 expect(await slot.findByRole('button',{name:'full'})).toBeTruthy();
 fireEvent.click(slot.getByRole('button',{name:'Exit handoff'}));
 expect(await slot.findByRole('button',{name:'auto'})).toBeTruthy();
});
it('moves the main composer message into its thread reply pool and clears it', async () => {
  const poolAdd = vi.fn(() => ({ id: 'pool_example' }));
  const { slot, recipients, send } = setup({ rpc: { poolAdd } });
  fireEvent.click(await recipients.findByRole('option'));
  const editor = await slot.findByRole('textbox', { name: 'Send message' });
  change(editor, { target: { value: 'Collect this message' } });
  fireEvent.click(slot.getByRole('button', { name: 'More send options' }));
  fireEvent.click(slot.getByRole('menuitem', { name: 'Add to reply pool' }));
  await waitFor(() => expect(poolAdd).toHaveBeenCalledWith({ threadId: 'thr_one', quote: '', note: 'Collect this message', attachments: [] }));
  await waitFor(() => expect(editor.textContent).toBe(''));
  expect(send).not.toHaveBeenCalled();
});

it('keeps a chat running, only out of sight, while its voice input is busy, so bb does not cancel the transcription', async () => {
 const people=[0,1].map(i=>({...one,threadId:`thr_example_${i}`,threadTitle:`Example ${i}`}));
 const {slot,recipients}=setup({recipients:people,list:input=>({items:[{...base,id:`ans_${input.threadId}`,threadId:input.threadId,question:input.threadId}],nextCursor:null})});
 const open=async(i:number)=>{fireEvent.click(await recipients.findByRole('option',{name:new RegExp(`Example ${i}`)}));await slot.findByText(`thr_example_${i}`);};
 const wrapper=()=>slot.getByText('thr_example_0').closest('[inert]') as HTMLElement;
 await open(0);
 act(()=>{window.dispatchEvent(new CustomEvent(VOICE_BUSY,{detail:{threadId:'thr_example_0',active:true}}));});
 await open(1);
 expect(wrapper().style.display).toBe(''); expect(wrapper().classList.contains('hidden')).toBe(true);
 act(()=>{window.dispatchEvent(new CustomEvent(VOICE_BUSY,{detail:{threadId:'thr_example_0',active:false}}));});
 await waitFor(()=>expect(wrapper().style.display).toBe('none'));
});
it('keeps five chats mounted, pauses hidden reads and restores DOM, composer, expansion and scroll', async () => {
 const people=Array.from({length:6},(_,i)=>({...one,threadId:`thr_example_${i}`,threadTitle:`Example ${i}`}));
 localStorage.setItem('bb-plugin-answers:page:compose',JSON.stringify({thr_example_0:{text:'',files:[{type:'localFile',path:'/tmp/example.txt',name:'example.txt'}]}}));
 let answer='Original answer';
 const {slot,recipients,list}=setup({recipients:people,list:input=>({items:[{...base,id:`ans_${input.threadId}`,threadId:input.threadId,question:input.threadId,answer}],nextCursor:input.threadId==='thr_example_0' && !input.cursor?'1|ans_example_old':null})});
 const open=async(i:number)=>{fireEvent.click(await recipients.findByRole('option',{name:new RegExp(`Example ${i}`)}));await slot.findByText(`thr_example_${i}`);};
 await open(0);const editor=slot.getByRole('textbox',{name:'Send message'}), history=slot.getByRole('list',{name:'History'}), scroll=history.closest('.overflow-auto') as HTMLElement;
 change(editor,{target:{value:'Kept draft'}});scroll.scrollTop=123;
 await open(1);const before=list.mock.calls.filter(([input])=>input.threadId==='thr_example_0' && input.view==='all').length;
 const renders=cards.byThread.thr_example_0;answer='Updated answer';
 await slot.behavior.experimental_invalidateRpc(['answers:items']);
 expect(cards.byThread.thr_example_0).toBe(renders);
 expect(list.mock.calls.filter(([input])=>input.threadId==='thr_example_0' && input.view==='all')).toHaveLength(before);
 await open(0);expect(slot.getByRole('list',{name:'History'})).toBe(history);expect(slot.getByRole('textbox',{name:'Send message'})).toBe(editor);expect(editor.textContent).toBe('Kept draft');expect(slot.getByText('example.txt')).toBeTruthy();expect(scroll.scrollTop).toBe(123);
 await waitFor(()=>expect(within(history).getByText('Updated answer')).toBeTruthy());
 await waitFor(()=>expect(list.mock.calls.filter(([input])=>input.threadId==='thr_example_0' && input.view==='all')).toHaveLength(before+1));
 for(const i of [1,2,3,4,5])await open(i);
 expect(history.isConnected).toBe(false);
 localStorage.setItem('bb-plugin-answers:page:scroll',JSON.stringify({thr_example_0:{top:77,depth:2}}));
 await open(0);expect(slot.getByRole('list',{name:'History'})).not.toBe(history);
 await waitFor(()=>expect(list.mock.calls.some(([input])=>input.threadId==='thr_example_0' && input.cursor==='1|ans_example_old')).toBe(true));
});

it('keeps expanded updates and the full transcript across cached chat switches', async()=>{
 const people=[one,{...one,threadId:'thr_example',threadTitle:'Example'}];
 const {slot,recipients}=setup({recipients:people,list:input=>({items:input.threadId==='thr_one'?[after,quiet(3,'Third report'),quiet(2,'Second report'),quiet(1,'First report')]:[{...base,id:'ans_example',threadId:'thr_example'}],nextCursor:null})});
 fireEvent.click(await recipients.findByRole('option',{name:/One/}));const toggle=await slot.findByRole('button',{name:/3 background updates/});fireEvent.click(toggle);
 fireEvent.click(slot.getByRole('button',{name:'Full transcript'}));const transcript=slot.getByRole('region',{name:'Full transcript'});
 fireEvent.click(recipients.getByRole('option',{name:/Example/}));await slot.findByRole('list',{name:'History'});
 fireEvent.click(recipients.getByRole('option',{name:/One/}));expect(slot.getByRole('region',{name:'Full transcript'})).toBe(transcript);
 fireEvent.click(slot.getByRole('button',{name:'Back to Agent Hub'}));expect(slot.getByRole('button',{name:/3 background updates/})).toBe(toggle);expect(toggle.getAttribute('aria-expanded')).toBe('true');
});
it('keeps a chat of background updates at its New divider, right above the first unread, when an older read page arrives', async () => {
  const jump = async () => { const button = await waitFor(() => { const node = document.querySelector('[aria-label="Jump to unread"]') as HTMLElement; expect(node.className).not.toContain('invisible'); return node; }); fireEvent.click(button); };
  const observers: (() => void)[] = [];
  vi.stubGlobal('ResizeObserver', class { constructor(private callback: () => void) { observers.push(() => this.callback()); } observe() {} disconnect() {} });
  const tops = new WeakMap<Element, number>(); const divider = 700;
  // A detached element has no box, as in a browser: its rect reads all zeros.
  const spies = [
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500),
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400),
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(3000),
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(function (this: HTMLElement) { return tops.get(this) ?? 0; }),
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function (this: HTMLElement, value: number) { tops.set(this, value); }),
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) { return this.hasAttribute('data-new') ? divider : 0; }),
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const top = !this.isConnected ? 0 : this.hasAttribute('data-new') ? divider - (tops.get(this.closest('.overflow-auto')!) ?? 0) + 50 : this.classList.contains('overflow-auto') ? 50 : 0;
      return { top, bottom: 0, left:0, right:0, width:0, height:0 } as DOMRect;
    }),
  ];
  try {
    const update = (n: number, readAt: number | null) => ({ ...between, id:`ans_u${n}`, answer:`Report ${n}`, readAt, createdAt:asked + n * minute, answeredAt:asked + n * minute });
    const { slot, recipients } = setup({ list: (input: any) => input.cursor ? { items:[update(1, 1), update(0, 1)], nextCursor:null } : { items:[5, 4, 3, 2].map(n => update(n, null)), nextCursor:'1|ans_u2' } });
    fireEvent.click(await recipients.findByRole('option')); await slot.findByRole('list', { name:'History' });
    const first = await waitFor(() => { const node = document.querySelector('[data-new]'); expect(node).not.toBeNull(); return node!; });
    const scroller = document.querySelector('[aria-label=History]')!.closest('.overflow-auto')!;
    await waitFor(() => expect(tops.get(scroller)).toBe(3000)); // opened at the newest
    const ids = () => Array.from(document.querySelectorAll('[data-new], [data-history-ids]')).flatMap(node => node.hasAttribute('data-new') ? ['new'] : node.getAttribute('data-history-ids')!.split(' '));
    await waitFor(() => expect(ids()).toContain('ans_u0')); // the older read page joined the chat
    expect(first.isConnected).toBe(true); expect(ids().indexOf('new')).toBe(ids().indexOf('ans_u2') - 1); expect(ids().indexOf('ans_u1')).toBeLessThan(ids().indexOf('new'));
    await jump(); expect(tops.get(scroller)).toBe(divider); // the button lands right above the first unread
    observers.forEach(observe => observe());
    expect(tops.get(scroller)).toBe(divider);
  } finally { spies.forEach(spy => spy.mockRestore()); vi.unstubAllGlobals(); }
});
it('keeps the reader at their place when an older page arrives above after the open position was released', async () => {
  const jump = async () => { const button = await waitFor(() => { const node = document.querySelector('[aria-label="Jump to unread"]') as HTMLElement; expect(node.className).not.toContain('invisible'); return node; }); fireEvent.click(button); };
  const observers: (() => void)[] = [];
  vi.stubGlobal('ResizeObserver', class { constructor(private callback: () => void) { observers.push(() => this.callback()); } observe() {} disconnect() {} });
  const tops = new WeakMap<Element, number>(); let shift = 0;
  const spies = [
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500),
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400),
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(3000),
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(function (this: HTMLElement) { return tops.get(this) ?? 0; }),
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function (this: HTMLElement, value: number) { tops.set(this, value); }),
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) { return this.hasAttribute('data-new') ? 700 + shift : 0; }),
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (!this.isConnected) return { top:0, bottom:0, left:0, right:0, width:0, height:0 } as DOMRect;
      const off = this.hasAttribute('data-new') ? 700 + shift : this.hasAttribute('data-history-ids') ? 710 + shift : null, top = off === null ? (this.classList.contains('overflow-auto') ? 50 : 0) : off - (tops.get(this.closest('.overflow-auto')!) ?? 0) + 50;
      return { top, bottom: off === null ? 0 : top + 100, left:0, right:0, width:0, height:0 } as DOMRect;
    }),
  ];
  try {
    const update = (n: number, readAt: number | null) => ({ ...between, id:`ans_u${n}`, answer:`Report ${n}`, readAt, createdAt:asked + n * minute, answeredAt:asked + n * minute });
    let release!: (value: object) => void;
    const { slot, recipients } = setup({ list: (input: any) => input.cursor ? new Promise(r => { release = r; }) : { items:[5, 4, 3, 2].map(n => update(n, null)), nextCursor:'1|ans_u2' } });
    fireEvent.click(await recipients.findByRole('option')); await slot.findByRole('list', { name:'History' });
    const scroller = document.querySelector('[aria-label=History]')!.closest('.overflow-auto')!;
    await waitFor(() => expect(tops.get(scroller)).toBe(3000));
    await jump(); expect(tops.get(scroller)).toBe(700);
    fireEvent.scroll(scroller); await new Promise(r => requestAnimationFrame(() => r(0))); fireEvent.wheel(scroller); // the reader acts: the hold ends
    await waitFor(() => expect(release).toBeTypeOf('function'));
    shift = 400; await act(async () => { release({ items:[update(1, 1), update(0, 1)], nextCursor:null }); }); await new Promise(r => setTimeout(r, 50));
    observers.forEach(observe => observe());
    expect(tops.get(scroller)).toBe(1100);
  } finally { spies.forEach(spy => spy.mockRestore()); vi.unstubAllGlobals(); }
});
it('keeps a reader at the newest in place when the reach back over quiet updates adds an older page after the hold ended', async () => {
  const tops = new WeakMap<Element, number>(); let height = 3000;
  const spies = [
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500),
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => height),
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(function (this: HTMLElement) { return tops.get(this) ?? 0; }),
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function (this: HTMLElement, value: number) { tops.set(this, value); }),
  ];
  try {
    let release!: (value: object) => void;
    const { slot, recipients } = setup({ list: (input: any) => input.cursor ? new Promise(r => { release = r; }) : { items:[quiet(3, 'Third report'), quiet(2, 'Second report')], nextCursor:'1|ans_u2' } });
    fireEvent.click(await recipients.findByRole('option')); await slot.findByRole('list', { name:'History' });
    const scroller = document.querySelector('[aria-label=History]')!.closest('.overflow-auto')!;
    await waitFor(() => expect(tops.get(scroller)).toBe(3000));
    fireEvent.wheel(scroller); // the reader acts: the hold on the newest ends
    await waitFor(() => expect(release).toBeTypeOf('function'));
    height = 3400; await act(async () => { release({ items:[quiet(1, 'First report')], nextCursor:null }); }); await new Promise(r => setTimeout(r, 50));
    expect(tops.get(scroller)).toBe(3400);
  } finally { spies.forEach(spy => spy.mockRestore()); }
});
it('keeps the remembered message in place when an older page joins its run of updates and the row is rebuilt', async () => {
  localStorage.setItem('bb-plugin-answers:page:scroll', JSON.stringify({ thr_one: { top:5, depth:1, anchor:'ans_u3', offset:0 } }));
  const observers: (() => void)[] = [];
  vi.stubGlobal('ResizeObserver', class { constructor(private callback: () => void) { observers.push(() => this.callback()); } observe() {} disconnect() {} });
  const tops = new WeakMap<Element, number>();
  // A detached element has no box, as in a browser: its rect reads all zeros.
  const spies = [
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500),
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400),
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(3000),
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(function (this: HTMLElement) { return tops.get(this) ?? 0; }),
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function (this: HTMLElement, value: number) { tops.set(this, value); }),
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const row = this.hasAttribute('data-history-ids'), top = !this.isConnected ? 0 : row ? 710 - (tops.get(this.closest('.overflow-auto')!) ?? 0) + 50 : this.classList.contains('overflow-auto') ? 50 : 0;
      return { top, bottom: row && this.isConnected ? top + 100 : 0, left:0, right:0, width:0, height:0 } as DOMRect;
    }),
  ];
  try {
    const update = (n: number) => ({ ...between, id:`ans_u${n}`, answer:`Report ${n}`, readAt:1, createdAt:asked + n * minute, answeredAt:asked + n * minute });
    const { slot, recipients } = setup({ list: (input: any) => input.cursor ? { items:[update(1), update(0)], nextCursor:null } : { items:[5, 4, 3, 2].map(update), nextCursor:'1|ans_u2' } });
    fireEvent.click(await recipients.findByRole('option')); await slot.findByRole('list', { name:'History' });
    const scroller = document.querySelector('[aria-label=History]')!.closest('.overflow-auto')!;
    await waitFor(() => expect(tops.get(scroller)).toBe(710));
    await waitFor(() => expect(document.querySelector('[data-history-ids~="ans_u0"]')).not.toBeNull()); // the older page joined the run
    observers.forEach(observe => observe());
    expect(tops.get(scroller)).toBe(710);
  } finally { spies.forEach(spy => spy.mockRestore()); vi.unstubAllGlobals(); localStorage.removeItem('bb-plugin-answers:page:scroll'); }
});
it('starts a run of updates at the first unread, so older read updates stay above it', async () => {
  const { conversation } = await import('./inbox');
  const update = (n: number, readAt: number | null) => [{ ...between, id:`ans_u${n}`, answer:`Report ${n}`, readAt, createdAt:asked + n * minute, answeredAt:asked + n * minute }];
  const ids = (entries: any[]) => entries.map(e => e.group.map((i: any) => i.id).join('+'));
  const groups = [update(0, 1), update(1, 1), update(2, null), update(3, null), update(4, null)];
  expect(ids(conversation(groups as any, false, [], false, null, true, 'ans_u2').entries)).toEqual(['ans_u0+ans_u1', 'ans_u2+ans_u3+ans_u4']);
  expect(ids(conversation(groups as any, false, [], false, null, true).entries)).toEqual(['ans_u0+ans_u1+ans_u2+ans_u3+ans_u4']);
});

// jsdom has no layout: each History row is 300 high and the New divider 40, stacked in DOM order inside a 500 high view.
function stackLayout() {
  const tops = new WeakMap<Element, number>();
  const list = () => document.querySelector('[aria-label=History]'), view = () => list()?.closest('.overflow-auto') ?? null;
  const offsets = () => { const map = new Map<Element, number>(); let y = 0; for (const el of Array.from(list()?.children ?? [])) { map.set(el, y); y += el.hasAttribute('data-new') ? 40 : 300; } return { map, total: y }; };
  const rowOf = (el: Element) => { let node: Element | null = el; while (node && node.parentElement !== list()) node = node.parentElement; return node; };
  const zero = { top:0, bottom:0, left:0, right:0, width:0, height:0 } as DOMRect;
  const spies = [
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500),
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400),
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return this === view() ? offsets().total : 0; }),
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(function (this: HTMLElement) { return tops.get(this) ?? 0; }),
    // A browser clamps the scroll position to the content.
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function (this: HTMLElement, value: number) { tops.set(this, Math.max(0, Math.min(value, this === view() ? offsets().total - 500 : 0))); }),
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) { return offsets().map.get(this) ?? 0; }),
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (!this.isConnected) return zero;
      if (this === view()) return { ...zero, top:0, bottom:500 } as DOMRect;
      const row = list() ? rowOf(this) : null, off = row ? offsets().map.get(row) : undefined; if (!row || off === undefined) return zero;
      const top = off - (tops.get(view()!) ?? 0), height = row.hasAttribute('data-new') ? 40 : 300;
      return { ...zero, top, bottom: top + height, height } as DOMRect;
    }),
  ];
  return { scroller: () => view() as HTMLElement, top: () => tops.get(view()!) ?? 0, restore: () => spies.forEach(spy => spy.mockRestore()) };
}
// An answered message of the owner's chat, n minutes into the hour; read unless it is one of the unread ones.
const chatItem = (n: number, readAt: number | null) => ({ ...base, id:`ans_${n}`, question:`Question ${n}`, questionSeq:n * 2, answer:`Reply ${n}`, answerSeq:n * 2 + 1, readAt, createdAt:asked + n * minute, answeredAt:asked + n * minute + 1000 });
const chatList = (unread: number[], total = 7) => () => ({ items:Array.from({ length: total }, (_, n) => chatItem(n, unread.includes(n) ? null : 1)).reverse(), nextCursor:null });
const jumpButton = () => document.querySelector('[aria-label="Jump to unread"]') as HTMLElement;
const markedIds = (markRead: ReturnType<typeof vi.fn>) => markRead.mock.calls.flatMap(([input]: any) => input.ids as string[]).sort();
const settle = async (scroller: Element) => { fireEvent.wheel(scroller); await new Promise(r => setTimeout(r, 80)); }; // the reader acts: the hold ends, reads count

it('opens a chat whose first unread message is above the last screen at the newest message, not at the first unread', async () => {
  const layout = stackLayout();
  try {
    const { slot, recipients } = setup({ recipients:[{ ...one, unread:6 }], list: chatList([1, 2, 3, 4, 5, 6]) });
    fireEvent.click(await recipients.findByRole('option')); await slot.findByRole('list', { name:'History' });
    await waitFor(() => expect(layout.top()).toBe(2140 - 500)); // the divider is at 300; the old rule opened there
    expect(document.querySelector('[data-new]')).not.toBeNull();
  } finally { layout.restore(); }
});
it('keeps a short unread tail in view with its New divider, and a chat with nothing unread at the newest without the button', async () => {
  const layout = stackLayout();
  try {
    const { slot, recipients } = setup({ list: chatList([6]) });
    fireEvent.click(await recipients.findByRole('option')); await slot.findByRole('list', { name:'History' });
    await waitFor(() => expect(layout.top()).toBe(2140 - 500)); // the divider (1800) sits in the last screen
    expect(document.querySelector('[data-new]')).not.toBeNull(); expect(jumpButton().className).toContain('invisible');
    cleanup();
    const next = setup({ list: chatList([]) });
    fireEvent.click(await next.recipients.findByRole('option')); await next.slot.findByRole('list', { name:'History' });
    await waitFor(() => expect(layout.top()).toBe(2100 - 500));
    expect(document.querySelector('[data-new]')).toBeNull(); expect(jumpButton().className).toContain('invisible');
  } finally { layout.restore(); }
});
it('offers Jump to unread with the unread count of the contact badge while the first unread is out of sight above, and hides it once it is in view', async () => {
  const layout = stackLayout();
  try {
    const { slot, recipients } = setup({ recipients:[{ ...one, unread:6 }], list: chatList([1, 2, 3, 4, 5, 6]) });
    fireEvent.click(await recipients.findByRole('option')); await slot.findByRole('list', { name:'History' });
    await waitFor(() => expect(jumpButton().className).not.toContain('invisible'));
    expect(jumpButton().textContent).toBe('6 unread'); expect((await recipients.findAllByLabelText('6 unread')).length).toBeGreaterThan(0);
    layout.scroller().scrollTop = 0; fireEvent.scroll(layout.scroller()); // the first unread comes into view
    await waitFor(() => expect(jumpButton().className).toContain('invisible'));
  } finally { layout.restore(); }
});
it('jumps to the first unread at once, marking read only what is in view there and nothing between it and the newest', async () => {
  const layout = stackLayout(), markRead = vi.fn(() => ({ ok:true }));
  try {
    const { slot, recipients } = setup({ recipients:[{ ...one, unread:6 }], list: chatList([1, 2, 3, 4, 5, 6]), rpc:{ markRead } });
    fireEvent.click(await recipients.findByRole('option')); await slot.findByRole('list', { name:'History' });
    await waitFor(() => expect(jumpButton().className).not.toContain('invisible'));
    fireEvent.click(jumpButton()); expect(layout.top()).toBe(300); // set at once: a smooth scroll would pass over, and mark, rows in between
    fireEvent.scroll(layout.scroller()); await new Promise(r => setTimeout(r, 80));
    expect(markedIds(markRead)).toEqual(['ans_1']); // the view holds the New divider and the first unread only
    await waitFor(() => expect(jumpButton().className).toContain('invisible'));
  } finally { layout.restore(); }
});
it('leaves the unread rows above the first screen unread while the chat sits at the newest, and marks the ones in view', async () => {
  const layout = stackLayout(), markRead = vi.fn(() => ({ ok:true }));
  try {
    const { slot, recipients } = setup({ recipients:[{ ...one, unread:6 }], list: chatList([1, 2, 3, 4, 5, 6]), rpc:{ markRead } });
    fireEvent.click(await recipients.findByRole('option')); await slot.findByRole('list', { name:'History' });
    await waitFor(() => expect(layout.top()).toBe(2140 - 500));
    await settle(layout.scroller());
    expect(markedIds(markRead)).toEqual(['ans_5', 'ans_6']); // ans_1 to ans_4 lie above the view: not seen, not read
  } finally { layout.restore(); }
});
it('shows Jump to unread for a chat reopened at its remembered place with unread rows above it', async () => {
  localStorage.setItem('bb-plugin-answers:page:scroll', JSON.stringify({ thr_one: { top:5, depth:1, anchor:'ans_4', offset:0 } }));
  const layout = stackLayout();
  try {
    const { slot, recipients } = setup({ list: chatList([1], 7) });
    fireEvent.click(await recipients.findByRole('option')); await slot.findByRole('list', { name:'History' });
    await waitFor(() => expect(layout.top()).toBe(1240)); // ans_4's row (ans_0, the divider and ans_1 to ans_3 above it) at the top of the view
    await waitFor(() => expect(jumpButton().className).not.toContain('invisible'));
    expect(jumpButton().textContent).toBe('1 unread');
  } finally { layout.restore(); }
});

// A chat kept by Activity is display:none while another is open: a browser reads its scroll offset as 0 and ignores writes then.
// Moving an attached element in the DOM (React does it to a keyed child that changes place) resets the offsets inside it to 0.
// jsdom has no layout: each History row is 300 high and the New divider 40, stacked in DOM order inside a 500 high view.
function keptLayout() {
  const tops = new WeakMap<Element, number>();
  const hidden = (el: Element) => { for (let node: Element | null = el; node; node = node.parentElement) if ((node as HTMLElement).style?.display === 'none') return true; return false; };
  const isView = (el: Element) => el.classList.contains('overflow-auto') && !!el.querySelector('[aria-label=History]');
  const viewOf = (el: Element) => { let node: Element | null = el; while (node && !isView(node)) node = node.parentElement; return node; };
  const list = (view: Element) => view.querySelector('[aria-label=History]')!;
  const offsets = (view: Element) => { const map = new Map<Element, number>(); let y = 0; for (const el of Array.from(list(view).children)) { map.set(el, y); y += el.hasAttribute('data-new') ? 40 : 300; } return { map, total: y }; };
  const rowOf = (el: Element, view: Element) => { let node: Element | null = el; while (node && node.parentElement !== list(view)) node = node.parentElement; return node; };
  const zero = { top:0, bottom:0, left:0, right:0, width:0, height:0 } as DOMRect;
  const reset = (node: Node) => { if (node.isConnected && node instanceof Element) [node, ...Array.from(node.querySelectorAll('.overflow-auto'))].forEach(el => tops.set(el, 0)); };
  const insertBefore = Node.prototype.insertBefore, appendChild = Node.prototype.appendChild;
  Node.prototype.insertBefore = function <T extends Node>(this: Node, node: T, child: Node | null) { reset(node); return insertBefore.call(this, node, child) as T; };
  Node.prototype.appendChild = function <T extends Node>(this: Node, node: T) { reset(node); return appendChild.call(this, node) as T; };
  const spies = [
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return hidden(this) ? 0 : 500; }),
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return hidden(this) ? 0 : 400; }),
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return isView(this) && !hidden(this) ? offsets(this).total : 0; }),
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(function (this: HTMLElement) { return hidden(this) ? 0 : tops.get(this) ?? 0; }),
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function (this: HTMLElement, value: number) { if (!hidden(this)) tops.set(this, Math.max(0, Math.min(value, isView(this) ? offsets(this).total - 500 : 0))); }),
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) { const view = viewOf(this); return view ? offsets(view).map.get(this) ?? 0 : 0; }),
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (!this.isConnected || hidden(this)) return zero;
      const view = viewOf(this); if (!view) return zero;
      if (this === view) return { ...zero, top:0, bottom:500 } as DOMRect;
      const row = rowOf(this, view), off = row ? offsets(view).map.get(row) : undefined; if (!row || off === undefined) return zero;
      const top = off - (tops.get(view) ?? 0), height = row.hasAttribute('data-new') ? 40 : 300;
      return { ...zero, top, bottom: top + height, height } as DOMRect;
    }),
  ];
  // A resize observer that reports like a browser's: once on observe, then whenever the box size changes (display:none reads 0 by 0).
  const watching = new Set<{ callback: () => void; targets: Map<Element, string> }>();
  const size = (el: Element) => el.getAttribute('aria-label') === 'History' ? `${offsets(viewOf(el)!).total}` : `${(el as HTMLElement).clientWidth}x${(el as HTMLElement).clientHeight}`;
  vi.stubGlobal('ResizeObserver', class { entry = { callback: () => this.callback(), targets: new Map<Element, string>() }; constructor(private callback: () => void) { watching.add(this.entry); } observe(el: Element) { this.entry.targets.set(el, '0x0'); } unobserve() {} disconnect() { watching.delete(this.entry); } });
  const frame = setInterval(() => { for (const entry of [...watching]) { let changed = false; for (const [el, last] of entry.targets) { const now = size(el); if (now !== last && el.isConnected) { entry.targets.set(el, now); changed = true; } } if (changed && watching.has(entry)) entry.callback(); } }, 16);
  return { top: (view: Element) => hidden(view) ? NaN : tops.get(view) ?? 0, restore: () => { clearInterval(frame); Node.prototype.insertBefore = insertBefore; Node.prototype.appendChild = appendChild; vi.unstubAllGlobals(); spies.forEach(spy => spy.mockRestore()); } };
}
// Chat A: `rows` answered messages, 300 high each; its list pages by 3 when `paged`, and rows from `unreadFrom` on are unread.
const keptChats = (rows: () => number, paged: boolean, unreadFrom = 6) => (input: any) => {
  if (input.threadId !== 'thr_example_b') {
    const all = Array.from({ length: rows() }, (_, n) => ({ ...chatItem(n, n >= unreadFrom ? null : 1), threadId:'thr_example_a', id:`ans_a${n}` })).reverse(), at = Number(String(input.cursor ?? 0).split('|')[0]), size = paged ? 3 : all.length;
    return { items: all.slice(at, at + size), nextCursor: at + size < all.length ? `${at + size}|ans_a` : null };
  }
  return { items:[{ ...base, id:'ans_b', threadId:'thr_example_b', question:'Question b' }], nextCursor:null };
};
const keptSetup = (list: (input: any) => any) => {
  const people = [{ ...one, threadId:'thr_example_a', threadTitle:'Chat A', unread:0 }, { ...one, threadId:'thr_example_b', threadTitle:'Chat B', unread:0 }], { slot, recipients } = setup({ recipients:people, list });
  return { slot, open: async (name: RegExp, text: string) => { fireEvent.click(await recipients.findByRole('option', { name })); await slot.findByText(text); } };
};
// Chat A read to its newest, or left scrolled up at 400, then B opened: `grows` adds two unread rows to A while it is hidden.
it.each([
  ['read to the bottom, new messages arrive meanwhile', true, true],
  ['left scrolled up, new messages arrive meanwhile', false, true],
  ['left scrolled up, nothing new', false, false],
] as const)('a chat kept hidden while another is open returns to its place: %s', async (_name, atBottom, grows) => {
  const layout = keptLayout();
  try {
    let rows = 6;
    const { slot, open } = keptSetup(keptChats(() => rows, false));
    await open(/Chat A/, 'Question 5');
    const scroller = document.querySelector('[aria-label=History]')!.closest('.overflow-auto') as HTMLElement, history = scroller.querySelector('[aria-label=History]');
    await waitFor(() => expect(layout.top(scroller)).toBe(1300)); // 6 rows of 300 in a 500 view
    fireEvent.wheel(scroller); await new Promise(r => setTimeout(r, 80)); // the reader acts: the open hold ends
    if (!atBottom) { scroller.scrollTop = 400; fireEvent.scroll(scroller); await new Promise(r => requestAnimationFrame(() => r(0))); await new Promise(r => setTimeout(r, 250)); }
    const left = layout.top(scroller);
    await open(/Chat B/, 'Question b');
    expect(layout.top(scroller)).toBeNaN(); // hidden: a browser reads 0
    if (grows) { rows = 8; await slot.behavior.experimental_invalidateRpc(['answers:items']); }
    await open(/Chat A/, 'Question 5');
    if (grows) await waitFor(() => expect(within(scroller).getByText('Question 7')).toBeTruthy());
    await act(async () => { await new Promise(r => setTimeout(r, 100)); });
    expect(scroller.isConnected && scroller.querySelector('[aria-label=History]')).toBe(history); // not remounted
    // Never above where the reader was; a reader at the bottom follows what arrived meanwhile to its end.
    expect(layout.top(scroller)).toBe(atBottom && grows ? 1900 : left);
  } finally { layout.restore(); }
});
it('keeps a chat kept hidden at its place when earlier messages load right after it is shown again', async () => {
  const layout = keptLayout();
  try {
    const { slot, open } = keptSetup(keptChats(() => 9, true, 99));
    await open(/Chat A/, 'Question 8');
    const scroller = document.querySelector('[aria-label=History]')!.closest('.overflow-auto') as HTMLElement;
    await waitFor(() => expect(layout.top(scroller)).toBe(400)); // 3 rows of 300 in a 500 view
    fireEvent.wheel(scroller); await new Promise(r => setTimeout(r, 80));
    scroller.scrollTop = 250; fireEvent.scroll(scroller); await new Promise(r => requestAnimationFrame(() => r(0))); await new Promise(r => setTimeout(r, 250));
    await open(/Chat B/, 'Question b');
    await open(/Chat A/, 'Question 8');
    fireEvent.click(slot.getByRole('button', { name:'Load earlier' })); // as its sentinel does on coming into view
    await waitFor(() => expect(within(scroller).getByText('Question 5')).toBeTruthy());
    await act(async () => { await new Promise(r => setTimeout(r, 100)); });
    expect(layout.top(scroller)).toBe(250 + 900); // the three earlier rows pushed the reader down by their height
  } finally { layout.restore(); }
});
it('keeps a freshly opened chat at its newest while its content keeps growing after the first page arrived', async () => {
  const observers: (() => void)[] = [];
  vi.stubGlobal('ResizeObserver', class { constructor(private callback: () => void) { observers.push(() => this.callback()); } observe() {} disconnect() {} });
  const tops = new WeakMap<Element, number>(); let height = 3000;
  const spies = [
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500),
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400),
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => height),
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(function (this: HTMLElement) { return tops.get(this) ?? 0; }),
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function (this: HTMLElement, value: number) { tops.set(this, value); }),
  ];
  try {
    const deliver: ((value: object) => void)[] = [];
    const { slot, recipients } = setup({ list: () => new Promise(r => { deliver.push(r); }) });
    fireEvent.click(await recipients.findByRole('option'));
    await waitFor(() => expect(deliver.length).toBeGreaterThan(0)); // the chat is mounted, its first page still on the way
    await act(async () => { deliver.forEach(release => release({ items:[base], nextCursor:null })); }); await slot.findByRole('list', { name:'History' });
    const scroller = document.querySelector('[aria-label=History]')!.closest('.overflow-auto')!;
    await waitFor(() => expect(tops.get(scroller)).toBe(3000));
    height = 5000; observers.forEach(observe => observe()); // the cards finish rendering below the fold, with no input from the reader
    expect(tops.get(scroller)).toBe(5000);
  } finally { spies.forEach(spy => spy.mockRestore()); vi.unstubAllGlobals(); }
});
it('opens at the newest, and stays there, while the pages of a remembered depth arrive one after another', async () => {
  localStorage.setItem('bb-plugin-answers:page:scroll', JSON.stringify({ thr_example_a: { top:0, depth:3, bottom:true } }));
  const layout = keptLayout();
  try {
    const slow = keptChats(() => 9, true, 99), { slot, open } = keptSetup(input => input.cursor ? new Promise(r => setTimeout(() => r(slow(input)), 120)) : slow(input));
    await open(/Chat A/, 'Question 8');
    const scroller = document.querySelector('[aria-label=History]')!.closest('.overflow-auto') as HTMLElement;
    await waitFor(() => expect(within(scroller).getByText('Question 0')).toBeTruthy(), { timeout: 3000 }); // all three pages are in: 9 rows of 300
    await act(async () => { await new Promise(r => setTimeout(r, 200)); });
    expect(layout.top(scroller)).toBe(9 * 300 - 500);
  } finally { layout.restore(); localStorage.removeItem('bb-plugin-answers:page:scroll'); }
});
