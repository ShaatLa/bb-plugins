import { randomUUID } from 'node:crypto';
import { NOTIFICATIONS_CHANNEL, NOTICE_THREAD } from './contract';
import type Database from 'better-sqlite3';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { createPreferences } from './settings';
import { ATTENTION_SQL } from './ingest';
import { inlineCommentPreview } from './inline-comments';

type Row={id:string;kind:string;status:string;thread_id:string;question:string;answer:string|null;failed_at:number|null;asks:number;urgency:string|null;reminders:number;reminded_at:number|null;created_at:number;trigger_source:string|null;project_id:string|null;notice:number};
const COLS='id,kind,status,thread_id,question,answer,failed_at,asks,urgency,reminders,reminded_at,created_at,trigger_source,project_id,EXISTS(SELECT 1 FROM notices WHERE notices.id=items.id) AS notice';
type Level='off'|'asked'|'questions'|'all';
const clean=(s:string,n:number)=>s.replace(/\s+/g,' ').trim().slice(0,n);
export function createNotifier(bb:BbPluginApi,db:Database.Database) {
 const settings=createPreferences(bb);
 const notifiers=new Map<string,number>();
 const beat=({clientId,canNotify}:{clientId:string;canNotify:boolean})=>{
  for(const [id,at] of notifiers) if(Date.now()-at>=45000) notifiers.delete(id);
  if(canNotify) notifiers.set(clientId,Date.now()); else notifiers.delete(clientId);
  return {ok:true as const};
 };
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
 // An update that asks nothing is never pushed (it collapses into a quiet group); one that asks counts as a question.
 const matches=(r:Row)=>r.urgency!=='low' && (r.kind!=='update' || !!r.asks) && (level==='all' || (level==='asked' && r.kind==='for_me') || (level==='questions' && (r.kind==='for_me' || r.kind==='update' || (r.kind==='mine' && (r.question.includes('?') || r.question.includes('？'))))));
 const rows=(ids:string[])=>ids.length ? db.prepare(`SELECT ${COLS} FROM items WHERE id IN (${ids.map(()=>'?').join(',')}) AND ${ATTENTION_SQL}`).all(...ids) as Row[] : [];
 const held=(end:number,ids:string[])=>db.transaction(()=>{
  const old=db.prepare("SELECT value FROM notify_meta WHERE key='held_for'").get() as {value:number}|undefined;
  if (old?.value!==end) {db.prepare('UPDATE items SET notify_state=0 WHERE notify_state=2').run(); db.prepare("INSERT INTO notify_meta(key,value) VALUES ('held_for',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(end);}
  for (const id of ids) db.prepare('UPDATE items SET notify_state=2 WHERE id=?').run(id);
 })();
 const log=(e:unknown)=>{if (Date.now()-lastError>=3600000 || !lastError) {lastError=Date.now(); bb.log.debug(`Agent Hub push unavailable: ${String(e)}`);}};
 const push=async(input:{title:string;body:string;threadId?:string})=>{
  if([...notifiers.values()].some(at=>Date.now()-at<45000)) {
   try {await bb.realtime.publish(NOTIFICATIONS_CHANNEL,{...input,id:randomUUID()});return;} catch(e){log(e);}
  }
  const outputSchema=z.object({channels:z.array(z.string())});
  try {const result=outputSchema.parse(await bb.sdk.plugins.callRpc({pluginId:'push-notifications',method:'notifications.send',input,outputSchema})); if (!result.channels.length) log('no channels');}
  catch(e){log(e);}
 };
 const serial=(task:()=>Promise<void>|void)=>{chain=chain.then(task).catch(e=>bb.log.warn(`Agent Hub notify: ${String(e)}`)); return chain;};
 const arm=()=>{if(endTimer) clearTimeout(endTimer); const end=windowEnd(); if(end!==null){endTimer=setTimeout(()=>void serial(summary),Math.max(0,end-Date.now())); endTimer.unref();}};
 async function summary(){
  if(disposed) return;
  const old=db.prepare("SELECT value FROM notify_meta WHERE key='held_for'").get() as {value:number}|undefined;
  if (!old || old.value>Date.now()) {arm(); return;}
  const selected=db.prepare(`SELECT ${COLS} FROM items WHERE notify_state=2 AND ${ATTENTION_SQL}`).all() as Row[];
  const valid=selected.filter(matches),chosen=valid.filter(r=>r.urgency!=='blocking'),threads=new Set(chosen.map(r=>r.thread_id)).size;
  db.transaction(()=>{db.prepare('UPDATE items SET notify_state=0 WHERE notify_state=2').run();db.prepare("DELETE FROM notify_meta WHERE key='held_for'").run();})();
  for(const r of valid.filter(r=>r.urgency==='blocking')) await sendOne(r);
  if(chosen.length && level!=='off') await push({title:'Agent Hub',body:`While you were away: ${chosen.length} new in ${threads} threads`});
  arm();
 }
 // A notice leads with its own title; its project and sender follow.
 const noticePush=async(r:Row)=>{
  let project='';
  try {project=(await bb.sdk.projects.list()).find(p=>p.id===r.project_id)?.name ?? '';} catch(e){log(e);}
  return {title:clean(r.question,80)||'Agent Hub',body:clean([project,r.trigger_source].filter(Boolean).join(' · '),180)||'Report',...(r.thread_id!==NOTICE_THREAD ? {threadId:r.thread_id} : {})};
 };
 async function sendOne(r:Row) {
  if(r.notice) {await push(await noticePush(r));return;}
  const titles=await bb.sdk.threads.list({threadIds:[r.thread_id],includeHidden:true,limit:1});
  const minutes=Math.max(1,Math.floor((Date.now()-r.created_at)/60000)),age=minutes<60 ? `${minutes}m` : minutes<1440 ? `${Math.floor(minutes/60)}h` : `${Math.floor(minutes/1440)}d`;
  const title=clean(titles[0]?.title ?? 'Agent Hub',80)||'Agent Hub',body=r.reminders>0 && r.reminded_at!==null ? `Still waiting (${age}): ${r.question}` : r.kind==='for_me' ? r.question : r.failed_at!==null && r.status!=='answered' ? `Turn failed: ${r.question}` : r.answer ?? r.question;
  await push({title:r.urgency==='blocking' ? `Blocking · ${title}` : title,body:clean(inlineCommentPreview(body),180),threadId:r.thread_id});
 }
 async function flush(){
  flushTimer=undefined; if(disposed || !queue.size) return;
  const batch=rows([...queue]).filter(matches); queue.clear();
  const end=windowEnd(); if(end!==null){held(end,batch.map(r=>r.id));arm();return;}
  if(!batch.length)return;
  const ids=[...new Set(batch.map(r=>r.thread_id))],real=ids.filter(id=>id!==NOTICE_THREAD);
  const titles=new Map((real.length ? await bb.sdk.threads.list({threadIds:real,includeHidden:true,limit:200}) : []).map(t=>[t.id,t.title ?? 'Agent Hub']));
  if(batch.length===1 && batch[0].notice) await push(await noticePush(batch[0]));
  else if(batch.length===1){const r=batch[0],body=r.kind==='for_me'?r.question:r.failed_at!==null && r.status!=='answered'?`Turn failed: ${r.question}`:r.answer ?? r.question; await push({title:clean(titles.get(r.thread_id) ?? 'Agent Hub',80)||'Agent Hub',body:clean(inlineCommentPreview(body),180),threadId:r.thread_id});}
  else await push({title:`${batch.length} new in Agent Hub`,body:clean(ids.slice(0,3).map(id=>titles.get(id) ?? 'Agent Hub').join(', '),180),...(ids.length===1 && real.length===1?{threadId:ids[0]}:{})});
 }
 function run(){return serial(async()=>{
  if(disposed)return;
  const selected=db.transaction(()=>{const pending=db.prepare(`SELECT ${COLS} FROM items WHERE notify_state=1 ORDER BY rowid`).all() as Row[];db.prepare('UPDATE items SET notify_state=0 WHERE notify_state=1').run();return pending;})();
  const valid=rows(selected.map(r=>r.id)).filter(matches);
  const end=windowEnd(); if(end!==null){held(end,valid.map(r=>r.id));arm();return;}
  for(const r of valid) {if(r.urgency==='blocking') {queue.delete(r.id);await sendOne(r);} else queue.add(r.id);}
  if(queue.size && !flushTimer){flushTimer=setTimeout(()=>void serial(flush),10000);flushTimer.unref();}
 });}
 settings.onChange((next)=>{level=next.notify as Level;quiet=next.quietHours;if(level==='off'){queue.clear();if(flushTimer)clearTimeout(flushTimer);flushTimer=undefined;db.prepare('UPDATE items SET notify_state=0 WHERE notify_state=2').run();db.prepare("DELETE FROM notify_meta WHERE key='held_for'").run();} arm();void run();});
 chain=settings.get().then(value=>{level=value.notify as Level;quiet=value.quietHours;db.transaction(()=>{db.prepare('UPDATE items SET notify_state=0 WHERE notify_state=1').run();const old=db.prepare("SELECT value FROM notify_meta WHERE key='held_for'").get() as {value:number}|undefined;if(old && old.value!==windowEnd()){db.prepare('UPDATE items SET notify_state=0 WHERE notify_state=2').run();db.prepare("DELETE FROM notify_meta WHERE key='held_for'").run();}})();arm();}).catch(log);
 return {run,settings,beat,dispose:async()=>{disposed=true;if(flushTimer)clearTimeout(flushTimer);if(endTimer)clearTimeout(endTimer);await chain;}};
}
