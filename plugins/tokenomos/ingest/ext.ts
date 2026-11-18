import type { Database } from "better-sqlite3";
import { setImmediate } from "node:timers/promises";
import { z } from "zod";
import { bandOf, type UsageRow } from "../contract";
import type { Store } from "../store/write";
import { normaliseTier } from "./tiers";

// ---- Schema for usage.list entries ----
const EntrySchema = z.object({
  id: z.string(),
  ts: z.number(),
  source: z.string(),
  threadId: z.string().nullable(),
  providerThreadId: z.string().nullable(),
  model: z.string(),
  promptTokens: z.number(),
  cachedTokens: z.number(),
  completionTokens: z.number(),
  reasoningTokens: z.number().nullable(),
  durationMs: z.number().nullish(),
});

// Entries are validated one by one so a single malformed entry is dropped, not the whole page.
const UsageListSchema = z.object({
  entries: z.array(z.unknown()).max(500),
  nextCursor: z.string().nullable(),
});

// ---- Schema for compactions.list entries ----
const CompactionItemSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  at: z.number(),
  trigger: z.string(),
  usedTokensBefore: z.number().nullable(), // null for Idle Compact 0.3.0 "manual" entries
  contextWindow: z.number().nullable(),
});

const CompactionsListSchema = z.object({
  items: z.array(z.unknown()),
  // Idle Compact omits nextCursor when no more items remain.
  nextCursor: z.string().nullish(),
});

/** Error codes that mean the remote API is unavailable */
const UNAVAILABLE_CODES = new Set(["unknown_method", "not_found", "plugin_not_found"]);
const UNAVAILABLE_MSG = "not found";

/** Build a UsageRow for a single usage entry */
function makeUsageRow(
  entry: z.infer<typeof EntrySchema>,
  pluginId: "local-models" | "antigravity",
  threadId: string,
  projectId: string,
): UsageRow {
  const freshIn = Math.max(0, entry.promptTokens - entry.cachedTokens);
  const cacheRead = entry.cachedTokens;
  const output = entry.completionTokens;
  const reasoning = entry.reasoningTokens ?? 0;
  const promptTokens = entry.promptTokens;
  const key = pluginId === "local-models" ? `lm:${entry.id}` : `ag:${entry.id}`;
  const source = pluginId === "local-models" ? "local-log" : "agy-log";
  const tierRaw = "";
  return {
    key,
    ts: entry.ts,
    threadId,
    projectId,
    provider: pluginId,
    model: entry.model,
    tier: normaliseTier(tierRaw),
    tierRaw,
    promptTokens,
    band: bandOf(promptTokens),
    conv: "",
    freshIn,
    cacheRead,
    cacheWriteShort: 0,
    cacheWriteLong: 0,
    output,
    reasoning,
    turnId: null,
    source,
    flags: 0,
  };
}

/** Check whether an error indicates the remote API is unavailable */
function isUnavailable(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err) {
    if (UNAVAILABLE_CODES.has((err as any).code)) return true;
  }
  if (err && typeof err === "object" && "message" in err) {
    if (typeof (err as any).message === "string" && (err as any).message.includes(UNAVAILABLE_MSG)) return true;
  }
  return false;
}

export function createExtSource(o: {
  store: Store;
  db: Database;
  callRpc: (pluginId: string, method: string, input: unknown) => Promise<unknown>;
  now?: () => number;
  signal?: AbortSignal;
}) {
  const { store, db, callRpc } = o;
  const now = o.now ?? (() => Date.now());

  const readCursor = (source: string) => (db.prepare("SELECT cursor FROM ext_cursor WHERE source=?").get(source) as { cursor: string } | undefined)?.cursor ?? null;
  const writeCursor = db.prepare("INSERT OR REPLACE INTO ext_cursor(source,cursor) VALUES(?,?)");

  async function pollUsage(pluginId: "local-models" | "antigravity") {
    o.signal?.throwIfAborted();
    const rows = new Map<string, UsageRow>();
    const pending = new Map<string, z.infer<typeof EntrySchema>>();
    const removed = new Set<string>();
    const retries = db.prepare("SELECT id,entry FROM ext_pending WHERE source=? ORDER BY at LIMIT 200").all(pluginId) as Array<{ id: string; entry: string }>;
    let cursor = readCursor(pluginId);
    const consume = (entry: z.infer<typeof EntrySchema>, id = `${pluginId}:${entry.id}`) => {
      let threadId = entry.threadId || "";
      if (!threadId && entry.providerThreadId) {
        threadId = (db.prepare("SELECT thread_id FROM provider_session WHERE provider_thread_id=?").get(entry.providerThreadId) as { thread_id: string } | undefined)?.thread_id ?? "";
      }
      // Standalone tools/CLI calls need no identity join; thread calls wait for it.
      if (!threadId && (entry.providerThreadId !== null || entry.source === "thread") && now() - entry.ts < 86_400_000) {
        pending.set(id, entry);
        return;
      }
      const projectId = threadId
        ? (db.prepare("SELECT project_id FROM threads WHERE id=?").get(threadId) as { project_id: string } | undefined)?.project_id ?? ""
        : pluginId === "local-models" ? "~local-calls" : "";
      const row = makeUsageRow(entry, pluginId, threadId, projectId);
      rows.set(row.key, row); pending.delete(id); removed.add(id);
    };
    for (const item of retries) consume(EntrySchema.parse(JSON.parse(item.entry)), item.id);
    // Keep polling read-only: failed later pages and abandoned batches replay from the durable cursor.
    for (let page = 0; page < 2; page++) {
      o.signal?.throwIfAborted();
      let result: unknown;
      try { result = await callRpc(pluginId, "usage.list", { ...(cursor ? { after: cursor } : {}), limit: 500 }); }
      catch (error) { if (isUnavailable(error)) return { rows: [] as UsageRow[], available: false, commit() {} }; throw error; }
      o.signal?.throwIfAborted();
      const parsed = UsageListSchema.safeParse(result);
      if (!parsed.success) throw new Error(`${pluginId} usage.list returned an unexpected shape`);
      const data = parsed.data;
      for (const raw of data.entries) {
        const one = EntrySchema.safeParse(raw);
        if (one.success) consume(one.data);
      }
      if (data.nextCursor !== null) cursor = data.nextCursor;
      await setImmediate(undefined, { signal: o.signal });
      if (!data.entries.length || data.nextCursor === null) break;
    }
    return { rows: [...rows.values()], available: true, commit() {
      o.signal?.throwIfAborted();
      const insert = db.prepare("INSERT OR REPLACE INTO ext_pending(id,source,entry,at) VALUES(?,?,?,?)");
      for (const [id, entry] of pending) insert.run(id, pluginId, JSON.stringify(entry), entry.ts);
      db.prepare("DELETE FROM ext_pending WHERE id IN (SELECT value FROM json_each(?))").run(JSON.stringify([...removed]));
      if (cursor !== null) writeCursor.run(pluginId, cursor);
    } };
  }

  async function pollCompactions() {
    o.signal?.throwIfAborted();
    let cursor = readCursor("idle-compact");
    const matched = new Set<string>();
    const match = (items: unknown[]) => {
      let lastId: string | null = null;
      for (const raw of items) {
        const parsed = CompactionItemSchema.safeParse(raw);
        if (!parsed.success) continue;
        const item = parsed.data;
        lastId = item.id;
        const existing = db.prepare("SELECT id FROM compactions WHERE thread_id=? AND at BETWEEN ? AND ?")
          .get(item.threadId, item.at - 120_000, item.at + 120_000) as { id: string } | undefined;
        if (existing) matched.add(existing.id);
      }
      return lastId;
    };
    const call = async (input: Record<string, unknown>) => {
      o.signal?.throwIfAborted();
      let result: unknown;
      try { result = await callRpc("idle-compact", "compactions.list", input); }
      catch (error) { if (isUnavailable(error)) return null; throw error; }
      o.signal?.throwIfAborted();
      const parsed = CompactionsListSchema.safeParse(result);
      if (!parsed.success) throw new Error("idle-compact compactions.list returned an unexpected shape");
      return parsed.data;
    };
    for (let page = 0; page < 20; page++) {
      const data = await call({ ...(cursor ? { after: cursor } : {}), limit: 500 });
      if (!data) return { matched: 0, available: false, commit() {} };
      const lastId = match(data.items);
      // The last non-null page cursor is durable only when its matches are committed.
      cursor = data.nextCursor ?? lastId ?? cursor;
      await setImmediate(undefined, { signal: o.signal });
      if (!data.items.length || data.nextCursor == null) break;
    }
    const scanAt = now();
    let scanned = false;
    if (scanAt - (store.getCursor<number>("ext-compactions-overlap") ?? 0) >= 3_600_000) {
      const overlap = await call({ since: scanAt - 7_200_000, limit: 500 });
      if (overlap) { match(overlap.items); scanned = true; }
    }
    return { matched: matched.size, available: true, commit() {
      o.signal?.throwIfAborted();
      db.prepare("UPDATE compactions SET origin='idle-compact' WHERE id IN (SELECT value FROM json_each(?))").run(JSON.stringify([...matched]));
      if (cursor !== null) writeCursor.run("idle-compact", cursor);
      if (scanned) store.setCursor("ext-compactions-overlap", scanAt);
    } };
  }

  return { pollUsage, pollCompactions };
}
