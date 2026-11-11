import type { BbPluginApi } from '@get-bb/plugin-sdk';
import type Database from 'better-sqlite3';
import { applyEvents, RELEVANT, type Event } from './ingest';

const notFound = (e: unknown) => {
  const error = e as { status?: number; statusCode?: number; code?: string };
  return error?.status === 404 || error?.statusCode === 404 || error?.code === 'not_found';
};
const oversized = (e: unknown) => {
  const error = e as { status?: number; statusCode?: number; code?: string };
  return error?.status === 413 || error?.statusCode === 413 || error?.code === 'event_data_too_large';
};
type State = { last_seq: number; last_error: string | null; ingested_thread_updated_at: number | null };
type Thread = Pick<Awaited<ReturnType<BbPluginApi['sdk']['threads']['get']>>, 'projectId' | 'parentThreadId' | 'updatedAt'>;
export function createDriver(bb: BbPluginApi, db: Database.Database, invalidate: () => void) {
  const live = new Set<string>();
  const locks = new Map<string, Promise<unknown>>();
  const scheduled = new Map<string, { dirty: boolean; listed?: Thread; promise: Promise<void> }>();
  const retries = new Map<string, { delay: number; timer?: ReturnType<typeof setTimeout> }>();
  const controller = new AbortController();
  const signal = controller.signal;
  let running = 0;
  const queue: (() => void)[] = [];
  async function slot<T>(fn: () => Promise<T>): Promise<T> {
    if (running >= 2) await new Promise<void>(resolve => queue.push(resolve));
    else running++;
    try { return await fn(); } finally { const next = queue.shift(); if (next) next(); else running--; }
  }
  function locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prior = locks.get(id) ?? Promise.resolve();
    const result = prior.catch(() => {}).then(fn);
    locks.set(id, result);
    void result.finally(() => { if (locks.get(id) === result) locks.delete(id); }).catch(() => {});
    return result;
  }
  function remove(id: string) {
    const hadItems = !!db.prepare('SELECT 1 FROM items WHERE thread_id=? LIMIT 1').get(id);
    db.transaction(() => {
      db.prepare("DELETE FROM items WHERE thread_id=? AND kind!='saved'").run(id);
      db.prepare('DELETE FROM pool_entries WHERE thread_id=?').run(id);
      db.prepare('DELETE FROM request_aliases WHERE thread_id=?').run(id);
      db.prepare('DELETE FROM request_triggers WHERE thread_id=?').run(id);
      db.prepare('DELETE FROM turn_updates WHERE thread_id=?').run(id);
      db.prepare('DELETE FROM threads_state WHERE thread_id=?').run(id);
      db.prepare('DELETE FROM archived_threads WHERE thread_id=?').run(id);
      db.prepare('UPDATE items SET thread_deleted=1,updated_at=? WHERE thread_id=?').run(Date.now(),id);
    })();
    live.delete(id);
    const retry = retries.get(id); if (retry?.timer) clearTimeout(retry.timer); retries.delete(id);
    if (hadItems) invalidate();
  }
  async function page(id: string, cursor: number | undefined, order: 'asc' | 'desc', initial: number) {
    let size = initial;
    for (;;) {
      try {
        const events = await bb.sdk.threads.events.list({threadId:id,types:RELEVANT,order,limit:String(size),signal,
          ...(cursor === undefined ? {} : order === 'asc' ? {afterSeq:String(cursor)} : {beforeSeq:String(cursor)})});
        return {events, size};
      } catch (e) {
        if (!oversized(e)) throw e;
        if (size === 1) throw new Error(`oversized event after seq ${cursor ?? 0}`);
        size = Math.max(1,Math.floor(size/2));
      }
    }
  }
  // shortcut: live events in the first successful drain do not push; revisit if discovery needs immediate notifications.
  async function drain(id: string, listed?: Thread) {
    if (signal.aborted) return;
    const state = db.prepare('SELECT last_seq,last_error FROM threads_state WHERE thread_id=?').get(id) as State | undefined;
    let projectId: string | null, questions: boolean;
    let thread: Thread;
    try { thread = listed ?? await bb.sdk.threads.get({threadId:id,signal}); projectId = thread.projectId; questions = !thread.parentThreadId; }
    catch (e) { if (notFound(e)) {remove(id); return;} throw e; }
    let changed = false;
    // Agent-spawned children store nothing: skip their events, keep only the row withThread needs.
    if (!questions) { db.prepare('INSERT OR IGNORE INTO threads_state(thread_id,last_seq,updated_at) VALUES (?,0,?)').run(id,Date.now()); return; }
    try {
    if (!state || (state.last_seq === 0 && state.last_error)) {
      const events: Event[] = [];
      let before: number | undefined;
      // shortcut: first sight covers at most 1,500 events; expand if older history becomes a requirement.
      // bb caps thread event pages at 100.
      for (let n=0;n<15;n++) {
        const result = await page(id,before,'desc',100);
        events.push(...result.events);
        if (result.events.length < result.size) break;
        before = Math.min(...result.events.map(e=>e.seq));
      }
      changed = db.transaction(() => applyEvents(db,id,events.sort((a,b)=>a.seq-b.seq),projectId,Date.now(),questions,live.has(id)))() || changed;
    }
    // Turn answers already on record before this drain; only those it adds can be auto-deferred, and only when live (not a backfill).
    const answeredTurns = () => new Set((db.prepare("SELECT id FROM items WHERE thread_id=? AND kind='mine' AND status='answered' AND answer_source='turn'").all(id) as {id:string}[]).map(r=>r.id));
    const before = live.has(id) ? answeredTurns() : null;
    let cursor = (db.prepare('SELECT last_seq FROM threads_state WHERE thread_id=?').get(id) as State).last_seq;
    for (;;) {
      const result = await page(id,cursor,'asc',100);
      if (signal.aborted) return;
      if (result.events.length) {
        changed = db.transaction(() => applyEvents(db,id,result.events,projectId,Date.now(),questions,live.has(id)))() || changed;
        cursor = Math.max(...result.events.map(e=>e.seq));
      }
      if (result.events.length < result.size) break;
    }
    if (before && !signal.aborted) await autoDefer(id,[...answeredTurns()].filter(x=>!before.has(x)));
    if (!signal.aborted) db.prepare('UPDATE threads_state SET ingested_thread_updated_at=? WHERE thread_id=? AND coalesce(ingested_thread_updated_at,0)<?').run(thread.updatedAt,id,thread.updatedAt);
    } finally { if (changed) invalidate(); }
  }
  // Safety net: a turn that answered with sub-sessions still running is an interim reply; defer the question until they report back.
  async function autoDefer(id: string, items: string[]) {
    if (!items.length) return;
    try {
      const kids = await bb.sdk.threads.list({parentThreadId:id,includeHidden:true,limit:200,signal});
      const running = kids.filter(t=>!t.archivedAt && !t.deletedAt && ['active','pending','starting','stopping'].includes(t.status));
      for (const item of items) {
        const since = (db.prepare('SELECT created_at FROM items WHERE id=?').get(item) as {created_at:number}).created_at;
        const waits = running.filter(t=>t.createdAt>=since).map(t=>t.id);
        if (waits.length) db.prepare("UPDATE items SET status='deferred',interim=answer,interim_seq=answer_seq,answer=NULL,answer_seq=NULL,answer_source=NULL,answered_at=NULL,read_at=NULL,likely_interim=0,notify_state=0,wait_children=?,updated_at=? WHERE id=? AND status='answered' AND answer_source='turn'").run(JSON.stringify(waits),Date.now(),item);
      }
    } catch (e) { if (signal.aborted) throw e; bb.log.warn(`Answers auto-defer: ${String(e)}`); }
  }
  async function attempt(id: string, listed?: Thread) {
    try {
      await slot(() => drain(id,listed));
      if (!signal.aborted) live.add(id);
      if (!signal.aborted && db.prepare('UPDATE threads_state SET last_error=NULL,updated_at=? WHERE thread_id=? AND last_error IS NOT NULL').run(Date.now(),id).changes) invalidate();
      const retry = retries.get(id); if (retry?.timer) clearTimeout(retry.timer); retries.delete(id);
    } catch (e) {
      if (signal.aborted) throw e;
      db.prepare(`INSERT INTO threads_state(thread_id,last_seq,last_error,updated_at) VALUES (?,0,?,?) ON CONFLICT(thread_id) DO UPDATE SET last_error=excluded.last_error,updated_at=excluded.updated_at`).run(id,String(e),Date.now());
      invalidate();
      const previous = retries.get(id); if (previous?.timer) clearTimeout(previous.timer);
      const delay = Math.min(previous ? previous.delay*2 : 30000,300000);
      const timer = setTimeout(() => { void schedule(id).catch(() => {}); },delay); timer.unref();
      retries.set(id,{delay,timer});
      throw e;
    }
  }
  function schedule(id: string, listed?: Thread) {
    const existing = scheduled.get(id);
    if (existing) {existing.dirty=true; if (listed) existing.listed=listed; return existing.promise;}
    const entry: { dirty: boolean; listed?: Thread; promise: Promise<void> } = {dirty:false,listed,promise:Promise.resolve()};
    entry.promise = locked(id,async () => {
      do {entry.dirty=false; const l=entry.listed; entry.listed=undefined; await attempt(id,l);} while (entry.dirty && !signal.aborted);
    }).finally(() => scheduled.delete(id));
    scheduled.set(id,entry); return entry.promise;
  }
  async function reconcile() {
    const tracked = db.prepare('SELECT ids.thread_id,s.last_seq,s.last_error,s.ingested_thread_updated_at FROM (SELECT thread_id FROM threads_state UNION SELECT thread_id FROM pool_entries) ids LEFT JOIN threads_state s USING(thread_id)').all() as (State & {thread_id:string})[];
    for (let i=0;i<tracked.length && !signal.aborted;i+=200) {
      const ids = tracked.slice(i,i+200).map(r=>r.thread_id);
      try {
        const found = await bb.sdk.threads.list({threadIds:ids,includeHidden:true,limit:200,signal});
        const known = new Map(found.map(t=>[t.id,t]));
        for (const t of found) db.prepare(t.archivedAt ? 'INSERT OR IGNORE INTO archived_threads VALUES (?)' : 'DELETE FROM archived_threads WHERE thread_id=?').run(t.id);
        await Promise.all(tracked.slice(i,i+200).map(async row => {
          const id=row.thread_id, thread=known.get(id);
          if (thread?.archivedAt || thread?.parentThreadId) return;
          if (thread && !row.last_error && row.ingested_thread_updated_at!==null && thread.updatedAt<=row.ingested_thread_updated_at) return;
          if (!thread) {
            try {await bb.sdk.threads.get({threadId:id,signal});}
            catch (e) {if (notFound(e)) await locked(id,async()=>remove(id)); return;}
          }
          await schedule(id,thread).catch(()=>{});
        }));
      } catch (e) {bb.log.warn(`Answers reconcile: ${String(e)}`);}
    }
    // shortcut: discovery covers 1,000 visible recent threads; other threads enter on their next event.
    for (let offset=0;offset<1000 && !signal.aborted;offset+=200) {
      const threads = await bb.sdk.threads.list({limit:200,offset,signal});
      await Promise.all(threads.filter(t=>!t.archivedAt && !t.parentThreadId && t.updatedAt>=Date.now()-48*3600000 && !db.prepare('SELECT 1 FROM threads_state WHERE thread_id=?').get(t.id)).map(t=>schedule(t.id,t).catch(()=>{})));
      if (threads.length<200) break;
    }
  }
  return {
    schedule, reconcile,
    withThread: <T>(id: string, mutate: () => T | Promise<T>) => locked(id,async () => {
      await attempt(id);
      if (!db.prepare('SELECT 1 FROM threads_state WHERE thread_id=?').get(id)) throw new Error('thread not found');
      return mutate();
    }),
    deleteThread: (id: string) => locked(id,async () => remove(id)),
    async dispose() {controller.abort(); for (const r of retries.values()) if (r.timer) clearTimeout(r.timer); await Promise.allSettled([...locks.values()]);},
  };
}
