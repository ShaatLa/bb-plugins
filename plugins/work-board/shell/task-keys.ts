import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { TasksRpcContract } from "../shared/contract.js";
import { MAX_RESOLVE_KEYS, type ResolvedTaskKey } from "../shared/task-keys.js";

// One lookup shared by every text that mentions a key. `task`: undefined = never answered, null = no such card.
// `fresh` = answered in the current generation; `loading` = asked in it and not answered yet.
interface Entry { task: ResolvedTaskKey | null | undefined; fresh: boolean; loading: boolean }
type Resolver = (input: { keys: string[] }) => Promise<{ tasks: ResolvedTaskKey[] }>;

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const pending = new Set<string>();
let resolver: Resolver | null = null;
let generation = 0;
let version = 0;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let invalidating = false;

function changed() {
  version++;
  for (const listener of listeners) listener();
}

function flush() {
  flushTimer = undefined;
  const keys = [...pending];
  pending.clear();
  const sent = generation;
  const resolve = resolver;
  if (!resolve) return;
  for (let from = 0; from < keys.length; from += MAX_RESOLVE_KEYS) {
    const chunk = keys.slice(from, from + MAX_RESOLVE_KEYS);
    for (const key of chunk) entries.set(key, { task: entries.get(key)?.task, fresh: false, loading: true });
    Promise.resolve().then(() => resolve({ keys: chunk })).then(({ tasks }) => {
      // A response from before an invalidation may be stale: only the current generation counts.
      if (sent !== generation) return;
      const found = new Map(tasks.map((task) => [task.key, task]));
      for (const key of chunk) entries.set(key, { task: found.get(key) ?? null, fresh: true, loading: false });
      changed();
    }, () => {
      // The keys stay as they were (plain text) until a later mount or invalidation asks again.
      if (sent !== generation) return;
      for (const key of chunk) entries.set(key, { task: entries.get(key)?.task, fresh: false, loading: false });
    });
  }
}

function request(keys: readonly string[]) {
  for (const key of keys) {
    const entry = entries.get(key);
    if (!entry || (!entry.fresh && !entry.loading)) pending.add(key);
  }
  if (pending.size > 0) flushTimer ??= setTimeout(flush, 0);
}

// Coalesced: one event reaches every mounted consumer, but the generation moves once.
function invalidate() {
  if (invalidating) return;
  invalidating = true;
  queueMicrotask(() => {
    invalidating = false;
    generation++;
    // Keep the last answers visible until the new ones arrive, so links do not flicker off.
    for (const [key, entry] of entries) entries.set(key, { task: entry.task, fresh: false, loading: false });
    pending.clear();
    changed();
  });
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/**
 * Looks up which of `keys` are cards. One batched call per 500 keys serves every mounted text; the returned function
 * gives the card behind a written key, or undefined while unknown, loading, missing or failed (the key stays plain text).
 */
export function useTaskKeys(keys: readonly string[]): (key: string) => ResolvedTaskKey | undefined {
  const rpc = useRpc<TasksRpcContract>();
  resolver = rpc.call.bind(rpc, "resolveTaskKeys") as Resolver;
  const seen = useSyncExternalStore(subscribe, () => version);
  const epoch = useSyncExternalStore(subscribe, () => generation);
  useRealtime("tasks:changed", invalidate);
  useRealtime("projects:changed", invalidate);
  const wanted = keys.join(" ");
  useEffect(() => request(wanted ? wanted.split(" ") : []), [wanted, epoch]);
  return useCallback((key) => entries.get(key)?.task ?? undefined, [seen]);
}

export function resetTaskKeysForTest() {
  clearTimeout(flushTimer);
  flushTimer = undefined;
  entries.clear();
  pending.clear();
  generation++;
  version++;
  invalidating = false;
}
