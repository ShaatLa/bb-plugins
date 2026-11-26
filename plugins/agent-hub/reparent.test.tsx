// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { renderSlot } from '@get-bb/plugin-sdk/testing/app';
import { ContactsList, useContacts } from './contacts';
import { decideDrop, pinnedTree } from './reparent';
const split = vi.hoisted(() => ({ start: undefined as undefined | (() => void) }));
vi.mock('./open-chat', async original => ({ ...await original<typeof import('./open-chat')>(), beginContactDrag: vi.fn() }));
vi.mock('@get-bb/plugin-sdk/app', async importOriginal => ({ ...await importOriginal<typeof import('@get-bb/plugin-sdk/app')>(), useBbNavigate: () => ({ toThread: vi.fn(), toPluginPanel: vi.fn(), toCompose: vi.fn() }), experimental_useSidebarNavigation: () => ({ items: [{ id: 'agent-hub/agent-hub', action: { kind: 'open-plugin-panel', pluginId: 'agent-hub', panelId: 'agent-hub' } }] }), experimental_useSidebarNavigationSplit: (_id: string, options?: { onDragStart?: () => void }) => { split.start = options?.onDragStart; return { isAvailable: true, splitProps: {} }; }, experimental_useSidebarThreadSplit: () => ({ splitProps: {} }) }));
afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); Reflect.deleteProperty(document, 'elementFromPoint'); });

const idle = { projectId: 'proj_a', parentThreadId: null, parentNotifications: 'auto', archivedAt: null, pinnedAt: null, isPinned: false, sectionId: null, isUnread: false, status: 'idle', runtimeStatus: 'idle', queuedWork: 'none', hasPendingInteraction: false, indicator: 'none', activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0 }, environment: null };
const thread = (id: string, fields: object = {}) => ({ ...idle, id, title: id.slice(4), ...fields }) as any;

describe('decideDrop', () => {
  const threads = [thread('thr_root', { sectionId: 'sec_a' }), thread('thr_kid', { parentThreadId: 'thr_root', isPinned: true }), thread('thr_grandkid', { parentThreadId: 'thr_kid' }), thread('thr_other', { sectionId: 'sec_o' }), thread('thr_far', { projectId: 'proj_b', sectionId: 'sec_b' })];
  it('nests under another session with its section, keeping a pinned one pinned', () => {
    expect(decideDrop(threads, 'thr_kid', { kind: 'nest', threadId: 'thr_other' }, true)).toEqual({ ok: true, parentThreadId: 'thr_other', sectionId: 'sec_o', unpin: false });
  });
  it('keeps the session\'s own section when it nests under another project', () => {
    expect(decideDrop(threads, 'thr_other', { kind: 'nest', threadId: 'thr_far' }, true)).toEqual({ ok: true, parentThreadId: 'thr_far', unpin: false });
  });
  it.each(['thr_kid', 'thr_grandkid', 'thr_root'])('refuses to nest under itself, its descendant or its current parent (%s)', target => {
    expect(decideDrop(threads, 'thr_kid', { kind: 'nest', threadId: target }, true)).toEqual({ ok: false });
  });
  it('moves a sub-session to the top level only in its own project when grouped, with the old parent\'s section, unpinning a pinned one', () => {
    expect(decideDrop(threads, 'thr_kid', { kind: 'top', projectId: 'proj_a' }, true)).toEqual({ ok: true, parentThreadId: null, sectionId: 'sec_a', unpin: true });
    expect(decideDrop(threads, 'thr_kid', { kind: 'top', projectId: 'proj_b' }, true)).toBeNull();
    expect(decideDrop(threads, 'thr_kid', { kind: 'top', projectId: null }, false)).toEqual({ ok: true, parentThreadId: null, sectionId: 'sec_a', unpin: true });
    expect(decideDrop(threads, 'thr_grandkid', { kind: 'top', projectId: null }, false)).toEqual({ ok: true, parentThreadId: null, sectionId: null, unpin: false });
    expect(decideDrop(threads, 'thr_root', { kind: 'top', projectId: 'proj_a' }, true)).toBeNull();
  });
  it('only unpins a pinned top-level session dropped on the top level', () => {
    expect(decideDrop([...threads, thread('thr_top', { isPinned: true })], 'thr_top', { kind: 'top', projectId: 'proj_a' }, true)).toEqual({ ok: true, unpin: true });
  });
  it('gives no section when the old parent is in another project', () => {
    expect(decideDrop([...threads, thread('thr_moved', { parentThreadId: 'thr_far' })], 'thr_moved', { kind: 'top', projectId: 'proj_a' }, true)).toEqual({ ok: true, parentThreadId: null, sectionId: null, unpin: false });
  });
});

describe('pinnedTree', () => {
  it('orders top-level pins as bb does, with their descendants and without nested pins', () => {
    const roots = pinnedTree([
      thread('thr_late', { isPinned: true, pinnedAt: 30, pinSortKey: null, createdAt: 1 }),
      thread('thr_b', { isPinned: true, pinnedAt: 10, pinSortKey: 'b', createdAt: 1 }),
      thread('thr_a', { isPinned: true, pinnedAt: 5, pinSortKey: 'a', createdAt: 1 }),
      thread('thr_early', { isPinned: true, pinnedAt: 20, pinSortKey: null, createdAt: 1 }),
      thread('thr_parent'), thread('thr_sub', { parentThreadId: 'thr_parent', isPinned: true, pinnedAt: 1, pinSortKey: null, createdAt: 1 }), thread('thr_subkid', { parentThreadId: 'thr_sub' }),
      thread('thr_gone', { isPinned: true, pinnedAt: 40, archivedAt: 1 }), thread('thr_hidden', { isPinned: true, pinnedAt: 40, isHidden: true }),
    ]);
    // bb compares manual keys only between two keyed pins, so each kind is checked on its own.
    expect(roots.roots.map(t => t.id).filter(id => id === 'thr_a' || id === 'thr_b')).toEqual(['thr_a', 'thr_b']);
    expect(roots.roots.map(t => t.id).filter(id => id !== 'thr_a' && id !== 'thr_b')).toEqual(['thr_late', 'thr_early']);
    // A pinned nested session stays under its parent, outside the group.
    expect([...roots.members].sort()).toEqual(['thr_a', 'thr_b', 'thr_early', 'thr_late']);
  });
});
describe('decideDrop on Pinned', () => {
  const pins = ['thr_p1', 'thr_p2', 'thr_p3'].map((id, i) => thread(id, { isPinned: true, pinnedAt: 30 - i, pinSortKey: null, createdAt: 1 }));
  const all = [...pins, thread('thr_free')];
  it.each([
    ['thr_p1', 'thr_p3', 'after', { previousThreadId: 'thr_p3', nextThreadId: null }],
    ['thr_p3', 'thr_p1', 'before', { previousThreadId: null, nextThreadId: 'thr_p1' }],
    ['thr_p1', 'thr_p3', 'before', { previousThreadId: 'thr_p2', nextThreadId: 'thr_p3' }],
  ] as const)('reorders %s to %s %s', (drag, target, edge, reorder) => {
    expect(decideDrop(all, drag, { kind: 'pin', threadId: target, edge }, false)).toEqual({ ok: true, unpin: false, reorder });
  });
  it('reorders pinned siblings under an unpinned parent, and refuses under a pinned parent or from another parent', () => {
    const kids = [thread('thr_mom'), thread('thr_pinmom', { isPinned: true, pinnedAt: 1 }), ...['thr_k1', 'thr_k2'].map((id, i) => thread(id, { parentThreadId: 'thr_mom', isPinned: true, pinnedAt: 9 - i, pinSortKey: null, createdAt: 1 })),
      ...['thr_q1', 'thr_q2'].map((id, i) => thread(id, { parentThreadId: 'thr_pinmom', isPinned: true, pinnedAt: 9 - i, pinSortKey: null, createdAt: 1 }))];
    expect(decideDrop(kids, 'thr_k2', { kind: 'pin', threadId: 'thr_k1', edge: 'before' }, false)).toEqual({ ok: true, unpin: false, reorder: { previousThreadId: null, nextThreadId: 'thr_k1' } });
    expect(decideDrop(kids, 'thr_q2', { kind: 'pin', threadId: 'thr_q1', edge: 'before' }, false)).toEqual({ ok: false });
    expect(decideDrop(kids, 'thr_q1', { kind: 'pin', threadId: 'thr_k1', edge: 'before' }, false)).toEqual({ ok: false });
  });
  it('leaves an unchanged order alone and refuses a session that is not a pinned root', () => {
    expect(decideDrop(all, 'thr_p1', { kind: 'pin', threadId: 'thr_p2', edge: 'before' }, false)).toBeNull();
    expect(decideDrop(all, 'thr_p1', { kind: 'pin', threadId: 'thr_p1', edge: 'after' }, false)).toBeNull();
    expect(decideDrop(all, 'thr_free', { kind: 'pin', threadId: 'thr_p1', edge: 'after' }, false)).toEqual({ ok: false });
  });
});

type Row = { id: string; fields?: object };
function setup({ sidebar = false, rows, contacts, grouped = false, update = vi.fn(async () => ({})), unpin = vi.fn(async () => ({})), reorderPinned = vi.fn(async () => ({})), unreadOf = {}, subUnread = {} }: { rows: Row[]; contacts: string[]; grouped?: boolean; update?: ReturnType<typeof vi.fn>; unpin?: ReturnType<typeof vi.fn>; reorderPinned?: ReturnType<typeof vi.fn>; unreadOf?: Record<string, number>; subUnread?: Record<string, number>; sidebar?: boolean }) {
  localStorage.setItem('bb-plugin-answers:page:open-subs', JSON.stringify(contacts));
  const threads = rows.map(r => thread(r.id, r.fields)), onSelect = vi.fn();
  // The sidebar list is the same component with bb's active thread and a navigate callback.
  function Contacts() { return sidebar ? <ContactsList model={useContacts(undefined)} onSelect={onSelect} activeThreadId={null} onNavigate={() => {}} /> : <ContactsList model={useContacts(undefined)} onSelect={onSelect} />; }
  const asked: unknown[] = [], recipient = (id: string) => { const t = threads.find(t => t.id === id)!; return { threadId: id, threadTitle: t.title, projectId: t.projectId, projectName: t.projectId === 'proj_a' ? 'Alpha' : 'Beta', unread: unreadOf[id] ?? 0, lastAt: 1, preview: '' }; };
  const slot = renderSlot({ component: Contacts }, {}, { sdk: { threads: { update, unpin, reorderPinned } }, rpc: { getPreferences: () => ({ groupByProject: grouped }), recipients: (input: { pinned?: string[] }) => { asked.push(input); return { recipients: contacts.map(recipient), subUnread, pinned: (input?.pinned ?? []).map(recipient) }; } }, sidebarThreads: { threads, projects: [{ id: 'proj_a', name: 'Alpha', isPersonal: false }, { id: 'proj_b', name: 'Beta', isPersonal: false }] } } as any);
  return { slot, update, unpin, reorderPinned, onSelect, asked };
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
it('keeps a pinned session pinned when nesting it', async () => {
  const calls: string[] = [];
  const { slot } = setup({ rows: [{ id: 'thr_parent' }, { id: 'thr_kid', fields: { parentThreadId: 'thr_parent', isPinned: true } }, { id: 'thr_other' }], contacts: ['thr_parent', 'thr_other'], update: vi.fn(async () => { calls.push('update'); }), unpin: vi.fn(async () => { calls.push('unpin'); }) });
  drag(await row(slot, 'kid'), await row(slot, 'other'));
  await waitFor(() => expect(calls).toEqual(['update']));
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

describe('Pinned group', () => {
  const pin = (at: number, fields: object = {}) => ({ isPinned: true, pinnedAt: at, pinSortKey: null, createdAt: 1, ...fields });
  it('lists pinned sessions first, in bb\'s order, with the server\'s unread count, and asks for them sorted', async () => {
    const { slot, asked } = setup({ rows: [{ id: 'thr_old', fields: pin(10) }, { id: 'thr_new', fields: pin(20) }, { id: 'thr_plain' }], contacts: ['thr_plain'], unreadOf: { thr_old: 2 } });
    const group = await slot.findByRole('group', { name: 'Pinned' });
    await waitFor(() => expect(within(group).getByLabelText('2 unread')).toBeTruthy());
    expect(within(group).getAllByRole('option').map(o => o.textContent)).toEqual([expect.stringContaining('new'), expect.stringContaining('old')]);
    expect(slot.getAllByRole('option')[0]!.textContent).toContain('new');
    expect(asked).toContainEqual({ pinned: ['thr_new', 'thr_old'] });
  });
  it('lists a pinned session once, even when the server also lists it as a contact', async () => {
    const { slot } = setup({ rows: [{ id: 'thr_both', fields: pin(10) }, { id: 'thr_plain' }], contacts: ['thr_both', 'thr_plain'] });
    await slot.findByRole('group', { name: 'Pinned' });
    expect(slot.getAllByText('both')).toHaveLength(1);
  });
  it('keeps a pinned sub-session under its parent, first among its siblings, and listed while collapsed', async () => {
    const { slot } = setup({ rows: [{ id: 'thr_parent' }, { id: 'thr_plain', fields: { parentThreadId: 'thr_parent' } }, { id: 'thr_kid', fields: { parentThreadId: 'thr_parent', ...pin(10) } }], contacts: ['thr_parent'] });
    const subs = await slot.findByRole('list', { name: 'Sub-sessions of parent' });
    expect(slot.queryByRole('group', { name: 'Pinned' })).toBeNull();
    expect(within(subs).getAllByRole('button').map(b => b.textContent)).toEqual([expect.stringContaining('kid'), expect.stringContaining('plain')]);
    fireEvent.click(slot.getByRole('button', { name: 'Hide sub-sessions' }));
    await waitFor(() => expect(within(slot.getByRole('list', { name: 'Sub-sessions of parent' })).getAllByRole('button').map(b => b.textContent)).toEqual([expect.stringContaining('kid')]));
  });
  it.each([false, true])('lists the top-level parent of a nested pin even without a conversation, and asks for rows for both (sidebar: %s)', async sidebar => {
    const { slot, asked } = setup({ sidebar, rows: [{ id: 'thr_quiet' }, { id: 'thr_kid', fields: { parentThreadId: 'thr_quiet', ...pin(10) } }, { id: 'thr_plain' }], contacts: ['thr_plain'] });
    const subs = await slot.findByRole('list', { name: 'Sub-sessions of quiet' });
    expect(within(subs).getByText('kid')).toBeTruthy();
    expect(asked).toContainEqual({ pinned: ['thr_kid', 'thr_quiet'] });
  });
  it('asks for a row for a nested pin inside a pinned root too, and badges it from that row', async () => {
    const { slot, asked } = setup({ rows: [{ id: 'thr_top', fields: pin(20) }, { id: 'thr_kid', fields: { parentThreadId: 'thr_top', ...pin(10) } }], contacts: [], unreadOf: { thr_kid: 4 } });
    const subs = await slot.findByRole('list', { name: 'Sub-sessions of top' });
    await waitFor(() => expect(within(subs).getByLabelText('4 unread')).toBeTruthy());
    expect(asked).toContainEqual({ pinned: ['thr_kid', 'thr_top'] });
  });
  it('badges a nested pin from its own row, not from subUnread', async () => {
    const { slot } = setup({ rows: [{ id: 'thr_parent' }, { id: 'thr_kid', fields: { parentThreadId: 'thr_parent', ...pin(10) } }, { id: 'thr_read', fields: { parentThreadId: 'thr_parent', ...pin(5) } }], contacts: ['thr_parent'], unreadOf: { thr_kid: 2, thr_read: 0 }, subUnread: { thr_read: 3 } });
    const subs = await slot.findByRole('list', { name: 'Sub-sessions of parent' });
    await waitFor(() => expect(within(subs).getByLabelText('2 unread')).toBeTruthy());
    expect(within(subs).queryByLabelText('3 unread')).toBeNull();
  });
  it('reorders pinned sub-sessions of one parent from a sibling\'s edge, and refuses an unpinned one there', async () => {
    const { slot, reorderPinned } = setup({ rows: [{ id: 'thr_parent' }, { id: 'thr_k1', fields: { parentThreadId: 'thr_parent', ...pin(20) } }, { id: 'thr_k2', fields: { parentThreadId: 'thr_parent', ...pin(10) } }, { id: 'thr_free', fields: { parentThreadId: 'thr_parent' } }], contacts: ['thr_parent'] });
    const ghost = () => slot.queryByRole('status', { name: 'Dragged session' });
    drag(await row(slot, 'free'), await row(slot, 'k1'), 0.1, false);
    await waitFor(() => expect(ghost()?.textContent).toBe("freeCan't drop here"));
    fireEvent.keyDown(window, { key: 'Escape' });
    drag(await row(slot, 'k2'), await row(slot, 'k1'), 0.1, false);
    await waitFor(() => expect(ghost()?.textContent).toBe('k2Move among pinned sub-sessions'));
    fireEvent.pointerUp(window, { clientX: 0, clientY: 10 });
    await waitFor(() => expect(reorderPinned).toHaveBeenCalledExactlyOnceWith({ threadId: 'thr_k2', previousThreadId: null, nextThreadId: 'thr_k1' }));
  });
  it('marks pinned rows with a pin icon, and only those', async () => {
    const { slot } = setup({ rows: [{ id: 'thr_top', fields: pin(20) }, { id: 'thr_kid', fields: { parentThreadId: 'thr_top' } }, { id: 'thr_parent' }, { id: 'thr_pinsub', fields: { parentThreadId: 'thr_parent', ...pin(10) } }, { id: 'thr_plainsub', fields: { parentThreadId: 'thr_parent' } }, { id: 'thr_plain' }], contacts: ['thr_parent', 'thr_plain', 'thr_top'] });
    await slot.findByText('pinsub'); await slot.findByText('kid');
    const marked = (name: string) => !!within((slot.getByText(name).closest('button') as HTMLElement)).queryByRole('img', { name: 'Pinned' });
    expect(['top', 'pinsub'].map(marked)).toEqual([true, true]);
    expect(['kid', 'plainsub', 'plain', 'parent'].map(marked)).toEqual([false, false, false, false]);
  });
  it('opens a pinned sub-session\'s own sub-sessions from its chevron under a collapsed parent', async () => {
    const { slot } = setup({ rows: [{ id: 'thr_parent' }, { id: 'thr_lead', fields: { parentThreadId: 'thr_parent', ...pin(10) } }, { id: 'thr_worker', fields: { parentThreadId: 'thr_lead' } }, { id: 'thr_other', fields: { parentThreadId: 'thr_parent' } }], contacts: ['thr_parent'] });
    await slot.findByText('lead');
    fireEvent.click(slot.getByRole('button', { name: 'Hide sub-sessions' }));
    await waitFor(() => expect(slot.queryByText('other')).toBeNull());
    expect(slot.queryByText('worker')).toBeNull();
    const chevron = slot.getByRole('button', { name: 'Show nested sub-sessions' });
    expect(chevron.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(chevron);
    await waitFor(() => expect(slot.getByText('worker')).toBeTruthy());
    expect(slot.queryByText('other')).toBeNull();
    fireEvent.click(slot.getByRole('button', { name: 'Hide nested sub-sessions' }));
    await waitFor(() => expect(slot.queryByText('worker')).toBeNull());
  });
  it('shows a pinned session instead of the empty state', async () => {
    const { slot } = setup({ rows: [{ id: 'thr_only', fields: pin(10) }], contacts: [] });
    await slot.findByRole('group', { name: 'Pinned' });
    expect(slot.queryByText('All caught up')).toBeNull();
  });
  it('reorders Pinned from a pinned row\'s edge', async () => {
    const { slot, reorderPinned, update } = setup({ rows: [{ id: 'thr_one', fields: pin(30) }, { id: 'thr_two', fields: pin(20) }, { id: 'thr_three', fields: pin(10) }], contacts: [] });
    drag(await row(slot, 'one'), await row(slot, 'three'), 0.9);
    await waitFor(() => expect(reorderPinned).toHaveBeenCalledExactlyOnceWith({ threadId: 'thr_one', previousThreadId: 'thr_three', nextThreadId: null }));
    expect(update).not.toHaveBeenCalled();
  });
  it('unpins a pinned session dropped on its project\'s header', async () => {
    const { slot, unpin, update } = setup({ grouped: true, rows: [{ id: 'thr_pinned', fields: pin(10) }, { id: 'thr_plain' }], contacts: ['thr_plain'] });
    const header = (await slot.findByRole('group', { name: 'Alpha' })).querySelector<HTMLElement>('[data-reparent-key="group:proj_a"]')!;
    drag(await row(slot, 'pinned'), header);
    await waitFor(() => expect(unpin).toHaveBeenCalledExactlyOnceWith({ threadId: 'thr_pinned' }));
    expect(update).not.toHaveBeenCalled();
  });
});
