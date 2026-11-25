import { experimental_PluginRpcRefusal, type BbPluginApi, type JsonValue, type PluginBbSdk, type PluginRpcHandlers } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import type { Database } from 'better-sqlite3';
import { rpcContract } from './contract.js';
import { parseOverrides, type Overrides } from './pricing/price.js';
import * as read from './store/read.js';
import { watchlist, wakeCost } from './store/context';
import { prune } from './store/prune.js';
import { REFERENCE_MODELS, SETTINGS, type SettingKey } from './settings.js';
import { resolveModel } from './pricing/price.js';
import { DEFAULT_HEAVY_MODELS, parseHeavy, RECENT, windowLength, windowPace, windowUsage } from './store/limits.js';
import { createLimitCollector, type CollectorState, type LimitAccount } from './ingest/usage-limits.js';

export type Settings = { rawRetentionDays: number; rollupRetentionDays: number; referenceModel: string; includeOutsideBb: boolean; priceOverrides: string; contextWatchTokens?:number; heavyModels?: string; heavyTargetPercent?: number; language?: string };
export type SettingsHandle = { get(): Promise<Settings>; experimental_set(values: Partial<Settings>): Promise<unknown> };
export function registerRpc(bb: BbPluginApi, db: Database, settings: SettingsHandle, sdk: PluginBbSdk = bb.sdk, loop?: () => { p99Ms: number; maxMs: number }, watchlistState?: (active:boolean)=>void) {
  const options = async () => {
    const s = await settings.get();
    let overrides: Overrides = {}, priceOverridesError: string | null = null;
    try { overrides = parseOverrides(s.priceOverrides); }
    catch (error) { priceOverridesError = `Invalid priceOverrides: ${error instanceof Error ? error.message : String(error)}`; }
    return { ...s, overrides, priceOverridesError, now: Date.now() };
  };
  let projectCache: { at: number; names: Map<string,string> } | undefined;
  let projectPending: Promise<void> | undefined;
  const projectNames = async () => {
    if (!projectCache || Date.now()-projectCache.at>=300_000) {
      projectPending ??= sdk.projects.list({ includePersonal: true }).then(items => {
        projectCache = { at: Date.now(), names: new Map(items.map(p => [p.id,p.name])) };
        projectCache.names.set('~outside','Outside bb'); projectCache.names.set('~local-calls','Local calls');
      }).finally(() => { projectPending = undefined; });
      await projectPending;
    }
    return projectCache!.names;
  };
  // Provider limits come from other plugins: at most one collection a minute, and only while someone reads them.
  // Readers get the last known accounts at once (kept in the db across restarts) while a stale copy refreshes in
  // the background; a finished refresh invalidates `usage`, so open views pick it up. Only the very first read waits.
  const LAST_LIMITS = 'limits-last';
  const persisted = (): { at: number; accounts: LimitAccount[] } & CollectorState | undefined => {
    try { return JSON.parse((db.prepare('SELECT value FROM cursor WHERE name=?').get(LAST_LIMITS) as { value: string } | undefined)?.value ?? 'null') ?? undefined; }
    catch { return undefined; }
  };
  // Numbers from before a restart are last known, not live: marked stale until the first refresh replaces them.
  const restored = persisted();
  let limitCache: { at: number; accounts: LimitAccount[] } | undefined = restored && { at: restored.at, accounts: restored.accounts.map(a => ({ ...a, stale: true })) };
  let limitPending: Promise<void> | undefined;
  const collectLimitsNow = createLimitCollector(
    async method => sdk.plugins.experimental_discoverRpc({ method }),
    (pluginId, method, input, signal) => sdk.plugins.callRpc({ pluginId, method, input: input as JsonValue, signal, outputSchema: z.unknown() }),
    bb.pluginId,
    undefined,
    restored,
  );
  // This machine: limits show only its accounts and shared ones, not other connected machines' logins.
  let selfHost: string | null = null;
  const refreshMachines = async () => {
    try { selfHost = (await sdk.system.config()).primaryHostId; } catch { /* unknown: no account is dropped */ }
  };
  const refreshLimits = () => limitPending ??= Promise.all([collectLimitsNow(), refreshMachines()]).then(([accounts]) => {
    const had = limitCache !== undefined;
    limitCache = { at: Date.now(), accounts };
    if (accounts.length) db.prepare('INSERT INTO cursor(name,value) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value').run(LAST_LIMITS, JSON.stringify({ ...limitCache, ...collectLimitsNow.state() }));
    if (had) bb.rpc.experimental_invalidate(['usage']);
  }, () => { limitCache ??= { at: Date.now(), accounts: [] }; }).finally(() => { limitPending = undefined; });
  let machinesKnown: Promise<void> | undefined;
  const limitAccounts = async () => {
    // A restart restores the accounts but not this machine's id; the first read learns it.
    await (machinesKnown ??= refreshMachines());
    if (!limitCache) await refreshLimits();
    else if (Date.now()-limitCache.at>=60_000) void refreshLimits();
    return limitCache!.accounts;
  };
  // Reference-model choices: the priced models bb's providers offer. Each successful answer is kept as the
  // fallback for the next time they cannot be reached; the built-in list is the last resort.
  const SAVED_MODELS = 'reference-models';
  const savedModels = () => {
    try { return JSON.parse((db.prepare('SELECT value FROM cursor WHERE name=?').get(SAVED_MODELS) as { value: string } | undefined)?.value ?? 'null') as { model: string; label: string; provider: string | null }[] | null; }
    catch { return null; }
  };
  const referenceModels = async () => {
    const items: { model: string; label: string; provider: string | null }[] = [], seen = new Set<string>();
    try {
      const providers = (await sdk.providers.list()).filter(p => p.id !== 'local-models');
      const lists = await Promise.all(providers.map(p => sdk.providers.models({ providerId: p.id, preferCached: true, signal: AbortSignal.timeout(5000) })
        .then(r => r.models.map(m => ({ model: m.model, label: m.displayName || m.model, provider: p.id })), () => [])));
      for (const m of lists.flat()) if (resolveModel(m.model) && !seen.has(m.model)) { seen.add(m.model); items.push(m); }
    } catch { /* providers unavailable: the fallback below */ }
    if (items.length) {
      db.prepare('INSERT INTO cursor(name,value) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value').run(SAVED_MODELS, JSON.stringify(items));
      return items;
    }
    const saved = savedModels()?.filter(m => resolveModel(m.model));
    return saved?.length ? saved : REFERENCE_MODELS.map(model => ({ model, label: model, provider: null }));
  };
  let watched: {at:number;key:string;value:ReturnType<typeof watchlist>}|undefined;
  const handlers: PluginRpcHandlers<typeof rpcContract> = {
    watchlist: async () => {
      const o=await options(), threshold=o.contextWatchTokens ?? 300000, key=JSON.stringify([threshold,o.overrides]);
      if (!watched || o.now-watched.at>=30000 || watched.key!==key) watched={at:o.now,key,value:watchlist(db,o.now,threshold,o.overrides)};
      watchlistState?.(watched.value.items.length>0);return watched.value;
    },
    limits: async () => {
      const o = await options(), heavy = parseHeavy(o.heavyModels ?? DEFAULT_HEAVY_MODELS);
      // A window past its reset comes from a last known report; its numbers belong to a period that is over.
      const accounts = (await limitAccounts()).filter(a => !a.host || !selfHost || a.host.id === selfHost).map(({ host: _, ...a }) => {
        const live = a.windows.filter(w => w.resetsAt === null || w.resetsAt > o.now);
        // All windows over and no fresh report yet: say so, instead of "no data: ok".
        return { ...a, message: live.length || !a.windows.length ? a.message : a.message ?? 'reset, no fresh report yet', windows: live.map(w => {
          const length = windowLength(w.kind, w.label), startsAt = w.resetsAt === null || length === null ? null : w.resetsAt - length;
          const usage = startsAt === null ? null : windowUsage(db, a.providerId, startsAt, w.usedPercent, w.model, heavy, o.overrides);
          // shortcut: the last week's spend counts from the first stored hour, so a fresh install underrates the pace for its first week.
          if (usage && length !== null && length >= RECENT) {
            const recent = windowUsage(db, a.providerId, o.now - RECENT, 0, w.model, heavy, o.overrides);
            usage.recentUsdPerHour = ((recent.heavy.usd + recent.other.usd) / RECENT) * 3_600_000;
          }
          const perMs = usage?.recentUsdPerHour != null && usage.usdPerPercent ? usage.recentUsdPerHour / 3_600_000 / usage.usdPerPercent : null;
          return { ...w, ...windowPace(w.usedPercent, w.resetsAt, length, o.now, perMs), usage };
        }) };
      });
      const target = o.heavyTargetPercent ?? 50;
      return { heavyModels: heavy, heavyTarget: target > 0 ? target / 100 : null, accounts };
    },
    wakeCost: async i => {const o=await options();return wakeCost(db,i.threadId,o.now,o.overrides);},
    'costs.threads': async i => read.threadCosts(db,i.threadIds,i.includeDescendants,(await options()).overrides),
    'costs.sum': async i => { const o = await options(); return 'spans' in i ? read.costSumSpans(db,i.spans,i.includeDescendants,{...o,breakdown:i.breakdown}) : read.costSum(db,i.threadIds,i.includeDescendants,o.overrides,i.breakdown); },
    summary: async i => read.summary(db,{ ...await options(), ...i }),
    topThreads: async i => { const o = await options(); return read.topThreads(db,i.range,i.offset,i.limit,o.overrides,o.now,i.projectId,await projectNames()); },
    compactions: async i => { const o = await options(); return read.compactionsInRange(db,i.range,o.overrides,o.now,i.projectId); },
    projects: async () => {
      const o = await options(), names = await projectNames();
      const ids = db.prepare('SELECT DISTINCT project_id FROM usage_hourly WHERE hour>=? ORDER BY project_id')
        .all(o.now-o.rollupRetentionDays*86_400_000) as { project_id: string }[];
      return { items: ids.map(p => ({ projectId: p.project_id, name: names.get(p.project_id) ?? p.project_id })) };
    },
    status: async () => {
      const o = await options(), result = read.status(db);
      if (o.priceOverridesError) result.sources.push({ id: 'priceOverrides', lastIngestAt: null, rows: 0, lastError: o.priceOverridesError, state: 'error' });
      return { ...result, ...(loop ? { loop: loop() } : {}) };
    },
    // Asked afresh each time the settings open, the only place this setting changes; no cache of our own.
    'config.options': async () => ({ referenceModels: await referenceModels() }),
    'config.get': async () => ({ values: { ...await settings.get() } as Record<string, string | number | boolean> }),
    'config.set': async i => {
      if (!Object.hasOwn(SETTINGS, i.key)) throw new Error(`Unknown setting: ${i.key}`);
      const value = SETTINGS[i.key as SettingKey].experimental_schema.parse(i.value);
      await settings.experimental_set({ [i.key]: value } as Partial<Settings>); bb.rpc.experimental_invalidate(['usage']); return { ok: true };
    },
    prices: async () => read.prices((await options()).overrides),
    setPriceOverride: async i => {
      const overrides = (await options()).overrides;
      if (i.rates === null) delete overrides[i.model]; else overrides[i.model] = { ...overrides[i.model], ...i.rates };
      const priceOverrides = JSON.stringify(overrides); parseOverrides(priceOverrides);
      await settings.experimental_set({ priceOverrides }); bb.rpc.experimental_invalidate(['usage']); return { ok: true };
    },
    prune: async () => { const o = await options(); const deletedRows = prune(db,o); bb.rpc.experimental_invalidate(['usage']); return { deletedRows }; },
  };
  bb.rpc.register(rpcContract,guardPublic(handlers));
  return handlers;
}

/** The only methods other plugins may call; the rest belong to the Tokenomos page and CLI and may change at any time. */
export const PUBLIC_METHODS = new Set(['costs.sum', 'costs.threads']);
/** Refuses other plugins on internal methods, naming the public method to use instead. The page and the CLI call as clients. */
function guardPublic<H extends Record<string, (input: never, ctx: { experimental_caller: { kind: string } }) => unknown>>(handlers: H): H {
  return Object.fromEntries(Object.entries(handlers).map(([method, handler]) => [method, PUBLIC_METHODS.has(method) ? handler
    : (input: never, ctx: { experimental_caller: { kind: string } }) => {
      if (ctx?.experimental_caller?.kind === 'plugin') throw new experimental_PluginRpcRefusal({ code: 'forbidden',
        message: `Tokenomos "${method}" is internal to its page and CLI. Call "costs.sum" (spans for a time window, breakdown: true for per-model and per-thread rows) or "costs.threads" instead.` });
      return handler(input, ctx);
    }])) as H;
}
