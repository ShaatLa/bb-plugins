const active = new Map<string, number>();

// Uncommitted uploads/imports remain protected even if they outlive the orphan grace period.
export function protectBlob(path: string): () => void {
  active.set(path, (active.get(path) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (active.get(path) ?? 1) - 1;
    if (count) active.set(path, count); else active.delete(path);
  };
}
export const blobIsActive = (path: string) => active.has(path);
