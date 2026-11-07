import { afterEach, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createWatcher } from "./watcher.js";
import type { Effect, Input } from "./contract.js";
const disposals: (() => Promise<unknown>)[] = [];
afterEach(async()=>{ vi.useRealTimers(); for (const dispose of disposals.splice(0)) await dispose(); });
function setup() {
  let now=0, enabled=true;
  const threads = new Map(['a','b','nested','null','remote'].map(id=>[id,makeThreadResponse({id,environmentId:id})]));
  const paths: Record<string,string|null> = { a:'/alias',b:'/repo',nested:'/repo/sub',null:null,remote:'/other' };
  const list=vi.fn(async ({offset=0,limit=100})=>[...threads.values()].slice(offset,offset+limit));
  const get=vi.fn(async ({threadId})=>threads.get(threadId)!);
  const env=vi.fn(async ({environmentId})=>({hostId:environmentId==='remote'?'remote':'local',path:paths[environmentId]}));
  const host=createFakePluginHost({sdk:{threads:{list,get},environments:{get:env}}}); disposals.push(()=>host.harness.lifecycle.dispose());
  const sample=vi.fn(async (_signal: AbortSignal)=>({startAt:now-30000,endAt:now,valid:true,unknownCores:0,perPid:[{cwd:'/repo',cores:2},{cwd:'/repo/sub/deep',cores:3},{cwd:'/outside',cores:9}],cwdChanged:[] as {from:string;to:string}[],stats:{psMs:2,lsofMs:3,lsofCalls:1,cacheSize:0}}));
  const preview=vi.fn(async (_usage: Extract<Input,{type:'usage'}>)=>[] as Effect[]);
  const commit=vi.fn(async (_usage: Extract<Input,{type:'usage'}>, _verified:Set<string>)=>{});
  const warn=vi.fn();
  const watcher=createWatcher({sdk:host.bb.sdk,hostId:()=> 'local',enabled:()=>enabled,now:()=>now,realpath:vi.fn(async (path)=>path==='/alias'?'/repo':path) as any,collector:{sample},preview,commit,warn});
  return {watcher,sample,preview,commit,warn,list,get,env,threads,paths,advance:(ms=30000)=>now+=ms,off:()=>enabled=false};
}
it('merges realpath aliases and duplicate paths, prefers nested groups, ignores null/remote/outside cwd',async()=>{
  const h=setup(); await h.watcher.run();
  expect(h.commit.mock.calls[0][0]).toMatchObject({valid:true,subjects:[{key:'/repo/sub',threadIds:['nested'],cores:3},{key:'/repo',threadIds:['a','b'],cores:2}]});
  expect(h.watcher.diagnostics().average10m.runs).toBe(1);
});
it('exhausts pagination and caches membership until refresh or lifecycle invalidation',async()=>{
  const h=setup(); for(let i=0;i<101;i++) h.threads.set('x'+i,makeThreadResponse({id:'x'+i,environmentId:'b'}));
  await h.watcher.run(); expect(h.list).toHaveBeenCalledTimes(2);
  h.advance(); await h.watcher.run(); expect(h.list).toHaveBeenCalledTimes(2);
  h.advance(120000); await h.watcher.run(); expect(h.list).toHaveBeenCalledTimes(4);
  h.watcher.invalidate(); await h.watcher.run(); expect(h.list).toHaveBeenCalledTimes(6);
});
it('off performs no collection, SDK reads, transitions or notices, and single flight skips overlap',async()=>{
  const h=setup(); h.off(); await h.watcher.run(); expect(h.sample).not.toHaveBeenCalled(); expect(h.list).not.toHaveBeenCalled(); expect(h.commit).not.toHaveBeenCalled();
  const active=setup(); let resolve!:()=>void; active.sample.mockImplementationOnce(async signal=>{await new Promise<void>(r=>resolve=r); return {startAt:0,endAt:30000,valid:false,perPid:[],unknownCores:0,cwdChanged:[],stats:{psMs:0,lsofMs:0,lsofCalls:0,cacheSize:0}};});
  const first=active.watcher.run(); await active.watcher.run(); expect(active.sample).toHaveBeenCalledTimes(1); resolve(); await first;
});
it('SDK failures and hung reads invalidate intervals and the next run recovers; dispose aborts collection',async()=>{
  vi.useFakeTimers(); const h=setup(); h.list.mockImplementationOnce(()=>new Promise(()=>{}));
  const run=h.watcher.run(); await vi.advanceTimersByTimeAsync(20000); await run;
  expect(h.commit.mock.calls[0][0].valid).toBe(false); h.advance(); await h.watcher.run(); expect(h.commit.mock.calls[1][0].valid).toBe(true);
  let signal!:AbortSignal; h.sample.mockImplementationOnce(async s=>{signal=s; return await new Promise(()=>{});});
  const pending=h.watcher.run(); h.watcher.dispose(); await pending; expect(signal.aborted).toBe(true);
});
it('refresh catches a silent move between known checkouts, fresh alert reads reject stale attribution',async()=>{
  const h=setup(); await h.watcher.run();
  const subject={key:'/repo',threadIds:['a','b'],cores:5};
  h.preview.mockResolvedValue([{type:'notify',reason:'unleased-load',threadId:'observer',text:'load',watch:{hostId:'local',subject}}]);
  h.threads.set('a',makeThreadResponse({id:'a',environmentId:'nested'}));
  h.advance(); await h.watcher.run(); expect(h.commit.mock.calls[1][1].size).toBe(0); expect(h.commit.mock.calls[1][0].resetKeys).toContain('/repo');
  h.advance(120000); await h.watcher.run(); expect(h.commit.mock.calls[2][0].subjects.find(s=>s.key==='/repo/sub')?.threadIds).toEqual(['a','nested']);
});
it('cwd changes reset old and new group histories and verified alerts receive a fresh environment read',async()=>{
  const h=setup(); await h.watcher.run(); h.sample.mockResolvedValueOnce({...await h.sample(new AbortController().signal),cwdChanged:[{from:'/repo',to:'/repo/sub'}]});
  const subject={key:'/repo',threadIds:['a','b'],cores:5}; h.preview.mockResolvedValue([{type:'notify',reason:'unleased-load',threadId:'observer',text:'load',watch:{hostId:'local',subject}}]);
  h.advance(); await h.watcher.run(); expect(h.commit.mock.calls[1][0].resetKeys).toEqual(expect.arrayContaining(['/repo','/repo/sub'])); expect(h.commit.mock.calls[1][1].has('/repo')).toBe(true);
  expect(h.get).toHaveBeenCalledTimes(2);
});
