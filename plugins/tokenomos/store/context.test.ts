import Database from 'better-sqlite3';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {MIGRATIONS} from './schema';
import {createStore} from './write';
import {currentContext,wakeCost,watchlist} from './context';
import {RECOVERED,BACKFILLED,type UsageRow} from '../contract';
let db:Database.Database,store:ReturnType<typeof createStore>;
const now=10_000_000;
const row=(o:Partial<UsageRow>={}):UsageRow=>({key:'r',ts:now-3600000,threadId:'t',projectId:'p',provider:'claude-code',providerThreadId:'s',model:'claude-sonnet-5-5',tier:'standard',tierRaw:'',promptTokens:300000,band:0,conv:'',freshIn:300000,cacheRead:0,cacheWriteShort:0,cacheWriteLong:0,output:0,reasoning:0,turnId:null,source:'claude-file',flags:0,...o});
beforeEach(()=>{db=new Database(':memory:');for(const m of MIGRATIONS)db.exec(m);store=createStore(db);store.noteThread({id:'t',providerId:'claude-code',title:'Thread'});});
afterEach(()=>db.close());
it('excludes aggregate, child and local-tool calls from current context',()=>{
 store.applyRows([row(),row({key:'child',ts:now-2,conv:'sub:x',promptTokens:999}),row({key:'local',ts:now-1,provider:'local-models',source:'local-log',promptTokens:999}),row({key:'recovered',ts:now,flags:RECOVERED}),row({key:'backfilled',ts:now,flags:BACKFILLED})]);
 expect(currentContext(db,'t')).toMatchObject({contextTokens:300000,lastCallAt:now-3600000,band:2});
});
it('overrides call context with newer snapshots and known compactions; unresolved compaction is unknown',()=>{
 store.applyRows([row()]);db.prepare('INSERT INTO context_last VALUES (?,?,?)').run('t',10000,now-100);
 expect(currentContext(db,'t')).toMatchObject({contextTokens:10000,band:0});
 db.prepare("INSERT INTO compactions(id,thread_id,at,after_tokens,after_known) VALUES ('c','t',?,5000,1)").run(now-50);
 expect(currentContext(db,'t')).toMatchObject({contextTokens:5000});
 db.prepare('UPDATE compactions SET after_known=0').run();expect(currentContext(db,'t')).toBeNull();
 db.prepare('UPDATE context_last SET at=?,used_tokens=1000').run(now);expect(currentContext(db,'t')).toMatchObject({contextTokens:1000});
});
it('invalidates earlier calls and snapshots at a clear boundary',()=>{
 store.applyRows([row()]);db.prepare('INSERT INTO context_last VALUES (?,?,?)').run('t',1000000,now-100);
 db.prepare('INSERT INTO context_cleared VALUES (?,?)').run('t',now-50);expect(currentContext(db,'t')).toBeNull();
 store.applyRows([row({key:'new',ts:now,promptTokens:1234})]);expect(currentContext(db,'t')).toMatchObject({contextTokens:1234});
});
it.each([[true,1,0,'short',5],[true,0,1,'long',60],[true,1,1,null,60],[false,1,0,null,60],[false,0,1,null,60]] as const)('handles split=%s short=%s long=%s', (writeSplit,cacheWriteShort,cacheWriteLong,kind,ttl)=>{
 store.applyRows([row({writeSplit,cacheWriteShort,cacheWriteLong,promptTokens:100000})]);
 expect(currentContext(db,'t')?.writeKind).toBe(kind);
 expect(wakeCost(db,'t',now)).toMatchObject({ttlMinutes:ttl,ttlSource:kind?'observed':'assumed',coldCostUsd:kind==='short'?0.25:0.4,warmCostUsd:0.01});
});
it('requires matching session and a TTL event at or after the call',()=>{
 store.applyRows([row({promptTokens:100000})]);
 const put=db.prepare('INSERT OR REPLACE INTO cache_ttl VALUES (?,?,?,?)');
 put.run('t','other',now,300000);expect(wakeCost(db,'t',now).ttlSource).toBe('assumed');
 put.run('t','s',now-3600001,300000);expect(wakeCost(db,'t',now).ttlSource).toBe('assumed');
 put.run('t','s',now,300000);expect(wakeCost(db,'t',now)).toMatchObject({ttlMinutes:5,ttlSource:'observed',cacheLikelyExpired:true,coldCostUsd:0.4});
 db.prepare("UPDATE usage_raw SET provider_thread_id='',write_split=1,cache_write_short=1").run();expect(wakeCost(db,'t',now)).toMatchObject({ttlSource:'assumed',ttlMinutes:60});
});
it('prices an OpenAI cold prompt as fresh input using the current context band and overrides',()=>{
 store.noteThread({id:'t',providerId:'codex'});store.applyRows([row({provider:'codex',model:'gpt-6.1-sol',promptTokens:10000,cacheWriteShort:100})]);
 const c=wakeCost(db,'t',now,{'gpt-6.1-sol':{input:7}});expect(c.coldCostUsd).toBeCloseTo(0.07);expect(c.ttlMinutes).toBe(30);expect(c.ttlSource).toBe('assumed');
});
it('distinguishes unknown thread from retained thread with unknown context, and uses strict idle > TTL',()=>{
 expect(()=>wakeCost(db,'missing',now)).toThrow('Unknown thread');expect(wakeCost(db,'t',now)).toMatchObject({contextTokens:null,cacheLikelyExpired:null,coldCostUsd:null});
 store.applyRows([row()]);expect(wakeCost(db,'t',now).cacheLikelyExpired).toBe(false);expect(wakeCost(db,'t',now+1).cacheLikelyExpired).toBe(true);
});
it('bounds candidates to 200 newest threads and output to 20, counting actual local calls without changing context',()=>{
 for(let i=0;i<205;i++){store.noteThread({id:`t${i}`,providerId:'claude-code'});store.applyRows([row({key:`r${i}`,threadId:`t${i}`,ts:now-i,model:i<5?'claude-sonnet-5-5':'unknown',promptTokens:300000})]);}
 // The five oldest high-priced threads are outside the 200-candidate cap.
 for(let i=200;i<205;i++)db.prepare("UPDATE usage_raw SET model='claude-sonnet-5-5',fresh_in=9999999 WHERE thread_id=?").run(`t${i}`);
 const result=watchlist(db,now,300000);expect(result.items).toHaveLength(20);expect(result.items.some(i=>Number(i.threadId.slice(1))>=200)).toBe(false);
 store.applyRows([row({key:'own',ts:now,promptTokens:300000}),row({key:'tool',ts:now,provider:'local-models',source:'local-log',model:'qwen',promptTokens:1000})]);
 const item=watchlist(db,now,300000).items.find(i=>i.threadId==='t');expect(item).toMatchObject({contextTokens:300000,callsLastHour:2});
});
it('upgrades provenance on a repeated call even if token totals do not grow',()=>{
 store.applyRows([row({providerThreadId:undefined,cacheWriteShort:1})]);
 expect(store.applyRows([row({providerThreadId:'s',writeSplit:true,cacheWriteShort:1})]).updated).toBe(1);
 expect(wakeCost(db,'t',now)).toMatchObject({ttlSource:'observed',ttlMinutes:5});
});
it('retains a newer snapshot with unknown pricing when no individual call is retained',()=>{
 db.prepare('INSERT INTO context_last VALUES (?,?,?)').run('t',12345,now);
 expect(currentContext(db,'t')).toMatchObject({contextTokens:12345,model:'unknown',lastCallAt:null});
 expect(wakeCost(db,'t',now)).toMatchObject({contextTokens:12345,idleMinutes:null,cacheLikelyExpired:null,coldCostUsd:null});
});
it('uses a newer context band for hypothetical costs without changing historical row bands',()=>{
 store.noteThread({id:'t',providerId:'codex'});store.applyRows([row({provider:'codex',model:'gpt-6.1-sol',band:2})]);
 db.prepare('INSERT INTO context_last VALUES (?,?,?)').run('t',10000,now);
 expect(wakeCost(db,'t',now).coldCostUsd).toBeCloseTo(0.02);
 expect(db.prepare('SELECT band FROM usage_raw').get()).toEqual({band:2});
});
