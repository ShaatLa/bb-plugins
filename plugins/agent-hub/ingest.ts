import { projectSchema } from './project-config';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

// "Archive the sessions" → "Archived": a short note without a question that got a short reply needs no Inbox slot.
export const QUIET_SQL = "length(trim(question))<=60 AND instr(question,'?')=0 AND instr(question,'？')=0 AND length(trim(answer))<=160";
export const QUESTION_SQL = "(instr(question,'?')>0 OR instr(question,'？')>0)";
// Archived threads leave the Inbox, counts and pushes; their items come back if the thread is unarchived.
export const ACTIVE_THREAD_SQL = "thread_id NOT IN (SELECT thread_id FROM archived_threads)";
// Explicit asks still reach the owner when a sub-agent calls agent_hub_ask.
export const CHAT_QUESTION_WARNING = '[agent-hub] Your last reply asks the owner a question in chat. Call `agent_hub_ask` now with that question (add options and recommended if you have them), then end the turn without waiting; the answer arrives as a new message.';
// In a sub-session the owner still gets explicit asks and replies to the owner's own messages (not the brief it was spawned with, nor a quoted answer to the agent's question); the rest there is background.
export const OWNER_ITEM_SQL = "(thread_id NOT IN (SELECT thread_id FROM sub_threads) OR (kind='for_me' AND chat_asked=0) OR (kind='mine' AND spawned=0 AND answers_ask=0))";
export const ATTENTION_SQL = OWNER_ITEM_SQL + " AND thread_id NOT IN (SELECT thread_id FROM archived_threads) AND dismissed_at IS NULL AND declined_at IS NULL AND read_at IS NULL AND snoozed_until IS NULL AND ((kind IN ('mine','update') AND status='answered') OR (kind='for_me' AND status='open') OR (kind='mine' AND status IN ('waiting','deferred') AND failed_at IS NOT NULL))";
// A question the agent put to the owner as plain text: the last sentence ending in '?' outside code, links, blockquotes and
// quoted phrases, that does not name the channel it was asked through (a card, Agent Hub). A short one ("Хотите?") keeps the
// sentence before it for context; table rows only list.
const CHANNEL_RE = /на карточк|в answers|через answers|agent_hub_ask|answers_ask|on the card|in answers|via answers|in agent hub|via agent hub|в agent hub|через agent hub/i;
export function chatQuestion(text: string): string | null {
 const blank = (m: string) => m.replace(/[^\n]/g, ' ');
 const mask = text.replace(/(```|~~~)[\s\S]*?(?:\1|$)/g, blank).replace(/`[^`\n]*`/g, blank).replace(/^[ \t]*>.*$/gm, blank).replace(/^[ \t]*\|.*\|[ \t]*$/gm, blank)
  .replace(/«[^»\n]*»|"[^"\n]*"|“[^”\n]*”/g, blank).replace(/\]\([^)\s]*\)/g, m => ']' + blank(m.slice(1))).replace(/\b(?:https?|ftp):\/\/\S+|\bwww\.\S+/gi, blank);
 const sentences: [number, number][] = [];
 for (const m of mask.matchAll(/[?？](?=[\s)\]*_]|$)/g)) {
  const end = m.index! + 1, start = Math.max(...['.', '!', '?', '？', '…', '\n'].map(c => mask.lastIndexOf(c, m.index! - 1))) + 1;
  sentences.push([start, end]);
 }
 const clean = (s: string) => s.replace(/^[\s>*_#-]+|[*_]+$/g, '').trim();
 for (let i = sentences.length - 1; i >= 0; i--) {
  const [start, end] = sentences[i]!, sentence = clean(text.slice(start, end));
  if (sentence.length < 3 || CHANNEL_RE.test(sentence)) continue;
  if (sentence.length >= 40) return sentence.slice(0, 2000);
  const before = mask.slice(0, start).replace(/\s+$/, ''), from = Math.max(...['.', '!', '?', '？', '…', '\n'].map(c => before.lastIndexOf(c, before.length - 2))) + 1;
  return clean(text.slice(from, end)).slice(0, 2000) || sentence;
 }
 return null;
}
// An update seemingly asks the owner something when a '?' ends a phrase outside code, links, URLs and quotes ('?query=' does not).
export function asksOwner(text: string) {
 const prose = text.replace(/(```|~~~)[\s\S]*?(?:\1|$)/g,' ').replace(/`[^`\n]*`/g,' ').replace(/^[ \t]*>.*$/gm,' ').replace(/\]\([^)\s]*\)/g,'] ').replace(/\b(?:https?|ftp):\/\/\S+|\bwww\.\S+/gi,' ');
 if (/[?？](?=[\s)\]»"'”’*_!]|$)/.test(prose)) return true;
 // A handoff counts only when it is due now: "когда оба одобрят, нужна ваша команда" is a status line, not a request.
 return prose.split(/[.!;\n]+/).some(sentence => HANDOFF_RE.test(sentence) && !CONDITION_RE.test(sentence));
}
const SUBJECT_RE = /\b[A-Z][A-Z0-9]*-\d+\b|#\d+\b|\bans_[0-9a-f]{6,}\b/g, LIST_LINE = /^\s*(?:(?:[-*+]|\d+[.)])\s.*)?$/;
// "The rest still wait on you" names nothing but points back at items the owner already has.
const STANDING_RE = /остальн|прежн|по-прежнему|вс[её] ещё|\b(?:still|remaining|other|else)\b/i;
// A reply hands nothing new over when every phrase that hands work over names only tasks, PRs or questions that text already
// shown to the owner named, or names nothing and points back at standing items; a header takes the names of the list under it.
export function restatesOnly(text: string, shown: string) {
 const known = new Set(shown.match(SUBJECT_RE) ?? []), lines = text.split('\n');
 let handoffs = 0;
 for (let i = 0; i < lines.length; i++) for (const phrase of lines[i]!.split(/(?<=[.!?？;])\s+/)) {
  if (!asksOwner(phrase)) continue;
  handoffs++;
  const subjects: string[] = phrase.match(SUBJECT_RE) ?? [];
  if (!subjects.length) for (let j = i + 1; j < lines.length && LIST_LINE.test(lines[j]!); j++) subjects.push(...lines[j]!.match(SUBJECT_RE) ?? []);
  if (subjects.length ? !subjects.every(x => known.has(x)) : !STANDING_RE.test(phrase)) return false;
 }
 return handoffs > 0;
}
const CONDITION_RE = /(?:^|[^а-яё])(?:когда|после|как только|если|потом)(?![а-яё])|\b(?:when|once|after|if)\b/i;
// Work handed to the owner with no '?': "EXA-1 готова к вашей проверке", "снова у вас", "ваших решений ждут", "ready for your review".
const HANDOFF_RE = /готов[аоы]? к ваш(?:ей|ему|им) (?:проверк|приёмк|приемк|ревью|решени|оценк)|(?:снова|теперь) у вас(?![а-яё])|жд[ёе]т ваш|ждут ваш|ваш(?:его|ей|их|е|и|у|а)?\s+(?:решени|ответ|провер|при[её]мк|оценк|ревью|команд|одобрени|подтвержд|выбор)[а-яё]*\s+(?:жд(?:[ёе]т|ут)|нужн)|жд[ёе]т вас(?![а-яё])|нужн[оаы]? ваш|на вашей стороне|поставил вас|перев[её]л[аи]? (?:её |его |их )?на вас|ready for your (?:review|acceptance|approval|decision|check)|(?:waiting|wait) (?:for|on) you|awaits? your|awaiting your|needs? your (?:review|approval|decision|input|answer|go-ahead|command|ok)|(?:back|over) to you|assigned (?:it |this )?to you|your call(?![a-z])/i;
export const INTERIM_RE = /делегир|доложу|сообщу, когда|отпишусь|вернусь с (ответом|результат)|как (только )?(будет|закончит)|жду (результат|ответ|завершени)|delegat|will report back|i'll (get back|report|follow up)|once (it|they|the \w+) (finish|complete)|waiting (for|on) (the )?(child|sub-?agent|thread|result)/i;
// One failed attempt can arrive twice (live turn.failed hook, then the persisted rejection); record it once.
export function failRequest(db: Database.Database, threadId:string, requestId:string, at:number, live:boolean, onlyNew=false) {
 return db.prepare(`UPDATE items SET failed_at=?,attempt_request_id=?,read_at=NULL,notify_state=?,updated_at=? WHERE thread_id=? AND status='waiting' AND (${onlyNew ? 'failed_at IS NULL' : '1=1'}) AND NOT (failed_at IS NOT NULL AND attempt_request_id IS ?) AND (request_id=? OR id IN (SELECT item_id FROM request_aliases WHERE thread_id=? AND alias_request_id=?))`).run(at,requestId,Number(live),at,threadId,requestId,requestId,threadId,requestId).changes;
}
// A leading [tag] (a letter, 3–60 chars, then whitespace) marks a script's message; '[EXA-12](link)' and '[x]' do not match.
export const SCRIPT_TAG = /^\[([A-Za-z][^\]\n]{2,59})\]\s/;
export const RELEVANT = ['client/turn/rejected','client/turn/requested','turn/started','turn/input/accepted','item/completed','turn/completed','system/operation'] as const;
// Read only while catching up (not on first sight, whose 1,500-event window it would crowd): it tells the open chat to
// reread its context ring, and ingest ignores it.
export const CONTEXT_EVENT = 'thread/contextWindowUsage/updated' as const, COMPACTED_EVENT = 'thread/compacted' as const;
export const cap = (text: string, max: number) => text.length <= max ? text : text.slice(0, max - '… (truncated, open in chat)'.length) + '… (truncated, open in chat)';
export type Event = { seq: number; type: string; scope?: { kind?: string; turnId?: string }; data: any; createdAt?: number };

/** Drops a finished child from every deferred item waiting for it; an emptied list ('[]') is settled by the driver, which
 * either waits for children started since (a later wave) or answers the question with the latest report. */
/** Apply an ascending page inside the caller's transaction; returns whether anything the UI shows changed. */
/** `trackQuestions` is false for sub-threads: their history stays read and never files chat questions. */
// One message from another thread or a plugin per turn: the chat item shown when the turn took it.
// shortcut: a length and work-count heuristic for "the owner's answer came before the steer"; replace it if agents get a way to say which message answers whom.
// shortcut: what the owner was shown in the last day counts as already handed over; widen it if standing items outlive it.
const RESTATE_WINDOW = 86_400_000;
const STEER_ANSWER_MIN = 400, STEER_TOOLS_MAX = 3;
const turnUpdateId = (threadId: string, turn: string) => 'ans_'+createHash('sha256').update(threadId+'|turn-update|'+turn).digest('hex');
export function applyEvents(db: Database.Database, threadId: string, events: Event[], projectId: string | null = null, now = 0, trackQuestions = true, live = false, onWarning?: (text: string, at: number, turn: string, seq: number) => void, channelCommands: string[] = projectSchema.parse({}).channelCommands): boolean {
 // Writes that only move bookkeeping (pending candidate text, turn links, the cursor) are not worth a UI refetch.
 const total = () => (db.prepare('SELECT total_changes() AS n').get() as {n:number}).n, start = total();
 let hidden = 0;
 if (!trackQuestions) hidden += db.prepare('INSERT OR IGNORE INTO sub_threads VALUES (?)').run(threadId).changes;
 hidden += db.prepare('INSERT OR IGNORE INTO threads_state(thread_id,last_seq,updated_at) VALUES (?,0,?)').run(threadId,now).changes;
 let state = db.prepare('SELECT last_seq,active_turn_id FROM threads_state WHERE thread_id=?').get(threadId) as {last_seq:number;active_turn_id:string|null};
 let cursor = state.last_seq, active = state.active_turn_id;
 for (const e of events) {
  if (e.seq <= cursor) continue;
  const d = e.data ?? {}, turn = e.scope?.turnId;
  if (e.type === 'system/operation' && d.operation === 'edit_message' && typeof d.metadata?.cutoffSequence === 'number') {
   // bb deleted this thread's events from the edited message on; the chat drops what they made, as bb's does.
   const cut = d.metadata.cutoffSequence, removed = d.metadata.removedTurnId ?? null;
   const from = (db.prepare("SELECT created_at FROM items WHERE thread_id=? AND kind='mine' AND question_seq=?").get(threadId,cut) as {created_at:number}|undefined)?.created_at ?? null;
   const gone = `thread_id=? AND id NOT IN (SELECT id FROM notices) AND kind IN ('mine','update','for_me') AND (coalesce(question_seq,answer_seq,interim_seq,-1)>=? OR (kind='update' AND question_seq IS NULL AND answer_seq IS NULL AND created_at>=coalesce(?,9e15)))`;
   db.prepare(`UPDATE items SET dismissed_at=coalesce(dismissed_at,?),updated_at=? WHERE ${gone} AND id IN (SELECT item_id FROM pool_entries WHERE item_id IS NOT NULL)`).run(now,now,threadId,cut,from);
   db.prepare(`DELETE FROM items WHERE ${gone} AND id NOT IN (SELECT item_id FROM pool_entries WHERE item_id IS NOT NULL)`).run(threadId,cut,from);
   // shortcut: an earlier question answered by a removed turn keeps that answer; reopen it if edits of deferred threads matter.
   if (removed) { db.prepare('DELETE FROM turn_updates WHERE thread_id=? AND turn_id=?').run(threadId,removed); if (active === removed) active = null; }
   cursor=e.seq; continue;
  }
  if (e.type === 'client/turn/requested') {
   if (d.retryOfRequestId && d.requestId) {
    // A retried non-owner request keeps its original trigger.
    hidden += db.prepare('UPDATE OR IGNORE request_triggers SET request_id=? WHERE thread_id=? AND request_id=?').run(d.requestId,threadId,d.retryOfRequestId).changes;
    const original = db.prepare(`SELECT id FROM items WHERE thread_id=? AND request_id=? UNION SELECT item_id AS id FROM request_aliases WHERE thread_id=? AND alias_request_id=? LIMIT 1`).get(threadId,d.retryOfRequestId,threadId,d.retryOfRequestId) as {id:string}|undefined;
    if (original) { hidden += db.prepare('UPDATE items SET attempt_request_id=? WHERE id=?').run(d.requestId,original.id).changes; db.prepare('INSERT OR IGNORE INTO request_aliases VALUES (?,?,?)').run(threadId,d.requestId,original.id); cursor=e.seq; continue; }
   }
   const text = (Array.isArray(d.input) ? d.input : []).filter((x:any) => x.type === 'text' && typeof x.text === 'string').map((x:any) => x.text).join('\n').trim();
   const attachments = (Array.isArray(d.input) ? d.input : []).filter((x:any) => (x.type === 'localImage' || x.type === 'localFile') && typeof x.path === 'string').map((x:any) => ({type:x.type,path:x.path,...(x.name ? {name:x.name} : {}),...(x.mimeType ? {mimeType:x.mimeType} : {}),...(x.sizeBytes != null ? {sizeBytes:x.sizeBytes} : {}),...(x.hostId ? {hostId:x.hostId} : {}),...(x.sourceProjectId ? {sourceProjectId:x.sourceProjectId} : {})}));
   const mention = d.input?.find((x:any) => x.type === 'text')?.mentions?.[0];
   const command = mention?.resource?.kind === 'command' && (mention.start === 0 || mention.range?.start === 0) && (mention.end === text.length || mention.range?.end === text.length);
   // Messages other plugins send are noise; the owner's own words sent through Agent Hub (Reply, pool, quote popup) still count.
   // bb records a script's `bb thread tell` into its own thread as the user's; such scripts start the text with a [tag].
   const tag = SCRIPT_TAG.exec(text)?.[1] ?? null;
   if (!tag && d.initiator === 'user' && d.senderThreadId == null && (d.originPluginId == null || ['agent-hub','answers'].includes(d.originPluginId)) && (text || attachments.length > 0) && !command) {
    // A message that opens with a quote of the agent's question answers it (Agent Hub's Reply sends it so).
    const quote = /^(?:>.*(?:\n|$))+/.exec(text)?.[0].split('\n').map(line => line.replace(/^> ?/,'')).join('\n').trim();
    const answersAsk = !!quote && !!db.prepare("SELECT 1 FROM items WHERE thread_id=? AND kind='for_me' AND instr(question,?)>0").get(threadId,quote);
    db.prepare(`INSERT OR IGNORE INTO items(id,kind,thread_id,project_id,status,question,attachments,question_seq,request_id,attempt_request_id,spawned,answers_ask,created_at,updated_at) VALUES (?,'mine',?,?,'waiting',?,?,?,?,?,?,?,?,?)`).run('ans_'+createHash('sha256').update(threadId+'|'+e.seq).digest('hex'),threadId,projectId,cap(text,4000),JSON.stringify(attachments),e.seq,d.requestId ?? null,d.requestId ?? null,Number(d.source === 'spawn'),Number(answersAsk),e.createdAt ?? now,now);
   } else if (d.requestId) {
    // Remember what else can start a turn, so its final message can reach the owner as an update.
    const kind = d.senderThreadId ? 'agent' : d.originPluginId ? 'plugin' : d.initiator === 'system' ? 'system' : 'other';
    // A tagged script message is an 'other' trigger named by its tag.
    const source = kind === 'agent' ? d.senderThreadId : kind === 'plugin' ? d.originPluginId : kind === 'system' ? /@thread:(thr_[\w-]+) completed/.exec(text)?.[1] ?? null : tag;
    hidden += db.prepare('INSERT OR IGNORE INTO request_triggers(thread_id,request_id,kind,source_id,text) VALUES (?,?,?,?,?)').run(threadId,d.requestId,kind,source,cap(text,4000)).changes;
   }
  } else if (e.type === 'client/turn/rejected' && d.requestId) {
   failRequest(db,threadId,d.requestId,e.createdAt ?? now,live);
  } else if (e.type === 'turn/started' && turn && !d.parentToolCallId) {
   active=turn;
   hidden += db.prepare('INSERT OR IGNORE INTO turn_updates(thread_id,turn_id,started_at) VALUES (?,?,?)').run(threadId,turn,e.createdAt ?? now).changes;
   // A steer the previous turn never showed the agent is read by this one (bb hands queued input to the next turn).
   hidden += db.prepare("UPDATE items SET turn_id=?,steer_seq=NULL WHERE thread_id=? AND kind='mine' AND status='waiting' AND steer_seq IS NOT NULL").run(turn,threadId).changes;
  }
  else if (e.type === 'turn/input/accepted' && turn && active === turn && d.clientRequestId) {
   db.prepare(`UPDATE items SET failed_at=NULL WHERE thread_id=? AND failed_at IS NOT NULL AND (request_id=? OR id IN (SELECT item_id FROM request_aliases WHERE thread_id=? AND alias_request_id=?))`).run(threadId,d.clientRequestId,threadId,d.clientRequestId);
   hidden += db.prepare(`UPDATE items SET attempt_request_id=?,candidate=CASE WHEN turn_id=? THEN candidate ELSE NULL END,candidate_seq=CASE WHEN turn_id=? THEN candidate_seq ELSE NULL END,turn_id=?,updated_at=? WHERE thread_id=? AND (request_id=? OR id IN (SELECT item_id FROM request_aliases WHERE thread_id=? AND alias_request_id=?))`).run(d.clientRequestId,turn,turn,turn,now,threadId,d.clientRequestId,threadId,d.clientRequestId).changes;
   // The turn's trigger is the first input it accepted; an owner message has no trigger row and counts as 'other'.
   const trigger = db.prepare('SELECT kind,source_id,text FROM request_triggers WHERE thread_id=? AND request_id=?').get(threadId,d.clientRequestId) as {kind:string;source_id:string|null;text:string}|undefined;
   const first = db.prepare('UPDATE turn_updates SET kind=?,source_id=?,question=? WHERE thread_id=? AND turn_id=? AND kind IS NULL').run(trigger?.kind ?? 'other',trigger?.source_id ?? null,trigger?.text ?? '',threadId,turn).changes;
   hidden += first;
   // bb shows another thread's or a plugin's message and a child's completion the moment the turn takes it; so does the chat, answered at turn end.
   // A script wake keeps appearing only with a reply.
   const shows = trigger?.kind === 'agent' || trigger?.kind === 'plugin' || trigger?.kind === 'system';
   if (first && shows) db.prepare(`INSERT OR IGNORE INTO items(id,kind,thread_id,project_id,status,question,read_at,trigger_kind,trigger_source,created_at,updated_at) VALUES (?,'update',?,?,'waiting',?,?,?,?,?,?)`).run(turnUpdateId(threadId,turn),threadId,projectId,trigger.text,e.createdAt ?? now,trigger.kind,trigger.source_id,e.createdAt ?? now,now);
   // One that joins a turn already under way (a steer, or a second message taken with the first) shows, read, and keeps the turn so the chat
   // can place it by the owner's message that turn answers. A steer taken mid-turn keeps its request and an unseen mark: once the agent sees
   // it (its next tool result), what the agent writes is its reply, not the owner's answer.
   else if (shows) { const steer = !!(db.prepare('SELECT busy FROM turn_updates WHERE thread_id=? AND turn_id=?').get(threadId,turn) as {busy:number}|undefined)?.busy;
    hidden += db.prepare(`INSERT OR IGNORE INTO items(id,kind,thread_id,project_id,status,question,answered_at,read_at,trigger_kind,trigger_source,turn_id,request_id,steer_seq,created_at,updated_at) VALUES (?,'update',?,?,'answered',?,?,?,?,?,?,?,?,?,?)`).run('ans_'+createHash('sha256').update(threadId+'|joined|'+d.clientRequestId).digest('hex'),threadId,projectId,trigger.text,e.createdAt ?? now,e.createdAt ?? now,trigger.kind,trigger.source_id,turn,steer ? d.clientRequestId : null,steer ? e.seq : null,e.createdAt ?? now,now).changes; }
   hidden += db.prepare('DELETE FROM request_triggers WHERE thread_id=? AND request_id=?').run(threadId,d.clientRequestId).changes;
   // Accepted while the turn was already producing items: a steer, unseen until the agent's next tool result.
   if ((db.prepare('SELECT busy FROM turn_updates WHERE thread_id=? AND turn_id=?').get(threadId,turn) as {busy:number}|undefined)?.busy)
    hidden += db.prepare(`UPDATE items SET steer_seq=? WHERE thread_id=? AND kind='mine' AND (request_id=? OR id IN (SELECT item_id FROM request_aliases WHERE thread_id=? AND alias_request_id=?))`).run(e.seq,threadId,d.clientRequestId,threadId,d.clientRequestId).changes;
  } else if (e.type === 'item/completed' && turn && d.item && !d.item.parentToolCallId && d.item.type !== 'agentMessage') {
   // Any other top-level item: the turn is busy, and a tool result after a steer means the agent's next step sees it.
   hidden += db.prepare('UPDATE turn_updates SET busy=1 WHERE thread_id=? AND turn_id=? AND busy=0').run(threadId,turn).changes;
   hidden += db.prepare('UPDATE turn_updates SET tail=0 WHERE thread_id=? AND turn_id=? AND tail=1').run(threadId,turn).changes;
   // Explicit channels suppress the chat-question fallback.
   if (['agent_hub_ask','answers_ask',...channelCommands].some(fragment => (`${d.item.tool ?? ''} ${d.item.name ?? ''} ${d.item.command ?? ''}`).includes(fragment))) hidden += db.prepare('UPDATE turn_updates SET asked=1 WHERE thread_id=? AND turn_id=? AND asked=0').run(threadId,turn).changes;
   if (d.item.type !== 'reasoning') {
    // A steer from another thread or a plugin, seen now: remember what the agent had written for the owner, and count the work after it.
    const mine = `SELECT candidate FROM items m WHERE m.thread_id=items.thread_id AND m.turn_id=items.turn_id AND m.kind='mine' AND m.status IN ('waiting','deferred') AND length(trim(coalesce(m.candidate,'')))>0 ORDER BY m.candidate_seq DESC LIMIT 1`;
    db.prepare(`UPDATE items SET steer_tools=steer_tools+1 WHERE thread_id=? AND turn_id=? AND kind='update' AND request_id IS NOT NULL AND steer_seq IS NULL`).run(threadId,turn);
    db.prepare(`UPDATE items SET candidate=(${mine}),candidate_seq=(${mine.replace('SELECT candidate','SELECT candidate_seq')}),steer_tools=1 WHERE thread_id=? AND turn_id=? AND kind='update' AND request_id IS NOT NULL AND steer_seq IS NOT NULL AND steer_seq<?`).run(threadId,turn,e.seq);
    hidden += db.prepare('UPDATE items SET steer_seq=NULL WHERE thread_id=? AND turn_id=? AND steer_seq IS NOT NULL AND steer_seq<?').run(threadId,turn,e.seq).changes;
   }
  } else if (e.type === 'item/completed' && turn && d.item?.type === 'agentMessage' && !d.item.parentToolCallId && typeof d.item.text === 'string') {
   // Like bb's chat: messages written in a row, with no other item between, are one reply and all show below the work log.
   const text = cap(d.item.text,20000);
   hidden += db.prepare(`UPDATE items SET candidate=CASE WHEN candidate_seq IS NOT NULL AND candidate_seq=(SELECT answer_seq FROM turn_updates u WHERE u.thread_id=items.thread_id AND u.turn_id=? AND u.tail=1) THEN substr(candidate||char(10)||char(10)||?,1,20000) ELSE ? END,candidate_seq=?,updated_at=? WHERE thread_id=? AND ((turn_id=? AND status IN ('waiting','deferred') AND question_seq<? AND steer_seq IS NULL) OR resolve_turn_id=?)`).run(turn,text,text,e.seq,now,threadId,turn,e.seq,turn).changes;
   hidden += db.prepare('UPDATE turn_updates SET answer=CASE WHEN tail=1 AND answer IS NOT NULL THEN substr(answer||char(10)||char(10)||?,1,20000) ELSE ? END,answer_seq=?,busy=1,tail=1 WHERE thread_id=? AND turn_id=?').run(text,text,e.seq,threadId,turn).changes;
  } else if (e.type === 'turn/completed' && turn) {
   if (d.status === 'completed') {
    // A turn that answered nothing of the owner's (a child finished, another thread or plugin wrote) still reports to them.
    const update = db.prepare('SELECT * FROM turn_updates WHERE thread_id=? AND turn_id=?').get(threadId,turn) as {kind:string|null;source_id:string|null;question:string;answer:string|null;answer_seq:number|null;started_at:number|null;report:number;asked:number}|undefined;
    // A question put to the owner only as text in the reply (no agent_hub_ask, no card question this turn) is filed in Questions
    // as asked in chat, so it is counted and pushed like any other; replying quotes it back into the thread.
    const warningTriggered = ['agent-hub','answers'].includes(update?.source_id ?? '') && /^\[(?:agent-hub|answers)\]/.test(update?.question ?? ''); // [answers] is the tag before the rename
    const asked = trackQuestions && update?.answer && !update.asked && (!warningTriggered || update.report) ? chatQuestion(update.answer) : null;
    if (trackQuestions && !warningTriggered && update?.answer && !update.asked && !db.prepare('SELECT 1 FROM archived_threads WHERE thread_id=?').get(threadId)) {
     if (asked) onWarning?.(CHAT_QUESTION_WARNING, e.createdAt ?? 0, turn, e.seq);
     else if (!update.report && ['agent','plugin','other','script'].includes(update.kind ?? '') && (update.kind !== 'other' || !!update.question) && asksOwner(update.answer) && !restatesOnly(update.answer,(db.prepare(`SELECT group_concat(CASE kind WHEN 'update' THEN answer ELSE question END,char(10)) AS t FROM items WHERE thread_id=? AND ((kind='update' AND asks=1) OR kind='for_me') AND coalesce(answered_at,created_at)>=?`).get(threadId,(e.createdAt ?? now)-RESTATE_WINDOW) as {t:string|null}).t ?? '')) onWarning?.('[agent-hub] Your last reply hands work to the owner but did not call `agent_hub_report`. Call `agent_hub_report` now and restate the handoff in this turn’s final message: that message becomes the report the owner sees as needing them.', e.createdAt ?? 0, turn, e.seq);
    }
    if (asked) db.prepare(`INSERT OR IGNORE INTO items(id,kind,thread_id,project_id,status,question,question_seq,chat_asked,notify_state,created_at,updated_at) VALUES (?,'for_me',?,?,'open',?,?,1,?,?,?)`).run('ans_'+createHash('sha256').update(threadId+'|chat-question|'+update!.answer_seq).digest('hex'),threadId,projectId,asked,update!.answer_seq,Number(live),e.createdAt ?? now,now);
    // Only an update that asks the owner something, or one the agent marked a report, is pushed; the rest collapse into a quiet group.
    const asks = trackQuestions && !!update?.answer && (!!update.report || (!warningTriggered && asksOwner(update.answer)));
    const early = turnUpdateId(threadId,turn), shown = !!db.prepare('SELECT 1 FROM items WHERE id=?').get(early), reply = update?.answer?.trim() && !db.prepare("SELECT 1 FROM items WHERE thread_id=? AND kind='mine' AND (turn_id=? OR resolve_turn_id=?) AND steer_seq IS NULL").get(threadId,turn,turn);
    // The message shown at acceptance takes the turn's reply; with nothing to report it stays a read caption.
    if (reply && shown) db.prepare(`UPDATE items SET status='answered',answer=?,answer_seq=?,answer_source='turn',answered_at=?,read_at=?,asks=?,notify_state=?,updated_at=? WHERE id=? AND status='waiting'`).run(update!.answer,update!.answer_seq,e.createdAt ?? now,asks ? null : e.createdAt ?? now,Number(asks),Number(live && asks),now,early);
    else if (reply)
     db.prepare(`INSERT OR IGNORE INTO items(id,kind,thread_id,project_id,status,question,answer,answer_seq,answer_source,answered_at,read_at,asks,notify_state,trigger_kind,trigger_source,created_at,updated_at) VALUES (?,'update',?,?,'answered',?,?,?,'turn',?,?,?,?,?,?,?,?)`).run('ans_'+createHash('sha256').update(threadId+'|update|'+update!.answer_seq).digest('hex'),threadId,projectId,update!.question,update!.answer,update!.answer_seq,e.createdAt ?? now,asks ? null : e.createdAt ?? now,Number(asks),Number(live && asks),update!.kind ?? 'other',update!.source_id,e.createdAt ?? now,now);
    // The owner's answer was written in full before a steer was seen, and only a little work followed: the turn's last message
    // replies to the steer, so the owner keeps the earlier one and the steer gets the last one.
    const steer = db.prepare(`SELECT id,candidate,candidate_seq,steer_tools FROM items WHERE thread_id=? AND turn_id=? AND kind='update' AND request_id IS NOT NULL AND steer_seq IS NULL AND length(trim(coalesce(candidate,'')))>=${STEER_ANSWER_MIN} AND steer_tools<=${STEER_TOOLS_MAX} ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(threadId,turn) as {id:string;candidate:string;candidate_seq:number}|undefined;
    const last = steer && db.prepare(`SELECT id,candidate,candidate_seq FROM items WHERE thread_id=? AND turn_id=? AND kind='mine' AND status IN ('waiting','deferred') AND resolve_turn_id IS NULL AND candidate_seq>? ORDER BY candidate_seq DESC LIMIT 1`).get(threadId,turn,steer.candidate_seq) as {candidate:string;candidate_seq:number}|undefined;
    if (steer && last) {
     db.prepare(`UPDATE items SET answer=?,answer_seq=?,answer_source='turn',answered_at=?,updated_at=? WHERE id=?`).run(last.candidate,last.candidate_seq,e.createdAt ?? now,now,steer.id);
     db.prepare(`UPDATE items SET candidate=?,candidate_seq=? WHERE thread_id=? AND turn_id=? AND kind='mine' AND status IN ('waiting','deferred') AND resolve_turn_id IS NULL AND candidate_seq>?`).run(steer.candidate,steer.candidate_seq,threadId,turn,steer.candidate_seq);
    }
    db.prepare(`UPDATE items SET status='answered',answer=candidate,answer_seq=candidate_seq,answer_source='agent',failed_at=NULL,wait_children=NULL,answered_at=?,notify_state=?,read_at=NULL,updated_at=? WHERE thread_id=? AND resolve_turn_id=? AND length(trim(candidate))>0`).run(e.createdAt ?? now,Number(live),now,threadId,turn);
    db.prepare(`UPDATE items SET status='answered',answer=candidate,answer_seq=candidate_seq,answer_source='turn',failed_at=NULL,answered_at=?,notify_state=?,read_at=NULL,updated_at=? WHERE thread_id=? AND turn_id=? AND status='waiting' AND resolve_turn_id IS NULL AND length(trim(candidate))>0`).run(e.createdAt ?? now,Number(live),now,threadId,turn);
    for (const item of db.prepare("SELECT id,answer FROM items WHERE thread_id=? AND turn_id=? AND status='answered' AND answer_source='turn' AND answer_seq=candidate_seq").all(threadId,turn) as {id:string;answer:string}[]) db.prepare('UPDATE items SET likely_interim=? WHERE id=?').run(Number(INTERIM_RE.test(item.answer.slice(-600))),item.id);
    db.prepare(`UPDATE items SET interim=candidate,interim_seq=candidate_seq,updated_at=? WHERE thread_id=? AND turn_id=? AND status='deferred' AND resolve_turn_id IS NULL AND length(trim(candidate))>0`).run(now,threadId,turn);

    db.prepare(`UPDATE items SET read_at=? WHERE thread_id=? AND (turn_id=? OR resolve_turn_id=?) AND kind='mine' AND status='answered' AND read_at IS NULL AND ${QUIET_SQL}`).run(now,threadId,turn,turn);
   } else if (d.status === 'failed' || d.status === 'interrupted') {
    db.prepare(`UPDATE items SET interim=candidate,interim_seq=candidate_seq,updated_at=? WHERE thread_id=? AND (turn_id=? OR resolve_turn_id=?) AND kind!='update' AND length(trim(candidate))>0`).run(now,threadId,turn,turn);
    if (d.status==='failed') db.prepare("UPDATE items SET failure_reason=?,interrupted_at=NULL,failed_at=?,read_at=NULL,notify_state=?,updated_at=? WHERE thread_id=? AND turn_id=? AND status IN ('waiting','deferred') AND resolve_turn_id IS NULL").run(typeof d.error?.message === 'string' ? cap(d.error.message,4000) : null,e.createdAt ?? now,Number(live),now,threadId,turn);
    // The user pressed Stop: like bb, the chat keeps the message with no reply, but it leaves the inbox and its waiting.
    if (d.status === 'interrupted') {
     const cancelled = `thread_id=? AND (turn_id=? OR resolve_turn_id=?) AND kind='mine' AND status IN ('waiting','deferred')`;
     db.prepare(`UPDATE items SET dismissed_at=COALESCE(dismissed_at,?),interrupted_at=?,failed_at=NULL,failure_reason=NULL,updated_at=? WHERE ${cancelled}`).run(now,e.createdAt ?? now,now,threadId,turn,turn);
    }
   }
   hidden += db.prepare("UPDATE items SET status='answered',answered_at=?,updated_at=? WHERE id=? AND status='waiting'").run(e.createdAt ?? now,now,turnUpdateId(threadId,turn)).changes;
   hidden += db.prepare('DELETE FROM turn_updates WHERE thread_id=? AND turn_id=?').run(threadId,turn).changes;
   hidden += db.prepare('UPDATE items SET candidate=NULL,candidate_seq=NULL,resolve_turn_id=CASE WHEN resolve_turn_id=? THEN NULL ELSE resolve_turn_id END WHERE thread_id=? AND (turn_id=? OR resolve_turn_id=?)').run(turn,threadId,turn,turn).changes;
   if (active === turn) active=null;
  }
  cursor=e.seq;
 }
 hidden += db.prepare('UPDATE threads_state SET last_seq=?,active_turn_id=?,last_error=NULL,updated_at=? WHERE thread_id=?').run(cursor,active,now,threadId).changes;
 return total() - start > hidden;
}
