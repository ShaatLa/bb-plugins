// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
const change = (element: Element, init: { target: { value?: string; files?: File[] } }) => { if (element.getAttribute('contenteditable') !== null) { (element as HTMLElement).dataset.testValue = init.target.value ?? ''; fireEvent.input(element); } else fireEvent.change(element, init); };
import { renderSlot as sdkRenderSlot } from '@get-bb/plugin-sdk/testing/app';
const renderSlot = ((slot: any, props: any, options: any = {}) => sdkRenderSlot(slot, props, { ...options, sdk: { ...options.sdk, threads: { ...options.sdk?.threads, queuedMessages: { list: () => Promise.resolve([]), ...options.sdk?.threads?.queuedMessages }, context: options.sdk?.threads?.context ?? (() => Promise.resolve({ usage: null })) } } })) as typeof sdkRenderSlot;
const cards = vi.hoisted(() => ({ renders: 0 }));
// The harness fixes sidebar threads at render; a test that needs a sidebar change sets sidebarOverride.threads and re-renders.
const sidebarOverride = vi.hoisted(() => ({ threads: undefined as any[] | undefined }));
vi.mock('@get-bb/plugin-sdk/app', async importOriginal => { const actual = await importOriginal<typeof import('@get-bb/plugin-sdk/app')>(); return { ...actual, experimental_useSidebarThreads: () => { const sidebar = actual.experimental_useSidebarThreads(); return sidebarOverride.threads ? { ...sidebar, threads: sidebarOverride.threads } : sidebar; } }; });
vi.mock('./app', async importOriginal => { const app = await importOriginal<typeof import('./app')>(); return { ...app, ItemCard: (props: Parameters<typeof app.ItemCard>[0]) => { cards.renders++; return app.ItemCard(props); } }; });
import { receivePage, History, Inbox, groupItems, followTo, atEnd } from './inbox';
import { itemSchema, type Item } from './contract';
const base: Item = itemSchema.parse({ id:'ans_one', kind:'mine', threadId:'thr_one', projectId:'pr_one', threadTitle:'One', projectName:'Project', status:'answered', question:'Question one', questionSeq:1, requestId:null, turnId:null, candidate:null, candidateSeq:null, interim:null, interimSeq:null, answer:'Answer one', answerSeq:2, answerSource:'turn', resolveTurnId:null, note:null, snoozedUntil:null, failedAt:null, likelyInterim:false, options:null, taskKey:null, readAt:null, pinned:false, dismissedAt:null, threadDeleted:false, createdAt:Date.now(), updatedAt:Date.now() });
const one = { threadId:'thr_one', threadTitle:'One', projectId:'pr_one', projectName:'Project', unread:1, lastAt:Date.now(), preview:'Answer one' };
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
function setup(options: { recipients?: typeof one[]; list?: (input: any) => any; send?: (input: any) => any; queuedMessages?: any; interactions?: any; context?: any; sidebarThreads?: any; rpc?: any; plugins?: any; props?: Record<string, unknown>; editMessage?: (input: any) => any } = {}) {
  const send = vi.fn(options.send ?? (() => Promise.resolve({}))), list = vi.fn(options.list ?? (() => ({ items:[base], nextCursor:null })));
  const slot = renderSlot({ component: Inbox }, options.props ?? {}, { rpc: { recipients: () => ({ recipients: options.recipients ?? [one] }), list, markRead: () => ({ ok:true }), markThreadRead: () => ({ ok:true }), ...options.rpc }, sdk: { threads: { send, editMessage: options.editMessage, queuedMessages: options.queuedMessages, interactions: options.interactions, context: options.context }, ...(options.plugins ? { plugins: options.plugins } : {}) }, sidebarThreads: options.sidebarThreads } as any);
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
  // A second click on the open contact lists the sub-sessions in tree order, as bb's sidebar nests them; a third hides them.
  const contact = recipients.getByRole('option', { name:/One/ });
  fireEvent.click(contact); expect(recipients.queryByRole('list', { name:'Sub-sessions of One' })).toBeNull();
  fireEvent.click(contact);
  const subs = within(recipients.getByRole('list', { name:'Sub-sessions of One' }));
  expect(subs.getAllByRole('listitem').map(li => [li.textContent, !!within(li).queryByRole('img', { name:'Working' }), li.style.paddingLeft])).toEqual([['Lead A', true, '32px'], ['Nested C', true, '56px'], ['Idle B', false, '32px']]);
  expect(subs.queryAllByRole('option')).toHaveLength(0); expect(subs.queryAllByRole('button')).toHaveLength(0);
  // Unbroken guides as bb draws them: a level's line runs under its parent's icon down to the middle of its last child.
  expect(subs.getAllByRole('listitem').map(li => Array.from(li.querySelectorAll<HTMLElement>('[data-guide]'), g => `${g.style.left} ${g.classList.contains('h-1/2') ? 'half' : 'full'}`))).toEqual([['24px full'], ['24px full', '40px half'], ['24px half']]);
  // They do not open; bb's thread menu on right-click gains Copy ID.
  fireEvent.contextMenu(subs.getByText('Nested C'));
  fireEvent.click(await slot.findByRole('menuitem', { name:'Copy ID' }));
  await waitFor(() => expect(slot.experimental_clipboardWrites).toEqual([{ text:'thr_c' }]));
  fireEvent.click(contact);
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
  expect(recipients.getByRole('option').className).toContain('opacity-70');
});
it('sends through browser SDK without originPluginId and passes draft submission', async () => {
  const { slot, recipients, send } = setup(); fireEvent.click(await recipients.findByRole('option'));
  const editor = await slot.findByRole('textbox', { name:'Send message' });
  change(editor, { target:{ value:'Hello' } }); fireEvent.click(slot.getByRole('button', { name:'More send options' })); fireEvent.click(slot.getByRole('menuitem', { name:'Save draft' }));
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(send.mock.calls[0]![0]).toMatchObject({ threadId:'thr_one', pluginSubmission:{ pluginId:'answers', data:{ kind:'draft' } } });
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
it('loads earlier pages when a search result is selected', async () => {
  const old = { ...base, id:'ans_old', question:'Ancient question', answer:'Ancient answer' };
  const { slot, recipients, list } = setup({ list: input => input.query ? { items:[old], nextCursor:null } : input.cursor ? { items:[old], nextCursor:null } : { items:[base], nextCursor:'1|ans_one' } });
  fireEvent.click(await recipients.findByRole('option')); await slot.findByText('Answer one');
  fireEvent.click(slot.getByRole('button', { name:'Search conversation' })); change(slot.getByRole('textbox', { name:'Search conversation' }), { target:{ value:'Ancient' } });
  fireEvent.click(await slot.findByRole('option', { name:/Ancient answer/ }));
  await waitFor(() => expect(list).toHaveBeenCalledWith(expect.objectContaining({ cursor:'1|ans_one' })));
  await waitFor(() => expect(document.querySelector('[data-history-ids~="ans_old"]')?.hasAttribute('data-flash')).toBe(true));
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
it('keeps a provider\'s last usage, marked out of date, when its refresh fails, as bb does', async () => {
  const ok = { codex:{ status:'ok', accountEmail:'me@example.com', planLabel:'Pro', windows:[{ label:'Weekly limit', usedPercent:42, resetsAt:new Date(Date.now() + 3600000).toISOString() }] } };
  const usageLimits = vi.fn(async () => ok as any);
  const slot = renderSlot({ component: Inbox }, {}, { rpc: { recipients: () => ({ recipients:[one] }), list: () => ({ items:[], nextCursor:null }) }, sdk: { system: { usageLimits } }, settings: { usage:'always', groupByProject:false } } as any);
  expect(await slot.findByText('42%')).toBeTruthy(); expect(slot.queryByRole('img', { name:'Usage may be out of date' })).toBeNull();
  usageLimits.mockImplementationOnce(async () => ({ codex:{ status:'error', message:'Provider unavailable', accountEmail:'me@example.com', planLabel:'Pro' } }));
  fireEvent.click(slot.getByRole('button', { name:'Refresh usage' }));
  const mark = await slot.findByRole('img', { name:'Usage may be out of date' });
  expect(mark.getAttribute('title')).toContain('Provider unavailable'); expect(slot.getByText('42%')).toBeTruthy();
  fireEvent.click(slot.getByRole('button', { name:'Refresh usage' }));
  await waitFor(() => expect(slot.queryByRole('img', { name:'Usage may be out of date' })).toBeNull()); expect(slot.getByText('42%')).toBeTruthy();
  localStorage.removeItem('bb-plugin-answers:page:usage-cache');
});
it('shows each provider\'s key limit on its tab when the usage panel is folded: weekly for Claude and Codex, Argon for Antigravity', async () => {
  const at = new Date(Date.now() + 3600000).toISOString();
  const usageLimits = vi.fn(async () => ({
    claude:{ status:'ok', windows:[{ label:'5h', kind:'five-hour', usedPercent:70, resetsAt:at }, { label:'Weekly limit', kind:'weekly', usedPercent:59, resetsAt:at }, { label:'Opus', kind:'weekly', usedPercent:90, resetsAt:at }] },
    antigravity:{ status:'ok', windows:[{ label:'Weekly', kind:'weekly', usedPercent:3, resetsAt:at }, { label:'Argon', kind:'weekly', usedPercent:96, resetsAt:at }] },
  }) as any);
  localStorage.setItem('bb-plugin-answers:page:usage-folded', 'true');
  try {
    const slot = renderSlot({ component: Inbox }, {}, { rpc: { recipients: () => ({ recipients:[one] }), list: () => ({ items:[], nextCursor:null }) }, sdk: { system: { usageLimits } }, settings: { usage:'always', groupByProject:false } } as any);
    await slot.findByRole('button', { name:'Expand usage' });
    await waitFor(() => expect(Array.from(document.querySelectorAll<HTMLElement>('[data-key-limit]'), node => [node.textContent, node.className.includes('text-destructive')])).toEqual([['59%', false], ['96%', true]]));
    expect(slot.queryByRole('button', { name:'All' })).toBeNull();
    fireEvent.click(slot.getByRole('button', { name:'Expand usage' }));
    expect(document.querySelectorAll('[data-key-limit]')).toHaveLength(0);
  } finally { localStorage.removeItem('bb-plugin-answers:page:usage-folded'); localStorage.removeItem('bb-plugin-answers:page:usage-cache'); }
});
it('spins the usage refresh icon until a manual refresh lands', async () => {
  let land: (value: unknown) => void = () => {};
  const usageLimits = vi.fn(async () => ({ codex:{ status:'ok', planLabel:'Pro', windows:[{ label:'Weekly limit', usedPercent:10, resetsAt:new Date(Date.now() + 3600000).toISOString() }] } }));
  const slot = renderSlot({ component: Inbox }, {}, { rpc: { recipients: () => ({ recipients:[one] }), list: () => ({ items:[], nextCursor:null }) }, sdk: { system: { usageLimits } }, settings: { usage:'always', groupByProject:false } } as any);
  const button = await slot.findByRole('button', { name:'Refresh usage' });
  await waitFor(() => expect(button.getAttribute('aria-busy')).toBe('false'));
  usageLimits.mockImplementationOnce(() => new Promise(resolve => { land = resolve; }) as any);
  fireEvent.click(button);
  await waitFor(() => expect(button.getAttribute('aria-busy')).toBe('true')); expect(button.querySelector('.animate-spin')).not.toBeNull();
  land(await usageLimits.getMockImplementation()!()); await waitFor(() => expect(slot.getByRole('button', { name:'Refresh usage' }).getAttribute('aria-busy')).toBe('false'));
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
  fireEvent.click(slot.getByRole('button', { name:'Copy' })); expect(writeText).toHaveBeenCalledWith('Question one');
  fireEvent.click(slot.getByRole('button', { name:'Save to Answers' }));
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
  const update = { ...base, id:'ans_plug', kind:'update' as const, status:'waiting' as const, question:'**ANV-1 · READY** from a lead', questionSeq:null, answer:null, answerSeq:null, trigger:{ kind:'plugin' as const, sourceId:'work-board', sourceTitle:null } };
  const { slot, recipients } = setup({ list: () => ({ items:[update], nextCursor:null }) });
  fireEvent.click(await recipients.findByRole('option'));
  await slot.findByText(/READY/);
  expect(within(document.querySelector('[data-history-ids="ans_plug"]') as HTMLElement).getByRole('img', { name:'Working on the message' })).toBeTruthy();
});
it('shows the message a plugin sent as bb does: a user bubble with all of its text, the reply below', async () => {
  const update = { ...base, id:'ans_plug', kind:'update' as const, question:'**CI Dashboard** · `Deploy finished` main\n- Run: 42', questionSeq:null, answer:'Deployed', answerSeq:7, trigger:{ kind:'plugin' as const, sourceId:'delivery-dashboard', sourceTitle:null } };
  const { slot, recipients } = setup({ list: () => ({ items:[update], nextCursor:null }) });
  fireEvent.click(await recipients.findByRole('option'));
  await slot.findByText('Deployed');
  const bubble = document.querySelector('[data-history-ids="ans_plug"] [data-plugin-message]') as HTMLElement;
  expect(bubble.textContent).toContain('Deploy finished'); expect(bubble.textContent).toContain('Run: 42');
  expect(document.querySelector('[data-history-ids="ans_plug"] [data-update-caption]')).toBeNull();
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
it('keeps the list and the previous conversation on screen while switching', async () => {
  let release!: () => void;
  const two = { ...one, threadId:'thr_two', threadTitle:'Two', preview:'Answer two' };
  const { slot, recipients } = setup({ recipients:[one, two], list: (input: any) => input.threadId === 'thr_two' && input.view !== 'for_me'
    ? new Promise(resolve => { release = () => resolve({ items:[{ ...base, id:'ans_two', threadId:'thr_two', question:'Question two', answer:'Answer two' }], nextCursor:null }); })
    : { items:[base], nextCursor:null } });
  fireEvent.click((await recipients.findAllByRole('option'))[0]!);
  expect(await slot.findByText('Question one')).toBeTruthy();
  fireEvent.click(recipients.getAllByRole('option')[1]!);
  expect(recipients.getAllByRole('option')).toHaveLength(2);
  expect(slot.getByText('Question one')).toBeTruthy();
  await act(async () => { release(); });
  expect(await slot.findByText('Question two')).toBeTruthy();
  expect(slot.queryByText('Question one')).toBeNull();
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
  const slot = renderSlot({ component: Inbox }, {}, { rpc: { recipients: () => ({ recipients: rows }), list: () => ({ items:[], nextCursor:null }) }, settings: { groupByProject: true } } as any);
  const list = slot.getByRole('listbox', { name:'Recipients' });
  await within(list).findAllByRole('option');
  expect(Array.from(list.querySelectorAll('p, [role=option]')).map(node => node.tagName === 'P' ? node.textContent : node.querySelector('.truncate')!.textContent)).toEqual(['Acme', 'A', 'C', 'Plugins', 'B']);
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
it('shows usage when set to always and changes contact preferences from the footer menu', async () => {
  const setPreferences = vi.fn(() => ({ ok:true }));
  const usageLimits = vi.fn(async () => ({ codex:{ status:'ok', planLabel:'Pro', windows:[{ label:'Weekly limit', usedPercent:91, resetsAt:new Date(Date.now() + 26 * 3600000).toISOString() }] }, 'local-models':{ status:'ok', windows:[{ label:'Flint', usedPercent:0, resetsAt:null }] } }));
  const slot = renderSlot({ component: Inbox }, {}, { rpc: { recipients: () => ({ recipients:[one] }), list: () => ({ items:[], nextCursor:null }), setPreferences }, sdk: { system: { usageLimits } }, settings: { usage:'always', groupByProject:false } } as any);
  const usage = await slot.findByLabelText('Usage');
  expect(usage.textContent).toContain('Weekly limit');
  expect(usage.textContent).toContain('91%');
  expect(usage.textContent).toMatch(/1d [12]h/);
  expect(usage.textContent).not.toContain('Flint');
  fireEvent.click(slot.getByRole('button', { name:'Contact list settings' }));
  fireEvent.click(slot.getByRole('menuitemcheckbox', { name:'Group by project' }));
  await waitFor(() => expect(setPreferences).toHaveBeenCalledWith({ groupByProject:true }));
  fireEvent.click(slot.getByRole('menuitemradio', { name:'Never' }));
  await waitFor(() => expect(setPreferences).toHaveBeenCalledWith({ usage:'never' }));
});
it('names usage windows the way bb does', async () => {
  const { windowLabel } = await import('./contacts-footer');
  expect(windowLabel({ label:'Weekly limit', kind:'weekly', usedPercent:0, resetsAt:null })).toBe('7d');
  expect(windowLabel({ label:'Fable', kind:'weekly', usedPercent:0, resetsAt:null })).toBe('7d · Fable');
  expect(windowLabel({ label:'7d · Argon', kind:'weekly', usedPercent:0, resetsAt:null })).toBe('7d · Argon');
  expect(windowLabel({ label:'5h', kind:'five-hour', usedPercent:0, resetsAt:null })).toBe('5h');
  expect(windowLabel({ label:'Flint⁣', usedPercent:0, resetsAt:null })).toBe('Flint');
});
it('orders project groups and saves a dragged order in plugin settings', async () => {
  const rows = [{ ...one, threadId:'thr_a', threadTitle:'A', projectId:'pa', projectName:'Acme' }, { ...one, threadId:'thr_b', threadTitle:'B', projectId:'pb', projectName:'Plugins' }];
  const setPreferences = vi.fn(() => ({ ok:true }));
  const slot = renderSlot({ component: Inbox }, {}, { rpc: { recipients: () => ({ recipients: rows }), list: () => ({ items:[], nextCursor:null }), setPreferences }, settings: { groupByProject: true, projectOrder: 'gone,pb' }, sidebarThreads: { threads: [], projects: [{ id:'personal', name:'Personal', isPersonal:true }, { id:'pb', name:'Plugins', isPersonal:false }, { id:'pa', name:'Acme', isPersonal:false }] } } as any);
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
it('drops the pending bubble when bb queues the message, since the queue card shows it', async () => {
  const { slot, recipients } = setup({ send: () => Promise.resolve({ ok:true, delivery:'queued' }) }); fireEvent.click(await recipients.findByRole('option'));
  change(await slot.findByRole('textbox', { name:'Send message' }), { target:{ value:'Queued one' } }); fireEvent.click(slot.getByRole('button', { name:'Send message' }));
  await waitFor(() => expect(slot.queryByRole('button', { name:'Toggle queued messages' })).toBeNull());
});
it('shows a quoted queued reply as the quote line and the message line', async () => {
  const row = { id:'q1', threadId:'thr_one', content:[{ type:'text', text:'> Quoted passage\n\nMy reply', mentions:[] }], updatedAt:1 };
  const { slot, recipients } = setup({ queuedMessages: { list: () => Promise.resolve([row]) } }); fireEvent.click(await recipients.findByRole('option'));
  const card = await slot.findByRole('region', { name:'Queued messages' });
  await waitFor(() => expect(within(card).getAllByTestId('bb-markdown').map(node => node.textContent)).toEqual(['Quoted passage', 'My reply']));
});
it('renders queued messages and sends or deletes them through the SDK', async () => {
  const row = { id:'q1', threadId:'thr_one', content:[{ type:'text', text:'Waiting text', mentions:[] }], updatedAt:1 };
  const sendNow = vi.fn(() => Promise.resolve({})), remove = vi.fn(() => Promise.resolve({}));
  const { slot, recipients } = setup({ queuedMessages: { list: () => Promise.resolve([row]), send:sendNow, delete:remove } }); fireEvent.click(await recipients.findByRole('option'));
  expect(await slot.findByText('Waiting text')).toBeTruthy();
  fireEvent.click(slot.getByRole('button', { name:'Send queued message 1 now' })); await waitFor(() => expect(sendNow).toHaveBeenCalledWith({ threadId:'thr_one', queuedMessageId:'q1', mode:'auto' }));
  fireEvent.click(slot.getByRole('button', { name:'Delete queued message 1' })); await waitFor(() => expect(remove).toHaveBeenCalledWith({ threadId:'thr_one', queuedMessageId:'q1' }));
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
it('says why a queued message is held, as bb does', async () => {
  const row = { id:'q1', threadId:'thr_one', content:[{ type:'text', text:'Held text', mentions:[] }], updatedAt:1, waitingOn:{ kind:'plugin', pluginId:'concurrency-limit', reason:'14 of 14 running on host Mac' } };
  const { slot, recipients } = setup({ queuedMessages: { list: () => Promise.resolve([row]) }, plugins: { list: async () => ({ plugins:[{ id:'concurrency-limit', name:'Concurrency limit', icon:'Gauge' }] }) } }); fireEvent.click(await recipients.findByRole('option'));
  expect(await slot.findByText('Held by Concurrency limit · 14 of 14 running on host Mac')).toBeTruthy();
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
  view.getBoundingClientRect = () => ({ top:0, bottom:500 }) as DOMRect; last.getBoundingClientRect = () => ({ top:900, bottom:1000 }) as DOMRect;
  const scrollTo = vi.fn(); view.scrollTo = scrollTo as any;
  fireEvent.scroll(view);
  await waitFor(() => expect(button.className).not.toContain('invisible'));
  fireEvent.click(button); expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior:'smooth' }));
  last.getBoundingClientRect = () => ({ top:300, bottom:450 }) as DOMRect; fireEvent.scroll(view);
  await waitFor(() => expect(button.className).toContain('invisible'));
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
  const { slot, recipients } = setup({ queuedMessages: { list: () => Promise.resolve([row]), experimental_holdForEdit:hold, update, experimental_releaseEditHold:release } }); fireEvent.click(await recipients.findByRole('option'));
  fireEvent.click(await slot.findByRole('button', { name:'Edit queued message 1' }));
  const editor = await slot.findByRole('textbox', { name:'Edit queued message' });
  expect(hold).toHaveBeenCalledWith({ threadId:'thr_one', queuedMessageId:'q1' });
  expect(slot.getByText('old.txt')).toBeTruthy();
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

it('follows new content at the bottom but stops a long arrival at its start', () => {
  // View 600 tall, 150 covered by the header, composer and margin; the content was 2000 tall with the reader at the bottom.
  expect(followTo(1400, 2100, 600, 2000, 150)).toBe(1500); // a short arrival: back to the bottom
  expect(followTo(1400, 4000, 600, 2000, 150)).toBe(1850); // a long reply: its start stays in view
  expect(followTo(1400, 2000, 500, 2000, 150)).toBe(1500); // the view shrank (keyboard): the bottom edge is kept
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

it('does not poll usage while auto usage is hidden', async () => {
  const usageLimits = vi.fn(async () => ({}));
  const slot = renderSlot({ component: Inbox }, {}, { rpc: { recipients: () => ({ recipients:[one] }), list: () => ({ items:[], nextCursor:null }) }, sdk: { system:{ usageLimits } }, settings:{ usage:'auto' } } as any);
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
