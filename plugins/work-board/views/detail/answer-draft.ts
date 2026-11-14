/**
 * Unsaved answers survive leaving the plugin until the question is answered:
 * choices and text in localStorage, chosen files as Blobs in IndexedDB.
 * A draft belongs to one question revision; a changed question drops it.
 */
export type AnswerDraft = { selected: string[]; other: boolean; text: string };

const key = (questionId: string) => `bb-work-board:answer-draft:${questionId}`;

export function readAnswerDraft(questionId: string, revision: number): AnswerDraft | null {
  try {
    const stored = JSON.parse(localStorage.getItem(key(questionId)) ?? "null") as (AnswerDraft & { revision: number }) | null;
    return stored && stored.revision === revision ? { selected: stored.selected, other: stored.other, text: stored.text } : null;
  } catch {
    return null;
  }
}

export function writeAnswerDraft(questionId: string, revision: number, draft: AnswerDraft | null) {
  try {
    if (draft) localStorage.setItem(key(questionId), JSON.stringify({ ...draft, revision }));
    else localStorage.removeItem(key(questionId));
  } catch {
    // Storage full or blocked: the draft simply stays in memory.
  }
}

type StoredFiles = { revision: number; files: { name: string; type: string; lastModified: number; blob: Blob }[] };

function filesStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  if (typeof indexedDB === "undefined") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const open = indexedDB.open("bb-work-board-drafts", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("answer-files");
    open.onerror = () => resolve(undefined);
    open.onsuccess = () => {
      const db = open.result;
      const request = run(db.transaction("answer-files", mode).objectStore("answer-files"));
      request.onsuccess = () => { resolve(request.result); db.close(); };
      request.onerror = () => { resolve(undefined); db.close(); };
    };
  });
}

export async function readAnswerFiles(questionId: string, revision: number): Promise<File[]> {
  const stored = await filesStore<StoredFiles | undefined>("readonly", store => store.get(questionId));
  if (!stored || stored.revision !== revision) return [];
  return stored.files.map(file => new File([file.blob], file.name, { type: file.type, lastModified: file.lastModified }));
}

export async function writeAnswerFiles(questionId: string, revision: number, files: readonly File[]) {
  await filesStore<unknown>("readwrite", store => (files.length
    ? store.put({ revision, files: files.map(file => ({ name: file.name, type: file.type, lastModified: file.lastModified, blob: file })) } satisfies StoredFiles, questionId)
    : store.delete(questionId)) as IDBRequest<unknown>);
}

export function clearAnswerDraft(questionId: string) {
  writeAnswerDraft(questionId, 0, null);
  void writeAnswerFiles(questionId, 0, []);
}
