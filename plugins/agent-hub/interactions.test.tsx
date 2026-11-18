// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { renderSlot } from '@get-bb/plugin-sdk/testing/app';
import { PendingInteractions, QuestionForm, answerText } from './interactions';

const host = vi.hoisted(() => ({ bound: true, choices: [] as ((n: number) => boolean)[] }));
vi.mock('@get-bb/plugin-sdk/app', async importOriginal => ({ ...await importOriginal<typeof import('@get-bb/plugin-sdk/app')>(), experimental_useQuestionFormHost: () => ({ shortcuts: host.bound ? new Map([['0', { label: '1', ariaKeyshortcuts: '1' }], ['1', { label: '2', ariaKeyshortcuts: '2' }], ['2', { label: '3', ariaKeyshortcuts: '3' }]]) : new Map(), actionShortcuts: new Map([['cancel', { ariaKeyshortcuts: 'Meta+.' }], ['submit', { ariaKeyshortcuts: 'Meta+Enter' }]]), registerChoiceHandler: (handler: (n: number) => boolean) => { host.choices.push(handler); return () => { host.choices.splice(host.choices.indexOf(handler), 1); }; }, registerActionHandler: () => () => {} }) }));

afterEach(() => { cleanup(); host.bound = true; localStorage.clear(); });
const question = (overrides = {}) => ({ id: 'i1', threadId: 'thr_one', status: 'pending', payload: { kind: 'user_question', questions: [{ id: 'q1', prompt: 'Choose?', shortLabel: 'Choice', required: true, multiSelect: false, allowFreeText: true, options: [{ value: 'a', label: 'Alpha', description: 'First' }, { value: 'b', label: 'Beta', description: 'Second' }] }] }, ...overrides });
function setup(rows: any[], pending = true) {
  const list = vi.fn(async () => rows), resolve = vi.fn(async () => ({})), respond = vi.fn(async () => ({})), cancel = vi.fn(async () => ({})), stop = vi.fn(async () => ({}));
  const slot = renderSlot({ component: PendingInteractions }, { threadId: 'thr_one', pending }, { sdk: { threads: { interactions: { list, resolve, respond, cancel }, stop } } } as any);
  return { slot, list, resolve, respond, cancel, stop };
}
it('renders provider options with descriptions and resolves the chosen value', async () => {
  const { slot, resolve } = setup([question()]);
  expect((await slot.findAllByText('Choose?')).length).toBeGreaterThan(0); expect(slot.getByText('First')).toBeTruthy();
  fireEvent.click(slot.getByRole('button', { name: /Alpha/ })); fireEvent.click(slot.getByRole('button', { name: 'Submit answer' }));
  await waitFor(() => expect(resolve).toHaveBeenCalledWith({ threadId: 'thr_one', interactionId: 'i1', resolution: { kind: 'user_answer', answers: { q1: { selected: ['a'] } } } }));
});
it('uses bb option hints, Other label, and action shortcuts', async () => {
  const { slot } = setup([question()]);
  await slot.findAllByText('Choose?');
  const form = slot.container.querySelector('[data-question-form]')!;
  expect(Array.from(form.querySelectorAll('kbd')).map(node => node.textContent)).toEqual(['1', '2', '3']);
  expect(Array.from(form.querySelectorAll('button[aria-keyshortcuts]')).map(node => node.getAttribute('aria-keyshortcuts'))).toEqual(['1', '2', '3', 'Meta+.', 'Meta+Enter']);
  expect(slot.getByRole('button', { name: /Other…/ }).querySelector('.min-w-0.flex-1 .block.text-xs')?.textContent).toBe('Other…');
  expect(form.querySelectorAll('fieldset > div')).toHaveLength(2);
  expect(form.closest('[data-pending-question-card]')).toBeTruthy();
});
it('renders bb tabs and the question counter', async () => {
  const row = question(); row.payload.questions.push({ ...row.payload.questions[0]!, id: 'q2', shortLabel: 'Second' });
  const { slot } = setup([row]); await slot.findAllByText('Choose?');
  expect(slot.container.querySelector('[data-question-tabs]')?.textContent).toContain('Second');
  expect(slot.getByText('1 of 2')).toBeTruthy();
  fireEvent.click(slot.getByRole('button', { name: 'Second' }));
  expect(slot.getByText('2 of 2')).toBeTruthy();
});
it('allows multiple selections and free text', async () => {
  const row = question(); row.payload.questions[0]!.multiSelect = true;
  const { slot, resolve } = setup([row]);
  fireEvent.click(await slot.findByRole('button', { name: /Alpha/ })); fireEvent.click(slot.getByRole('button', { name: /Beta/ })); fireEvent.click(slot.getByRole('button', { name: 'Submit answer' }));
  await waitFor(() => expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ resolution: { kind: 'user_answer', answers: { q1: { selected: ['a', 'b'] } } } })));
  cleanup(); const other = setup([question()]); fireEvent.click(await other.slot.findByRole('button', { name: /Other/ }));
  fireEvent.change(other.slot.getByRole('textbox', { name: 'Choice answer' }), { target: { value: 'Custom' } }); fireEvent.click(other.slot.getByRole('button', { name: 'Submit answer' }));
  await waitFor(() => expect(other.resolve).toHaveBeenCalledWith(expect.objectContaining({ resolution: { kind: 'user_answer', answers: { q1: { selected: [], freeText: 'Custom' } } } })));
});
it('keeps a typed Other answer across a remount, and forgets it once submitted', async () => {
  const first = setup([question()]); fireEvent.click(await first.slot.findByRole('button', { name: /Other/ }));
  fireEvent.change(first.slot.getByRole('textbox', { name: 'Choice answer' }), { target: { value: 'Half written' } });
  cleanup(); const again = setup([question()]);
  await waitFor(() => expect((again.slot.getByRole('textbox', { name: 'Choice answer' }) as HTMLTextAreaElement).value).toBe('Half written'));
  fireEvent.click(again.slot.getByRole('button', { name: 'Submit answer' }));
  await waitFor(() => expect(again.resolve).toHaveBeenCalledWith(expect.objectContaining({ resolution: { kind: 'user_answer', answers: { q1: { selected: [], freeText: 'Half written' } } } })));
  await waitFor(() => expect(Object.keys(localStorage).some(key => key.includes('question-draft'))).toBe(false));
});
it('stops the turn on Cancel', async () => {
  const { slot, stop } = setup([question()]); fireEvent.click(await slot.findByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(stop).toHaveBeenCalledWith({ threadId: 'thr_one' }));
});
it('approves a permission with the exact granted permissions', async () => {
  const permissions = { fileSystem: { read: ['/tmp'], write: [] }, network: null };
  const row = question({ payload: { kind: 'approval', availableDecisions: ['allow_once', 'deny'], reason: null, subject: { kind: 'permission_grant', itemId: 'item', permissions, toolName: 'Read' } } });
  const { slot, resolve } = setup([row]); fireEvent.click(await slot.findByRole('button', { name: 'Allow once' }));
  await waitFor(() => expect(resolve).toHaveBeenCalledWith({ threadId: 'thr_one', interactionId: 'i1', resolution: { decision: 'allow_once', grantedPermissions: permissions } }));
});
it('makes no list request without a pending interaction', async () => {
  const { list, slot } = setup([], false); expect(list).not.toHaveBeenCalled(); expect(slot.queryByText('Choose?')).toBeNull();
});
it('links plugin and provider extension interactions to bb chat', async () => {
  const plugin = question({ origin: { kind: 'plugin', pluginId: 'demo', rendererId: 'pick' }, payload: { kind: 'plugin', title: 'Choose a target', data: null } });
  const { slot, respond, cancel } = setup([plugin]);
  expect(await slot.findByText('Choose a target')).toBeTruthy();
  expect(slot.getByText('Open in chat to answer').closest('a')?.getAttribute('href')).toContain('/threads/thr_one');
  expect(respond).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
});
it('numbers options and takes digit keys itself where bb binds no shortcuts (the Answers page)', async () => {
  host.bound = false;
  const { slot } = setup([question()]);
  await slot.findAllByText('Choose?');
  const form = slot.container.querySelector('[data-question-form]')! as HTMLElement;
  expect(Array.from(form.querySelectorAll('kbd')).map(k => k.textContent)).toEqual(['1', '2', '3']);
  fireEvent.keyDown(form, { key: '2' });
  await waitFor(() => expect(form.querySelectorAll('[aria-pressed=true]').length).toBe(1));
});
it('lets host shortcuts act only on the focused form when several share a page', async () => {
  const list = vi.fn(async ({ threadId }: { threadId: string }) => [question({ id: `i_${threadId}`, threadId })]);
  const slot = renderSlot({ component: () => <><PendingInteractions threadId="thr_a" pending /><PendingInteractions threadId="thr_b" pending /></> }, {}, { sdk: { threads: { interactions: { list, resolve: vi.fn() }, stop: vi.fn() } } } as any);
  await waitFor(() => expect(slot.container.querySelectorAll('[data-question-form]')).toHaveLength(2));
  const [first, second] = Array.from(slot.container.querySelectorAll<HTMLElement>('[data-question-form]'));
  const press = () => { let handled = 0; act(() => { handled = host.choices.filter(handler => handler(0)).length; }); return handled; };
  expect(press()).toBe(0);
  second!.focus();
  await waitFor(() => expect(press()).toBe(1));
  await waitFor(() => expect(second!.querySelector('button[aria-pressed="true"]')).toBeTruthy());
  expect(first!.querySelector('button[aria-pressed="true"]')).toBeNull();
});

it('retains a question draft across collapse and reopen', async () => {
  const { slot, resolve } = setup([question()]);
  fireEvent.click(await slot.findByRole('button', { name: /Other/ }));
  fireEvent.change(slot.getByRole('textbox', { name: 'Choice answer' }), { target: { value: 'Keep this draft' } });
  fireEvent.click(slot.getByRole('button', { name: 'Hide details' }));
  expect(slot.queryByRole('textbox')).toBeNull();
  fireEvent.click(slot.getByRole('button', { name: 'Show details' }));
  expect((slot.getByRole('textbox', { name: 'Choice answer' }) as HTMLTextAreaElement).value).toBe('Keep this draft');
  fireEvent.click(slot.getByRole('button', { name: 'Submit answer' }));
  await waitFor(() => expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ resolution: { kind: 'user_answer', answers: { q1: { selected: [], freeText: 'Keep this draft' } } } })));
});

it('requires one partial answer and makes Your call exclusive', async () => {
 const q={...question().payload.questions[0]!,required:false,multiSelect:true,options:[...question().payload.questions[0]!.options,{value:'Your call',label:'Your call'}]}, submit=vi.fn(async()=>{});
 const slot=renderSlot({component:QuestionForm},{questions:[q],requireAny:true,onSubmit:submit});
 expect((slot.getByRole('button',{name:'Submit answer'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(slot.getByRole('button',{name:/Alpha/})); fireEvent.click(slot.getByRole('button',{name:/Other/})); fireEvent.click(slot.getByRole('button',{name:/Your call/}));
 expect(slot.queryByRole('textbox')).toBeNull();
 fireEvent.click(slot.getByRole('button',{name:'Submit answer'})); await waitFor(()=>expect(submit).toHaveBeenCalledWith({q1:{selected:['Your call']}}));
 expect(answerText([q,{...q,id:'q2'}],{q1:{selected:['a,b','c']}})).toContain('a,b; c');
 expect(answerText([q,{...q,id:'q2'}],{q1:{selected:['Your call']}})).toBe('1. Choice — Your call (decide yourself)\n2. Choice — Skipped');
});
it('answers Codex MCP elicitations here: Computer Use access, tool approvals and decline', async () => {
  const elicitation = (id: string, data: object) => ({ id, threadId: 'thr_one', status: 'pending', payload: { kind: 'provider-codex/mcp-elicitation', title: 'MCP request', data: { serverName: 'cua_repl', message: 'Codex wants access', ...data } } });
  const { slot, respond } = setup([
    elicitation('app', { kind: 'computer_use', app: { id: 'com.apple.Safari', name: 'Safari', iconDataUrl: null }, scopes: ['session', 'always'], warning: 'It can read your screen', riskLevel: 'high' }),
    elicitation('tool', { kind: 'tool_approval', toolName: 'browser.open', toolDescription: null, params: [{ name: 'url', label: 'URL', value: 'https://example.com' }], omittedParamCount: 2, scopes: [] }),
    elicitation('form', { kind: 'form', fields: [] }),
  ]);
  expect(await slot.findByText('Allow Computer Use to use Safari?')).toBeTruthy(); expect(slot.getByText('It can read your screen')).toBeTruthy();
  expect(slot.getByText('https://example.com')).toBeTruthy(); expect(slot.getByText('+2 more')).toBeTruthy();
  const app = slot.getByText('Allow Computer Use to use Safari?').closest('[data-approval-banner]') as HTMLElement, tool = slot.getByText('Allow browser.open?').closest('[data-approval-banner]') as HTMLElement;
  // Computer Use grants only with a scope, so it has no plain Allow; the tool approval offers no scopes here.
  expect(within(app).queryByRole('button', { name: 'Allow' })).toBeNull(); expect(within(tool).queryByRole('button', { name: 'Allow for this session' })).toBeNull();
  fireEvent.click(within(app).getByRole('button', { name: 'Always allow' }));
  await waitFor(() => expect(respond).toHaveBeenCalledWith({ threadId: 'thr_one', interactionId: 'app', value: { action: 'accept', persist: 'always' } }));
  fireEvent.click(within(tool).getByRole('button', { name: 'Allow' }));
  await waitFor(() => expect(respond).toHaveBeenCalledWith({ threadId: 'thr_one', interactionId: 'tool', value: { action: 'accept' } }));
  // A form's fields are filled in bb's chat; here it can only be declined.
  const form = slot.getAllByText('MCP request').map(node => node.closest('[data-approval-banner]') as HTMLElement).find(card => within(card).queryByText('Open in chat to answer'))!;
  fireEvent.click(within(form).getByRole('button', { name: 'Decline' }));
  await waitFor(() => expect(respond).toHaveBeenCalledWith({ threadId: 'thr_one', interactionId: 'form', value: { action: 'decline' } }));
});
