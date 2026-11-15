import Database from 'better-sqlite3';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import type { PluginBbSdk, PluginLogger } from '@get-bb/plugin-sdk';
import { readFileSync } from 'node:fs';
import { type UsageRow, RECOVERED } from '../contract';
import { MIGRATIONS } from '../store/schema';
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
 expect((await source().flushThread('t',true)).rows[0]).toMatchObject({model:'m1',tier:'standard',tierRaw:'default',turnId:'t1',flags:0});
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
it('returns candidates while maintaining non-owned counters',async()=>{usage(100,100);const s=source(),a=await s.flushThread('t',false);expect(a.rows).toEqual([]);expect(a.candidates).toHaveLength(1);usage(180,80);expect((await s.flushThread('t',true)).rows).toHaveLength(1);});
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
 const {rows}=await source().flushThread('t',true);expect(log.warn).not.toHaveBeenCalled();expect(rows[0]).toMatchObject({freshIn:62,cacheRead:6140824,cacheWriteShort:32192,output:12168});expect(db.prepare("SELECT compaction_only FROM turns WHERE turn_id='daa6b08a7b-t1'").get()).toEqual({compaction_only:1});expect(db.prepare("SELECT own_cost_known FROM compactions WHERE turn_id='daa6b08a7b-t1'").get()).toEqual({own_cost_known:0});
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
