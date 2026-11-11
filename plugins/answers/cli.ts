import { cliCommand, defineCli, type BbPluginApi } from '@get-bb/plugin-sdk';
import { inputs, viewSchema, type ListInput, type ListResult } from './contract';
import type { z } from 'zod';
import type Database from 'better-sqlite3';
type Api = {
  list(input: ListInput): Promise<ListResult>;
  markRead(input: z.infer<typeof inputs.markRead>): {ok:true;count?:number};
  status(): unknown;
  db: Database.Database;
};
export function registerCli(bb: BbPluginApi, api: Api) {
  const thread={type:'string',description:'Filter by thread'} as const;
  bb.cli.register(defineCli({name:'answers',summary:'Questions, answers and saved messages',commands:{
    list:cliCommand({summary:'List up to 50 items',options:{view:{type:'enum',values:viewSchema.options,description:'Items view'},thread,json:{type:'boolean',description:'Return JSON'}},async run(i){
      const result=await api.list(inputs.list.parse({view:i.options.view ?? 'unread',threadId:i.options.thread}));
      return {exitCode:0,stdout:i.options.json ? JSON.stringify(result) : result.items.map(r=>`${r.id} ${r.status} ${r.threadTitle ?? r.threadId} ${r.question.replace(/\s+/g,' ').slice(0,160)}`).join('\n') || 'No items.'};
    }}),
    read:cliCommand({summary:'Mark items read',positionals:[{name:'ids',description:'Item ids',variadic:true}],options:{all:{type:'boolean',description:'Mark all answers read'},thread},run(i){
      if (i.options.all && i.positionals.ids.length) throw new Error('Choose ids or --all');
      if (!i.options.all && i.options.thread) throw new Error('--thread requires --all');
      const result=api.markRead(inputs.markRead.parse(i.options.all ? {all:true,threadId:i.options.thread} : {ids:i.positionals.ids})); return {exitCode:0,stdout:i.options.all ? `Marked ${result.count ?? 0} read.` : 'Marked read.'};
    }}),
    digest:cliCommand({summary:'Summarize answers and open questions',options:{since:{type:'string',description:'24h, 7d, or ISO date/time'},json:{type:'boolean',description:'Return JSON'}},async run(i){
      const raw=i.options.since ?? '24h', since=raw==='24h' ? Date.now()-86400000 : raw==='7d' ? Date.now()-7*86400000 : Date.parse(raw);
      if (!Number.isFinite(since) || (raw!=='24h' && raw!=='7d' && !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(raw))) throw new Error('Use --since 24h, 7d, or an ISO timestamp');
      type DigestRow={thread_id:string;question:string;answer:string|null;created_at:number;answered_at:number|null;failed_at:number|null};
      const section=(where:string,order:string,params:(number|string)[]=[])=>({total:(api.db.prepare(`SELECT count(*) AS n FROM items WHERE dismissed_at IS NULL AND thread_deleted=0 AND ${where}`).get(...params) as {n:number}).n,items:api.db.prepare(`SELECT thread_id,question,answer,created_at,answered_at,failed_at FROM items WHERE dismissed_at IS NULL AND thread_deleted=0 AND ${where} ORDER BY ${order} LIMIT 20`).all(...params) as DigestRow[]});
      const newAnswers=section("kind='mine' AND status='answered' AND answered_at>=?",'read_at IS NOT NULL,answered_at DESC,id DESC',[since]);
      const waiting=section("kind='mine' AND status IN ('waiting','deferred')",'failed_at IS NULL,created_at DESC,id DESC');
      const askedOfYou=section("kind='for_me' AND status='open'",'created_at DESC,id DESC');
      const data={newAnswers,waiting,askedOfYou};
      if(i.options.json)return {exitCode:0,stdout:JSON.stringify(data)};
      const ids=[...new Set(Object.values(data).flatMap(part=>part.items.map(r=>r.thread_id)))];
      const titles=new Map((ids.length ? await bb.sdk.threads.list({threadIds:ids,includeHidden:true,limit:200}) : []).map(t=>[t.id,t.title ?? t.id]));
      const age=(at:number)=>{const ms=Math.max(0,Date.now()-at);return ms<3600000 ? `${Math.floor(ms/60000)}m` : ms<86400000 ? `${Math.floor(ms/3600000)}h` : `${Math.floor(ms/86400000)}d`;};
      return {exitCode:0,stdout:Object.entries(data).map(([name,part])=>`${{newAnswers:'New answers',waiting:'Still waiting',askedOfYou:'Asked of you'}[name as keyof typeof data]} (${part.total})\n${part.items.map(r=>`${titles.get(r.thread_id) ?? r.thread_id} — ${((name==='newAnswers' ? r.answer : r.question) ?? '').replace(/\s+/g,' ').slice(0,160)} (${age(name==='newAnswers' ? r.answered_at! : r.created_at)})`).join('\n')}${part.total>20 ? `\n+${part.total-20} more` : ''}`).join('\n\n')};
    }}),
    status:cliCommand({summary:'Show counts, tracked threads and ingestion errors',run(){return {exitCode:0,stdout:JSON.stringify(api.status())};}}),
  }}));
}
