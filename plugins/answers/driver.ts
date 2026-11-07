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
type State = { last_seq: number };
export function createDriver(bb: BbPluginApi, db: Database.Database, invalidate: () => void) {
  const locks = new Map<string, Promise<unknown>>();
  const scheduled = new Map<string, { dirty: boolean; promise: Promise<void> }>();
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
    db.transaction(() => {
      db.prepare("DELETE FROM items WHERE thread_id=? AND kind!='saved'").run(id);
      db.prepare('DELETE FROM request_aliases WHERE thread_id=?').run(id);
      db.prepare('DELETE FROM threads_state WHERE thread_id=?').run(id);
      db.prepare('UPDATE items SET thread_deleted=1,updated_at=? WHERE thread_id=?').run(Date.now(),id);
    })();
    const retry = retries.get(id); if (retry?.timer) clearTimeout(retry.timer); retries.delete(id);
    invalidate();
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
  async function drain(id: string) {
    if (signal.aborted) return;
    const state = db.prepare('SELECT last_seq FROM threads_state WHERE thread_id=?').get(id) as State | undefined;
    let projectId: string | null = null;
    if (!state || state.last_seq === 0) {
      try { projectId = (await bb.sdk.threads.get({threadId:id,signal})).projectId; }
      catch (e) { if (notFound(e)) {remove(id); return;} throw e; }
      const events: Event[] = [];
      let before: number | undefined;
      // shortcut: first sight covers at most 1,500 events; expand if older history becomes a requirement.
      for (let n=0;n<3;n++) {
        const result = await page(id,before,'desc',500);
        events.push(...result.events);
        if (result.events.length < result.size) break;
        before = Math.min(...result.events.map(e=>e.seq));
      }
      db.transaction(() => applyEvents(db,id,events.sort((a,b)=>a.seq-b.seq),projectId,Date.now()))();
      invalidate();
    }
    let cursor = (db.prepare('SELECT last_seq FROM threads_state WHERE thread_id=?').get(id) as State).last_seq;
    for (;;) {
      const result = await page(id,cursor,'asc',200);
      if (signal.aborted) return;
      if (result.events.length) {
        db.transaction(() => applyEvents(db,id,result.events,projectId,Date.now()))(); invalidate();
        cursor = Math.max(...result.events.map(e=>e.seq));
      }
      if (result.events.length < result.size) break;
    }
  }
  async function attempt(id: string) {
    try {
      await slot(() => drain(id));
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
  function schedule(id: string) {
    const existing = scheduled.get(id);
    if (existing) {existing.dirty=true; return existing.promise;}
    const entry = {dirty:false,promise:Promise.resolve()};
    entry.promise = locked(id,async () => {
      do {entry.dirty=false; await attempt(id);} while (entry.dirty && !signal.aborted);
    }).finally(() => scheduled.delete(id));
    scheduled.set(id,entry); return entry.promise;
  }
  async function reconcile() {
    const tracked = db.prepare('SELECT thread_id FROM threads_state').all() as {thread_id:string}[];
    for (let i=0;i<tracked.length && !signal.aborted;i+=200) {
      const ids = tracked.slice(i,i+200).map(r=>r.thread_id);
      try {
        const found = await bb.sdk.threads.list({threadIds:ids,includeHidden:true,limit:200,signal});
        const known = new Set(found.map(t=>t.id));
        await Promise.all(ids.map(async id => {
          if (!known.has(id)) {
            try {await bb.sdk.threads.get({threadId:id,signal});}
            catch (e) {if (notFound(e)) await locked(id,async()=>remove(id)); return;}
          }
          await schedule(id).catch(()=>{});
        }));
      } catch (e) {bb.log.warn(`Answers reconcile: ${String(e)}`);}
    }
    // shortcut: discovery covers 1,000 visible recent threads; other threads enter on their next event.
    for (let offset=0;offset<1000 && !signal.aborted;offset+=200) {
      const threads = await bb.sdk.threads.list({limit:200,offset,signal});
      await Promise.all(threads.filter(t=>t.updatedAt>=Date.now()-48*3600000 && !db.prepare('SELECT 1 FROM threads_state WHERE thread_id=?').get(t.id)).map(t=>schedule(t.id).catch(()=>{})));
      if (threads.length<200) break;
    }
  }
  return {
    schedule, reconcile,
    withThread: <T>(id: string, mutate: () => T | Promise<T>) => locked(id,async () => {await attempt(id); return mutate();}),
    deleteThread: (id: string) => locked(id,async () => remove(id)),
    async dispose() {controller.abort(); for (const r of retries.values()) if (r.timer) clearTimeout(r.timer); await Promise.allSettled([...locks.values()]);},
  };
}
