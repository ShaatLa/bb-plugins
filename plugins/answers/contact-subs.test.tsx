// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, waitFor } from '@testing-library/react';
import { renderSlot } from '@get-bb/plugin-sdk/testing/app';
import { AnswersContacts, ContactsList, useContacts } from './contacts';
const navigate = vi.hoisted(() => ({ toThread: vi.fn(), toPluginPanel: vi.fn() }));
vi.mock('@get-bb/plugin-sdk/app', async importOriginal => ({ ...await importOriginal<typeof import('@get-bb/plugin-sdk/app')>(), useBbNavigate: () => navigate, experimental_useSidebarThreadSplit: (id: string) => ({ splitProps: { 'data-thread-split': id, draggable: true } }) }));
afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); });
const parent = 'thr_example', child = 'thr_example_child', stored = 'bb-plugin-answers:page:open-subs';
const idle = { projectId: null, parentThreadId: null, parentNotifications: 'all', archivedAt: null, pinnedAt: null, sectionId: null, isUnread: false, status: 'idle', runtimeStatus: 'idle', queuedWork: 'none', hasPendingInteraction: false, indicator: 'none', activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: false }, environment: null };
function setup(open = false, sidebar = false) {
  if (open) localStorage.setItem(stored, JSON.stringify([parent]));
  const onSelect = vi.fn(), onNavigate = vi.fn(), markThreadRead = vi.fn(() => ({ batch: null, count: 1 }));
  function Contacts() { return <ContactsList model={useContacts(parent)} selected={parent} onSelect={onSelect} onNavigate={onNavigate} footer={false} />; }
  const slot = renderSlot({ component: sidebar ? AnswersContacts : Contacts }, { activeThreadId: child, activeProjectId: null, isCompactViewport: false, searchQuery: '', onNavigate }, { rpc: { recipients: () => ({ recipients: [{ threadId: parent, threadTitle: 'Parent', projectId: null, projectName: null, unread: 1, lastAt: 1, preview: '' }] }), markThreadRead }, sidebarThreads: { threads: [{ ...idle, id: parent, title: 'Parent' }, { ...idle, id: child, title: 'Child', parentThreadId: parent }], projects: [] } } as any);
  return { slot, onSelect, onNavigate, markThreadRead };
}
it('toggles and stores sub-sessions only through a separate chevron button', async () => {
  const { slot, onSelect, onNavigate, markThreadRead } = setup();
  const chevron = await slot.findByRole('button', { name: 'Show sub-sessions' });
  expect(chevron.closest('button button')).toBeNull();
  expect(chevron.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(chevron);
  expect(slot.getByRole('list', { name: 'Sub-sessions of Parent' })).toBeTruthy();
  expect(slot.getByRole('button', { name: 'Hide sub-sessions' }).getAttribute('aria-expanded')).toBe('true');
  await waitFor(() => expect(JSON.parse(localStorage.getItem(stored)!)).toEqual([parent]));
  expect(onSelect).not.toHaveBeenCalled(); expect(onNavigate).not.toHaveBeenCalled(); expect(markThreadRead).not.toHaveBeenCalled();
  slot.unmount();
  const restored = setup();
  fireEvent.click(await restored.slot.findByRole('button', { name: 'Hide sub-sessions' }));
  expect(restored.slot.queryByRole('list', { name: 'Sub-sessions of Parent' })).toBeNull();
  await waitFor(() => expect(JSON.parse(localStorage.getItem(stored)!)).toEqual([]));
});
it('keeps the tree open on a second contact click and marks it read', async () => {
  const { slot, onSelect, markThreadRead } = setup(true);
  fireEvent.click(await slot.findByRole('option', { name: /Parent/ }));
  await waitFor(() => expect(markThreadRead).toHaveBeenCalledWith({ threadId: parent }));
  expect(onSelect).toHaveBeenCalledWith(parent);
  expect(slot.queryByRole('list', { name: 'Sub-sessions of Parent' })).not.toBeNull();
});
it('opens a sub-session in bb and closes the mobile sidebar', async () => {
  const { slot, onSelect, onNavigate } = setup(true);
  fireEvent.click(await slot.findByRole('button', { name: 'Child' }));
  expect(navigate.toThread).toHaveBeenCalledExactlyOnceWith(child);
  expect(onNavigate).toHaveBeenCalledOnce(); expect(onSelect).not.toHaveBeenCalled();
});
it('highlights the sub-session bb currently shows', async () => {
  const { slot } = setup(true, true);
  expect((await slot.findByText('Child')).closest('button')?.getAttribute('aria-current')).toBe('page');
  expect(slot.getByRole('option', { name: /Parent/ }).getAttribute('aria-selected')).toBe('false');
});
it('puts bb thread split props on the interactive sub-session row', async () => {
  const { slot } = setup(true);
  const row = (await slot.findByText('Child')).closest('button');
  expect(row?.getAttribute('data-thread-split')).toBe(child);
  expect(row?.getAttribute('draggable')).toBe('true');
});
