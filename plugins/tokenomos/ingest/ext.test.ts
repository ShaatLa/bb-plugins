import Database from "better-sqlite3";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import type { UsageRow } from "../contract";
import { MIGRATIONS } from "../store/schema";
import { createStore } from "../store/write";
import { createExtSource } from "./ext";

// Schema for usage.list response
type UsageEntry = {
  id: string;
  ts: number;
  source: string;
  threadId: string | null;
  providerThreadId: string | null;
  model: string;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  reasoningTokens: number | null;
  durationMs?: number;
};

type UsageListResponse = {
  entries: UsageEntry[];
  nextCursor: string | null;
};

// Schema for compactions.list response
type CompactionItem = {
  id: string;
  threadId: string;
  at: number;
  trigger: string;
  usedTokensBefore: number;
  contextWindow: number;
};

type CompactionsListResponse = {
  items: CompactionItem[];
  nextCursor: string | null;
};

type FakeCallResult = UsageListResponse | CompactionsListResponse;

let db: Database.Database;
let callCounts: { usage: number; compactions: number };

function buildFakeCalls() {
  const usageCalls: FakeCallResult[] = [];
  const compactionCalls: FakeCallResult[] = [];
  let usageIdx = 0;
  let compactionIdx = 0;

  return {
    call: (pluginId: string, method: string, input: unknown): Promise<FakeCallResult> => {
      const arr =
        pluginId === "local-models" || pluginId === "antigravity"
          ? usageCalls
          : compactionCalls;
      const idx =
        pluginId === "local-models" || pluginId === "antigravity"
          ? usageIdx
          : compactionIdx;
      if (idx >= arr.length) {
        return Promise.resolve({ entries: [], nextCursor: null } as FakeCallResult);
      }
      const item = arr[idx];
      if (pluginId === "local-models" || pluginId === "antigravity") {
        usageIdx = idx + 1;
      } else {
        compactionIdx = idx + 1;
      }
      return Promise.resolve(item);
    },
    pushUsage: (item: FakeCallResult) => usageCalls.push(item),
    pushCompaction: (item: FakeCallResult) => compactionCalls.push(item),
    resetUsage: () => { usageCalls.length = 0; usageIdx = 0; },
    resetCompaction: () => { compactionCalls.length = 0; compactionIdx = 0; },
  };
}

function row(o: Partial<UsageRow> = {}): UsageRow {
  return {
    key: "r",
    ts: 1,
    threadId: "t",
    projectId: "p",
    provider: "local-models",
    model: "m1",
    tier: "standard",
    tierRaw: "",
    promptTokens: 100,
    band: 0,
    conv: "",
    freshIn: 100,
    cacheRead: 0,
    cacheWriteShort: 0,
    cacheWriteLong: 0,
    output: 0,
    reasoning: 0,
    turnId: null,
    source: "local-log",
    flags: 0,
    ...o,
  };
}

beforeEach(() => {
  db = new Database(":memory:");
  for (const sql of MIGRATIONS) db.exec(sql);
  callCounts = { usage: 0, compactions: 0 };
});

afterEach(() => db.close());

// ---- pollUsage tests ----

it("paginates two pages then an empty page, saves cursor; second poll with empty page returns no rows", async () => {
  const fake = buildFakeCalls();

  fake.pushUsage({
    entries: [
      {
        id: "u1",
        ts: 100,
        source: "lm",
        threadId: "t1",
        providerThreadId: null,
        model: "qwen3.6",
        promptTokens: 500,
        cachedTokens: 100,
        completionTokens: 20,
        reasoningTokens: null,
      },
      {
        id: "u2",
        ts: 200,
        source: "lm",
        threadId: "t2",
        providerThreadId: null,
        model: "qwen3.6",
        promptTokens: 600,
        cachedTokens: 200,
        completionTokens: 30,
        reasoningTokens: null,
      },
    ],
    nextCursor: "c1",
  });
  fake.pushUsage({
    entries: [
      {
        id: "u3",
        ts: 300,
        source: "lm",
        threadId: "t3",
        providerThreadId: null,
        model: "qwen3.6",
        promptTokens: 700,
        cachedTokens: 300,
        completionTokens: 40,
        reasoningTokens: null,
      },
    ],
    nextCursor: "c2",
  });
  fake.pushUsage({ entries: [], nextCursor: null });

  const src = createExtSource({
    db,
    store: createStore(db),
    callRpc: fake.call,
    now: () => 1000,
  });

  // First poll: should collect all 3 entries across 2 pages.
  const first = await src.pollUsage("local-models");
  expect(first.rows).toHaveLength(3);
  expect(first.available).toBe(true);
  expect(first.rows[0].key).toBe("lm:u1");
  expect(first.rows[1].key).toBe("lm:u2");
  expect(first.rows[2].key).toBe("lm:u3");

  // Cursor should be saved to ext_cursor.
  const cr = db.prepare(
    "SELECT cursor FROM ext_cursor WHERE source='local-models'",
  ).get();
  expect(cr).toEqual({ cursor: "c2" });

  // Second poll: page is immediately empty → no rows.
  fake.pushUsage({ entries: [], nextCursor: null });
  const second = await src.pollUsage("local-models");
  expect(second.rows).toHaveLength(0);
  expect(second.available).toBe(true);
});

it("unknown_method error → available: false, no rows", async () => {
  const fake = buildFakeCalls();

  function rpc(pluginId: string, method: string): Promise<FakeCallResult> {
    const err = new Error("method not found");
    (err as any).code = "unknown_method";
    throw err;
  }

  const src = createExtSource({
    db,
    store: createStore(db),
    callRpc: rpc,
    now: () => 1000,
  });

  const result = await src.pollUsage("local-models");
  expect(result.available).toBe(false);
  expect(result.rows).toHaveLength(0);
});

it("thread entry with providerThreadId only goes to ext_pending; provider_session resolves it", async () => {
  const fake = buildFakeCalls();

  fake.pushUsage({
    entries: [
      {
        id: "u1",
        ts: 100,
        source: "lm",
        threadId: null,
        providerThreadId: "pt-1",
        model: "qwen3.6",
        promptTokens: 500,
        cachedTokens: 100,
        completionTokens: 20,
        reasoningTokens: null,
      },
    ],
    nextCursor: null,
  });

  const src = createExtSource({
    db,
    store: createStore(db),
    callRpc: fake.call,
    now: () => 1000,
  });

  // First poll: no provider_session → goes to ext_pending, stays pending.
  const first = await src.pollUsage("local-models");
  expect(first.rows).toHaveLength(0);

  // Verify entry is in ext_pending.
  const pending = db.prepare(
    "SELECT * FROM ext_pending WHERE source='local-models'",
  ).all();
  expect(pending).toHaveLength(1);
  const parsed = JSON.parse((pending[0] as any).entry as string);
  expect(parsed.providerThreadId).toBe("pt-1");

  // Insert provider_session mapping.
  db.prepare(
    "INSERT INTO provider_session(provider_thread_id, thread_id) VALUES(?,?)",
  ).run("pt-1", "resolved-thread");

  // Also insert a threads row so projectId resolves.
  db.prepare("INSERT INTO threads(id, project_id) VALUES(?,?)").run(
    "resolved-thread",
    "proj-x",
  );

  // Second poll: should resolve the pending entry.
  const second = await src.pollUsage("local-models");
  expect(second.rows).toHaveLength(1);
  expect(second.rows[0].threadId).toBe("resolved-thread");
  expect(second.rows[0].projectId).toBe("proj-x");

  // Entry should be deleted from ext_pending.
  const pendingAfter = db.prepare(
    "SELECT * FROM ext_pending WHERE source='local-models'",
  ).all();
  expect(pendingAfter).toHaveLength(0);
});

it("normalisation: promptTokens 14050, cachedTokens 13984, completionTokens 10 → freshIn 66, cacheRead 13984, output 10", async () => {
  const fake = buildFakeCalls();

  fake.pushUsage({
    entries: [
      {
        id: "n1",
        ts: 500,
        source: "lm",
        threadId: null,
        providerThreadId: null,
        model: "qwen3.6",
        promptTokens: 14050,
        cachedTokens: 13984,
        completionTokens: 10,
        reasoningTokens: null,
      },
    ],
    nextCursor: null,
  });

  const src = createExtSource({
    db,
    store: createStore(db),
    callRpc: fake.call,
    now: () => 1000,
  });

  const result = await src.pollUsage("local-models");
  expect(result.rows).toHaveLength(1);
  const r = result.rows[0];
  expect(r.freshIn).toBe(66);
  expect(r.cacheRead).toBe(13984);
  expect(r.output).toBe(10);
  expect(r.promptTokens).toBe(14050);
  expect(r.key).toBe("lm:n1");
});

it("antigravity rows use key prefix ag: and source agy-log", async () => {
  const fake = buildFakeCalls();

  fake.pushUsage({
    entries: [
      {
        id: "a1",
        ts: 600,
        source: "ag",
        threadId: null,
        providerThreadId: null,
        model: "flash",
        promptTokens: 200,
        cachedTokens: 50,
        completionTokens: 30,
        reasoningTokens: 10,
      },
    ],
    nextCursor: null,
  });

  const src = createExtSource({
    db,
    store: createStore(db),
    callRpc: fake.call,
    now: () => 1000,
  });

  const result = await src.pollUsage("antigravity");
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0].key).toBe("ag:a1");
  expect(result.rows[0].source).toBe("agy-log");
  expect(result.rows[0].provider).toBe("antigravity");
});

// ---- pollCompactions tests ----

it("pollCompactions matches a compaction within 2 minutes", async () => {
  const fake = buildFakeCalls();

  const baseTs = 100_000;
  // Both the API item and the DB row share the same at; diff = 0 ≤ 120000 → match.
  fake.pushCompaction({
    items: [
      {
        id: "c1",
        threadId: "ct1",
        at: baseTs + 60000,
        trigger: "manual",
        usedTokensBefore: 500000,
        contextWindow: 1000000,
      },
    ],
    nextCursor: null,
  });

  // Insert the compaction row with default origin 'bb'.
  db.prepare(
    "INSERT INTO compactions(id, thread_id, at, before_tokens, origin) VALUES(?,?,?,?,?)",
  ).run("c1", "ct1", baseTs + 60000, 500000, "bb");

  const src = createExtSource({
    db,
    store: createStore(db),
    callRpc: fake.call,
    now: () => baseTs + 200_000,
  });

  const result = await src.pollCompactions();
  expect(result.matched).toBe(1);
  expect(result.available).toBe(true);

  // Verify origin was updated.
  const c = db.prepare("SELECT origin FROM compactions WHERE id='c1'").get();
  expect(c).toEqual({ origin: "idle-compact" });
});

it("pollCompactions ignores one 3 minutes away", async () => {
  const fake = buildFakeCalls();

  const baseTs = 200_000;
  // API item at now() (200000), DB compaction 3 min later (380000) → diff 180000 > 120000 → no match.
  fake.pushCompaction({
    items: [
      {
        id: "c2",
        threadId: "ct2",
        at: baseTs,
        trigger: "auto",
        usedTokensBefore: 400000,
        contextWindow: 1000000,
      },
    ],
    nextCursor: null,
  });

  // Insert the compaction row 180000 ms away from the API item.
  db.prepare(
    "INSERT INTO compactions(id, thread_id, at, before_tokens, origin) VALUES(?,?,?,?,?)",
  ).run("c2", "ct2", baseTs + 180000, 400000, "bb");

  const src = createExtSource({
    db,
    store: createStore(db),
    callRpc: fake.call,
    now: () => baseTs,
  });

  const result = await src.pollCompactions();
  expect(result.matched).toBe(0);
  expect(result.available).toBe(true);

  // Origin should still be 'bb'.
  const c = db.prepare("SELECT origin FROM compactions WHERE id='c2'").get();
  expect(c).toEqual({ origin: "bb" });
});
