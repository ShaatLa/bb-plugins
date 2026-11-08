import { afterEach, describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrations } from './schema';
import { applyEvents, cap, type Event } from './ingest';
const databases: Database.Database[] = [];
const setup = () => { const db = new Database(':memory:'); db.exec(migrations[0]); databases.push(db); return db; };
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
 it('pairs a plain question', () => {const db=setup(); applyEvents(db,'t',[req(1),start(),accept(),message(),done()]); expect(row(db)).toMatchObject({status:'answered',answer:'answer',answer_seq:4,answer_source:'turn'});});
 it('persists candidates across page splits and reapplication is idempotent', () => {const db=setup(); const page=[req(1),start(),accept(),message()]; applyEvents(db,'t',page); applyEvents(db,'t',page); expect(row(db).status).toBe('waiting'); applyEvents(db,'t',[done()]); expect(rows(db)).toHaveLength(1); expect(row(db).answer_seq).toBe(4);});
 it.each([{initiator:'agent'},{initiator:'system'},{originPluginId:'answers'},{originPluginId:'slots'},{senderThreadId:'sender'},{input:[{type:'text',text:'  '}]},{input:[{type:'text',text:'/help',mentions:[{start:0,end:5,resource:{kind:'command'}}]}]}])('ignores non-questions %j', extra => {const db=setup(); applyEvents(db,'t',[req(1,'r',extra)]); expect(rows(db)).toHaveLength(0);});
 it('keeps a slash command with additional text', () => {const db=setup(); applyEvents(db,'t',[req(1,'r',{input:[{type:'text',text:'/help explain',mentions:[{start:0,end:5,resource:{kind:'command'}}]}]})]); expect(rows(db)).toHaveLength(1);});
 it('steers into an agent turn using only messages after the question', () => {const db=setup(); applyEvents(db,'t',[start(1),message(2,'old'),req(3),accept(4),done(5)]); expect(row(db).status).toBe('waiting'); applyEvents(db,'t',[start(6),accept(7),message(8,'new'),done(9)]); expect(row(db).answer).toBe('new');});
 it('ignores nested starts, messages and completions', () => {const db=setup(); applyEvents(db,'t',[req(1),start(),accept(),message(),ev(5,'turn/started','nested',{parentToolCallId:'tool'}),message(6,'nested','nested',{parentToolCallId:'tool'}),done(7,'completed','nested')]); expect(row(db).candidate).toBe('answer'); expect(db.prepare('SELECT active_turn_id FROM threads_state').get()).toEqual({active_turn_id:'x'}); applyEvents(db,'t',[done(8)]); expect(row(db).answer).toBe('answer');});
 it.each(['failed','interrupted'])('%s keeps interim and waiting', status => {const db=setup(); applyEvents(db,'t',[req(1),start(),accept(),message(),done(5,status)]); expect(row(db)).toMatchObject({status:'waiting',interim:'answer',interim_seq:4,answer:null,candidate:null});});
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
 it('caps text with the chat suffix', () => {expect(cap('x'.repeat(21000),20000)).toHaveLength(20000); expect(cap('x'.repeat(5000),4000)).toMatch(/… \(truncated, open in chat\)$/);});
});
