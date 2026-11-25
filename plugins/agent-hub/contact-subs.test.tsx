// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { renderSlot } from '@get-bb/plugin-sdk/testing/app';
import { beginContactDrag } from './open-chat';
import { AgentHubContacts, ContactsList, useContacts } from './contacts';
import { COMPOSE_KEY } from './drafts';
const navigate = vi.hoisted(() => ({ toThread: vi.fn(), toPluginPanel: vi.fn() }));
vi.mock('./open-chat', async original => ({ ...await original<typeof import('./open-chat')>(), beginContactDrag: vi.fn() }));
vi.mock('@get-bb/plugin-sdk/app', async importOriginal => ({ ...await importOriginal<typeof import('@get-bb/plugin-sdk/app')>(), useBbNavigate: () => navigate, experimental_useSidebarNavigation: () => ({items:[{id:'answers/answers',action:{kind:'open-plugin-panel',pluginId:'agent-hub',panelId:'agent-hub'}}]}), experimental_useSidebarNavigationSplit: (_id:string, options?:{onDragStart?:()=>void}) => ({isAvailable:true,splitProps:{onPointerDown:()=>options?.onDragStart?.()}}), experimental_useSidebarThreadSplit: (id: string) => ({ splitProps: { 'data-thread-split': id, draggable: true } }) }));
afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); });
const parent = 'thr_example', child = 'thr_example_child', stored = 'bb-plugin-answers:page:open-subs';
const idle = { projectId: null, parentThreadId: null, parentNotifications: 'all', archivedAt: null, pinnedAt: null, sectionId: null, isUnread: false, status: 'idle', runtimeStatus: 'idle', queuedWork: 'none', hasPendingInteraction: false, indicator: 'none', activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: false }, environment: null };
function setup(open = false, sidebar = false, selected = parent, asking: string[] = [], childFields: object = {}, subUnread: Record<string, number> = {}, extra: object[] = []) {
  if (open) localStorage.setItem(stored, JSON.stringify([parent]));
  const onSelect = vi.fn(), onNavigate = vi.fn(), markThreadRead = vi.fn(() => ({ batch: null, count: 1 }));
  function Contacts() { return <ContactsList model={useContacts(selected)} selected={selected} onSelect={onSelect} onNavigate={onNavigate} />; }
  const slot = renderSlot({ component: sidebar ? AgentHubContacts : Contacts }, { activeThreadId: child, activeProjectId: null, isCompactViewport: false, searchQuery: '', onNavigate }, { rpc: { recipients: () => ({ asking, subUnread, recipients: [{ threadId: parent, threadTitle: 'Parent', projectId: null, projectName: null, unread: 1, lastAt: 1, preview: '' }] }), markThreadRead }, sidebarThreads: { threads: [{ ...idle, id: parent, title: 'Parent' }, { ...idle, id: child, title: 'Child', parentThreadId: parent, ...childFields }, { ...idle, id: 'thr_example_quiet', title: 'Quiet', parentThreadId: parent }, ...extra], projects: [] } } as any);
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
  expect(await row('unread')).not.toEqual(expect.arrayContaining(['opacity-50'])); expect(await row('unread')).not.toContain('opacity-80');
  expect(await row('working')).toContain('opacity-80');
  expect(await row('idle')).toContain('opacity-50');
});
it('shows bb\'s draft pencil instead of the time or spinner while the Answers composer holds unsent text', async () => {
  localStorage.setItem(COMPOSE_KEY, JSON.stringify({ thr_example_draft: { text: 'half typed', files: [] }, thr_example_busy: { text: 'more', files: [] }, thr_example_empty: { text: '  ', files: [] } }));
  const rows = [['thr_example_draft', 'idle'], ['thr_example_busy', 'active'], ['thr_example_empty', 'idle']] as const;
  function Contacts() { return <ContactsList model={useContacts(undefined)} onSelect={() => {}} />; }
  const slot = renderSlot({ component: Contacts }, {}, { rpc: { recipients: () => ({ recipients: rows.map(([threadId]) => ({ threadId, threadTitle: threadId.slice(12), projectId: null, projectName: null, unread: 0, lastAt: 1, preview: '' })) }) }, sidebarThreads: { threads: rows.map(([id, status]) => ({ ...idle, id, title: id.slice(12), ...(status === 'active' ? { status: 'active', runtimeStatus: 'active', indicator: 'runtime' } : {}) })), projects: [] } } as any);
  const glyph = async (name: string) => (await slot.findByRole('option', { name: new RegExp(name) })).querySelector('[data-thread-status-glyph]')?.getAttribute('data-thread-status-glyph');
  expect(await glyph('draft')).toBe('draft');
  expect(await glyph('busy')).toBe('working-draft');
  expect(await glyph('empty')).toBeUndefined();
  localStorage.removeItem(COMPOSE_KEY);
});
it('keeps a sub-session that asks the owner visible under its collapsed parent', async () => {
  for (const [asking, fields] of [[[child], {}], [[], { hasPendingInteraction: true }]] as const) {
    const { slot } = setup(false, false, parent, [...asking], fields);
    const subs = await slot.findByRole('list', { name: 'Sub-sessions of Parent' });
    expect(subs.textContent).toContain('Child'); expect(subs.textContent).not.toContain('Quiet');
    // The sub-session's row and its parent contact both show the question mark.
    expect(within(subs).getByRole('img', { name: 'Asking you' })).toBeTruthy(); expect(slot.getAllByRole('img', { name: 'Asking you' })).toHaveLength(2);
    expect(slot.getByRole('button', { name: 'Show sub-sessions' })).toBeTruthy();
    slot.unmount();
  }
  const { slot } = setup();
  await slot.findByRole('button', { name: 'Show sub-sessions' });
  expect(slot.queryByRole('list', { name: 'Sub-sessions of Parent' })).toBeNull();
});
it('dims sub-sessions like contacts, except one that asks the owner', async () => {
  const subRow = async (slot: ReturnType<typeof setup>['slot'], name: string) => within(await slot.findByRole('list', { name: 'Sub-sessions of Parent' })).getByText(name).closest('button')!.className.split(' ');
  const open = setup(true);
  expect(await subRow(open.slot, 'Quiet')).toContain('opacity-50');
  open.slot.unmount();
  const busy = setup(true, false, parent, [], { status: 'active', runtimeStatus: 'active', indicator: 'runtime' });
  expect(await subRow(busy.slot, 'Child')).toContain('opacity-80');
  busy.slot.unmount();
  const asking = setup(false, false, parent, [child]);
  const row = await subRow(asking.slot, 'Child');
  expect(row).not.toContain('opacity-50'); expect(row).not.toContain('opacity-80');
});
it('marks a failed sub-session and keeps it at full strength', async () => {
  const { slot } = setup(true, false, parent, [], { status: 'error' });
  const subs = await slot.findByRole('list', { name: 'Sub-sessions of Parent' });
  expect(within(subs).getByRole('img', { name: 'Failed' })).toBeTruthy();
  expect(within(subs).getByText('Child').closest('button')!.className.split(' ')).not.toContain('opacity-50');
});
it('shows the question mark, not the working spinner, on a sub-session that asks while it works', async () => {
  const { slot } = setup(false, false, parent, [child], { status: 'active', runtimeStatus: 'active', indicator: 'runtime' });
  const subs = await slot.findByRole('list', { name: 'Sub-sessions of Parent' });
  expect(within(subs).getByRole('img', { name: 'Asking you' })).toBeTruthy(); expect(within(subs).queryByRole('img', { name: 'Working' })).toBeNull();
});
it('badges a sub-session with unread replies to the owner, adds them once to its contact and lists it under a collapsed tree', async () => {
  const nested = 'thr_example_nested';
  for (const sidebar of [false, true]) {
    const { slot } = setup(false, sidebar, parent, [], {}, { [child]: 2, [nested]: 1 }, [{ ...idle, id: nested, title: 'Nested', parentThreadId: child }]);
    expect((await slot.findAllByLabelText('4 unread')).length).toBeGreaterThan(0); // the contact's own 1, the child's 2 and the nested 1
    const subs = within(slot.getByRole('list', { name: 'Sub-sessions of Parent' }));
    expect(subs.getAllByRole('listitem').map(li => li.textContent)).toEqual(['Child2', 'Nested1']);
    expect(subs.getByLabelText('2 unread')).toBeTruthy(); expect(subs.queryByText('Quiet')).toBeNull();
    cleanup();
  }
});
it('keeps the nesting of a collapsed tree: a nested sub-session with unread replies shows under its parent sub-session', async () => {
  const nested = 'thr_example_nested';
  const { slot } = setup(false, false, parent, [], {}, { [nested]: 1 }, [{ ...idle, id: nested, title: 'Nested', parentThreadId: child }]);
  await slot.findAllByLabelText('2 unread');
  const subs = within(slot.getByRole('list', { name: 'Sub-sessions of Parent' }));
  expect(subs.getAllByRole('listitem').map(li => li.textContent)).toEqual(['Child', 'Nested1']);
  const indent = (name: string) => parseInt(subs.getByText(name).closest('button')!.style.paddingLeft);
  expect(indent('Nested')).toBeGreaterThan(indent('Child'));
});
