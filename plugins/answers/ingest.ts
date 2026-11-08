import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

// "Archive the sessions" → "Archived": a short note without a question that got a short reply needs no Inbox slot.
export const QUIET_SQL = "length(trim(question))<=60 AND instr(question,'?')=0 AND instr(question,'？')=0 AND length(trim(answer))<=160";
export const QUESTION_SQL = "(instr(question,'?')>0 OR instr(question,'？')>0)";
export const RELEVANT = ['client/turn/requested','turn/started','turn/input/accepted','item/completed','turn/completed'] as const;
export const cap = (text: string, max: number) => text.length <= max ? text : text.slice(0, max - '… (truncated, open in chat)'.length) + '… (truncated, open in chat)';
export type Event = { seq: number; type: string; scope?: { kind?: string; turnId?: string }; data: any; createdAt?: number };

/** Apply an ascending page inside the caller's transaction; returns whether anything the UI shows changed. */
/** `trackQuestions` is false for agent-spawned threads, whose "user" turns come from agents and scripts. */
export function applyEvents(db: Database.Database, threadId: string, events: Event[], projectId: string | null = null, now = 0, trackQuestions = true): boolean {
 // Writes that only move bookkeeping (pending candidate text, turn links, the cursor) are not worth a UI refetch.
 const total = () => (db.prepare('SELECT total_changes() AS n').get() as {n:number}).n, start = total();
 let hidden = 0;
 hidden += db.prepare('INSERT OR IGNORE INTO threads_state(thread_id,last_seq,updated_at) VALUES (?,0,?)').run(threadId,now).changes;
 let state = db.prepare('SELECT last_seq,active_turn_id FROM threads_state WHERE thread_id=?').get(threadId) as {last_seq:number;active_turn_id:string|null};
 let cursor = state.last_seq, active = state.active_turn_id;
 for (const e of events) {
  if (e.seq <= cursor) continue;
  const d = e.data ?? {}, turn = e.scope?.turnId;
  if (e.type === 'client/turn/requested') {
   if (d.retryOfRequestId && d.requestId) {
    const original = db.prepare(`SELECT id FROM items WHERE thread_id=? AND request_id=? UNION SELECT item_id AS id FROM request_aliases WHERE thread_id=? AND alias_request_id=? LIMIT 1`).get(threadId,d.retryOfRequestId,threadId,d.retryOfRequestId) as {id:string}|undefined;
    if (original) { db.prepare('INSERT OR IGNORE INTO request_aliases VALUES (?,?,?)').run(threadId,d.requestId,original.id); cursor=e.seq; continue; }
   }
   const text = (Array.isArray(d.input) ? d.input : []).filter((x:any) => x.type === 'text' && typeof x.text === 'string').map((x:any) => x.text).join('\n').trim();
   const mention = d.input?.find((x:any) => x.type === 'text')?.mentions?.[0];
   const command = mention?.resource?.kind === 'command' && (mention.start === 0 || mention.range?.start === 0) && (mention.end === text.length || mention.range?.end === text.length);
   if (trackQuestions && d.initiator === 'user' && d.senderThreadId == null && d.originPluginId == null && text && !command) {
    db.prepare(`INSERT OR IGNORE INTO items(id,kind,thread_id,project_id,status,question,question_seq,request_id,created_at,updated_at) VALUES (?,'mine',?,?,'waiting',?,?,?,?,?)`).run('ans_'+createHash('sha256').update(threadId+'|'+e.seq).digest('hex'),threadId,projectId,cap(text,4000),e.seq,d.requestId ?? null,e.createdAt ?? now,now);
   }
  } else if (e.type === 'turn/started' && turn && !d.parentToolCallId) active=turn;
  else if (e.type === 'turn/input/accepted' && turn && active === turn && d.clientRequestId) {
   hidden += db.prepare(`UPDATE items SET candidate=CASE WHEN turn_id=? THEN candidate ELSE NULL END,candidate_seq=CASE WHEN turn_id=? THEN candidate_seq ELSE NULL END,turn_id=?,updated_at=? WHERE thread_id=? AND (request_id=? OR id IN (SELECT item_id FROM request_aliases WHERE thread_id=? AND alias_request_id=?))`).run(turn,turn,turn,now,threadId,d.clientRequestId,threadId,d.clientRequestId).changes;
  } else if (e.type === 'item/completed' && turn && d.item?.type === 'agentMessage' && !d.item.parentToolCallId && typeof d.item.text === 'string') {
   hidden += db.prepare(`UPDATE items SET candidate=?,candidate_seq=?,updated_at=? WHERE thread_id=? AND ((turn_id=? AND status IN ('waiting','deferred') AND question_seq<?) OR resolve_turn_id=?)`).run(cap(d.item.text,20000),e.seq,now,threadId,turn,e.seq,turn).changes;
  } else if (e.type === 'turn/completed' && turn) {
   if (d.status === 'completed') {
    db.prepare(`UPDATE items SET status='answered',answer=candidate,answer_seq=candidate_seq,answer_source='agent',read_at=NULL,updated_at=? WHERE thread_id=? AND resolve_turn_id=? AND length(trim(candidate))>0`).run(now,threadId,turn);
    db.prepare(`UPDATE items SET status='answered',answer=candidate,answer_seq=candidate_seq,answer_source='turn',read_at=NULL,updated_at=? WHERE thread_id=? AND turn_id=? AND status='waiting' AND resolve_turn_id IS NULL AND length(trim(candidate))>0`).run(now,threadId,turn);
    db.prepare(`UPDATE items SET interim=candidate,interim_seq=candidate_seq,updated_at=? WHERE thread_id=? AND turn_id=? AND status='deferred' AND resolve_turn_id IS NULL AND length(trim(candidate))>0`).run(now,threadId,turn);
    db.prepare(`UPDATE items SET read_at=? WHERE thread_id=? AND (turn_id=? OR resolve_turn_id=?) AND kind='mine' AND status='answered' AND read_at IS NULL AND ${QUIET_SQL}`).run(now,threadId,turn,turn);
   } else if (d.status === 'failed' || d.status === 'interrupted') {
    db.prepare(`UPDATE items SET interim=candidate,interim_seq=candidate_seq,updated_at=? WHERE thread_id=? AND (turn_id=? OR resolve_turn_id=?) AND length(trim(candidate))>0`).run(now,threadId,turn,turn);
    // The user pressed Stop (often to resend a reworded message): the message was cancelled, so it leaves the
    // plugin entirely; the chat still has it. One already quoted in a reply pool is only hidden, to keep the pool valid.
    if (d.status === 'interrupted') {
     const cancelled = `thread_id=? AND turn_id=? AND kind='mine' AND status='waiting' AND resolve_turn_id IS NULL`;
     db.prepare(`DELETE FROM items WHERE ${cancelled} AND id NOT IN (SELECT item_id FROM pool_entries WHERE item_id IS NOT NULL)`).run(threadId,turn);
     db.prepare(`UPDATE items SET dismissed_at=?,updated_at=? WHERE ${cancelled} AND dismissed_at IS NULL`).run(now,now,threadId,turn);
    }
   }
   hidden += db.prepare('UPDATE items SET candidate=NULL,candidate_seq=NULL,resolve_turn_id=CASE WHEN resolve_turn_id=? THEN NULL ELSE resolve_turn_id END WHERE thread_id=? AND (turn_id=? OR resolve_turn_id=?)').run(turn,threadId,turn,turn).changes;
   if (active === turn) active=null;
  }
  cursor=e.seq;
 }
 hidden += db.prepare('UPDATE threads_state SET last_seq=?,active_turn_id=?,last_error=NULL,updated_at=? WHERE thread_id=?').run(cursor,active,now,threadId).changes;
 return total() - start > hidden;
}
