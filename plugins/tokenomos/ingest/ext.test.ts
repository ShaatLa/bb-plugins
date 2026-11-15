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
        const empty = arr === usageCalls ? { entries: [], nextCursor: null } : { items: [] };
        return Promise.resolve(empty as FakeCallResult);
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

function commit(batch: { rows?: UsageRow[]; commit(): void }) {
  db.transaction(() => { if (batch.rows) createStore(db).applyRows(batch.rows); batch.commit(); })();
}

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

  expect(db.prepare("SELECT cursor FROM ext_cursor WHERE source='local-models'").get()).toBeUndefined();
  commit(first);
  // Cursor is saved with the usage rows.
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

  commit(first);
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

  expect(db.prepare("SELECT COUNT(*) n FROM ext_pending").get()).toEqual({n:1});
  commit(second);
  // Entry is deleted only with its applied usage row.
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

  expect(db.prepare("SELECT origin FROM compactions WHERE id='c1'").get()).toEqual({ origin:'bb' });
  commit(result);
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

it("compactions.list without nextCursor and with a malformed item still matches the valid items", async () => {
  const fake = buildFakeCalls();
  fake.pushCompaction({ items: [{ id: "x", threadId: "t", at: 1 }, { id: "a", threadId: "thr_live", at: 1_000_000, trigger: "idle", usedTokensBefore: 133259, contextWindow: 1000000 }] } as unknown as FakeCallResult);
  const db = new Database(":memory:");
  for (const sql of MIGRATIONS) db.exec(sql);
  db.prepare("INSERT INTO compactions (id, thread_id, at) VALUES ('c1', 'thr_live', 1_050_000)").run();
  const ext = createExtSource({ store: createStore(db), db, callRpc: fake.call, now: () => 2_000_000 });
  const result = await ext.pollCompactions();
  expect(result).toMatchObject({ matched: 1, available: true });
});
it('caps usage at two pages and retries at most 200 pending entries per poll',async()=>{
  const entry=(id:string):UsageEntry=>({id,ts:100,source:'thread',threadId:'t',providerThreadId:null,model:'m',promptTokens:1,cachedTokens:0,completionTokens:0,reasoningTokens:null});
  db.transaction(()=>{for(let i=0;i<250;i++)db.prepare('INSERT INTO ext_pending VALUES (?,?,?,?)').run(`p${i}`,'local-models',JSON.stringify(entry(`p${i}`)),i);})();
  const callRpc=vi.fn(async(_plugin:string,_method:string,input:unknown)=>{
    const after=Number((input as {after?:string}).after??0);
    return {entries:Array.from({length:500},(_,i)=>entry(`${after+i+1}`)),nextCursor:String(after+500)};
  });
  const s=createExtSource({db,store:createStore(db),callRpc});
  const first=await s.pollUsage('local-models');expect(callRpc).toHaveBeenCalledTimes(2);expect(first.rows).toHaveLength(1200);commit(first);
  expect(db.prepare('SELECT COUNT(*) n FROM ext_pending').get()).toEqual({n:50});
  expect(db.prepare('SELECT cursor FROM ext_cursor').get()).toEqual({cursor:'1000'});
  const second=await s.pollUsage('local-models');expect(second.rows).toHaveLength(1050);commit(second);
  expect(callRpc.mock.calls[2][2]).toMatchObject({after:'1000'});
});

const usageEntry = (over: Partial<UsageEntry> = {}): UsageEntry => ({id:'u',ts:1_000_000,source:'thread',threadId:'t',providerThreadId:null,model:'m',promptTokens:100,cachedTokens:0,completionTokens:10,reasoningTokens:null,...over});

it('replays page one when page two fails without moving the durable usage cursor',async()=>{
  let fail=true;
  const callRpc=vi.fn(async(_plugin:string,_method:string,input:unknown)=>{
    const after=(input as {after?:string}).after;
    if (!after) return {entries:[usageEntry()],nextCursor:'one'};
    if (fail) throw new Error('page two failed');
    return {entries:[usageEntry({id:'v'})],nextCursor:null};
  });
  const src=createExtSource({db,store:createStore(db),callRpc});
  await expect(src.pollUsage('local-models')).rejects.toThrow('page two failed');
  expect(db.prepare('SELECT * FROM ext_cursor').all()).toEqual([]);
  expect(db.prepare('SELECT * FROM usage_raw').all()).toEqual([]);
  fail=false;const batch=await src.pollUsage('local-models');
  expect(batch.rows.map(r=>r.key)).toEqual(['lm:u','lm:v']);commit(batch);
  expect(callRpc.mock.calls[2][2]).not.toHaveProperty('after');
  expect(db.prepare('SELECT SUM(calls) n FROM thread_tokens').get()).toEqual({n:2});
});

it('replays an abandoned usage batch and rolls cursor/pending deletion back with a failed apply',async()=>{
  const entry=usageEntry();
  const callRpc=vi.fn(async(_plugin:string,_method:string,input:unknown)=>(input as {after?:string}).after ? {entries:[],nextCursor:null}:{entries:[entry],nextCursor:'one'});
  const src=createExtSource({db,store:createStore(db),callRpc});
  const abandoned=await src.pollUsage('local-models');
  const replay=await src.pollUsage('local-models');expect(replay.rows).toEqual(abandoned.rows);
  expect(()=>db.transaction(()=>{createStore(db).applyRows(replay.rows);replay.commit();throw new Error('crash');})()).toThrow('crash');
  expect(db.prepare('SELECT * FROM ext_cursor').all()).toEqual([]);
  expect(db.prepare('SELECT * FROM usage_raw').all()).toEqual([]);
  commit(await src.pollUsage('local-models'));commit(abandoned);
  expect(db.prepare('SELECT SUM(calls) n FROM thread_tokens').get()).toEqual({n:1});
});

it('keeps an unresolved entry across retries and assigns it when identity arrives one hour later',async()=>{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(1_000_000);
  try {
    const entry=usageEntry({threadId:null,providerThreadId:'session'});
    let delivered=false;
    const src=createExtSource({db,store:createStore(db),callRpc:async()=>{
      if (delivered) return {entries:[],nextCursor:null};
      delivered=true;return {entries:[entry],nextCursor:'one'};
    }});
    commit(await src.pollUsage('local-models'));
    const waiting=await src.pollUsage('local-models');expect(waiting.rows).toEqual([]);commit(waiting);
    expect(db.prepare('SELECT COUNT(*) n FROM ext_pending').get()).toEqual({n:1});
    vi.setSystemTime(Date.now()+3_600_000);
    db.prepare("INSERT INTO provider_session VALUES ('session','resolved')").run();
    db.prepare("INSERT INTO threads(id,project_id) VALUES ('resolved','p')").run();
    const resolved=await src.pollUsage('local-models');expect(resolved.rows[0]).toMatchObject({threadId:'resolved',projectId:'p'});
    expect(()=>db.transaction(()=>{createStore(db).applyRows(resolved.rows);resolved.commit();throw new Error('crash');})()).toThrow('crash');
    expect(db.prepare('SELECT COUNT(*) n FROM ext_pending').get()).toEqual({n:1});
    commit(await src.pollUsage('local-models'));
    expect(db.prepare('SELECT COUNT(*) n FROM ext_pending').get()).toEqual({n:0});
    expect(db.prepare('SELECT thread_id FROM usage_raw').get()).toEqual({thread_id:'resolved'});
  } finally {vi.useRealTimers();}
});

it.each(['local-models','antigravity'] as const)('emits unresolved %s usage only after 24 hours and deletes pending on commit',async(pluginId)=>{
  const entry=usageEntry({threadId:null,providerThreadId:'missing'});let now=entry.ts;
  let delivered=false;
  const src=createExtSource({db,store:createStore(db),now:()=>now,callRpc:async()=>{
    if (delivered) return {entries:[],nextCursor:null};delivered=true;return {entries:[entry],nextCursor:'one'};
  }});
  commit(await src.pollUsage(pluginId));now+=86_400_000-1;
  const waiting=await src.pollUsage(pluginId);expect(waiting.rows).toEqual([]);commit(waiting);
  now++;
  const expired=await src.pollUsage(pluginId);expect(expired.rows).toHaveLength(1);
  expect(expired.rows[0]).toMatchObject({threadId:'',projectId:pluginId==='local-models'?'~local-calls':''});
  expect(db.prepare('SELECT COUNT(*) n FROM ext_pending').get()).toEqual({n:1});
  commit(expired);expect(db.prepare('SELECT COUNT(*) n FROM ext_pending').get()).toEqual({n:0});
});

it('commits compaction origins and cursor together and replays failed or abandoned polls',async()=>{
  const item={id:'one',threadId:'t',at:1_000_000,trigger:'idle',usedTokensBefore:100,contextWindow:1000};
  db.prepare("INSERT INTO compactions(id,thread_id,at) VALUES ('c','t',1000000)").run();
  let fail=true;
  const callRpc=vi.fn(async(_plugin:string,_method:string,input:unknown)=>{
    if (!(input as {after?:string}).after) return {items:[item],nextCursor:'one'};
    if (fail) throw new Error('compaction page two failed');
    return {items:[],nextCursor:null};
  });
  const src=createExtSource({db,store:createStore(db),callRpc,now:()=>1_000_000});
  await expect(src.pollCompactions()).rejects.toThrow('compaction page two failed');
  expect(db.prepare('SELECT * FROM ext_cursor').all()).toEqual([]);
  expect(db.prepare('SELECT origin FROM compactions').get()).toEqual({origin:'bb'});
  fail=false;const abandoned=await src.pollCompactions();const replay=await src.pollCompactions();
  expect(replay.matched).toBe(abandoned.matched);
  expect(()=>db.transaction(()=>{replay.commit();throw new Error('crash');})()).toThrow('crash');
  expect(db.prepare('SELECT * FROM ext_cursor').all()).toEqual([]);
  expect(db.prepare('SELECT origin FROM compactions').get()).toEqual({origin:'bb'});
  commit(await src.pollCompactions());
  expect(db.prepare('SELECT cursor FROM ext_cursor').get()).toEqual({cursor:'one'});
  expect(db.prepare('SELECT origin FROM compactions').get()).toEqual({origin:'idle-compact'});
});
