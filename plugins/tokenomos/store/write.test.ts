import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { bandOf, type UsageRow } from "../contract";
import { MIGRATIONS } from "./schema";
import { createStore, type Store } from "./write";

const HOUR = 3_600_000;

export function migrate(db: Database.Database) {
  // The host records applied statements; here every statement is simply executed.
  for (const sql of MIGRATIONS) db.exec(sql);
}

const row = (over: Partial<UsageRow> = {}): UsageRow => ({
  key: "cc:m1:r1", ts: 10 * HOUR + 5, threadId: "t1", projectId: "p1", provider: "claude-code", model: "claude-sonnet-5-5",
  tier: "standard", tierRaw: "standard", promptTokens: 150, band: 0, conv: "", freshIn: 100, cacheRead: 50,
  cacheWriteShort: 0, cacheWriteLong: 0, output: 20, reasoning: 0, turnId: null, source: "claude-file", flags: 0, ...over,
});

let db: Database.Database;
let store: Store;
beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  store = createStore(db);
});

const hourly = () => db.prepare("SELECT * FROM usage_hourly").all() as Array<Record<string, number>>;
const threadTokens = () => db.prepare("SELECT * FROM thread_tokens").all() as Array<Record<string, number>>;

describe("migrations", () => {
  it("run twice without error through the plugin migrate semantics", () => {
    // bb.storage.migrate skips applied statements; emulate with a ledger table.
    const ledger = new Database(":memory:");
    ledger.exec("CREATE TABLE _m (i INTEGER PRIMARY KEY)");
    const run = () => ledger.transaction(() => {
      MIGRATIONS.forEach((sql, i) => {
        if (ledger.prepare("SELECT 1 FROM _m WHERE i = ?").get(i)) return;
        ledger.exec(sql);
        ledger.prepare("INSERT INTO _m VALUES (?)").run(i);
      });
    })();
    run();
    expect(run).not.toThrow();
  });

  it("has no nullable primary-key or dimension columns", () => {
    for (const t of ["usage_raw", "usage_hourly", "thread_tokens", "bb_counter", "source_interval"]) {
      const cols = db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ notnull: number; name: string }>;
      expect(cols.filter((c) => !c.notnull).map((c) => c.name), t).toEqual([]);
    }
  });
});

describe("applyRows", () => {
  it("counts the same key once", () => {
    expect(store.applyRows([row()])).toEqual({ inserted: 1, updated: 0, touchedThreads: ["t1"] });
    expect(store.applyRows([row()])).toEqual({ inserted: 0, updated: 0, touchedThreads: [] });
    expect(hourly()).toHaveLength(1);
    expect(hourly()[0]).toMatchObject({ hour: 10 * HOUR, calls: 1, fresh_in: 100, cache_read: 50, output: 20 });
    expect(threadTokens()[0]).toMatchObject({ calls: 1, fresh_in: 100, first_ts: 10 * HOUR + 5, last_ts: 10 * HOUR + 5 });
  });

  it("adds only the delta for a bigger snapshot and nothing for a smaller one", () => {
    store.applyRows([row()]);
    const grown = store.applyRows([row({ output: 50, freshIn: 90 })]); // freshIn smaller: kept at 100
    expect(grown).toMatchObject({ inserted: 0, updated: 1 });
    expect(hourly()[0]).toMatchObject({ calls: 1, fresh_in: 100, output: 50 });
    expect(threadTokens()[0]).toMatchObject({ calls: 1, output: 50 });
    expect(db.prepare("SELECT output, fresh_in FROM usage_raw").get()).toEqual({ output: 50, fresh_in: 100 });

    const before = store.dataVersion();
    expect(store.applyRows([row({ output: 10 })])).toMatchObject({ inserted: 0, updated: 0 });
    expect(hourly()[0]).toMatchObject({ output: 50 });
    expect(store.dataVersion()).toBe(before);
  });

  it("rolls up a row without thread or project into one hourly row and no thread_tokens", () => {
    store.applyRows([row({ key: "lm:1", threadId: "", projectId: "" }), row({ key: "lm:2", threadId: "", projectId: "" })]);
    expect(hourly()).toHaveLength(1);
    expect(hourly()[0]).toMatchObject({ calls: 2, fresh_in: 200, thread_id: "", project_id: "" });
    expect(threadTokens()).toHaveLength(0);
  });

  it("bumps dataVersion on change", () => {
    const v = store.dataVersion();
    store.applyRows([row()]);
    expect(store.dataVersion()).toBe(v + 1);
  });
});

describe("deleteContribution", () => {
  it("subtracts only rows at or after fromTs, and only that source", () => {
    store.applyRows([
      row({ key: "a", ts: 1 * HOUR }),
      row({ key: "b", ts: 2 * HOUR }),
      row({ key: "c", ts: 2 * HOUR, source: "bb-events" }),
    ]);
    store.deleteContribution("t1", "claude-file", 2 * HOUR);
    expect(db.prepare("SELECT key FROM usage_raw ORDER BY key").all()).toEqual([{ key: "a" }, { key: "c" }]);
    expect(hourly().find((h) => h.hour === 2 * HOUR)).toMatchObject({ calls: 1, fresh_in: 100 }); // only c left
    expect(hourly().find((h) => h.hour === 1 * HOUR)).toMatchObject({ calls: 1, fresh_in: 100 });
    expect(threadTokens()[0]).toMatchObject({ calls: 2, fresh_in: 200 });

    store.deleteContribution("t1", "claude-file");
    expect(threadTokens()[0]).toMatchObject({ calls: 1, fresh_in: 100 });
  });
});

describe("cursors and threads", () => {
  it("round-trips cursors", () => {
    expect(store.getCursor("x")).toBeNull();
    store.setCursor("x", { n: 1 });
    store.setCursor("x", { n: 2 });
    expect(store.getCursor("x")).toEqual({ n: 2 });
  });

  it("stores thread dto with ISO or ms times", () => {
    store.noteThread({ id: "t1", projectId: "p", providerId: "codex", parentThreadId: null, title: null, titleFallback: "fb", createdAt: "2026-01-01T00:00:00.000Z", archivedAt: 5 });
    expect(db.prepare("SELECT * FROM threads").get()).toMatchObject({
      id: "t1", project_id: "p", provider_id: "codex", parent_id: "", title: "fb", created_at: Date.parse("2026-01-01T00:00:00.000Z"), archived_at: 5, deleted_at: 0,
    });
  });
});

describe("bandOf", () => {
  it("counts edges strictly below the prompt", () => {
    expect([100_000, 100_001, 272_000, 272_001].map(bandOf)).toEqual([0, 1, 1, 2]);
  });
});
