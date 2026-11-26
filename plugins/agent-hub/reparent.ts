import { useEffect, useRef, useState } from 'react';
import { useSdk, type PluginSidebarThread } from '@get-bb/plugin-sdk/app';

// bb's pin order (its thread-list plugin): manual keys first when both have one, then the newest pin, the newest thread, the id.
const byPin = (a: PluginSidebarThread, b: PluginSidebarThread) => (a.pinSortKey !== null && b.pinSortKey !== null && a.pinSortKey !== b.pinSortKey ? (a.pinSortKey < b.pinSortKey ? -1 : 1) : 0)
  || (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0) || b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
// bb's Pinned group: pinned threads with all their descendants; a member whose parent is outside the group is one of its roots.
export function pinnedTree(threads: readonly PluginSidebarThread[]) {
  const live = threads.filter(t => !t.isHidden && t.archivedAt === null), kids = new Map<string, PluginSidebarThread[]>();
  for (const t of live) if (t.parentThreadId) kids.set(t.parentThreadId, [...(kids.get(t.parentThreadId) ?? []), t]);
  const members = new Set<string>(), add = (t: PluginSidebarThread) => { if (members.has(t.id)) return; members.add(t.id); for (const k of kids.get(t.id) ?? []) add(k); };
  for (const t of live) if (t.isPinned) add(t);
  const roots = live.filter(t => members.has(t.id) && !(t.parentThreadId && members.has(t.parentThreadId))).sort(byPin);
  return { members, roots };
}

// Drop rules of bb's own sidebar (its thread-list plugin): a row's middle band nests, the top level takes only the session's own project,
// a pinned root's edges reorder the Pinned group, and a pinned thread moved to the top level is unpinned.
export type ReparentTarget = { kind: 'nest'; threadId: string } | { kind: 'top'; projectId: string | null } | { kind: 'pin'; threadId: string; edge: 'before' | 'after' };
export type ReparentDrop = { ok: false } | { ok: true; parentThreadId?: string | null; sectionId?: string | null; unpin: boolean; reorder?: { previousThreadId: string | null; nextThreadId: string | null } };
export function decideDrop(threads: readonly PluginSidebarThread[], dragId: string, target: ReparentTarget, grouped: boolean): ReparentDrop | null {
  const byId = new Map(threads.map(t => [t.id, t])), drag = byId.get(dragId);
  if (!drag) return null;
  if (target.kind === 'pin') {
    const roots = pinnedTree(threads).roots.map(t => t.id);
    if (!roots.includes(dragId)) return { ok: false };
    const rest = roots.filter(id => id !== dragId), at = rest.indexOf(target.threadId) + (target.edge === 'after' ? 1 : 0);
    if (at < 0 || !rest.includes(target.threadId)) return null;
    const next = [...rest.slice(0, at), dragId, ...rest.slice(at)];
    if (next.every((id, i) => id === roots[i])) return null;
    return { ok: true, unpin: false, reorder: { previousThreadId: next[at - 1] ?? null, nextThreadId: next[at + 1] ?? null } };
  }
  if (target.kind === 'top') {
    if ((!drag.parentThreadId && !drag.isPinned) || (grouped && target.projectId !== drag.projectId)) return null;
    if (!drag.parentThreadId) return { ok: true, unpin: true };
    const parent = byId.get(drag.parentThreadId);
    return { ok: true, parentThreadId: null, sectionId: parent?.projectId === drag.projectId ? parent.sectionId : null, unpin: drag.isPinned };
  }
  const parent = byId.get(target.threadId);
  if (!parent) return null;
  // Walking up from the target finds the dragged session when the target is the session itself or one of its descendants.
  for (let t: PluginSidebarThread | undefined = parent, steps = 0; t && steps < 64; t = t.parentThreadId ? byId.get(t.parentThreadId) : undefined, steps++) if (t.id === dragId) return { ok: false };
  if (drag.parentThreadId === parent.id) return { ok: false };
  // A section belongs to one project, so a nest across projects keeps the session's own section.
  return { ok: true, parentThreadId: parent.id, ...(parent.projectId === drag.projectId ? { sectionId: parent.sectionId } : {}), unpin: drag.isPinned };
}

type Over = { key: string; target: ReparentTarget; edge?: 'before' | 'after'; drop: ReparentDrop | null };
// The target under the pointer, from the data-reparent-* marks on contact rows, project headers and the move-up row.
function targetAt(x: number, y: number): Omit<Over, 'drop'> | null {
  const el = document.elementFromPoint?.(x, y)?.closest<HTMLElement>('[data-reparent-key]');
  if (!el) return null;
  const key = el.dataset.reparentKey!, id = el.dataset.reparentId, project = el.dataset.reparentTop;
  const up = project === undefined ? null : { kind: 'top' as const, projectId: project || null };
  if (!id) return up && { key, target: up };
  const r = el.getBoundingClientRect(), rel = r.height ? (y - r.top) / r.height : 0.5;
  if (rel >= 0.25 && rel <= 0.75) return { key, target: { kind: 'nest', threadId: id } };
  const edge = rel < 0.25 ? 'before' as const : 'after' as const;
  if (el.dataset.reparentPin !== undefined) return { key, target: { kind: 'pin', threadId: id, edge }, edge };
  return up && { key, target: up, edge };
}

export type Reparent = ReturnType<typeof useReparent>;
// A vertical pointer drag inside the list; bb's split drag engages only past the row's right edge, and when it does this drag ends.
export function useReparent(threads: readonly PluginSidebarThread[], grouped: boolean, setError: (message: string) => void) {
  const sdk = useSdk();
  const [state, setState] = useState<{ id: string; over: Over | null; x: number; y: number } | null>(null);
  const live = useRef({ threads, grouped }); live.current = { threads, grouped };
  const press = useRef<{ id: string; x: number; y: number; right: number; active: boolean } | null>(null);
  const stop = useRef<() => void>(() => {});
  useEffect(() => () => stop.current(), []);
  function apply(id: string, drop: ReparentDrop) {
    if (!drop.ok) return;
    const { ok: _, unpin, reorder, ...update } = drop;
    void (async () => {
      try {
        if (unpin) await sdk.threads.unpin({ threadId: id });
        if (reorder) await sdk.threads.reorderPinned({ threadId: id, ...reorder });
        if ('parentThreadId' in update) await sdk.threads.update({ threadId: id, ...update });
      }
      catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    })();
  }
  function onPointerDown(id: string, event: { button: number; pointerType: string; clientX: number; clientY: number; currentTarget: Element }) {
    if (event.button !== 0 || event.pointerType === 'touch') return;
    stop.current();
    const list = event.currentTarget.closest('[role=listbox]');
    press.current = { id, x: event.clientX, y: event.clientY, right: (list ?? event.currentTarget).getBoundingClientRect().right, active: false };
    const end = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', end); window.removeEventListener('keydown', key); press.current = null; setState(null); document.body.style.removeProperty('cursor'); stop.current = () => {}; };
    const move = (e: PointerEvent) => {
      const p = press.current; if (!p) return;
      if (e.clientX > p.right) { end(); return; }
      const dy = Math.abs(e.clientY - p.y);
      if (!p.active) { if (dy < 4 || dy < Math.abs(e.clientX - p.x)) return; p.active = true; document.body.style.cursor = 'grabbing'; }
      const at = targetAt(e.clientX, e.clientY);
      setState({ id: p.id, x: e.clientX, y: e.clientY, over: at && { ...at, drop: decideDrop(live.current.threads, p.id, at.target, live.current.grouped) } });
    };
    const up = (e: PointerEvent) => {
      const p = press.current; end();
      if (!p?.active) return;
      // The click that follows the drop would open the chat under the pointer.
      const swallow = (c: MouseEvent) => { c.preventDefault(); c.stopPropagation(); };
      window.addEventListener('click', swallow, { capture: true, once: true }); setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
      const at = targetAt(e.clientX, e.clientY), drop = at && decideDrop(live.current.threads, p.id, at.target, live.current.grouped);
      if (drop) apply(p.id, drop);
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') end(); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', end); window.addEventListener('keydown', key);
    stop.current = end;
  }
  const dragging = state?.id ?? null, dragged = dragging ? threads.find(t => t.id === dragging) : undefined;
  const over = state?.over ?? null;
  // Classes for a drop target: a ring to nest, a line for a top-level edge, dimmed where bb would refuse the drop.
  const mark = (key: string) => over?.key !== key || !over.drop ? '' : !over.drop.ok ? 'cursor-not-allowed opacity-40' : over.edge === 'before' ? 'shadow-[0_-2px_0_0_var(--color-ring,currentColor)]' : over.edge === 'after' ? 'shadow-[0_2px_0_0_var(--color-ring,currentColor)]' : 'bg-state-hover ring-1 ring-inset ring-ring';
  return { dragging, dragged, over, mark, pointer: state && { x: state.x, y: state.y }, onPointerDown, cancel: () => stop.current() };
}
