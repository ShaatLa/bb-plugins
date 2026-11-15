import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MIGRATIONS } from '../store/schema';
import { createStore } from '../store/write';
import { createExtSource } from './ext';
import { createBbEvents } from './bb-events';
import { createScheduler } from './scheduler';
import type { UsageRow } from '../contract';

vi.mock('node:timers/promises', () => ({ setImmediate: vi.fn(async (_value?: unknown, options?: { signal?: AbortSignal }) => { options?.signal?.throwIfAborted(); }) }));

const row = (o: Partial<UsageRow> = {}): UsageRow => ({key:'r',ts:1_000_000,threadId:'t',projectId:'p',provider:'claude-code',model:'claude-sonnet-5-5',tier:'standard',tierRaw:'',promptTokens:100,band:0,conv:'',freshIn:100,cacheRead:0,cacheWriteShort:0,cacheWriteLong:0,output:0,reasoning:0,turnId:null,source:'claude-file',flags:0,...o});
const settingsValue = {rawRetentionDays:30,rollupRetentionDays:200,referenceModel:'claude-sonnet-5-5',priceOverrides:'{}',includeOutsideBb:false};
let dispose: (()=>Promise<void>) | undefined;
beforeEach(()=> {vi.useFakeTimers();vi.setSystemTime(1_000_000);});
afterEach(async()=> {await dispose?.();dispose=undefined;vi.useRealTimers();});
type TestEvent = {id:string;seq:number;createdAt:number;type:string;data:unknown;scope:{kind:'thread'}|{kind:'turn';turnId:string}};
function setup(provider='claude-code', found=true, available=true, realEvents?:TestEvent[], externalRpc?: (id:string, method:string, input:unknown)=>Promise<unknown>) {
  const thread = makeThreadResponse({id:'t',projectId:'p',providerId:provider,environmentId:null,createdAt:1});
  const {bb,harness} = createFakePluginHost({pluginId:'tokenomos',sdk:{threads:{list:async()=>[],get:async()=>thread,events:{list:async a=>(realEvents??[]).filter(e=>e.seq>Number(a.afterSeq)).slice(0,100)}}}});
  dispose=()=>harness.lifecycle.dispose();
  const db=bb.storage.database();bb.storage.migrate(db,MIGRATIONS);const store=createStore(db);
  const settings=bb.settings.define({rawRetentionDays:{type:'number',label:'raw',default:30},rollupRetentionDays:{type:'number',label:'rollup',default:200},referenceModel:{type:'string',label:'ref',default:settingsValue.referenceModel},priceOverrides:{type:'string',label:'price',default:'{}'},includeOutsideBb:{type:'boolean',label:'outside',default:false}});
  const file={locate:vi.fn(async()=>found),flushThread:vi.fn(async(_info?: unknown, _signal?: AbortSignal)=>({rows:[] as UsageRow[],parseErrors:0,commit:vi.fn(),more:undefined as boolean | undefined})),scanOutside:vi.fn(async()=>({rows:[],commit:vi.fn()}))};
  const events={flushThread:vi.fn(async()=>({rows:[] as UsageRow[],candidates:[] as UsageRow[],touched:false,...({} as {more?:boolean})})),coverage:vi.fn(async()=>({uncoveredStreak:0,firstUncoveredStart:null as number|null,lastCoveredTurnStart:null as number|null})),onRowsApplied:vi.fn()};
  const ext={pollUsage:vi.fn(async()=>({rows:[] as UsageRow[],available})),pollCompactions:vi.fn(async()=>({matched:0,available:true}))};
  createScheduler({bb,db,store,settings,files:{'claude-file':file,'codex-file':file},sources:sdk=>({bbEvents:realEvents?createBbEvents({db,store,sdk,log:bb.log}):events,ext:externalRpc?createExtSource({db,store,callRpc:externalRpc}):ext})});
  const service = harness.behavior.runService('ingest');
  const emit=()=>harness.behavior.emitThreadEvent('experimental_thread.events',{thread,sequence:1});
  const step=()=>vi.advanceTimersByTimeAsync(5000);
  const source=()=>db.prepare('SELECT source,state FROM thread_source WHERE thread_id=?').get('t');
  const total=()=> (db.prepare('SELECT SUM(fresh_in) n FROM thread_tokens').get() as {n:number}).n;
  return {bb,harness,db,store,file,events,ext,thread,emit,step,source,total,service};
}
it.each([['claude-code',true,true,'claude-file'],['codex',true,true,'codex-file'],['local-models',false,true,'local-log'],['antigravity',false,true,'agy-log'],['antigravity',false,false,'bb-events'],['other',false,false,'bb-events']])('selects %s (file %s, RPC %s)',async(provider,found,available,expected)=>{
  const s=setup(provider,found,available);await s.emit();await s.step();expect(s.source()).toMatchObject({source:expected});
});
it('waits ten minutes from first usage, then falls back and replaces retained fallback with a late file',async()=>{
  const s=setup('claude-code',false);s.events.flushThread.mockResolvedValueOnce({rows:[],candidates:[row({key:'bb',source:'bb-events'})],touched:true});
  await s.emit();await s.step();expect(s.source()).toMatchObject({source:'claude-file'});expect(s.total()).toBe(null);
  await vi.advanceTimersByTimeAsync(600_000);expect(s.source()).toMatchObject({source:'bb-events'});expect(s.total()).toBe(100);
  s.file.locate.mockResolvedValue(true);s.file.flushThread.mockResolvedValue({rows:[row()],parseErrors:0,commit:vi.fn(),more:undefined});await s.step();
  expect(s.source()).toMatchObject({source:'claude-file'});expect(s.total()).toBe(100);expect(s.db.prepare('SELECT source FROM usage_raw').all()).toEqual([{source:'claude-file'}]);
});
it('keeps fallback after raw expiry and exposes why',async()=>{
  const s=setup();s.store.noteThread(s.thread);s.db.prepare("INSERT INTO thread_source VALUES ('t','bb-events',0,'ok')").run();
  s.store.applyRows([row({source:'bb-events'})]);s.db.prepare('DELETE FROM usage_raw').run();
  s.file.flushThread.mockResolvedValue({rows:[row()],parseErrors:0,commit:vi.fn(),more:undefined});await s.emit();await s.step();
  expect(s.source()).toMatchObject({source:'bb-events'});expect(s.total()).toBe(100);expect(s.db.prepare('SELECT last_error FROM source_status WHERE source=?').get('bb-events')).toEqual({last_error:'Source switch deferred: raw rows have expired'});
});
it('does not degrade while a large transcript is still being caught up (more: true)',async()=>{
  const s=setup();
  s.events.flushThread.mockResolvedValueOnce({rows:[],candidates:[row({key:'bb',ts:900_000,source:'bb-events'})],touched:true});
  s.events.coverage.mockResolvedValue({uncoveredStreak:3,firstUncoveredStart:900_000,lastCoveredTurnStart:null});
  s.file.flushThread.mockResolvedValue({rows:[row({key:'old',ts:100_000})],parseErrors:0,commit:vi.fn(),more:true});
  await s.emit();await s.step();expect(s.source()).toMatchObject({state:'ok'});
});
it('opens and closes degraded intervals without counting a later transcript of the same call twice',async()=>{
  const s=setup();
  s.events.flushThread.mockResolvedValueOnce({rows:[],candidates:[row({key:'bb',ts:900_000,source:'bb-events'})],touched:true});
  s.events.coverage.mockResolvedValue({uncoveredStreak:3,firstUncoveredStart:900_000,lastCoveredTurnStart:null});
  await s.emit();await s.step();expect(s.source()).toMatchObject({state:'degraded'});expect(s.total()).toBe(100);
  s.file.flushThread.mockResolvedValueOnce({rows:[row({key:'late',ts:900_000})],parseErrors:0,commit:vi.fn(),more:undefined});await s.emit();await s.step();expect(s.total()).toBe(100);expect(s.source()).toMatchObject({state:'degraded'});
  const ts=Date.now()+1;s.db.prepare("INSERT INTO turns(thread_id,turn_id,started_at,completed_at,reported_usage) VALUES ('t','new',?,?,1)").run(ts-1,ts+1);
  s.events.flushThread.mockResolvedValueOnce({rows:[],candidates:[row({key:'bb2',ts,source:'bb-events'})],touched:true});
  s.file.flushThread.mockResolvedValueOnce({rows:[row({key:'file2',ts})],parseErrors:0,commit:vi.fn(),more:undefined});
  s.events.coverage.mockResolvedValue({uncoveredStreak:0,firstUncoveredStart:null,lastCoveredTurnStart:ts-1});await s.emit();await s.step();
  expect(s.source()).toMatchObject({state:'ok'});expect(s.total()).toBe(200);
  s.file.flushThread.mockResolvedValueOnce({rows:[row({key:'file3',ts:Date.now()+1})],parseErrors:0,commit:vi.fn(),more:undefined});await s.emit();await s.step();expect(s.total()).toBe(300);
});
it('throttles invalidation and guarantees a trailing settings invalidation',async()=>{
  const s=setup();await vi.advanceTimersByTimeAsync(0);await s.emit();const n=s.harness.experimental_rpcInvalidations.length;
  await vi.advanceTimersByTimeAsync(1000);await s.harness.behavior.setSettings({priceOverrides:'{"m":{"input":1}}'});
  await s.harness.behavior.setSettings({referenceModel:'other'});expect(s.harness.experimental_rpcInvalidations).toHaveLength(n);
  await vi.advanceTimersByTimeAsync(4000);expect(s.harness.experimental_rpcInvalidations).toHaveLength(n+1);
});
it('records a file error and retries the thread without stopping other sources',async()=>{
  const s=setup();s.file.locate.mockRejectedValueOnce(new Error('unreadable'));await s.emit();await s.step();
  expect(s.harness.logEntries.some(e=>e.level==='warn')).toBe(true);await s.step();expect(s.source()).toMatchObject({source:'claude-file'});
});
it('applies external calls and outside scans in the service, with a commit for each file batch',async()=>{
  const s=setup('local-models');const commit=vi.fn();
  s.ext.pollUsage.mockResolvedValueOnce({rows:[row({source:'local-log',provider:'local-models'})],available:true});
  s.file.scanOutside.mockResolvedValue({rows:[row({key:'outside',threadId:'',projectId:'~outside'})] as never[],commit});
  await s.harness.behavior.setSettings({includeOutsideBb:true});await s.emit();await s.step();
  expect(s.total()).toBe(100);expect(commit).toHaveBeenCalledTimes(2);
  expect(s.db.prepare('SELECT COUNT(*) n FROM usage_raw').get()).toEqual({n:2});
});
it('limits dirty batches to fifty threads and keeps a pending flush single flight',async()=>{
  const s=setup('other');await vi.advanceTimersByTimeAsync(0);
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  s.events.flushThread.mockImplementationOnce(async()=>{await gate;return {rows:[],candidates:[],touched:false};});
  for(let i=0;i<55;i++)await s.harness.behavior.emitThreadEvent('thread.created',{thread:{...s.thread,id:`t${i}`}});
  await s.step();expect(s.events.flushThread).toHaveBeenCalledTimes(1);await s.step();expect(s.events.flushThread).toHaveBeenCalledTimes(1);
  release();await vi.advanceTimersByTimeAsync(0);expect(s.events.flushThread).toHaveBeenCalledTimes(50);
  await s.step();expect(s.events.flushThread).toHaveBeenCalledTimes(55);
});
it('backs up degradation to decision time when raw rows have expired',async()=>{
  const s=setup();s.store.noteThread(s.thread);s.store.applyRows([row({ts:100})]);s.db.prepare('DELETE FROM usage_raw').run();
  s.events.coverage.mockResolvedValue({uncoveredStreak:3,firstUncoveredStart:900_000,lastCoveredTurnStart:null});
  s.events.flushThread.mockResolvedValueOnce({rows:[],candidates:[row({key:'old',ts:900_001,source:'bb-events'})],touched:true});
  await s.emit();await s.step();expect(s.source()).toMatchObject({state:'degraded'});expect(s.total()).toBe(100);
  expect(s.db.prepare("SELECT from_ts FROM source_interval WHERE source='bb-events'").get()).toEqual({from_ts:1_000_000});
});
it('keeps fallback totals if reading a late file fails before the switch transaction',async()=>{
  const s=setup();s.store.noteThread(s.thread);s.store.applyRows([row({source:'bb-events'})]);s.db.prepare("INSERT INTO thread_source VALUES ('t','bb-events',0,'ok')").run();
  s.file.flushThread.mockRejectedValue(new Error('file read failed'));await s.emit();await s.step();
  expect(s.total()).toBe(100);expect(s.source()).toMatchObject({source:'bb-events'});
});
it('aborts the run signal and stops within 1500 ms even if a file flush ignores cancellation',async()=>{
  const s=setup();await vi.advanceTimersByTimeAsync(0);
  let release!:()=>void;
  const gate=new Promise<never>(resolve=>{release=()=>resolve({rows:[],parseErrors:0,commit:vi.fn()} as never);});
  s.file.flushThread.mockImplementationOnce(async()=>gate);
  await s.emit();await s.step();
  expect(s.file.flushThread).toHaveBeenCalled();
  const signal=s.file.flushThread.mock.calls.at(-1)![1]!;
  const applied=s.events.onRowsApplied.mock.calls.length;
  let done=false;s.service.done.then(()=>{done=true;});s.service.controller.abort();
  expect(signal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(1499);expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(1);await s.service.done;expect(done).toBe(true);
  release();await vi.advanceTimersByTimeAsync(0);
  expect(s.events.onRowsApplied).toHaveBeenCalledTimes(applied);
});
it('flushes a source again when it reports more rows',async()=>{
  const s=setup();await vi.advanceTimersByTimeAsync(0);
  s.file.flushThread.mockResolvedValueOnce({rows:[row({key:'first'})],parseErrors:0,commit:vi.fn(),more:true});
  s.file.flushThread.mockResolvedValueOnce({rows:[row({key:'second'})],parseErrors:0,commit:vi.fn(),more:false});
  await s.emit();await s.step();await s.step();
  expect(s.file.flushThread).toHaveBeenCalledTimes(2);expect(s.total()).toBe(200);
});
it('splits large external results into transactions of at most 1000 rows',async()=>{
  const s=setup('local-models');
  const batches:number[]=[];let count=0;
  s.db.function('count_applied',()=>{count++;return 1;});
  s.db.exec('CREATE TEMP TRIGGER count_insert AFTER INSERT ON usage_raw BEGIN SELECT count_applied(); END');
  const spy=vi.spyOn(s.db,'transaction');
  spy.mockImplementation(((fn:(...args:unknown[])=>unknown)=>{
    const wrapped=(...args:unknown[])=>{const before=count;const result=fn(...args);if(count>before)batches.push(count-before);return result;};
    return original(wrapped);
  }) as typeof s.db.transaction);
  function original(fn:(...args:unknown[])=>unknown) {return Object.getPrototypeOf(s.db).transaction.call(s.db,fn);}
  s.ext.pollUsage.mockResolvedValueOnce({rows:Array.from({length:2500},(_,i)=>row({key:`ext${i}`,source:'local-log',provider:'local-models'})),available:true});
  await s.emit();await s.step();
  expect(s.total()).toBe(250000);expect(Math.max(...batches)).toBeLessThanOrEqual(1000);expect(batches.length).toBeGreaterThanOrEqual(3);
});
it('accepts thread events while a file flush is awaiting IO',async()=>{
  const s=setup();await vi.advanceTimersByTimeAsync(0);
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  s.file.flushThread.mockImplementationOnce(async()=>{await gate;return {rows:[],parseErrors:0,commit:vi.fn(),more:undefined};});
  await s.emit();await s.step();
  const event=await s.harness.behavior.emitThreadEvent('thread.created',{thread:{...s.thread,id:'live'}});
  expect(event.errors).toEqual([]);expect(s.db.prepare("SELECT id FROM threads WHERE id='live'").get()).toEqual({id:'live'});
  release();await vi.advanceTimersByTimeAsync(0);await s.step();
  expect(s.harness.logEntries.filter(e=>e.level==='warn')).toEqual([]);
});
it('drains event metadata before reading a transcript',async()=>{
 const s=setup();s.events.flushThread.mockResolvedValue({rows:[],candidates:[],touched:true,more:true});
 await s.emit();await s.step();expect(s.file.locate).not.toHaveBeenCalled();expect(s.file.flushThread).not.toHaveBeenCalled();
 s.events.flushThread.mockResolvedValue({rows:[],candidates:[],touched:true,more:false});await s.step();expect(s.file.flushThread).toHaveBeenCalled();
});
it('attributes a transcript call after C2 to C2 when its metadata is beyond the 500-event flush limit',async()=>{
 const events:TestEvent[]=[];
 const add=(type:string,at:number,data:unknown={providerThreadId:'s'})=>events.push({id:`e${events.length+1}`,seq:events.length+1,createdAt:at,type,data,scope:{kind:'thread'}});
 const context=(at:number,usedTokens:number)=>add('thread/contextWindowUsage/updated',at,{providerThreadId:'s',contextWindowUsage:{usedTokens,estimated:false}});
 context(100,40000);add('thread/compacted',200);context(300,10000);
 while(events.length<500)add('thread/identity',400);
 context(900,50000);add('thread/compacted',1000);const c2=events.at(-1)!.id;context(1100,12000);
 const s=setup('claude-code',true,true,events);
 s.file.flushThread.mockImplementation(async()=>{
   expect(s.db.prepare('SELECT id FROM compactions WHERE id=?').get(`bbc:${c2}`)).toBeDefined();
   return {rows:[row({key:'before',ts:150}),row({key:'after',ts:1200})],parseErrors:0,commit:vi.fn(),more:false};
 });
 await s.emit();await s.step();await s.step();
 expect(s.db.prepare('SELECT compaction_id,calls_hit,calls_miss FROM compaction_effect').all()).toEqual([{compaction_id:`bbc:${c2}`,calls_hit:1,calls_miss:0}]);
 expect(s.db.prepare("SELECT key FROM compaction_seen WHERE key='after'").get()).toEqual({key:'after'});
});
it('counts file turn one plus last-only fallback turns two through four once (400 tokens)',async()=>{
 const events:TestEvent[]=[];
 for(let turn=2;turn<=4;turn++){
   const base=turn*200000;const count=(n:number)=>({totalTokens:n,inputTokens:n,cachedInputTokens:0,outputTokens:0});
   for(const [type,at,data] of [
     ['turn/started',base,{providerThreadId:'s'}],
     ['thread/tokenUsage/updated',base+1,{providerThreadId:'s',tokenUsage:{total:count(turn*100),last:count(100)}}],
     ['turn/completed',base+2,{providerThreadId:'s'}],
   ] as const)events.push({id:`e${events.length+1}`,seq:events.length+1,createdAt:at,type,data,scope:{kind:'turn',turnId:`t${turn}`}});
 }
 const s=setup('claude-code',true,true,events);
 s.file.flushThread.mockResolvedValue({rows:[row({key:'file-turn-one',ts:100000})],parseErrors:0,commit:vi.fn(),more:false});
 await s.emit();await s.step();expect(s.total()).toBe(400);
 expect(s.db.prepare('SELECT partial FROM thread_cov').get()).toEqual({partial:1});
 expect(s.db.prepare("SELECT flags FROM usage_raw WHERE source='bb-events'").all()).toHaveLength(3);
});
it('marks backfill partial only when the scheduler applies its rows',async()=>{
 const count={totalTokens:300000,inputTokens:300000,cachedInputTokens:0,outputTokens:0};
 const events:TestEvent[]=[{id:'e',seq:1,createdAt:1,type:'thread/tokenUsage/updated',data:{providerThreadId:'s',tokenUsage:{total:count,last:{...count,totalTokens:10000,inputTokens:10000}}},scope:{kind:'thread'}}];
 const s=setup('other',false,false,events);await s.emit();await s.step();
 expect(s.total()).toBe(300000);expect(s.db.prepare('SELECT partial FROM thread_cov').get()).toEqual({partial:1});
});
function initialSnapshot(at=1):TestEvent[] {
 const count=(n:number)=>({totalTokens:n,inputTokens:n,cachedInputTokens:0,outputTokens:0});
 return [{id:'initial',seq:1,createdAt:at,type:'thread/tokenUsage/updated',data:{providerThreadId:'s',tokenUsage:{total:count(10000),last:count(100)}},scope:{kind:'thread'}}];
}
it.each(['claude-code','codex','other'])('recovers the initial 10000-token total for %s with no transcript',async(provider)=>{
 const s=setup(provider,false,false,initialSnapshot());await s.emit();await s.step();
 expect(s.total()).toBe(10000);expect(s.source()).toMatchObject({source:'bb-events'});
 await s.emit();await s.step();expect(s.total()).toBe(10000);
});
it.each(['claude-code','codex'])('keeps %s initial history pending until the ten-minute file deadline',async(provider)=>{
 const s=setup(provider,false,false,initialSnapshot(Date.now()));await s.emit();await s.step();expect(s.total()).toBeNull();
 expect(s.db.prepare("SELECT fresh_in FROM bb_candidate WHERE key GLOB 'bbi:*'").get()).toEqual({fresh_in:10000});
 expect(s.db.prepare('SELECT last_seq FROM bb_cursor').get()).toEqual({last_seq:1});
 await vi.advanceTimersByTimeAsync(600000);expect(s.total()).toBe(10000);
 // A late transcript replaces all fallback history once, including the promoted initial total.
 s.file.locate.mockResolvedValue(true);s.file.flushThread.mockResolvedValue({rows:[row({freshIn:10000,promptTokens:10000,source:provider==='codex'?'codex-file':'claude-file'})],parseErrors:0,commit:vi.fn(),more:false});
 await s.step();expect(s.total()).toBe(10000);
 expect(s.db.prepare("SELECT key FROM bb_candidate WHERE key GLOB 'bbi:*'").all()).toEqual([]);
});
it.each(['claude-code','codex'])('drops the %s initial snapshot when a transcript owns its history',async(provider)=>{
 const s=setup(provider,true,true,initialSnapshot());
 s.file.flushThread.mockResolvedValue({rows:[row({source:provider==='codex'?'codex-file':'claude-file'})],parseErrors:0,commit:vi.fn(),more:false});
 await s.emit();await s.step();expect(s.total()).toBe(100);
 expect(s.db.prepare("SELECT key FROM bb_candidate WHERE key GLOB 'bbi:*'").all()).toEqual([]);
 expect(s.db.prepare("SELECT key FROM usage_raw WHERE source='bb-events'").all()).toEqual([]);
});
it('keeps Antigravity contributions and its durable cursor through an RPC outage',async()=>{
 let available=true;
 const rpc=vi.fn(async(id:string,method:string,input:unknown)=>{
   if(method==='compactions.list')return {items:[]};
   if(id!=='antigravity')return {entries:[],nextCursor:null};
   if(!available)throw Object.assign(new Error('unavailable'),{code:'unknown_method'});
   if((input as {after?:string}).after)return {entries:[],nextCursor:null};
   return {entries:[{id:'one',ts:1,source:'thread',threadId:'t',providerThreadId:'s',model:'m',promptTokens:100,cachedTokens:0,completionTokens:0,reasoningTokens:null}],nextCursor:'one'};
 });
 const s=setup('antigravity',false,true,[],rpc);await s.emit();await s.step();expect(s.total()).toBe(100);
 const removed=vi.spyOn(s.store,'deleteContribution');
 const cursor=()=>s.db.prepare("SELECT cursor FROM ext_cursor WHERE source='antigravity'").get();
 expect(cursor()).toEqual({cursor:'one'});
 available=false;await vi.advanceTimersByTimeAsync(60000);await s.emit();await s.step();
 expect(s.source()).toMatchObject({source:'agy-log'});expect(s.total()).toBe(100);expect(removed).not.toHaveBeenCalled();expect(cursor()).toEqual({cursor:'one'});
 expect(s.db.prepare("SELECT state FROM source_status WHERE source='agy-log'").get()).toEqual({state:'unavailable'});
 available=true;await vi.advanceTimersByTimeAsync(60000);await s.emit();await s.step();
 expect(s.total()).toBe(100);expect(s.source()).toMatchObject({source:'agy-log'});expect(removed).not.toHaveBeenCalled();expect(cursor()).toEqual({cursor:'one'});
 expect(s.db.prepare("SELECT state FROM source_status WHERE source='agy-log'").get()).toEqual({state:'ok'});
});
