import { useSyncExternalStore } from 'react';

export const OPEN_CHAT_KEY = 'bb-plugin-answers:page:selected';
function initialThread() {
  try { const value: unknown = JSON.parse(localStorage.getItem(OPEN_CHAT_KEY) ?? 'null'); return typeof value === 'string' && value ? value : undefined; } catch { return undefined; }
}
let snapshot = { threadId: initialThread(), revision: 0 }, working = false;
const listeners = new Set<() => void>();
export function setOpenChat(threadId: string | undefined, isWorking: boolean) {
  const changed = snapshot.threadId !== threadId;
  const completed = !changed && working && !isWorking;
  working = isWorking;
  if (!changed && !completed) return;
  snapshot = { threadId, revision: snapshot.revision + 1 };
  listeners.forEach(listener => listener());
}
export function useOpenChat() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => snapshot, () => snapshot);
}
