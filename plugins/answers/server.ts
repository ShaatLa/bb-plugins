import { createHash, randomUUID } from 'node:crypto';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { rpcContract, inputs, idSchema, itemSchema, ITEMS_TAG, COUNTS_TAG, POOLS_TAG, type Item, type ListInput, type Counts, type Attachment, type SendOptions } from './contract';
import { migrations } from './schema';
import { cap, QUESTION_SQL, ATTENTION_SQL, failRequest } from './ingest';
import { createDriver } from './driver';
import { registerCli } from './cli';
import { createNotifier } from './notify';

export const INSTRUCTIONS = "Answers plugin: user messages are tracked as questions paired with your final reply. If the answer will come later (e.g. delegated), call answers_defer. When a later turn delivers it, call answers_list, then answers_resolve, and put the answer in your final message. Use answers_ask for small non-blocking questions to the user; blocking decisions stay in Work Board. answers_ask accepts 1–6 unique short options for quick replies.";
const toolInputs = {
  list: z.object({}).strict(),
  defer: z.object({id:idSchema.optional(),note:z.string().max(2000).optional()}).strict(),
  resolve: z.object({id:idSchema}).strict(),
  ask: z.object({question:z.string().trim().min(1).max(2000),options:z.array(z.string().trim().min(1).max(80)).min(1).max(6).refine(v=>new Set(v).size===v.length,'Options must be unique').optional()}).strict(),
};
type Row = Record<string, any>;
export function buildReplyMessage(entries: readonly {quote:string;note:string}[]): string {
  const message = entries.filter(({quote,note}) => quote || note.trim()).map(({quote,note}) => {
    if (quote.length > 20000) throw new Error('Quote exceeds 20,000 characters');
    if (!quote) return note;
    const quoted = quote.split('\n').map(line=>line ? '> '+line : '>').join('\n');
    return quoted + (note ? '\n\n'+note : '');
  }).join('\n\n');
  if (message.length > 32000) throw new Error('Message exceeds 32,000 characters — split the pool');
  return message;
}
export default function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db,migrations);
  const invalidate = () => bb.rpc.experimental_invalidate([ITEMS_TAG,COUNTS_TAG]);
  const invalidatePools = () => bb.rpc.experimental_invalidate([POOLS_TAG]);
  const notifier=createNotifier(bb,db);
  const onAttention = () => {void notifier.run();};
  const driver = createDriver(bb,db,() => {invalidate(); invalidatePools(); onAttention();});
  const sending = new Set<string>();
  // Drafts wait in the thread's queue until the user sends them from the chat, like bb's built-in Drafts plugin.
  bb.experimental_hooks.on('message.dispatch',ctx=>{
    const data=ctx.experimental_submission?.pluginId===bb.pluginId ? ctx.experimental_submission.data : null;
    const draft=!!data && typeof data==='object' && !Array.isArray(data) && data.kind==='draft';
    const head=ctx.queuedMessages[0], held=head?.waitingOn?.kind==='plugin' && head.waitingOn.pluginId===bb.pluginId;
    return draft || held ? {action:'wait',reason:'Draft'} : {action:'proceed'};
  });
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
      count(CASE WHEN kind='mine' AND status='answered' AND read_at IS NULL AND snoozed_until IS NULL THEN 1 END) AS unread,
      count(CASE WHEN kind='mine' AND status IN ('waiting','deferred') THEN 1 END) AS waiting,
      count(CASE WHEN kind='for_me' AND status='open' THEN 1 END) AS forMe,
      count(CASE WHEN ${ATTENTION_SQL} THEN 1 END) AS inbox
      FROM items WHERE dismissed_at IS NULL`).get() as Counts;
  }
  async function list(raw: ListInput) {
    const p = inputs.list.parse(raw);
    const views = {
      // Same set as the Inbox: unread answers and open agent questions.
      unread:ATTENTION_SQL,
      waiting:"kind='mine' AND status IN ('waiting','deferred')",
      for_me:"kind='for_me' AND status='open'", pinned:'pinned=1', saved:"((kind='saved' AND dismissed_at IS NULL) OR pinned=1)", all:'1=1',
    };
    const where = [views[p.view]], args: (string | number)[] = [];
    if (!['all','pinned','saved'].includes(p.view)) where.push('dismissed_at IS NULL');
    for (const [key,value] of [['thread_id',p.threadId],['project_id',p.projectId]] as const) {
      if (value !== undefined) {where.push(`${key}=?`); args.push(value);}
    }
    // Agent questions to the user count as questions too.
    if (p.questions) where.push(`(kind='for_me' OR ${QUESTION_SQL})`);
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
      return itemSchema.parse({...value,snoozedUntil:row.snoozed_until,failedAt:row.failed_at,likelyInterim:!!row.likely_interim,options:row.options===null ? null : JSON.parse(row.options),taskKey:row.task_key,pinned:!!row.pinned,threadDeleted:!!row.thread_deleted,threadTitle:titles.get(row.thread_id) ?? null,projectName:names.get(row.project_id) ?? null});
    });
    const last = rows.at(-1);
    return {items,nextCursor:more && last ? `${last.created_at}|${last.id}` : null};
  }
  function markRead(raw: {all:true;threadId?:string}): {ok:true;batch:string|null;count:number};
  function markRead(raw: z.infer<typeof inputs.markRead>): {ok:true;batch?:string|null;count?:number};
  function markRead(raw: z.infer<typeof inputs.markRead>) {
    const p=inputs.markRead.parse(raw), now=Date.now();
    if ('ids' in p) return commit(`UPDATE items SET read_at=?,read_batch=NULL WHERE id IN (${p.ids.map(()=>'?').join(',')}) AND ${ATTENTION_SQL}`,now,...p.ids);
    const batch=randomUUID(), count=db.prepare(`UPDATE items SET read_at=?,read_batch=? WHERE ${ATTENTION_SQL}${p.threadId ? ' AND thread_id=?' : ''}`).run(now,batch,...(p.threadId ? [p.threadId] : [])).changes;
    invalidate(); return {ok:true as const,batch:count ? batch : null,count};
  }
  let wakeTimer: ReturnType<typeof setTimeout>|undefined, disposed=false;
  function wakeDue() {
    if (disposed) return;
    if (wakeTimer) clearTimeout(wakeTimer);
    const count=db.transaction(()=>db.prepare('UPDATE items SET snoozed_until=NULL,read_at=NULL,notify_state=1 WHERE snoozed_until<=?').run(Date.now()).changes)();
    if (count) {invalidate(); onAttention();}
    const next=db.prepare('SELECT min(snoozed_until) AS at FROM items').get() as {at:number|null};
    if (next.at!==null) {wakeTimer=setTimeout(wakeDue,Math.min(Math.max(0,next.at-Date.now()),2147483647)); wakeTimer.unref();}
  }
  async function guarded<T>(threadId:string, send:()=>Promise<T>): Promise<T> {
    if (sending.has(threadId)) throw new Error('A reply to this thread is already sending');
    sending.add(threadId);
    try {return await send();} finally {sending.delete(threadId);}
  }
  async function deliver(threadId:string,text:string,files:Attachment[]=[],opts:SendOptions={mode:'queue'}) {
    if (opts.sendAt!==undefined && opts.sendAt<=Date.now()) throw new Error('That time has passed — pick another');
    if (text.length>32000) throw new Error('Message exceeds 32,000 characters — split the pool');
    if (files.length>20) throw new Error('At most 20 attachments per message — split the pool');
    const inputs=files.map(f=>f.type==='localImage' ? {type:'localImage' as const,path:f.path,...(f.sourceProjectId ? {sourceProjectId:f.sourceProjectId} : {})} : {type:'localFile' as const,path:f.path,name:f.name,...(f.mimeType ? {mimeType:f.mimeType} : {}),...(f.sizeBytes ? {sizeBytes:f.sizeBytes} : {}),...(f.sourceProjectId ? {sourceProjectId:f.sourceProjectId} : {})});
    try {
      const result=await bb.sdk.threads.send({threadId,mode:opts.mode==='steer' ? 'steer-if-active' : 'queue-if-active',input:[{type:'text',mentions:[],text},...inputs],...(opts.sendAt ? {sendAt:opts.sendAt} : {}),...(opts.mode==='draft' ? {pluginSubmission:{pluginId:bb.pluginId,data:{kind:'draft'}}} : {})});
      if (!result.ok) throw new Error('send failed');
      return {delivery:result.delivery};
    } catch {throw new Error('Delivery uncertain — check the thread before retrying');}
  }
  function checkSources(threadId:string,entries:Row[]) {
    for (const entry of entries) if (entry.item_id) {
      const item=get(entry.item_id);
      if (item.thread_id!==threadId || item.thread_deleted || item.kind==='saved') throw new Error('item cannot receive replies in this thread');
    }
  }
  function applyReplies(threadId:string,entries:Row[]) {
    for (const id of new Set(entries.map(e=>e.item_id).filter(Boolean))) {
      const linked=entries.filter(e=>e.item_id===id);
      const notes=linked.map(e=>e.note).filter(n=>n.length>0);
      const answer=(notes.length ? notes : linked.map(e=>e.quote)).join('\n\n');
      db.prepare("UPDATE items SET status='replied',answer=?,answer_source='user',updated_at=? WHERE id=? AND thread_id=? AND kind='for_me' AND status='open'").run(answer,Date.now(),id,threadId);
    }
  }
  const handlers = {
    list, counts,
    undoRead(raw:z.infer<typeof inputs.undoRead>) {
      const p=inputs.undoRead.parse(raw),count=db.prepare('UPDATE items SET read_at=NULL,read_batch=NULL WHERE read_batch=? AND read_at>=?').run(p.batch,Date.now()-600000).changes;
      invalidate(); return {ok:true as const,count};
    },
    keepWaiting(raw:z.infer<typeof inputs.keepWaiting>) {
      const p=inputs.keepWaiting.parse(raw),item=get(p.id);
      if (item.kind!=='mine' || item.status!=='answered') throw new Error('item is not an answered question');
      return commit("UPDATE items SET status='deferred',interim=answer,interim_seq=answer_seq,answer=NULL,answer_seq=NULL,answer_source=NULL,answered_at=NULL,read_at=NULL,likely_interim=0,notify_state=0,updated_at=? WHERE id=?",Date.now(),p.id);
    },
    setInterim(raw:z.infer<typeof inputs.setInterim>) {const p=inputs.setInterim.parse(raw); get(p.id); return commit('UPDATE items SET likely_interim=? WHERE id=?',Number(p.value),p.id);},
    snooze(raw:z.infer<typeof inputs.snooze>) {
      const p=inputs.snooze.parse(raw),item=get(p.id),now=Date.now();
      if (item.kind==='saved') throw new Error('saved items cannot be snoozed');
      if (p.until!==null && (p.until<=now || p.until>now+30*86400000)) throw new Error('Snooze must be within the next 30 days');
      const result=commit('UPDATE items SET snoozed_until=?,read_at=NULL,notify_state=?,updated_at=? WHERE id=?',p.until,p.until===null ? 1 : 0,now,p.id);
      if (p.until===null) onAttention(); wakeDue(); return result;
    },
    async retryTurn(raw:z.infer<typeof inputs.retryTurn>) {
      const p=inputs.retryTurn.parse(raw),item=get(p.id);
      if (item.kind!=='mine' || !['waiting','deferred'].includes(item.status) || item.failed_at===null || !item.attempt_request_id || item.thread_deleted) throw new Error('item has no failed attempt');
      await bb.sdk.threads.retry({threadId:item.thread_id,turnRequestId:item.attempt_request_id}); invalidate(); return {ok:true as const};
    },
    async workBoardProjects(raw:z.infer<typeof inputs.workBoardProjects>) {
      inputs.workBoardProjects.parse(raw);
      const outputSchema=z.object({projects:z.array(z.object({id:z.string(),name:z.string()}))});
      try {const result=outputSchema.parse(await bb.sdk.plugins.callRpc({pluginId:'work-board',method:'listProjects',input:{},outputSchema})); return {available:true,projects:result.projects};}
      catch {return {available:false,projects:[]};}
    },
    async createTask(raw:z.infer<typeof inputs.createTask>) {
      const p=inputs.createTask.parse(raw),item=get(p.id);
      const outputSchema=z.discriminatedUnion('ok',[z.object({ok:z.literal(true),task:z.object({key:z.string().min(1)})}),z.object({ok:z.literal(false),error:z.object({message:z.string()})})]);
      const path=item.project_id ? '/projects/'+item.project_id+'/threads/'+item.thread_id : '/threads/'+item.thread_id;
      const result=outputSchema.parse(await bb.sdk.plugins.callRpc({pluginId:'work-board',method:'createTask',input:{projectId:p.projectId,title:(item.question.split('\n').find((line:string)=>line.trim()) ?? item.question).trim().slice(0,120),description:[item.question,item.answer,`[Open thread](${path})`].filter(Boolean).join('\n\n'),requesterThreadId:item.thread_id},outputSchema}));
      if (!result.ok) throw new Error(result.error.message);
      commit('UPDATE items SET task_key=? WHERE id=?',result.task.key,p.id); return {key:result.task.key};
    },
    async recipients(raw:z.infer<typeof inputs.recipients>) {
      const p=inputs.recipients.parse(raw);
      // shortcut: show at most 200 conversations; paginate when larger inboxes need it.
      const rows=db.prepare(`WITH ranked AS (
        SELECT *,CASE WHEN ${ATTENTION_SQL} THEN 1 ELSE 0 END AS attention,
        ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY CASE WHEN ${ATTENTION_SQL} THEN 0 ELSE 1 END,updated_at DESC,id DESC) AS rank
        FROM items WHERE thread_deleted=0 ${p.questions ? `AND (kind='for_me' OR ${QUESTION_SQL})` : ''}
      ), grouped AS (
        SELECT thread_id,sum(attention) AS unread,max(updated_at) AS last_at,
        max(CASE WHEN rank=1 THEN project_id END) AS project_id,
        max(CASE WHEN rank=1 THEN CASE WHEN attention=1 AND kind='mine' AND status='answered' THEN answer WHEN attention=1 AND kind='mine' THEN 'Turn failed: '||question WHEN attention=1 THEN question ELSE coalesce(answer,question) END END) AS preview
        FROM ranked GROUP BY thread_id
      ) SELECT * FROM grouped ORDER BY (thread_id=?) DESC,(unread>0) DESC,last_at DESC,thread_id LIMIT 200`).all(p.selected ?? '') as Row[];
      if (p.selected && !rows.some(r=>r.thread_id===p.selected)) {if(rows.length===200) rows.pop(); rows.push({thread_id:p.selected,unread:0,last_at:0,preview:''});}
      rows.sort((a,b)=>Number(b.unread>0)-Number(a.unread>0) || b.last_at-a.last_at || a.thread_id.localeCompare(b.thread_id));
      const threads=rows.length ? await bb.sdk.threads.list({threadIds:rows.map(r=>r.thread_id),includeHidden:true,limit:200}) : [];
      const projects=rows.length ? await bb.sdk.projects.list() : [];
      return {recipients:rows.map(r=>{const t=threads.find(t=>t.id===r.thread_id),projectId=t?.projectId ?? r.project_id ?? null; return {threadId:r.thread_id,threadTitle:t?.title ?? null,projectId,projectName:projects.find(p=>p.id===projectId)?.name ?? null,unread:r.unread,lastAt:r.last_at,preview:(r.preview ?? '').slice(0,160)};})};
    },
    markThreadRead(raw:z.infer<typeof inputs.markThreadRead>) {const p=inputs.markThreadRead.parse(raw); return markRead({all:true,threadId:p.threadId});},
    async pools(raw:z.infer<typeof inputs.pools>) {
      inputs.pools.parse(raw);
      const rows=db.prepare('SELECT * FROM pool_entries ORDER BY created_at,rowid').all() as Row[];
      const ids=[...new Set(rows.map(r=>r.thread_id as string))];
      const threads=ids.length ? await bb.sdk.threads.list({threadIds:ids,includeHidden:true,limit:200}) : [];
      return {pools:ids.map(threadId=>{
        const thread=threads.find(t=>t.id===threadId);
        return {threadId,threadTitle:thread?.title ?? null,projectId:thread?.projectId ?? null,entries:rows.filter(r=>r.thread_id===threadId).map(r=>({id:r.id,threadId,quote:r.quote,quoteSeq:r.quote_seq,itemId:r.item_id,note:r.note,attachments:JSON.parse(r.attachments as string) as Attachment[],revision:r.revision,createdAt:r.created_at,updatedAt:r.updated_at}))};
      })};
    },
    async poolAdd(raw:z.infer<typeof inputs.poolAdd>) {
      const p=inputs.poolAdd.parse(raw);
      await bb.sdk.threads.get({threadId:p.threadId});
      checkSources(p.threadId,[{item_id:p.itemId}]);
      const id='pool_'+randomUUID(),now=Date.now();
      db.prepare('INSERT INTO pool_entries(id,thread_id,quote,quote_seq,item_id,note,attachments,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id,p.threadId,p.quote,p.quoteSeq ?? null,p.itemId ?? null,p.note ?? '',JSON.stringify(p.attachments ?? []),now,now);
      invalidatePools(); return {id};
    },
    poolUpdate(raw:z.infer<typeof inputs.poolUpdate>) {
      const p=inputs.poolUpdate.parse(raw);
      if (!db.prepare('UPDATE pool_entries SET note=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?').run(p.note,Date.now(),p.id,p.revision).changes) throw new Error('Pool entry changed or removed — refresh before editing');
      invalidatePools(); return {revision:p.revision+1};
    },
    poolRemove(raw:z.infer<typeof inputs.poolRemove>) {
      const p=inputs.poolRemove.parse(raw); db.prepare('DELETE FROM pool_entries WHERE id=?').run(p.id); invalidatePools(); return {ok:true as const};
    },
    async quoteReply(raw:z.infer<typeof inputs.quoteReply>) {
      const p=inputs.quoteReply.parse(raw);
      return guarded(p.threadId,async()=>{
        await bb.sdk.threads.get({threadId:p.threadId});
        const entries=[{quote:p.quote,note:p.text,item_id:p.itemId}]; checkSources(p.threadId,entries);
        const result=await deliver(p.threadId,buildReplyMessage(entries),p.attachments,p.send);
        db.transaction(()=>applyReplies(p.threadId,entries))(); invalidate(); return result;
      });
    },
    async poolSend(raw:z.infer<typeof inputs.poolSend>) {
      const p=inputs.poolSend.parse(raw);
      return guarded(p.threadId,async()=>{
        await bb.sdk.threads.get({threadId:p.threadId});
        const entries=db.prepare('SELECT * FROM pool_entries WHERE thread_id=? ORDER BY created_at,rowid').all(p.threadId) as Row[];
        if (!entries.length) throw new Error('Pool is empty');
        checkSources(p.threadId,entries);
        const text=buildReplyMessage(entries as {quote:string;note:string}[]);
        if (!text) throw new Error('Nothing to send — write a reply first');
        const result=await deliver(p.threadId,text,entries.flatMap(e=>JSON.parse(e.attachments as string) as Attachment[]),p.send);
        let keptEdited=0;
        db.transaction(()=>{
          for (const entry of entries) {
            db.prepare('DELETE FROM pool_entries WHERE id=? AND revision=?').run(entry.id,entry.revision);
            if (db.prepare('SELECT 1 FROM pool_entries WHERE id=?').get(entry.id)) keptEdited++;
          }
          applyReplies(p.threadId,entries);
        })();
        invalidatePools(); invalidate(); return {...result,sent:entries.length,keptEdited};
      });
    },
    markRead,
    setPinned(raw: z.infer<typeof inputs.setPinned>) {const p=inputs.setPinned.parse(raw); get(p.id); return commit('UPDATE items SET pinned=?,updated_at=? WHERE id=?',Number(p.pinned),Date.now(),p.id);},
    setDismissed(raw: z.infer<typeof inputs.setDismissed>) {const p=inputs.setDismissed.parse(raw); get(p.id); return commit('UPDATE items SET dismissed_at=?,updated_at=? WHERE id=?',p.dismissed ? Date.now() : null,Date.now(),p.id);},
    async reply(raw: z.infer<typeof inputs.reply>) {
      const p=inputs.reply.parse(raw), threadId=get(p.id).thread_id as string;
      return guarded(threadId,async()=>{
        const item=get(p.id);
        if (item.thread_deleted || item.kind==='saved') throw new Error('item cannot receive replies');
        if (item.kind==='for_me' && item.status!=='open') throw new Error('question already replied');
        const result=await deliver(threadId,`Re: "${item.question.slice(0,120)}"\n\n${p.text}`,p.attachments,p.send);
        if (item.kind==='for_me') commit("UPDATE items SET status='replied',answer=?,answer_source='user',updated_at=? WHERE id=? AND status='open'",p.text,Date.now(),p.id);
        return result;
      });
    },
    async save(raw: z.infer<typeof inputs.save>) {
      const p=inputs.save.parse(raw);
      const key=createHash('sha256').update(`${p.threadId}|${p.seq}|${p.text}`).digest('hex');
      const existing=db.prepare("SELECT id FROM items WHERE kind='saved' AND dedupe_key=?").get(key) as {id:string} | undefined;
      if (existing) return {...existing,created:false};
      const thread=await bb.sdk.threads.get({threadId:p.threadId});
      const id='ans_'+randomUUID(), now=Date.now();
      commit("INSERT OR IGNORE INTO items(id,kind,thread_id,project_id,status,question,question_seq,answer,read_at,dedupe_key,created_at,updated_at) VALUES (?,'saved',?,?,'saved',?,?,?,?,?,?,?)",id,p.threadId,thread.projectId,cap(p.text,4000),p.seq,p.text,now,key,now,now);
      const saved=db.prepare('SELECT id FROM items WHERE dedupe_key=?').get(key) as {id:string};
      return {...saved,created:saved.id===id};
    },
  };
  bb.rpc.register(rpcContract,handlers);
  for (const method of Object.keys(toolInputs) as (keyof typeof toolInputs)[]) {
    bb.agents.registerTool({name:`answers_${method}`,description:{list:'List this thread’s pending questions.',defer:'Defer a user question until a later turn.',resolve:'Use this turn’s final message to answer a pending question.',ask:'Ask the user a small non-blocking question, optionally with 1–6 unique short quick-reply options.'}[method],parameters:toolInputs[method],
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
            commit("INSERT INTO items(id,kind,thread_id,project_id,status,question,options,notify_state,created_at,updated_at) VALUES (?,'for_me',?,?,'open',?,?,1,?,?)",id,ctx.threadId,ctx.projectId ?? null,(p as z.infer<typeof toolInputs.ask>).question,JSON.stringify((p as z.infer<typeof toolInputs.ask>).options ?? null),now,now);
            onAttention();
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
  registerCli(bb,{list,markRead,db,status:()=>({counts:counts(),trackedThreads:(db.prepare('SELECT count(*) AS n FROM threads_state').get() as {n:number}).n,errors:db.prepare('SELECT thread_id,last_error FROM threads_state WHERE last_error IS NOT NULL').all()})});
  bb.events.on('experimental_thread.events',({thread})=>driver.schedule(thread.id).catch(e=>bb.log.warn(`Answers ingest: ${String(e)}`)));
  bb.events.on('thread.deleted',({thread})=>driver.deleteThread(thread.id));
  bb.events.on('turn.failed',event=>{
    if (!event.inputAccepted && failRequest(db,event.threadId,event.requestId,Date.now(),true,true)) {invalidate(); onAttention();}
  });
  wakeDue();
  const startup = driver.reconcile().catch(e=>bb.log.warn(`Answers discovery: ${String(e)}`));
  bb.onDispose(async()=>{disposed=true; if (wakeTimer) clearTimeout(wakeTimer); await driver.dispose(); await startup; await notifier.dispose();});
}
