import { afterEach, describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrations } from './schema';
import { applyEvents, asksOwner, cap, failRequest, type Event } from './ingest';
const databases: Database.Database[] = [];
const setup = () => { const db = new Database(':memory:'); migrations.forEach(m => db.exec(m)); databases.push(db); return db; };
afterEach(() => databases.splice(0).forEach(db => db.close()));
export const req = (seq: number, id = 'r', extra: object = {}): Event => ({seq,type:'client/turn/requested',data:{initiator:'user',requestId:id,input:[{type:'text',text:'question'}],...extra}});
export const ev = (seq: number, type: string, turnId = 'x', data: object = {}): Event => ({seq,type,scope:{turnId},data});
const start = (seq = 2, turn = 'x') => ev(seq,'turn/started',turn);
const accept = (seq = 3, id = 'r', turn = 'x') => ev(seq,'turn/input/accepted',turn,{clientRequestId:id});
const message = (seq = 4, text = 'answer', turn = 'x', extra: object = {}) => ev(seq,'item/completed',turn,{item:{type:'agentMessage',text,...extra}});
const done = (seq = 5, status = 'completed', turn = 'x') => ev(seq,'turn/completed',turn,{status});
const rows = (db: Database.Database) => db.prepare('SELECT * FROM items ORDER BY question_seq').all() as any[];
const row = (db: Database.Database) => rows(db)[0];
describe('applyEvents', () => {
 it('keeps a user message that has only attachments', () => { const db=setup(); applyEvents(db,'t',[req(1,'r',{input:[{type:'localImage',path:'/photo.png'}]})],'project'); expect(row(db).question).toBe(''); expect(JSON.parse(row(db).attachments)).toEqual([{type:'localImage',path:'/photo.png'}]); });
 it('stores image and file input parts without changing question text', () => { const db=setup(); applyEvents(db,'t',[req(1,'r',{input:[{type:'text',text:'question'},{type:'localImage',path:'/photo.png',hostId:'h'},{type:'localFile',path:'/notes.pdf',name:'notes.pdf',mimeType:'application/pdf',sizeBytes:42}]})],'project'); expect(row(db).question).toBe('question'); expect(JSON.parse(row(db).attachments)).toEqual([{type:'localImage',path:'/photo.png',hostId:'h'},{type:'localFile',path:'/notes.pdf',name:'notes.pdf',mimeType:'application/pdf',sizeBytes:42}]); });
 it('reports only changes the UI shows: candidate text alone is not one', () => {const db=setup(); expect(applyEvents(db,'t',[req(1),start(),accept()])).toBe(true); expect(applyEvents(db,'t',[message()])).toBe(false); expect(applyEvents(db,'t',[done()])).toBe(true); expect(applyEvents(db,'t',[done()])).toBe(false);});
 it('pairs a plain question', () => {const db=setup(); applyEvents(db,'t',[req(1),start(),accept(),message(),done()]); expect(row(db)).toMatchObject({status:'answered',answer:'answer',answer_seq:4,answer_source:'turn'});});
 it('persists candidates across page splits and reapplication is idempotent', () => {const db=setup(); const page=[req(1),start(),accept(),message()]; applyEvents(db,'t',page); applyEvents(db,'t',page); expect(row(db).status).toBe('waiting'); applyEvents(db,'t',[done()]); expect(rows(db)).toHaveLength(1); expect(row(db).answer_seq).toBe(4);});
 it.each([{initiator:'agent'},{initiator:'system'},{originPluginId:'slots'},{senderThreadId:'sender'},{input:[{type:'text',text:'  '}]},{input:[{type:'text',text:'/help',mentions:[{start:0,end:5,resource:{kind:'command'}}]}]}])('ignores non-questions %j', extra => {const db=setup(); applyEvents(db,'t',[req(1,'r',extra)]); expect(rows(db)).toHaveLength(0);});
 it('tracks the owner\'s words sent through Answers itself', () => {const db=setup(); applyEvents(db,'t',[req(1,'r',{originPluginId:'answers'})]); expect(rows(db)).toHaveLength(1);});
 it('keeps a slash command with additional text', () => {const db=setup(); applyEvents(db,'t',[req(1,'r',{input:[{type:'text',text:'/help explain',mentions:[{start:0,end:5,resource:{kind:'command'}}]}]})]); expect(rows(db)).toHaveLength(1);});
 it('steers into an agent turn using only messages after the question', () => {const db=setup(); const mine=()=>rows(db).find(r=>r.kind==='mine'); applyEvents(db,'t',[start(1),message(2,'old'),req(3),accept(4),done(5)]); expect(mine().status).toBe('waiting'); applyEvents(db,'t',[start(6),accept(7),message(8,'new'),done(9)]); expect(mine().answer).toBe('new');});
 it('a steer the agent never saw (no tool result after it) is answered by the next turn, not by the reply already being written', () => {
  const db=setup(), mine=()=>rows(db).filter(r=>r.kind==='mine');
  const tool=(seq:number,turn='x')=>ev(seq,'item/completed',turn,{item:{type:'commandExecution'}});
  applyEvents(db,'t',[req(1,'a',{initiator:'system'}),start(2),accept(3,'a'),tool(4),req(5,'s'),accept(6,'s'),message(7,'report on the old work'),done(8)]);
  expect(mine()).toMatchObject([{status:'waiting',steer_seq:6}]);
  applyEvents(db,'t',[req(9,'n'),start(10,'y'),accept(11,'n','y'),message(12,'answers both','y'),done(13,'completed','y')]);
  expect(mine().map(r=>[r.status,r.answer])).toEqual([['answered','answers both'],['answered','answers both']]);
 });
 it('a steer followed by a tool result is seen and answered by the same turn', () => {
  const db=setup(), tool=(seq:number)=>ev(seq,'item/completed','x',{item:{type:'commandExecution'}});
  applyEvents(db,'t',[req(1,'a',{initiator:'system'}),start(2),accept(3,'a'),tool(4),req(5,'s'),accept(6,'s'),tool(7),message(8,'saw it'),done(9)]);
  expect(rows(db).find(r=>r.kind==='mine')).toMatchObject({status:'answered',answer:'saw it',steer_seq:null});
 });
 it('ignores nested starts, messages and completions', () => {const db=setup(); applyEvents(db,'t',[req(1),start(),accept(),message(),ev(5,'turn/started','nested',{parentToolCallId:'tool'}),message(6,'nested','nested',{parentToolCallId:'tool'}),done(7,'completed','nested')]); expect(row(db).candidate).toBe('answer'); expect(db.prepare('SELECT active_turn_id FROM threads_state').get()).toEqual({active_turn_id:'x'}); applyEvents(db,'t',[done(8)]); expect(row(db).answer).toBe('answer');});
 it.each(['failed','interrupted'])('%s: failed keeps interim and waiting, a stopped message is dropped', status => {const db=setup(); applyEvents(db,'t',[req(1),start(),accept(),message(),done(5,status)]); if (status === 'interrupted') { expect(rows(db)).toHaveLength(0); return; } expect(row(db)).toMatchObject({status:'waiting',interim:'answer',interim_seq:4,answer:null,candidate:null,dismissed_at:null});});
 it('shares the final candidate for two accepted questions', () => {const db=setup(); applyEvents(db,'t',[req(1),start(),accept(),req(4,'r2'),accept(5,'r2'),message(6,'final'),done(7)]); expect(rows(db).map(r=>r.answer)).toEqual(['final','final']);});
 it('maps chained system retries while preserving original request id', () => {const db=setup(); applyEvents(db,'t',[req(1,'a'),req(2,'b',{initiator:'system',retryOfRequestId:'a'}),req(3,'c',{initiator:'system',retryOfRequestId:'b'}),start(4),accept(5,'c'),message(6),done(7)]); expect(rows(db)).toHaveLength(1); expect(row(db)).toMatchObject({request_id:'a',answer:'answer'});});
 it('defers to interim then resolves in a later turn', () => {const db=setup(); applyEvents(db,'t',[req(1),start(),accept()]); db.prepare("UPDATE items SET status='deferred'").run(); applyEvents(db,'t',[message(4,'later'),done()]); expect(row(db)).toMatchObject({status:'deferred',interim:'later',interim_seq:4}); applyEvents(db,'t',[start(6,'y')]); db.prepare("UPDATE items SET resolve_turn_id='y'").run(); applyEvents(db,'t',[message(7,'resolved','y'),done(8,'completed','y')]); expect(row(db)).toMatchObject({status:'answered',answer:'resolved',answer_seq:7,answer_source:'agent',resolve_turn_id:null});});
 it('clears interrupted and empty explicit resolutions', () => {const db=setup(); applyEvents(db,'t',[req(1),start(),accept()]); db.prepare("UPDATE items SET resolve_turn_id='x',status='deferred'").run(); applyEvents(db,'t',[message(),done(5,'interrupted')]); expect(row(db)).toMatchObject({status:'deferred',resolve_turn_id:null,interim:'answer'}); applyEvents(db,'t',[start(6,'y')]); db.prepare("UPDATE items SET resolve_turn_id='y'").run(); applyEvents(db,'t',[done(7,'completed','y')]); expect(row(db)).toMatchObject({status:'deferred',resolve_turn_id:null});});
 it('ignores a boundary turn whose start precedes the backfill window', () => {const db=setup(); const desc=[done(9),message(8),accept(7),start(6),req(5),done(4,'completed','old'),message(3,'orphan','old'),accept(2,'missing','old')]; applyEvents(db,'t',desc.reverse()); expect(rows(db)).toHaveLength(1); expect(row(db).answer).toBe('answer'); expect(db.prepare('SELECT last_seq FROM threads_state').get()).toEqual({last_seq:9});});
 it('skips questions in agent-spawned threads', () => {const db=setup(); applyEvents(db,'t',[req(1)],null,0,false); expect(rows(db)).toHaveLength(0); expect(db.prepare('SELECT last_seq FROM threads_state').get()).toEqual({last_seq:1});});
 it('auto-reads a short note with a short reply, keeps questions and long reports unread', () => {
  const q = (text: string) => ({input:[{type:'text',text}]}), db = setup();
  applyEvents(db,'t',[req(1,'a',q('archive the sessions')),start(2,'x'),accept(3,'a','x'),message(4,'Archived','x'),done(5,'completed','x'),
   req(6,'b',q('ready?')),start(7,'y'),accept(8,'b','y'),message(9,'Yes','y'),done(10,'completed','y'),
   req(11,'c',q('go')),start(12,'z'),accept(13,'c','z'),message(14,'x'.repeat(200),'z'),done(15,'completed','z')]);
  expect(rows(db).map(r => r.read_at === null)).toEqual([false,true,true]);
 });
 it('only hides a stopped message that a reply pool quotes', () => {const db=setup(); applyEvents(db,'t',[req(1),start(),accept()]); const id=row(db).id; db.prepare("INSERT INTO pool_entries(id,thread_id,quote,item_id,created_at,updated_at) VALUES ('pool_a','t','q',?,1,1)").run(id); applyEvents(db,'t',[done(5,'interrupted')]); expect(row(db).dismissed_at).not.toBeNull();});
 it('caps text with the chat suffix', () => {expect(cap('x'.repeat(21000),20000)).toHaveLength(20000); expect(cap('x'.repeat(5000),4000)).toMatch(/… \(truncated, open in chat\)$/);});
});

describe('0.3 attention lifecycle',()=>{
 it.each([false,true])('stamps failures and answers using event time, live=%s',live=>{
  const db=setup();
  applyEvents(db,'t',[req(1),start(),accept(),{...done(4,'failed'),createdAt:123}],null,900,true,live);
  expect(row(db)).toMatchObject({failed_at:123,notify_state:Number(live),attempt_request_id:'r'});
  applyEvents(db,'t',[req(5,'b',{retryOfRequestId:'r'}),ev(6,'client/turn/rejected','x',{requestId:'b'})],null,901,true,live);
  expect(row(db).attempt_request_id).toBe('b');
  applyEvents(db,'t',[start(7,'y')],null,902,true,live);
  expect(applyEvents(db,'t',[accept(8,'b','y')],null,903,true,live)).toBe(true);
  expect(row(db).failed_at).toBeNull();
  expect(applyEvents(db,'t',[accept(9,'b','y')],null,903,true,live)).toBe(false);
  applyEvents(db,'t',[message(10,'Final answer?','y'),{...done(11,'completed','y'),createdAt:456}],null,904,true,live);
  expect(row(db)).toMatchObject({failed_at:null,answered_at:456,notify_state:Number(live)});
 });
 it('rejects original and retry requests before acceptance and keeps live rejection idempotent',()=>{
  const db=setup();
  applyEvents(db,'t',[req(1),ev(2,'client/turn/rejected','x',{requestId:'r'})],null,10,true,true);
  expect(row(db)).toMatchObject({failed_at:10,attempt_request_id:'r'});
  applyEvents(db,'t',[req(3,'b',{retryOfRequestId:'r'}),ev(4,'client/turn/rejected','x',{requestId:'b'})],null,20,true,true);
  expect(row(db).attempt_request_id).toBe('b');
 });
 it('records one failed attempt once when the live hook and the persisted rejection both arrive',()=>{
  const db=setup(); applyEvents(db,'t',[req(1)],null,5,true,true);
  expect(failRequest(db,'t','r',10,true,true)).toBe(1);
  db.prepare('UPDATE items SET notify_state=0').run();
  applyEvents(db,'t',[ev(2,'client/turn/rejected','x',{requestId:'r'})],null,20,true,true);
  expect(row(db)).toMatchObject({failed_at:10,notify_state:0});
 });
 it.each(["Делегировал задачу","Отпишусь позже","I'll get back","waiting for the sub-agent"])('flags interim text %s',text=>{
  const db=setup(); applyEvents(db,'t',[req(1),start(),accept(),message(4,text),done()]);
  expect(row(db).likely_interim).toBe(1);
 });
 it('does not flag agent resolutions or fail a resolution turn',()=>{
  const db=setup(); applyEvents(db,'t',[req(1),start(),accept()]);
  db.prepare("UPDATE items SET status='deferred',resolve_turn_id='y'").run();
  applyEvents(db,'t',[start(4,'y'),message(5,'waiting for the child','y'),done(6,'failed','y')]);
  expect(row(db)).toMatchObject({status:'deferred',failed_at:null,resolve_turn_id:null});
  db.prepare("UPDATE items SET resolve_turn_id='z'").run();
  applyEvents(db,'t',[start(7,'z'),message(8,'waiting for the child','z'),done(9,'completed','z')]);
  expect(row(db)).toMatchObject({answer_source:'agent',likely_interim:0});
 });
});

describe('updates',()=>{
 const updates=(db:Database.Database)=>db.prepare("SELECT * FROM items WHERE kind='update'").all() as any[];
 const count=(db:Database.Database,table:string)=>(db.prepare(`SELECT count(*) n FROM ${table}`).get() as {n:number}).n;
 const text=(t:string)=>[{type:'text',text:t}];
 const system={initiator:'system',input:text('[bb system] @thread:thr_child-1 completed: done')};
 it.each([
  [system,'system','thr_child-1'],
  [{initiator:'agent',senderThreadId:'thr_s',input:text('[bb message from thread:thr_s] hi')},'agent','thr_s'],
  [{originPluginId:'delivery-dashboard',input:text('**CI Dashboard** Deploy')},'plugin','delivery-dashboard'],
  [{input:text('[merge-queue watcher] Merge queue changed: empty')},'other','merge-queue watcher'],
 ] as const)('records the final message of a %j turn',(extra,kind,source)=>{
  const db=setup(); applyEvents(db,'t',[req(1,'r',extra),start(),accept(),message(4,'first'),message(5,'report'),{...done(6),createdAt:77}],'p',100,true,true);
  expect(updates(db)).toEqual([expect.objectContaining({status:'answered',question:extra.input[0].text,answer:'report',answer_seq:5,answer_source:'turn',answered_at:77,created_at:77,read_at:77,asks:0,notify_state:0,trigger_kind:kind,trigger_source:source,project_id:'p'})]);
  expect([count(db,'request_triggers'),count(db,'turn_updates')]).toEqual([0,0]);
 });
 it('marks an update that asks the owner, and pushes only that one when live',()=>{
  const db=setup(); applyEvents(db,'t',[req(1,'a',system),start(2,'x'),accept(3,'a','x'),message(4,'Merge it now?','x'),done(5,'completed','x'),req(6,'b',system),start(7,'y'),accept(8,'b','y'),message(9,'Merged.','y'),done(10,'completed','y')],'p',100,true,true);
  expect(updates(db).map(u=>[u.answer,u.asks,u.notify_state])).toEqual([['Merge it now?',1,1],['Merged.',0,0]]); expect(updates(db).map(u=>u.read_at===null)).toEqual([true,false]);
  const replay=setup(); applyEvents(replay,'t',[req(1,'a',system),start(2,'x'),accept(3,'a','x'),message(4,'Merge it now?','x'),done(5,'completed','x')]);
  expect(updates(replay).map(u=>[u.asks,u.notify_state])).toEqual([[1,0]]);
 });
 it('still counts owner messages that open with a task link or a checkbox as questions',()=>{
  for (const t of ['[ANV-12](/plugins/work-board/work-board/task/ANV-12) ok?','[x] done','[]']) {const db=setup(); applyEvents(db,'t',[req(1,'r',{input:text(t)})]); expect(rows(db).map(r=>r.kind)).toEqual(['mine']);}
 });
 it('keeps the trigger across a retry, falls back to other, and pushes only live events',()=>{
  const db=setup(); applyEvents(db,'t',[req(1,'a',{initiator:'agent',senderThreadId:'thr_s'}),req(2,'b',{initiator:'system',retryOfRequestId:'a'}),start(3),accept(4,'b'),message(5),done(6),start(7,'y'),message(8,'no trigger seen','y'),done(9,'completed','y')]);
  expect(updates(db).map(u=>[u.trigger_kind,u.trigger_source,u.notify_state])).toEqual([['agent','thr_s',0],['other',null,0]]);
 });
 it('adds nothing when the turn answered the owner: own question, steer-in, answers_resolve',()=>{
  const db=setup();
  applyEvents(db,'t',[req(1),start(),accept(),message(),done()]);
  applyEvents(db,'t',[req(6,'s',system),start(7,'y'),accept(8,'s','y'),req(9,'o'),accept(10,'o','y'),message(11,'steered','y'),done(12,'completed','y')]);
  applyEvents(db,'t',[req(13,'d'),start(14,'z'),accept(15,'d','z'),done(16,'completed','z')]); db.prepare("UPDATE items SET status='deferred' WHERE request_id='d'").run();
  applyEvents(db,'t',[req(17,'s2',system),start(18,'w'),accept(19,'s2','w')]); db.prepare("UPDATE items SET resolve_turn_id='w' WHERE request_id='d'").run();
  applyEvents(db,'t',[message(20,'resolved','w'),done(21,'completed','w')]);
  expect(updates(db)).toHaveLength(0); expect(rows(db).map(r=>r.answer)).toEqual(['answer','steered','resolved']);
 });
 it.each(['failed','interrupted'])('adds nothing for a %s turn and cleans its bookkeeping',status=>{
  const db=setup(); applyEvents(db,'t',[req(1,'s',system),start(),accept(3,'s'),message(),done(5,status)]);
  expect(updates(db)).toHaveLength(0); expect(count(db,'turn_updates')).toBe(0);
 });
 it('adds nothing for an empty final message or an agent-spawned thread',()=>{
  const db=setup(); applyEvents(db,'t',[req(1,'s',system),start(),accept(3,'s'),done(4)]);
  applyEvents(db,'u',[req(1,'s',system),start(),accept(3,'s'),message(),done()],null,0,false);
  expect(updates(db)).toHaveLength(0); expect([count(db,'request_triggers'),count(db,'turn_updates')]).toEqual([0,0]);
 });
 it('is idempotent on re-ingest, also from a reset cursor',()=>{
  const db=setup(), page=[req(1,'s',system),start(),accept(3,'s'),message(),done()];
  expect(applyEvents(db,'t',page)).toBe(true); expect(applyEvents(db,'t',page)).toBe(false);
  db.prepare('UPDATE threads_state SET last_seq=0').run(); applyEvents(db,'t',page);
  expect(updates(db)).toHaveLength(1);
 });
});

describe('auto-defer wait list',()=>{
 const wake = (seq:number, child:string, turn:string, text='report') => [req(seq,'c'+seq,{initiator:'system',input:[{type:'text',text:`[bb system] @thread:${child} completed: ok`}]}),start(seq+1,turn),accept(seq+2,'c'+seq,turn),message(seq+3,text,turn),done(seq+4,'completed',turn)];
 const waiting = (kids:string[]) => { const db=setup(); applyEvents(db,'t',[req(1),start(),accept(),message(),done()]); db.prepare("UPDATE items SET status='deferred',interim=answer,answer=NULL,answer_source=NULL,answered_at=NULL,wait_children=?").run(JSON.stringify(kids)); return db; };
 const long = 'final report '.repeat(20), mine = (db:Database.Database) => db.prepare("SELECT * FROM items WHERE kind='mine'").get() as any;
 const updates = (db:Database.Database) => db.prepare("SELECT trigger_source FROM items WHERE kind='update'").all();
 it('an earlier child still leaves a quiet update; the last child answers the question with its report',()=>{
  const db=waiting(['thr_a','thr_b']);
  applyEvents(db,'t',wake(10,'thr_a','y','first report'),'p',5,true,true);
  expect(mine(db)).toMatchObject({status:'deferred',wait_children:'["thr_b"]'}); expect(updates(db)).toEqual([{trigger_source:'thr_a'}]);
  applyEvents(db,'t',wake(20,'thr_b','z',long),'p',9,true,true);
  expect(mine(db)).toMatchObject({status:'answered',answer:long,answer_source:'agent',answered_at:9,read_at:null,notify_state:1,wait_children:null}); expect(updates(db)).toEqual([{trigger_source:'thr_a'}]);
 });
 it('a child nobody waits for behaves as before', () => { const db=waiting(['thr_a']); applyEvents(db,'t',wake(10,'thr_other','y')); expect(mine(db)).toMatchObject({status:'deferred',wait_children:'["thr_a"]'}); expect(updates(db)).toEqual([{trigger_source:'thr_other'}]); });
 it('the oldest item whose list empties is resolved', () => {
  const db=waiting(['thr_a']); applyEvents(db,'t',[req(30,'q2'),start(31,'w'),accept(32,'q2','w'),message(33,'ok','w'),done(34,'completed','w')]);
  db.prepare("UPDATE items SET status='deferred',answer=NULL,answer_source=NULL,wait_children='[\"thr_a\"]' WHERE question_seq=30").run();
  applyEvents(db,'t',wake(40,'thr_a','y','report'));
  expect(db.prepare("SELECT status,wait_children FROM items WHERE kind='mine' ORDER BY question_seq").all()).toEqual([{status:'answered',wait_children:null},{status:'deferred',wait_children:null}]); expect(updates(db)).toEqual([]);
 });
 it('an explicit answers_resolve in the waking turn wins and clears the list', () => {
  const db=waiting(['thr_a']); db.prepare("UPDATE items SET resolve_turn_id='y'").run();
  applyEvents(db,'t',wake(10,'thr_a','y','explicit'));
  expect(mine(db)).toMatchObject({status:'answered',answer:'explicit',answer_source:'agent',wait_children:null}); expect(updates(db)).toEqual([]);
 });
});

describe('asksOwner',()=>{
 it.each([
  ['Should I merge it?',true],['Мержить? Жду ответа.',true],['Готово. Мержить?',true],['Ship it (or wait?)',true],['**Merge now?**',true],['Ready?\n\nDetails below.',true],['Готово？',true],
  ['Done. See https://ci.example/run?id=4 for logs.',false],['Opened [the run](https://x.dev/r?id=1).',false],['Ran `git status?` fine.',false],
  ['Logs:\n```\nok? yes\n```\nAll green.',false],['> Can you merge?\n\nMerged as asked.',false],['Use ?query=1 in the URL.',false],['Готово, всё смёржено.',false],
 ] as const)('%j → %s',(text,expected)=>expect(asksOwner(text)).toBe(expected));
});
