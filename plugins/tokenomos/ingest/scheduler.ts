import type { BbPluginApi, PluginBbSdk } from '@get-bb/plugin-sdk';
import type { Database } from 'better-sqlite3';
import { setImmediate } from 'node:timers/promises';
import { RECOVERED, type SourceId, type UsageRow, type ThreadDtoLike } from '../contract';
import type { Store } from '../store/write';
import type { Settings } from '../rpc';
import type { FileSource, ThreadInfo } from './files';
import type { createBbEvents } from './bb-events';

type ThreadResponse = ThreadDtoLike & { createdAt: number; environmentId?: string | null; providerThreadId?: string | null };
type BbEvents = Pick<ReturnType<typeof createBbEvents>, 'flushThread' | 'coverage'> & { onRowsApplied(rows: UsageRow[]): void };
type Ext = {
  pollUsage(id: 'local-models' | 'antigravity'): Promise<{ rows: UsageRow[]; available: boolean }>;
  pollCompactions(): Promise<{ matched: number; available: boolean }>;
};
type Source = { source: SourceId; since_ts: number; state: string };
type Batch = { rows: UsageRow[]; commit?(): void };
const fileId = (provider: string) => provider === 'claude-code' ? 'claude-file' : provider === 'codex' ? 'codex-file' : null;

export function createScheduler(o: {
  bb: BbPluginApi; db: Database; store: Store;
  settings: { get(): Promise<Settings>; onChange(fn: (next: Settings, prev: Settings) => void): void };
  files: Record<'claude-file' | 'codex-file', FileSource>;
  // Construct these only in the service, after the SDK has been bound.
  sources(sdk: PluginBbSdk): { bbEvents: BbEvents; ext: Ext };
}) {
  const { bb, db, store } = o;
  const dirty = new Set<string>();
  const dtos = new Map<string, ThreadResponse>();
  const environments = new Map<string, string | null>();
  let stopped = false, lastInvalidation = -Infinity;
  let trailing: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let sources: ReturnType<typeof o.sources> | undefined;
  let agyAvailable = false, lastExt = -Infinity, lastOutside = -Infinity;
  const status = (id: string, error: string | null = null, state = 'ok') => {
    db.prepare(`INSERT INTO source_status(source,last_ingest_at,rows,last_error,state) VALUES (?,?,(SELECT COUNT(*) FROM usage_raw WHERE source=?),?,?)
      ON CONFLICT(source) DO UPDATE SET last_ingest_at=CASE WHEN excluded.last_error IS NULL THEN excluded.last_ingest_at ELSE last_ingest_at END,
      rows=(SELECT COUNT(*) FROM usage_raw WHERE source=?),last_error=excluded.last_error,state=excluded.state`).run(id, Date.now(), id, error, state, id);
  };
  const fail = (id: string, error: unknown) => {
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
  function apply(batches: Batch[]) {
    if (stopped) return;
    db.transaction(() => {
      const rows = batches.flatMap(b => b.rows).filter(owns);
      const result = store.applyRows(rows);
      for (const batch of batches) batch.commit?.();
      sources!.bbEvents.onRowsApplied(rows);
      if (result.inserted || result.updated) invalidate();
    })();
  }
  const retained = (id: string) => {
    const total = db.prepare('SELECT COALESCE(SUM(calls),0) n FROM thread_tokens WHERE thread_id=?').get(id) as { n: number };
    const raw = db.prepare('SELECT COUNT(*) n FROM usage_raw WHERE thread_id=?').get(id) as { n: number };
    return total.n === raw.n;
  };
  const setSource = (id: string, source: SourceId, state = 'ok') => db.prepare(`INSERT INTO thread_source(thread_id,source,since_ts,state) VALUES (?,?,?,?)
    ON CONFLICT(thread_id) DO UPDATE SET source=excluded.source,since_ts=excluded.since_ts,state=excluded.state`).run(id, source, Date.now(), state);
  const candidates = (id: string): UsageRow[] => (db.prepare('SELECT * FROM bb_candidate WHERE thread_id=?').all(id) as Array<Record<string, any>>).map(r => ({
    key:r.key,ts:r.ts,threadId:r.thread_id,projectId:r.project_id,provider:r.provider,model:r.model,tier:r.tier,tierRaw:r.tier_raw,promptTokens:r.prompt_tokens,band:r.band,conv:r.conv,
    freshIn:r.fresh_in,cacheRead:r.cache_read,cacheWriteShort:r.cache_write_short,cacheWriteLong:r.cache_write_long,output:r.output,reasoning:r.reasoning,turnId:r.turn_id||null,source:'bb-events',flags:r.flags,
  }));
  async function flushThread(id: string): Promise<boolean> {
    let sourceId: SourceId = current(id)?.source ?? 'bb-events';
    try {
      const sdk = bb.sdk;
      const dto = dtos.get(id) ?? await sdk.threads.get({ threadId: id });
      if (stopped) return false;
      store.noteThread(dto);
      const desiredFile = fileId(dto.providerId ?? '');
      // Always keep event metadata/candidates, even while waiting for a local file.
      const eventBatch = await sources!.bbEvents.flushThread(id, current(id)?.source === 'bb-events');
      if (stopped) return false;
      const session = db.prepare('SELECT provider_thread_id FROM provider_session WHERE thread_id=? ORDER BY rowid DESC LIMIT 1').get(id) as { provider_thread_id: string } | undefined;
      let cwd: string | null = null;
      if (dto.environmentId) {
        if (!environments.has(dto.environmentId)) environments.set(dto.environmentId, (await sdk.environments.get({ environmentId: dto.environmentId })).path);
        cwd = environments.get(dto.environmentId) ?? null;
      }
      const info: ThreadInfo = { threadId:id, providerThreadId:session?.provider_thread_id ?? ('providerThreadId' in dto ? dto.providerThreadId as string | null : null),
        provider:dto.providerId ?? '',projectId:dto.projectId ?? '',createdAt:dto.createdAt,isFork:!!dto.sourceThreadId,cwd };
      const found = desiredFile ? await o.files[desiredFile].locate(info) : false;
      if (stopped) return false;
      const pending = [...eventBatch.rows, ...eventBatch.candidates];
      const firstKey = `first-usage:${id}`;
      let first = store.getCursor<number>(firstKey);
      if (first === null) { const saved = candidates(id); if (saved.length) first = Math.min(...saved.map(r => r.ts)); }
      if (pending.length) { first = Math.min(first ?? Infinity, ...pending.map(r => r.ts)); store.setCursor(firstKey, first); }
      if (found) store.setCursor(`file-found:${id}`, true);
      const old = current(id);
      let switchDeferred = false;
      const selected: SourceId = desiredFile ? (found || store.getCursor<boolean>(`file-found:${id}`) || first === null || Date.now() - first < 600_000 ? desiredFile : 'bb-events')
        : dto.providerId === 'local-models' ? 'local-log' : dto.providerId === 'antigravity' && agyAvailable ? 'agy-log' : 'bb-events';
      switchDeferred = !!old && old.source !== selected && !retained(id);
      sourceId = switchDeferred ? old!.source : selected;
      // Persist candidates before any file read can fail.
      const insert = db.prepare(`INSERT OR REPLACE INTO bb_candidate (key,ts,thread_id,project_id,provider,model,tier,tier_raw,prompt_tokens,band,conv,fresh_in,cache_read,cache_write_short,cache_write_long,output,reasoning,turn_id,source,flags)
        VALUES (@key,@ts,@threadId,@projectId,@provider,@model,@tier,@tierRaw,@promptTokens,@band,@conv,@freshIn,@cacheRead,@cacheWriteShort,@cacheWriteLong,@output,@reasoning,@turnId,@source,@flags)`);
      db.transaction(() => { for (const r of pending) insert.run({ ...r, turnId:r.turnId ?? '' }); })();
      const fileBatch = desiredFile && found && sourceId === desiredFile ? await o.files[desiredFile].flushThread(info) : null;
      if (stopped) return false;
      // Observe arriving main rows before filtering: rows in a fallback interval cannot be applied again.
      const state = old ?? { source:sourceId, since_ts:Date.now(), state:'ok' };
      const coverage = desiredFile && sourceId === desiredFile ? await sources!.bbEvents.coverage(id) : null;
      const covered = state.state === 'degraded' && fileBatch?.rows.some(r => !r.conv && r.ts >= state.since_ts && !!db.prepare('SELECT 1 FROM turns WHERE thread_id=? AND reported_usage=1 AND started_at<=? AND completed_at+120000>=? AND completed_at>0').get(id,r.ts,r.ts));
      db.transaction(() => {
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
        apply([...(fileBatch ? [fileBatch] : []), { rows: candidates(id) }]);
      })();
      // Recompute after applying file rows, so this batch can prevent a false degradation.
      const after = coverage && await sources!.bbEvents.coverage(id);
      if (after && current(id)!.state !== 'degraded' && !covered && after.uncoveredStreak >= 3 && after.firstUncoveredStart !== null) {
        const from = retained(id) ? after.firstUncoveredStart : Date.now();
        db.transaction(() => {
          db.prepare('INSERT OR IGNORE INTO source_interval VALUES (?,?,?)').run(id,0,sourceId);
          db.prepare('INSERT OR REPLACE INTO source_interval VALUES (?,?,?)').run(id,from,'bb-events');
          store.deleteContribution(id,sourceId,from);
          setSource(id,sourceId,'degraded');
          db.prepare("INSERT INTO thread_cov(thread_id,partial) VALUES (?,1) ON CONFLICT(thread_id) DO UPDATE SET partial=1").run(id);
          apply([{ rows:candidates(id).map(r => ({ ...r, flags:r.flags | RECOVERED })) }]);
          invalidate();
        })();
      }
      const warning = switchDeferred ? 'Source switch deferred: raw rows have expired'
        : fileBatch?.parseErrors ? `Skipped ${fileBatch.parseErrors} invalid transcript lines` : null;
      if (warning) bb.log.warn(`Tokenomos ${sourceId}: ${warning}`);
      status(sourceId, warning, warning ? 'partial' : current(id)!.state);
      if (desiredFile && (!found || sourceId === 'bb-events')) dirty.add(id);
      if (eventBatch.touched) invalidate();
      return true;
    } catch (e) { fail(sourceId,e); dirty.add(id); return false; }
  }
  async function external() {
    for (const id of ['local-models','antigravity'] as const) {
      const source = id === 'local-models' ? 'local-log' : 'agy-log';
      try {
        const result = await sources!.ext.pollUsage(id);
        if (stopped) return;
        if (id === 'antigravity') {
          if (agyAvailable !== result.available) for (const r of db.prepare("SELECT id FROM threads WHERE provider_id='antigravity'").all() as {id:string}[]) dirty.add(r.id);
          agyAvailable = result.available;
        }
        db.transaction(() => {
          for (const row of result.rows) {
            if (!row.threadId || row.source === 'local-log') continue;
            const old = current(row.threadId);
            if (!old) setSource(row.threadId,source);
            else if (old.source === 'bb-events' && retained(row.threadId)) {
              store.deleteContribution(row.threadId,old.source);
              setSource(row.threadId,source); invalidate();
            }
          }
          apply([result]);
        })();
        status(source,null,result.available ? 'ok' : 'unavailable');
      } catch (e) { fail(source,e); }
    }
    try { const result = await sources!.ext.pollCompactions(); if (!stopped && result.matched) invalidate(); } catch (e) { fail('compactions',e); }
  }
  async function backfill(signal: AbortSignal) {
    type Cursor = { done: boolean; after?: { createdAt: number; id: string } };
    const cursor = store.getCursor<Cursor>('backfill') ?? {done:false};
    if (cursor.done) return true;
    const threads: ThreadResponse[] = [];
    for (const archived of [false,true]) for (let offset=0;;offset+=100) {
      const page = await bb.sdk.threads.list({archived,includeHidden:true,limit:100,offset,signal});
      if (stopped || signal.aborted) return;
      threads.push(...page); if (page.length<100) break;
    }
    const ordered = [...new Map(threads.map(t=>[t.id,t])).values()].sort((a,b)=>a.createdAt-b.createdAt || a.id.localeCompare(b.id));
    let failed = false;
    for (const dto of ordered) {
      if (stopped || signal.aborted) return;
      if (cursor.after && (dto.createdAt < cursor.after.createdAt || (dto.createdAt === cursor.after.createdAt && dto.id.localeCompare(cursor.after.id) <= 0))) continue;
      dtos.set(dto.id,dto);
      if (!await flushThread(dto.id)) failed = true;
      if (stopped || signal.aborted) return;
      if (!failed) store.setCursor('backfill',{done:false,after:{createdAt:dto.createdAt,id:dto.id}});
      await setImmediate();
    }
    if (!stopped && !signal.aborted && !failed) store.setCursor('backfill',{done:true});
    return !failed;
  }
  async function tick() {
    if (Date.now()-lastExt>=60_000) { lastExt=Date.now(); await external(); }
    for (const id of [...dirty].slice(0,50)) { if (stopped) return; dirty.delete(id); await flushThread(id); }
    if (stopped) return;
    const settings = await o.settings.get();
    if (settings.includeOutsideBb && Date.now()-lastOutside>=300_000) {
      lastOutside=Date.now();
      const known = new Set((db.prepare('SELECT provider_thread_id FROM provider_session').all() as {provider_thread_id:string}[]).map(r=>r.provider_thread_id));
      for (const id of ['claude-file','codex-file'] as const) try {
        const batch = await o.files[id].scanOutside(known,Date.now()-settings.rollupRetentionDays*86_400_000);
        apply([batch]); status(id);
      } catch (e) { fail(id,e); }
    }
  }
  bb.background.service('ingest',{ async start(signal) {
    sources = o.sources(bb.sdk);
    signal.addEventListener('abort', () => { stopped=true; if (trailing) clearTimeout(trailing); }, {once:true});
    for (const row of db.prepare("SELECT id FROM threads WHERE provider_id IN ('claude-code','codex')").all() as {id:string}[]) dirty.add(row.id);
    let first = true;
    const run = () => running ??= (async () => {
      try { if (first) { first=!(await backfill(signal)); } if (!signal.aborted && !stopped) await tick(); }
      catch (e) { if (!signal.aborted) { first=true; fail('scheduler',e); } }
    })().finally(() => { running=undefined; });
    const timer = setInterval(() => { if (!signal.aborted && !stopped) void run(); },5000);
    try {
      void run();
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort',()=>resolve(),{once:true}); });
    } finally { clearInterval(timer); await running; }
  } });
  bb.onDispose(() => { stopped=true; if (trailing) clearTimeout(trailing); });
  return { invalidate };
}
