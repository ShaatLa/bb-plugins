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
it('shows Won’t reply as a quiet state on an open question, keeps its choices, and offers the button no more', async () => {
  const reply = vi.fn(() => ({ delivery: 'sent' }));
  const slot = await questionsSetup({ reply }, { options: ['Yes', 'No'], declinedAt: Date.now() });
  expect(slot.getByText('Won’t reply')).toBeTruthy();
  expect(slot.queryByRole('button', { name: 'Won’t reply' })).toBeNull();
  fireEvent.click(slot.getByRole('button', { name: 'Yes' }));
  await waitFor(() => expect(reply).toHaveBeenCalledWith({ id: 'ans_ask', text: 'Yes' }));
});
it('does not count a declined open question as unread', async () => {
  const { isUnread } = await import('./app');
  const open = { ...item, kind: 'for_me' as const, status: 'open' as const, answer: null };
  expect(isUnread(open)).toBe(true); expect(isUnread({ ...open, declinedAt: 1 })).toBe(false);
});
it('does not count a declined question in the Questions tab badge', async () => {
  const slot = await questionsSetup({}, { declinedAt: Date.now() });
  expect(slot.queryByLabelText(/pending$/)).toBeNull();
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
  it('counts only the questions still waiting, and still lists the declined card', async () => {
    const { ComposerQuestions } = await import('./app');
    const ask = { ...item, id: 'ans_a', kind: 'for_me' as const, status: 'open' as const, question: 'Choose?', answer: null, options: ['A', 'B'] };
    const items = [ask, { ...ask, id: 'ans_b', question: 'Later?', declinedAt: 1 }];
    const slot = renderSlot({ component: ComposerQuestions }, {}, { composer: { text: '', scope: { kind: 'thread', threadId: 'thr_one' } }, rpc: { list: () => ({ items, nextCursor: null }) } } as any);
    const card = await slot.findByRole('region', { name: 'Questions for you' });
    expect(within(card).getByText('Question for you')).toBeTruthy(); expect(within(card).getByText('1')).toBeTruthy(); expect(within(card).getByText('Later?')).toBeTruthy();
  });
});
