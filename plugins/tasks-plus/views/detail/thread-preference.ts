import { useSyncExternalStore } from "react";

export interface DefaultThread {
  id: string;
  title: string;
}

const CHANGED = "bb-tasks-plus:default-thread-changed";
const storageKey = (projectId: string) => `bb-tasks-plus:default-thread:${projectId}`;

function subscribe(onChange: () => void) {
  window.addEventListener(CHANGED, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function useDefaultThread(projectId: string): DefaultThread | null {
  const raw = useSyncExternalStore(subscribe, () => {
    try { return window.localStorage.getItem(storageKey(projectId)); }
    catch { return null; }
  }, () => null);
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (value && typeof value === "object" && "id" in value && "title" in value &&
        typeof value.id === "string" && /^thr_[a-zA-Z0-9_-]+$/.test(value.id) && typeof value.title === "string") {
      return { id: value.id, title: value.title };
    }
  } catch {}
  return null;
}

export function storeDefaultThread(projectId: string, thread: DefaultThread | null): void {
  try {
    if (thread) window.localStorage.setItem(storageKey(projectId), JSON.stringify(thread));
    else window.localStorage.removeItem(storageKey(projectId));
    window.dispatchEvent(new Event(CHANGED));
  } catch {}
}
