import { createContext, createElement, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';

export const OPEN_CHAT_KEY = 'bb-plugin-answers:page:selected';
function initialThread() {
  try { const value: unknown = JSON.parse(localStorage.getItem(OPEN_CHAT_KEY) ?? 'null'); return typeof value === 'string' && value ? value : undefined; } catch { return undefined; }
}
let snapshot = { threadId: initialThread(), revision: 0, working: false };
const listeners = new Set<() => void>();
// revision moves when the chat changes or its turn completes (tabs refetch); working follows the open chat's agent.
export function setOpenChat(threadId: string | undefined, isWorking: boolean) {
  const changed = snapshot.threadId !== threadId, completed = !changed && snapshot.working && !isWorking;
  if (!changed && snapshot.working === isWorking) return;
  snapshot = { threadId, revision: snapshot.revision + (changed || completed ? 1 : 0), working: isWorking };
  listeners.forEach(listener => listener());
}
export function useOpenChat() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => snapshot, () => snapshot);
}

export const CONTACT_SELECTED = 'answers:contact-selected';
function storeSelection(threadId: string | undefined) {
  try { if (threadId) localStorage.setItem(OPEN_CHAT_KEY, JSON.stringify(threadId)); else localStorage.removeItem(OPEN_CHAT_KEY); } catch { /* storage unavailable */ }
}
type ContactPage = { threadId: string | undefined; working: boolean; open: boolean; listeners: Set<() => void> };
const ContactContext = createContext<ContactPage | null>(null);
const pages = new Set<ContactPage>();
let activePage: ContactPage | undefined;
function activatePage(page: ContactPage) {
  activePage = page; storeSelection(page.threadId); setOpenChat(page.threadId, page.working);
  window.dispatchEvent(new Event(CONTACT_SELECTED));
}
function choose(page: ContactPage, threadId: string | undefined) {
  page.threadId = threadId; page.working = false; page.open = true;
  page.listeners.forEach(listener => listener()); activatePage(page);
  window.dispatchEvent(new CustomEvent(CONTACT_SELECTED, { detail: page }));
}
export function isChatOpen(threadId: string) { return [...pages].some(page => page.open && page.threadId === threadId); }
export function selectContact(threadId: string | undefined) {
  if (activePage) { choose(activePage, threadId); return true; }
  storeSelection(threadId); window.dispatchEvent(new Event(CONTACT_SELECTED)); return false;
}
let pending: { threadId: string; dispose: () => void } | undefined;
export function beginContactDrag(threadId: string) {
  pending?.dispose();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const dispose = () => { clearTimeout(timer); window.removeEventListener('pointerup', release, true); window.removeEventListener('pointercancel', dispose, true); window.removeEventListener('keydown', escape, true); window.removeEventListener('blur', dispose); pending = undefined; };
  const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') dispose(); };
  const release = (event: PointerEvent) => {
    const target = document.elementFromPoint?.(event.clientX, event.clientY) ?? event.target;
    if (target instanceof Element && target.closest('[role="listbox"][aria-label="Recipients"]')) { dispose(); return; }
    // bb mounts the new pane after its own pointerup handler; waiting lets that pane claim the drag before an existing one does.
    timer = setTimeout(() => { dispose(); if (activePage) choose(activePage, threadId); }, 600);
  };
  pending = { threadId, dispose };
  window.addEventListener('pointerup', release, true); window.addEventListener('pointercancel', dispose, true); window.addEventListener('keydown', escape, true); window.addEventListener('blur', dispose);
}
export function ContactPageProvider({ children }: { children: ReactNode }) {
  const [page] = useState<ContactPage>(() => {
    const url = new URL(window.location.href), linked = url.searchParams.get('thread'), dragged = pending?.threadId;
    pending?.dispose();
    if (linked) { url.searchParams.delete('thread'); window.history.replaceState(window.history.state, '', url); }
    return { threadId: dragged ?? linked ?? initialThread(), working: false, open: !!(dragged || linked), listeners: new Set() };
  });
  useEffect(() => { pages.add(page); activatePage(page); return () => { pages.delete(page); if (activePage === page) { activePage = undefined; const last = [...pages].at(-1); if (last) activatePage(last); } }; }, [page]);
  return createElement(ContactContext.Provider, { value: page }, children);
}
export function useContactPage() { return useContext(ContactContext); }
export function useContactSelection() {
  const page = useContactPage(), selected = useSelectedContact();
  return { selected, select: page ? (id: string | undefined) => choose(page, id) : selectContact, activate: () => { if (page) activatePage(page); }, setWorking: (working: boolean) => { if (page) { page.working = working; if (activePage !== page) return; } setOpenChat(selected, working); } };
}
export function useSelectedContact() {
  const page = useContactPage();
  return useSyncExternalStore(listener => {
    if (page) { page.listeners.add(listener); return () => { page.listeners.delete(listener); }; }
    window.addEventListener(CONTACT_SELECTED, listener); window.addEventListener('storage', listener);
    return () => { window.removeEventListener(CONTACT_SELECTED, listener); window.removeEventListener('storage', listener); };
  }, () => page ? page.threadId : activePage ? activePage.threadId : initialThread(), () => undefined);
}

// Counts mounted sidebar contact lists, so the page can drop its own column while bb's sidebar shows ours.
let sidebarMounts = 0;
const sidebarListeners = new Set<() => void>();
export function mountSidebarContacts() {
  sidebarMounts++; sidebarListeners.forEach(listener => listener());
  return () => { sidebarMounts--; sidebarListeners.forEach(listener => listener()); };
}
export function useSidebarContacts() {
  return useSyncExternalStore(listener => { sidebarListeners.add(listener); return () => { sidebarListeners.delete(listener); }; }, () => sidebarMounts > 0, () => false);
}

// bb's thread routes; a message is ?msg= in Agent Hub's own links and #msg= in bb's message chips.
const THREAD_PATH = /^\/(?:projects\/[^/]+\/)?threads\/([\w-]+)\/?$/;
export function threadLink(href: string): { threadId: string; seq: number | null } | null {
  let url: URL; try { url = new URL(href, window.location.origin); } catch { return null; }
  const threadId = url.origin === window.location.origin ? THREAD_PATH.exec(url.pathname)?.[1] : undefined;
  if (!threadId) return null;
  const msg = url.searchParams.get('msg') ?? new URLSearchParams(url.hash.slice(1)).get('msg');
  return { threadId, seq: msg && /^\d+$/.test(msg) ? Number(msg) : null };
}
// A message link waits here until the chat it points to has loaded its history.
export const JUMP_EVENT = 'agent-hub:jump';
let pendingJump: { threadId: string; seq: number } | null = null;
export function requestJump(threadId: string, seq: number) { pendingJump = { threadId, seq }; window.dispatchEvent(new Event(JUMP_EVENT)); }
export function takeJump(threadId: string) { if (pendingJump?.threadId !== threadId) return null; const { seq } = pendingJump; pendingJump = null; return seq; }
