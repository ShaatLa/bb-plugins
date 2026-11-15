import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { UsageRow } from "../contract";
import { prune, diskStats } from "./prune";
import { MIGRATIONS } from "./schema";
import { createStore } from "./write";

const DAY = 86_400_000;
const NOW = 1_000 * DAY;

const row = (key: string, ts: number): UsageRow => ({
  key, ts, threadId: "t1", projectId: "p", provider: "claude-code", model: "m", tier: "standard", tierRaw: "", promptTokens: 1,
  band: 0, conv: "", freshIn: 1, cacheRead: 0, cacheWriteShort: 0, cacheWriteLong: 0, output: 0, reasoning: 0, turnId: null,
  source: "claude-file", flags: 0,
});

describe("prune", () => {
  it("keeps in-window rows, deletes expired ones and returns the count", () => {
    const db = new Database(":memory:");
    for (const sql of MIGRATIONS) db.exec(sql);
    createStore(db).applyRows([
      row("fresh", NOW - 29 * DAY), row("old", NOW - 31 * DAY),
      row("rollup-old", NOW - 201 * DAY), // expired raw, and its hourly row is past rollup retention too
    ]);
    db.prepare("INSERT INTO requests (request_id, at) VALUES ('r-old', ?), ('r-new', ?)").run(NOW - 25 * 3_600_000, NOW - 3_600_000);
    db.prepare("INSERT INTO ext_pending (id, at) VALUES ('e-old', ?), ('e-new', ?)").run(NOW - 25 * 3_600_000, NOW - 3_600_000);
    const cand = (key: string, ts: number) => db.prepare("INSERT INTO bb_candidate (key, ts) VALUES (?, ?)").run(key, ts);
    cand("c-old", NOW - 25 * 3_600_000);
    cand("c-new", NOW - 3_600_000);

    // raw: old + rollup-old (2); hourly: rollup-old (1); requests/ext_pending/bb_candidate: 1 each (3)
    expect(prune(db, { rawRetentionDays: 30, rollupRetentionDays: 200, now: NOW })).toBe(6);

    expect(db.prepare("SELECT key FROM usage_raw").all()).toEqual([{ key: "fresh" }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM usage_hourly").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT request_id FROM requests").all()).toEqual([{ request_id: "r-new" }]);
    expect(db.prepare("SELECT id FROM ext_pending").all()).toEqual([{ id: "e-new" }]);
    expect(db.prepare("SELECT key FROM bb_candidate").all()).toEqual([{ key: "c-new" }]);
    expect(prune(db, { rawRetentionDays: 30, rollupRetentionDays: 200, now: NOW })).toBe(0);
  });

  it("reports disk stats", () => {
    const db = new Database(":memory:");
    for (const sql of MIGRATIONS) db.exec(sql);
    createStore(db).applyRows([row("a", NOW)]);
    const stats = diskStats(db);
    expect(stats.bytes).toBe(stats.pages * 4096);
    expect(stats.rows).toMatchObject({ usage_raw: 1, usage_hourly: 1, thread_tokens: 1 });
  });
});
