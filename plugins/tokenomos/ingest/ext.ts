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
  usedTokensBefore: z.number(),
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

  // Track the last wall-clock time at which the hourly full compactions scan ran.
  let lastHourlyCompactionsScan: number = 0;

  /** Poll usage data for a single plugin (local-models or antigravity). */
  async function pollUsage(
    pluginId: "local-models" | "antigravity",
  ): Promise<{ rows: UsageRow[]; available: boolean }> {
    const rows: UsageRow[] = [];

    // Capture the set of pending entry ids before pagination (retry only
    // entries that were already pending at the start of this poll).
    let existingPendingIds: string[] = [];
    try {
      const pendingRows = db.prepare(
        "SELECT id FROM ext_pending WHERE source=? ORDER BY at LIMIT 200",
      ).all(pluginId) as Array<{ id: string }>;
      existingPendingIds = pendingRows.map((e) => e.id);
    } catch {
      // Table may not exist in tests.
    }

    let cursor: string | null = null;
    try {
      const cr = db.prepare("SELECT cursor FROM ext_cursor WHERE source=?").get(pluginId) as { cursor: string } | undefined;
      if (cr && cr.cursor) cursor = cr.cursor;
    } catch {
      // Table may not exist yet in tests; treat cursor as null.
    }

    // Bound usage history to two pages per poll.
    let page = 0;
    while (page < 2) {
      o.signal?.throwIfAborted();
      let result: unknown;
      try {
        result = await callRpc(
          pluginId,
          "usage.list",
          { after: cursor ?? undefined, limit: 500 },
        );
      } catch (err: any) {
        if (isUnavailable(err)) return { rows: [], available: false };
        throw err;
      }

      o.signal?.throwIfAborted();
      const parsed = UsageListSchema.safeParse(result);
      // A malformed page is a contract break, not absence: surface it in source status.
      if (!parsed.success) throw new Error(`${pluginId} usage.list returned an unexpected shape`);

      const data = parsed.data;
      if (data.entries.length === 0) break;

      db.transaction(() => {
      // Save the latest non-null cursor.
      if (data.nextCursor !== null) {
        cursor = data.nextCursor;
        try {
          db.prepare("INSERT OR REPLACE INTO ext_cursor(source,cursor) VALUES(?,?)")
            .run(pluginId, cursor);
        } catch {
          // Table may not exist in tests.
        }
      }

      for (const raw of data.entries) {
        const one = EntrySchema.safeParse(raw);
        if (!one.success) continue;
        const entry = one.data;
        let threadId: string | null = entry.threadId;
        let projectId = "";

        // If threadId is null, try to resolve via provider_session.
        if (threadId === null && entry.providerThreadId !== null) {
          const session = db.prepare(
            "SELECT thread_id FROM provider_session WHERE provider_thread_id=?",
          ).get(entry.providerThreadId) as { thread_id: string } | undefined;
          if (session) {
            threadId = session.thread_id;
          }
        }

        // Still unknown? Insert into ext_pending if younger than 24 h
        // and has a providerThreadId (waiting to be resolved).
        const entryAge = now() - entry.ts;
        if (threadId === null || threadId === "") {
          if (entryAge < 24 * 3600 * 1000 && entry.providerThreadId !== null) {
            const pendingId = `${pluginId}:${entry.id}`;
            try {
              db.prepare(
                "INSERT OR REPLACE INTO ext_pending(id,source,entry,at) VALUES(?,?,?,?)",
              ).run(pendingId, pluginId, JSON.stringify(entry), entry.ts);
            } catch {
              // Table may not exist in tests.
            }
            continue; // skip emitting for this entry
          } else {
            // No providerThreadId or older than 24 h: emit immediately.
            threadId = "";
            projectId = pluginId === "local-models" ? "~local-calls" : "";
          }
        }

        // Look up projectId from the threads table.
        if (threadId !== "") {
          const thr = db.prepare("SELECT project_id FROM threads WHERE id=?")
            .get(threadId) as { project_id: string } | undefined;
          if (thr) projectId = thr.project_id;
        }

        rows.push(makeUsageRow(entry, pluginId, threadId ?? "", projectId));
      }

      })();
      page++;
      await setImmediate(undefined,{signal:o.signal});
    }

    // Also retry every ext_pending entry for this plugin.
    // Spec: on retry, resolve, emit row, delete from pending.
    let pendingRows: UsageRow[] = [];
    try {
      const pendingEntries = db.prepare(
        `SELECT * FROM ext_pending WHERE id IN (SELECT value FROM json_each(?)) ORDER BY at`,
      ).all(JSON.stringify(existingPendingIds)) as Array<{ id: string; entry: string; at: number }>;

      db.transaction(() => {
      for (const p of pendingEntries) {
        // Skip entries inserted on this poll (not in existing set).
        if (!existingPendingIds.includes(p.id)) continue;

        const entry = JSON.parse(p.entry) as z.infer<typeof EntrySchema>;
        let threadId: string | null = entry.threadId;
        let projectId = "";

        // Try to resolve via provider_session if we have a providerThreadId.
        if (threadId === null && entry.providerThreadId !== null) {
          const session = db.prepare(
            "SELECT thread_id FROM provider_session WHERE provider_thread_id=?",
          ).get(entry.providerThreadId) as { thread_id: string } | undefined;
          if (session) {
            threadId = session.thread_id;
          }
        }

        // If still unresolved:
        if (threadId === null || threadId === "") {
          // Entries with providerThreadId=null can never resolve via
          // provider_session; emit immediately with empty threadId.
          // Entries with providerThreadId≠null but no session match also
          // emit on retry (per spec).
          threadId = "";
          projectId = pluginId === "local-models" ? "~local-calls" : "";
        } else {
          // Resolved via provider_session; look up projectId.
          const thr = db.prepare("SELECT project_id FROM threads WHERE id=?")
            .get(threadId) as { project_id: string } | undefined;
          if (thr) projectId = thr.project_id;
        }

        pendingRows.push(makeUsageRow(entry, pluginId, threadId, projectId));
        db.prepare("DELETE FROM ext_pending WHERE id=?").run(p.id);
      }
      })();
    } catch (error) {
      o.signal?.throwIfAborted();
      // Table may not exist in tests.
    }

    rows.push(...pendingRows);
    return { rows, available: true };
  }

  /** Poll compaction data from idle-compact. */
  async function pollCompactions(): Promise<{ matched: number; available: boolean }> {
    const MATCH_MS = 120_000; // ±2 minutes
    let matched = 0;

    let cursor: string | null = null;
    try {
      const cr = db.prepare("SELECT cursor FROM ext_cursor WHERE source='idle-compact'").get() as { cursor: string } | undefined;
      if (cr && cr.cursor) cursor = cr.cursor;
    } catch {
      // Table may not exist in tests.
    }

    const callWithCursor = async (
      params: Record<string, unknown>,
    ): Promise<{ items: z.infer<typeof CompactionItemSchema>[]; nextCursor: string | null } | null> => {
      try {
        o.signal?.throwIfAborted();
        const result = await callRpc("idle-compact", "compactions.list", params);
        o.signal?.throwIfAborted();
        const parsed = CompactionsListSchema.safeParse(result);
        if (!parsed.success) throw new Error("idle-compact compactions.list returned an unexpected shape");
        const items = parsed.data.items.flatMap((item) => {
          const one = CompactionItemSchema.safeParse(item);
          return one.success ? [one.data] : [];
        });
        return { items, nextCursor: parsed.data.nextCursor ?? null };
      } catch (err: any) {
        if (isUnavailable(err)) return null;
        throw err;
      }
    };

    // Main cursor-based scan.
    let page = 0;
    let lastId: string | null = null;
    while (page < 20) {
      const data = await callWithCursor({ after: cursor ?? undefined, limit: 500 });
      if (!data) return { matched, available: true };

      const items = data.items;
      if (items.length === 0) break;

      if (items.length > 0) lastId = items[items.length - 1].id;

      db.transaction(() => {
      for (const item of items) {
        // Look for a row in compactions with the same thread_id and at
        // within ±MATCH_MS; set its origin to idle-compact.
        const existing = db.prepare(
          "SELECT id FROM compactions WHERE thread_id=? AND at BETWEEN ? AND ?",
        ).get(
          item.threadId,
          item.at - MATCH_MS,
          item.at + MATCH_MS,
        ) as { id: string } | undefined;
        if (existing) {
          db.prepare("UPDATE compactions SET origin='idle-compact' WHERE id=?")
            .run(existing.id);
          matched++;
        }
      }

      })();
      page++;
      cursor = lastId;
      await setImmediate(undefined,{signal:o.signal});
    }

    // Save cursor for the next poll.
    if (lastId !== null) {
      try {
        db.prepare("INSERT OR REPLACE INTO ext_cursor(source,cursor) VALUES(?,?)")
          .run("idle-compact", lastId);
      } catch {
        // Table may not exist in tests.
      }
    }

    // Hourly full scan: also call with a since parameter every hour.
    const currentNow = now();
    if (currentNow - lastHourlyCompactionsScan >= 3_600_000) {
      lastHourlyCompactionsScan = currentNow;
      try {
        const hourlyData = await callWithCursor({
          since: currentNow - 7_200_000,
          limit: 500,
        });
        if (hourlyData) {
          for (const item of hourlyData.items) {
            const existing = db.prepare(
              "SELECT id FROM compactions WHERE thread_id=? AND at BETWEEN ? AND ?",
            ).get(
              item.threadId,
              item.at - MATCH_MS,
              item.at + MATCH_MS,
            ) as { id: string } | undefined;
            if (existing) {
              db.prepare("UPDATE compactions SET origin='idle-compact' WHERE id=?")
                .run(existing.id);
              matched++;
            }
          }
        }
      } catch {
        // Ignore errors on the hourly scan; it's best-effort.
      }
    }

    return { matched, available: true };
  }

  return { pollUsage, pollCompactions };
}
