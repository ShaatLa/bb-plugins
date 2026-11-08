import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin, { INSTRUCTIONS, buildReplyMessage } from './server';
import { ITEMS_TAG, COUNTS_TAG, POOLS_TAG, inputs, rpcContract } from './contract';
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
  expect(await harness.behavior.callRpc('counts',{})).toEqual({unread:2,waiting:0,forMe:1,inbox:3});
  await harness.behavior.callRpc('setDismissed',{id:'ans_b',dismissed:true});
  await harness.behavior.callRpc('setPinned',{id:'ans_b',pinned:true});
  expect((await harness.behavior.callRpc('list',{view:'pinned'}) as any).items).toHaveLength(1);
  await harness.behavior.callRpc('markRead',{all:true,threadId:'other'});
  expect((await harness.behavior.callRpc('counts',{}) as any).unread).toBe(1);
  await harness.behavior.callRpc('markRead',{ids:['ans_a']});
  expect(await harness.behavior.callRpc('counts',{})).toEqual({unread:0,waiting:0,forMe:1,inbox:1});
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
  await expect(harness.behavior.callRpc('reply',{id:'ans_one',text:'duplicate'})).rejects.toThrow('already sending');
  expect(db.prepare('SELECT status FROM items').get()).toEqual({status:'open'});
  gate.resolve({ok:true,delivery:'queued'}); expect(await first).toEqual({delivery:'queued'});
  await expect(harness.behavior.callRpc('reply',{id:'ans_one',text:'duplicate'})).rejects.toThrow('already replied');
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0]).toMatchObject({threadId:'t',mode:'queue-if-active',input:[{type:'text',text:'Re: "Question"\n\nresponse',mentions:[]}]});
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
  expect(harness.inspection.experimental_rpcInvalidations.every(tags=>JSON.stringify(tags)===JSON.stringify([ITEMS_TAG,COUNTS_TAG]) || JSON.stringify(tags)===JSON.stringify([POOLS_TAG]))).toBe(true); off();
 });
 it('provides list/read/status CLI commands',async()=>{
  const {harness,db}=setup(); seed(db,'ans_one','mine'); db.prepare("UPDATE items SET status='answered'").run();
  const list=await harness.behavior.runCli(['list','--json']); expect(list.exitCode).toBe(0); expect(JSON.parse(list.stdout).items).toHaveLength(1);
  expect((await harness.behavior.runCli(['read','ans_one'])).exitCode).toBe(0);
  expect((await harness.behavior.runCli(['read','--all','--thread','t'])).exitCode).toBe(0);
  expect((await harness.behavior.runCli(['status'])).stdout).toContain('trackedThreads');
 });
});

describe('reply pools and inbox',()=>{
 it('appends migration 2 without changing existing items',()=>{
  const db=new Database(':memory:'); db.exec(migrations[0]); seed(db); db.exec(migrations[1]);
  expect(db.prepare('SELECT question FROM items').get()).toEqual({question:'Question'});
  expect(db.prepare('SELECT * FROM pool_entries').all()).toEqual([]); db.close();
 });
 it('builds exact Markdown, with empty lines and notes, and enforces caps',()=>{
  expect(buildReplyMessage([{quote:'**bold**\n\nlast',note:'note'},{quote:'only',note:''}])).toBe('> **bold**\n>\n> last\n\nnote\n\n> only');
  expect(()=>buildReplyMessage([{quote:'x'.repeat(20001),note:''}])).toThrow('20,000');
  expect(()=>buildReplyMessage([{quote:'x'.repeat(20000),note:'x'.repeat(12000)}])).toThrow('32,000');
 });
 it('groups unread recipients, orders them, keeps selected, and reads only inbox kinds',async()=>{
  const {harness,db}=setup(); seed(db,'ans_a','mine','a'); seed(db,'ans_b','for_me','b'); seed(db,'ans_c','for_me','b'); seed(db,'ans_wait','mine','b'); seed(db,'ans_save','saved','b');
  db.prepare("UPDATE items SET status='answered',answer=?,updated_at=10 WHERE id='ans_a'").run('x'.repeat(200));
  db.prepare("UPDATE items SET updated_at=20 WHERE id='ans_b'").run();
  const call=(name:string,p:object={})=>harness.behavior.callRpc(name,p) as Promise<any>;
  expect(await call('counts')).toMatchObject({inbox:3});
  const recipients=(await call('recipients')).recipients;
  expect(recipients.map((r:any)=>[r.threadId,r.unread,r.lastAt])).toEqual([['b',2,20],['a',1,10]]);
  expect(recipients[1].preview).toHaveLength(160);
  await call('markThreadRead',{threadId:'b'});
  expect((await call('counts')).inbox).toBe(1);
  expect((await call('recipients')).recipients.map((r:any)=>r.threadId)).toEqual(['a']);
  expect((await call('recipients',{selected:'b'})).recipients.find((r:any)=>r.threadId==='b').unread).toBe(0);
  expect(db.prepare("SELECT read_at FROM items WHERE id IN ('ans_wait','ans_save')").all()).toEqual([{read_at:null},{read_at:null}]);
 });
 it('validates pool CRUD, revisions, ordering, missing threads and tags',async()=>{
  const {harness,db}=setup();
  harness.sdk.stub('threads.list',async()=>[makeThreadResponse({id:'a',title:'A',projectId:'p'}),makeThreadResponse({id:'b',title:'B',projectId:'p'})]);
  const call=(name:string,p:object={})=>harness.behavior.callRpc(name,p) as Promise<any>;
  const a=await call('poolAdd',{threadId:'a',quote:'a',quoteSeq:4});
  const b=await call('poolAdd',{threadId:'b',quote:'b'});
  db.prepare('UPDATE pool_entries SET created_at=1 WHERE id=?').run(a.id); db.prepare('UPDATE pool_entries SET created_at=2 WHERE id=?').run(b.id);
  const pools=(await call('pools')).pools; expect(pools.map((p:any)=>p.threadId)).toEqual(['a','b']);
  expect(pools[0]).toMatchObject({threadTitle:'A',projectId:'p',entries:[{revision:0,quoteSeq:4,note:''}]});
  expect(await call('poolUpdate',{id:a.id,note:'edit',revision:0})).toEqual({revision:1});
  await expect(call('poolUpdate',{id:a.id,note:'stale',revision:0})).rejects.toThrow('changed');
  await expect(call('poolAdd',{threadId:'a',quote:'x'.repeat(20001)})).rejects.toThrow('validation');
  expect(()=>inputs.poolAdd.parse({threadId:'a',quote:'x'.repeat(20001)})).toThrow('20,000');
  await call('poolRemove',a); expect((await call('pools')).pools).toHaveLength(1);
  harness.sdk.stub('threads.get',async()=>{throw {status:404};});
  await expect(call('poolAdd',{threadId:'missing',quote:'x'})).rejects.toBeDefined();
  expect(harness.inspection.experimental_rpcInvalidations.some(tags=>tags?.includes(POOLS_TAG))).toBe(true);
  expect(rpcContract.pools.tags).toBeDefined(); expect(rpcContract.recipients.tags).toBeDefined();
 });
 it('snapshots revisions, keeps edited and newly added entries, and commits linkage with deletes',async()=>{
  const gate=deferred<{ok:true;delivery:'queued'}>(),entered=deferred<void>();
  const {harness,db,send}=setup(vi.fn(async()=>{entered.resolve(); return gate.promise;}) as any); seed(db);
  const call=(name:string,p:object)=>harness.behavior.callRpc(name,p) as Promise<any>;
  const a=await call('poolAdd',{threadId:'t',quote:'a',note:'first',itemId:'ans_one'});
  const b=await call('poolAdd',{threadId:'t',quote:'b',note:'second',itemId:'ans_one'});
  db.prepare('UPDATE pool_entries SET created_at=1 WHERE id=?').run(a.id); db.prepare('UPDATE pool_entries SET created_at=2 WHERE id=?').run(b.id);
  const pending=call('poolSend',{threadId:'t'}); await entered.promise;
  await call('poolUpdate',{id:a.id,note:'edited',revision:0});
  const c=await call('poolAdd',{threadId:'t',quote:'new'});
  await expect(call('reply',{id:'ans_one',text:'duplicate'})).rejects.toThrow('already sending');
  await expect(call('quoteReply',{threadId:'t',quote:'q',text:'duplicate'})).rejects.toThrow('already sending');
  await expect(call('poolSend',{threadId:'t'})).rejects.toThrow('already sending');
  expect(db.prepare('SELECT status FROM items').get()).toEqual({status:'open'});
  const observations:any[]=[];
  const off=harness.inspection.experimental_onRpcInvalidation(()=>observations.push({item:db.prepare('SELECT status,answer FROM items').get(),rows:db.prepare('SELECT id FROM pool_entries ORDER BY created_at,id').all()}));
  gate.resolve({ok:true,delivery:'queued'});
  expect(await pending).toEqual({delivery:'queued',sent:2,keptEdited:1}); off();
  expect(send.mock.calls[0][0]).toMatchObject({input:[{text:'> a\n\nfirst\n\n> b\n\nsecond'}]});
  expect(observations).toHaveLength(2);
  for (const state of observations) {expect(state.item).toEqual({status:'replied',answer:'first\n\nsecond'}); expect(state.rows.map((r:any)=>r.id)).toEqual([a.id,c.id]);}
 });
 it('forwards attachments on quote replies and pooled sends',async()=>{
  const {harness,send}=setup(vi.fn(async()=>({ok:true,delivery:'sent'})));
  const call=(name:string,p:object)=>harness.behavior.callRpc(name,p) as Promise<any>;
  const img={type:'localImage',path:'.bb/attachments/a.png',name:'a.png',mimeType:'image/png',sizeBytes:3};
  const doc={type:'localFile',path:'.bb/attachments/b.txt',name:'b.txt',sizeBytes:5,sourceProjectId:'p'};
  await call('quoteReply',{threadId:'t',quote:'q',text:'see file',attachments:[doc]});
  expect((send.mock.calls[0] as any[])[0].input).toEqual([{type:'text',mentions:[],text:'> q\n\nsee file'},{type:'localFile',path:doc.path,name:'b.txt',sizeBytes:5,sourceProjectId:'p'}]);
  await call('poolAdd',{threadId:'t',quote:'one',attachments:[img]}); await call('poolAdd',{threadId:'t',quote:'two',attachments:[doc]});
  expect((await call('pools',{})).pools[0].entries.map((e:any)=>e.attachments)).toEqual([[img],[doc]]);
  await call('poolSend',{threadId:'t'});
  expect((send.mock.calls[1] as any[])[0].input.slice(1)).toEqual([{type:'localImage',path:img.path},{type:'localFile',path:doc.path,name:'b.txt',sizeBytes:5,sourceProjectId:'p'}]);
  await expect(call('quoteReply',{threadId:'t',quote:'q',text:'',attachments:Array(11).fill(doc)})).rejects.toBeDefined();
 });
 it('keeps failed sends, never retries, and checks total size before sending',async()=>{
  const {harness,db,send}=setup(vi.fn(async()=>{throw new Error('network');}));
  const call=(name:string,p:object)=>harness.behavior.callRpc(name,p) as Promise<any>;
  await call('poolAdd',{threadId:'t',quote:'q'});
  await expect(call('poolSend',{threadId:'t'})).rejects.toThrow('Delivery uncertain');
  expect(db.prepare('SELECT count(*) n FROM pool_entries').get()).toEqual({n:1}); expect(send).toHaveBeenCalledTimes(1);
  await call('poolAdd',{threadId:'t',quote:'x'.repeat(20000),note:'x'.repeat(8000)});
  await call('poolAdd',{threadId:'t',quote:'x'.repeat(5000)});
  await expect(call('poolSend',{threadId:'t'})).rejects.toThrow('32,000'); expect(send).toHaveBeenCalledTimes(1);
 });
 it('links quote replies, allows follow-ups, uses quotes for empty notes and checks sources',async()=>{
  const {harness,db}=setup(); seed(db); seed(db,'ans_other','for_me','other');
  const call=(name:string,p:object)=>harness.behavior.callRpc(name,p) as Promise<any>;
  await expect(call('quoteReply',{threadId:'t',quote:'q',text:'',itemId:'ans_other'})).rejects.toThrow('this thread');
  await call('quoteReply',{threadId:'t',quote:'q',text:'',itemId:'ans_one'});
  expect(db.prepare("SELECT status,answer,answer_source FROM items WHERE id='ans_one'").get()).toEqual({status:'replied',answer:'q',answer_source:'user'});
  await call('quoteReply',{threadId:'t',quote:'q',text:'follow-up',itemId:'ans_one'});
  expect(db.prepare("SELECT answer FROM items WHERE id='ans_one'").get()).toEqual({answer:'q'});
  await call('poolAdd',{threadId:'other',quote:'one',itemId:'ans_other'}); await call('poolAdd',{threadId:'other',quote:'two',itemId:'ans_other'});
  await call('poolSend',{threadId:'other'});
  expect(db.prepare("SELECT answer FROM items WHERE id='ans_other'").get()).toEqual({answer:'one\n\ntwo'});
 });
 it('shares guard when reply starts first, including another item in the thread',async()=>{
  const gate=deferred<{ok:true;delivery:'sent'}>(),entered=deferred<void>();
  const {harness,db}=setup(vi.fn(async()=>{entered.resolve();return gate.promise;}) as any);seed(db);seed(db,'ans_two');
  const call=(name:string,p:object)=>harness.behavior.callRpc(name,p);
  const first=call('reply',{id:'ans_one',text:'yes'});await entered.promise;
  for(const [name,p] of [['reply',{id:'ans_two',text:'yes'}],['quoteReply',{threadId:'t',quote:'q',text:''}],['poolSend',{threadId:'t'}]] as const) await expect(call(name,p)).rejects.toThrow('already sending');
  gate.resolve({ok:true,delivery:'sent'});await first;
 });
 it('removes pools on deletion and authoritative removal even for pool-only threads',async()=>{
  const {harness,db,bb}=setup();
  await harness.behavior.callRpc('poolAdd',{threadId:'t',quote:'q'});
  await harness.behavior.emitThreadEvent('thread.deleted',{thread:makeThreadResponse({id:'t'})});
  expect(db.prepare('SELECT * FROM pool_entries').all()).toEqual([]);
  await harness.behavior.callRpc('poolAdd',{threadId:'other',quote:'q'});
  harness.sdk.stub('threads.get',async()=>{throw {status:404};});
  const driver=createDriver(bb,db,()=>{});
  await driver.reconcile(); await driver.dispose();
  expect(db.prepare('SELECT * FROM pool_entries').all()).toEqual([]);
 });
});

describe('ingestion driver',()=>{
 function driverSetup() {
  const host=createFakePluginHost({pluginId:'answers',sdk:{threads:{get:async({threadId})=>makeThreadResponse({id:threadId,projectId:'p'}),list:async()=>[],events:{list:async()=>[]}}}});
  const db=host.bb.storage.database(); db.exec(migrations.join("\n")); const invalidate=vi.fn();
  const driver=createDriver(host.bb,db,invalidate);
  cleanup.push(async()=>{await driver.dispose(); await host.harness.lifecycle.dispose();});
  return {...host,db,driver,invalidate};
 }
 it('backfills descending pages then drains ascending, halving 413 pages at the same cursor',async()=>{
  const {harness,db,driver,invalidate}=driverSetup();
  const calls:any[]=[];
  harness.sdk.stub('threads.events.list',async(args:any)=>{
   calls.push(args);
   if (args.order==='desc' && args.limit==='100') throw {status:413};
   if (args.order==='desc') return [{seq:100,type:'client/turn/requested',createdAt:123,data:{initiator:'user',requestId:'r',input:[{type:'text',text:'question'}]},scope:{kind:'thread'}}];
   return [];
  });
  await driver.schedule('t');
  expect(calls.map(c=>[c.order,c.limit,c.afterSeq])).toEqual([['desc','100',undefined],['desc','50',undefined],['asc','100','100']]);
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
  expect(limits).toEqual(['100','50','25','12','6','3','1']);
  expect(db.prepare('SELECT last_seq,last_error FROM threads_state').get()).toMatchObject({last_seq:42,last_error:'Error: oversized event after seq 42'});
  fail=false; await vi.advanceTimersByTimeAsync(30000);
  expect(limits.at(-1)).toBe('100'); expect(db.prepare('SELECT last_error FROM threads_state').get()).toEqual({last_error:null});
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
