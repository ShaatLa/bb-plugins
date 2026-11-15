import type { Database } from "better-sqlite3";
import { bandOf, type UsageRow } from "../contract";
import type { Store } from "../store/write";

type Compaction = { id: string; thread_id: string; turn_id: string; at: number; seq: number; before_tokens: number; after_tokens: number; before_known: number; after_known: number; ttl_ms: number };
let applyEffects: ((rows: UsageRow[]) => void) | undefined;

// The plugin has one database; the factory also returns a bound hook for isolated consumers.
export function onRowsApplied(rows: UsageRow[]): void {
  if (!applyEffects) throw new Error("createBbEvents must run before onRowsApplied");
  applyEffects(rows);
}

export function createCompactions(db: Database, store: Store, now: () => number) {
  const overhead = (c: Compaction) => {
    const turn = db.prepare("SELECT started_at, compaction_only FROM turns WHERE thread_id=? AND turn_id=?").get(c.thread_id, c.turn_id) as { started_at: number; compaction_only: number } | undefined;
    if (!turn?.compaction_only) return;
    const groups = db.prepare(`SELECT model, tier, band, SUM(fresh_in) AS fresh, SUM(cache_read) AS read,
      SUM(cache_write_short + cache_write_long) AS write, SUM(output) AS output FROM usage_raw
      WHERE thread_id=? AND turn_id=? AND conv='' AND ts>=? AND ts<=? GROUP BY model,tier,band`).all(c.thread_id, c.turn_id, turn.started_at, c.at) as Array<{ model: string; tier: string; band: number; fresh: number; read: number; write: number; output: number }>;
    if (!groups.length) return;
    db.prepare("UPDATE compactions SET own_cost_known=1 WHERE id=?").run(c.id);
    for (const g of groups) db.prepare(`INSERT INTO compaction_effect (compaction_id,model,tier,band,overhead_fresh_in,overhead_cache_read,overhead_cache_write,overhead_output)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(compaction_id,model,tier,band) DO UPDATE SET
      overhead_fresh_in=excluded.overhead_fresh_in,overhead_cache_read=excluded.overhead_cache_read,
      overhead_cache_write=excluded.overhead_cache_write,overhead_output=excluded.overhead_output`).run(c.id,g.model,g.tier,g.band,g.fresh,g.read,g.write,g.output);
  };
  function resolve(threadId: string, expire = true) {
    const pending = db.prepare("SELECT * FROM compactions WHERE thread_id=? AND seq>0 AND after_known=0 AND expired=0 ORDER BY seq").all(threadId) as Compaction[];
    for (const c of pending) {
      const after = db.prepare("SELECT used_tokens,at FROM context_snap WHERE thread_id=? AND seq>? ORDER BY seq LIMIT 1").get(threadId,c.seq) as { used_tokens: number; at: number } | undefined;
      if (after && after.at-c.at<=86_400_000) db.prepare("UPDATE compactions SET after_tokens=?,after_known=1 WHERE id=?").run(after.used_tokens,c.id);
      else if (expire && now()-c.at>86_400_000) db.prepare("UPDATE compactions SET expired=1 WHERE id=?").run(c.id);
    }
    for (const c of db.prepare("SELECT * FROM compactions WHERE thread_id=? AND seq>0").all(threadId) as Compaction[]) overhead(c);
    const waiting = store.getCursor<UsageRow[]>(`compaction-waiting:${threadId}`) ?? [];
    if (waiting.length) {
      store.setCursor(`compaction-waiting:${threadId}`, []);
      applied(waiting);
    }
  }
  const applied = db.transaction((rows: UsageRow[]) => {
    for (const row of [...rows].sort((a,b)=>a.ts-b.ts)) {
      if (row.conv || !row.threadId) continue;
      const previous = store.getCursor<{ ts: number; model: string }>(`main-call:${row.threadId}`);
      // Summary usage precedes the compaction whose overhead it pays for.
      for (const own of db.prepare("SELECT * FROM compactions WHERE thread_id=? AND turn_id=? AND at>=?").all(row.threadId,row.turnId ?? "",row.ts) as Compaction[]) overhead(own);
      const c = db.prepare("SELECT * FROM compactions WHERE thread_id=? AND at<=? ORDER BY at DESC,seq DESC LIMIT 1").get(row.threadId,row.ts) as Compaction | undefined;
      if (c && row.ts>=c.at && !c.after_known && !(c as Compaction & {expired:number}).expired) {
        const key = `compaction-waiting:${row.threadId}`;
        const waiting = store.getCursor<UsageRow[]>(key) ?? [];
        if (!waiting.some(r => r.key === row.key)) store.setCursor(key, [...waiting,row]);
        continue;
      }
      // Calls can be replayed after a cursor retry or a larger transcript snapshot.
      if (!db.prepare("INSERT OR IGNORE INTO compaction_seen(key,at) VALUES (?,?)").run(row.key,row.ts).changes) continue;
      if (c && row.ts>=c.at && c.after_known && c.before_known && c.before_tokens>c.after_tokens) {
        const ttl = store.getCursor<number>(`cache-ttl:${row.threadId}`) ?? (row.provider==="claude-code" ? 3_600_000 : 1_800_000);
        const hit = !!previous && previous.model===row.model && row.ts>=previous.ts && row.ts-previous.ts<=ttl;
        const cross = bandOf(row.promptTokens+c.before_tokens-c.after_tokens)!==row.band;
        const first = !db.prepare("SELECT 1 FROM compaction_effect WHERE compaction_id=? AND (calls_hit+calls_miss+calls_cross)>0 LIMIT 1").get(c.id);
        db.prepare(`INSERT INTO compaction_effect(compaction_id,model,tier,band,calls_hit,calls_miss,calls_cross,first_gap_hit)
          VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(compaction_id,model,tier,band) DO UPDATE SET
          calls_hit=calls_hit+excluded.calls_hit,calls_miss=calls_miss+excluded.calls_miss,
          calls_cross=calls_cross+excluded.calls_cross,first_gap_hit=first_gap_hit+excluded.first_gap_hit`)
          .run(c.id,row.model,row.tier,row.band,+(!cross&&hit),+(!cross&&!hit),+cross,+(first&&hit));
      }
      if (!previous || row.ts>=previous.ts) store.setCursor(`main-call:${row.threadId}`,{ts:row.ts,model:row.model});
    }
  });
  applyEffects = applied;
  return { resolve, onRowsApplied: applied };
}
