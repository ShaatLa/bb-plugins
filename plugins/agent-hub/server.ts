import { needsMigration, migrateAnswers, migrationStatus } from './migration';
import { createConfig } from './config';
import { mentionsForText, threadToken } from './mentions';
import { createHash, randomUUID } from 'node:crypto';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { deliveryError } from './delivery';
import { rpcContract, inputs, idSchema, itemSchema, ITEMS_TAG, COUNTS_TAG, POOLS_TAG, QUEUE_TAG, CONTEXT_TAG, inlinePreviewSchema, tokenomosThreads, type Item, type ListInput, type Counts, type Attachment, type SendOptions, type FormQuestion, YOUR_CALL, defaultAnswer } from './contract';
import { migrations } from './schema';
import { cap, ATTENTION_SQL, ACTIVE_THREAD_SQL, OWNER_ITEM_SQL, failRequest } from './ingest';
import { createDriver } from './driver';
import { registerCli } from './cli';
import { createNotifier } from './notify';
import { buildReplyMessage } from './reply-message';
export { buildReplyMessage };
import { inlineCommentPreview } from './inline-comments';

export const INSTRUCTIONS = "Agent Hub tracks user messages and final replies. For a later answer, call answers_defer; when it arrives, answers_list then answers_resolve. Ask decisions via answers_ask, then end the turn. With no pending question, call answers_report for an awaited result or when handing work to the owner (ready for review, decisions awaiting them). Scripts waking their own thread via bb thread tell start with a [tag].";
const optionsSchema=z.array(z.string().trim().min(1).max(200)).min(1).max(6).refine(v=>new Set(v).size===v.length,'Options must be unique');
// A session started before a tool gained a flag sends it as a string; read 'true'/'false' as the boolean.
const flag=z.preprocess(v=>v==='true' ? true : v==='false' ? false : v,z.boolean());
const toolInputs = {
  list: z.object({}).strict(),
  defer: z.object({id:idSchema.optional(),note:z.string().max(2000).optional()}).strict(),
  resolve: z.object({id:idSchema}).strict(),
  report: z.object({}).strict(),
  withdraw: z.object({id:idSchema,reason:z.string().trim().min(1).max(300)}).strict(),
  ask: z.object({urgency:z.enum(['blocking','normal','low']).optional(),deadlineMinutes:z.number().int().min(5).max(10080).optional(),question:z.string().trim().min(1).max(2000),options:optionsSchema.optional(),multiSelect:flag.optional(),recommended:z.string().trim().min(1).optional(),reason:z.string().trim().min(1).max(300).optional(),
    questions:z.array(z.object({question:z.string().trim().min(1).max(1000),header:z.string().trim().min(1).max(40).optional(),options:optionsSchema.optional(),multiSelect:flag.optional(),recommended:z.string().trim().min(1).optional()}).strict()
      .refine(q=>!q.multiSelect || !!q.options,{message:'multiSelect requires options',path:['multiSelect']})
      .refine(q=>q.recommended===undefined || q.options?.includes(q.recommended),{message:'recommended must equal one of options',path:['recommended']})).min(2).max(10).optional()}).strict()
    .refine(p=>!p.questions || (p.options===undefined && p.multiSelect===undefined && p.recommended===undefined),{message:'with questions, put options, multiSelect and recommended on each question',path:['questions']})
    .refine(p=>!p.multiSelect || !!p.options,{message:'multiSelect requires options',path:['multiSelect']})
    .refine(p=>p.recommended===undefined || p.options?.includes(p.recommended),{message:'recommended must equal one of options',path:['recommended']})
    .refine(p=>p.deadlineMinutes===undefined || !!p.questions || p.recommended!==undefined,{message:'deadlineMinutes requires recommended for a single question',path:['deadlineMinutes']})
    .refine(p=>p.reason===undefined || p.recommended!==undefined,{message:'reason requires recommended',path:['reason']}),
};
const formQuestion=(id:string,prompt:string,q:{header?:string;options?:string[];multiSelect?:boolean;recommended?:string;reason?:string}):FormQuestion=>({id,prompt,...(q.header ? {shortLabel:q.header} : {}),
  options:[...(q.options ?? []).filter(o=>o!==YOUR_CALL).map(o=>({value:o,label:o,...(o===q.recommended ? {description:q.reason ? `Recommended: ${q.reason}` : 'Recommended'} : {})})),{value:YOUR_CALL,label:YOUR_CALL,description:'Let the agent decide'}],multiSelect:!!q.multiSelect,allowFreeText:true,required:false});
// Deferred answers expire after three days without answer movement.
export const OWED_EXPIRY_MS = 3 * 24 * 60 * 60 * 1000;
type Row = Record<string, any>;
export default function plugin(bb: BbPluginApi) {
  if (!needsMigration(bb)) return start(bb, null);
  return migrateAnswers(bb).then(() => start(bb, null), error => {
    bb.log.error(`Agent Hub migration failed; will retry next start: ${String(error)}`);
    return start(bb, String(error));
  });
}
function start(bb: BbPluginApi, migrationError: string | null) {
  const db = bb.storage.database();
  bb.storage.migrate(db,migrations);
  const migrationPending = !!migrationError && !(db.prepare('SELECT 1 FROM items LIMIT 1').get());
  // Keep a failed import empty so the next start can retry without overwriting new work.
  if (migrationPending) db.pragma('query_only = ON');
  // Leading call goes out at once; calls inside the next 150 ms collapse into one trailing invalidate, so bursts cause one client refetch.
  let invTimer: ReturnType<typeof setTimeout> | undefined, invPending = false, invOff = false;
  const invalidate = (): void => {
    if (invOff) return;
    if (invTimer) { invPending = true; return; }
    bb.rpc.experimental_invalidate([ITEMS_TAG,COUNTS_TAG]);
    invTimer = setTimeout(() => { invTimer = undefined; if (invPending) { invPending = false; invalidate(); } },150); invTimer.unref();
  };
  const invalidatePools = () => bb.rpc.experimental_invalidate([POOLS_TAG]);
  const queueStamps = new Map<string,number>(); // per thread, bumped by bb's queue events below
  // Per thread, bumped when bb reports its context window usage changed, so the open chat rereads its ring then, not on a timer.
  const contextStamps = new Map<string,{stamp:number;compactedAt:number|null}>();
  const notifier=createNotifier(bb,db);
  const config=createConfig(bb,notifier.settings);
  const onAttention = () => {void notifier.run();};
  const driver = createDriver(bb,db,() => {invalidate(); onAttention();},(threadId,compactedAt) => {const last=contextStamps.get(threadId); contextStamps.set(threadId,{stamp:(last?.stamp ?? 0)+1,compactedAt:compactedAt ?? last?.compactedAt ?? null}); bb.rpc.experimental_invalidate([CONTEXT_TAG]);},async () => (await notifier.settings.get()).handoffWarnings);
  let projectCache: {expires:number; rows:Awaited<ReturnType<typeof bb.sdk.projects.list>>}|undefined;
  type DisplayThread = {id:string; title:string|null; projectId:string};
  const threadCache=new Map<string,{expires:number; thread:DisplayThread|undefined}>();
  async function displayProjects() {
    if (!projectCache || projectCache.expires<=Date.now()) projectCache={rows:await bb.sdk.projects.list(),expires:Date.now()+60000};
    return projectCache.rows;
  }
  async function displayThreads(ids:string[]) {
    const missing=[...new Set(ids)].filter(id=>!threadCache.has(id) || threadCache.get(id)!.expires<=Date.now());
    if (missing.length) {
      const rows=await bb.sdk.threads.list({threadIds:missing,includeHidden:true,limit:200}), expires=Date.now()+30000;
      for (const id of missing) {const t=rows.find(t=>t.id===id); threadCache.set(id,{expires,thread:t ? {id:t.id,title:t.title,projectId:t.projectId} : undefined});}
    }
    return ids.flatMap(id=>{const t=threadCache.get(id)?.thread; return t ? [t] : [];});
  }
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
  function expireOwed(threadId: string) {
    const now = Date.now();
    if (db.prepare("UPDATE items SET dismissed_at=?,wait_children=NULL,updated_at=? WHERE thread_id=? AND kind='mine' AND status='deferred' AND dismissed_at IS NULL AND coalesce(moved_at,created_at)<=?").run(now,now,threadId,now-OWED_EXPIRY_MS).changes) invalidate();
  }
  function counts(): Counts {
    return db.prepare(`SELECT
      count(CASE WHEN kind IN ('mine','update') AND status='answered' AND read_at IS NULL AND snoozed_until IS NULL THEN 1 END) AS unread,
      count(CASE WHEN kind='mine' AND status IN ('waiting','deferred') THEN 1 END) AS waiting,
      count(CASE WHEN kind='for_me' AND status='open' THEN 1 END) AS forMe,
      count(CASE WHEN ${ATTENTION_SQL} THEN 1 END) AS inbox
      FROM items WHERE dismissed_at IS NULL AND thread_deleted=0 AND ${ACTIVE_THREAD_SQL} AND ${OWNER_ITEM_SQL}`).get() as Counts;
  }
  // bb has no "thread read" event, so the badge would keep counting answers already read in bb's chat until the Agent Hub
  // page loads contacts. Counting first applies bb's lastReadAt to threads with unread answers (at most every 15 s).
  // Agent questions stay: reading the thread in bb does not answer them.
  let bbReadSyncedAt = 0;
  // bb also counts sending a message as reading its thread (lastReadAt = the send time, to the millisecond), even a queued
  // message it sends by itself when a turn ends, while nobody is looking; taking that as a read would hide the answer that
  // just arrived. So a lastReadAt that falls right on one of the owner's sends is not a read; only bb's real reads count.
  const sendReads = new Map<string, number>();
  async function applyBbRead(threadId: string, readAt: number) {
    const sql = `FROM items WHERE thread_id=? AND ${ATTENTION_SQL} AND kind<>'for_me' AND coalesce(answered_at,created_at)<=?`;
    if (sendReads.get(threadId) === readAt || !(db.prepare(`SELECT count(*) AS n ${sql}`).get(threadId,readAt) as {n:number}).n) return 0;
    const sent = await bb.sdk.threads.events.list({threadId,types:['client/turn/requested'],order:'desc',limit:'5'}) as {createdAt:number;data?:{initiator?:string}}[];
    if (sent.some(e => e.data?.initiator === 'user' && readAt >= e.createdAt && readAt - e.createdAt < 1000)) { sendReads.set(threadId, readAt); return 0; }
    return db.prepare(`UPDATE items SET read_at=? WHERE id IN (SELECT id ${sql})`).run(readAt,threadId,readAt).changes;
  }
  async function syncReadFromBb() {
    if (Date.now() - bbReadSyncedAt < 15000) return; bbReadSyncedAt = Date.now();
    const ids = threadsOf(`${ATTENTION_SQL} AND kind<>'for_me' AND thread_deleted=0`);
    if (!ids.length) return;
    try {
      let n = 0;
      for (const t of await bb.sdk.threads.list({threadIds:ids,includeHidden:true,limit:200})) if (t.lastReadAt) n += await applyBbRead(t.id,t.lastReadAt);
      if (n) invalidate();
    } catch (e) { bb.log.warn(`Agent Hub read sync: ${String(e)}`); }
  }
  async function list(raw: ListInput) {
    const p = inputs.list.parse(raw);
    if (!migrationPending && p.threadId && !db.prepare('SELECT 1 FROM threads_state WHERE thread_id=? AND (last_seq>0 OR ingested_thread_updated_at IS NOT NULL)').get(p.threadId)) await driver.schedule(p.threadId);
    const views = {
      // Same set as the Inbox: unread answers and open agent questions.
      unread:ATTENTION_SQL,
      waiting:"kind='mine' AND status IN ('waiting','deferred')",
      for_me:"kind='for_me' AND status='open'", pinned:'pinned=1', saved:"((kind='saved' AND dismissed_at IS NULL) OR pinned=1)", all:'1=1',
    };
    const where = [views[p.view]], args: (string | number)[] = [];
    if (!p.threadId) where.push(OWNER_ITEM_SQL);
    if (!['all','pinned','saved'].includes(p.view)) where.push('dismissed_at IS NULL',ACTIVE_THREAD_SQL);
    for (const [key,value] of [['thread_id',p.threadId],['project_id',p.projectId]] as const) {
      if (value !== undefined) {where.push(`${key}=?`); args.push(value);}
    }
    if (p.query) {where.push("(instr(lower(question),lower(?))>0 OR instr(lower(coalesce(answer,'')),lower(?))>0)"); args.push(p.query,p.query);}
    // activity: conversations place an item at its latest activity, so a late answer pages in with its own time.
    const at = p.order === 'activity' ? 'coalesce(answered_at,created_at)' : 'created_at';
    if ((p.anchor !== undefined || p.after) && (!p.threadId || p.view !== 'all' || p.order !== 'activity' || p.cursor || p.query)) throw new Error('Anchored history requires one thread and activity order');
    if (p.anchor !== undefined) {
      const target = db.prepare(`SELECT *,${at} AS list_at FROM items WHERE thread_id=? AND ${typeof p.anchor === 'number' ? '(question_seq=? OR answer_seq=? OR interim_seq=? OR candidate_seq=?)' : 'id=?'} LIMIT 1`).get(p.threadId, ...(typeof p.anchor === 'number' ? [p.anchor,p.anchor,p.anchor,p.anchor] : [p.anchor])) as Row | undefined;
      if (!target) return {items:[],nextCursor:null,newerCursor:null};
      where.push(`(${at}<? OR (${at}=? AND id<=?))`); args.push(target.list_at,target.list_at,target.id);
    }
    const cursor = p.after ?? p.cursor;
    if (cursor) {const [time,id]=cursor.split('|'), op=p.after ? '>' : '<'; where.push(`(${at}${op}? OR (${at}=? AND id${op}?))`); args.push(Number(time),Number(time),id);}
    const limit = p.limit ?? 50, direction = p.after ? 'ASC' : 'DESC';
    const rows = db.prepare(`SELECT *,${at} AS list_at FROM items WHERE ${where.join(' AND ')} ORDER BY ${at} ${direction},id ${direction} LIMIT ?`).all(...args,limit+1) as Row[];
    const more = rows.length>limit; rows.splice(limit); if (p.after) rows.reverse();
    const titles = new Map<string,string>();
    const ids = [...new Set(rows.filter(r=>!r.thread_deleted).map(r=>r.thread_id as string))];
    if (ids.length) for (const t of await displayThreads(ids)) titles.set(t.id,t.title ?? t.id);
    // Update captions name the child or sender thread; one that left the sidebar (archived) is looked up by id.
    const sources = [...new Set(rows.filter(r=>r.trigger_kind==='system' || r.trigger_kind==='agent').map(r=>r.trigger_source as string|null).filter((id):id is string=>!!id && !titles.has(id)))];
    if (sources.length) for (const t of await displayThreads(sources)) titles.set(t.id,t.title ?? t.id);
    await Promise.all(sources.filter(id=>!titles.has(id)).map(id=>bb.sdk.threads.get({threadId:id}).then(t=>{titles.set(id,t.title ?? id); threadCache.set(id,{expires:Date.now()+30000,thread:{id:t.id,title:t.title,projectId:t.projectId}});},()=>{})));
    const names = new Map<string,string>();
    if (rows.some(r=>r.project_id)) for (const p of await displayProjects()) names.set(p.id,p.name);
    const items: Item[] = rows.map(row => {
      const value: Row = {};
      for (const [key,v] of Object.entries(row)) if (key !== 'dedupe_key' && key !== 'list_at') value[key.replace(/_([a-z])/g,(_,c:string)=>c.toUpperCase())]=v;
      return itemSchema.parse({...value,attachments:JSON.parse(row.attachments),snoozedUntil:row.snoozed_until,failedAt:row.failed_at,failureReason:row.failure_reason,interruptedAt:row.interrupted_at,likelyInterim:!!row.likely_interim,asks:!!row.asks,chatAsked:!!row.chat_asked,options:row.options===null ? null : JSON.parse(row.options),questions:row.questions===null ? null : JSON.parse(row.questions),recommended:row.recommended,recommendReason:row.recommend_reason,taskKey:row.task_key,trigger:row.trigger_kind ? {kind:row.trigger_kind,sourceId:row.trigger_source,sourceTitle:row.trigger_source ? titles.get(row.trigger_source) ?? null : null} : null,pinned:!!row.pinned,threadDeleted:!!row.thread_deleted,threadTitle:titles.get(row.thread_id) ?? null,projectName:names.get(row.project_id) ?? null});
    });
    const last = rows.at(-1);
    const first = rows[0], newer = first && (p.anchor !== undefined || p.after) && db.prepare(`SELECT 1 FROM items WHERE thread_id=? AND (${at}>? OR (${at}=? AND id>?)) LIMIT 1`).get(p.threadId,first.list_at,first.list_at,first.id);
    return {items,nextCursor:more && last ? `${last.list_at}|${last.id}` : null,...(p.anchor !== undefined || p.after ? {newerCursor:newer ? `${first!.list_at}|${first!.id}` : null} : {})};
  }
  function markRead(raw: {all:true;threadId?:string}): {ok:true;batch:string|null;count:number};
  function markRead(raw: z.infer<typeof inputs.markRead>): {ok:true;batch?:string|null;count?:number};
  function markRead(raw: z.infer<typeof inputs.markRead>) {
    const p=inputs.markRead.parse(raw), now=Date.now();
    if ('ids' in p) return commit(`UPDATE items SET read_at=?,read_batch=NULL WHERE id IN (${p.ids.map(()=>'?').join(',')}) AND ${ATTENTION_SQL}`,now,...p.ids);
    // Reading does not answer an open agent question; it stays counted until answered.
    const batch=randomUUID(), count=db.prepare(`UPDATE items SET read_at=?,read_batch=? WHERE ${ATTENTION_SQL} AND NOT (kind='for_me' AND status='open')${p.threadId ? ' AND thread_id=?' : ''}`).run(now,batch,...(p.threadId ? [p.threadId] : [])).changes;
    invalidate(); return {ok:true as const,batch:count ? batch : null,count};
  }
  // Reads made in Agent Hub's UI also clear bb's own unread mark on a thread once nothing there is left unread here,
  // and an undo restores it. The CLI path (`bb agent-hub read`) is not a person reading, so it leaves bb alone.
  async function syncBbRead(threadIds: Iterable<string>, read: boolean) {
    for (const threadId of new Set(threadIds)) {
      if (read && db.prepare(`SELECT 1 FROM items WHERE thread_id=? AND ${ATTENTION_SQL} LIMIT 1`).get(threadId)) continue;
      try { await (read ? bb.sdk.threads.markRead({threadId}) : bb.sdk.threads.markUnread({threadId})); }
      catch (e) { bb.log.warn(`Agent Hub read sync: ${String(e)}`); }
    }
  }
  const threadsOf = (sql: string, ...params: unknown[]) => (db.prepare(`SELECT DISTINCT thread_id FROM items WHERE ${sql}`).all(...params) as {thread_id:string}[]).map(r=>r.thread_id);
  async function markReadFromUi(raw: z.infer<typeof inputs.markRead>) {
    const p=inputs.markRead.parse(raw), result=markRead(p);
    const threads='ids' in p ? threadsOf(`id IN (${p.ids.map(()=>'?').join(',')})`,...p.ids) : p.threadId ? [p.threadId] : result.batch ? threadsOf('read_batch=?',result.batch) : [];
    await syncBbRead(threads,true); return result;
  }
  const deadlinePending=new Set<string>();
  let remindHours=0, reminderSettingsChanged=false;
  let wakeTimer: ReturnType<typeof setTimeout>|undefined, disposed=false;
  function wakeDue() {
    if (disposed || migrationPending) return;
    if (wakeTimer) clearTimeout(wakeTimer);
    const count=db.transaction(()=>db.prepare('UPDATE items SET snoozed_until=NULL,read_at=NULL,notify_state=1 WHERE snoozed_until<=?').run(Date.now()).changes)();
    if (count) {invalidate(); onAttention();}
    if(remindHours>0) {
      const reminders=db.prepare("UPDATE items SET notify_state=1,reminded_at=?,reminders=reminders+1 WHERE kind='for_me' AND urgency='blocking' AND status='open' AND dismissed_at IS NULL AND thread_deleted=0 AND reminders<3 AND coalesce(reminded_at,created_at)+?<=? AND (deadline_at IS NULL OR deadline_at>?)").run(Date.now(),remindHours*3600000,Date.now(),Date.now()).changes;
      if(reminders) {invalidate();onAttention();}
    }
    const due=db.prepare("SELECT * FROM items WHERE kind='for_me' AND status='open' AND dismissed_at IS NULL AND thread_deleted=0 AND deadline_at<=?").all(Date.now()) as Row[];
    for (const row of due) {
      if (deadlinePending.has(row.id) || sending.has(row.thread_id)) continue;
      deadlinePending.add(row.id);
      void guarded(row.thread_id,async()=>{
        const item=get(row.id);
        if (item.status!=='open' || item.dismissed_at!==null || item.deadline_at===null || item.deadline_at>Date.now()) return;
        const note=`No answer by the deadline, so going with the default:\n${defaultAnswer({questions:item.questions ? JSON.parse(item.questions) : null,recommended:item.recommended})}`;
        try {
          await deliver(item.thread_id,buildReplyMessage([{quote:item.question,note}]));
          commit("UPDATE items SET status='replied',answer=?,answer_source='agent',deadline_at=NULL,updated_at=? WHERE id=? AND status='open'",note,Date.now(),item.id);
        } catch(e) {bb.log.warn(`Agent Hub deadline: ${String(e)}`); commit('UPDATE items SET deadline_at=NULL WHERE id=?',item.id);}
      }).finally(()=>{deadlinePending.delete(row.id);wakeDue();});
    }
    const next=db.prepare("SELECT min(at) AS at FROM (SELECT CASE WHEN ?>0 THEN coalesce(reminded_at,created_at)+? END AS at FROM items WHERE kind='for_me' AND urgency='blocking' AND status='open' AND dismissed_at IS NULL AND thread_deleted=0 AND reminders<3 UNION ALL SELECT snoozed_until AS at FROM items WHERE snoozed_until IS NOT NULL UNION ALL SELECT deadline_at FROM items WHERE kind='for_me' AND status='open' AND dismissed_at IS NULL AND thread_deleted=0 AND deadline_at IS NOT NULL)").get(remindHours,remindHours*3600000) as {at:number|null};
    if (next.at!==null) {wakeTimer=setTimeout(wakeDue,Math.min(Math.max(1000,next.at-Date.now()),2147483647)); wakeTimer.unref();}
  }
  async function guarded<T>(threadId:string, send:()=>Promise<T>): Promise<T> {
    if (sending.has(threadId)) throw new Error('A reply to this thread is already sending');
    sending.add(threadId);
    try {return await send();} finally {sending.delete(threadId);}
  }
  async function deliver(threadId:string,text:string,files:Attachment[]=[],opts:SendOptions={mode:'queue'}) {
    if (opts.sendAt!==undefined && opts.sendAt<=Date.now()) throw new Error('Not sent: that time has passed — pick another');
    if (text.length>32000) throw new Error('Not sent: the message exceeds 32,000 characters — split the pool');
    if (files.length>20) throw new Error('Not sent: at most 20 attachments per message — split the pool');
    const inputs=files.map(f=>f.type==='localImage' ? {type:'localImage' as const,path:f.path,...(f.sourceProjectId ? {sourceProjectId:f.sourceProjectId} : {})} : {type:'localFile' as const,path:f.path,name:f.name,...(f.mimeType ? {mimeType:f.mimeType} : {}),...(f.sizeBytes ? {sizeBytes:f.sizeBytes} : {}),...(f.sourceProjectId ? {sourceProjectId:f.sourceProjectId} : {})});
    const labels = new Map<string, { label: string; projectId?: string }>();
    await Promise.all(Array.from(text.matchAll(threadToken), async match => { try { const thread = await bb.sdk.threads.get({ threadId: match[1] }); labels.set(match[1], { label: thread.title ?? match[1], projectId: thread.projectId }); } catch { /* retain the token id */ } }));
    try {
      const result=await bb.sdk.threads.send({threadId,mode:opts.mode==='steer' ? 'steer-if-active' : 'queue-if-active',input:[...(text.trim() ? [{type:'text' as const,mentions:mentionsForText(text, id => labels.get(id)),text}] : []),...inputs],...(opts.sendAt ? {sendAt:opts.sendAt} : {}),...(opts.mode==='draft' ? {pluginSubmission:{pluginId:bb.pluginId,data:{kind:'draft'}}} : {})});
      if (!result.ok) throw new Error('send failed');
      return {delivery:result.delivery};
    } catch (e) {throw new Error(deliveryError(e));}
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
    'config.get':config.get,
    'config.set':config.set,
    list, async counts() { await syncReadFromBb(); return counts(); },
    undoRead(raw:z.infer<typeof inputs.undoRead>) {
      const p=inputs.undoRead.parse(raw),threads=threadsOf('read_batch=? AND read_at>=?',p.batch,Date.now()-600000),count=db.prepare('UPDATE items SET read_at=NULL,read_batch=NULL WHERE read_batch=? AND read_at>=?').run(p.batch,Date.now()-600000).changes;
      invalidate(); if (count) void syncBbRead(threads,false); return {ok:true as const,count};
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
    // Contact-list preferences live in plugin settings, so they follow the user across devices.
    getPreferences() {return notifier.settings.get();},
    updatePreferences(raw:unknown) {return notifier.settings.experimental_set(raw);},
    async setPreferences(raw:z.infer<typeof inputs.setPreferences>) {await notifier.settings.experimental_set(inputs.setPreferences.parse(raw)); return {ok:true as const};},
    // bb's Markdown for plugins does not render message directives, so the chat asks the built-in inline-vis plugin for
    // the page an ::inline-vis directive names (it resolves and validates the path and size exactly as bb's chat does).
    async inlinePreview(raw:z.infer<typeof inputs.inlinePreview>) {
      const p=inputs.inlinePreview.parse(raw);
      const outputSchema=z.object({kind:z.string()}).passthrough();
      try {const result=await bb.sdk.plugins.callRpc({pluginId:'inline-vis',method:'preparePreview',input:{threadId:p.threadId,file:p.file,source:p.source},outputSchema}); const parsed=inlinePreviewSchema.safeParse(result); return parsed.success ? parsed.data : {kind:'error' as const,message:'Unexpected preview'};}
      catch (e) {return {kind:'error' as const,message:(e instanceof Error ? e.message : String(e)).slice(0,500)};}
    },
    // Tokenomos' cost of a thread and its sub-threads; fail-soft, so Agent Hub works the same without it.
    async threadCost(raw:z.infer<typeof inputs.threadCost>) {
      const p=inputs.threadCost.parse(raw);
      try {const result=tokenomosThreads.parse(await bb.sdk.plugins.callRpc({pluginId:'tokenomos',method:'costs.threads',input:{threadIds:[p.threadId],includeDescendants:true},outputSchema:tokenomosThreads})),t=result.threads[0]; if (t) return {available:true,own:t.own,total:t.total,descendantCount:t.descendantCount};}
      catch { /* not installed, not running, or another shape */ }
      return {available:false,own:null,total:null,descendantCount:0};
    },
    async workBoardProjects(raw:z.infer<typeof inputs.workBoardProjects>) {
      inputs.workBoardProjects.parse(raw);
      const outputSchema=z.object({projects:z.array(z.object({id:z.string(),name:z.string(),prefix:z.string()}))});
      try {const result=outputSchema.parse(await bb.sdk.plugins.callRpc({pluginId:'work-board',method:'listProjects',input:{},outputSchema})); return {available:true,projects:result.projects};}
      catch {return {available:false,projects:[]};}
    },
    async createTask(raw:z.infer<typeof inputs.createTask>) {
      const p=inputs.createTask.parse(raw),item=get(p.id);
      const outputSchema=z.discriminatedUnion('ok',[z.object({ok:z.literal(true),task:z.object({key:z.string().min(1)})}),z.object({ok:z.literal(false),error:z.object({message:z.string()})})]);
      const path=item.project_id ? '/projects/'+item.project_id+'/threads/'+item.thread_id : '/threads/'+item.thread_id;
      const result=outputSchema.parse(await bb.sdk.plugins.callRpc({pluginId:'work-board',method:'createTask',input:{projectId:p.projectId,title:(inlineCommentPreview(item.question).split('\n').find((line:string)=>line.trim()) ?? '').trim().slice(0,120),description:[item.question,item.answer,`[Open thread](${path})`].filter(Boolean).join('\n\n'),requesterThreadId:item.thread_id},outputSchema}));
      if (!result.ok) throw new Error(result.error.message);
      commit('UPDATE items SET task_key=? WHERE id=?',result.task.key,p.id); return {key:result.task.key};
    },
    async recipients(raw:z.infer<typeof inputs.recipients>) {
      const p=inputs.recipients.parse(raw);
      if (!migrationPending && p.selected && !db.prepare('SELECT 1 FROM threads_state WHERE thread_id=? AND (last_seq>0 OR ingested_thread_updated_at IS NOT NULL)').get(p.selected)) await driver.schedule(p.selected);
      // A contact counts its own open agent questions too; explicit sub-agent asks live only in Questions.
      const contactAttention = ATTENTION_SQL;
      const chosenAttention=contactAttention.replaceAll('thread_id NOT IN','chosen.thread_id NOT IN');
      // shortcut: show at most 200 conversations; paginate when larger inboxes need it.
      const rows=db.prepare(`WITH grouped AS (
        SELECT thread_id,sum(CASE WHEN ${contactAttention} THEN 1 ELSE 0 END) AS unread,max(updated_at) AS last_at
        FROM items WHERE thread_deleted=0 AND ${ACTIVE_THREAD_SQL} AND thread_id NOT IN (SELECT thread_id FROM sub_threads)
        GROUP BY thread_id
        -- A thread with only agent questions lives in Questions; an open top-level chat stays listed.
        HAVING sum(kind<>'for_me')>0 OR thread_id=?
        ORDER BY (thread_id=?) DESC,(unread>0) DESC,last_at DESC,thread_id LIMIT 200
      ) SELECT grouped.*,chosen.project_id,
        CASE WHEN ${chosenAttention} AND chosen.kind IN ('mine','update') AND chosen.status='answered' THEN chosen.answer
             WHEN ${chosenAttention} AND chosen.kind='mine' THEN 'Turn failed: '||chosen.question
             WHEN ${chosenAttention} THEN chosen.question ELSE coalesce(chosen.answer,chosen.question) END AS preview
        FROM grouped JOIN items chosen ON chosen.id=(
          SELECT id FROM items WHERE items.thread_id=grouped.thread_id AND thread_deleted=0
          ORDER BY CASE WHEN ${contactAttention.replaceAll('thread_id NOT IN','items.thread_id NOT IN')} THEN 0 ELSE 1 END,updated_at DESC,id DESC LIMIT 1
        )`).all(p.selected ?? '',p.selected ?? '') as Row[];
      // The open chat stays listed even without items yet, unless it was archived or deleted.
      if (p.selected && !rows.some(r=>r.thread_id===p.selected) && !db.prepare('SELECT 1 FROM archived_threads WHERE thread_id=? UNION ALL SELECT 1 FROM items WHERE thread_id=? AND thread_deleted=1 UNION ALL SELECT 1 FROM sub_threads WHERE thread_id=?').get(p.selected,p.selected,p.selected)) {if(rows.length===200) rows.pop(); rows.push({thread_id:p.selected,unread:0,last_at:0,preview:''});}
      rows.sort((a,b)=>Number(b.unread>0)-Number(a.unread>0) || b.last_at-a.last_at || a.thread_id.localeCompare(b.thread_id));
      const threads=rows.length ? await displayThreads(rows.map(r=>r.thread_id)) : [];
      const projects=rows.length ? await displayProjects() : [];
      const threadMap=new Map(threads.map(t=>[t.id,t]));
      // Reading a thread in bb counts as reading it here: what arrived before bb's lastReadAt was seen there.
      const unreadIds=rows.filter(r=>r.unread>0).map(r=>r.thread_id as string);
      const fresh=unreadIds.length ? await bb.sdk.threads.list({threadIds:unreadIds,includeHidden:true,limit:200}) : [];
      const readTimes=new Map(fresh.map(t=>[t.id,t.lastReadAt]));
      let seen=0;
      for (const r of rows) { const readAt=readTimes.get(r.thread_id); if (r.unread>0 && readAt) { const n=await applyBbRead(r.thread_id,readAt).catch(()=>0); r.unread-=n; seen+=n; } }
      if (seen) invalidate();
      const projectMap=new Map(projects.map(p=>[p.id,p]));
      const mentioned=[...new Set(rows.flatMap(r=>[...((r.preview ?? '') as string).matchAll(/(?:@thread:|^\[bb message from thread:)(thr_[A-Za-z0-9_-]+)/g)].map(m=>m[1]!)))].filter(id=>!threadMap.has(id)).slice(0,200);
      if (mentioned.length) threads.push(...await displayThreads(mentioned));
      for(const t of threads) threadMap.set(t.id,t);
      // A quote reply previews as its note (the quote is context, as in a messenger); a bare quote as its text without '>'.
      const unquote=(text:string)=>{const note=text.split('\n').filter(line=>!/^\s*>/.test(line)).join('\n').trim(); return note || text.replace(/^\s*>[ \t]?/gm,'');};
      // Another thread's message previews as "Sender: text", as its chat card names the sender instead of the [bb message from …] header.
      const plain=(text:string)=>unquote(text.replace(/^\[bb message from thread:(thr_[A-Za-z0-9_-]+)\]\s*/,(_,id:string)=>threadMap.get(id)?.title ? `${threadMap.get(id)!.title}: ` : '')).replace(/^\s*(?:#{1,6}|[-*+]|\d+[.)])\s+/gm,'').replace(/@thread:(thr_[A-Za-z0-9_-]+)(?:#msg=\d+)?/g,(_,id:string)=>'@'+(threadMap.get(id)?.title ?? 'thread')).replace(/\[([^\]]+)\]\([^)\s]+\)/g,'$1').replace(/\*\*|`/g,'').replace(/\s+/g,' ').trim();
      // Threads with an open question to the owner, so contacts can surface a sub-session that asks under its collapsed parent.
      const asking=(db.prepare(`SELECT DISTINCT thread_id FROM items WHERE kind='for_me' AND status='open' AND dismissed_at IS NULL AND thread_deleted=0 AND ${ACTIVE_THREAD_SQL} AND ${OWNER_ITEM_SQL}`).all() as {thread_id:string}[]).map(r=>r.thread_id);
      return {asking,recipients:rows.map(r=>{const t=threadMap.get(r.thread_id),projectId=t?.projectId ?? r.project_id ?? null; return {threadId:r.thread_id,threadTitle:t?.title ?? null,projectId,projectName:projectMap.get(projectId)?.name ?? null,unread:r.unread,lastAt:r.last_at,preview:plain(inlineCommentPreview(((r.preview ?? '') as string).replace(/<!--[\s\S]*?-->\s*/g,''))).slice(0,160)};})};
    },
    // A UI crash caught by the app's CrashGuard, so its stack reaches `bb plugin logs agent-hub`.
    logClientError(raw:z.infer<typeof inputs.logClientError>) {const p=inputs.logClientError.parse(raw); bb.log.error(`Agent Hub UI crash (${p.where}): ${p.message}${p.stack ? `\n${p.stack}` : ''}`); return {ok:true as const};},
    queueStamp(raw:z.infer<typeof inputs.queueStamp>) {return {stamp:queueStamps.get(inputs.queueStamp.parse(raw).threadId) ?? 0};},
    contextStamp(raw:z.infer<typeof inputs.contextStamp>) {return contextStamps.get(inputs.contextStamp.parse(raw).threadId) ?? {stamp:0,compactedAt:null};},
    async markThreadRead(raw:z.infer<typeof inputs.markThreadRead>) {const p=inputs.markThreadRead.parse(raw), result=markRead({all:true,threadId:p.threadId}); await syncBbRead([p.threadId],true); return result;},
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
      if (!db.prepare('UPDATE pool_entries SET note=?,attachments=COALESCE(?,attachments),revision=revision+1,updated_at=? WHERE id=? AND revision=?').run(p.note,p.attachments ? JSON.stringify(p.attachments) : null,Date.now(),p.id,p.revision).changes) throw new Error('Pool entry changed or removed — refresh before editing');
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
        const entries=(db.prepare('SELECT * FROM pool_entries WHERE thread_id=? ORDER BY created_at,rowid').all(p.threadId) as Row[]).filter(entry=>!p.ids || p.ids.includes(entry.id));
        if (!entries.length) throw new Error('Pool is empty');
        checkSources(p.threadId,entries);
        const text=buildReplyMessage(entries as {quote:string;note:string}[]);
        const files=entries.flatMap(e=>JSON.parse(e.attachments as string) as Attachment[]);
        if (!text && !files.length) throw new Error('Nothing to send — write a reply first');
        const result=await deliver(p.threadId,text,files,p.send);
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
    markRead: markReadFromUi,
    owed(raw: z.infer<typeof inputs.owed>) {
      const {threadId}=inputs.owed.parse(raw);
      return driver.withThread(threadId,() => {
        expireOwed(threadId);
        const rows=db.prepare("SELECT id,question,created_at,interim FROM items WHERE thread_id=? AND kind='mine' AND status='deferred' AND dismissed_at IS NULL AND thread_id NOT IN (SELECT thread_id FROM sub_threads) ORDER BY created_at,id").all(threadId) as Row[];
        return {items:rows.map(r=>({id:r.id,question:r.question,createdAt:r.created_at,interim:!!r.interim}))};
      });
    },
    settleOwed(raw: z.infer<typeof inputs.settleOwed>) {
      const p=inputs.settleOwed.parse(raw), item=get(p.id), now=Date.now();
      if (item.kind!=='mine' || item.status!=='deferred' || item.dismissed_at!==null) throw new Error('item is not owed');
      return p.action==='answered'
        ? commit("UPDATE items SET status='answered',answered_at=?,answer_source='user',resolve_turn_id=NULL,wait_children=NULL,failed_at=NULL,updated_at=? WHERE id=?",now,now,p.id)
        : commit('UPDATE items SET dismissed_at=?,wait_children=NULL,updated_at=? WHERE id=?',now,now,p.id);
    },
    setPinned(raw: z.infer<typeof inputs.setPinned>) {const p=inputs.setPinned.parse(raw); get(p.id); return commit('UPDATE items SET pinned=?,updated_at=? WHERE id=?',Number(p.pinned),Date.now(),p.id);},
    setDismissed(raw: z.infer<typeof inputs.setDismissed>) {const p=inputs.setDismissed.parse(raw); get(p.id); return commit('UPDATE items SET dismissed_at=?,wait_children=CASE WHEN ? THEN NULL ELSE wait_children END,updated_at=? WHERE id=?',p.dismissed ? Date.now() : null,Number(p.dismissed),Date.now(),p.id);},
    async reply(raw: z.infer<typeof inputs.reply>) {
      const p=inputs.reply.parse(raw), threadId=get(p.id).thread_id as string;
      return guarded(threadId,async()=>{
        const item=get(p.id);
        if (item.thread_deleted || item.kind==='saved' || item.kind==='update') throw new Error('item cannot receive replies');
        if (item.kind==='for_me' && item.status!=='open') throw new Error('question already replied');
        const result=await deliver(threadId,buildReplyMessage([{quote:item.question,note:p.text}]),p.attachments,p.send);
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
    bb.agents.registerTool({name:`answers_${method}`,description:{list:'List this thread’s pending user questions and your own open questions to the user.',withdraw:'Withdraw your open question to the user (from answers_ask or one Answers caught in your reply text) once it no longer needs an answer. It closes with your reason and stays in the user’s history.',defer:'Defer a user question until a later turn.',resolve:'Use this turn’s final message to answer a pending question.',report:'Show this turn’s final message in the user’s history as a report, not a background update. Use it when work the user gave you finishes in a turn they did not start (another agent, a child, a script) and no question of theirs is pending.',ask:'Ask the user a question, including a decision that blocks your work. Do not wait in this turn: the reply arrives later as a user message quoting the question. Optional: 1–6 unique options (≤200 chars each), multiSelect to let the user tick several, recommended (must equal one option) and a short reason. For several related decisions ask once with questions (2–10, each with its own header, options, multiSelect, recommended): the user answers them in one form and you get one reply. Asks in the same turn merge up to 10 parts. Parts may return Skipped or Your call (decide yourself). urgency: blocking (own push, first in lists), normal, low (no push). deadlineMinutes (5–10080 integer) auto-answers with recommended; required on singles, missing part defaults to Your call.'}[method],parameters:toolInputs[method],
      async execute(raw,ctx) {
        if (migrationPending) throw new Error('Agent Hub migration failed; restart to retry before writing');
        const p=toolInputs[method].parse(raw);
        return driver.withThread(ctx.threadId,() => {
          const now=Date.now();
          if (method==='list') {
            expireOwed(ctx.threadId);
            const rows=db.prepare("SELECT id,question,note,created_at FROM items WHERE thread_id=? AND kind='mine' AND status IN ('waiting','deferred') AND dismissed_at IS NULL ORDER BY created_at DESC LIMIT 20").all(ctx.threadId) as Row[];
            const asked=db.prepare("SELECT id,question,created_at FROM items WHERE thread_id=? AND kind='for_me' AND status='open' AND dismissed_at IS NULL ORDER BY created_at DESC LIMIT 20").all(ctx.threadId) as Row[];
            const line=(r:Row)=>`${r.id} ${Math.max(0,Math.floor((now-r.created_at)/1000))}s ${r.question.slice(0,160)}${r.note ? ' — '+r.note : ''}`;
            const text=[rows.length ? rows.map(line).join('\n') : 'No pending questions.',asked.length ? 'Your open questions to the user:\n'+asked.map(line).join('\n') : ''].filter(Boolean).join('\n');
            return cap(text,2000);
          }
          if (method==='ask') {
            const id='ans_'+randomUUID();
            const ask=p as z.infer<typeof toolInputs.ask>;
            // Several questions or checkboxes go to bb's question form; the text keeps every part for the quote, push and search.
            const form=ask.questions ? ask.questions.map((q,i)=>formQuestion(`q${i+1}`,q.question,q)) : ask.multiSelect ? [formQuestion('q1',ask.question,ask)] : null;
            const text=ask.questions ? `${ask.question}\n\n${ask.questions.map((q,i)=>`${i+1}. ${q.header ? `**${q.header}.** ` : ''}${q.question}`).join('\n')}` : ask.question;
            const turn=(db.prepare('SELECT active_turn_id FROM threads_state WHERE thread_id=?').get(ctx.threadId) as Row|undefined)?.active_turn_id ?? null, deadline=ask.deadlineMinutes===undefined ? null : now+ask.deadlineMinutes*60000;
            const candidates=turn ? db.prepare("SELECT * FROM items WHERE thread_id=? AND turn_id=? AND kind='for_me' AND chat_asked=0 AND status='open' AND dismissed_at IS NULL ORDER BY created_at DESC,rowid DESC").all(ctx.threadId,turn) as Row[] : [];
            const added=form ?? [formQuestion('q1',ask.question,ask)], partsText=(parts:FormQuestion[])=>parts.map((q,i)=>`${i+1}. ${q.shortLabel ? `**${q.shortLabel}.** ` : ''}${q.prompt}`).join('\n');
            for(const old of candidates) {
              if(sending.has(ctx.threadId)) break;
              const parts:FormQuestion[]=old.questions ? JSON.parse(old.questions) : [formQuestion('q1',old.question,{options:old.options ? JSON.parse(old.options) ?? undefined : undefined,recommended:old.recommended ?? undefined,reason:old.recommend_reason ?? undefined})];
              if(parts.length+added.length>10) continue;
              const intro=parts.length>1 ? old.question.slice(0,-partsText(parts).length-2) : '';
              if(parts.length===1 && old.recommend_reason) for(const o of parts[0]!.options ?? []) if(o.value===old.recommended) o.description=`Recommended: ${old.recommend_reason}`;
              const merged=[...parts,...added].map((q,i)=>({...q,id:`q${i+1}`})), rank=(v:string|null|undefined)=>v==='blocking' ? 2 : v==='low' ? 0 : 1;
              const urgency=rank(ask.urgency)>rank(old.urgency) ? ask.urgency! : old.urgency, raised=urgency==='blocking' && old.urgency!=='blocking';
              const due=old.deadline_at===null ? deadline : deadline===null ? old.deadline_at : Math.min(old.deadline_at,deadline);
              commit("UPDATE items SET question=?,questions=?,options=NULL,recommended=NULL,recommend_reason=NULL,urgency=?,deadline_at=?,notify_state=CASE WHEN ? THEN 1 ELSE notify_state END,updated_at=? WHERE id=? AND status='open'",(intro ? intro+'\n\n' : '')+partsText(merged),JSON.stringify(merged),urgency,due,Number(raised),now,old.id);
              if(raised) onAttention(); wakeDue();
              return `${old.id}\nMerged into your earlier question from this turn; the user answers all parts in one form.`;
            }
            commit("INSERT INTO items(id,kind,thread_id,project_id,status,question,options,questions,recommended,recommend_reason,deadline_at,urgency,notify_state,turn_id,created_at,updated_at) VALUES (?,'for_me',?,?,'open',?,?,?,?,?,?,?,?,?,?,?)",id,ctx.threadId,ctx.projectId ?? null,text,JSON.stringify(form ? null : ask.options ?? null),form && JSON.stringify(form),ask.recommended ?? null,ask.reason ?? null,deadline,ask.urgency ?? null,ask.urgency==='low' ? 0 : 1,turn,now,now);
            onAttention(); wakeDue();
            return id;
          }
          if (method==='report') {
            if (db.prepare('SELECT 1 FROM sub_threads WHERE thread_id=?').get(ctx.threadId)) return 'This sub-thread’s final message stays in its read chat history.';
            const state=db.prepare('SELECT active_turn_id FROM threads_state WHERE thread_id=?').get(ctx.threadId) as {active_turn_id:string|null} | undefined;
            if (!state?.active_turn_id) throw new Error('no active turn');
            commit('INSERT INTO turn_updates(thread_id,turn_id,started_at,report) VALUES (?,?,?,1) ON CONFLICT(thread_id,turn_id) DO UPDATE SET report=1',ctx.threadId,state.active_turn_id,now);
            return 'This turn’s final message will reach the user as a report.';
          }
          if (method==='withdraw') {
            const {id,reason}=p as z.infer<typeof toolInputs.withdraw>;
            const item=db.prepare('SELECT * FROM items WHERE id=?').get(id) as Row | undefined;
            if (!item || item.thread_id!==ctx.threadId || item.kind!=='for_me' || item.status!=='open' || item.dismissed_at!==null) throw new Error('open question not found in calling thread');
            // answer_source='agent' tells a withdrawal from the owner's "Won't reply"; an owner reply still goes through afterwards.
            commit("UPDATE items SET dismissed_at=?,answer_source='agent',note=?,notify_state=0,updated_at=? WHERE id=?",now,reason,now,id);
            return 'Withdrawn.';
          }
          const params=p as {id?:string;note?:string};
          const item=params.id ? get(params.id) : db.prepare("SELECT * FROM items WHERE thread_id=? AND kind='mine' AND status='waiting' ORDER BY question_seq DESC LIMIT 1").get(ctx.threadId) as Row | undefined;
          // The owner may mark an owed question answered before the agent's report lands; resolving it still attaches that report.
          const settledByOwner=method==='resolve' && item?.status==='answered' && item.answer_source==='user' && item.answer===null && item.dismissed_at===null;
          if (!item || item.thread_id!==ctx.threadId || item.kind!=='mine' || !(['waiting','deferred'].includes(item.status) || settledByOwner)) throw new Error('pending question not found in calling thread');
          // The owner's messages one turn handles (a question and the steers added to it) are deferred and resolved together,
          // so the turn's reply is not an answer to one and an interim to another.
          const mates="(id=? OR (thread_id=? AND kind='mine' AND turn_id IS NOT NULL AND turn_id=? AND steer_seq IS NULL AND status IN ('waiting','deferred')))";
          if (method==='defer') commit(`UPDATE items SET status='deferred',note=?,wait_children=NULL,updated_at=? WHERE ${mates}`,params.note ?? null,now,item.id,ctx.threadId,item.turn_id ?? null);
          else {
            const state=db.prepare('SELECT active_turn_id FROM threads_state WHERE thread_id=?').get(ctx.threadId) as {active_turn_id:string|null};
            if (!state?.active_turn_id) throw new Error('no active turn');
            commit(`UPDATE items SET resolve_turn_id=?,candidate=NULL,candidate_seq=NULL,updated_at=? WHERE ${mates}`,state.active_turn_id,now,item.id,ctx.threadId,item.turn_id ?? null);
          }
          return item.id as string;
        });
      },
    });
  }
  bb.agents.contributeInstructions(() => INSTRUCTIONS);
  registerCli(bb,{config,list,markRead,db,migrationStatus:()=>migrationStatus(bb,db,migrationError),status:(threadId?:string)=>{
    if (threadId) {const row=db.prepare('SELECT last_seq AS lastSeq,last_error AS lastError FROM threads_state WHERE thread_id=?').get(threadId) as {lastSeq:number;lastError:string|null}|undefined; return {threadId,tracked:!!row,archived:!!db.prepare('SELECT 1 FROM archived_threads WHERE thread_id=?').get(threadId),...row,items:(db.prepare('SELECT count(*) AS n FROM items WHERE thread_id=?').get(threadId) as {n:number}).n};}
    const n=(sql:string)=>(db.prepare(sql).get() as {n:number}).n, archived=n('SELECT count(*) AS n FROM threads_state WHERE thread_id IN (SELECT thread_id FROM archived_threads)');
    // Errors are capped so the output stays small; --thread shows one in full.
    return {counts:counts(),threads:{active:n('SELECT count(*) AS n FROM threads_state')-archived,archived},errors:{total:n('SELECT count(*) AS n FROM threads_state WHERE last_error IS NOT NULL'),latest:(db.prepare('SELECT thread_id AS threadId,substr(last_error,1,200) AS error FROM threads_state WHERE last_error IS NOT NULL ORDER BY rowid DESC LIMIT 10').all())}};
  }});
  // The event payload avoids a metadata lookup for both contacts and sub-sessions.
  if (!migrationPending) bb.events.on('experimental_thread.events',({thread})=>driver.schedule(thread.id,thread).catch(e=>bb.log.warn(`Agent Hub ingest: ${String(e)}`)));
  // bb pushes no queue changes to plugin apps; a per-thread stamp lets an open chat re-read its queue as soon as a row
  // is queued, dispatched or deleted anywhere (bb's chat, an agent's thread tell, a script).
  for (const name of ['message.queued','message.dispatched','message.cancelled'] as const) bb.events.on(name,({entry})=>{queueStamps.set(entry.threadId,(queueStamps.get(entry.threadId) ?? 0)+1); bb.rpc.experimental_invalidate([QUEUE_TAG]);});
  bb.events.on('thread.deleted',({thread})=>driver.deleteThread(thread.id));
  const hasItems = (id: string) => !!db.prepare('SELECT 1 FROM items WHERE thread_id=? LIMIT 1').get(id);
  bb.events.on('thread.archived',({thread})=>{db.prepare('INSERT OR IGNORE INTO archived_threads VALUES (?)').run(thread.id); if (hasItems(thread.id)) invalidate();});
  bb.events.on('thread.unarchived',({thread})=>{db.prepare('DELETE FROM archived_threads WHERE thread_id=?').run(thread.id); if (hasItems(thread.id)) invalidate();});
  bb.events.on('turn.failed',event=>{
    if (!event.inputAccepted && failRequest(db,event.threadId,event.requestId,Date.now(),true,true)) {invalidate(); onAttention();}
  });
  notifier.settings.onChange(next=>{reminderSettingsChanged=true;remindHours=next.remindHours;wakeDue();});
  void notifier.settings.get().then(next=>{if(reminderSettingsChanged) return;remindHours=next.remindHours;wakeDue();}).catch(e=>bb.log.warn(`Agent Hub reminders: ${String(e)}`));
  wakeDue();
  const startup = (migrationPending ? Promise.resolve() : driver.reconcile()).catch(e=>bb.log.warn(`Agent Hub discovery: ${String(e)}`));
  bb.onDispose(async()=>{disposed=true; projectCache=undefined; threadCache.clear(); if (wakeTimer) clearTimeout(wakeTimer); await driver.dispose(); await startup; await notifier.dispose(); invOff=true; if (invTimer) clearTimeout(invTimer);});
}
