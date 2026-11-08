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
  const statuses: Record<string, string> = {};
  const env=vi.fn(async ({environmentId})=>({status:statuses[environmentId] ?? "ready",hostId:environmentId==='remote'?'remote':'local',path:paths[environmentId]}));
  const host=createFakePluginHost({sdk:{threads:{list,get},environments:{get:env}}}); disposals.push(()=>host.harness.lifecycle.dispose());
  const sample=vi.fn(async (_signal: AbortSignal)=>({startAt:now-30000,endAt:now,valid:true,unknownCores:0,perPid:[{cwd:'/repo',cores:2},{cwd:'/repo/sub/deep',cores:3},{cwd:'/outside',cores:9}],cwdChanged:[] as {from:string;to:string}[],stats:{psMs:2,lsofMs:3,lsofCalls:1,cacheSize:0}}));
  const preview=vi.fn(async (_usage: Extract<Input,{type:'usage'}>)=>[] as Effect[]);
  const commit=vi.fn(async (_usage: Extract<Input,{type:'usage'}>, _verified:Set<string>)=>{});
  const warn=vi.fn();
  const canonical=vi.fn(async (path: string)=>path==='/alias'?'/repo':path);
  const rpc=vi.fn(async (_args:any):Promise<any>=>[]);
  const sdk=new Proxy(host.bb.sdk, {get(target, key) { return key === 'plugins' ? {callRpc:rpc} : Reflect.get(target, key); }});
  const watcher=createWatcher({sdk,hostId:()=> 'local',enabled:()=>enabled,now:()=>now,realpath:canonical as any,collector:{sample},preview,commit,warn});
  return {watcher,sdk,rpc,sample,preview,commit,warn,list,get,env,threads,paths,statuses,canonical,advance:(ms=30000)=>now+=ms,off:()=>enabled=false};
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
it('SDK errors and collector failures do not stop later runs',async()=>{
  const h=setup(); h.list.mockRejectedValueOnce(new Error('SDK unavailable'));
  await h.watcher.run(); expect(h.commit.mock.calls[0][0].valid).toBe(false);
  h.advance(); await h.watcher.run(); expect(h.commit.mock.calls[1][0].valid).toBe(true);
  h.sample.mockRejectedValueOnce(new Error('collector failed')); h.advance(); await h.watcher.run(); expect(h.commit.mock.calls[2][0].valid).toBe(false);
  h.advance(); await h.watcher.run(); expect(h.commit.mock.calls[3][0].valid).toBe(true);
});
it('notification delivery is deadline-bounded and an aborted run cannot stop the next run',async()=>{
  vi.useFakeTimers(); const h=setup(); h.commit.mockImplementationOnce(()=>new Promise(()=>{}));
  const run=h.watcher.run(); await vi.advanceTimersByTimeAsync(20000); await run;
  expect(h.warn).toHaveBeenCalled(); h.advance(); await h.watcher.run(); expect(h.sample).toHaveBeenCalledTimes(2);
});
it.each(['destroyed','creating','provisioning','error','no-environment','null-path','ENOENT','ENOTDIR'])('skips a %s checkout while healthy groups stay valid and attributed',async kind=>{
  const h=setup();
  h.threads.set('stale',makeThreadResponse({id:'stale',environmentId:kind==='no-environment'?null:'stale'}));
  h.paths.stale=kind==='null-path'?null:'/removed';
  h.statuses.stale=['destroyed','creating','provisioning','error'].includes(kind)?kind:'ready';
  h.canonical.mockImplementation(async path=>{
    if(path==='/removed') throw Object.assign(new Error('worktree removed'),{code:kind});
    return path==='/alias'?'/repo':path;
  });
  await h.watcher.run();
  expect(h.commit.mock.calls[0][0]).toMatchObject({valid:true,subjects:[{key:'/repo/sub',threadIds:['nested'],cores:3},{key:'/repo',threadIds:['a','b'],cores:2}]});
  expect(h.warn).not.toHaveBeenCalled();
});
it.each(['destroyed','no-environment','null-path','ENOENT','ENOTDIR'])('rejects alert verification when a thread becomes %s without invalidating healthy sampling',async kind=>{
  const h=setup(); await h.watcher.run();
  const subject={key:'/repo',threadIds:['a','b'],cores:5};
  h.preview.mockResolvedValue([{type:'notify',reason:'unleased-load',threadId:'observer',text:'load',watch:{hostId:'local',subject}}]);
  if(kind==='destroyed') h.statuses.a='destroyed';
  else if(kind==='no-environment') h.threads.set('a',makeThreadResponse({id:'a',environmentId:null}));
  else if(kind==='null-path') h.paths.a=null;
  else h.canonical.mockImplementation(async path=>{if(path==='/alias') throw Object.assign(new Error('removed'),{code:kind});return path;});
  h.advance(); await h.watcher.run();
  expect(h.commit.mock.calls[1][0]).toMatchObject({valid:true,resetKeys:['/repo']});
  expect(h.commit.mock.calls[1][1].size).toBe(0);
  expect(h.warn).not.toHaveBeenCalled();
});
it('environment SDK failures still invalidate the whole interval, including an SDK ENOENT',async()=>{
  const h=setup(); h.env.mockRejectedValueOnce(Object.assign(new Error('SDK failed'),{code:'ENOENT'}));
  await h.watcher.run();
  expect(h.commit.mock.calls[0][0].valid).toBe(false); expect(h.warn).toHaveBeenCalled();
});
it('other realpath errors still invalidate the interval',async()=>{
  const h=setup(); h.canonical.mockRejectedValueOnce(Object.assign(new Error('denied'),{code:'EACCES'}));
  await h.watcher.run();
  expect(h.commit.mock.calls[0][0].valid).toBe(false); expect(h.warn).toHaveBeenCalled();
});

it('limits ancestry and handles cycles in the live thread map',async()=>{
  const h=setup();
  for(let i=0;i<6;i++) h.threads.set(`x${i}`,makeThreadResponse({id:`x${i}`,environmentId:i===0?'x0':null,parentThreadId:`x${(i+1)%6}`}));
  h.paths.x0='/child'; await h.watcher.run();
  expect(h.commit.mock.calls[0][0].subjects.find(s=>s.key==='/child')?.ancestorThreadIds).toEqual(['x1','x2','x3','x4']);
});
it.each(['ready','stopped','expired','remote','failure'])('checks family browser sessions: %s',async kind=>{
  const h=setup(); h.threads.set('nested',makeThreadResponse({id:'nested',environmentId:'nested',parentThreadId:'a'}));
  const rpc=h.rpc.mockImplementation(async ({input}:any)=>{
    if(kind==='failure') throw new Error('missing');
    return input.threadId==='nested' ? [{id:'s',threadId:'nested',hostId:kind==='remote'?'remote':'local',backend:'local',state:kind==='stopped'?'stopped':'ready',createdAt:0,expiresAt:kind==='expired'?0:999999}] as any : [] as any;
  });
  await h.watcher.run();
  const subject={key:'/repo',threadIds:['a','b'],cores:0};
  h.preview.mockResolvedValue([{type:'notify',reason:'idle-lease',threadId:'observer',text:'idle',watch:{hostId:'local',subject,holderThreadId:'a'}}]);
  h.advance(); await h.watcher.run();
  expect(h.commit.mock.calls[1][1].has('/repo\0a')).toBe(kind!=='ready');
  expect(h.commit.mock.calls[1][0].resetKeys?.includes('/repo')).toBe(kind==='ready');
  expect(rpc).toHaveBeenCalled(); if(kind==='failure') expect(h.warn).toHaveBeenCalledTimes(1);
});
