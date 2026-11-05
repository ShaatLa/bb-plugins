import type { z } from "zod";

const QUERY_SNAPSHOT_STORAGE_ROOT = "bb-work-board:query-snapshot:";
const QUERY_SNAPSHOT_STORAGE_VERSION = "v1";
const QUERY_SNAPSHOT_STORAGE_PREFIX = `${QUERY_SNAPSHOT_STORAGE_ROOT}${QUERY_SNAPSHOT_STORAGE_VERSION}:`;
const WRITE_DELAY_MS = 25;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const MAX_SNAPSHOT_KEYS = 32;

export function querySnapshotStorageKey(name: string): string {
  return `${QUERY_SNAPSHOT_STORAGE_PREFIX}${name}`;
}

let prunedOtherVersions = false;

const claimedRevisions = new Map<string, number>();
const writtenRevisions = new Map<string, number>();
const pendingWrites = new Map<string, { revision: number; value: unknown; timer: ReturnType<typeof setTimeout> }>();

export function resetQuerySnapshotStateForTest(): void {
  prunedOtherVersions = false;
  claimedRevisions.clear();
  writtenRevisions.clear();
  for (const pending of pendingWrites.values()) clearTimeout(pending.timer);
  pendingWrites.clear();
}

export function claimQuerySnapshotRevision(name: string): number {
  const revision = (claimedRevisions.get(name) ?? 0) + 1;
  claimedRevisions.set(name, revision);
  return revision;
}

function pruneOtherSnapshotVersions(): void {
  if (prunedOtherVersions) return;
  prunedOtherVersions = true;
  try {
    const stale: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (
        key !== null &&
        key.startsWith(QUERY_SNAPSHOT_STORAGE_ROOT) &&
        !key.startsWith(QUERY_SNAPSHOT_STORAGE_PREFIX)
      ) {
        stale.push(key);
      }
    }
    for (const key of stale) window.localStorage.removeItem(key);
  } catch {}
}

export function readQuerySnapshot<T>(
  name: string,
  schema: z.ZodType<T>,
): T | undefined {
  pruneOtherSnapshotVersions();
  try {
    const raw = window.localStorage.getItem(querySnapshotStorageKey(name));
    if (raw === null) return undefined;
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function writeQuerySnapshot(
  name: string,
  value: unknown,
  revision: number,
): void {
  pruneOtherSnapshotVersions();
  const key = querySnapshotStorageKey(name);
  if (revision < Math.max(writtenRevisions.get(name) ?? 0, pendingWrites.get(name)?.revision ?? 0)) return;
  const previous = pendingWrites.get(name);
  if (previous) clearTimeout(previous.timer);
  // Keep the newest revision visible immediately while delaying only synchronous storage work.
  const pending = { revision, value, timer: setTimeout(() => {
    if (pendingWrites.get(name) !== pending) return;
    pendingWrites.delete(name);
    if (revision < (writtenRevisions.get(name) ?? 0)) return;
    try {
      const serialized = JSON.stringify(value);
      if (serialized.length * 2 > MAX_SNAPSHOT_BYTES) return;
      const storage = window.localStorage;
      const keys: string[] = [];
      let bytes = 0;
      for (let index = 0; index < storage.length; index += 1) {
        const existingKey = storage.key(index);
        if (existingKey?.startsWith(QUERY_SNAPSHOT_STORAGE_PREFIX)) {
          keys.push(existingKey);
          bytes += existingKey.length * 2 + (storage.getItem(existingKey)?.length ?? 0) * 2;
        }
      }
      for (const existingKey of keys) {
        if (existingKey === key || (keys.length < MAX_SNAPSHOT_KEYS && bytes <= MAX_SNAPSHOT_BYTES - serialized.length * 2)) break;
        const old = storage.getItem(existingKey);
        storage.removeItem(existingKey);
        keys.splice(keys.indexOf(existingKey), 1);
        bytes -= existingKey.length * 2 + (old?.length ?? 0) * 2;
      }
      storage.setItem(key, serialized);
      writtenRevisions.set(name, revision);
    } catch {}
  }, WRITE_DELAY_MS) };
  pendingWrites.set(name, pending);
}
