import { createHash, randomUUID } from 'node:crypto';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { rpcContract, inputs, idSchema, itemSchema, ITEMS_TAG, COUNTS_TAG, type Item, type ListInput, type Counts } from './contract';
import { migrations } from './schema';
import { cap } from './ingest';
import { createDriver } from './driver';
import { registerCli } from './cli';

export const INSTRUCTIONS = "Answers plugin: user messages are tracked as questions paired with your final reply. If the answer will come later (e.g. delegated), call answers_defer. When a later turn delivers it, call answers_list, then answers_resolve, and put the answer in your final message. Use answers_ask for small non-blocking questions to the user; blocking decisions stay in Work Board.";
const toolInputs = {
  list: z.object({}).strict(),
  defer: z.object({id:idSchema.optional(),note:z.string().max(2000).optional()}).strict(),
  resolve: z.object({id:idSchema}).strict(),
  ask: z.object({question:z.string().trim().min(1).max(2000)}).strict(),
};
type Row = Record<string, any>;
export default function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db,migrations);
  const invalidate = () => bb.rpc.experimental_invalidate([ITEMS_TAG,COUNTS_TAG]);
  const driver = createDriver(bb,db,invalidate);
  const sending = new Set<string>();
  const get = (id: string): Row => {
    const item = db.prepare('SELECT * FROM items WHERE id=?').get(id) as Row | undefined;
    if (!item) throw new Error('item not found');
    return item;
  };
  const commit = (sql: string, ...params: (string | number | null)[]) => {
    db.prepare(sql).run(...params); invalidate(); return {ok:true as const};
  };
  function counts(): Counts {
    return db.prepare(`SELECT
      count(CASE WHEN kind='mine' AND status='answered' AND read_at IS NULL THEN 1 END) AS unread,
      count(CASE WHEN kind='mine' AND status IN ('waiting','deferred') THEN 1 END) AS waiting,
      count(CASE WHEN kind='for_me' AND status='open' THEN 1 END) AS forMe
      FROM items WHERE dismissed_at IS NULL`).get() as Counts;
  }
  async function list(raw: ListInput) {
    const p = inputs.list.parse(raw);
    const views = {
      unread:"kind='mine' AND status='answered' AND read_at IS NULL",
      waiting:"kind='mine' AND status IN ('waiting','deferred')",
      for_me:"kind='for_me' AND status='open'", pinned:'pinned=1', saved:"kind='saved'", all:'1=1',
    };
    const where = [views[p.view]], args: (string | number)[] = [];
    if (!['all','pinned'].includes(p.view)) where.push('dismissed_at IS NULL');
    for (const [key,value] of [['thread_id',p.threadId],['project_id',p.projectId]] as const) {
      if (value !== undefined) {where.push(`${key}=?`); args.push(value);}
    }
    if (p.query) {where.push("(instr(lower(question),lower(?))>0 OR instr(lower(coalesce(answer,'')),lower(?))>0)"); args.push(p.query,p.query);}
    if (p.cursor) {const [at,id]=p.cursor.split('|'); where.push('(created_at<? OR (created_at=? AND id<?))'); args.push(Number(at),Number(at),id);}
    const limit = p.limit ?? 50;
    const rows = db.prepare(`SELECT * FROM items WHERE ${where.join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT ?`).all(...args,limit+1) as Row[];
    const more = rows.length>limit; rows.splice(limit);
    const titles = new Map<string,string>();
    const ids = [...new Set(rows.filter(r=>!r.thread_deleted).map(r=>r.thread_id as string))];
    if (ids.length) for (const t of await bb.sdk.threads.list({threadIds:ids,includeHidden:true,limit:200})) titles.set(t.id,t.title ?? t.id);
    const names = new Map<string,string>();
    if (rows.some(r=>r.project_id)) for (const p of await bb.sdk.projects.list()) names.set(p.id,p.name);
    const items: Item[] = rows.map(row => {
      const value: Row = {};
      for (const [key,v] of Object.entries(row)) if (key !== 'dedupe_key') value[key.replace(/_([a-z])/g,(_,c:string)=>c.toUpperCase())]=v;
      return itemSchema.parse({...value,pinned:!!row.pinned,threadDeleted:!!row.thread_deleted,threadTitle:titles.get(row.thread_id) ?? null,projectName:names.get(row.project_id) ?? null});
    });
    const last = rows.at(-1);
    return {items,nextCursor:more && last ? `${last.created_at}|${last.id}` : null};
  }
  function markRead(raw: z.infer<typeof inputs.markRead>) {
    const p=inputs.markRead.parse(raw), now=Date.now();
    if ('ids' in p) return commit(`UPDATE items SET read_at=?,updated_at=? WHERE id IN (${p.ids.map(()=>'?').join(',')})`,now,now,...p.ids);
    return commit(`UPDATE items SET read_at=?,updated_at=? WHERE kind='mine' AND status='answered'${p.threadId ? ' AND thread_id=?' : ''}`,now,now,...(p.threadId ? [p.threadId] : []));
  }
  const handlers = {
    list, counts,
    markRead,
    setPinned(raw: z.infer<typeof inputs.setPinned>) {const p=inputs.setPinned.parse(raw); get(p.id); return commit('UPDATE items SET pinned=?,updated_at=? WHERE id=?',Number(p.pinned),Date.now(),p.id);},
    setDismissed(raw: z.infer<typeof inputs.setDismissed>) {const p=inputs.setDismissed.parse(raw); get(p.id); return commit('UPDATE items SET dismissed_at=?,updated_at=? WHERE id=?',p.dismissed ? Date.now() : null,Date.now(),p.id);},
    async reply(raw: z.infer<typeof inputs.reply>) {
      const p=inputs.reply.parse(raw), item=get(p.id);
      if (item.thread_deleted || item.kind==='saved') throw new Error('item cannot receive replies');
      if (sending.has(p.id)) throw new Error('reply already in flight');
      if (item.kind==='for_me' && item.status!=='open') throw new Error('question already replied');
      sending.add(p.id);
      try {
        let result;
        try {
          result=await bb.sdk.threads.send({threadId:item.thread_id,mode:'auto',input:[{type:'text',mentions:[],text:`Re: "${item.question.slice(0,120)}"\n\n${p.text}`} ]});
          if (!result.ok) throw new Error('send failed');
        } catch {throw new Error('Delivery uncertain — check the thread before retrying');}
        if (item.kind==='for_me') commit("UPDATE items SET status='replied',answer=?,answer_source='user',updated_at=? WHERE id=? AND status='open'",p.text,Date.now(),p.id);
        return {delivery:result.delivery};
      } finally {sending.delete(p.id);}
    },
    async save(raw: z.infer<typeof inputs.save>) {
      const p=inputs.save.parse(raw);
      const key=createHash('sha256').update(`${p.threadId}|${p.seq}|${p.text}`).digest('hex');
      const existing=db.prepare("SELECT id FROM items WHERE kind='saved' AND dedupe_key=?").get(key) as {id:string} | undefined;
      if (existing) return existing;
      const thread=await bb.sdk.threads.get({threadId:p.threadId});
      const id='ans_'+randomUUID(), now=Date.now();
      commit("INSERT OR IGNORE INTO items(id,kind,thread_id,project_id,status,question,question_seq,answer,read_at,dedupe_key,created_at,updated_at) VALUES (?,'saved',?,?,'saved',?,?,?,?,?,?,?)",id,p.threadId,thread.projectId,cap(p.text,4000),p.seq,p.text,now,key,now,now);
      return db.prepare('SELECT id FROM items WHERE dedupe_key=?').get(key) as {id:string};
    },
  };
  bb.rpc.register(rpcContract,handlers);
  for (const method of Object.keys(toolInputs) as (keyof typeof toolInputs)[]) {
    bb.agents.registerTool({name:`answers_${method}`,description:{list:'List this thread’s pending questions.',defer:'Defer a user question until a later turn.',resolve:'Use this turn’s final message to answer a pending question.',ask:'Ask the user a small non-blocking question.'}[method],parameters:toolInputs[method],
      async execute(raw,ctx) {
        const p=toolInputs[method].parse(raw);
        return driver.withThread(ctx.threadId,() => {
          const now=Date.now();
          if (method==='list') {
            const rows=db.prepare("SELECT id,question,note,created_at FROM items WHERE thread_id=? AND kind='mine' AND status IN ('waiting','deferred') ORDER BY created_at DESC LIMIT 20").all(ctx.threadId) as Row[];
            return cap(rows.map(r=>`${r.id} ${Math.max(0,Math.floor((now-r.created_at)/1000))}s ${r.question.slice(0,160)}${r.note ? ' — '+r.note : ''}`).join('\n') || 'No pending questions.',2000);
          }
          if (method==='ask') {
            const id='ans_'+randomUUID();
            commit("INSERT INTO items(id,kind,thread_id,project_id,status,question,created_at,updated_at) VALUES (?,'for_me',?,?,'open',?,?,?)",id,ctx.threadId,ctx.projectId ?? null,(p as z.infer<typeof toolInputs.ask>).question,now,now);
            return id;
          }
          const params=p as {id?:string;note?:string};
          const item=params.id ? get(params.id) : db.prepare("SELECT * FROM items WHERE thread_id=? AND kind='mine' AND status='waiting' ORDER BY question_seq DESC LIMIT 1").get(ctx.threadId) as Row | undefined;
          if (!item || item.thread_id!==ctx.threadId || item.kind!=='mine' || !['waiting','deferred'].includes(item.status)) throw new Error('pending question not found in calling thread');
          if (method==='defer') commit("UPDATE items SET status='deferred',note=?,updated_at=? WHERE id=?",params.note ?? null,now,item.id);
          else {
            const state=db.prepare('SELECT active_turn_id FROM threads_state WHERE thread_id=?').get(ctx.threadId) as {active_turn_id:string|null};
            if (!state?.active_turn_id) throw new Error('no active turn');
            commit('UPDATE items SET resolve_turn_id=?,candidate=NULL,candidate_seq=NULL,updated_at=? WHERE id=?',state.active_turn_id,now,item.id);
          }
          return item.id as string;
        });
      },
    });
  }
  bb.agents.contributeInstructions(() => INSTRUCTIONS);
  registerCli(bb,{list,markRead,status:()=>({counts:counts(),trackedThreads:(db.prepare('SELECT count(*) AS n FROM threads_state').get() as {n:number}).n,errors:db.prepare('SELECT thread_id,last_error FROM threads_state WHERE last_error IS NOT NULL').all()})});
  bb.events.on('experimental_thread.events',({thread})=>driver.schedule(thread.id).catch(e=>bb.log.warn(`Answers ingest: ${String(e)}`)));
  bb.events.on('thread.deleted',({thread})=>driver.deleteThread(thread.id));
  const startup = driver.reconcile().catch(e=>bb.log.warn(`Answers discovery: ${String(e)}`));
  bb.onDispose(async()=>{await driver.dispose(); await startup;});
}
