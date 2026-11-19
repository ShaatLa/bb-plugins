import { useEffect, useState } from 'react';

// bb unmounts the plugin page when the user switches screens; keep page state across that (and reloads).
export function useStoredState<T>(key: string | null, initial: T) {
  const [value, setValue] = useState<T>(() => {
    if (!key) return initial;
    try { const raw = localStorage.getItem(key); return raw === null ? initial : JSON.parse(raw) as T; } catch { return initial; }
  });
  useEffect(() => {
    if (!key) return;
    try { if (value === undefined || value === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  }, [key, value]);
  return [value, setValue] as const;
}
