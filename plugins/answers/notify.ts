import type Database from 'better-sqlite3';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { ATTENTION_SQL } from './ingest';

type Row={id:string;kind:string;status:string;thread_id:string;question:string;answer:string|null;failed_at:number|null};
type Level='off'|'asked'|'questions'|'all';
const clean=(s:string,n:number)=>s.replace(/\s+/g,' ').trim().slice(0,n);
const quietSchema=z.string().regex(/^(?:([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d)?$/).refine(s=>!s || s.slice(0,5)!==s.slice(6),'Quiet hours must have different endpoints');
export function createNotifier(bb:BbPluginApi,db:Database.Database) {
 const settings=bb.settings.define({notify:{type:'select',label:'Push notifications',options:['off','asked','questions','all'],default:'asked'},quietHours:{type:'string',label:'Quiet hours (HH:MM-HH:MM)',default:'',experimental_schema:quietSchema}});
 let level:Level='asked',quiet='',disposed=false,chain=Promise.resolve(),flushTimer:ReturnType<typeof setTimeout>|undefined,endTimer:ReturnType<typeof setTimeout>|undefined,lastError=0;
 const queue=new Set<string>();
 const windowEnd=(now=Date.now())=>{
  if (!quiet) return null;
  const [start,end]=quiet.split('-').map(s=>Number(s.slice(0,2))*60+Number(s.slice(3)));
  const date=new Date(now),minute=date.getHours()*60+date.getMinutes();
  if (start<end ? minute<start || minute>=end : minute<start && minute>=end) return null;
  const until=new Date(now); until.setHours(Math.floor(end/60),end%60,0,0);
  if (until.getTime()<=now) until.setDate(until.getDate()+1);
  return until.getTime();
 };
 const matches=(r:Row)=>level==='all' || (level==='asked' && r.kind==='for_me') || (level==='questions' && (r.kind==='for_me' || (r.kind==='mine' && (r.question.includes('?') || r.question.includes('？')))));
 const rows=(ids:string[])=>ids.length ? db.prepare(`SELECT id,kind,status,thread_id,question,answer,failed_at FROM items WHERE id IN (${ids.map(()=>'?').join(',')}) AND ${ATTENTION_SQL}`).all(...ids) as Row[] : [];
 const held=(end:number,ids:string[])=>db.transaction(()=>{
  const old=db.prepare("SELECT value FROM notify_meta WHERE key='held_for'").get() as {value:number}|undefined;
  if (old?.value!==end) {db.prepare('UPDATE items SET notify_state=0 WHERE notify_state=2').run(); db.prepare("INSERT INTO notify_meta(key,value) VALUES ('held_for',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(end);}
  for (const id of ids) db.prepare('UPDATE items SET notify_state=2 WHERE id=?').run(id);
 })();
 const log=(e:unknown)=>{if (Date.now()-lastError>=3600000 || !lastError) {lastError=Date.now(); bb.log.debug(`Answers push unavailable: ${String(e)}`);}};
 const push=async(input:{title:string;body:string;threadId?:string})=>{
  const outputSchema=z.object({channels:z.array(z.string())});
  try {const result=outputSchema.parse(await bb.sdk.plugins.callRpc({pluginId:'push-notifications',method:'notifications.send',input,outputSchema})); if (!result.channels.length) log('no channels');}
  catch(e){log(e);}
 };
 const serial=(task:()=>Promise<void>|void)=>{chain=chain.then(task).catch(e=>bb.log.warn(`Answers notify: ${String(e)}`)); return chain;};
 const arm=()=>{if(endTimer) clearTimeout(endTimer); const end=windowEnd(); if(end!==null){endTimer=setTimeout(()=>void serial(summary),Math.max(0,end-Date.now())); endTimer.unref();}};
 async function summary(){
  if(disposed) return;
  const old=db.prepare("SELECT value FROM notify_meta WHERE key='held_for'").get() as {value:number}|undefined;
  if (!old || old.value>Date.now()) {arm(); return;}
  const selected=db.prepare(`SELECT id,thread_id,kind,status,question,answer,failed_at FROM items WHERE notify_state=2 AND ${ATTENTION_SQL}`).all() as Row[];
  const chosen=selected.filter(matches),threads=new Set(chosen.map(r=>r.thread_id)).size;
  db.transaction(()=>{db.prepare('UPDATE items SET notify_state=0 WHERE notify_state=2').run();db.prepare("DELETE FROM notify_meta WHERE key='held_for'").run();})();
  if(chosen.length && level!=='off') await push({title:'Answers',body:`While you were away: ${chosen.length} new in ${threads} threads`});
  arm();
 }
 async function flush(){
  flushTimer=undefined; if(disposed || !queue.size) return;
  const batch=rows([...queue]).filter(matches); queue.clear();
  const end=windowEnd(); if(end!==null){held(end,batch.map(r=>r.id));arm();return;}
  if(!batch.length)return;
  const ids=[...new Set(batch.map(r=>r.thread_id))];
  const titles=new Map((await bb.sdk.threads.list({threadIds:ids,includeHidden:true,limit:200})).map(t=>[t.id,t.title ?? 'Answers']));
  if(batch.length===1){const r=batch[0],body=r.kind==='for_me'?r.question:r.failed_at!==null && r.status!=='answered'?`Turn failed: ${r.question}`:r.answer ?? r.question; await push({title:clean(titles.get(r.thread_id) ?? 'Answers',80)||'Answers',body:clean(body,180),threadId:r.thread_id});}
  else await push({title:`${batch.length} new in Answers`,body:clean(ids.slice(0,3).map(id=>titles.get(id) ?? 'Answers').join(', '),180),...(ids.length===1?{threadId:ids[0]}:{})});
 }
 function run(){return serial(()=>{
  if(disposed)return;
  const selected=db.transaction(()=>{const pending=db.prepare('SELECT id,kind,status,thread_id,question,answer,failed_at FROM items WHERE notify_state=1 ORDER BY rowid').all() as Row[];db.prepare('UPDATE items SET notify_state=0 WHERE notify_state=1').run();return pending;})();
  const valid=rows(selected.map(r=>r.id)).filter(matches);
  const end=windowEnd(); if(end!==null){held(end,valid.map(r=>r.id));arm();return;}
  for(const r of valid)queue.add(r.id);
  if(queue.size && !flushTimer){flushTimer=setTimeout(()=>void serial(flush),10000);flushTimer.unref();}
 });}
 settings.onChange((next)=>{level=next.notify as Level;quiet=next.quietHours;if(level==='off'){queue.clear();if(flushTimer)clearTimeout(flushTimer);flushTimer=undefined;db.prepare('UPDATE items SET notify_state=0 WHERE notify_state=2').run();db.prepare("DELETE FROM notify_meta WHERE key='held_for'").run();} arm();void run();});
 chain=settings.get().then(value=>{level=value.notify as Level;quiet=value.quietHours;db.transaction(()=>{db.prepare('UPDATE items SET notify_state=0 WHERE notify_state=1').run();const old=db.prepare("SELECT value FROM notify_meta WHERE key='held_for'").get() as {value:number}|undefined;if(old && old.value!==windowEnd()){db.prepare('UPDATE items SET notify_state=0 WHERE notify_state=2').run();db.prepare("DELETE FROM notify_meta WHERE key='held_for'").run();}})();arm();}).catch(log);
 return {run,dispose:async()=>{disposed=true;if(flushTimer)clearTimeout(flushTimer);if(endTimer)clearTimeout(endTimer);await chain;}};
}
