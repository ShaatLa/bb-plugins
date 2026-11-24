// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { renderSlot } from '@get-bb/plugin-sdk/testing/app';
import { ItemCard, unlabel } from './app';
import { itemSchema, type Item } from './contract';

// The chat draws a message by its author: the owner, the agent, or an incoming one (another thread, a plugin, bb, a script).
const base: Item = itemSchema.parse({ snoozedUntil: null, failedAt: null, likelyInterim: false, options: null, taskKey: null,
  id: 'ans_one', kind: 'mine', threadId: 'thr_example', projectId: 'proj_example', threadTitle: 'A thread', projectName: 'A project', status: 'answered', question: 'What changed?', questionSeq: 10,
  requestId: null, turnId: null, candidate: null, candidateSeq: null, interim: null, interimSeq: null, answer: 'The answer', answerSeq: 20, answerSource: 'turn', resolveTurnId: null, note: null, readAt: null, pinned: false, dismissedAt: null, threadDeleted: false, createdAt: 1000, updatedAt: 1000 });
const sdk = { threads: { get: async () => ({ id: 'thr_example', projectId: 'p', environmentId: 'e', providerId: 'codex' }), queuedMessages: { list: async () => [] }, context: async () => ({ usage: null }) }, plugins: { list: async () => ({ plugins: [{ id: 'example-plugin', name: 'Example Plugin', icon: 'Gauge' }] }) } };
const workBoard = { workBoardProjects: () => ({ available: true, projects: [{ id: 'p', name: 'Acme', prefix: 'ACM' }] }) };
const update = (extra: Partial<Item>): Item => ({ ...base, id: 'ans_in', kind: 'update', questionSeq: null, answer: null, answerSeq: null, ...extra });
const show = (item: Item, rpc: Record<string, () => unknown> = {}) => renderSlot({ component: () => <ul><ItemCard item={item} chat /></ul> }, {}, { sdk, rpc } as any);
afterEach(() => { cleanup(); localStorage.clear(); });

it('gives the owner bubble a row with Copy link, shown on touch screens with a 32px touch area', () => {
  const slot = show(base);
  const link = slot.getAllByRole('button', { name: 'Copy link' })[0]!;
  expect(link.className).toContain('[@media(hover:none)]:size-8');
  expect(link.parentElement!.className).toContain('[@media(hover:none)]:opacity-100');
  expect(slot.container.querySelector('.max-w-\\[85\\%\\]')).toBeTruthy();
});
it('gives agent text one row: Copy, Copy link as its own icon, and a menu of Save, Remind later and Create task only', async () => {
  const slot = show(base, workBoard);
  const row = slot.getByRole('button', { name: 'More' }).parentElement!.parentElement!;
  expect(within(row).getByRole('button', { name: 'Copy' })).toBeTruthy(); expect(within(row).getByRole('button', { name: 'Copy link' })).toBeTruthy();
  expect(row.className).toContain('[@media(hover:none)]:opacity-100');
  fireEvent.click(slot.getByRole('button', { name: 'More' }));
  await slot.findByRole('menuitem', { name: 'Create task' });
  expect(within(document.querySelector('[role=menu]') as HTMLElement).getAllByRole('menuitem').map(node => node.textContent)).toEqual(['Save', 'Remind later', 'Create task']);
});
it('offers no dismiss entry on a waiting question, and no Create task without Work Board', async () => {
  const slot = show({ ...base, status: 'waiting', answer: null, answerSeq: null }, { workBoardProjects: () => ({ available: false, projects: [] }) });
  fireEvent.click(slot.getByRole('button', { name: 'More' }));
  await slot.findByRole('menuitem', { name: 'Save' });
  expect(within(document.querySelector('[role=menu]') as HTMLElement).getAllByRole('menuitem').map(node => node.textContent)).toEqual(['Save', 'Remind later']);
});
it('keeps the menu inside a narrow viewport', async () => {
  const width = window.innerWidth; Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true });
  const slot = show(base);
  const more = slot.getByRole('button', { name: 'More' }); more.getBoundingClientRect = () => ({ left: 370, right: 394, top: 600, bottom: 624, width: 24, height: 24, x: 370, y: 600, toJSON: () => ({}) });
  fireEvent.click(more);
  await waitFor(() => expect(parseFloat((document.querySelector('[role=menu]') as HTMLElement).style.left)).toBeLessThanOrEqual(390 - 192));
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
});

const sources: [string, Partial<Item>, RegExp, string][] = [
  ['another thread', { question: '[bb message from thread:thr_m] Task from the owner', trigger: { kind: 'agent', sourceId: 'thr_m', sourceTitle: 'Manager' } }, /^Message from/, 'Task from the owner'],
  ['a plugin', { question: '[bb message from plugin:example-plugin]\n\n[example] A notice', trigger: { kind: 'plugin', sourceId: 'example-plugin', sourceTitle: null } }, /^Message from Example Plugin/, 'A notice'],
  ['an undelivered report', { question: 'Check report', trigger: { kind: 'plugin', sourceId: 'example-plugin', sourceTitle: null }, notice: { source: 'example-plugin', managerThreadId: 'thr_m', bytes: 20, truncated: false } }, /^Undelivered report from Example Plugin/, 'Check report'],
  ['a finished child', { question: '[bb system]\n@thread:thr_child completed:\nThe child report', trigger: { kind: 'system', sourceId: 'thr_child', sourceTitle: null } }, /^thr_child finished/, 'The child report'],
  ['a failed child', { question: '[bb system]\n@thread:thr_child failed.\nIt broke', trigger: { kind: 'system', sourceId: null, sourceTitle: null } }, /^thr_child failed/, 'It broke'],
  ['a batch of children', { question: '[bb system]\n@thread:thr_a completed:\n@thread:thr_b completed:\nBoth done', trigger: { kind: 'system', sourceId: 'thr_a', sourceTitle: null } }, /^2 child threads finished/, 'Both done'],
  ['a script', { question: '[nightly-sync] Run the sync', trigger: { kind: 'other', sourceId: 'nightly-sync', sourceTitle: null } }, /^nightly-sync/, 'Run the sync'],
];
it.each(sources)('draws a message from %s with one header, a quote without header text, and only Copy link', async (_name, extra, header, quote) => {
  const slot = show(update(extra));
  await waitFor(() => expect(slot.container.querySelector('[data-update-caption]')?.textContent).toMatch(header));
  expect(slot.container.querySelectorAll('[data-update-caption]')).toHaveLength(1);
  expect(slot.container.querySelector('[data-agent-message]')?.textContent).toBe(quote);
  expect(slot.getByRole('button', { name: 'Copy link' })).toBeTruthy();
  expect(slot.queryByRole('button', { name: 'More' })).toBeNull();
});
it.each([
  ['example-launch v1 card=EXA-1 role=reviewer', 'Review the proposed change.'],
  ['Check the tests.', 'Check the tests.Review the proposed change.'],
])('shows the human brief of a Spawn Gate launch beginning with %s', (firstLine, displayed) => {
  const question = `${firstLine}\nagent-admission v1 token=${'0'.repeat(64)}\n\nReview the proposed change.`;
  const slot = show(update({ question, trigger: { kind: 'plugin', sourceId: 'spawn-gate', sourceTitle: null } }));
  const quote = slot.container.querySelector('[data-agent-message]')!.textContent!;
  expect(quote.replace(/\s*\n\s*/g, '')).toBe(displayed);
  expect(quote).not.toContain('agent-admission');
});

it('shows no quote when a bb notice has nothing but its own line', () => {
  const slot = show(update({ question: '[bb system] @thread:thr_child completed:', trigger: { kind: 'system', sourceId: 'thr_child', sourceTitle: null } }));
  expect(slot.container.querySelector('[data-agent-message]')).toBeNull();
  expect(slot.container.querySelector('[data-update-caption]')?.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('CircleCheck');
});
it('draws a failed child with the failure icon', () => {
  const slot = show(update({ question: '[bb system] @thread:thr_child failed.', trigger: { kind: 'system', sourceId: null, sourceTitle: null } }));
  expect(slot.container.querySelector('[data-update-caption] [data-icon]')?.getAttribute('data-icon')).toBe('CircleX');
});
it('draws the agent\'s reply to an incoming message as a separate agent message with the agent row', async () => {
  const slot = show(update({ question: '[bb message from thread:thr_m] Task', trigger: { kind: 'agent', sourceId: 'thr_m', sourceTitle: 'Manager' }, answer: 'Done', answerSeq: 7 }), workBoard);
  expect(slot.container.querySelector('[data-agent-body]')?.textContent).toBe('Done');
  expect(slot.getAllByRole('button', { name: 'Copy link' })).toHaveLength(2);
  expect(slot.getAllByRole('button', { name: 'More' })).toHaveLength(1);
  fireEvent.click(slot.getByRole('button', { name: 'More' }));
  await slot.findByRole('menuitem', { name: 'Create task' });
});
it('strips bb\'s notice line from a system message but nothing from other text', () => {
  expect(unlabel('[bb system]\n@thread:thr_example completed:\nReport')).toBe('Report');
  expect(unlabel('[bb system] @thread:thr_example failed.')).toBe('');
  expect(unlabel('A line @thread:thr_example completed: stays')).toBe('A line @thread:thr_example completed: stays');
});
