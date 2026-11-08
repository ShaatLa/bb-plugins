// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { renderSlot } from '@get-bb/plugin-sdk/testing/app';
import { Inbox } from './inbox';
import { itemSchema, type Item } from './contract';
const base: Item = itemSchema.parse({ id:'ans_one', kind:'mine', threadId:'thr_one', projectId:'pr_one', threadTitle:'One', projectName:'Project', status:'answered', question:'Question one', questionSeq:1, requestId:null, turnId:null, candidate:null, candidateSeq:null, interim:null, interimSeq:null, answer:'Answer one', answerSeq:2, answerSource:'turn', resolveTurnId:null, note:null, snoozedUntil:null, failedAt:null, likelyInterim:false, options:null, taskKey:null, readAt:null, pinned:false, dismissedAt:null, threadDeleted:false, createdAt:Date.now(), updatedAt:Date.now() });
const one = { threadId:'thr_one', threadTitle:'One', projectId:'pr_one', projectName:'Project', unread:1, lastAt:Date.now(), preview:'Answer one' };
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
function setup(options: { recipients?: typeof one[]; list?: (input: any) => any; send?: (input: any) => any } = {}) {
  const send = vi.fn(options.send ?? (() => Promise.resolve({}))), list = vi.fn(options.list ?? (() => ({ items:[base], nextCursor:null })));
  const slot = renderSlot({ component: Inbox }, {}, { rpc: { recipients: () => ({ recipients: options.recipients ?? [one] }), list, markRead: () => ({ ok:true }), markThreadRead: () => ({ ok:true }) }, sdk: { threads: { send } } });
  const recipients = within(slot.getByRole('listbox', { name:'Recipients' }));
  return { slot, recipients, send, list };
}
it('mutes read rows, shows the caught-up line, and previews failures', async () => {
  const { slot, recipients } = setup({ recipients:[{ ...one, unread:0, preview:'Turn failed: Question one' }] });
  expect(await slot.findByText('All caught up')).toBeTruthy();
  expect(recipients.getByText('Turn failed: Question one')).toBeTruthy();
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
  await waitFor(() => expect(document.querySelector('[data-history-id="ans_old"]')?.hasAttribute('data-flash')).toBe(true));
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
  expect(document.querySelectorAll('[data-history-id]')).toHaveLength(1);
});
