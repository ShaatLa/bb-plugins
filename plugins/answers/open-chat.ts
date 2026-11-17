import { useSyncExternalStore } from 'react';

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
export function selectContact(threadId: string | undefined) {
  try { if (threadId) localStorage.setItem(OPEN_CHAT_KEY, JSON.stringify(threadId)); else localStorage.removeItem(OPEN_CHAT_KEY); } catch { /* storage unavailable */ }
  window.dispatchEvent(new Event(CONTACT_SELECTED));
}
export function useSelectedContact() {
  return useSyncExternalStore(listener => { window.addEventListener(CONTACT_SELECTED, listener); window.addEventListener('storage', listener); return () => { window.removeEventListener(CONTACT_SELECTED, listener); window.removeEventListener('storage', listener); }; }, initialThread, () => undefined);
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
