import { useSyncExternalStore } from 'react';

export const COMPOSE_KEY = 'bb-plugin-answers:page:compose';
export const DRAFTS_EVENT = 'answers:drafts';
const none = new Set<string>();
let cache: { raw: string | null; ids: Set<string> } = { raw: null, ids: none };
// Threads whose Answers composer holds unsent text or files; bb's own draft state never sees this composer.
function snapshot() {
  let raw: string | null = null; try { raw = localStorage.getItem(COMPOSE_KEY); } catch { /* storage unavailable */ }
  if (raw === cache.raw) return cache.ids;
  const ids = new Set<string>();
  try { for (const [id, draft] of Object.entries(JSON.parse(raw ?? '{}') as Record<string, { text?: string; files?: unknown[] }>)) if (draft?.text?.trim() || draft?.files?.length) ids.add(id); } catch { /* malformed: treat as none */ }
  cache = { raw, ids }; return ids;
}
function subscribe(changed: () => void) {
  window.addEventListener(DRAFTS_EVENT, changed); window.addEventListener('storage', changed);
  return () => { window.removeEventListener(DRAFTS_EVENT, changed); window.removeEventListener('storage', changed); };
}
export const useDraftThreads = () => useSyncExternalStore(subscribe, snapshot, () => none);
