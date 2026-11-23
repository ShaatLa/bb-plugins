import { useEffect, useMemo, useState } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";

type Sdk = ReturnType<typeof useSdk>;

const FLUSH_DELAY_MS = 20;
const BATCH = 100;

/** Titles asked for through one SDK connection; every chip and list on screen shares one batched lookup. */
interface Names {
  titles: Map<string, string>;
  asked: Set<string>;
  queue: string[];
  timer: ReturnType<typeof setTimeout> | undefined;
  version: number;
  listeners: Set<(version: number) => void>;
}
const registry = new WeakMap<Sdk, Names>();
const namesOf = (sdk: Sdk): Names => {
  let names = registry.get(sdk);
  if (!names) registry.set(sdk, (names = { titles: new Map(), asked: new Set(), queue: [], timer: undefined, version: 0, listeners: new Set() }));
  return names;
};

function schedule(sdk: Sdk, names: Names) {
  if (names.timer) return;
  names.timer = setTimeout(async () => {
    names.timer = undefined;
    const ids = names.queue.splice(0);
    for (let at = 0; at < ids.length; at += BATCH) {
      const batch = ids.slice(at, at + BATCH);
      try {
        for (const thread of await sdk.threads.list({ threadIds: batch, limit: batch.length })) names.titles.set(thread.id, thread.title ?? thread.titleFallback ?? "Untitled thread");
      } catch {
        // A thread that cannot be listed keeps its id as its label.
      }
    }
    names.version++;
    for (const listener of names.listeners) listener(names.version);
  }, FLUSH_DELAY_MS);
}

/** One bounded SDK batch per visible target set (shared by everything on screen); no per-row reads or polling. */
export function useThreadNames(threadIds: readonly string[]): ReadonlyMap<string, string> {
  const sdk = useSdk();
  const names = namesOf(sdk);
  const key = useMemo(() => [...new Set(threadIds)].sort().join(","), [threadIds.join(",")]);
  const [seen, setSeen] = useState(names.version);
  useEffect(() => {
    names.listeners.add(setSeen);
    for (const id of key ? key.split(",") : []) {
      if (names.asked.has(id)) continue;
      names.asked.add(id);
      names.queue.push(id);
    }
    if (names.queue.length) schedule(sdk, names);
    return () => void names.listeners.delete(setSeen);
  }, [sdk, names, key]);
  return useMemo(() => new Map((key ? key.split(",") : []).flatMap((id): Array<[string, string]> => (names.titles.has(id) ? [[id, names.titles.get(id)!]] : []))), [names, key, seen]);
}
