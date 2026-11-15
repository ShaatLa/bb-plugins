import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS } from './schema.js';
import { fixture } from './fixture.js';
import { rangeBounds, summary, threadCosts, costSum, compactionEstimate, compactionsInRange, limits, topThreads, type Effect } from './read.js';
import { createStore } from './write.js';
import { RECOVERED, ESTIMATED, type UsageRow } from '../contract.js';

const HOUR=3_600_000, now=+new Date(2026,10,15,12), overrides={ 'claude-sonnet-5-5': { input: 2,output: 10,cacheRead: 0.1,cacheWriteShort: 2.5,cacheWriteLong: 4 } };
let db: Database.Database;
beforeEach(() => { db=new Database(':memory:'); for (const sql of MIGRATIONS) db.exec(sql); });
afterEach(() => db.close());
function row(key: string, extra: Partial<UsageRow>={}): UsageRow {
  return { key,ts: now-HOUR,threadId: 'a',projectId: 'p',provider: 'claude-code',model: 'claude-sonnet-5-5',tier: 'standard',tierRaw: '',promptTokens: 150,band: 0,conv: '',freshIn: 100,cacheRead: 50,cacheWriteShort: 10,cacheWriteLong: 20,output: 5,reasoning: 0,turnId: null,source: 'claude-file',flags: 0,...extra };
}
const opts = { range: 'week' as const,by: 'provider' as const,now,overrides,referenceModel: 'claude-sonnet-5-5',includeOutsideBb: false };
const note = (id: string,parent='',owner='') => db.prepare('INSERT INTO threads(id,parent_id,lifecycle_owner_id,title) VALUES (?,?,?,?)').run(id,parent,owner,id);

it('has 24/7/30/13 buckets, exact totals and share, previous coverage and outside filtering', () => {
  const store=createStore(db); store.applyRows([row('a'),row('out',{ projectId: '~outside' })]);
  for (const [range,n] of [['day',24],['week',7],['month',30],['3m',13]] as const) expect(summary(db,{ ...opts,range }).buckets).toHaveLength(n);
  const s=summary(db,opts);
  expect(s.totals.usd).toBeCloseTo((200+5+25+80+50)/1e6);
  expect(s.totals.tokens).toEqual({ freshIn: 100,cacheRead: 50,cacheWrite: 30,output: 5 });
  expect(s.cacheReadShare).toBeCloseTo(50/180); expect(s.previous).toBeNull();
  expect(summary(db,{ ...opts,includeOutsideBb: true }).totals.usd).toBeCloseTo(s.totals.usd!*2);
  store.applyRows([row('old',{ ts: s.from-20*24*HOUR })]);
  expect(summary(db,opts).previous?.usd).toBe(0);
});
it('includes the current partial hour and uses inclusive now for every range', () => {
  const at=now+HOUR/2, store=createStore(db);
  const day=rangeBounds('day',at);
  store.applyRows([row('first',{ts:day.from}),row('current',{ts:at,flags:ESTIMATED}),row('previous',{ts:day.from-HOUR}),row('old',{ts:day.previousFrom-2*HOUR}),row('future',{ts:now+HOUR})]);
  note('a');
  for (const range of ['day','week','month','3m'] as const) {
    const b=rangeBounds(range,at), s=summary(db,{...opts,range,now:at});
    expect(b.to).toBe(at); expect(s.to).toBe(at);
    expect(b.from-b.previousFrom).toBe(at-b.from);
    expect(b.starts.at(-1)).toBe(range==='day' ? now : +new Date(2026,10,range==='3m' ? 9 : 15));
    expect(s.buckets.at(-1)?.series['claude-code'].tokens.freshIn).toBe(range==='3m' ? 400 : 100);
  }
  const s=summary(db,{...opts,range:'day',now:at});
  expect(s.from).toBe(now-23*HOUR); expect(s.buckets).toHaveLength(24);
  expect(s.totals.tokens.freshIn).toBe(200); expect(s.totals.estimated).toBe(true);
  expect(s.previous?.tokens.freshIn).toBe(100);
  expect(topThreads(db,'day',0,50,overrides,at).items[0].own.tokens.freshIn).toBe(200);
  db.prepare('INSERT INTO compactions(id,thread_id,at) VALUES (?,?,?)').run('current','a',at);
  db.prepare('INSERT INTO compactions(id,thread_id,at) VALUES (?,?,?)').run('future','a',at+1);
  expect(compactionsInRange(db,'day',overrides,at).items.map(i=>i.id)).toEqual(['current']);
});
it('groups top four models plus other and preserves unknown, recovered and estimated flags', () => {
  const store=createStore(db);
  const models=['claude-sonnet-5-5','claude-opus-5-5','claude-haiku-5-5','claude-sonnet-5','claude-opus-5','claude-haiku-4-5'];
  store.applyRows(Array.from({ length: 6 },(_,i) => row(`m${i}`,{ model:models[i],freshIn: (i+1)*1000 })));
  const os=Object.fromEntries(Array.from({ length: 6 },(_,i) => [models[i],overrides['claude-sonnet-5-5']]));
  const s=summary(db,{ ...opts,by:'model',overrides:os });
  expect(s.breakdown.map(b => b.key).sort()).toEqual([...models.slice(2),'other'].sort());
  expect(s.breakdown.find(b => b.key==='other')?.calls).toBe(2);
  expect(s.buckets.flatMap(b => Object.values(b.series)).reduce((n,c) => n+(c.usd ?? 0),0)).toBeCloseTo(s.totals.usd!);
  store.applyRows([row('unknown',{ model:'unpriced',flags:RECOVERED|ESTIMATED })]);
  const u=summary(db,opts); expect(u.totals.partial).toBe(true); expect(u.totals.estimated).toBe(true);
  expect(u.breakdown.find(b => b.key==='claude-code')?.cost.partial).toBe(true);
  db.exec('DELETE FROM usage_hourly'); store.applyRows([row('unknown-only',{ model:'unpriced' })]);
  expect(summary(db,opts).totals.usd).toBeNull();
});
it('computes local reference savings', () => {
  createStore(db).applyRows([row('l',{ provider:'local-models',model:'a-local-model' })]);
  expect(summary(db,opts).totals).toMatchObject({ usd:0,partial:false,estimated:false });
  expect(summary(db,opts).localSavings).toMatchObject({ usd: 0.00036,tokens:185,referenceModel:'claude-sonnet-5-5',partial:false });
});
it('walks both edges with cycles, skips unknown ids and deduplicates sums', () => {
  note('a','c'); note('b','a'); note('c','','b'); note('d','a','b');
  createStore(db).applyRows(['a','b','c','d'].map(id => row(id,{ threadId:id })));
  const r=threadCosts(db,['a','missing'],true,overrides);
  expect(r.threads).toHaveLength(1); expect(r.threads[0].descendantCount).toBe(3);
  expect(r.threads[0].total.tokens.freshIn).toBe(400); expect(r.threads[0].total.partial).toBe(true);
  expect(r.threads[0].updatedAt).toBe(now-HOUR);
  expect(costSum(db,['a','b'],true,overrides)).toMatchObject({ threadCount:4,cost:{ tokens:{ freshIn:400 } } });
  expect(costSum(db,['missing'],true,overrides).cost.partial).toBe(true);
  db.prepare('INSERT INTO thread_cov(thread_id,partial) VALUES (?,1)').run('b');
  expect(threadCosts(db,['a'],true,overrides).threads[0].total.partial).toBe(true);
  expect(threadCosts(db,['a'],false,overrides).threads[0].total.tokens.freshIn).toBe(100);
  expect(topThreads(db,'week',0,2,overrides,now)).toMatchObject({ hasMore:true,items:[{ threadId:'a' },{ threadId:'b' }] });
});
it('keeps local tool usage free in mixed lifetime totals', () => {
  note('a');
  createStore(db).applyRows([row('cloud'),row('local',{ provider:'local-models',model:'local-qwen' })]);
  const s=costSum(db,['a'],false,overrides);
  expect(s.cost).toMatchObject({ usd:0.00036,partial:false,tokens:{ freshIn:200 } });
  expect(threadCosts(db,['a'],false,overrides).threads[0].own).toEqual(s.cost);
});
const effect: Effect = { model:'claude-sonnet-5-5',tier:'standard',band:0,calls_hit:2,calls_miss:1,calls_cross:0,first_gap_hit:1,overhead_fresh_in:10,overhead_cache_read:20,overhead_cache_write:30,overhead_output:40 };
it('prices hit/miss, rewrite and overhead by hand, keeps negative and cross savings', () => {
  const c={ before_tokens:1000,after_tokens:200,own_cost_known:1 };
  // gross 800*(2*.1+4)=3360; rewrite 200*3.9=780; overhead 20+2+75+400=497.
  expect(compactionEstimate([effect],c,overrides)).toEqual({ usd:(3360-780-497)/1e6,tokens:2400,partial:false,excludesOwnCost:false });
  expect(compactionEstimate([{ ...effect,calls_hit:0,calls_miss:0 }],c,overrides).usd).toBeLessThan(0);
  expect(compactionEstimate([{ ...effect,calls_cross:2 }],{ ...c,own_cost_known:0 },overrides)).toMatchObject({ partial:true,tokens:4000,excludesOwnCost:true });
});
it('compaction estimates survive raw expiry', () => {
  createStore(db).applyRows([row('raw')]);
  db.prepare('INSERT INTO compactions(id,thread_id,at,before_tokens,after_tokens,own_cost_known) VALUES (?,?,?,?,?,?)').run('c','a',now-HOUR,1000,200,1);
  db.prepare(`INSERT INTO compaction_effect(compaction_id,${Object.keys(effect).join(',')}) VALUES (${Array(Object.keys(effect).length+1).fill('?').join(',')})`).run('c',...Object.values(effect));
  const before=compactionsInRange(db,'week',overrides,now);
  db.exec('DELETE FROM usage_raw');
  expect(compactionsInRange(db,'week',overrides,now)).toEqual(before);
  expect(summary(db,opts).compactionSavings).toEqual(before.items[0].saving);
});
it('joins a weekly sonnet window only to sonnet models; custom and unmatched windows have no breakdown', () => {
  createStore(db).applyRows([row('s',{ model:'claude-sonnet-5-5' }),row('o',{ model:'claude-opus-5-5' }),row('old',{ model:'claude-sonnet-5-5',ts:now-8*24*HOUR })]);
  const w={ id:'weekly',label:'Weekly Sonnet',kind:'weekly',model:'SoNnEt',usedPercent:20,resetsAt:new Date(now+HOUR).toISOString() };
  const result=limits(db,{ 'claude-code': { status:'ok',accountEmail:null,planLabel:null,windows:[w,{ ...w,kind:'custom' },{ ...w,model:'missing' }] } },now);
  expect(result.windows[0].byModel?.map(m => m.model)).toEqual(['claude-sonnet-5-5']);
  expect(result.windows[0].byModel?.[0].cost.tokens.freshIn).toBe(100);
  expect(result.windows[0].since).toBe(now+HOUR-7*24*HOUR);
  expect(result.windows.slice(1).map(w => w.byModel)).toEqual([null,null]);
});

describe.skipIf(process.env.TOKENOMOS_SKIP_PERF==='1')('performance', () => {
  it('meets summary and 200-thread descendant budgets on a disk fixture', () => {
    const dir=mkdtempSync(join(tmpdir(),'tokenomos-perf-')), perfDb=new Database(join(dir,'fixture.db'));
    try {
      fixture(perfDb,now);
      const median=(f:()=>unknown) => { f(); const times=Array.from({ length:5 },() => { const t=performance.now(); f(); return performance.now()-t; }).sort((a,b) => a-b); return times[2]; };
      const summaryMs=median(() => summary(perfDb,{ ...opts,range:'3m',overrides:{} }));
      const threadsMs=median(() => threadCosts(perfDb,Array.from({ length:200 },(_,i) => `t${i*15}`),true));
      process.stdout.write(`Tokenomos perf median: summary 3m ${summaryMs.toFixed(2)} ms; costs.threads 200 ${threadsMs.toFixed(2)} ms\n`);
      expect(summaryMs).toBeLessThan(50); expect(threadsMs).toBeLessThan(100);
    } finally { perfDb.close(); rmSync(dir,{ recursive:true,force:true }); }
  });
});
