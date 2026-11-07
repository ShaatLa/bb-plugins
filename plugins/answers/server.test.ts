import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin, { INSTRUCTIONS } from './server';
import { ITEMS_TAG, COUNTS_TAG, inputs, rpcContract } from './contract';
import { createDriver } from './driver';
import { migrations } from './schema';
import Database from 'better-sqlite3';
const cleanup: (()=>Promise<void>)[]=[];
afterEach(async()=>{for (const dispose of cleanup.splice(0)) await dispose(); vi.useRealTimers();});
function setup(send = vi.fn(async (_args:unknown)=>({ok:true as const,delivery:'sent' as const}))) {
 const host=createFakePluginHost({pluginId:'answers',sdk:{threads:{list:async()=>[],get:async({threadId})=>makeThreadResponse({id:threadId,projectId:'p',title:'Thread title'}),events:{list:async()=>[]},send},projects:{list:async()=>[]}}});
 plugin(host.bb); cleanup.push(()=>host.harness.lifecycle.dispose());
 return {...host,db:host.bb.storage.database(),send};
}
function seed(db:Database.Database,id='ans_one',kind='for_me',thread='t') {
 db.prepare("INSERT INTO items(id,kind,thread_id,status,question,created_at,updated_at) VALUES (?,?,?,?,?,1,1)").run(id,kind,thread,kind==='mine'?'waiting':kind==='saved'?'saved':'open','Question');
}
const deferred=<T>()=>{let resolve!:(v:T)=>void; const promise=new Promise<T>(r=>resolve=r); return {promise,resolve};};
describe('server',()=>{
 it('validates every RPC boundary and tags both reads',async()=>{
  const {harness}=setup();
  for (const [name,input] of Object.entries({list:{view:'wrong'},counts:{extra:1},markRead:{ids:['bad']},setPinned:{id:'ans_a',pinned:1},setDismissed:{id:'bad',dismissed:true},reply:{id:'ans_a',text:'x'.repeat(8001)},save:{threadId:'t',seq:-1,role:'user',text:'x'}})) await expect(harness.behavior.callRpc(name,input)).rejects.toThrow();
  expect(inputs.list.safeParse({view:'all',limit:51}).success).toBe(false);
  expect(inputs.reply.safeParse({id:'ans_a',text:' '}).success).toBe(false);
  expect(rpcContract.list.tags).toBeDefined(); expect(rpcContract.counts.tags).toBeDefined();
  expect(INSTRUCTIONS.length).toBeLessThanOrEqual(600);
 });
 it('lists with filters, stable pagination, titles, counts and orthogonal flags',async()=>{
  const {harness,db}=setup();
  harness.sdk.stub('threads.list',async()=>[makeThreadResponse({id:'t',title:'Thread title'})]);
  seed(db,'ans_a','mine'); seed(db,'ans_b','mine'); seed(db,'ans_c');
  db.prepare("UPDATE items SET status='answered',answer='answer' WHERE id IN ('ans_a','ans_b')").run();
  const first=await harness.behavior.callRpc('list',{view:'unread',limit:1}) as any;
  expect(first.items[0]).toMatchObject({id:'ans_b',threadTitle:'Thread title'});
  const next=await harness.behavior.callRpc('list',{view:'unread',limit:1,cursor:first.nextCursor}) as any;
  expect(next.items[0].id).toBe('ans_a'); expect(next.nextCursor).toBeNull();
  expect(await harness.behavior.callRpc('counts',{})).toEqual({unread:2,waiting:0,forMe:1});
  await harness.behavior.callRpc('setDismissed',{id:'ans_b',dismissed:true});
  await harness.behavior.callRpc('setPinned',{id:'ans_b',pinned:true});
  expect((await harness.behavior.callRpc('list',{view:'pinned'}) as any).items).toHaveLength(1);
  await harness.behavior.callRpc('markRead',{all:true,threadId:'other'});
  expect((await harness.behavior.callRpc('counts',{}) as any).unread).toBe(1);
  await harness.behavior.callRpc('markRead',{ids:['ans_a']});
  expect(await harness.behavior.callRpc('counts',{})).toEqual({unread:0,waiting:0,forMe:1});
  expect(db.prepare("SELECT status FROM items WHERE id='ans_b'").get()).toEqual({status:'answered'});
 });
 it('checks calling thread and kind for id-taking tools and requires an active turn',async()=>{
  const {harness,db}=setup(); seed(db,'ans_mine','mine','t'); seed(db,'ans_saved','saved','t');
  const call=(name:string,p:object,threadId='t')=>harness.behavior.callAgentTool(name,p,{threadId,projectId:'p'});
  for (const method of ['defer','resolve']) {
    await expect(call('answers_'+method,{id:'ans_mine'},'other')).rejects.toThrow('calling thread');
    await expect(call('answers_'+method,{id:'ans_saved'})).rejects.toThrow('calling thread');
  }
  await expect(call('answers_resolve',{id:'ans_mine'})).rejects.toThrow('no active turn');
  await call('answers_defer',{note:'later'});
  expect(db.prepare("SELECT status,note FROM items WHERE id='ans_mine'").get()).toEqual({status:'deferred',note:'later'});
  db.prepare("UPDATE threads_state SET active_turn_id='turn' WHERE thread_id='t'").run();
  await call('answers_resolve',{id:'ans_mine'});
  expect(db.prepare("SELECT resolve_turn_id FROM items WHERE id='ans_mine'").get()).toEqual({resolve_turn_id:'turn'});
  const list=await call('answers_list',{}); expect(String(list)).toContain('ans_mine'); expect(String(list).length).toBeLessThanOrEqual(2000);
  const id=await call('answers_ask',{question:'Small question'});
  expect(db.prepare('SELECT kind,status FROM items WHERE id=?').get(id)).toEqual({kind:'for_me',status:'open'});
 });
 it('rejects concurrent and second for_me replies, exposing queued delivery',async()=>{
  const gate=deferred<{ok:true;delivery:'queued'}>(); const entered=deferred<void>();
  const send=vi.fn(async(_args:unknown)=>{entered.resolve(); return gate.promise;});
  const {harness,db}=setup(send as any); seed(db);
  const first=harness.behavior.callRpc('reply',{id:'ans_one',text:'response'}); await entered.promise;
  await expect(harness.behavior.callRpc('reply',{id:'ans_one',text:'duplicate'})).rejects.toThrow('in flight');
  expect(db.prepare('SELECT status FROM items').get()).toEqual({status:'open'});
  gate.resolve({ok:true,delivery:'queued'}); expect(await first).toEqual({delivery:'queued'});
  await expect(harness.behavior.callRpc('reply',{id:'ans_one',text:'duplicate'})).rejects.toThrow('already replied');
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0]).toMatchObject({threadId:'t',mode:'auto',input:[{type:'text',text:'Re: "Question"\n\nresponse',mentions:[]}]});
 });
 it('leaves a failed send open, releases its guard and never retries automatically',async()=>{
  const send=vi.fn(async()=>{throw new Error('network');}); const {harness,db}=setup(send); seed(db);
  await expect(harness.behavior.callRpc('reply',{id:'ans_one',text:'reply'})).rejects.toThrow('Delivery uncertain');
  expect(db.prepare('SELECT status,answer FROM items').get()).toEqual({status:'open',answer:null}); expect(send).toHaveBeenCalledTimes(1);
  await expect(harness.behavior.callRpc('reply',{id:'ans_one',text:'retry'})).rejects.toThrow('Delivery uncertain'); expect(send).toHaveBeenCalledTimes(2);
 });
 it('mine reply is a follow-up and never changes status',async()=>{
  const {harness,db}=setup(); seed(db,'ans_one','mine');
  await harness.behavior.callRpc('reply',{id:'ans_one',text:'follow up'});
  expect(db.prepare('SELECT status FROM items').get()).toEqual({status:'waiting'});
 });
 it('deduplicates saved text and deletion preserves saved items',async()=>{
  const {harness,db}=setup(); seed(db,'ans_mine','mine'); seed(db,'ans_open');
  const input={threadId:'t',seq:50,role:'assistant',text:'saved text'};
  const saved=await harness.behavior.callRpc('save',input);
  expect(await harness.behavior.callRpc('save',input)).toEqual(saved);
  await harness.behavior.callAgentTool('answers_list',{}, {threadId:'t'});
  const result=await harness.behavior.emitThreadEvent('thread.deleted',{thread:makeThreadResponse({id:'t'})}); expect(result.errors).toEqual([]);
  expect(db.prepare('SELECT kind,thread_deleted FROM items').all()).toEqual([{kind:'saved',thread_deleted:1}]);
  expect(db.prepare('SELECT * FROM threads_state').all()).toEqual([]);
  expect(db.prepare('SELECT * FROM request_aliases').all()).toEqual([]);
 });
 it('invalidates after committed RPC/tool/ingestion/deletion writes',async()=>{
  const {harness,db}=setup(); seed(db);
  const seen:string[]=[];
  const off=harness.inspection.experimental_onRpcInvalidation(()=>{seen.push((db.prepare("SELECT status FROM items WHERE id='ans_one'").get() as any)?.status ?? 'deleted');});
  await harness.behavior.callRpc('reply',{id:'ans_one',text:'yes'}); expect(seen.at(-1)).toBe('replied');
  await harness.behavior.callAgentTool('answers_ask',{question:'hello'},{threadId:'t'});
  await harness.behavior.emitThreadEvent('thread.deleted',{thread:makeThreadResponse({id:'t'})});
  expect(seen.at(-1)).toBe('deleted');
  expect(harness.inspection.experimental_rpcInvalidations.every(tags=>JSON.stringify(tags)===JSON.stringify([ITEMS_TAG,COUNTS_TAG]))).toBe(true); off();
 });
 it('provides list/read/status CLI commands',async()=>{
  const {harness,db}=setup(); seed(db,'ans_one','mine'); db.prepare("UPDATE items SET status='answered'").run();
  const list=await harness.behavior.runCli(['list','--json']); expect(list.exitCode).toBe(0); expect(JSON.parse(list.stdout).items).toHaveLength(1);
  expect((await harness.behavior.runCli(['read','ans_one'])).exitCode).toBe(0);
  expect((await harness.behavior.runCli(['read','--all','--thread','t'])).exitCode).toBe(0);
  expect((await harness.behavior.runCli(['status'])).stdout).toContain('trackedThreads');
 });
});

describe('ingestion driver',()=>{
 function driverSetup() {
  const host=createFakePluginHost({pluginId:'answers',sdk:{threads:{get:async({threadId})=>makeThreadResponse({id:threadId,projectId:'p'}),list:async()=>[],events:{list:async()=>[]}}}});
  const db=host.bb.storage.database(); db.exec(migrations[0]); const invalidate=vi.fn();
  const driver=createDriver(host.bb,db,invalidate);
  cleanup.push(async()=>{await driver.dispose(); await host.harness.lifecycle.dispose();});
  return {...host,db,driver,invalidate};
 }
 it('backfills descending pages then drains ascending, halving 413 pages at the same cursor',async()=>{
  const {harness,db,driver,invalidate}=driverSetup();
  const calls:any[]=[];
  harness.sdk.stub('threads.events.list',async(args:any)=>{
   calls.push(args);
   if (args.order==='desc' && args.limit==='500') throw {status:413};
   if (args.order==='desc') return [{seq:100,type:'client/turn/requested',createdAt:123,data:{initiator:'user',requestId:'r',input:[{type:'text',text:'question'}]},scope:{kind:'thread'}}];
   return [];
  });
  await driver.schedule('t');
  expect(calls.map(c=>[c.order,c.limit,c.afterSeq])).toEqual([['desc','500',undefined],['desc','250',undefined],['asc','200','100']]);
  expect(calls.every(c=>c.types.length===5)).toBe(true);
  expect(db.prepare('SELECT last_seq FROM threads_state').get()).toEqual({last_seq:100});
  expect(db.prepare('SELECT project_id,created_at FROM items').get()).toEqual({project_id:'p',created_at:123});
  expect(invalidate).toHaveBeenCalled();
 });
 it('persists oversized errors without moving the cursor and retries without another event',async()=>{
  vi.useFakeTimers(); const {harness,db,driver}=driverSetup();
  db.prepare("INSERT INTO threads_state(thread_id,last_seq,updated_at) VALUES ('t',42,0)").run();
  let fail=true; const limits:string[]=[];
  harness.sdk.stub('threads.events.list',async(args:any)=>{limits.push(args.limit); if(fail) throw {status:413}; return [];});
  await expect(driver.schedule('t')).rejects.toThrow('oversized event after seq 42');
  expect(limits).toEqual(['200','100','50','25','12','6','3','1']);
  expect(db.prepare('SELECT last_seq,last_error FROM threads_state').get()).toMatchObject({last_seq:42,last_error:'Error: oversized event after seq 42'});
  fail=false; await vi.advanceTimersByTimeAsync(30000);
  expect(limits.at(-1)).toBe('200'); expect(db.prepare('SELECT last_error FROM threads_state').get()).toEqual({last_error:null});
 });
 it('coalesces triggers and limits drains to two globally',async()=>{
  const {harness,driver}=driverSetup();
  const gates=[deferred<void>(),deferred<void>()]; const both=deferred<void>();
  let active=0,max=0,started=0;
  const calls:string[]=[];
  harness.sdk.stub('threads.events.list',async(args:any)=>{
   if(args.order==='desc') return [];
   calls.push(args.threadId); active++; max=Math.max(max,active);
   const index=started++; if(started===2) both.resolve();
   if(index<2) await gates[index].promise;
   active--; return [];
  });
  const a=driver.schedule('a'), b=driver.schedule('b'), c=driver.schedule('c');
  await both.promise;
  driver.schedule('a'); driver.schedule('a');
  expect(max).toBe(2); gates.forEach(g=>g.resolve());
  await Promise.all([a,b,c]);
  expect(max).toBe(2); expect(calls.filter(id=>id==='a')).toHaveLength(2);
 });
 it('waits for an in-flight drain before deleting and refuses tools for missing threads',async()=>{
  const {harness,db,driver}=driverSetup(); const entered=deferred<void>(), gate=deferred<void>();
  seed(db,'ans_mine','mine'); seed(db,'ans_saved','saved');
  let missing=false;
  harness.sdk.stub('threads.get',async()=>{if(missing) throw {status:404}; return makeThreadResponse({id:'t'});});
  harness.sdk.stub('threads.events.list',async()=>{entered.resolve(); await gate.promise; return [];});
  const drain=driver.schedule('t'); await entered.promise;
  const deletion=driver.deleteThread('t');
  expect(db.prepare('SELECT count(*) AS n FROM items').get()).toEqual({n:2});
  gate.resolve(); await drain; await deletion;
  expect(db.prepare('SELECT kind,thread_deleted FROM items').all()).toEqual([{kind:'saved',thread_deleted:1}]);
  missing=true;
  await expect(driver.withThread('t',()=>{throw new Error('must not mutate');})).rejects.toThrow('thread not found');
 });
 it('confirms omitted tracked threads and preserves data on transient get failures',async()=>{
  const {harness,db,driver}=driverSetup();
  for(const id of ['deleted','transient','hidden']) {seed(db,'ans_'+id,'mine',id); db.prepare('INSERT INTO threads_state(thread_id,last_seq,updated_at) VALUES (?,1,0)').run(id);}
  harness.sdk.stub('threads.list',async(args:any)=>args.threadIds ? [makeThreadResponse({id:'hidden'})] : []);
  harness.sdk.stub('threads.get',async({threadId}:any)=>{if(threadId==='deleted') throw {status:404}; if(threadId==='transient') throw {status:503}; return makeThreadResponse({id:threadId});});
  await driver.reconcile();
  expect(db.prepare('SELECT thread_id FROM items ORDER BY thread_id').all()).toEqual([{thread_id:'hidden'},{thread_id:'transient'}]);
  const calls=harness.inspection.sdk.callsTo('threads.list'); expect(calls.length).toBe(2);
 });
 it('discovers only recent threads and stops after five pages',async()=>{
  const {harness,db,driver}=driverSetup(); let pages=0;
  harness.sdk.stub('threads.list',async(args:any)=>{pages++; return Array.from({length:200},(_,i)=>makeThreadResponse({id:`t${args.offset+i}`,updatedAt: i===0 ? Date.now() : 0}));});
  await driver.reconcile(); expect(pages).toBe(5);
  expect(db.prepare('SELECT count(*) AS n FROM threads_state').get()).toEqual({n:5});
 });
});
