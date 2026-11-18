// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, waitFor } from '@testing-library/react';
import { renderSlot } from '@get-bb/plugin-sdk/testing/app';
import { beginContactDrag } from './open-chat';
import { AnswersContacts, ContactsList, useContacts } from './contacts';
const navigate = vi.hoisted(() => ({ toThread: vi.fn(), toPluginPanel: vi.fn() }));
vi.mock('./open-chat', async original => ({ ...await original<typeof import('./open-chat')>(), beginContactDrag: vi.fn() }));
vi.mock('@get-bb/plugin-sdk/app', async importOriginal => ({ ...await importOriginal<typeof import('@get-bb/plugin-sdk/app')>(), useBbNavigate: () => navigate, experimental_useSidebarNavigation: () => ({items:[{id:'answers/answers',action:{kind:'open-plugin-panel',pluginId:'answers',panelId:'answers'}}]}), experimental_useSidebarNavigationSplit: (_id:string, options?:{onDragStart?:()=>void}) => ({isAvailable:true,splitProps:{onPointerDown:()=>options?.onDragStart?.()}}), experimental_useSidebarThreadSplit: (id: string) => ({ splitProps: { 'data-thread-split': id, draggable: true } }) }));
afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); });
const parent = 'thr_example', child = 'thr_example_child', stored = 'bb-plugin-answers:page:open-subs';
const idle = { projectId: null, parentThreadId: null, parentNotifications: 'all', archivedAt: null, pinnedAt: null, sectionId: null, isUnread: false, status: 'idle', runtimeStatus: 'idle', queuedWork: 'none', hasPendingInteraction: false, indicator: 'none', activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: false }, environment: null };
function setup(open = false, sidebar = false, selected = parent) {
  if (open) localStorage.setItem(stored, JSON.stringify([parent]));
  const onSelect = vi.fn(), onNavigate = vi.fn(), markThreadRead = vi.fn(() => ({ batch: null, count: 1 }));
  function Contacts() { return <ContactsList model={useContacts(selected)} selected={selected} onSelect={onSelect} onNavigate={onNavigate} />; }
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
it('opens a sub-session in Answers and closes the mobile sidebar', async () => {
  const { slot, onSelect, onNavigate } = setup(true);
  fireEvent.click(await slot.findByRole('button', { name: 'Child' }));
  expect(onSelect).toHaveBeenCalledExactlyOnceWith(child);
  expect(navigate.toThread).not.toHaveBeenCalled();
  expect(onNavigate).toHaveBeenCalledOnce();
});
it('highlights the sub-session bb currently shows', async () => {
  const { slot } = setup(true, true);
  expect((await slot.findByText('Child')).closest('button')?.getAttribute('aria-current')).toBe('page');
  expect(slot.getByRole('option', { name: /Parent/ }).getAttribute('aria-selected')).toBe('false');
});
it('highlights the selected page sub-session without highlighting its parent', async () => {
  const { slot } = setup(true, false, child);
  const row = (await slot.findByText('Child')).closest('button');
  expect(row?.getAttribute('aria-current')).toBe('page'); expect(row?.className).toContain('bg-state-active');
  expect(slot.getByRole('option', { name: /Parent/ }).getAttribute('aria-selected')).toBe('false');
});
it('starts an Answers navigation split drag for the sub-session', async () => {
  const { slot } = setup(true);
  fireEvent.pointerDown((await slot.findByText('Child')).closest('button')!);
  expect(beginContactDrag).toHaveBeenCalledExactlyOnceWith(child);
});
it('shows three brightness levels: unread full, working without news in between, idle dimmed', async () => {
  const rows = [['thr_example_unread', 1, 'idle'], ['thr_example_working', 0, 'active'], ['thr_example_idle', 0, 'idle']] as const;
  function Contacts() { return <ContactsList model={useContacts(undefined)} onSelect={() => {}} />; }
  const slot = renderSlot({ component: Contacts }, {}, { rpc: { recipients: () => ({ recipients: rows.map(([threadId, unread]) => ({ threadId, threadTitle: threadId.slice(11), projectId: null, projectName: null, unread, lastAt: 1, preview: '' })) }) }, sidebarThreads: { threads: rows.map(([id, , status]) => ({ ...idle, id, title: id.slice(11), ...(status === 'active' ? { status: 'active', runtimeStatus: 'active', indicator: 'runtime' } : {}) })), projects: [] } } as any);
  const row = async (name: string) => (await slot.findByRole('option', { name: new RegExp(name) })).className.split(' ');
  expect(await row('unread')).not.toEqual(expect.arrayContaining(['opacity-70'])); expect(await row('unread')).not.toContain('opacity-[0.85]');
  expect(await row('working')).toContain('opacity-[0.85]');
  expect(await row('idle')).toContain('opacity-70');
});
