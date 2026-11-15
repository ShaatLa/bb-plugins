import Database from 'better-sqlite3';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import type { PluginBbSdk, PluginLogger } from '@get-bb/plugin-sdk';
import { readFileSync } from 'node:fs';
import { type UsageRow, BACKFILLED, ESTIMATED, RECOVERED } from '../contract';
import { MIGRATIONS } from '../store/schema';
import { costUsd } from '../pricing/price';
import { createStore } from '../store/write';
import { createBbEvents, onRowsApplied } from './bb-events';

type Event={id:string;seq:number;createdAt:number;scope:{kind:'thread'}|{kind:'turn';turnId:string};type:string;data:unknown};
let db:Database.Database, events:Event[], seq:number, time:number;
const log={debug:vi.fn(),info:vi.fn(),warn:vi.fn(),error:vi.fn()} satisfies PluginLogger;
const list=vi.fn(async(a:{afterSeq?:string})=>events.filter(e=>e.seq>Number(a.afterSeq)).slice(0,100));
const source=()=>createBbEvents({db,store:createStore(db),sdk:{threads:{events:{list}}} as unknown as PluginBbSdk,log,now:()=>time});
const count=(n:number)=>({totalTokens:n,inputTokens:n,cachedInputTokens:0,outputTokens:0,reasoningOutputTokens:0});
function event(type:string,data:unknown={providerThreadId:'s'},turnId:string|null='t1') {const e:Event={id:`e${++seq}`,seq,createdAt:++time,type,data,scope:turnId?{kind:'turn',turnId}:{kind:'thread'}};events.push(e);return e;}
const request=(id:string,model='m1',text='hello')=>event('client/turn/requested',{requestId:id,input:[{type:'text',text}],execution:{model,serviceTier:'default'}},null);
const accept=(id:string,turn='t1')=>event('turn/input/accepted',{providerThreadId:'s',clientRequestId:id},turn);
const usage=(total:number,last:number,parent?:string,turn='t1')=>event('thread/tokenUsage/updated',{providerThreadId:'s',parentToolCallId:parent,tokenUsage:{total:count(total),last:count(last),modelContextWindow:1000000}},turn);
const context=(usedTokens:number)=>event('thread/contextWindowUsage/updated',{providerThreadId:'s',contextWindowUsage:{usedTokens,modelContextWindow:1000000,estimated:true}});
const row=(o:Partial<UsageRow>={}):UsageRow=>({key:'r',ts:++time,threadId:'t',projectId:'p',provider:'claude-code',model:'m1',tier:'standard',tierRaw:'default',promptTokens:100,band:0,conv:'',freshIn:100,cacheRead:0,cacheWriteShort:0,cacheWriteLong:0,output:0,reasoning:0,turnId:'t1',source:'claude-file',flags:0,...o});
beforeEach(()=>{db=new Database(':memory:');for(const sql of [...MIGRATIONS])db.exec(sql);events=[];seq=0;time=1000;list.mockClear();log.warn.mockClear();db.prepare("INSERT INTO threads(id,provider_id,project_id) VALUES ('t','claude-code','p')").run();});
afterEach(()=>db.close());
it('joins the first accepted request, ignoring steers and queued execution until its own turn, across restart',async()=>{
 request('r1');request('queued','m2');event('turn/started');accept('r1');request('steer','m3');accept('steer');usage(100,100);
 expect((await source().flushThread('t',true)).rows[0]).toMatchObject({model:'m1',tier:'standard',tierRaw:'default',turnId:'t1',flags:BACKFILLED|ESTIMATED});
 event('turn/completed');event('turn/started',undefined,'t2');accept('queued','t2');usage(180,80,undefined,'t2');
 expect((await source().flushThread('t',true)).rows[0]).toMatchObject({model:'m2',turnId:'t2'});expect((await source().flushThread('t',true)).rows).toEqual([]);
});
it('pages at 100 with string arguments; invalid and unknown payloads advance cursor and count errors',async()=>{
 for(let i=0;i<101;i++)event('thread/identity',{providerThreadId:`s${i}`},null);event('thread/tokenUsage/updated',{bad:true});event('future/event',{});
 const s=source();await s.flushThread('t',false);expect(list).toHaveBeenCalledTimes(2);expect(list.mock.calls[0][0]).toMatchObject({afterSeq:'0',limit:'100',order:'asc'});
 expect(createStore(db).getCursor('bb-parse-errors:t')).toBe(2);expect(log.warn).toHaveBeenCalledTimes(1);expect((await s.flushThread('t',false)).touched).toBe(false);
});
it('shares Claude counters with nested results',async()=>{usage(100,100);usage(180,80,'child');usage(300,120);const {rows}=await source().flushThread('t',true);expect(rows).toHaveLength(3);expect(rows.reduce((s,r)=>s+r.freshIn,0)).toBe(300);expect(rows[1].conv).toBe('nested:child');});
it('recovers missing events and bridge restarts',async()=>{usage(100,100);usage(300,120);usage(70,50);const {rows}=await source().flushThread('t',true);expect(rows.filter(r=>r.flags&RECOVERED).map(r=>[r.key,r.freshIn])).toEqual([['bbr:t:e2',80],['bbr:t:e3',20]]);expect(rows.reduce((s,r)=>s+r.freshIn,0)).toBe(370);});
it('scopes Codex counters by parent tool call',async()=>{db.prepare("UPDATE threads SET provider_id='codex'").run();usage(100,100);usage(80,80,'child');usage(220,120);const {rows}=await source().flushThread('t',true);expect(rows).toHaveLength(3);expect(rows.reduce((s,r)=>s+r.freshIn,0)).toBe(300);});
it('returns candidates while maintaining non-owned counters',async()=>{usage(100,100);const s=source(),a=await s.flushThread('t',false);expect(a.rows).toEqual([]);expect(a.candidates).toHaveLength(1);expect(db.prepare('SELECT key FROM bb_candidate').all()).toEqual([{key:a.candidates[0].key},{key:'bbi:t:e1'}]);usage(180,80);expect((await s.flushThread('t',true)).rows).toHaveLength(1);});
it('normalizes explicit OpenAI writes and Claude cached-minus-read writes',async()=>{
 for(const [i,last] of [{totalTokens:120,inputTokens:100,cachedInputTokens:40,cacheReadInputTokens:30,cacheWriteInputTokens:10,outputTokens:20},{totalTokens:120,inputTokens:10,cachedInputTokens:90,cacheReadInputTokens:70,outputTokens:20}].entries())event('thread/tokenUsage/updated',{providerThreadId:`s${i}`,tokenUsage:{total:last,last}});
 const {rows}=await source().flushThread('t',true);expect(rows[0]).toMatchObject({freshIn:60,cacheRead:30,cacheWriteShort:10,promptTokens:100});expect(rows[1]).toMatchObject({freshIn:10,cacheRead:70,cacheWriteShort:20,promptTokens:100});
});
it('persists only the last 50 context snapshots and provider identity',async()=>{event('thread/identity',{providerThreadId:'s'},null);for(let i=0;i<55;i++)context(i);await source().flushThread('t',false);expect(db.prepare('SELECT COUNT(*) n FROM context_snap').get()).toEqual({n:50});expect(db.prepare('SELECT used_tokens FROM context_last').get()).toEqual({used_tokens:54});expect(db.prepare('SELECT * FROM provider_session').get()).toEqual({provider_thread_id:'s',thread_id:'t'});});
it('pairs two compactions in a turn, including an after snapshot in a later flush',async()=>{
 context(200000);const a=event('thread/compacted');context(10000);context(180000);const b=event('thread/compacted');await source().flushThread('t',false);expect(db.prepare('SELECT after_known FROM compactions WHERE id=?').get(`bbc:${b.id}`)).toEqual({after_known:0});
 context(15000);await source().flushThread('t',false);expect(db.prepare('SELECT id,before_tokens,after_tokens FROM compactions ORDER BY seq').all()).toEqual([{id:`bbc:${a.id}`,before_tokens:200000,after_tokens:10000},{id:`bbc:${b.id}`,before_tokens:180000,after_tokens:15000}]);
});
it('does not reuse a snapshot before the previous compaction; pending expires after 24h',async()=>{context(100);event('thread/compacted');event('thread/compacted');await source().flushThread('t',false);expect(db.prepare('SELECT before_known FROM compactions ORDER BY seq').all()).toEqual([{before_known:1},{before_known:0}]);time+=86400001;context(20);await source().flushThread('t',false);expect(db.prepare('SELECT expired,after_known FROM compactions').all()).toEqual([{expired:1,after_known:0},{expired:1,after_known:0}]);});
it('reads real payloads and recognizes manual compact without claiming absent own usage',async()=>{
 const real=JSON.parse(readFileSync(new URL('./fixtures/bb/real-events.json',import.meta.url),'utf8')) as Array<{id:string;sequence:number;created_at:number;turn_id:string|null;type:string;data:unknown}>;
 events=real.map(e=>({id:e.id,seq:e.sequence,createdAt:e.created_at,type:e.type,data:e.data,scope:e.turn_id?{kind:'turn',turnId:e.turn_id}:{kind:'thread'}}));time=events.at(-1)!.createdAt;
 const {rows}=await source().flushThread('t',true);expect(log.warn).not.toHaveBeenCalled();expect(rows[0]).toMatchObject({freshIn:226,cacheRead:17538311,cacheWriteShort:147020,output:55593});expect(db.prepare("SELECT compaction_only FROM turns WHERE turn_id='daa6b08a7b-t1'").get()).toEqual({compaction_only:1});expect(db.prepare("SELECT own_cost_known FROM compactions WHERE turn_id='daa6b08a7b-t1'").get()).toEqual({own_cost_known:0});
});
it('counts the trailing uncovered streak using main file rows and completion grace',async()=>{
 for(let i=1;i<=5;i++){time=i*10000;event('turn/started',undefined,`t${i}`);usage(i*100,100,undefined,`t${i}`);event('turn/completed',undefined,`t${i}`);}const s=source();await s.flushThread('t',false);
 createStore(db).applyRows([row({key:'covered',ts:20002}),row({key:'child',ts:40002,conv:'child'}),row({key:'bb',ts:50002,source:'bb-events'})]);expect(await s.coverage('t')).toEqual({uncoveredStreak:3,firstUncoveredStart:30001,lastCoveredTurnStart:20001});createStore(db).applyRows([row({key:'covered5',ts:50004})]);expect(await s.coverage('t')).toEqual({uncoveredStreak:0,firstUncoveredStart:null,lastCoveredTurnStart:50001});
});
it('effects track hits, TTL misses, model switches and 100K crossings, ignoring children/replays/late calls',async()=>{
 const s=source();s.onRowsApplied([row({key:'prev'})]);context(40000);event('thread/compacted');context(10000);await s.flushThread('t',false);
 const hit=row({key:'hit'}),miss=row({key:'ttl',ts:time+3600001}),switched=row({key:'switch',model:'m2',ts:miss.ts+1}),cross=row({key:'cross',model:'m2',ts:miss.ts+2,promptTokens:90000});
 onRowsApplied([hit,miss,switched,cross,row({key:'child',conv:'child'}),row({key:'late',ts:1000})]);onRowsApplied([hit]);expect(db.prepare('SELECT model,calls_hit,calls_miss,calls_cross,first_gap_hit FROM compaction_effect ORDER BY model').all()).toEqual([{model:'m1',calls_hit:1,calls_miss:1,calls_cross:0,first_gap_hit:1},{model:'m2',calls_hit:0,calls_miss:1,calls_cross:1,first_gap_hit:0}]);
});
it('updates own overhead only from actual compact-turn usage and honors the latest TTL',async()=>{
 request('r','m1','/compact');event('turn/started');accept('r');context(40000);const before=row();event('thread/compacted');context(10000);const s=source();await s.flushThread('t',false);const store=createStore(db);store.applyRows([before]);s.onRowsApplied([before]);expect(db.prepare('SELECT own_cost_known FROM compactions').get()).toEqual({own_cost_known:1});expect(db.prepare('SELECT overhead_fresh_in FROM compaction_effect').get()).toEqual({overhead_fresh_in:100});store.setCursor('cache-ttl:t',5);s.onRowsApplied([row({key:'after',ts:time+10})]);expect(db.prepare('SELECT calls_miss FROM compaction_effect').get()).toEqual({calls_miss:1});
});
it('retains applied calls while an after snapshot is pending, including across factory restart',async()=>{
 const s=source();s.onRowsApplied([row({key:'prev'})]);context(40000);event('thread/compacted');await s.flushThread('t',false);s.onRowsApplied([row({key:'pending'})]);
 expect(db.prepare('SELECT * FROM compaction_effect').all()).toEqual([]);context(10000);await source().flushThread('t',false);expect(db.prepare('SELECT calls_hit FROM compaction_effect').get()).toEqual({calls_hit:1});
});
it('pairs historical snapshots before applying the pending timeout, even across a page boundary',async()=>{
 context(40000);event('thread/compacted');for(let i=0;i<98;i++)event('thread/identity',{providerThreadId:'s'},null);context(10000);time+=86400001;await source().flushThread('t',false);expect(db.prepare('SELECT after_tokens,after_known,expired FROM compactions').get()).toEqual({after_tokens:10000,after_known:1,expired:0});
});
it('caps a flush at five pages and resumes at its saved cursor',async()=>{
  for(let i=0;i<601;i++)event('thread/identity',{providerThreadId:`s${i}`},null);
  const s=source();expect((await s.flushThread('t',false)).more).toBe(true);expect(list).toHaveBeenCalledTimes(5);
  expect(db.prepare('SELECT last_seq FROM bb_cursor').get()).toEqual({last_seq:500});
  expect((await s.flushThread('t',false)).more).toBe(false);expect(list).toHaveBeenCalledTimes(7);
  expect(db.prepare('SELECT last_seq FROM bb_cursor').get()).toEqual({last_seq:601});
});

it('backfills one accumulated snapshot per new counter and seeds subsequent live deltas',async()=>{
 usage(10000,100);
 const s=source(), first=await s.flushThread('t',true);
 expect(first.rows).toHaveLength(1);
 expect(first.rows[0]).toMatchObject({key:'bb:t:e1',freshIn:10000,flags:BACKFILLED|ESTIMATED});
 expect(db.prepare('SELECT partial FROM thread_cov WHERE thread_id=?').get('t')).toBeUndefined();
 usage(10100,100);
 const next=await source().flushThread('t',true);
 expect(next.rows).toHaveLength(1);expect(next.rows[0].freshIn).toBe(100);expect(next.rows[0].flags & (BACKFILLED|RECOVERED)).toBe(0);
});
it('keeps only last calls as candidates for new Codex counter scopes',async()=>{
 db.prepare("UPDATE threads SET provider_id='codex'").run();usage(10000,100);usage(8000,80,'child');usage(10200,200);
 const result=await source().flushThread('t',false);
 expect(result.rows).toEqual([]);
 expect(result.candidates.map(r=>[r.freshIn,r.conv,!!(r.flags&BACKFILLED)])).toEqual([[100,'',false],[80,'nested:child',false],[200,'',false]]);
});
it('assigns historical calls to their compaction intervals after both compactions are loaded',async()=>{
 const before=row({key:'before'});context(40000);const c1=event('thread/compacted');context(10000);
 const between1=row({key:'between1'}),between2=row({key:'between2'});context(50000);const c2=event('thread/compacted');context(12000);const after=row({key:'after'});
 const s=source();await s.flushThread('t',false);
 s.onRowsApplied([after,between2,before,between1]);
 expect(db.prepare('SELECT compaction_id,calls_hit,calls_miss,first_gap_hit FROM compaction_effect ORDER BY compaction_id').all()).toEqual([
  {compaction_id:`bbc:${c1.id}`,calls_hit:2,calls_miss:0,first_gap_hit:1},
  {compaction_id:`bbc:${c2.id}`,calls_hit:1,calls_miss:0,first_gap_hit:1},
 ]);
});
it('uses the observed last-call band to price backfilled and recovered aggregates',async()=>{
 request('r','gpt-6.1-sol');event('turn/started');accept('r');usage(300000,10000);
 const first=(await source().flushThread('t',true)).rows[0];
 expect(first).toMatchObject({promptTokens:300000,band:0});expect(costUsd(first,first.model,first.tier,first.band)).toBeCloseTo(0.60);
 usage(610000,10000);
 const recovered=(await source().flushThread('t',true)).rows.find(r=>r.flags&RECOVERED)!;
 expect(recovered).toMatchObject({promptTokens:300000,band:0});expect(costUsd(recovered,recovered.model,recovered.tier,recovered.band)).toBeCloseTo(0.60);
});
it('does not mark exact file-backed threads partial while collecting initial or gap candidates',async()=>{
 usage(200,100);const s=source();const first=await s.flushThread('t',false);
 expect(first.candidates[0]).toMatchObject({freshIn:100});expect(first.candidates[0].flags & BACKFILLED).toBe(0);
 usage(500,100);expect((await s.flushThread('t',false)).candidates.some(r=>r.flags&RECOVERED)).toBe(true);
 expect(db.prepare('SELECT * FROM thread_cov').all()).toEqual([]);
});
it('defaults an aggregate to band zero when no last call was observed',async()=>{
 usage(300000,0);expect((await source().flushThread('t',true)).rows[0]).toMatchObject({promptTokens:300000,band:0});
});
it('persists the initial total beside last-only candidates without advancing it on later snapshots',async()=>{
 usage(10000,100);await source().flushThread('t',false);
 expect(db.prepare("SELECT key,fresh_in,band,flags FROM bb_candidate WHERE key GLOB 'bbi:*'").all()).toEqual([{key:'bbi:t:e1',fresh_in:10000,band:0,flags:BACKFILLED|ESTIMATED}]);
 usage(10100,100);await source().flushThread('t',false);
 expect(db.prepare("SELECT fresh_in FROM bb_candidate WHERE key GLOB 'bbi:*'").all()).toEqual([{fresh_in:10000}]);
 expect(db.prepare('SELECT partial FROM thread_cov').get()).toBeUndefined();
});

it('assigns the only surviving snapshot to the last of three historical compactions',async()=>{
 event('thread/compacted');event('thread/compacted');event('thread/compacted');context(120848);
 await source().flushThread('t',false);
 expect(db.prepare('SELECT after_tokens,after_known FROM compactions ORDER BY seq').all()).toEqual([{after_tokens:0,after_known:0},{after_tokens:0,after_known:0},{after_tokens:120848,after_known:1}]);
});
it('recomputes historical effects when compactions arrive after already applied calls, idempotently',async()=>{
 const before=row({key:'before'});context(40000);const c1=event('thread/compacted');context(10000);
 const between=row({key:'between'});context(50000);const c2=event('thread/compacted');context(12000);const after=row({key:'after'});
 const s=source(),store=createStore(db);store.applyRows([before,between,after]);s.onRowsApplied([before,between,after]);
 await s.flushThread('t',false);await source().flushThread('t',false);
 expect(db.prepare('SELECT compaction_id,calls_hit,calls_miss,first_gap_hit FROM compaction_effect WHERE calls_hit+calls_miss>0 ORDER BY compaction_id').all()).toEqual([
 {compaction_id:`bbc:${c1.id}`,calls_hit:1,calls_miss:0,first_gap_hit:1},{compaction_id:`bbc:${c2.id}`,calls_hit:1,calls_miss:0,first_gap_hit:1}]);
 s.onRowsApplied([between,after]);expect(db.prepare('SELECT SUM(calls_hit) n FROM compaction_effect').get()).toEqual({n:2});
});

it('merges bb events arriving after a file marker without replacing authoritative sizes',async()=>{
 const {createCompactions}=await import('./compactions');
 context(90000);const e=event('thread/compacted');context(120848);
 createCompactions(db,createStore(db),()=>time,false).upsert([{threadId:'t',at:e.createdAt-1000,before:429042,after:16199,conv:'',source:'claude-file',key:'ccx:session:boundary'}]);
 await source().flushThread('t',false);
 expect(db.prepare('SELECT before_tokens,after_tokens,seq FROM compactions').all()).toEqual([{before_tokens:429042,after_tokens:16199,seq:e.seq}]);
});

it('keeps retained interval effects when recomputing with only a suffix of raw calls',async()=>{
 const {createCompactions}=await import('./compactions');
 const store=createStore(db), effects=createCompactions(db,store,()=>time,false);
 const before=row({key:'before'}), at=++time, calls=[row({key:'one'}),row({key:'two'}),row({key:'three'})];
 store.applyRows([before,...calls]);effects.upsert([{threadId:'t',at,before:40000,after:10000,conv:'',source:'claude-file',key:'ccx:s:1'}]);
 const saved=db.prepare('SELECT * FROM compaction_effect').all();
 db.prepare('DELETE FROM usage_raw WHERE ts<?').run(calls[2].ts);effects.recompute('t');
 expect(db.prepare('SELECT * FROM compaction_effect').all()).toEqual(saved);
});
