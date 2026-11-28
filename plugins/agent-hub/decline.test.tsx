// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
const change = (element: Element, init: { target: { value?: string; files?: File[] } }) => { if (element.getAttribute('contenteditable') !== null) { (element as HTMLElement).dataset.testValue = init.target.value ?? ''; fireEvent.input(element); } else fireEvent.change(element, init); };
vi.mock('@get-bb/plugin-sdk/app', async importOriginal => ({ ...await importOriginal<typeof import('@get-bb/plugin-sdk/app')>(), experimental_saveFile: vi.fn(async () => 'started') }));
import { useComposer, experimental_saveFile } from '@get-bb/plugin-sdk/app';
import { loadPluginApp, renderSlot as sdkRenderSlot } from '@get-bb/plugin-sdk/testing/app';
const renderSlot = ((slot: any, props: any, options: any = {}) => sdkRenderSlot(slot, props, { ...options, sdk: { ...options.sdk, threads: { ...options.sdk?.threads, queuedMessages: { list: () => Promise.resolve([]), ...options.sdk?.threads?.queuedMessages }, context: options.sdk?.threads?.context ?? (() => Promise.resolve({ usage: null })) } } })) as typeof sdkRenderSlot;
import { itemSchema, type Item } from './contract';

const item: Item = itemSchema.parse({snoozedUntil:null,failedAt:null,likelyInterim:false,options:null,taskKey:null,
  id: 'ans_one', kind: 'mine', threadId: 'thr_one', projectId: 'pr_one', threadTitle: 'A thread', projectName: 'A project', status: 'answered', question: 'What changed?', questionSeq: 10,
  requestId: null, turnId: null, candidate: null, candidateSeq: null, interim: null, interimSeq: null, answer: 'The answer', answerSeq: 20, answerSource: 'turn', resolveTurnId: null, note: null, readAt: null, pinned: false, dismissedAt: null, threadDeleted: false, createdAt: Date.now(), updatedAt: Date.now(),
});
// Most tests cover the classic conversation; the embedded bb chat has its own test.
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
// The page's Questions section with one open agent question.
async function questionsSetup(overrides: Record<string, (...args: any[]) => any> = {}, extra: Partial<Item> = {}) {
  localStorage.setItem('bb-plugin-answers:page:questions', 'true');
  const app = await loadPluginApp(() => import('./app'));
  const ask = { ...item, id: 'ans_ask', kind: 'for_me' as const, status: 'open' as const, question: 'Choose?', answer: null, ...extra };
  const slot = renderSlot(app.navPanels[0]!, { subPath: '' }, { rpc: { recipients: () => ({ recipients: [] }), list: (input: unknown) => ({ items: (input as { view: string }).view === 'for_me' ? [ask] : [], nextCursor: null }), counts: () => ({ unread: 0, waiting: 0, forMe: 1, inbox: 0 }), ...overrides } });
  // A question of several parts shows its prompts only in the form, so wait for the card itself.
  await waitFor(() => expect(slot.container.querySelector('[data-pending-title="Choose?"]')).toBeTruthy());
  return slot;
}
it('leaves a Won’t reply question out of Questions and its badge: the page lists only questions the owner can still answer', async () => {
  localStorage.setItem('bb-plugin-answers:page:questions', 'true');
  const app = await loadPluginApp(() => import('./app'));
  const declined = { ...item, id: 'ans_ask', kind: 'for_me' as const, status: 'open' as const, question: 'Choose?', answer: null, options: ['Yes', 'No'], declinedAt: Date.now() };
  // Answers as the server does: answerable leaves declined questions out.
  const list = vi.fn((input: { view: string; answerable?: boolean }) => ({ items: input.view === 'for_me' && !input.answerable ? [declined] : [], nextCursor: null }));
  const slot = renderSlot(app.navPanels[0]!, { subPath: '' }, { rpc: { recipients: () => ({ recipients: [] }), list, counts: () => ({ unread: 0, waiting: 0, forMe: 0, inbox: 0 }) } });
  expect(await slot.findByText('No questions for you')).toBeTruthy();
  expect(list).toHaveBeenCalledWith(expect.objectContaining({ view: 'for_me', answerable: true }));
  expect(slot.queryByText('Choose?')).toBeNull(); expect(slot.queryByLabelText(/pending$/)).toBeNull();
});
it('draws no link row above a question\'s form in Questions: the header\'s Open thread already leads to the chat', async () => {
  const part = (id: string, prompt: string) => ({ id, prompt, options: [{ value: 'a', label: 'A' }], multiSelect: false, allowFreeText: false, required: true });
  const slot = await questionsSetup({}, { questions: [part('q1', 'First?'), part('q2', 'Second?')] });
  expect(slot.queryByRole('link', { name: 'Open in Agent Hub' })).toBeNull();
  expect(slot.getByText('Open thread')).toBeTruthy();
});
it('shows the text of a declined question of several parts, whose form is no longer drawn', async () => {
  const part = (id: string, prompt: string) => ({ id, prompt, options: [{ value: 'a', label: 'A' }], multiSelect: false, allowFreeText: false, required: true });
  const slot = await questionsSetup({}, { questions: [part('q1', 'First?'), part('q2', 'Second?')], declinedAt: Date.now() });
  expect(slot.getByText('Choose?')).toBeTruthy(); expect(slot.queryByRole('button', { name: 'Submit' })).toBeNull();
});
it('shows a withdrawn question in the chat history read-only', async () => {
  const slot = await questionsSetup({}, { options: ['Yes', 'No'], declinedAt: 4, dismissedAt: 5, answerSource: 'agent', note: 'Found it' });
  expect(slot.getByText('Withdrawn')).toBeTruthy(); expect(slot.queryByRole('button', { name: 'Yes' })).toBeNull();
});
it('does not count a declined open question as unread', async () => {
  const { isUnread } = await import('./app');
  const open = { ...item, kind: 'for_me' as const, status: 'open' as const, answer: null };
  expect(isUnread(open)).toBe(true); expect(isUnread({ ...open, declinedAt: 1 })).toBe(false);
});
it('counts an undeclined question in the Questions tab badge', async () => {
  const slot = await questionsSetup({});
  expect(slot.getByLabelText('1 pending')).toBeTruthy();
});
it('shows only Withdrawn on a question that was declined and then withdrawn', async () => {
  const slot = await questionsSetup({}, { declinedAt: 4, dismissedAt: 5, answerSource: 'agent', note: 'Found it' });
  expect(slot.getByText('Withdrawn')).toBeTruthy(); expect(slot.queryByText('Won’t reply')).toBeNull();
});
describe('thread composer banner', () => {
  const ask = { ...item, id: 'ans_a', kind: 'for_me' as const, status: 'open' as const, question: 'Choose?', answer: null, options: ['A', 'B'] };
  const banner = async (list: () => { items: Item[]; nextCursor: null }) => { const { ComposerQuestions } = await import('./app'); return renderSlot({ component: ComposerQuestions }, {}, { composer: { text: '', scope: { kind: 'thread', threadId: 'thr_one' } }, rpc: { list } } as any); };
  it('lists and counts only the questions still waiting, leaving out a declined one', async () => {
    const slot = await banner(() => ({ items: [ask, { ...ask, id: 'ans_b', question: 'Later?', declinedAt: 1 }], nextCursor: null }));
    const card = await slot.findByRole('region', { name: 'Questions for you' });
    expect(within(card).getByText('Question for you')).toBeTruthy(); expect(within(card).getByText('1')).toBeTruthy(); expect(within(card).queryByText('Later?')).toBeNull();
  });
  it('draws no stack when the only question is declined', async () => {
    const slot = await banner(() => ({ items: [{ ...ask, declinedAt: 1 }], nextCursor: null }));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(slot.queryByRole('region', { name: 'Questions for you' })).toBeNull();
  });
  // The server's for_me query drops a question once it is answered (from any client) or withdrawn.
  it('drops a question answered elsewhere or withdrawn on the next list read after the server invalidates', async () => {
    let items: Item[] = [ask];
    const slot = await banner(() => ({ items, nextCursor: null }));
    await slot.findByRole('region', { name: 'Questions for you' });
    items = [];
    await act(async () => { await slot.behavior.experimental_invalidateRpc(['answers:items']); });
    await waitFor(() => expect(slot.queryByRole('region', { name: 'Questions for you' })).toBeNull());
  });
});
