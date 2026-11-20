// A stored actor name such as "agent (thr_example)" carries a thread id in its tail; the UI shows it as a thread chip.

const TRAILING_THREAD = /\s*\((thr_[A-Za-z0-9_-]+)\)\s*$/;

const BARE_THREAD = /^thr_[A-Za-z0-9_-]+$/;

/** The thread id in a trailing `(thr_…)` of `text` (or `text` being a bare thread id), and the text before it; null when there is none. */
export function parseThreadRef(text: string): { threadId: string; label: string } | null {
  if (BARE_THREAD.test(text.trim())) return { threadId: text.trim(), label: "" };
  const match = TRAILING_THREAD.exec(text);
  return match ? { threadId: match[1]!, label: text.slice(0, match.index).trim() } : null;
}
