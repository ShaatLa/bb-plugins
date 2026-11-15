import type { Database } from 'better-sqlite3';
import type { PluginBbSdk } from '@get-bb/plugin-sdk';
import { ESTIMATED, RECOVERED, type Cost, type Range, type Saving } from '../contract.js';
import { costUsd, ratesFor, listPrices, resolveModel, PRICE_TABLE_VERSION, type Overrides } from '../pricing/price.js';
import { diskStats } from './prune.js';

const HOUR = 3_600_000;
type Group = { model: string; tier: string; band: number; fresh_in: number; cache_read: number; cache_write_short: number; cache_write_long: number; output: number; calls: number; provider?: string };
const sums = ['fresh_in', 'cache_read', 'cache_write_short', 'cache_write_long', 'output', 'calls'].map(k => `SUM(${k}) AS ${k}`).join(',');
const empty = (): Cost => ({ usd: 0, tokens: { freshIn: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, partial: false, estimated: false });
function add(a: Cost, b: Cost) {
  a.usd = a.usd === null && b.usd === null ? null : (a.usd ?? 0) + (b.usd ?? 0);
  for (const k of ['freshIn', 'cacheRead', 'cacheWrite', 'output'] as const) a.tokens[k] += b.tokens[k];
  a.partial ||= b.partial; a.estimated ||= b.estimated;
  return a;
}
function priceContext(overrides: Overrides) {
  const verified = new Set(listPrices(overrides).filter(p => p.verified).map(p => p.model));
  return (r: Group): Cost => {
    const usd = r.provider === 'local-models' ? 0 : costUsd({ freshIn: r.fresh_in, cacheRead: r.cache_read, cacheWriteShort: r.cache_write_short, cacheWriteLong: r.cache_write_long, output: r.output }, r.model, r.tier, r.band, overrides);
    return { usd, tokens: { freshIn: r.fresh_in, cacheRead: r.cache_read, cacheWrite: r.cache_write_short + r.cache_write_long, output: r.output }, partial: usd === null, estimated: r.provider !== 'local-models' && usd !== null && !verified.has(resolveModel(r.model) ?? r.model) };
  };
}
function combine(rows: Group[], overrides: Overrides): Cost {
  const price = priceContext(overrides);
  if (!rows.length) return empty();
  return rows.map(price).reduce(add);
}

// Calendar buckets follow the server timezone, including daylight-saving transitions.
export function rangeBounds(range: Range, now: number) {
  const count = { day: 24, week: 7, month: 30, '3m': 13 }[range];
  const step = range === '3m' ? 7 : 1;
  const end = new Date(now);
  if (range === 'day') {
    end.setMinutes(0, 0, 0);
    const to = +end, from = to - count * HOUR;
    return { from, to, previousFrom: from - count * HOUR, starts: Array.from({ length: count }, (_, i) => from + i * HOUR) };
  }
  end.setHours(0, 0, 0, 0); end.setDate(end.getDate() + 1);
  const starts = Array.from({ length: count }, (_, i) => { const d = new Date(end); d.setDate(d.getDate() - (count - i) * step); return +d; });
  const prev = new Date(starts[0]); prev.setDate(prev.getDate() - count * step);
  return { from: starts[0], to: +end, previousFrom: +prev, starts };
}
function flags(db: Database, from: number, to: number, outside: boolean) {
  return db.prepare(`SELECT COALESCE(MAX((r.flags & ?) != 0 OR c.partial = 1),0) AS partial,
    COALESCE(MAX((r.flags & ?) != 0),0) AS estimated FROM usage_raw r LEFT JOIN thread_cov c ON c.thread_id=r.thread_id
    WHERE r.ts>=? AND r.ts<? ${outside ? '' : "AND r.project_id != '~outside'"}`).get(RECOVERED, ESTIMATED, from, to) as { partial: number; estimated: number };
}
export type SummaryOptions = { range: Range; by: 'provider' | 'model'; now: number; overrides: Overrides; referenceModel: string; includeOutsideBb: boolean };
export function summary(db: Database, o: SummaryOptions) {
  const { from, to, previousFrom, starts } = rangeBounds(o.range, o.now);
  const outside = o.includeOutsideBb ? '' : "AND project_id != '~outside'";
  const query = db.prepare(`SELECT hour,provider,model,tier,band,${sums} FROM usage_hourly WHERE hour>=? AND hour<? ${outside} GROUP BY hour,provider,model,tier,band`);
  type Hour = Group & { hour: number; provider: string };
  const rows = query.all(from, to) as Hour[], previousRows = query.all(previousFrom, from) as Hour[];
  const price = priceContext(o.overrides);
  const totals = combine(rows, o.overrides), f = flags(db, from, to, o.includeOutsideBb);
  totals.partial ||= !!f.partial; totals.estimated ||= !!f.estimated;
  const modelCosts = new Map<string, number>();
  for (const r of rows) modelCosts.set(r.model, (modelCosts.get(r.model) ?? 0) + (price(r).usd ?? 0));
  const top = new Set([...modelCosts].sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0])).slice(0,4).map(([k]) => k));
  const key = (r: Hour) => o.by === 'provider' ? r.provider : top.has(r.model) ? r.model : 'other';
  const keys = [...new Set(rows.map(key))];
  const buckets = starts.map(start => ({ start, series: Object.fromEntries(keys.map(k => [k, empty()])) }));
  const breakdown = new Map(keys.map(k => [k, { key: k, label: k, cost: empty(), calls: 0 }]));
  // Start accumulators at the first priced row so an entirely unknown group stays null.
  const seen = new Set<string>();
  rows.forEach(r => {
    let i = starts.length - 1; while (i > 0 && r.hour < starts[i]) i--;
    const k = key(r), c = price(r), b = breakdown.get(k)!;
    buckets[i].series[k] = seen.has(`${i}:${k}`) ? add(buckets[i].series[k], c) : structuredClone(c);
    b.cost = seen.has(k) ? add(b.cost, c) : structuredClone(c); b.calls += r.calls;
    seen.add(`${i}:${k}`); seen.add(k);
  });
  const oldest = (db.prepare('SELECT MIN(hour) AS hour FROM usage_hourly').get() as { hour: number | null }).hour;
  const previous = oldest === null || previousFrom < oldest ? null : combine(previousRows, o.overrides);
  if (previous) { const p = flags(db, previousFrom, from, o.includeOutsideBb); previous.partial ||= !!p.partial; previous.estimated ||= !!p.estimated; }
  const localRows = rows.filter(r => r.provider === 'local-models');
  const local = combine(localRows.map(r => ({ ...r, provider: '', model: o.referenceModel, tier: 'standard' })), o.overrides);
  const denominator = totals.tokens.freshIn + totals.tokens.cacheRead + totals.tokens.cacheWrite;
  const savings = compactionsInRange(db, o.range, o.overrides, o.now).items.map(i => i.saving);
  const compactionSavings = sumSavings(savings);
  return { range: o.range, from, to, buckets, totals, previous, cacheReadShare: denominator ? totals.tokens.cacheRead / denominator : null,
    breakdown: [...breakdown.values()].sort((a,b) => (b.cost.usd ?? 0)-(a.cost.usd ?? 0)), compactionSavings,
    localSavings: { usd: local.usd, tokens: Object.values(local.tokens).reduce((a,b) => a+b,0), partial: local.partial, excludesOwnCost: false, referenceModel: o.referenceModel } };
}

export type Compaction = { before_tokens: number; after_tokens: number; own_cost_known: number };
export type Effect = { model: string; tier: string; band: number; calls_hit: number; calls_miss: number; calls_cross: number; first_gap_hit: number; overhead_fresh_in: number; overhead_cache_read: number; overhead_cache_write: number; overhead_output: number };
export function compactionEstimate(effects: Effect[], c: Compaction, overrides: Overrides = {}): Saving {
  const delta = c.before_tokens - c.after_tokens;
  let usd: number | null = effects.length ? null : 0, tokens = 0, partial = false;
  for (const e of effects) {
    tokens += delta * (e.calls_hit + e.calls_miss + e.calls_cross);
    partial ||= e.calls_cross > 0;
    const r = ratesFor(e.model, e.tier, e.band, overrides);
    if (!r) { partial = true; continue; }
    const gross = delta * (e.calls_hit * r.cacheRead + e.calls_miss * r.cacheWriteLong);
    const rewrite = e.first_gap_hit ? c.after_tokens * (r.cacheWriteLong - r.cacheRead) : 0;
    // shortcut: overhead writes have no TTL split; use short until effects retain both lifetimes.
    const overhead = e.overhead_fresh_in*r.input + e.overhead_cache_read*r.cacheRead + e.overhead_cache_write*r.cacheWriteShort + e.overhead_output*r.output;
    usd = (usd ?? 0) + (gross - rewrite - overhead)/1e6;
  }
  return { usd, tokens, partial, excludesOwnCost: !c.own_cost_known };
}
function sumSavings(rows: Saving[]): Saving {
  return { usd: rows.length && rows.every(r => r.usd === null) ? null : rows.reduce((n,r) => n+(r.usd ?? 0),0), tokens: rows.reduce((n,r) => n+r.tokens,0), partial: rows.some(r => r.partial), excludesOwnCost: rows.some(r => r.excludesOwnCost) };
}
export function compactionsInRange(db: Database, range: Range, overrides: Overrides = {}, now = Date.now()) {
  const { from, to } = rangeBounds(range, now);
  type Row = Compaction & { id: string; thread_id: string; title: string; at: number; origin: 'bb' | 'idle-compact' };
  const rows = db.prepare(`SELECT c.*,COALESCE(t.title,'') AS title FROM compactions c LEFT JOIN threads t ON t.id=c.thread_id WHERE c.at>=? AND c.at<? ORDER BY c.at DESC`).all(from,to) as Row[];
  const effects = db.prepare('SELECT * FROM compaction_effect WHERE compaction_id=?');
  return { items: rows.map(c => ({ id: c.id, threadId: c.thread_id, title: c.title, at: c.at, beforeTokens: c.before_tokens, afterTokens: c.after_tokens, origin: c.origin, saving: compactionEstimate(effects.all(c.id) as Effect[],c,overrides) })) };
}

function tree(db: Database, ids: string[], descendants: boolean) {
  // UNION deduplicates equal-depth paths; the final DISTINCT removes cycles across depths.
  return db.prepare(`WITH RECURSIVE reach(root,id,depth) AS (
    SELECT id,id,0 FROM threads WHERE id IN (SELECT value FROM json_each(?))
    UNION SELECT r.root,t.id,r.depth+1 FROM reach r JOIN threads t ON t.parent_id=r.id OR t.lifecycle_owner_id=r.id WHERE r.depth<32 AND ?
  ) SELECT DISTINCT root,id FROM reach`).all(JSON.stringify(ids), descendants ? 1 : 0) as { root: string; id: string }[];
}
function threadData(db: Database, ids: string[], overrides: Overrides) {
  const rows = db.prepare(`SELECT tt.*,COALESCE(c.partial,0) AS partial FROM thread_tokens tt LEFT JOIN thread_cov c ON c.thread_id=tt.thread_id WHERE tt.thread_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) as (Group & { thread_id: string; last_ts: number; partial: number })[];
  const price = priceContext(overrides), result = new Map<string, { cost: Cost; updatedAt: number }>();
  for (const r of rows) {
    const c = price(r); c.partial ||= !!r.partial;
    const old = result.get(r.thread_id);
    result.set(r.thread_id, { cost: old ? add(old.cost,c) : c, updatedAt: Math.max(old?.updatedAt ?? 0,r.last_ts) });
  }
  for (const r of db.prepare('SELECT thread_id FROM thread_cov WHERE partial=1 AND thread_id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids)) as { thread_id: string }[]) {
    if (!result.has(r.thread_id)) result.set(r.thread_id,{ cost: { ...empty(), partial: true }, updatedAt: 0 });
  }
  return result;
}
export function threadCosts(db: Database, threadIds: string[], includeDescendants: boolean, overrides: Overrides = {}) {
  const edges = tree(db,threadIds,includeDescendants), data = threadData(db,[...new Set(edges.map(e => e.id))],overrides);
  const roots = [...new Set(edges.map(e => e.root))], unknown = threadIds.some(id => !roots.includes(id));
  const threads = roots.map(threadId => {
    const ids = edges.filter(e => e.root===threadId).map(e => e.id);
    const costs = ids.map(id => data.get(id)?.cost).filter((c): c is Cost => !!c);
    const total = costs.length ? costs.map(c => structuredClone(c)).reduce(add) : empty(); total.partial ||= unknown;
    const own = structuredClone(data.get(threadId)?.cost ?? empty()); own.partial ||= unknown;
    return { threadId, own, total, descendantCount: ids.length-1, updatedAt: Math.max(0,...ids.map(id => data.get(id)?.updatedAt ?? 0)) };
  });
  return { priceVersion: PRICE_TABLE_VERSION, threads };
}
export function costSum(db: Database, threadIds: string[], includeDescendants: boolean, overrides: Overrides = {}) {
  const edges = tree(db,threadIds,includeDescendants), ids = [...new Set(edges.map(e => e.id))], data = threadData(db,ids,overrides);
  const costs = [...data.values()].map(d => d.cost), cost = costs.length ? costs.reduce(add) : empty();
  cost.partial ||= threadIds.some(id => !edges.some(e => e.root===id));
  return { priceVersion: PRICE_TABLE_VERSION, cost, threadCount: ids.length, updatedAt: Math.max(0,...[...data.values()].map(d => d.updatedAt)) };
}
export function topThreads(db: Database, range: Range, offset: number, limit: number, overrides: Overrides = {}, now = Date.now()) {
  const { from,to } = rangeBounds(range,now);
  const rows = db.prepare(`SELECT thread_id,provider,model,tier,band,${sums} FROM usage_hourly WHERE hour>=? AND hour<? AND thread_id!='' GROUP BY thread_id,provider,model,tier,band`).all(from,to) as (Group & { thread_id: string })[];
  const costs = new Map<string, Cost>(), price = priceContext(overrides);
  for (const r of rows) costs.set(r.thread_id,costs.has(r.thread_id) ? add(costs.get(r.thread_id)!,price(r)) : price(r));
  const ids = [...costs].sort((a,b) => (b[1].usd ?? 0)-(a[1].usd ?? 0) || a[0].localeCompare(b[0])).slice(offset,offset+limit).map(([id]) => id);
  const edges = tree(db,ids,true);
  const get = db.prepare('SELECT title,project_id,provider_id FROM threads WHERE id=?');
  const items = ids.flatMap(threadId => {
    const info = get.get(threadId) as { title: string; project_id: string; provider_id: string } | undefined;
    if (!info) return [];
    const own = costs.get(threadId) ?? empty();
    const children = edges.filter(e => e.root===threadId).map(e => costs.get(e.id)).filter((c): c is Cost => !!c);
    const total = children.length ? children.map(c => structuredClone(c)).reduce(add) : empty();
    return [{ threadId, title: info.title, projectId: info.project_id, provider: info.provider_id, own, total }];
  });
  return { items, hasMore: costs.size>offset+limit };
}
export function prices(overrides: Overrides = {}) { return { version: PRICE_TABLE_VERSION, entries: listPrices(overrides) }; }
export function status(db: Database) {
  const sources = db.prepare(`SELECT source AS id,MAX(ts) AS lastIngestAt,COUNT(*) AS rows FROM usage_raw GROUP BY source`).all() as { id: string; lastIngestAt: number | null; rows: number }[];
  const states = db.prepare('SELECT source,MAX(state) AS state FROM thread_source GROUP BY source').all() as { source: string; state: string }[];
  for (const id of ['claude-file','codex-file','local-log','agy-log','bb-events']) if (!sources.some(s => s.id===id)) sources.push({ id,lastIngestAt: null,rows: 0 });
  return { sources: sources.map(s => ({ ...s, lastError: null, state: states.find(t => t.source===s.id)?.state ?? (s.rows ? 'ok' : 'no-data') })),
    degradedThreads: (db.prepare("SELECT COUNT(*) AS n FROM thread_source WHERE state='degraded'").get() as { n: number }).n, disk: diskStats(db) };
}
type Usage = Awaited<ReturnType<PluginBbSdk['system']['usageLimits']>>;
export function limits(db: Database, usage: Usage, now: number, overrides: Overrides = {}) {
  const windows = [];
  const providers: Record<string,string> = { 'claude-code': 'claude-code', codex: 'codex', 'local-models': 'local-models', antigravity: 'antigravity' };
  for (const [provider,u] of Object.entries(usage)) {
    if (u.status !== 'ok') continue;
    for (const [i,w] of u.windows.entries()) {
      const kind = typeof w.kind==='string' ? w.kind : 'custom', model = typeof w.model==='string' ? w.model : null;
      const length = ({ 'five-hour': 5*HOUR, daily: 24*HOUR, weekly: 7*24*HOUR } as Record<string,number>)[kind];
      const reset = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
      const since = length && Number.isFinite(reset) ? Math.floor((reset-length)/HOUR)*HOUR : null;
      let byModel: { model: string; cost: Cost }[] | null = null;
      if (since !== null && providers[provider]) {
        const rows = db.prepare(`SELECT provider,model,tier,band,${sums} FROM usage_hourly WHERE provider=? AND hour>=? AND hour<=? GROUP BY model,tier,band`).all(providers[provider],since,now) as Group[];
        const grouped = new Map<string,Group[]>();
        for (const r of rows) if (!model || r.model.toLowerCase().includes(model.toLowerCase())) grouped.set(r.model,[...(grouped.get(r.model) ?? []),r]);
        if (grouped.size || !model) byModel = [...grouped].map(([model,rs]) => ({ model,cost: combine(rs,overrides) }));
      }
      windows.push({ provider,id: typeof w.id==='string' ? w.id : `${provider}:${i}`,label: w.label,kind,usedPercent: w.usedPercent,resetsAt: w.resetsAt,model,since,byModel });
    }
  }
  return { fetchedAt: now,windows };
}
