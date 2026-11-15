import type { BbPluginApi, PluginBbSdk, PluginRpcHandlers } from '@get-bb/plugin-sdk';
import type { Database } from 'better-sqlite3';
import { rpcContract } from './contract.js';
import { parseOverrides, type Overrides } from './pricing/price.js';
import * as read from './store/read.js';
import { prune } from './store/prune.js';

export type Settings = { rawRetentionDays: number; rollupRetentionDays: number; referenceModel: string; includeOutsideBb: boolean; priceOverrides: string };
export type SettingsHandle = { get(): Promise<Settings>; experimental_set(values: { priceOverrides: string }): Promise<unknown> };
export function registerRpc(bb: BbPluginApi, db: Database, settings: SettingsHandle, sdk: PluginBbSdk = bb.sdk, loop?: () => { p99Ms: number; maxMs: number }) {
  const options = async () => {
    const s = await settings.get();
    let overrides: Overrides = {}, priceOverridesError: string | null = null;
    try { overrides = parseOverrides(s.priceOverrides); }
    catch (error) { priceOverridesError = `Invalid priceOverrides: ${error instanceof Error ? error.message : String(error)}`; }
    return { ...s, overrides, priceOverridesError, now: Date.now() };
  };
  let cached: { at: number; value: Awaited<ReturnType<typeof sdk.system.usageLimits>> } | undefined;
  let pending: Promise<void> | undefined;
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
  const handlers: PluginRpcHandlers<typeof rpcContract> = {
    'costs.threads': async i => read.threadCosts(db,i.threadIds,i.includeDescendants,(await options()).overrides),
    'costs.sum': async i => read.costSum(db,i.threadIds,i.includeDescendants,(await options()).overrides),
    summary: async i => read.summary(db,{ ...await options(), ...i }),
    topThreads: async i => { const o = await options(); return read.topThreads(db,i.range,i.offset,i.limit,o.overrides,o.now,i.projectId,await projectNames()); },
    compactions: async i => { const o = await options(); return read.compactionsInRange(db,i.range,o.overrides,o.now,i.projectId); },
    projects: async () => {
      const o = await options(), names = await projectNames();
      const ids = db.prepare('SELECT DISTINCT project_id FROM usage_hourly WHERE hour>=? ORDER BY project_id')
        .all(o.now-o.rollupRetentionDays*86_400_000) as { project_id: string }[];
      return { items: ids.map(p => ({ projectId: p.project_id, name: names.get(p.project_id) ?? p.project_id })) };
    },
    limits: async () => {
      const o = await options();
      if (!cached || o.now-cached.at>=60_000) {
        pending ??= sdk.system.usageLimits().then(value => { cached = { at: Date.now(),value }; }).finally(() => { pending = undefined; });
        await pending;
      }
      return { ...read.limits(db,cached!.value,o.now,o.overrides), fetchedAt: cached!.at };
    },
    status: async () => {
      const o = await options(), result = read.status(db);
      if (o.priceOverridesError) result.sources.push({ id: 'priceOverrides', lastIngestAt: null, rows: 0, lastError: o.priceOverridesError, state: 'error' });
      return { ...result, ...(loop ? { loop: loop() } : {}) };
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
  bb.rpc.register(rpcContract,handlers);
  return handlers;
}
