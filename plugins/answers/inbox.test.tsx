// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { renderSlot as sdkRenderSlot } from '@get-bb/plugin-sdk/testing/app';
const renderSlot = ((slot: any, props: any, options: any = {}) => sdkRenderSlot(slot, props, { ...options, sdk: { ...options.sdk, threads: { ...options.sdk?.threads, queuedMessages: { list: () => Promise.resolve([]), ...options.sdk?.threads?.queuedMessages }, context: options.sdk?.threads?.context ?? (() => Promise.resolve({ usage: null })) } } })) as typeof sdkRenderSlot;
import { Inbox } from './inbox';
import { itemSchema, type Item } from './contract';
const base: Item = itemSchema.parse({ id:'ans_one', kind:'mine', threadId:'thr_one', projectId:'pr_one', threadTitle:'One', projectName:'Project', status:'answered', question:'Question one', questionSeq:1, requestId:null, turnId:null, candidate:null, candidateSeq:null, interim:null, interimSeq:null, answer:'Answer one', answerSeq:2, answerSource:'turn', resolveTurnId:null, note:null, snoozedUntil:null, failedAt:null, likelyInterim:false, options:null, taskKey:null, readAt:null, pinned:false, dismissedAt:null, threadDeleted:false, createdAt:Date.now(), updatedAt:Date.now() });
const one = { threadId:'thr_one', threadTitle:'One', projectId:'pr_one', projectName:'Project', unread:1, lastAt:Date.now(), preview:'Answer one' };
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
function setup(options: { recipients?: typeof one[]; list?: (input: any) => any; send?: (input: any) => any; queuedMessages?: any; context?: any; sidebarThreads?: any } = {}) {
  const send = vi.fn(options.send ?? (() => Promise.resolve({}))), list = vi.fn(options.list ?? (() => ({ items:[base], nextCursor:null })));
  const slot = renderSlot({ component: Inbox }, {}, { rpc: { recipients: () => ({ recipients: options.recipients ?? [one] }), list, markRead: () => ({ ok:true }), markThreadRead: () => ({ ok:true }) }, sdk: { threads: { send, queuedMessages: options.queuedMessages, context: options.context } }, sidebarThreads: options.sidebarThreads } as any);
  const recipients = within(slot.getByRole('listbox', { name:'Recipients' }));
  return { slot, recipients, send, list };
}
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
  fireEvent.change(editor, { target:{ value:'Hello' } }); fireEvent.click(slot.getByRole('button', { name:'More send options' })); fireEvent.click(slot.getByRole('menuitem', { name:'Save draft' }));
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(send.mock.calls[0]![0]).toMatchObject({ threadId:'thr_one', pluginSubmission:{ pluginId:'answers', data:{ kind:'draft' } } });
  expect(send.mock.calls[0]![0]).not.toHaveProperty('originPluginId');
});
it('keeps a failed draft and edits made during a pending send', async () => {
  let reject!: (error: Error) => void;
  const { slot, recipients, send } = setup({ send: () => new Promise((_, no) => { reject = no; }) }); fireEvent.click(await recipients.findByRole('option'));
  const editor = await slot.findByRole('textbox', { name:'Send message' }); fireEvent.change(editor, { target:{ value:'First' } }); fireEvent.click(slot.getByRole('button', { name:'Send message' }));
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
  await act(async () => { reject(new Error('Offline')); });
  expect((editor as HTMLTextAreaElement).value).toBe('First');
  expect(localStorage.getItem('bb-plugin-answers:page:compose')).toContain('First');
  expect(slot.getByRole('alert').textContent).toContain('Delivery uncertain');
});
it('loads earlier pages when a search result is selected', async () => {
  const old = { ...base, id:'ans_old', question:'Ancient question', answer:'Ancient answer' };
  const { slot, recipients, list } = setup({ list: input => input.query ? { items:[old], nextCursor:null } : input.cursor ? { items:[old], nextCursor:null } : { items:[base], nextCursor:'1|ans_one' } });
  fireEvent.click(await recipients.findByRole('option')); await slot.findByText('Answer one');
  fireEvent.click(slot.getByRole('button', { name:'Search conversation' })); fireEvent.change(slot.getByRole('textbox', { name:'Search conversation' }), { target:{ value:'Ancient' } });
  fireEvent.click(await slot.findByRole('option', { name:/Ancient answer/ }));
  await waitFor(() => expect(list).toHaveBeenCalledWith(expect.objectContaining({ cursor:'1|ans_one' })));
  await waitFor(() => expect(document.querySelector('[data-history-ids~="ans_old"]')?.hasAttribute('data-flash')).toBe(true));
});

it('retains a newer edit after the sent snapshot resolves', async () => {
  let resolve!: (value: object) => void;
  const { slot, recipients } = setup({ send: () => new Promise(done => { resolve = done; }) }); fireEvent.click(await recipients.findByRole('option'));
  const editor = await slot.findByRole('textbox', { name:'Send message' }); fireEvent.change(editor, { target:{ value:'First' } }); fireEvent.click(slot.getByRole('button', { name:'Send message' }));
  fireEvent.change(editor, { target:{ value:'Second' } }); await act(async () => { resolve({}); });
  expect((editor as HTMLTextAreaElement).value).toBe('Second'); expect(localStorage.getItem('bb-plugin-answers:page:compose')).toContain('Second');
});
it('keeps a send tied to its original thread after switching', async () => {
  let resolve!: (value: object) => void; const two = { ...one, threadId:'thr_two', threadTitle:'Two', preview:'Second preview' };
  const { slot, recipients, send } = setup({ recipients:[one, two], send: () => new Promise(done => { resolve = done; }) });
  fireEvent.click((await recipients.findAllByRole('option'))[0]!); const editor = await slot.findByRole('textbox', { name:'Send message' });
  fireEvent.change(editor, { target:{ value:'For one' } }); fireEvent.click(slot.getByRole('button', { name:'Send message' }));
  fireEvent.click(recipients.getAllByRole('option')[1]!); fireEvent.change(slot.getByRole('textbox', { name:'Send message' }), { target:{ value:'For two' } });
  await act(async () => { resolve({}); }); expect(send.mock.calls[0]![0].threadId).toBe('thr_one');
  expect((slot.getByRole('textbox', { name:'Send message' }) as HTMLTextAreaElement).value).toBe('For two');
});
it('groups consecutive questions with a shared answer', async () => {
  const other = { ...base, id:'ans_two', question:'Question two', questionSeq:3, answer:'Shared answer', turnId:'turn_one', answerSeq:4 };
  const first = { ...base, answer:'Shared answer', turnId:'turn_one', answerSeq:4 };
  const { slot, recipients } = setup({ list: () => ({ items:[other, first], nextCursor:null }) }); fireEvent.click(await recipients.findByRole('option'));
  await slot.findByText('Shared answer'); expect(slot.getAllByText('Shared answer')).toHaveLength(1);
  expect(document.querySelectorAll('[data-history-ids]')).toHaveLength(1);
});
it('shows Reply only on agent questions in the conversation', async () => {
  const agentQuestion = { ...base, id:'ans_agent', kind:'for_me' as const, status:'open' as const, question:'Choose?', answer:null, answerSeq:null, options:['Yes'] };
  const { slot, recipients } = setup({ list: () => ({ items:[agentQuestion, base], nextCursor:null }) });
  fireEvent.click(await recipients.findByRole('option'));
  await slot.findByText('Choose?');
  expect(within(document.querySelector('[data-history-ids="ans_one"]')!).queryByRole('button', { name:'Reply' })).toBeNull();
  expect(within(document.querySelector('[data-history-ids="ans_agent"]')!).getByRole('button', { name:'Reply' })).toBeTruthy();
  expect(slot.getByRole('button', { name:'Yes' })).toBeTruthy();
});
it('keeps the list and the previous conversation on screen while switching', async () => {
  let release!: () => void;
  const two = { ...one, threadId:'thr_two', threadTitle:'Two', preview:'Answer two' };
  const { slot, recipients } = setup({ recipients:[one, two], list: (input: any) => input.threadId === 'thr_two'
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
  const rows = [{ ...one, threadId:'thr_a', threadTitle:'A', projectId:'pa', projectName:'Anvil' }, { ...one, threadId:'thr_b', threadTitle:'B', projectId:'pb', projectName:'Plugins' }, { ...one, threadId:'thr_c', threadTitle:'C', projectId:'pa', projectName:'Anvil' }];
  const slot = renderSlot({ component: Inbox }, {}, { rpc: { recipients: () => ({ recipients: rows }), list: () => ({ items:[], nextCursor:null }) }, settings: { groupByProject: true } } as any);
  const list = slot.getByRole('listbox', { name:'Recipients' });
  await within(list).findAllByRole('option');
  expect(Array.from(list.querySelectorAll('p, [role=option]')).map(node => node.tagName === 'P' ? node.textContent : node.querySelector('.truncate')!.textContent)).toEqual(['Anvil', 'A', 'C', 'Plugins', 'B']);
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
  const rows = [{ ...one, threadId:'thr_a', threadTitle:'A', projectId:'pa', projectName:'Anvil' }, { ...one, threadId:'thr_b', threadTitle:'B', projectId:'pb', projectName:'Plugins' }];
  const setPreferences = vi.fn(() => ({ ok:true }));
  const slot = renderSlot({ component: Inbox }, {}, { rpc: { recipients: () => ({ recipients: rows }), list: () => ({ items:[], nextCursor:null }), setPreferences }, settings: { groupByProject: true, projectOrder: 'gone,pb' }, sidebarThreads: { threads: [], projects: [{ id:'personal', name:'Personal', isPersonal:true }, { id:'pb', name:'Plugins', isPersonal:false }, { id:'pa', name:'Anvil', isPersonal:false }] } } as any);
  const list = slot.getByRole('listbox', { name:'Recipients' });
  await within(list).findAllByRole('option');
  const headers = () => Array.from(list.querySelectorAll('p')).map(node => node.textContent);
  expect(headers()).toEqual(['Plugins', 'Anvil']);
  fireEvent.dragStart(within(list).getByText('Anvil'), { dataTransfer: { setData: () => {}, effectAllowed: '' } });
  const plugins = within(list).getByRole('group', { name:'Plugins' });
  fireEvent.dragOver(plugins, { clientY: -1 });
  fireEvent.drop(plugins, { clientY: -1 });
  expect(headers()).toEqual(['Anvil', 'Plugins']);
  await waitFor(() => expect(setPreferences).toHaveBeenCalledWith({ projectOrder:'pa,pb' }));
});

it('shows a pending bubble until the matching newest item arrives, and skips drafts', async () => {
  let items = [base];
  const { slot, recipients } = setup({ list: () => ({ items, nextCursor:null }) }); fireEvent.click(await recipients.findByRole('option'));
  const editor = await slot.findByRole('textbox', { name:'Send message' });
  fireEvent.change(editor, { target:{ value:'New message' } }); fireEvent.click(slot.getByRole('button', { name:'Send message' }));
  expect(slot.container.textContent).not.toContain('Sending…'); expect(slot.getAllByText('New message').length).toBeGreaterThan(0);
  items = [{ ...base, id:'ans_new', question:'New message' }, base];
  await act(async () => { fireEvent.click(recipients.getByRole('option')); });
  await waitFor(() => expect(slot.queryByText('Sending…')).toBeNull());
  fireEvent.change(editor, { target:{ value:'Draft only' } }); fireEvent.click(slot.getByRole('button', { name:'More send options' })); fireEvent.click(slot.getByRole('menuitem', { name:'Save draft' }));
  expect(slot.queryByText('Sending…')).toBeNull();
});
it('drops the pending bubble when bb queues the message, since the queue card shows it', async () => {
  const { slot, recipients } = setup({ send: () => Promise.resolve({ ok:true, delivery:'queued' }) }); fireEvent.click(await recipients.findByRole('option'));
  fireEvent.change(await slot.findByRole('textbox', { name:'Send message' }), { target:{ value:'Queued one' } }); fireEvent.click(slot.getByRole('button', { name:'Send message' }));
  await waitFor(() => expect(slot.queryByText('Queued one')).toBeNull());
});
it('renders queued messages and sends or deletes them through the SDK', async () => {
  const row = { id:'q1', threadId:'thr_one', content:[{ type:'text', text:'Waiting text', mentions:[] }], updatedAt:1 };
  const sendNow = vi.fn(() => Promise.resolve({})), remove = vi.fn(() => Promise.resolve({}));
  const { slot, recipients } = setup({ queuedMessages: { list: () => Promise.resolve([row]), send:sendNow, delete:remove } }); fireEvent.click(await recipients.findByRole('option'));
  expect(await slot.findByText('Waiting text')).toBeTruthy();
  fireEvent.click(slot.getByRole('button', { name:'Send queued message 1 now' })); await waitFor(() => expect(sendNow).toHaveBeenCalledWith({ threadId:'thr_one', queuedMessageId:'q1', mode:'auto' }));
  fireEvent.click(slot.getByRole('button', { name:'Delete queued message 1' })); await waitFor(() => expect(remove).toHaveBeenCalledWith({ threadId:'thr_one', queuedMessageId:'q1' }));
});
it('edits queued text and attachments through the composer, holding it while edited', async () => {
  const row = { id:'q1', threadId:'thr_one', content:[{ type:'text', text:'Waiting text', mentions:[] }, { type:'localFile', path:'/old', name:'old.txt' }], model:'opus', reasoningLevel:'high', serviceTier:'default', permissionMode:'auto', updatedAt:7 };
  const hold = vi.fn(() => Promise.resolve({})), update = vi.fn(() => Promise.resolve({})), release = vi.fn(() => Promise.resolve({}));
  const { slot, recipients } = setup({ queuedMessages: { list: () => Promise.resolve([row]), experimental_holdForEdit:hold, update, experimental_releaseEditHold:release } }); fireEvent.click(await recipients.findByRole('option'));
  fireEvent.click(await slot.findByRole('button', { name:'Edit queued message 1' }));
  const editor = await slot.findByRole('textbox', { name:'Edit queued message' });
  expect(hold).toHaveBeenCalledWith({ threadId:'thr_one', queuedMessageId:'q1' });
  expect(slot.getByText('old.txt')).toBeTruthy();
  fireEvent.change(editor, { target:{ value:'Changed text' } }); fireEvent.click(slot.getByRole('button', { name:'Remove old.txt' })); fireEvent.click(slot.getByRole('button', { name:'Confirm queued message edit' }));
  await waitFor(() => expect(update).toHaveBeenCalledWith({ threadId:'thr_one', queuedMessageId:'q1', expectedUpdatedAt:7, model:'opus', reasoningLevel:'high', serviceTier:'default', permissionMode:'auto', input:[{ type:'text', text:'Changed text', mentions:[] }] }));
  await waitFor(() => expect(release).toHaveBeenCalledWith({ threadId:'thr_one', queuedMessageId:'q1' }));
  fireEvent.click(slot.getByRole('button', { name:'Edit queued message 1' })); fireEvent.keyDown(await slot.findByRole('textbox', { name:'Edit queued message' }), { key:'Escape' });
  await waitFor(() => expect(release).toHaveBeenCalledTimes(2)); expect(update).toHaveBeenCalledTimes(1);
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
  fireEvent.change(slot.getByLabelText('Send at'), { target:{ value:local } }); fireEvent.click(slot.getByRole('button', { name:'Schedule' }));
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
  expect(await slot.findByText('Plugins')).toBeTruthy(); expect(slot.getByText('answers/3g').parentElement!.getAttribute('title')).toBe('Worktree'); expect(await slot.findByRole('button', { name:'Context window 38% used' })).toBeTruthy();
});
