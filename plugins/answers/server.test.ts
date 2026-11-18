import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin, { INSTRUCTIONS, buildReplyMessage } from './server';
import { ITEMS_TAG, COUNTS_TAG, POOLS_TAG, inputs, rpcContract } from './contract';
import { createDriver } from './driver';
import { migrations } from './schema';
import Database from 'better-sqlite3';
const cleanup: (()=>Promise<void>)[]=[];
afterEach(async()=>{for (const dispose of cleanup.splice(0)) await dispose(); vi.useRealTimers();});
function setup(send = vi.fn(async (_args:unknown)=>({ok:true as const,delivery:'sent' as const})), list:(args:any)=>Promise<any[]> = async()=>[]) {
 const host=createFakePluginHost({pluginId:'answers',sdk:{threads:{list,get:async({threadId})=>makeThreadResponse({id:threadId,projectId:'p',title:'Thread title'}),events:{list:async()=>[]},send},projects:{list:async()=>[]}}});
 plugin(host.bb); cleanup.push(()=>host.harness.lifecycle.dispose());
 return {...host,db:host.bb.storage.database(),send};
}
function seed(db:Database.Database,id='ans_one',kind='for_me',thread='t') {
 db.prepare("INSERT INTO items(id,kind,thread_id,status,question,created_at,updated_at) VALUES (?,?,?,?,?,1,1)").run(id,kind,thread,kind==='mine'?'waiting':kind==='saved'?'saved':'open','Question');
}
const deferred=<T>()=>{let resolve!:(v:T)=>void; const promise=new Promise<T>(r=>resolve=r); return {promise,resolve};};
describe('server',()=>{
 it('caches display metadata across list and recipients with independent TTLs',async()=>{
  const {harness,db}=setup(); seed(db,'ans_cache','mine');
  db.prepare("UPDATE items SET project_id='p'").run();
  const threads=vi.fn(async()=>[makeThreadResponse({id:'t',title:'T',projectId:'p'})]);
  const projects=vi.fn(async()=>[{id:'p',name:'P'}]);
  harness.sdk.stub('threads.list',threads); harness.sdk.stub('projects.list',projects as any);
  const now=vi.spyOn(Date,'now').mockReturnValue(100000);
  try {
   await harness.behavior.callRpc('list',{view:'all'}); await harness.behavior.callRpc('recipients',{});
   expect(threads).toHaveBeenCalledTimes(1); expect(projects).toHaveBeenCalledTimes(1);
   now.mockReturnValue(130001); await harness.behavior.callRpc('recipients',{});
   expect(threads).toHaveBeenCalledTimes(2); expect(projects).toHaveBeenCalledTimes(1);
   now.mockReturnValue(160001); await harness.behavior.callRpc('list',{view:'all'});
   expect(threads).toHaveBeenCalledTimes(3); expect(projects).toHaveBeenCalledTimes(2);
   db.prepare("UPDATE items SET status='answered',answer='A',answered_at=1").run();
   threads.mockImplementation(async()=>[makeThreadResponse({id:'t',lastReadAt:10})]);
   expect((await harness.behavior.callRpc('recipients',{}) as any).recipients[0].unread).toBe(0);
   expect(threads).toHaveBeenCalledTimes(4);
  } finally {now.mockRestore();}
 });
 it('clears bb\'s unread mark when a thread has nothing left unread in Answers, and restores it on undo',async()=>{
  const {harness,db}=setup(), read=vi.fn(async(_a:unknown)=>({})), unread=vi.fn(async(_a:unknown)=>({}));
  harness.sdk.stub('threads.markRead',read as any); harness.sdk.stub('threads.markUnread',unread as any);
  seed(db,'ans_x','for_me','t'); seed(db,'ans_y','for_me','t'); seed(db,'ans_z','for_me','u'); db.prepare("UPDATE items SET kind='mine',status='answered',answer='a'").run();
  await harness.behavior.callRpc('markRead',{ids:['ans_x']}); expect(read).not.toHaveBeenCalled();
  await harness.behavior.callRpc('markRead',{ids:['ans_y']}); expect(read).toHaveBeenCalledWith({threadId:'t'});
  const all=await harness.behavior.callRpc('markRead',{all:true}) as any; expect(read).toHaveBeenLastCalledWith({threadId:'u'});
  await harness.behavior.callRpc('undoRead',{batch:all.batch}); await vi.waitFor(()=>expect(unread).toHaveBeenCalledWith({threadId:'u'}));
 });
 it('marks answers read when the thread was read in bb after they arrived',async()=>{
  const {harness,db}=setup();
  seed(db,'ans_old','mine','t'); seed(db,'ans_new','mine','t');
  db.prepare("UPDATE items SET status='answered',answer='a',answered_at=? WHERE id=?").run(1000,'ans_old');
  db.prepare("UPDATE items SET status='answered',answer='b',answered_at=? WHERE id=?").run(3000,'ans_new');
  harness.sdk.stub('threads.list',async()=>[makeThreadResponse({id:'t',title:'T',lastReadAt:2000} as any)]);
  const result=await harness.behavior.callRpc('recipients',{}) as any;
  expect(result.recipients[0].unread).toBe(1);
  expect(db.prepare("SELECT id FROM items WHERE read_at IS NOT NULL").all()).toEqual([{id:'ans_old'}]);
 });
 it('does not take bb marking a thread read on a send (a queued message going out at turn end) as the owner reading it',async()=>{
  const {harness,db}=setup();
  seed(db,'ans_new','mine','t'); db.prepare("UPDATE items SET status='answered',answer='b',answered_at=? WHERE id=?").run(3000,'ans_new');
  harness.sdk.stub('threads.list',async()=>[makeThreadResponse({id:'t',title:'T',lastReadAt:5001} as any)]);
  harness.sdk.stub('threads.events.list',async()=>[{seq:9,createdAt:5000,type:'client/turn/requested',data:{initiator:'user'}}] as any);
  expect((await harness.behavior.callRpc('recipients',{}) as any).recipients[0].unread).toBe(1);
  expect(db.prepare("SELECT id FROM items WHERE read_at IS NOT NULL").all()).toEqual([]);
  // A real read in bb later still counts.
  harness.sdk.stub('threads.list',async()=>[makeThreadResponse({id:'t',title:'T',lastReadAt:9000} as any)]);
  expect((await harness.behavior.callRpc('recipients',{}) as any).recipients[0].unread).toBe(0);
 });
 it('validates every RPC boundary and tags both reads',async()=>{
  const {harness}=setup();
  for (const [name,input] of Object.entries({list:{view:'wrong'},counts:{extra:1},markRead:{ids:['bad']},setPinned:{id:'ans_a',pinned:1},setDismissed:{id:'bad',dismissed:true},reply:{id:'ans_a',text:'x'.repeat(8001)},save:{threadId:'t',seq:-1,role:'user',text:'x'}})) await expect(harness.behavior.callRpc(name,input)).rejects.toThrow();
  expect(inputs.list.safeParse({view:'all',limit:51}).success).toBe(false);
  expect(inputs.reply.safeParse({id:'ans_a',text:' '}).success).toBe(false);
  expect(rpcContract.list.tags).toBeDefined(); expect(rpcContract.counts.tags).toBeDefined();
  expect(INSTRUCTIONS.length).toBeLessThanOrEqual(600);
 });
 it('orders a conversation by latest activity, so a late answer pages in at its answer time',async()=>{
  const {harness,db}=setup();
  seed(db,'ans_q','mine'); seed(db,'ans_u','update'); seed(db,'ans_n');
  db.prepare("UPDATE items SET status='answered',answer='late',answered_at=30 WHERE id='ans_q'").run();
  db.prepare("UPDATE items SET created_at=20 WHERE id='ans_u'").run(); db.prepare("UPDATE items SET created_at=10 WHERE id='ans_n'").run();
  const first=await harness.behavior.callRpc('list',{view:'all',threadId:'t',order:'activity',limit:2}) as any;
  expect(first.items.map((i:any)=>i.id)).toEqual(['ans_q','ans_u']); expect(first.items[0]).toMatchObject({createdAt:1,answeredAt:30}); expect(first.nextCursor).toBe('20|ans_u');
  const next=await harness.behavior.callRpc('list',{view:'all',threadId:'t',order:'activity',limit:2,cursor:first.nextCursor}) as any;
  expect(next.items.map((i:any)=>i.id)).toEqual(['ans_n']); expect(next.nextCursor).toBeNull();
  expect((await harness.behavior.callRpc('list',{view:'all',threadId:'t'}) as any).items.map((i:any)=>i.id)).toEqual(['ans_u','ans_n','ans_q']);
 });
 it('lists with filters, stable pagination, titles, counts and orthogonal flags',async()=>{
  const {harness,db}=setup();
  harness.sdk.stub('threads.list',async()=>[makeThreadResponse({id:'t',title:'Thread title'})]);
  seed(db,'ans_a','mine'); seed(db,'ans_b','mine'); seed(db,'ans_c');
  db.prepare("UPDATE items SET status='answered',answer='answer' WHERE id IN ('ans_a','ans_b')").run();
  // unread mirrors the Inbox: the open agent question ans_c is included.
  const first=await harness.behavior.callRpc('list',{view:'unread',limit:2}) as any;
  expect(first.items.map((i:any)=>i.id)).toEqual(['ans_c','ans_b']); expect(first.items[1]).toMatchObject({threadTitle:'Thread title'});
  const next=await harness.behavior.callRpc('list',{view:'unread',limit:2,cursor:first.nextCursor}) as any;
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
  await call('answers_report',{}); await call('answers_report',{});
  expect(db.prepare("SELECT turn_id,report FROM turn_updates WHERE thread_id='t'").all()).toEqual([{turn_id:'turn',report:1}]);
  const list=await call('answers_list',{}); expect(String(list)).toContain('ans_mine'); expect(String(list).length).toBeLessThanOrEqual(2000);
  const id=await call('answers_ask',{question:'Small question'});
  expect(db.prepare('SELECT kind,status FROM items WHERE id=?').get(id)).toEqual({kind:'for_me',status:'open'});
  expect(String(await call('answers_list',{}))).toContain(`Your open questions to the user:\n${id} `);
  await expect(harness.behavior.callAgentTool('answers_withdraw',{id,reason:'x'},{threadId:'other'})).rejects.toThrow('open question not found');
  await expect(call('answers_withdraw',{id:'ans_mine',reason:'x'})).rejects.toThrow('open question not found');
  db.prepare('UPDATE items SET notify_state=1 WHERE id=?').run(id);
  await call('answers_withdraw',{id,reason:' Found it '});
  expect(db.prepare('SELECT status,answer_source,note,notify_state,dismissed_at IS NOT NULL AS gone FROM items WHERE id=?').get(id)).toEqual({status:'open',answer_source:'agent',note:'Found it',notify_state:0,gone:1});
  expect(String(await call('answers_list',{}))).not.toContain(id);
  await expect(call('answers_withdraw',{id,reason:'again'})).rejects.toThrow('open question not found');
 });
 it('defers and resolves the owner messages of one turn together, so its reply is not an answer to one and an interim to another',async()=>{
  const {harness,db}=setup(); seed(db,'ans_q','mine','t'); seed(db,'ans_steer','mine','t'); seed(db,'ans_other','mine','t');
  db.prepare("UPDATE items SET turn_id='u',question_seq=CASE id WHEN 'ans_q' THEN 1 ELSE 2 END WHERE id IN ('ans_q','ans_steer')").run();
  db.prepare("UPDATE items SET turn_id='v',question_seq=0 WHERE id='ans_other'").run();
  const call=(name:string,p:object)=>harness.behavior.callAgentTool(name,p,{threadId:'t',projectId:'p'});
  await call('answers_defer',{id:'ans_steer'});
  expect(db.prepare("SELECT id,status FROM items ORDER BY id").all()).toEqual([{id:'ans_other',status:'waiting'},{id:'ans_q',status:'deferred'},{id:'ans_steer',status:'deferred'}]);
  db.prepare("UPDATE threads_state SET active_turn_id='w' WHERE thread_id='t'").run();
  await call('answers_resolve',{id:'ans_q'});
  expect(db.prepare("SELECT id,resolve_turn_id FROM items ORDER BY id").all()).toEqual([{id:'ans_other',resolve_turn_id:null},{id:'ans_q',resolve_turn_id:'w'},{id:'ans_steer',resolve_turn_id:'w'}]);
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
  expect(send.mock.calls[0][0]).toMatchObject({threadId:'t',mode:'queue-if-active',input:[{type:'text',text:'> Question\n\nresponse',mentions:[]}]});
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
  expect(await harness.behavior.callRpc('save',input)).toEqual({...saved as object,created:false});
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
  await vi.waitFor(()=>expect(seen.at(-1)).toBe('deleted')); // the burst collapses into one trailing invalidate
  expect(harness.inspection.experimental_rpcInvalidations.every(tags=>JSON.stringify(tags)===JSON.stringify([ITEMS_TAG,COUNTS_TAG]) || JSON.stringify(tags)===JSON.stringify([POOLS_TAG]))).toBe(true); off();
 });
 it('coalesces a burst of invalidations into a leading and one trailing call',async()=>{
  const {harness}=setup();
  for(const q of ['a','b','c']) await harness.behavior.callAgentTool('answers_ask',{question:q},{threadId:'t'});
  const n=harness.inspection.experimental_rpcInvalidations.length;
  expect(n).toBe(1); await vi.waitFor(()=>expect(harness.inspection.experimental_rpcInvalidations.length).toBe(2));
 });
 it.each(['live','list','recipients','legacy-list','legacy-recipients'])('ingests sub-thread history read and outside aggregates via %s',async mode=>{
  const {harness,db}=setup(), sub='thr_example_child', thread=makeThreadResponse({id:sub,parentThreadId:'thr_example'});
  const push=vi.fn(async()=>({channels:['mobile']}));
  harness.sdk.stub('threads.get',async()=>thread); harness.sdk.stub('plugins.callRpc',push as any);
  const events:any[]=[{seq:1,type:'client/turn/requested',data:{initiator:'user',requestId:'req_example',input:[{type:'text',text:'Inspect the result?'}]}},{seq:2,type:'turn/started',scope:{turnId:'turn_example'},data:{}},{seq:3,type:'turn/input/accepted',scope:{turnId:'turn_example'},data:{clientRequestId:'req_example'}},{seq:4,type:'item/completed',scope:{turnId:'turn_example'},data:{item:{type:'agentMessage',text:'Ready. Shall I continue?'}}},{seq:5,type:'turn/completed',scope:{turnId:'turn_example'},data:{status:'completed'}}];
  harness.sdk.stub('threads.events.list',async(a:any)=>events.filter(e=>e.seq>Number(a.afterSeq ?? 0)) as any);
  if(mode.startsWith('legacy')) db.prepare('INSERT INTO threads_state(thread_id,last_seq,updated_at) VALUES (?,0,0)').run(sub);
  if(mode==='live') {
   await harness.behavior.emitThreadEvent('experimental_thread.events',{thread,sequence:5} as any);
   await vi.waitFor(()=>expect(db.prepare('SELECT last_seq FROM threads_state WHERE thread_id=?').get(sub)).toEqual({last_seq:5}));
  } else if(mode.endsWith('recipients')) expect((await harness.behavior.callRpc('recipients',{selected:sub}) as any).recipients).toEqual([]);
  const history=await harness.behavior.callRpc('list',{view:'all',threadId:sub}) as any;
  expect(history.items).toMatchObject([{question:'Inspect the result?',answer:'Ready. Shall I continue?'}]);
  expect(history.items.every((i:any)=>i.readAt!==null)).toBe(true);
  if(mode==='live') {
   events.push(...events.slice(0,5).map(e=>({...e,seq:e.seq+5,scope:e.scope ? {turnId:'turn_example_next'} : undefined,data:{...e.data,...(e.type==='client/turn/requested' ? {requestId:'req_example_next'} : e.type==='turn/input/accepted' ? {clientRequestId:'req_example_next'} : {})}})));
   await harness.behavior.emitThreadEvent('experimental_thread.events',{thread,sequence:10} as any);
   await vi.waitFor(()=>expect(db.prepare('SELECT last_seq FROM threads_state WHERE thread_id=?').get(sub)).toEqual({last_seq:10}));
   expect(db.prepare('SELECT 1 FROM items WHERE read_at IS NULL').get()).toBeUndefined();
  }
  db.prepare('UPDATE items SET read_at=NULL,notify_state=1,asks=1').run();
  expect(db.prepare('SELECT 1 FROM items WHERE read_at IS NULL OR notify_state<>0 OR asks<>0').get()).toBeUndefined();
  expect(db.prepare("SELECT 1 FROM items WHERE kind='for_me' OR notify_state<>0").get()).toBeUndefined();
  expect(await harness.behavior.callRpc('counts',{})).toEqual({unread:0,waiting:0,forMe:0,inbox:0});
  expect((await harness.behavior.callRpc('recipients',{selected:sub}) as any).recipients).toEqual([]);
  db.prepare('UPDATE items SET pinned=1').run();
  for(const view of ['all','unread','waiting','for_me','saved','pinned']) expect((await harness.behavior.callRpc('list',{view,query:'result'}) as any).items).toEqual([]);
  const digest=JSON.parse((await harness.behavior.runCli(['digest','--json'])).stdout);
  expect(digest.newAnswers.total).toBe(0); expect(digest.waiting.total).toBe(0);
  expect(push).not.toHaveBeenCalled();
 });
 it('keeps explicit sub-agent asks visible and sub-thread reports read',async()=>{
  const {harness,db}=setup(),sub='thr_example_child';
  harness.sdk.stub('threads.get',async()=>makeThreadResponse({id:sub,parentThreadId:'thr_example'}));
  const push=vi.fn(async()=>({channels:['mobile']})); harness.sdk.stub('plugins.callRpc',push as any);
  const id=await harness.behavior.callAgentTool('answers_ask',{question:'Choose an option',urgency:'blocking'},{threadId:sub});
  expect((await harness.behavior.callRpc('list',{view:'for_me'}) as any).items.map((i:any)=>i.id)).toEqual([id]);
  expect((await harness.behavior.callRpc('counts',{}) as any).forMe).toBe(1);
  await vi.waitFor(()=>expect(push).toHaveBeenCalledWith(expect.objectContaining({pluginId:'push-notifications',input:expect.objectContaining({threadId:sub})})));
  expect((await harness.behavior.callRpc('recipients',{selected:sub}) as any).recipients).toEqual([]);
  db.prepare("UPDATE threads_state SET active_turn_id='turn_example' WHERE thread_id=?").run(sub);
  expect(await harness.behavior.callAgentTool('answers_report',{},{threadId:sub})).toContain('sub-thread');
 });
 it('keeps saved sub-thread history out of aggregates after deletion',async()=>{
  const {harness,db}=setup(),sub='thr_example_child',thread=makeThreadResponse({id:sub,parentThreadId:'thr_example'});
  harness.sdk.stub('threads.get',async()=>thread);
  await harness.behavior.callAgentTool('answers_ask',{question:'Choose an option'},{threadId:sub});
  seed(db,'ans_example_saved','saved',sub);
  await harness.behavior.emitThreadEvent('thread.deleted',{thread});
  await vi.waitFor(()=>expect(db.prepare("SELECT thread_deleted FROM items WHERE id='ans_example_saved'").get()).toEqual({thread_deleted:1}));
  expect((await harness.behavior.callRpc('list',{view:'saved'}) as any).items).toEqual([]);
 });
 it('passes the hook payload thread to the driver (no threads.get)',async()=>{
  const {harness}=setup();
  await harness.behavior.emitThreadEvent('experimental_thread.events',{thread:makeThreadResponse({id:'top'}),sequence:5} as any);
  await vi.waitFor(()=>expect(harness.inspection.sdk.callsTo('threads.events.list').length).toBeGreaterThan(0));
  expect(harness.inspection.sdk.callsTo('threads.get')).toHaveLength(0);
 });
 it('does not invalidate when an empty thread is archived, unarchived or deleted',async()=>{
  const {harness,db}=setup(); seed(db,'ans_a','for_me','a');
  const count=()=>harness.inspection.experimental_rpcInvalidations.length;
  for(const ev of ['thread.archived','thread.unarchived','thread.deleted']) await harness.behavior.emitThreadEvent(ev as any,{thread:makeThreadResponse({id:'empty'})});
  expect(count()).toBe(0);
  await harness.behavior.emitThreadEvent('thread.archived',{thread:makeThreadResponse({id:'a'})}); expect(count()).toBe(1);
 });
 it('bumps the queue stamp of a thread on bb queue events',async()=>{
  const {harness}=setup(); const stamp=async(threadId:string)=>((await harness.behavior.callRpc('queueStamp',{threadId})) as any).stamp;
  expect(await stamp('thr_q')).toBe(0);
  for(const ev of ['message.queued','message.dispatched','message.cancelled']) await harness.behavior.emitThreadEvent(ev as any,{entry:{id:'q1',threadId:'thr_q'}} as any);
  expect(await stamp('thr_q')).toBe(3); expect(await stamp('thr_other')).toBe(0);
  expect(harness.inspection.experimental_rpcInvalidations.length).toBe(3);
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
 it('adds empty attachments to existing items',()=>{ const db=new Database(':memory:'); migrations.slice(0,-2).forEach(m=>db.exec(m)); seed(db); db.exec(migrations.at(-2)!); expect(db.prepare('SELECT attachments FROM items').get()).toEqual({attachments:'[]'}); db.close(); });
 it('uses wake and pending notification indexes',()=>{
  const db=new Database(':memory:'); db.exec(migrations.join('\n'));
  const insert=db.prepare("INSERT INTO items(id,kind,thread_id,status,question,created_at,updated_at,notify_state,snoozed_until) VALUES (?,'mine','t','waiting','q',1,1,?,?)");
  db.transaction(()=>{for(let i=0;i<1000;i++) insert.run('ans_'+i,Number(i===500),i===500?100:null);})();
  db.exec('ANALYZE');
  const plan=(sql:string)=>db.prepare('EXPLAIN QUERY PLAN '+sql).all().map((r:any)=>r.detail).join(' ');
  expect(plan('SELECT min(snoozed_until) FROM items WHERE snoozed_until IS NOT NULL')).toContain('items_snoozed_until');
  expect(plan('SELECT id FROM items WHERE notify_state=1 ORDER BY rowid')).toContain('items_notify_pending');
  db.close();
 });
 it('builds exact Markdown, with empty lines and notes, and enforces caps',()=>{
  expect(buildReplyMessage([{quote:'**bold**\n\nlast',note:'note'},{quote:'only',note:''}])).toBe('> **bold**\n>\n> last\n\nnote\n\n> only');
  expect(()=>buildReplyMessage([{quote:'x'.repeat(20001),note:''}])).toThrow('20,000');
  expect(()=>buildReplyMessage([{quote:'x'.repeat(20000),note:'x'.repeat(12000)}])).toThrow('32,000');
 });
 it('previews another thread\'s message as "Sender: text", not its [bb message from …] header',async()=>{
  const {harness,db}=setup(undefined,async (args:any)=>(args?.threadIds ?? []).filter((id:string)=>id==='thr_c').map(()=>makeThreadResponse({id:'thr_c',projectId:'p',title:'Manager'})));
  db.prepare("INSERT INTO items(id,kind,thread_id,status,question,read_at,trigger_kind,trigger_source,created_at,updated_at) VALUES ('ans_w','update','t','waiting','[bb message from thread:thr_c] **Review** done',1,'agent','thr_c',1,1)").run();
  expect(((await harness.behavior.callRpc('recipients',{})) as any).recipients[0].preview).toBe('Manager: Review done');
 });
 it('cleans contact previews with full thread ids, links, emphasis and sender headers',async()=>{
  const {harness,db}=setup(undefined,async (args:any)=>(args?.threadIds ?? []).map((id:string)=>makeThreadResponse({id,projectId:'p',title:id==='thr_manager-one' ? 'Manager' : 'Worker'})));
  db.prepare("INSERT INTO items(id,kind,thread_id,status,question,read_at,trigger_kind,trigger_source,created_at,updated_at) VALUES ('ans_inline','update','t','waiting',?,1,'agent','thr_manager-one',1,1)").run('[bb message from thread:thr_manager-one] **Review** [docs](https://example.com) @thread:thr_worker_two#msg=4 /optimize');
  expect(((await harness.behavior.callRpc('recipients',{})) as any).recipients[0].preview).toBe('Manager: Review docs @Worker /optimize');
 });
 it('hides HTML comment markers other plugins embed from contact previews',async()=>{
  const {harness,db}=setup();
  db.prepare("INSERT INTO items(id,kind,thread_id,status,question,read_at,trigger_kind,trigger_source,created_at,updated_at) VALUES ('ans_marker','update','t','waiting',?,1,'plugin','work-board',1,1)").run('<!-- work-board-task:EXA-1 -->\nPick up EXA-1');
  expect(((await harness.behavior.callRpc('recipients',{})) as any).recipients[0].preview).toBe('Pick up EXA-1');
 });
 it('counts an update as unread in contacts and views, never as waiting or saved, and refuses replies to it',async()=>{
  const {harness,db}=setup(), call=(name:string,p:object={})=>harness.behavior.callRpc(name,p) as Promise<any>;
  db.prepare("INSERT INTO items(id,kind,thread_id,status,question,answer,answer_seq,trigger_kind,trigger_source,created_at,updated_at) VALUES ('ans_u','update','t','answered','[bb system] done','Report',5,'system','thr_c',1,1)").run();
  expect(await call('counts')).toMatchObject({unread:1,waiting:0,inbox:1});
  expect((await call('recipients')).recipients[0]).toMatchObject({threadId:'t',unread:1,preview:'Report'});
  expect((await call('list',{view:'unread'})).items[0]).toMatchObject({kind:'update',trigger:{kind:'system',sourceId:'thr_c',sourceTitle:'Thread title'}});
  for (const view of ['waiting','saved']) expect((await call('list',{view})).items).toHaveLength(0);
  expect((await call('list',{view:'all'})).items).toHaveLength(1);
  await expect(call('reply',{id:'ans_u',text:'ok'})).rejects.toThrow('cannot receive replies');
  await call('markThreadRead',{threadId:'t'}); expect((await call('counts')).inbox).toBe(0);
 });
 it('the badge drops answers already read in bb, keeps open agent questions, and ignores deleted threads',async()=>{
  const {harness,db}=setup(), call=(name:string,p:object={})=>harness.behavior.callRpc(name,p) as Promise<any>;
  seed(db,'ans_a','mine','a'); db.prepare("UPDATE items SET status='answered',answer='x',answered_at=5 WHERE id='ans_a'").run();
  seed(db,'ans_q','for_me','a'); db.prepare("UPDATE items SET created_at=1 WHERE id='ans_q'").run();
  seed(db,'ans_gone','mine','gone'); db.prepare("UPDATE items SET status='answered',answer='y',thread_deleted=1 WHERE id='ans_gone'").run();
  harness.sdk.stub('threads.list',async(args:any)=>args.threadIds.map((id:string)=>makeThreadResponse({id,lastReadAt:10} as any)));
  expect(await call('counts')).toMatchObject({inbox:1,unread:0,forMe:1});
  expect(db.prepare("SELECT read_at FROM items WHERE id='ans_q'").get()).toEqual({read_at:null});
 });
 it('previews a quote reply by its note and a bare quote by its text, without Markdown markers',async()=>{
  const {harness,db}=setup(), call=(name:string,p:object={})=>harness.behavior.callRpc(name,p) as Promise<any>;
  seed(db,'ans_a','mine','a'); db.prepare("UPDATE items SET question=? WHERE id='ans_a'").run('> Include the board export?\n> yes or no\n\nДа');
  seed(db,'ans_b','mine','b'); db.prepare("UPDATE items SET question=? WHERE id='ans_b'").run('> Only a quote');
  seed(db,'ans_c','mine','c'); db.prepare("UPDATE items SET question=? WHERE id='ans_c'").run('## Plan\n- first step');
  const previews=Object.fromEntries((await call('recipients')).recipients.map((r:any)=>[r.threadId,r.preview]));
  expect(previews).toEqual({a:'Да',b:'Only a quote',c:'Plan first step'});
 });
 it('groups unread recipients, orders them, keeps selected, and reads only inbox kinds',async()=>{
  const {harness,db}=setup(); seed(db,'ans_a','mine','a'); seed(db,'ans_b','for_me','b'); seed(db,'ans_c','for_me','b'); seed(db,'ans_wait','mine','b'); seed(db,'ans_save','saved','b');
  db.prepare("UPDATE items SET status='answered',answer=?,updated_at=10 WHERE id='ans_a'").run('x'.repeat(200));
  db.prepare("UPDATE items SET updated_at=20 WHERE id='ans_b'").run();
  const call=(name:string,p:object={})=>harness.behavior.callRpc(name,p) as Promise<any>;
  expect(await call('counts')).toMatchObject({inbox:3});
  const recipients=(await call('recipients')).recipients;
  // Open agent questions count on the contact too, so contacts add up to the nav badge.
  expect(recipients.map((r:any)=>[r.threadId,r.unread,r.lastAt])).toEqual([['b',2,20],['a',1,10]]);
  expect(recipients[1].preview).toHaveLength(160);
  // Reading a thread does not answer its open questions; they stay counted.
  await call('markThreadRead',{threadId:'a'});
  expect((await call('counts')).inbox).toBe(2);
  expect((await call('recipients')).recipients.map((r:any)=>[r.threadId,r.unread])).toEqual([['b',2],['a',0]]);
  expect(db.prepare("SELECT read_at FROM items WHERE id IN ('ans_wait','ans_save')").all()).toEqual([{read_at:null},{read_at:null}]);
 });
 it('keeps the open chat listed without items, but not once its thread is archived',async()=>{
  const {harness,db}=setup(); seed(db,'ans_a','mine','a');
  const ids=async(selected:string)=>((await harness.behavior.callRpc('recipients',{selected})) as any).recipients.map((r:any)=>r.threadId);
  expect(await ids('fresh')).toEqual(['a','fresh']);
  db.prepare("INSERT INTO archived_threads VALUES ('fresh')").run();
  expect(await ids('fresh')).toEqual(['a']);
 });
 it('keeps recipient output across threads and projects',async()=>{
  const {harness,db}=setup();
  for(const [id,kind,thread,project] of [['ans_a','mine','a','p1'],['ans_b','for_me','b','p2'],['ans_c','mine','b','p2'],['ans_d','for_me','c','p1']] as const) {
    seed(db,id,kind,thread); db.prepare('UPDATE items SET project_id=?,updated_at=? WHERE id=?').run(project,{ans_a:10,ans_b:20,ans_c:30,ans_d:5}[id],id);
  }
  db.prepare("UPDATE items SET status='answered',answer='A answer' WHERE id='ans_a'").run();
  db.prepare("UPDATE items SET question='B question?' WHERE id='ans_b'").run();
  harness.sdk.stub('threads.list',async(args:any)=>args.threadIds.map((id:string)=>makeThreadResponse({id,title:id.toUpperCase(),projectId:id==='b'?'p2':'p1'})));
  harness.sdk.stub('projects.list',async()=>[{id:'p1',name:'One'},{id:'p2',name:'Two'}] as any);
  expect((await harness.behavior.callRpc('recipients',{}) as any).recipients).toEqual([
    {threadId:'b',threadTitle:'B',projectId:'p2',projectName:'Two',unread:1,lastAt:30,preview:'B question?'},
    {threadId:'a',threadTitle:'A',projectId:'p1',projectName:'One',unread:1,lastAt:10,preview:'A answer'},
  ]);
 });
 it('stores contact-list preferences in plugin settings and rejects anything else',async()=>{
  const {harness}=setup();
  expect(await harness.behavior.callRpc('setPreferences',{groupByProject:true})).toEqual({ok:true});
  for(const bad of [{usage:'never'},{notify:'off'},{groupByProject:'yes'}]) await expect(harness.behavior.callRpc('setPreferences',bad)).rejects.toThrow();
 });
 it('hides archived threads from the Inbox, counts and views until unarchived',async()=>{
  const {harness,db}=setup(); seed(db,'ans_a','mine','a'); seed(db,'ans_b','for_me','b');
  db.prepare("UPDATE items SET status='answered',answer='x' WHERE id='ans_a'").run();
  const call=(name:string,p:object={})=>harness.behavior.callRpc(name,p) as Promise<any>;
  expect((await call('recipients')).recipients.map((r:any)=>r.threadId).sort()).toEqual(['a']); // b only asked a question: no contact
  expect((await harness.behavior.emitThreadEvent('thread.archived',{thread:makeThreadResponse({id:'a'})})).errors).toEqual([]);
  expect((await call('recipients')).recipients.map((r:any)=>r.threadId)).toEqual([]);
  expect(await call('counts')).toMatchObject({unread:0,inbox:1});
  expect((await call('list',{view:'unread'})).items.map((i:any)=>i.id)).toEqual(['ans_b']);
  expect((await call('list',{view:'all'})).items.map((i:any)=>i.id).sort()).toEqual(['ans_a','ans_b']);
  await harness.behavior.emitThreadEvent('thread.unarchived',{thread:makeThreadResponse({id:'a'})});
  expect(await call('counts')).toMatchObject({unread:1,inbox:2});
 });
 it('uses inline comments in recipient previews and task titles',async()=>{
  const {harness,db}=setup(); seed(db,'ans_a','mine','a');
  db.prepare("UPDATE items SET question=? WHERE id='ans_a'").run('@short\nContext for @short (resolved by plugin "inline-comments"):\n\nThe user attached this passage from the conversation to their message:\n\n> Quoted passage\n\nTheir comment on it: My comment');
  expect((await harness.behavior.callRpc('recipients',{}) as any).recipients[0].preview).toBe('My comment');
  let title=''; harness.sdk.stub('plugins.callRpc',async(args:any)=>{title=args.input.title;return {ok:true,task:{key:'TASK-1'}};});
  await harness.behavior.callRpc('createTask',{id:'ans_a',projectId:'p'});
  expect(title).toBe('My comment');
 });
 it('shows thread titles and link text in recipient previews',async()=>{
  const {harness,db}=setup(); seed(db,'ans_a','mine','a');
  db.prepare("UPDATE items SET status='answered',answer=? WHERE id='ans_a'").run('Sent **@thread:thr_mgr#msg=3** see [ACM-5](/plugins/work-board/work-board/task/ACM-5) and `x`');
  harness.sdk.stub('threads.list',async(args:any)=>args.threadIds.includes('thr_mgr') ? [makeThreadResponse({id:'thr_mgr',title:'Manager'})] : [makeThreadResponse({id:'a',title:'A'})]);
  expect((await harness.behavior.callRpc('recipients',{}) as any).recipients[0].preview).toBe('Sent @Manager see ACM-5 and x');
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
 it('counts an opened contact\'s open agent questions and drops the old questions filter',async()=>{
  const {harness,db}=setup();
  const call=(name:string,p:object)=>harness.behavior.callRpc(name,p) as Promise<any>;
  const add=db.prepare("INSERT INTO items(id,kind,thread_id,status,question,answer,created_at,updated_at) VALUES (?,?,?,?,?,?,1,1)");
  add.run('ans_q','mine','a','answered','Ready?','a'); add.run('ans_f','for_me','c','open','Pick one',null); add.run('ans_r','for_me','d','replied','Pick two','B');
  // Threads that only asked the owner something are no contacts (they live in Questions), unless opened.
  expect((await call('recipients',{})).recipients.map((r:any)=>[r.threadId,r.unread])).toEqual([['a',1]]);
  expect((await call('recipients',{selected:'c'})).recipients.map((r:any)=>[r.threadId,r.unread])).toEqual([['a',1],['c',1]]);
  expect((await call('counts',{})).inbox).toBe(2);
  await expect(call('recipients',{questions:true})).rejects.toBeDefined();
  await expect(call('list',{view:'all',questions:true})).rejects.toBeDefined();
 });
 it('sends free pool messages without a quote and refuses an empty pool',async()=>{
  expect(buildReplyMessage([{quote:'q',note:'reply'},{quote:'',note:'extra'},{quote:'',note:'  '}])).toBe('> q\n\nreply\n\nextra');
  const {harness,send}=setup();
  const call=(name:string,p:object)=>harness.behavior.callRpc(name,p) as Promise<any>;
  await call('poolAdd',{threadId:'t',quote:'',note:''});
  await expect(call('poolSend',{threadId:'t'})).rejects.toThrow('Nothing to send'); expect(send).not.toHaveBeenCalled();
 });
 it('maps send modes, holds drafts in the queue and rejects past times',async()=>{
  const {harness,send}=setup();
  const call=(name:string,p:object)=>harness.behavior.callRpc(name,p) as Promise<any>;
  const at=Date.now()+3600e3;
  await call('quoteReply',{threadId:'t',quote:'q',text:'a',send:{mode:'steer'}});
  await call('quoteReply',{threadId:'t',quote:'q',text:'b',send:{mode:'draft'}});
  await call('quoteReply',{threadId:'t',quote:'q',text:'c',send:{mode:'queue',sendAt:at}});
  const args=send.mock.calls.map(c=>c[0] as any);
  expect(args.map(a=>[a.mode,a.pluginSubmission,a.sendAt])).toEqual([['steer-if-active',undefined,undefined],['queue-if-active',{pluginId:'answers',data:{kind:'draft'}},undefined],['queue-if-active',undefined,at]]);
  await expect(call('quoteReply',{threadId:'t',quote:'q',text:'d',send:{mode:'queue',sendAt:Date.now()-1}})).rejects.toThrow('passed');
  const hook=harness.inspection.registrations.hooks['message.dispatch']!;
  const ctx=(submission:unknown,queued:unknown[]=[])=>({experimental_submission:submission,queuedMessages:queued}) as any;
  expect(await hook(ctx({pluginId:'answers',data:{kind:'draft'}}))).toEqual({action:'wait',reason:'Draft'});
  expect(await hook(ctx(null,[{waitingOn:{kind:'plugin',pluginId:'answers'}}]))).toEqual({action:'wait',reason:'Draft'});
  expect(await hook(ctx({pluginId:'drafts',data:{kind:'draft'}}))).toEqual({action:'proceed'});
  expect(await hook(ctx(null))).toEqual({action:'proceed'});
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

 it.each(['new','tracked','failed-first'])('suppresses first drain and not later answers: %s',async mode=>{
  const {harness,db,driver}=driverSetup();
  if(mode==='tracked') db.prepare("INSERT INTO threads_state(thread_id,last_seq,updated_at) VALUES ('t',0,0)").run();
  let fail=mode==='failed-first',phase=0;
  const events=(offset:number)=>[
   {seq:offset+1,type:'client/turn/requested',data:{initiator:'user',requestId:'r'+offset,input:[{type:'text',text:'Question?'}]}},
   {seq:offset+2,type:'turn/started',scope:{turnId:'turn'+offset},data:{}},
   {seq:offset+3,type:'turn/input/accepted',scope:{turnId:'turn'+offset},data:{clientRequestId:'r'+offset}},
   {seq:offset+4,type:'item/completed',scope:{turnId:'turn'+offset},data:{item:{type:'agentMessage',text:'Answer'}}},
   {seq:offset+5,type:'turn/completed',scope:{turnId:'turn'+offset},createdAt:Date.now()-120000,data:{status:'completed'}}
  ];
  harness.sdk.stub('threads.events.list',async(args:any)=>{
   if(fail) throw new Error('temporary');
   const all=events(phase*10);
   return args.order==='desc' ? [...all].reverse() : all.filter(e=>e.seq>Number(args.afterSeq ?? 0));
  });
  if(fail) {await expect(driver.schedule('t')).rejects.toThrow('temporary'); fail=false;}
  await driver.schedule('t');
  expect(db.prepare('SELECT notify_state FROM items').all()).toEqual([{notify_state:0}]);
  phase=1; await driver.schedule('t');
  expect(db.prepare('SELECT notify_state FROM items ORDER BY question_seq').all()).toEqual([{notify_state:0},{notify_state:1}]);
 });
 it('tells the open chat to reread its context ring when bb reports context usage, and only then',async()=>{
  const host=createFakePluginHost({pluginId:'answers',sdk:{threads:{get:async({threadId})=>makeThreadResponse({id:threadId,projectId:'p'}),list:async()=>[],events:{list:async()=>[]}}}});
  const db=host.bb.storage.database(); db.exec(migrations.join("\n")); const onContext=vi.fn();
  const driver=createDriver(host.bb,db,()=>{},onContext);
  cleanup.push(async()=>{await driver.dispose(); await host.harness.lifecycle.dispose();});
  db.prepare("INSERT INTO threads_state(thread_id,last_seq,updated_at) VALUES ('t',5,0)").run();
  let next:any[]=[{seq:6,type:'item/completed',createdAt:1,data:{},scope:{kind:'thread'}}];
  host.harness.sdk.stub('threads.events.list',async(args:any)=>{ if (args.order!=='asc') return []; const page=next; next=[]; return page; });
  await driver.schedule('t'); expect(onContext).not.toHaveBeenCalled();
  next=[{seq:7,type:'thread/contextWindowUsage/updated',createdAt:2,data:{},scope:{kind:'thread'}}];
  await driver.schedule('t'); expect(onContext).toHaveBeenLastCalledWith('t',undefined);
  next=[{seq:8,type:'thread/compacted',createdAt:42,data:{},scope:{kind:'thread'}}];
  await driver.schedule('t'); expect(onContext).toHaveBeenLastCalledWith('t',42);
 });
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
  // First sight reads only what ingest needs; catching up also reads context-usage events (they bump the ring's stamp).
  expect(calls.map(c=>c.types.includes('thread/contextWindowUsage/updated'))).toEqual([false,false,true]);
  expect(db.prepare('SELECT last_seq FROM threads_state').get()).toEqual({last_seq:100});
  expect(db.prepare('SELECT project_id,created_at FROM items').get()).toEqual({project_id:'p',created_at:123});
  expect(invalidate).toHaveBeenCalled();
 });
 it('invalidates once after a multi-page drain',async()=>{
  const {harness,db,driver,invalidate}=driverSetup();
  db.prepare("INSERT INTO threads_state(thread_id,last_seq,updated_at) VALUES ('t',1,0)").run();
  const events=Array.from({length:101},(_,i)=>({seq:i+2,type:'client/turn/requested',data:{initiator:'user',requestId:'r'+i,input:[{type:'text',text:'Question '+i}]}}));
  harness.sdk.stub('threads.events.list',async(args:any)=>events.filter(e=>e.seq>Number(args.afterSeq)).slice(0,100));
  await driver.schedule('t');
  expect(db.prepare('SELECT count(*) n FROM items').get()).toEqual({n:101});
  expect(invalidate).toHaveBeenCalledTimes(1);
  expect(harness.inspection.sdk.callsTo('threads.events.list')).toHaveLength(2);
 });
 // Only answers_defer defers: a reply stays the answer even while sub-sessions its turn started still run.
 it('keeps a turn answer while the children it started still run',async()=>{
  const kids=[{id:'k',createdAt:2000,status:'active'}], backfill=false;
  const {harness,db,driver}=driverSetup();
  const events=[
   {seq:1,type:'client/turn/requested',createdAt:1000,data:{initiator:'user',requestId:'r',input:[{type:'text',text:'Research?'}]}},
   {seq:2,type:'turn/started',scope:{turnId:'u'},data:{}},
   {seq:3,type:'turn/input/accepted',scope:{turnId:'u'},data:{clientRequestId:'r'}},
   {seq:4,type:'item/completed',scope:{turnId:'u'},data:{item:{type:'agentMessage',text:'Research started, I will report'}}},
   {seq:5,type:'turn/completed',scope:{turnId:'u'},data:{status:'completed'}},
  ];
  let shown=backfill?events:[];
  harness.sdk.stub('threads.events.list',async(args:any)=>args.order==='desc' ? [...shown].reverse() : shown.filter(e=>e.seq>Number(args.afterSeq ?? 0)));
  harness.sdk.stub('threads.list',async(args:any)=>args.parentThreadId==='t' ? kids.map(k=>makeThreadResponse({parentThreadId:'t',...k} as any)) : []);
  await driver.schedule('t'); shown=events; await driver.schedule('t');
  const item=db.prepare("SELECT status,interim,answer,read_at,wait_children FROM items").get();
  expect(item).toEqual(expect.objectContaining({status:'answered',answer:'Research started, I will report',wait_children:null}));
 });
 it('skips archived and unchanged tracked threads using reconcile metadata',async()=>{
  const {harness,db,driver}=driverSetup();
  const eventThreads:string[]=[];
  for(const id of ['archived','unchanged','changed']) db.prepare('INSERT INTO threads_state(thread_id,last_seq,updated_at,ingested_thread_updated_at) VALUES (?,1,0,100)').run(id);
  harness.sdk.stub('threads.list',async(args:any)=>args.threadIds ? [makeThreadResponse({id:'archived',updatedAt:200,archivedAt:1}),makeThreadResponse({id:'unchanged',updatedAt:100}),makeThreadResponse({id:'changed',updatedAt:101,projectId:'p'})] : []);
  harness.sdk.stub('threads.events.list',async(args:any)=>{eventThreads.push(args.threadId);return [];});
  await driver.reconcile();
  expect(harness.inspection.sdk.callsTo('threads.get')).toHaveLength(0);
  expect(eventThreads).toEqual(['changed']);
  expect(db.prepare("SELECT thread_id FROM archived_threads").all()).toEqual([{thread_id:'archived'}]);
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

describe('0.3 server attention',()=>{
 it('uses the attention set for counts, list, recipients and bulk undo',async()=>{
  const {harness,db}=setup(),call=async(name:string,input:object={})=>await harness.behavior.callRpc(name,input) as any;
  seed(db,'ans_fail','mine','failed'); seed(db,'ans_read','mine','read'); seed(db,'ans_ask','for_me','asked'); seed(db,'ans_sleep','for_me','sleep');
  db.prepare("UPDATE items SET failed_at=2,attempt_request_id='retry' WHERE id='ans_fail'").run();
  db.prepare("UPDATE items SET status='answered',read_at=3 WHERE id='ans_read'").run();
  db.prepare("UPDATE items SET snoozed_until=? WHERE id='ans_sleep'").run(Date.now()+100000);
  expect((await call('counts')).inbox).toBe(2);
  expect((await call('list',{view:'unread'})).items.map((i:any)=>i.id).sort()).toEqual(['ans_ask','ans_fail']);
  const recipients=(await call('recipients')).recipients;
  expect(recipients).toHaveLength(2); expect(recipients.map((r:any)=>r.unread)).toEqual([1,0]);
  expect(recipients.find((r:any)=>r.threadId==='failed').preview).toBe('Turn failed: Question');
  // The open agent question stays until answered.
  const batch=await call('markRead',{all:true}); expect(batch.count).toBe(1);
  expect(await call('undoRead',{batch:batch.batch})).toEqual({ok:true,count:1});
  const threadBatch=await call('markThreadRead',{threadId:'failed'}); expect(threadBatch.count).toBe(1);
  db.prepare('UPDATE items SET read_at=? WHERE read_batch=?').run(Date.now()-600001,threadBatch.batch);
  expect((await call('undoRead',{batch:threadBatch.batch})).count).toBe(0);
 });
 it('keeps interim answers waiting and clears the flag explicitly',async()=>{
  const {harness,db}=setup(); seed(db,'ans_a','mine');
  db.prepare("UPDATE items SET status='answered',answer='later',answer_seq=7,likely_interim=1,notify_state=1,answered_at=8").run();
  await harness.behavior.callRpc('setInterim',{id:'ans_a',value:false});
  expect((db.prepare('SELECT likely_interim FROM items').get() as any).likely_interim).toBe(0);
  await harness.behavior.callRpc('keepWaiting',{id:'ans_a'});
  expect(db.prepare('SELECT status,interim,interim_seq,answer,answered_at,notify_state FROM items').get()).toEqual({status:'deferred',interim:'later',interim_seq:7,answer:null,answered_at:null,notify_state:0});
  await expect(harness.behavior.callRpc('keepWaiting',{id:'ans_a'})).rejects.toThrow();
 });
 it('validates options, stores trimmed options and enters attention',async()=>{
  const {harness,db}=setup();
  for(const options of [[],['a',' a '],['x'.repeat(201)],Array(7).fill('a')]) await expect(harness.behavior.callAgentTool('answers_ask',{question:'Pick',options},{threadId:'t'})).rejects.toThrow();
  for(const extra of [{recommended:'Maybe'},{reason:'why'},{options:undefined,recommended:'Yes'}]) await expect(harness.behavior.callAgentTool('answers_ask',{question:'Pick',options:['Yes','No'],...extra},{threadId:'t'})).rejects.toThrow();
  const id=await harness.behavior.callAgentTool('answers_ask',{question:'Pick',options:[' Yes ','x'.repeat(200)],recommended:' Yes',reason:'Cheaper'},{threadId:'t'});
  expect(db.prepare('SELECT options,recommended,recommend_reason,notify_state FROM items WHERE id=?').get(id)).toEqual({options:JSON.stringify(['Yes','x'.repeat(200)]),recommended:'Yes',recommend_reason:'Cheaper',notify_state:0});
  expect((await harness.behavior.callRpc('list',{view:'for_me'}) as any).items[0]).toMatchObject({recommended:'Yes',recommendReason:'Cheaper'});
 });
 it('asks several questions at once or with checkboxes through one form',async()=>{
  const {harness,db}=setup(), ask=(p:object)=>harness.behavior.callAgentTool('answers_ask',p,{threadId:'t'});
  for(const bad of [{question:'Pick',multiSelect:true},{question:'Pick',questions:[{question:'One'}]},{question:'Pick',options:['a'],questions:[{question:'One'},{question:'Two'}]},
    {question:'Pick',questions:[{question:'One',multiSelect:true},{question:'Two'}]},{question:'Pick',questions:[{question:'One',options:['a'],recommended:'b'},{question:'Two'}]}]) await expect(ask(bad)).rejects.toThrow();
  const multi=await ask({question:'Which?',options:['A','B'],multiSelect:'true',recommended:'B'});
  expect(db.prepare('SELECT question,options,questions FROM items WHERE id=?').get(multi)).toEqual({question:'Which?',options:'null',questions:JSON.stringify([{id:'q1',prompt:'Which?',options:[{value:'A',label:'A'},{value:'B',label:'B',description:'Recommended'},{value:'Your call',label:'Your call',description:'Let the agent decide'}],multiSelect:true,allowFreeText:true,required:false}])});
  const composite=await ask({question:'Setup',questions:[{question:'Name?',header:'Name'},{question:'Colors?',options:['Red','Blue'],multiSelect:true}]});
  expect(db.prepare('SELECT question FROM items WHERE id=?').get(composite)).toEqual({question:'Setup\n\n1. **Name.** Name?\n2. Colors?'});
  const item=(await harness.behavior.callRpc('list',{view:'for_me'}) as any).items.find((i:any)=>i.id===composite);
  expect(item.questions.map((q:any)=>[q.id,q.shortLabel,q.multiSelect,q.options?.length])).toEqual([['q1','Name',false,1],['q2',undefined,true,3]]);
 });
 it('retries the latest attempt and handles live pre-acceptance failures',async()=>{
  const {harness,db}=setup(); seed(db,'ans_a','mine');
  db.prepare("UPDATE items SET request_id='a',attempt_request_id='b'").run();
  db.prepare("INSERT INTO request_aliases VALUES ('t','b','ans_a')").run();
  await harness.behavior.emitThreadEvent('turn.failed',{threadId:'t',requestId:'b',turnId:null,inputAccepted:false,attemptNumber:2,errorInfo:null,rateLimits:null,originPluginId:null});
  const retry=vi.fn(async()=>({})); harness.sdk.stub('threads.retry',retry as any);
  await harness.behavior.callRpc('retryTurn',{id:'ans_a'});
  expect(retry).toHaveBeenCalledWith({threadId:'t',turnRequestId:'b'});
 });
 it('consumes snoozes, clamps long timers, re-arms and disposes',async()=>{
  vi.useFakeTimers(); const {harness,db}=setup(); seed(db,'ans_a'); seed(db,'ans_b');
  const call=(id:string,until:number|null)=>harness.behavior.callRpc('snooze',{id,until});
  await expect(call('ans_a',Date.now())).rejects.toThrow();
  await expect(call('ans_a',Date.now()+30*86400000+1)).rejects.toThrow();
  await call('ans_a',Date.now()+30*86400000);
  await vi.advanceTimersByTimeAsync(2147483647);
  expect((db.prepare("SELECT snoozed_until FROM items WHERE id='ans_a'").get() as any).snoozed_until).not.toBeNull();
  await call('ans_b',Date.now()+1000);
  await vi.advanceTimersByTimeAsync(1000);
  expect(db.prepare("SELECT snoozed_until,notify_state FROM items WHERE id='ans_b'").get()).toEqual({snoozed_until:null,notify_state:0});
  await call('ans_a',null);
  expect((db.prepare("SELECT notify_state FROM items WHERE id='ans_a'").get() as any).notify_state).toBe(0);
  await call('ans_a',Date.now()+1000);
  await harness.lifecycle.dispose(); await vi.advanceTimersByTimeAsync(2000);
  expect(vi.getTimerCount()).toBe(0);
 });
 it('consumes overdue snoozes at startup',async()=>{
  const host=createFakePluginHost({pluginId:'answers',sdk:{threads:{list:async()=>[]}}});
  const db=host.bb.storage.database(); host.bb.storage.migrate(db,migrations); seed(db);
  db.prepare('UPDATE items SET snoozed_until=1,read_at=2').run();
  plugin(host.bb); cleanup.push(()=>host.harness.lifecycle.dispose());
  expect(db.prepare('SELECT snoozed_until,read_at,notify_state FROM items').get()).toEqual({snoozed_until:null,read_at:null,notify_state:1});
 });
 it('validates Work Board output and stores task keys',async()=>{
  const {harness,db}=setup(); seed(db);
  const rpc=vi.fn(async(args:any)=>args.method==='listProjects' ? {projects:[{id:'p',name:'Project',prefix:'TASK'}]} : {ok:true,task:{key:'TASK-1'}});
  harness.sdk.stub('plugins.callRpc',rpc as any);
  expect(await harness.behavior.callRpc('workBoardProjects',{})).toEqual({available:true,projects:[{id:'p',name:'Project',prefix:'TASK'}]});
  expect(await harness.behavior.callRpc('createTask',{id:'ans_one',projectId:'p'})).toEqual({key:'TASK-1'});
  expect((db.prepare('SELECT task_key FROM items').get() as any).task_key).toBe('TASK-1');
  rpc.mockImplementation(async()=>({ok:false,error:{message:'Denied'}}) as any);
  await expect(harness.behavior.callRpc('createTask',{id:'ans_one',projectId:'p'})).rejects.toThrow('Denied');
  rpc.mockImplementation(async()=>{throw new Error('missing');});
  expect(await harness.behavior.callRpc('workBoardProjects',{})).toEqual({available:false,projects:[]});
 });
});

it('sends only selected pool IDs and keeps other entries', async () => {
  const { harness, db, send } = setup(vi.fn(async () => ({ ok: true, delivery: 'sent' }))); seed(db);
  const call = (name: string, input: object) => harness.behavior.callRpc(name, input) as Promise<any>;
  const first = await call('poolAdd', { threadId: 't', quote: 'first', note: 'one', itemId: 'ans_one' });
  const second = await call('poolAdd', { threadId: 't', quote: 'second', note: 'two', itemId: 'ans_one' });
  await call('poolSend', { threadId: 't', ids: [first.id] });
  expect((send.mock.calls[0] as any[])[0].input[0].text).toBe('> first\n\none');
  expect((await call('pools', {})).pools[0].entries.map((entry: any) => entry.id)).toEqual([second.id]);
});
it('updates pool attachments with revision checks and forwards steer', async () => {
  const { harness, send } = setup();
  const call = (name: string, input: object) => harness.behavior.callRpc(name, input) as Promise<any>;
  const { id } = await call('poolAdd', { threadId: 't', quote: '', note: 'Ready' });
  const attachments = [{ type: 'localFile', path: 'file.txt', name: 'file.txt' }];
  await call('poolUpdate', { id, note: 'Ready', attachments, revision: 0 });
  await expect(call('poolUpdate', { id, note: 'Stale', attachments: [], revision: 0 })).rejects.toThrow('changed');
  expect((await call('pools', {})).pools[0].entries[0].attachments).toEqual(attachments);
  await call('poolSend', { threadId: 't', ids: [id], send: { mode: 'steer' } });
  expect((send.mock.calls[0] as any[])[0]).toMatchObject({ mode: 'steer-if-active', input: [{ type: 'text' }, { type: 'localFile', path: 'file.txt' }] });
});

it('reads a thread\'s cost from Tokenomos and stays quiet when it is missing', async () => {
  const {harness}=setup(), cost={usd:1.5,tokens:{freshIn:1,cacheRead:2,cacheWrite:3,output:4},estimated:false,partial:false};
  let input:any; harness.sdk.stub('plugins.callRpc',async(args:any)=>{input=args;return {priceVersion:'v1',threads:[{threadId:'thr_a',own:cost,total:{...cost,usd:2},descendantCount:2,updatedAt:1}]};});
  expect(await harness.behavior.callRpc('threadCost',{threadId:'thr_a'})).toEqual({available:true,own:cost,total:{...cost,usd:2},descendantCount:2});
  expect(input).toMatchObject({pluginId:'tokenomos',method:'costs.threads',input:{threadIds:['thr_a'],includeDescendants:true}});
  harness.sdk.stub('plugins.callRpc',async()=>{throw new Error('Plugin tokenomos is not installed');});
  expect(await harness.behavior.callRpc('threadCost',{threadId:'thr_a'})).toEqual({available:false,own:null,total:null,descendantCount:0});
});

describe('owed answers', () => {
 const day=24*60*60*1000, now=10*day;
 function owedSeed(db:Database.Database,id:string,at=now-1000) {
  seed(db,id,'mine');
  db.prepare("UPDATE items SET status='deferred',created_at=?,updated_at=? WHERE id=?").run(at,at,id);
 }
 it('lists oldest first, omits dismissed and expired, and keeps history',async()=>{
  vi.useFakeTimers(); vi.setSystemTime(now);
  const {db,harness}=setup();
  owedSeed(db,'ans_new'); owedSeed(db,'ans_old',now-day); owedSeed(db,'ans_expired',now-3*day); owedSeed(db,'ans_dismissed');
  db.prepare("UPDATE items SET interim='Working',updated_at=? WHERE id='ans_old'").run(now-day);
  db.prepare("UPDATE items SET dismissed_at=? WHERE id='ans_dismissed'").run(now);
  expect(await harness.behavior.callRpc('owed',{threadId:'t'})).toEqual({items:[
   {id:'ans_old',question:'Question',createdAt:now-day,interim:true},
   {id:'ans_new',question:'Question',createdAt:now-1000,interim:false},
  ]});
  expect(db.prepare("SELECT status,dismissed_at FROM items WHERE id='ans_expired'").get()).toEqual({status:'deferred',dismissed_at:now});
  expect((await harness.behavior.callRpc('list',{view:'all',threadId:'t'}) as any).items).toHaveLength(4);
 });
 it('settles answered and dismissed, validates kind and invalidates lists and counts',async()=>{
  vi.useFakeTimers(); vi.setSystemTime(now);
  const {db,harness}=setup(); owedSeed(db,'ans_answer'); owedSeed(db,'ans_drop'); seed(db,'ans_wrong');
  await harness.behavior.callRpc('settleOwed',{id:'ans_answer',action:'answered'});
  expect(db.prepare("SELECT status,answered_at,answer_source FROM items WHERE id='ans_answer'").get()).toEqual({status:'answered',answered_at:now,answer_source:'user'});
  await harness.behavior.callRpc('settleOwed',{id:'ans_drop',action:'dismissed'});
  expect(db.prepare("SELECT dismissed_at FROM items WHERE id='ans_drop'").get()).toEqual({dismissed_at:now});
  await expect(harness.behavior.callRpc('settleOwed',{id:'ans_wrong',action:'answered'})).rejects.toThrow('not owed');
  // The agent's later report still resolves the question the owner settled by hand; deferring it again is refused.
  db.prepare("INSERT INTO threads_state(thread_id,last_seq,updated_at,active_turn_id) VALUES ('t',0,0,'late') ON CONFLICT(thread_id) DO UPDATE SET active_turn_id='late'").run();
  await harness.behavior.callAgentTool('answers_resolve',{id:'ans_answer'},{threadId:'t',projectId:'p'});
  expect(db.prepare("SELECT resolve_turn_id FROM items WHERE id='ans_answer'").get()).toEqual({resolve_turn_id:'late'});
  await expect(harness.behavior.callAgentTool('answers_defer',{id:'ans_answer'},{threadId:'t',projectId:'p'})).rejects.toThrow('not found');
  expect(await harness.behavior.callRpc('owed',{threadId:'t'})).toEqual({items:[]});
  await vi.advanceTimersByTimeAsync(150);
  expect(JSON.stringify(harness.inspection.experimental_rpcInvalidations)).toContain(ITEMS_TAG);
  expect(JSON.stringify(harness.inspection.experimental_rpcInvalidations)).toContain(COUNTS_TAG);
 });
 it('expires at three days despite pins and reads; interim and status movement restart the clock',async()=>{
  vi.useFakeTimers(); vi.setSystemTime(now);
  const {db,harness}=setup();
  for (const id of ['ans_stale','ans_interim','ans_status']) owedSeed(db,id,now-3*day+1);
  await harness.behavior.callRpc('setPinned',{id:'ans_stale',pinned:true});
  db.prepare("UPDATE items SET failed_at=? WHERE id='ans_stale'").run(now);
  await harness.behavior.callRpc('markThreadRead',{threadId:'t'});
  expect(db.prepare("SELECT read_at FROM items WHERE id='ans_stale'").get()).toEqual({read_at:now});
  db.prepare("UPDATE items SET interim='New interim',interim_seq=10,updated_at=? WHERE id='ans_interim'").run(now);
  db.prepare("UPDATE items SET status='waiting',updated_at=? WHERE id='ans_status'").run(now);
  db.prepare("UPDATE items SET status='deferred',updated_at=? WHERE id='ans_status'").run(now);
  expect((await harness.behavior.callRpc('owed',{threadId:'t'}) as any).items).toHaveLength(3);
  vi.setSystemTime(now+1);
  expect((await harness.behavior.callRpc('owed',{threadId:'t'}) as any).items.map((r:any)=>r.id)).toEqual(['ans_interim','ans_status']);
 });
 it('agent list excludes dismissed and expires deferred items, retaining waiting and fresh items',async()=>{
  vi.useFakeTimers(); vi.setSystemTime(now);
  const {db,harness}=setup(); owedSeed(db,'ans_expired',now-3*day); owedSeed(db,'ans_fresh'); seed(db,'ans_waiting','mine'); seed(db,'ans_dismissed','mine');
  db.prepare("UPDATE items SET dismissed_at=? WHERE id='ans_dismissed'").run(now);
  const result=await harness.behavior.callAgentTool('answers_list',{}, {threadId:'t'});
  expect(String(result)).toContain('ans_fresh'); expect(String(result)).toContain('ans_waiting');
  expect(String(result)).not.toContain('ans_expired'); expect(String(result)).not.toContain('ans_dismissed');
  expect(db.prepare("SELECT dismissed_at FROM items WHERE id='ans_expired'").get()).toEqual({dismissed_at:now});
 });
});

it('defaults deadlines once and lets an earlier owner reply win',async()=>{
 vi.useFakeTimers(); const {harness,db,send}=setup(), ask=(p:object)=>harness.behavior.callAgentTool('answers_ask',p,{threadId:'t'});
 for(const deadlineMinutes of [4,10081,5.5]) await expect(ask({question:'Pick',options:['A'],recommended:'A',deadlineMinutes})).rejects.toThrow();
 await expect(ask({question:'Pick',deadlineMinutes:5})).rejects.toThrow();
 const id=await ask({question:'Pick',options:['A'],recommended:'A',deadlineMinutes:5});
 await vi.advanceTimersByTimeAsync(300000);
 expect(db.prepare('SELECT status,answer_source,answer FROM items WHERE id=?').get(id)).toEqual({status:'replied',answer_source:'agent',answer:'No answer by the deadline, so going with the default:\nA'});
 const owner=await ask({question:'Pick again',options:['B'],recommended:'B',deadlineMinutes:5}); await harness.behavior.callRpc('reply',{id:owner,text:'Mine'}); await vi.advanceTimersByTimeAsync(300000);
 expect(db.prepare('SELECT answer_source FROM items WHERE id=?').get(owner)).toEqual({answer_source:'user'});expect(send).toHaveBeenCalledTimes(2);
 const failed=await ask({question:'Setup',questions:[{question:'One',options:['A'],recommended:'A'},{question:'Two'}],deadlineMinutes:5}); send.mockRejectedValueOnce(new Error('offline'));
 await vi.advanceTimersByTimeAsync(300000); expect(db.prepare('SELECT status,deadline_at FROM items WHERE id=?').get(failed)).toEqual({status:'open',deadline_at:null});
 await vi.advanceTimersByTimeAsync(300000);expect(send).toHaveBeenCalledTimes(3);
});

it('restores composite deadlines after restart',async()=>{
 vi.useFakeTimers();const h=setup();
 const id=await h.harness.behavior.callAgentTool('answers_ask',{question:'Setup',questions:[{question:'One',options:['A'],recommended:'A'},{question:'Two'}],deadlineMinutes:5},{threadId:'t'});
 const next=await h.harness.lifecycle.reload(plugin); cleanup.push(()=>next.harness.lifecycle.dispose());
 await vi.advanceTimersByTimeAsync(300000);
 expect((next.bb.storage.database().prepare('SELECT answer FROM items WHERE id=?').get(id) as any).answer).toContain('1. One — A\n2. Two — Your call (decide yourself)');
});

it('stores urgency and keeps low questions visible without a push',async()=>{
 const {harness,db}=setup();const id=await harness.behavior.callAgentTool('answers_ask',{question:'Later?',urgency:'low'},{threadId:'t'});
 expect(db.prepare('SELECT urgency,notify_state FROM items WHERE id=?').get(id)).toEqual({urgency:'low',notify_state:0});
 expect((await harness.behavior.callRpc('list',{view:'for_me'}) as any).items[0].urgency).toBe('low');
 await expect(harness.behavior.callAgentTool('answers_ask',{question:'?',urgency:'urgent'},{threadId:'t'})).rejects.toThrow();
});

it('merges same-turn asks preserving choices, reasons, intro and limits',async()=>{
 const {harness,db}=setup(), ask=(p:object)=>harness.behavior.callAgentTool('answers_ask',p,{threadId:'t'});
 await ask({question:'Earlier turn'});db.prepare("UPDATE threads_state SET active_turn_id='turn1' WHERE thread_id='t'").run();
 const id=await ask({question:'Pick',options:['A','B'],recommended:'A',reason:'Cheap',deadlineMinutes:10,urgency:'low'});
 const result=await ask({question:'Which?',options:['C','D'],multiSelect:true,recommended:'D',reason:'Fast',deadlineMinutes:5,urgency:'blocking'});expect(String(result).split('\n')[0]).toBe(id);
 const row=db.prepare('SELECT * FROM items WHERE id=?').get(id) as any,parts=JSON.parse(row.questions);
 expect(row).toMatchObject({options:null,recommend_reason:null,turn_id:'turn1',urgency:'blocking'});expect(row.deadline_at).toBeLessThan(Date.now()+301000);
 expect(parts[0].options[0].description).toBe('Recommended: Cheap');expect(parts[1]).toMatchObject({id:'q2',multiSelect:true});expect(parts[1].options[1].description).toBe('Recommended: Fast');expect(row.question).toBe('1. Pick\n2. Which?');
 await ask({question:'More',questions:Array.from({length:8},(_,i)=>({question:`Part ${i}`}))});expect(JSON.parse((db.prepare('SELECT questions FROM items WHERE id=?').get(id) as any).questions)).toHaveLength(10);
 const separate=await ask({question:'New intro',questions:[{question:'First',header:'One'},{question:'Second'}]});expect(separate).not.toBe(id);
 await ask({question:'Third'});expect((db.prepare('SELECT question FROM items WHERE id=?').get(separate) as any).question).toBe('New intro\n\n1. **One.** First\n2. Second\n3. Third');
 db.prepare("UPDATE items SET dismissed_at=1 WHERE id=?").run(separate);expect(String(await ask({question:'Separate'}))).not.toContain('Merged');
});

it('reminds blocking questions at the configured interval, at most three times',async()=>{
 vi.useFakeTimers();const {harness,db}=setup();await harness.behavior.setSettings({remindHours:1});
 const ask=(question:string,urgency='blocking')=>harness.behavior.callAgentTool('answers_ask',{question,urgency},{threadId:'t'});
 const id=await ask('Waiting?');const normal=await ask('Normal?','normal');
 await vi.advanceTimersByTimeAsync(3600000);expect(db.prepare('SELECT reminders,reminded_at FROM items WHERE id=?').get(id)).toEqual({reminders:1,reminded_at:Date.now()});
 await vi.advanceTimersByTimeAsync(3*3600000);expect(db.prepare('SELECT reminders FROM items WHERE id=?').get(id)).toEqual({reminders:3});expect(db.prepare('SELECT reminders FROM items WHERE id=?').get(normal)).toEqual({reminders:0});
 const off=await ask('Off?');await harness.behavior.setSettings({remindHours:0});await vi.advanceTimersByTimeAsync(4*3600000);expect(db.prepare('SELECT reminders FROM items WHERE id=?').get(off)).toEqual({reminders:0});
 await harness.behavior.callRpc('setDismissed',{id:off,dismissed:true});await harness.behavior.setSettings({remindHours:1});await vi.advanceTimersByTimeAsync(3600000);expect(db.prepare('SELECT reminders FROM items WHERE id=?').get(off)).toEqual({reminders:0});
});

it('restores reminder timing after restart and honors disabled saved settings',async()=>{
 vi.useFakeTimers();const h=setup();await h.harness.behavior.setSettings({remindHours:0});
 const id=await h.harness.behavior.callAgentTool('answers_ask',{question:'Waiting?',urgency:'blocking'},{threadId:'t'});
 await vi.advanceTimersByTimeAsync(4*3600000);
 const next=await h.harness.lifecycle.reload(plugin);cleanup.push(()=>next.harness.lifecycle.dispose());await vi.advanceTimersByTimeAsync(1000);
 const db=next.bb.storage.database();expect(db.prepare('SELECT reminders FROM items WHERE id=?').get(id)).toEqual({reminders:0});
 await next.harness.behavior.setSettings({remindHours:3});await vi.advanceTimersByTimeAsync(1000);expect(db.prepare('SELECT reminders FROM items WHERE id=?').get(id)).toEqual({reminders:1});
});
