// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, waitFor } from '@testing-library/react';
import { renderSlot } from '@get-bb/plugin-sdk/testing/app';
import { ContactsList, useContacts } from './contacts';
import { decideDrop } from './reparent';
const split = vi.hoisted(() => ({ start: undefined as undefined | (() => void) }));
vi.mock('./open-chat', async original => ({ ...await original<typeof import('./open-chat')>(), beginContactDrag: vi.fn() }));
vi.mock('@get-bb/plugin-sdk/app', async importOriginal => ({ ...await importOriginal<typeof import('@get-bb/plugin-sdk/app')>(), useBbNavigate: () => ({ toThread: vi.fn(), toPluginPanel: vi.fn(), toCompose: vi.fn() }), experimental_useSidebarNavigation: () => ({ items: [{ id: 'agent-hub/agent-hub', action: { kind: 'open-plugin-panel', pluginId: 'agent-hub', panelId: 'agent-hub' } }] }), experimental_useSidebarNavigationSplit: (_id: string, options?: { onDragStart?: () => void }) => { split.start = options?.onDragStart; return { isAvailable: true, splitProps: {} }; }, experimental_useSidebarThreadSplit: () => ({ splitProps: {} }) }));
afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); Reflect.deleteProperty(document, 'elementFromPoint'); });

const idle = { projectId: 'proj_a', parentThreadId: null, parentNotifications: 'auto', archivedAt: null, pinnedAt: null, isPinned: false, sectionId: null, isUnread: false, status: 'idle', runtimeStatus: 'idle', queuedWork: 'none', hasPendingInteraction: false, indicator: 'none', activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0 }, environment: null };
const thread = (id: string, fields: object = {}) => ({ ...idle, id, title: id.slice(4), ...fields }) as any;

describe('decideDrop', () => {
  const threads = [thread('thr_root', { sectionId: 'sec_a' }), thread('thr_kid', { parentThreadId: 'thr_root', isPinned: true }), thread('thr_grandkid', { parentThreadId: 'thr_kid' }), thread('thr_other', { sectionId: 'sec_o' }), thread('thr_far', { projectId: 'proj_b', sectionId: 'sec_b' })];
  it('nests under another session with its section, and unpins a pinned one', () => {
    expect(decideDrop(threads, 'thr_kid', { kind: 'nest', threadId: 'thr_other' }, true)).toEqual({ ok: true, parentThreadId: 'thr_other', sectionId: 'sec_o', unpin: true });
  });
  it('keeps the session\'s own section when it nests under another project', () => {
    expect(decideDrop(threads, 'thr_other', { kind: 'nest', threadId: 'thr_far' }, true)).toEqual({ ok: true, parentThreadId: 'thr_far', unpin: false });
  });
  it.each(['thr_kid', 'thr_grandkid', 'thr_root'])('refuses to nest under itself, its descendant or its current parent (%s)', target => {
    expect(decideDrop(threads, 'thr_kid', { kind: 'nest', threadId: target }, true)).toEqual({ ok: false });
  });
  it('moves a sub-session to the top level only in its own project when grouped, with the old parent\'s section', () => {
    expect(decideDrop(threads, 'thr_kid', { kind: 'top', projectId: 'proj_a' }, true)).toEqual({ ok: true, parentThreadId: null, sectionId: 'sec_a', unpin: false });
    expect(decideDrop(threads, 'thr_kid', { kind: 'top', projectId: 'proj_b' }, true)).toBeNull();
    expect(decideDrop(threads, 'thr_kid', { kind: 'top', projectId: null }, false)).toEqual({ ok: true, parentThreadId: null, sectionId: 'sec_a', unpin: false });
    expect(decideDrop(threads, 'thr_root', { kind: 'top', projectId: 'proj_a' }, true)).toBeNull();
  });
  it('gives no section when the old parent is in another project', () => {
    expect(decideDrop([...threads, thread('thr_moved', { parentThreadId: 'thr_far' })], 'thr_moved', { kind: 'top', projectId: 'proj_a' }, true)).toEqual({ ok: true, parentThreadId: null, sectionId: null, unpin: false });
  });
});

type Row = { id: string; fields?: object };
function setup({ rows, contacts, grouped = false, update = vi.fn(async () => ({})), unpin = vi.fn(async () => ({})) }: { rows: Row[]; contacts: string[]; grouped?: boolean; update?: ReturnType<typeof vi.fn>; unpin?: ReturnType<typeof vi.fn> }) {
  localStorage.setItem('bb-plugin-answers:page:open-subs', JSON.stringify(contacts));
  const threads = rows.map(r => thread(r.id, r.fields)), onSelect = vi.fn();
  function Contacts() { return <ContactsList model={useContacts(undefined)} onSelect={onSelect} />; }
  const slot = renderSlot({ component: Contacts }, {}, { sdk: { threads: { update, unpin } }, rpc: { getPreferences: () => ({ groupByProject: grouped }), recipients: () => ({ recipients: contacts.map(id => { const t = threads.find(t => t.id === id)!; return { threadId: id, threadTitle: t.title, projectId: t.projectId, projectName: t.projectId === 'proj_a' ? 'Alpha' : 'Beta', unread: 0, lastAt: 1, preview: '' }; }) }) }, sidebarThreads: { threads, projects: [{ id: 'proj_a', name: 'Alpha', isPersonal: false }, { id: 'proj_b', name: 'Beta', isPersonal: false }] } } as any);
  return { slot, update, unpin, onSelect };
}
// jsdom has no layout: the element under the pointer is the one a test names, at the given height within it.
function drag(from: HTMLElement, to: HTMLElement, rel = 0.5, done = true) {
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => to });
  to.getBoundingClientRect = () => ({ top: 0, height: 100, bottom: 100, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) });
  fireEvent.pointerDown(from, { button: 0, pointerType: 'mouse', clientX: 0, clientY: 0 });
  fireEvent.pointerMove(window, { clientX: 0, clientY: rel * 100 });
  if (done) { fireEvent.pointerUp(window, { clientX: 0, clientY: rel * 100 }); fireEvent.click(from); }
}
const row = async (slot: ReturnType<typeof setup>['slot'], name: string) => (await slot.findByText(name)).closest('button')!;

it('nests a sub-session under another contact by dropping it on the row, without opening a chat', async () => {
  const { slot, update, onSelect } = setup({ rows: [{ id: 'thr_parent' }, { id: 'thr_kid', fields: { parentThreadId: 'thr_parent' } }, { id: 'thr_other', fields: { sectionId: 'sec_o' } }], contacts: ['thr_parent', 'thr_other'] });
  drag(await row(slot, 'kid'), await row(slot, 'other'));
  await waitFor(() => expect(update).toHaveBeenCalledExactlyOnceWith({ threadId: 'thr_kid', parentThreadId: 'thr_other', sectionId: 'sec_o' }));
  expect(onSelect).not.toHaveBeenCalled();
});
it('unpins a pinned session before nesting it, as bb does', async () => {
  const calls: string[] = [];
  const { slot } = setup({ rows: [{ id: 'thr_parent' }, { id: 'thr_kid', fields: { parentThreadId: 'thr_parent', isPinned: true } }, { id: 'thr_other' }], contacts: ['thr_parent', 'thr_other'], update: vi.fn(async () => { calls.push('update'); }), unpin: vi.fn(async () => { calls.push('unpin'); }) });
  drag(await row(slot, 'kid'), await row(slot, 'other'));
  await waitFor(() => expect(calls).toEqual(['unpin', 'update']));
});
it('moves a sub-session to the top level from the edge of a contact row', async () => {
  const { slot, update } = setup({ rows: [{ id: 'thr_parent', fields: { sectionId: 'sec_p' } }, { id: 'thr_kid', fields: { parentThreadId: 'thr_parent' } }, { id: 'thr_other' }], contacts: ['thr_parent', 'thr_other'] });
  drag(await row(slot, 'kid'), await row(slot, 'other'), 0.9);
  await waitFor(() => expect(update).toHaveBeenCalledExactlyOnceWith({ threadId: 'thr_kid', parentThreadId: null, sectionId: 'sec_p' }));
});
it('dims a refused target and changes nothing on the drop', async () => {
  const { slot, update } = setup({ rows: [{ id: 'thr_parent' }, { id: 'thr_kid', fields: { parentThreadId: 'thr_parent' } }], contacts: ['thr_parent'] });
  const target = await row(slot, 'parent');
  drag(await row(slot, 'kid'), target, 0.5, false);
  await waitFor(() => expect(target.className).toContain('cursor-not-allowed'));
  fireEvent.pointerUp(window, { clientX: 0, clientY: 50 });
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(update).not.toHaveBeenCalled();
});
it('ends the drag when bb starts its split drag, so a drag to the chat area only splits', async () => {
  const { slot, update } = setup({ rows: [{ id: 'thr_parent' }, { id: 'thr_kid', fields: { parentThreadId: 'thr_parent' } }, { id: 'thr_other' }], contacts: ['thr_parent', 'thr_other'] });
  drag(await row(slot, 'kid'), await row(slot, 'other'), 0.5, false);
  split.start?.();
  fireEvent.pointerUp(window, { clientX: 0, clientY: 50 });
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(update).not.toHaveBeenCalled();
});
it('shows bb\'s refusal in the list', async () => {
  const { slot } = setup({ rows: [{ id: 'thr_parent' }, { id: 'thr_kid', fields: { parentThreadId: 'thr_parent' } }, { id: 'thr_other' }], contacts: ['thr_parent', 'thr_other'], update: vi.fn(async () => { throw new Error('Thread nesting is limited to 4 levels.'); }) });
  drag(await row(slot, 'kid'), await row(slot, 'other'));
  expect((await slot.findByRole('alert')).textContent).toBe('Thread nesting is limited to 4 levels.');
});
it('after a nest across projects, marks the session and offers the top level of its own project even with its group gone', async () => {
  const { slot, update } = setup({ grouped: true, rows: [{ id: 'thr_host', fields: { projectId: 'proj_b' } }, { id: 'thr_kid', fields: { parentThreadId: 'thr_host' } }], contacts: ['thr_host'] });
  expect(await slot.findByRole('img', { name: 'In project Alpha' })).toBeTruthy();
  expect(slot.queryByRole('group', { name: 'Alpha' })).toBeNull();
  const kid = await row(slot, 'kid');
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => null });
  fireEvent.pointerDown(kid, { button: 0, pointerType: 'mouse', clientX: 0, clientY: 0 });
  fireEvent.pointerMove(window, { clientX: 0, clientY: 50 });
  const end = await slot.findByText('Move to top level in Alpha');
  drag(kid, end);
  await waitFor(() => expect(update).toHaveBeenCalledExactlyOnceWith({ threadId: 'thr_kid', parentThreadId: null, sectionId: null }));
});
it('lists a contact whose live parent is set only under that parent', async () => {
  const { slot } = setup({ rows: [{ id: 'thr_parent' }, { id: 'thr_kid', fields: { parentThreadId: 'thr_parent' } }], contacts: ['thr_parent', 'thr_kid'] });
  await slot.findByText('kid');
  expect(slot.getAllByText('kid')).toHaveLength(1);
  expect(slot.getAllByRole('option')).toHaveLength(1);
});
it('shows a ghost with the session and what the drop will do, only while the drag runs', async () => {
  const { slot } = setup({ rows: [{ id: 'thr_parent' }, { id: 'thr_kid', fields: { parentThreadId: 'thr_parent' } }, { id: 'thr_other' }], contacts: ['thr_parent', 'thr_other'] });
  const kid = await row(slot, 'kid'), other = await row(slot, 'other'), parent = await row(slot, 'parent');
  const ghost = () => slot.queryByRole('status', { name: 'Dragged session' });
  const at = (el: HTMLElement | null, rel = 0.5) => {
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => el });
    if (el) el.getBoundingClientRect = () => ({ top: 0, height: 100, bottom: 100, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerMove(window, { clientX: 0, clientY: rel * 100 });
  };
  at(other);
  fireEvent.pointerDown(kid, { button: 0, pointerType: 'mouse', clientX: 0, clientY: 0 });
  expect(ghost()).toBeNull();
  at(other);
  await waitFor(() => expect(ghost()?.textContent).toBe('kidNest under other'));
  at(parent);
  await waitFor(() => expect(ghost()?.textContent).toBe("kidCan't drop here"));
  at(other, 0.9);
  await waitFor(() => expect(ghost()?.textContent).toBe('kidMove to top level'));
  at(null);
  await waitFor(() => expect(ghost()?.textContent).toBe('kidDrop on a session or the top level'));
  expect(document.body.style.cursor).toBe('grabbing');
  // Near the window's bottom the ghost flips above the pointer; a narrow window keeps it inside sideways.
  const width = window.innerWidth; Object.defineProperty(window, 'innerWidth', { configurable: true, value: 200 });
  fireEvent.pointerMove(window, { clientX: 0, clientY: window.innerHeight - 2 });
  await waitFor(() => expect(ghost()!.style.transform).toBe('translateY(-100%)'));
  expect(ghost()!.style.top).toBe(`${window.innerHeight - 10}px`); expect(ghost()!.style.left).toBe('4px');
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  fireEvent.keyDown(window, { key: 'Escape' });
  await waitFor(() => expect(ghost()).toBeNull());
  expect(document.body.style.cursor).toBe('');
  drag(kid, other, 0.5, false);
  await waitFor(() => expect(ghost()).not.toBeNull());
  split.start?.();
  await waitFor(() => expect(ghost()).toBeNull());
  drag(kid, other);
  await waitFor(() => expect(ghost()).toBeNull());
});
