import type { BbPluginApi, PluginBbSdk } from '@get-bb/plugin-sdk';
import type { Database } from 'better-sqlite3';
import { performance } from 'node:perf_hooks';
import { setImmediate } from 'node:timers/promises';
import { BACKFILLED, RECOVERED, type SourceId, type UsageRow, type ThreadDtoLike } from '../contract';
import type { Store } from '../store/write';
import type { Settings } from '../rpc';
import type { FileSource, ThreadInfo } from './files';
import type { createBbEvents } from './bb-events';

type ThreadResponse = ThreadDtoLike & { createdAt: number; environmentId?: string | null; providerThreadId?: string | null };
type BbEvents = Omit<Pick<ReturnType<typeof createBbEvents>, 'flushThread' | 'coverage'>, 'flushThread'> & { onRowsApplied(rows: UsageRow[]): void; flushThread(id: string, fallback: boolean): Promise<{ rows: UsageRow[]; candidates: UsageRow[]; touched: boolean; more?: boolean }> };
type Ext = {
  pollUsage(id: 'local-models' | 'antigravity'): Promise<{ rows: UsageRow[]; available: boolean; commit?(): void }>;
  pollCompactions(): Promise<{ matched: number; available: boolean; commit?(): void }>;
};
type Source = { source: SourceId; since_ts: number; state: string };
type Batch = { rows: UsageRow[]; commit?(): void };
type CancellableFileSource = {
  locate(t: ThreadInfo, signal?: AbortSignal): ReturnType<FileSource['locate']>;
  flushThread(t: ThreadInfo, signal?: AbortSignal): Promise<Awaited<ReturnType<FileSource['flushThread']>> & { more?: boolean }>;
  scanOutside(known: Set<string>, since: number, signal?: AbortSignal): ReturnType<FileSource['scanOutside']>;
};
const fileId = (provider: string) => provider === 'claude-code' ? 'claude-file' : provider === 'codex' ? 'codex-file' : null;

export function createScheduler(o: {
  bb: BbPluginApi; db: Database; store: Store;
  settings: { get(): Promise<Settings>; onChange(fn: (next: Settings, prev: Settings) => void): void };
  files: Record<'claude-file' | 'codex-file', CancellableFileSource>;
  // Construct these only in the service, after the SDK has been bound.
  sources(sdk: PluginBbSdk, signal: AbortSignal): { bbEvents: BbEvents; ext: Ext };
}) {
  const { bb, db, store } = o;
  const dirty = new Set<string>();
  const dtos = new Map<string, ThreadResponse>();
  const environments = new Map<string, string | null>();
  let stopped = false, lastInvalidation = -Infinity;
  let controller: AbortController | undefined;
  let sdk: PluginBbSdk;
  let trailing: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let sources: ReturnType<typeof o.sources> | undefined;
  let agyAvailable = false, lastExt = -Infinity, lastOutside = -Infinity;
  const status = (id: string, error: string | null = null, state = 'ok') => {
    db.prepare(`INSERT INTO source_status(source,last_ingest_at,rows,last_error,state) VALUES (?,?,0,?,?)
      ON CONFLICT(source) DO UPDATE SET last_ingest_at=CASE WHEN excluded.last_error IS NULL THEN excluded.last_ingest_at ELSE last_ingest_at END,
      last_error=excluded.last_error,state=excluded.state`).run(id, Date.now(), error, state);
  };
  const fail = (id: string, error: unknown) => {
    if (stopped) return;
    const message = error instanceof Error ? error.message : String(error);
    if (!stopped) status(id, message, 'error');
    bb.log.warn(`Tokenomos ${id}: ${message}`);
  };
  function invalidate() {
    if (stopped) return;
    const wait = 5000 - (Date.now() - lastInvalidation);
    if (wait <= 0) {
      if (trailing) clearTimeout(trailing);
      trailing = undefined; lastInvalidation = Date.now(); bb.rpc.experimental_invalidate(['usage']);
    } else trailing ??= setTimeout(() => { trailing = undefined; invalidate(); }, wait);
  }
  const note = (thread: ThreadResponse, ingest: boolean) => {
    store.noteThread(thread); dtos.set(thread.id, thread);
    if (ingest) dirty.add(thread.id);
    invalidate();
  };
  for (const event of ['experimental_thread.events', 'thread.idle', 'thread.created'] as const) bb.events.on(event, ({ thread }) => note(thread, true));
  for (const event of ['experimental_thread.parentChanged', 'thread.archived', 'thread.unarchived', 'thread.deleted'] as const) bb.events.on(event, ({ thread }) => note(thread, false));
  o.settings.onChange((next, prev) => {
    if (next.priceOverrides !== prev.priceOverrides || next.referenceModel !== prev.referenceModel || next.includeOutsideBb !== prev.includeOutsideBb) invalidate();
  });
  const current = (id: string) => db.prepare('SELECT * FROM thread_source WHERE thread_id=?').get(id) as Source | undefined;
  const owns = (row: UsageRow) => {
    if (!row.threadId) return true;
    // Local tool/CLI requests are extra calls, separate from the thread provider's transcript.
    if (row.source === 'local-log' && row.provider === 'local-models') return true;
    const interval = db.prepare('SELECT source FROM source_interval WHERE thread_id=? AND from_ts<=? ORDER BY from_ts DESC LIMIT 1').get(row.threadId, row.ts) as { source: SourceId } | undefined;
    return (interval?.source ?? current(row.threadId)?.source) === row.source;
  };
  async function apply(batches: Batch[], signal: AbortSignal, before?: () => void) {
    let sliceStart = performance.now();
    for (const batch of batches) {
      let offset = 0;
      do {
        signal.throwIfAborted();
        db.transaction(() => {
          before?.(); before = undefined;
          const end = Math.min(offset + 1000, batch.rows.length);
          // Check the time budget every 100 rows, with no more than 1000 in a transaction.
          do {
            const rows = batch.rows.slice(offset, Math.min(offset + 100, end)).filter(owns);
            const result = store.applyRows(rows);
            for (const id of new Set(rows.filter(r => r.source === 'bb-events' && (r.flags & (BACKFILLED|RECOVERED))).map(r => r.threadId))) {
              db.prepare("INSERT INTO thread_cov(thread_id,partial) VALUES (?,1) ON CONFLICT(thread_id) DO UPDATE SET partial=1").run(id);
            }
            sources!.bbEvents.onRowsApplied(rows);
            if (result.inserted || result.updated) invalidate();
            offset = Math.min(offset + 100, end);
          } while (offset < end && performance.now() - sliceStart < 8);
          if (offset === batch.rows.length) batch.commit?.();
        })();
        if (offset < batch.rows.length || performance.now() - sliceStart >= 8) {
          await setImmediate(undefined, { signal }); sliceStart = performance.now();
        }
      } while (offset < batch.rows.length);
    }
  }
  const retained = (id: string) => {
    const total = db.prepare('SELECT COALESCE(SUM(calls),0) n FROM thread_tokens WHERE thread_id=?').get(id) as { n: number };
    const raw = db.prepare('SELECT COUNT(*) n FROM usage_raw WHERE thread_id=?').get(id) as { n: number };
    return total.n === raw.n;
  };
  const setSource = (id: string, source: SourceId, state = 'ok') => {
    if (!current(id)) store.setCursor(`initial-source:${id}`, source);
    db.prepare(`INSERT INTO thread_source(thread_id,source,since_ts,state) VALUES (?,?,?,?)
    ON CONFLICT(thread_id) DO UPDATE SET source=excluded.source,since_ts=excluded.since_ts,state=excluded.state`).run(id, source, Date.now(), state);
  };
  const candidates = (id: string, after = ''): UsageRow[] => (db.prepare('SELECT b.* FROM bb_candidate b WHERE thread_id=? AND key>? AND NOT EXISTS (SELECT 1 FROM usage_raw r WHERE r.key=b.key) ORDER BY key LIMIT 1000').all(id, after) as Array<Record<string, any>>).map(r => ({
    key:r.key,ts:r.ts,threadId:r.thread_id,projectId:r.project_id,provider:r.provider,model:r.model,tier:r.tier,tierRaw:r.tier_raw,promptTokens:r.prompt_tokens,band:r.band,conv:r.conv,
    freshIn:r.fresh_in,cacheRead:r.cache_read,cacheWriteShort:r.cache_write_short,cacheWriteLong:r.cache_write_long,output:r.output,reasoning:r.reasoning,turnId:r.turn_id||null,source:'bb-events',flags:r.flags,
  }));
  async function applyCandidates(id: string, signal: AbortSignal, recovered = false) {
    const initialOwned = current(id)?.source === 'bb-events' && !store.getCursor<boolean>(`file-found:${id}`)
      && !db.prepare('SELECT 1 FROM source_interval WHERE thread_id=? LIMIT 1').get(id);
    if (initialOwned) {
      // The initial total replaces its last-call candidate, rather than adding to it.
      db.prepare("DELETE FROM bb_candidate WHERE thread_id=? AND key IN (SELECT 'bb:' || substr(key,5) FROM bb_candidate WHERE thread_id=? AND key GLOB 'bbi:*')").run(id,id);
    }
    let after = '';
    for (;;) {
      signal.throwIfAborted();
      const rows = candidates(id, after);
      if (!rows.length) return;
      after = rows.at(-1)!.key;
      const owned = rows.filter(r => initialOwned || !r.key.startsWith('bbi:'));
      await apply([{ rows: recovered ? owned.map(r => ({ ...r, flags:r.flags | RECOVERED })) : owned }], signal);
      await setImmediate(undefined, { signal });
    }
  }
  async function flushThread(id: string, signal: AbortSignal): Promise<boolean> {
    let sourceId: SourceId = current(id)?.source ?? 'bb-events';
    try {
      signal.throwIfAborted();
      const dto = dtos.get(id) ?? await sdk.threads.get({ threadId: id });
      if (stopped) return false;
      store.noteThread(dto);
      const desiredFile = fileId(dto.providerId ?? '');
      // Always keep event metadata/candidates, even while waiting for a local file.
      if (!current(id) && !desiredFile) setSource(id, dto.providerId === 'local-models' ? 'local-log' : dto.providerId === 'antigravity' && agyAvailable ? 'agy-log' : 'bb-events');
      const fallbackOwned = current(id)?.source === 'bb-events'
        && (store.getCursor<string>(`initial-source:${id}`) ?? 'bb-events') === 'bb-events'
        && !store.getCursor<boolean>(`file-found:${id}`)
        && !db.prepare('SELECT 1 FROM source_interval WHERE thread_id=? LIMIT 1').get(id);
      const eventBatch = await sources!.bbEvents.flushThread(id, fallbackOwned);
      if (stopped) return false;
      if (eventBatch.more) {
        dirty.add(id);
        if (eventBatch.touched) invalidate();
        return true; // Drain compaction metadata before consuming calls at later timestamps.
      }
      const session = db.prepare('SELECT provider_thread_id FROM provider_session WHERE thread_id=? ORDER BY rowid DESC LIMIT 1').get(id) as { provider_thread_id: string } | undefined;
      let cwd: string | null = null;
      if (dto.environmentId) {
        if (!environments.has(dto.environmentId)) environments.set(dto.environmentId, (await sdk.environments.get({ environmentId: dto.environmentId })).path);
        cwd = environments.get(dto.environmentId) ?? null;
      }
      const info: ThreadInfo = { threadId:id, providerThreadId:session?.provider_thread_id ?? ('providerThreadId' in dto ? dto.providerThreadId as string | null : null),
        provider:dto.providerId ?? '',projectId:dto.projectId ?? '',createdAt:dto.createdAt,isFork:!!dto.sourceThreadId,cwd };
      const found = desiredFile ? await o.files[desiredFile].locate(info, signal) : false;
      if (stopped) return false;
      const pending = [...eventBatch.rows, ...eventBatch.candidates];
      const firstKey = `first-usage:${id}`;
      let first = store.getCursor<number>(firstKey);
      if (first === null) first = (db.prepare('SELECT MIN(ts) first FROM bb_candidate WHERE thread_id=?').get(id) as { first: number | null }).first;
      if (pending.length) { first = Math.min(first ?? Infinity, ...pending.map(r => r.ts)); store.setCursor(firstKey, first); }
      if (found) store.setCursor(`file-found:${id}`, true);
      const old = current(id);
      let switchDeferred = false;
      const selected: SourceId = desiredFile ? (found || store.getCursor<boolean>(`file-found:${id}`) || first === null || Date.now() - first < 600_000 ? desiredFile : 'bb-events')
        : dto.providerId === 'local-models' ? 'local-log' : dto.providerId === 'antigravity' && (agyAvailable || old?.source === 'agy-log') ? 'agy-log' : 'bb-events';
      switchDeferred = !!old && old.source !== selected && !retained(id);
      sourceId = switchDeferred ? old!.source : selected;
      // Persist candidates before any file read can fail.
      const insert = db.prepare(`INSERT OR REPLACE INTO bb_candidate (key,ts,thread_id,project_id,provider,model,tier,tier_raw,prompt_tokens,band,conv,fresh_in,cache_read,cache_write_short,cache_write_long,output,reasoning,turn_id,source,flags)
        VALUES (@key,@ts,@threadId,@projectId,@provider,@model,@tier,@tierRaw,@promptTokens,@band,@conv,@freshIn,@cacheRead,@cacheWriteShort,@cacheWriteLong,@output,@reasoning,@turnId,@source,@flags)`);
      db.transaction(() => { for (const r of pending) insert.run({ ...r, turnId:r.turnId ?? '' }); })();
      const fileBatch = desiredFile && found && sourceId === desiredFile ? await o.files[desiredFile].flushThread(info, signal) : null;
      if (stopped) return false;
      // Observe arriving main rows before filtering: rows in a fallback interval cannot be applied again.
      const state = old ?? { source:sourceId, since_ts:Date.now(), state:'ok' };
      const coverage = desiredFile && sourceId === desiredFile ? await sources!.bbEvents.coverage(id) : null;
      const covered = state.state === 'degraded' && fileBatch?.rows.some(r => !r.conv && r.ts >= state.since_ts && !!db.prepare('SELECT 1 FROM turns WHERE thread_id=? AND reported_usage=1 AND started_at<=? AND completed_at+120000>=? AND completed_at>0').get(id,r.ts,r.ts));
      await apply([fileBatch ?? { rows:[] }], signal, () => {
        if (found) db.prepare("DELETE FROM bb_candidate WHERE thread_id=? AND key GLOB 'bbi:*'").run(id);
        if (!old) setSource(id, sourceId);
        else if (old.source !== sourceId) {
          store.deleteContribution(id, old.source);
          db.prepare('DELETE FROM source_interval WHERE thread_id=?').run(id);
          setSource(id, sourceId); invalidate();
        }
        if (covered) {
          db.prepare('INSERT OR REPLACE INTO source_interval VALUES (?,?,?)').run(id, Date.now(), sourceId);
          setSource(id, sourceId); invalidate();
        }
      });
      await applyCandidates(id, signal);
      // Recompute after applying file rows, so this batch can prevent a false degradation.
      const after = coverage && await sources!.bbEvents.coverage(id);
      // Judge coverage only once the file is fully read: a large transcript still being caught up looks "uncovered".
      if (after && fileBatch && !fileBatch.more && current(id)!.state !== 'degraded' && !covered && after.uncoveredStreak >= 3 && after.firstUncoveredStart !== null) {
        const from = retained(id) ? after.firstUncoveredStart : Date.now();
        db.transaction(() => {
          db.prepare('INSERT OR IGNORE INTO source_interval VALUES (?,?,?)').run(id,0,sourceId);
          db.prepare('INSERT OR REPLACE INTO source_interval VALUES (?,?,?)').run(id,from,'bb-events');
          store.deleteContribution(id,sourceId,from);
          setSource(id,sourceId,'degraded');
          invalidate();
        })();
        await applyCandidates(id, signal, true);
      }
      const warning = switchDeferred ? 'Source switch deferred: raw rows have expired'
        : fileBatch?.parseErrors ? `Skipped ${fileBatch.parseErrors} invalid transcript lines` : null;
      if (warning) bb.log.warn(`Tokenomos ${sourceId}: ${warning}`);
      status(sourceId, warning, sourceId === 'agy-log' && !agyAvailable ? 'unavailable' : warning ? 'partial' : current(id)!.state);
      if (fileBatch?.more || eventBatch.more || (desiredFile && (!found || sourceId === 'bb-events'))) dirty.add(id);
      if (eventBatch.touched) invalidate();
      return true;
    } catch (e) { if (!signal.aborted) { fail(sourceId,e); dirty.add(id); } return false; }
  }
  async function external(signal: AbortSignal) {
    for (const id of ['local-models','antigravity'] as const) {
      const source = id === 'local-models' ? 'local-log' : 'agy-log';
      try {
        const result = await sources!.ext.pollUsage(id);
        if (stopped) return;
        if (id === 'antigravity') {
          if (agyAvailable !== result.available) for (const r of db.prepare("SELECT id FROM threads WHERE provider_id='antigravity'").all() as {id:string}[]) dirty.add(r.id);
          agyAvailable = result.available;
        }
        await apply([result], signal, () => {
          const seen = new Set<string>();
          for (const row of result.rows) {
            if (seen.has(row.threadId)) continue;
            seen.add(row.threadId);
            if (!row.threadId || row.source === 'local-log') continue;
            const old = current(row.threadId);
            if (!old) setSource(row.threadId,source);
            else if (old.source === 'bb-events' && retained(row.threadId)) {
              store.deleteContribution(row.threadId,old.source);
              setSource(row.threadId,source); invalidate();
            }
          }
        });
        status(source,null,result.available ? 'ok' : 'unavailable');
      } catch (e) { fail(source,e); }
    }
    try {
      const result = await sources!.ext.pollCompactions();
      await apply([{ rows:[], commit:result.commit }], signal);
      if (!stopped && result.matched) invalidate();
    } catch (e) { fail('compactions',e); }
  }
  async function* backfill(signal: AbortSignal) {
    type Cursor = { done: boolean; after?: { createdAt: number; id: string } };
    const cursor = store.getCursor<Cursor>('backfill') ?? {done:false};
    if (cursor.done) return;
    const threads = new Map<string, ThreadResponse>();
    for (const archived of [false,true]) for (let offset=0;;offset+=100) {
      const page = await sdk.threads.list({archived,includeHidden:true,limit:100,offset,signal});
      signal.throwIfAborted();
      let sliceStart = performance.now();
      for (const dto of page) {
        threads.set(dto.id,dto);
        if (performance.now()-sliceStart>=8) { await setImmediate(undefined,{signal}); sliceStart=performance.now(); }
      }
      yield; // Live work gets a turn while historical pages are collected.
      if (page.length<100) break;
    }
    const ordered = [...threads.values()].sort((a,b)=>a.createdAt-b.createdAt || a.id.localeCompare(b.id));
    let failed = false;
    for (const dto of ordered) {
      signal.throwIfAborted();
      if (cursor.after && (dto.createdAt < cursor.after.createdAt || (dto.createdAt === cursor.after.createdAt && dto.id.localeCompare(cursor.after.id) <= 0))) continue;
      dtos.set(dto.id,dto);
      if (!await flushThread(dto.id, signal)) failed = true;
      signal.throwIfAborted();
      if (!failed) store.setCursor('backfill',{done:false,after:{createdAt:dto.createdAt,id:dto.id}});
      yield;
    }
    if (!failed) store.setCursor('backfill',{done:true});
  }
  async function flushDirty(signal: AbortSignal, limit = 50) {
    for (const id of [...dirty].slice(0,limit)) {
      signal.throwIfAborted(); dirty.delete(id);
      await flushThread(id, signal);
      await setImmediate(undefined, { signal });
    }
  }
  async function tick(signal: AbortSignal) {
    if (Date.now()-lastExt>=60_000) { lastExt=Date.now(); await external(signal); }
    await flushDirty(signal);
    signal.throwIfAborted();
    const settings = await o.settings.get();
    if (settings.includeOutsideBb && Date.now()-lastOutside>=300_000) {
      lastOutside=Date.now();
      const known = new Set((db.prepare('SELECT provider_thread_id FROM provider_session').all() as {provider_thread_id:string}[]).map(r=>r.provider_thread_id));
      for (const id of ['claude-file','codex-file'] as const) try {
        const batch = await o.files[id].scanOutside(known,Date.now()-settings.rollupRetentionDays*86_400_000, signal);
        await apply([batch], signal); status(id);
      } catch (e) { if (!signal.aborted) fail(id,e); }
    }
  }
  bb.background.service('ingest',{ async start(hostSignal) {
    controller = new AbortController();
    const { signal } = controller;
    const stop = () => { stopped=true; controller?.abort(); if (trailing) clearTimeout(trailing); };
    hostSignal.addEventListener('abort',stop,{once:true});
    if (hostSignal.aborted) stop();
    // Source SDK calls share the service run's signal, including their internal paging/RPC calls.
    const bound = bb.sdk;
    sdk = { ...bound,
      threads: { ...bound.threads,
        get: args => bound.threads.get({ ...args, signal }),
        list: args => bound.threads.list({ ...args, signal }),
        events: { ...bound.threads.events, list: args => bound.threads.events.list({ ...args, signal }) },
      },
      environments: { ...bound.environments, get: args => bound.environments.get({ ...args, signal }) },
      plugins: { ...bound.plugins, callRpc: args => bound.plugins.callRpc({ ...args, signal }) },
    };
    sources = o.sources(sdk, signal);
    const loop = async () => {
      try {
        let afterId = '';
        for (;;) {
          signal.throwIfAborted();
          const page = db.prepare("SELECT id FROM threads WHERE provider_id IN ('claude-code','codex') AND id>? ORDER BY id LIMIT 100").all(afterId) as {id:string}[];
          for (const row of page) dirty.add(row.id);
          if (page.length<100) break;
          afterId = page.at(-1)!.id;
          await setImmediate(undefined,{signal});
        }
        let history = backfill(signal), historyDone = false;
        while (!signal.aborted) {
          try {
            if (!historyDone) {
              historyDone = !!(await history.next()).done;
              if (!historyDone) {
                await flushDirty(signal,1);
                if (Date.now()-lastExt>=60_000) { lastExt=Date.now(); await external(signal); }
                await setImmediate(undefined,{signal});
                continue;
              }
            }
            await tick(signal);
          } catch (e) {
            if (signal.aborted) break;
            fail('scheduler',e); history=backfill(signal); historyDone=false;
          }
          await new Promise<void>(resolve => {
            const abort = () => { clearTimeout(timer); resolve(); };
            const timer = setTimeout(() => { signal.removeEventListener('abort',abort); resolve(); },5000);
            signal.addEventListener('abort',abort,{once:true});
            if (signal.aborted) abort();
          });
        }
      } catch (e) { if (!signal.aborted) fail('scheduler',e); }
    };
    running = loop();
    try {
      await new Promise<void>(resolve => {
        if (signal.aborted) resolve(); else signal.addEventListener('abort',()=>resolve(),{once:true});
      });
    } finally {
      stop(); hostSignal.removeEventListener('abort',stop);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([running,new Promise<void>(resolve => { timeout=setTimeout(resolve,1500); })]); }
      finally { if (timeout) clearTimeout(timeout); }
    }
  } });
  bb.onDispose(() => { stopped=true; controller?.abort(); if (trailing) clearTimeout(trailing); });
  return { invalidate };
}
