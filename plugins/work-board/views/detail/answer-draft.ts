/**
 * Unsaved answers survive leaving the plugin until the question is answered:
 * choices and text in localStorage, chosen files as Blobs in IndexedDB.
 * A draft belongs to one question revision; a stale or changed one is deleted
 * when read, and a sweep drops anything untouched for DRAFT_TTL_MS, so
 * abandoned drafts (deleted tasks, answers given elsewhere) do not pile up.
 */
export type AnswerDraft = { selected: string[]; other: boolean; text: string };

export const DRAFT_TTL_MS = 14 * 86_400_000;
const PREFIX = "bb-work-board:answer-draft:";
const key = (questionId: string) => PREFIX + questionId;

export function readAnswerDraft(questionId: string, revision: number): AnswerDraft | null {
  try {
    const stored = JSON.parse(localStorage.getItem(key(questionId)) ?? "null") as (AnswerDraft & { revision: number }) | null;
    if (stored && stored.revision === revision) return { selected: stored.selected, other: stored.other, text: stored.text };
    if (stored) localStorage.removeItem(key(questionId));
  } catch {
    // Unreadable entries are dropped by the sweep.
  }
  return null;
}

export function writeAnswerDraft(questionId: string, revision: number, draft: AnswerDraft | null) {
  try {
    if (draft) localStorage.setItem(key(questionId), JSON.stringify({ ...draft, revision, savedAt: Date.now() }));
    else localStorage.removeItem(key(questionId));
  } catch {
    // Storage full or blocked: the draft simply stays in memory.
  }
}

type StoredFiles = { revision: number; savedAt: number; files: { name: string; type: string; lastModified: number; blob: Blob }[] };

function withFiles<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore, done: (value: T) => void) => void): Promise<T | undefined> {
  if (typeof indexedDB === "undefined") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const open = indexedDB.open("bb-work-board-drafts", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("answer-files");
    open.onerror = () => resolve(undefined);
    open.onsuccess = () => {
      const db = open.result;
      const transaction = db.transaction("answer-files", mode);
      let result: T | undefined;
      transaction.oncomplete = () => { db.close(); resolve(result); };
      transaction.onerror = transaction.onabort = () => { db.close(); resolve(undefined); };
      run(transaction.objectStore("answer-files"), (value) => { result = value; });
    };
  });
}

export async function readAnswerFiles(questionId: string, revision: number): Promise<File[]> {
  const stored = await withFiles<StoredFiles | undefined>("readwrite", (store, done) => {
    const request = store.get(questionId);
    request.onsuccess = () => {
      const value = request.result as StoredFiles | undefined;
      if (value && value.revision !== revision) store.delete(questionId);
      done(value?.revision === revision ? value : undefined);
    };
  });
  return stored?.files.map(file => new File([file.blob], file.name, { type: file.type, lastModified: file.lastModified })) ?? [];
}

export async function writeAnswerFiles(questionId: string, revision: number, files: readonly File[]) {
  await withFiles<void>("readwrite", (store) => {
    if (files.length) store.put({ revision, savedAt: Date.now(), files: files.map(file => ({ name: file.name, type: file.type, lastModified: file.lastModified, blob: file })) } satisfies StoredFiles, questionId);
    else store.delete(questionId);
  });
}

export function clearAnswerDraft(questionId: string) {
  writeAnswerDraft(questionId, 0, null);
  void writeAnswerFiles(questionId, 0, []);
}

let swept = false;

/** Drop drafts untouched for DRAFT_TTL_MS; runs once per page load. */
export async function sweepAnswerDrafts(now = Date.now(), force = false) {
  if (swept && !force) return;
  swept = true;
  const cutoff = now - DRAFT_TTL_MS;
  try {
    for (const name of Object.keys(localStorage).filter(item => item.startsWith(PREFIX))) {
      let savedAt = 0;
      try { savedAt = Number((JSON.parse(localStorage.getItem(name) ?? "null") as { savedAt?: number } | null)?.savedAt) || 0; } catch { /* unreadable: expire */ }
      if (savedAt < cutoff) localStorage.removeItem(name);
    }
  } catch {
    // localStorage unavailable.
  }
  await withFiles<void>("readwrite", (store) => {
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const entry = cursor.result;
      if (!entry) return;
      if (!((entry.value as Partial<StoredFiles>).savedAt! >= cutoff)) entry.delete();
      entry.continue();
    };
  });
}
