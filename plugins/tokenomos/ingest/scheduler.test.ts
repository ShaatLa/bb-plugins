import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MIGRATIONS } from '../store/schema';
import { createStore } from '../store/write';
import { createScheduler } from './scheduler';
import type { UsageRow } from '../contract';

const row = (o: Partial<UsageRow> = {}): UsageRow => ({key:'r',ts:1_000_000,threadId:'t',projectId:'p',provider:'claude-code',model:'claude-sonnet-5-5',tier:'standard',tierRaw:'',promptTokens:100,band:0,conv:'',freshIn:100,cacheRead:0,cacheWriteShort:0,cacheWriteLong:0,output:0,reasoning:0,turnId:null,source:'claude-file',flags:0,...o});
const settingsValue = {rawRetentionDays:30,rollupRetentionDays:200,referenceModel:'claude-sonnet-5-5',priceOverrides:'{}',includeOutsideBb:false};
let dispose: (()=>Promise<void>) | undefined;
beforeEach(()=> {vi.useFakeTimers();vi.setSystemTime(1_000_000);});
afterEach(async()=> {await dispose?.();dispose=undefined;vi.useRealTimers();});
function setup(provider='claude-code', found=true, available=true) {
  const thread = makeThreadResponse({id:'t',projectId:'p',providerId:provider,environmentId:null,createdAt:1});
  const {bb,harness} = createFakePluginHost({pluginId:'tokenomos',sdk:{threads:{list:async()=>[],get:async()=>thread}}});
  dispose=()=>harness.lifecycle.dispose();
  const db=bb.storage.database();bb.storage.migrate(db,MIGRATIONS);const store=createStore(db);
  const settings=bb.settings.define({rawRetentionDays:{type:'number',label:'raw',default:30},rollupRetentionDays:{type:'number',label:'rollup',default:200},referenceModel:{type:'string',label:'ref',default:settingsValue.referenceModel},priceOverrides:{type:'string',label:'price',default:'{}'},includeOutsideBb:{type:'boolean',label:'outside',default:false}});
  const file={locate:vi.fn(async()=>found),flushThread:vi.fn(async()=>({rows:[] as UsageRow[],parseErrors:0,commit:vi.fn()})),scanOutside:vi.fn(async()=>({rows:[],commit:vi.fn()}))};
  const events={flushThread:vi.fn(async()=>({rows:[] as UsageRow[],candidates:[] as UsageRow[],touched:false})),coverage:vi.fn(async()=>({uncoveredStreak:0,firstUncoveredStart:null as number|null,lastCoveredTurnStart:null as number|null})),onRowsApplied:vi.fn()};
  const ext={pollUsage:vi.fn(async()=>({rows:[] as UsageRow[],available})),pollCompactions:vi.fn(async()=>({matched:0,available:true}))};
  createScheduler({bb,db,store,settings,files:{'claude-file':file,'codex-file':file},sources:()=>({bbEvents:events,ext})});
  harness.behavior.runService('ingest');
  const emit=()=>harness.behavior.emitThreadEvent('experimental_thread.events',{thread,sequence:1});
  const step=()=>vi.advanceTimersByTimeAsync(5000);
  const source=()=>db.prepare('SELECT source,state FROM thread_source WHERE thread_id=?').get('t');
  const total=()=> (db.prepare('SELECT SUM(fresh_in) n FROM thread_tokens').get() as {n:number}).n;
  return {bb,harness,db,store,file,events,ext,thread,emit,step,source,total};
}
it.each([['claude-code',true,true,'claude-file'],['codex',true,true,'codex-file'],['local-models',false,true,'local-log'],['antigravity',false,true,'agy-log'],['antigravity',false,false,'bb-events'],['other',false,false,'bb-events']])('selects %s (file %s, RPC %s)',async(provider,found,available,expected)=>{
  const s=setup(provider,found,available);await s.emit();await s.step();expect(s.source()).toMatchObject({source:expected});
});
it('waits ten minutes from first usage, then falls back and replaces retained fallback with a late file',async()=>{
  const s=setup('claude-code',false);s.events.flushThread.mockResolvedValueOnce({rows:[],candidates:[row({key:'bb',source:'bb-events'})],touched:true});
  await s.emit();await s.step();expect(s.source()).toMatchObject({source:'claude-file'});expect(s.total()).toBe(null);
  await vi.advanceTimersByTimeAsync(600_000);expect(s.source()).toMatchObject({source:'bb-events'});expect(s.total()).toBe(100);
  s.file.locate.mockResolvedValue(true);s.file.flushThread.mockResolvedValue({rows:[row()],parseErrors:0,commit:vi.fn()});await s.step();
  expect(s.source()).toMatchObject({source:'claude-file'});expect(s.total()).toBe(100);expect(s.db.prepare('SELECT source FROM usage_raw').all()).toEqual([{source:'claude-file'}]);
});
it('keeps fallback after raw expiry and exposes why',async()=>{
  const s=setup();s.store.noteThread(s.thread);s.db.prepare("INSERT INTO thread_source VALUES ('t','bb-events',0,'ok')").run();
  s.store.applyRows([row({source:'bb-events'})]);s.db.prepare('DELETE FROM usage_raw').run();
  s.file.flushThread.mockResolvedValue({rows:[row()],parseErrors:0,commit:vi.fn()});await s.emit();await s.step();
  expect(s.source()).toMatchObject({source:'bb-events'});expect(s.total()).toBe(100);expect(s.db.prepare('SELECT last_error FROM source_status WHERE source=?').get('bb-events')).toEqual({last_error:'Source switch deferred: raw rows have expired'});
});
it('opens and closes degraded intervals without counting a later transcript of the same call twice',async()=>{
  const s=setup();
  s.events.flushThread.mockResolvedValueOnce({rows:[],candidates:[row({key:'bb',ts:900_000,source:'bb-events'})],touched:true});
  s.events.coverage.mockResolvedValue({uncoveredStreak:3,firstUncoveredStart:900_000,lastCoveredTurnStart:null});
  await s.emit();await s.step();expect(s.source()).toMatchObject({state:'degraded'});expect(s.total()).toBe(100);
  s.file.flushThread.mockResolvedValueOnce({rows:[row({key:'late',ts:900_000})],parseErrors:0,commit:vi.fn()});await s.emit();await s.step();expect(s.total()).toBe(100);expect(s.source()).toMatchObject({state:'degraded'});
  const ts=Date.now()+1;s.db.prepare("INSERT INTO turns(thread_id,turn_id,started_at,completed_at,reported_usage) VALUES ('t','new',?,?,1)").run(ts-1,ts+1);
  s.events.flushThread.mockResolvedValueOnce({rows:[],candidates:[row({key:'bb2',ts,source:'bb-events'})],touched:true});
  s.file.flushThread.mockResolvedValueOnce({rows:[row({key:'file2',ts})],parseErrors:0,commit:vi.fn()});
  s.events.coverage.mockResolvedValue({uncoveredStreak:0,firstUncoveredStart:null,lastCoveredTurnStart:ts-1});await s.emit();await s.step();
  expect(s.source()).toMatchObject({state:'ok'});expect(s.total()).toBe(200);
  s.file.flushThread.mockResolvedValueOnce({rows:[row({key:'file3',ts:Date.now()+1})],parseErrors:0,commit:vi.fn()});await s.emit();await s.step();expect(s.total()).toBe(300);
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
