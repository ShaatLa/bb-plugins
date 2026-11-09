// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, waitFor } from '@testing-library/react';
import { renderSlot } from '@get-bb/plugin-sdk/testing/app';
import { PendingInteractions } from './interactions';

afterEach(cleanup);
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
it('allows multiple selections and free text', async () => {
  const row = question(); row.payload.questions[0]!.multiSelect = true;
  const { slot, resolve } = setup([row]);
  fireEvent.click(await slot.findByRole('button', { name: /Alpha/ })); fireEvent.click(slot.getByRole('button', { name: /Beta/ })); fireEvent.click(slot.getByRole('button', { name: 'Submit answer' }));
  await waitFor(() => expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ resolution: { kind: 'user_answer', answers: { q1: { selected: ['a', 'b'] } } } })));
  cleanup(); const other = setup([question()]); fireEvent.click(await other.slot.findByRole('button', { name: /Other/ }));
  fireEvent.change(other.slot.getByRole('textbox', { name: 'Choice answer' }), { target: { value: 'Custom' } }); fireEvent.click(other.slot.getByRole('button', { name: 'Submit answer' }));
  await waitFor(() => expect(other.resolve).toHaveBeenCalledWith(expect.objectContaining({ resolution: { kind: 'user_answer', answers: { q1: { selected: [], freeText: 'Custom' } } } })));
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
