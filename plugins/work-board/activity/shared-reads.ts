/** Process-local read sharing for activity sampling. Every structure here has a hard size bound. */
export const SAMPLE_TTL_MS = 1_000; // runtime / interactions / queues may lag by at most this long
export const MAX_CACHE_ENTRIES = 256; // per cache; oldest inserted entry is dropped first
export const MAX_SDK_READS = 4; // simultaneous event/interaction/queue reads for one plugin host

type Entry<T> = { at: number; promise: Promise<T> };

/**
 * Shares in-flight promises and keeps settled successes for `ttlMs`.
 * Failures are evicted when they settle, so a retry always issues a new read.
 * Values must be small, immutable parsed data: consumers never receive a shared mutable object they own.
 */
export function createSharedCache<T>(ttlMs: number, maxEntries = MAX_CACHE_ENTRIES) {
  const entries = new Map<string, Entry<T>>();
  // `at` is Infinity while pending, so an in-flight read is always shareable and a slow read is not born expired.
  const peek = (key: string) => {
    const entry = entries.get(key);
    return entry && Date.now() - entry.at < ttlMs ? entry.promise : undefined;
  };
  const set = (key: string, promise: Promise<T>): Promise<T> => {
    entries.delete(key);
    while (entries.size >= maxEntries) entries.delete(entries.keys().next().value!);
    const entry: Entry<T> = { at: Infinity, promise };
    entries.set(key, entry);
    promise.then(() => { entry.at = Date.now(); }, () => { if (entries.get(key) === entry) entries.delete(key); });
    return promise;
  };
  return {
    peek,
    set,
    get: (key: string, load: () => Promise<T>) => peek(key) ?? set(key, load()),
    delete: (key: string) => { entries.delete(key); },
  };
}

/** FIFO counting semaphore; a released slot is handed straight to the next waiter so the limit is never exceeded. */
export function createReadLimiter(max: number) {
  let running = 0;
  const waiters: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (running >= max) await new Promise<void>((resolve) => waiters.push(resolve));
    else running++;
    try { return await task(); }
    finally {
      const next = waiters.shift();
      if (next) next(); else running--;
    }
  };
}

export type AcceptedTurn = { seq: number; turnId: string; claimKey: string | null; requestId: string | null };
export type PendingInteraction = { id: string; turnId: string | null };

export function createActivityReads<Thread>(ttlMs = SAMPLE_TTL_MS) {
  return {
    limit: createReadLimiter(MAX_SDK_READS),
    threads: createSharedCache<Thread | null>(ttlMs),
    accepted: createSharedCache<AcceptedTurn | null>(ttlMs),
    interactions: createSharedCache<PendingInteraction[]>(ttlMs),
    queues: createSharedCache<string[]>(ttlMs),
    // An accepted request never changes, so its small parsed attribution (including null) is kept until evicted.
    dispatches: createSharedCache<string | null>(Infinity),
  };
}
export type ActivityReads<Thread> = ReturnType<typeof createActivityReads<Thread>>;
