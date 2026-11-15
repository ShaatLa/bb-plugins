import type { Database } from 'better-sqlite3';
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
    const to = now, from = +end - (count - 1) * HOUR;
    return { from, to, previousFrom: from - (to - from), starts: Array.from({ length: count }, (_, i) => from + i * HOUR) };
  }
  end.setHours(0, 0, 0, 0); end.setDate(end.getDate() + 1);
  const starts = Array.from({ length: count }, (_, i) => { const d = new Date(end); d.setDate(d.getDate() - (count - i) * step); return +d; });
  return { from: starts[0], to: now, previousFrom: starts[0] - (now - starts[0]), starts };
}
function flags(db: Database, from: number, to: number, outside: boolean, projectId?: string) {
  return db.prepare(`SELECT COALESCE(MAX((r.flags & ?) != 0 OR c.partial = 1),0) AS partial,
    COALESCE(MAX((r.flags & ?) != 0),0) AS estimated FROM usage_raw r LEFT JOIN thread_cov c ON c.thread_id=r.thread_id
    WHERE r.ts>=? AND r.ts<? ${outside ? '' : "AND r.project_id != '~outside'"} ${projectId === undefined ? '' : 'AND r.project_id=?'}`).get(RECOVERED, ESTIMATED, from, to, ...(projectId === undefined ? [] : [projectId])) as { partial: number; estimated: number };
}
export type SummaryOptions = { range: Range; by: 'provider' | 'model'; now: number; overrides: Overrides; referenceModel: string; includeOutsideBb: boolean; projectId?: string };
export function summary(db: Database, o: SummaryOptions) {
  const { from, to, previousFrom, starts } = rangeBounds(o.range, o.now);
  const filter = `${o.includeOutsideBb ? '' : "AND project_id != '~outside'"} ${o.projectId === undefined ? '' : 'AND project_id=?'}`;
  const params = o.projectId === undefined ? [] : [o.projectId];
  type Hour = Group & { hour: number; provider: string; reasoning: number };
  const allRows = db.prepare(`SELECT hour,provider,model,tier,band,${sums},SUM(reasoning) AS reasoning FROM usage_hourly
    WHERE hour>=? AND hour<=? ${filter} GROUP BY hour,provider,model,tier,band`).all(Math.floor(previousFrom / HOUR) * HOUR,to,...params) as Hour[];
  const rows = allRows.filter(r => r.hour>=from), previousRows = allRows.filter(r => r.hour<from);
  const price = priceContext(o.overrides);
  const totals = combine(rows, o.overrides), f = flags(db, from, to + 1, o.includeOutsideBb, o.projectId);
  totals.partial ||= !!f.partial; totals.estimated ||= !!f.estimated;
  const modelCosts = new Map<string, number>();
  for (const r of rows) modelCosts.set(r.model, (modelCosts.get(r.model) ?? 0) + (price(r).usd ?? 0));
  const top = new Set([...modelCosts].sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0])).slice(0,4).map(([k]) => k));
  const key = (r: Hour) => o.by === 'provider' ? r.provider : top.has(r.model) ? r.model : 'other';
  const keys = [...new Set(rows.map(key))];
  const buckets: { start: number; series: Record<string, Cost & { calls: number }>; localSavedUsd?: number }[] = starts.map(start => ({ start, series: Object.fromEntries(keys.map(k => [k, { ...empty(), calls: 0 }])) }));
  const breakdown = new Map(keys.map(k => [k, { key: k, label: k, cost: empty(), calls: 0 }]));
  // Start accumulators at the first priced row so an entirely unknown group stays null.
  const seen = new Set<string>();
  rows.forEach(r => {
    let i = starts.length - 1; while (i > 0 && r.hour < starts[i]) i--;
    const k = key(r), c = price(r), b = breakdown.get(k)!;
    const bucket = buckets[i].series[k];
    buckets[i].series[k] = { ...(seen.has(`${i}:${k}`) ? add(bucket, c) : structuredClone(c)), calls: bucket.calls + r.calls };
    b.cost = seen.has(k) ? add(b.cost, c) : structuredClone(c); b.calls += r.calls;
    seen.add(`${i}:${k}`); seen.add(k);
    // Local calls cost $0; what the same tokens would cost on the reference model is drawn as a saving.
    if (r.provider === 'local-models') {
      const saved = price({ ...r, provider: '', model: o.referenceModel, tier: 'standard' }).usd;
      if (saved) buckets[i].localSavedUsd = (buckets[i].localSavedUsd ?? 0) + saved;
    }
  });
  const oldest = (db.prepare(`SELECT MIN(hour) AS hour FROM usage_hourly WHERE 1=1 ${filter}`).get(...params) as { hour: number | null }).hour;
  const previous = oldest === null || previousFrom < oldest ? null : combine(previousRows, o.overrides);
  if (previous) { const p = flags(db, previousFrom, from, o.includeOutsideBb, o.projectId); previous.partial ||= !!p.partial; previous.estimated ||= !!p.estimated; }
  const localRows = rows.filter(r => r.provider === 'local-models');
  const local = combine(localRows.map(r => ({ ...r, provider: '', model: o.referenceModel, tier: 'standard' })), o.overrides);
  const denominator = totals.tokens.freshIn + totals.tokens.cacheRead + totals.tokens.cacheWrite;
  const savings = compactionsInRange(db, o.range, o.overrides, o.now, o.projectId).items.map(i => i.saving);
  const compactionSavings = sumSavings(savings);
  const threadRows = db.prepare(`SELECT thread_id,provider,model,tier,band,${sums} FROM usage_hourly
    WHERE hour>=? AND hour<=? AND thread_id!='' ${filter} GROUP BY thread_id,provider,model,tier,band`).all(from,to,...params) as (Group & { thread_id: string })[];
  const threadSpend = new Map<string, Cost>();
  for (const r of threadRows) if (r.calls) threadSpend.set(r.thread_id, threadSpend.has(r.thread_id) ? add(threadSpend.get(r.thread_id)!,price(r)) : price(r));
  const spends = [...threadSpend.values()].flatMap(c => c.usd === null ? [] : [c.usd]).sort((a,b) => a-b);
  const mid = Math.floor(spends.length/2);
  const calls = rows.reduce((n,r) => n+r.calls,0);
  const tokenCount = (c: Cost) => Object.values(c.tokens).reduce((a,b) => a+b,0);
  const components = ['freshIn','cacheWrite','cacheRead','output'] as const;
  const mixRows = components.map(component => {
    let usd: number | null = rows.length ? null : 0;
    for (const r of rows) {
      const rates = ratesFor(r.model,r.tier,r.band,o.overrides);
      if (r.provider !== 'local-models' && !rates) continue;
      const value = r.provider === 'local-models' ? 0 : component === 'freshIn' ? r.fresh_in*rates!.input
        : component === 'cacheRead' ? r.cache_read*rates!.cacheRead : component === 'output' ? r.output*rates!.output
        : r.cache_write_short*rates!.cacheWriteShort+r.cache_write_long*rates!.cacheWriteLong;
      usd = (usd ?? 0)+value/1e6;
    }
    const tokens = totals.tokens[component];
    return { component, tokens, usd, usdPerMTok: tokens && usd !== null ? usd/tokens*1e6 : null };
  });
  const cells = new Map<number, { weekday: number; hour: number; usd: number | null; tokens: number; calls: number }>();
  for (const r of rows) {
    const date = new Date(r.hour), weekday = (date.getDay()+6)%7, hour = date.getHours(), key = weekday*24+hour;
    const c = price(r), old = cells.get(key);
    cells.set(key,{ weekday,hour,usd: old ? old.usd === null && c.usd === null ? null : (old.usd ?? 0)+(c.usd ?? 0) : c.usd,
      tokens: (old?.tokens ?? 0)+tokenCount(c),calls: (old?.calls ?? 0)+r.calls });
  }
  const heatCells = [...cells.values()].sort((a,b) => a.weekday-b.weekday || a.hour-b.hour);
  const busiest = [...heatCells].sort((a,b) => b.calls-a.calls || b.tokens-a.tokens || (b.usd ?? 0)-(a.usd ?? 0))[0] ?? null;
  const kpis = { spendUsd: totals.usd, spendPrevUsd: previous?.usd ?? null, tokens: tokenCount(totals), tokensPrev: previous ? tokenCount(previous) : null,
    calls, callsPrev: previous ? previousRows.reduce((n,r) => n+r.calls,0) : null, threads: threadSpend.size,
    medianThreadUsd: spends.length ? spends.length%2 ? spends[mid] : (spends[mid-1]+spends[mid])/2 : null,
    perCallUsd: calls && totals.usd !== null ? totals.usd/calls : null, cacheHitRate: denominator ? totals.tokens.cacheRead/denominator : null,
    estimated: totals.estimated, partial: totals.partial };
  return { range: o.range, from, to, buckets, totals, previous, kpis, mix: { rows: mixRows, reasoningTokens: rows.reduce((n,r) => n+r.reasoning,0) }, heatmap: { cells: heatCells, busiest }, cacheReadShare: denominator ? totals.tokens.cacheRead / denominator : null,
    breakdown: [...breakdown.values()].sort((a,b) => (b.cost.usd ?? 0)-(a.cost.usd ?? 0)), compactionSavings,
    localSavings: { usd: local.usd, tokens: Object.values(local.tokens).reduce((a,b) => a+b,0), partial: local.partial, excludesOwnCost: false, referenceModel: o.referenceModel } };
}

export type Compaction = { before_tokens: number; after_tokens: number; own_cost_known: number; before_known: number; after_known: number };
export type Effect = { model: string; tier: string; band: number; calls_hit: number; calls_miss: number; calls_cross: number; first_gap_hit: number; overhead_fresh_in: number; overhead_cache_read: number; overhead_cache_write: number; overhead_output: number };
export function compactionEstimate(effects: Effect[], c: Compaction, overrides: Overrides = {}): Saving {
  if (!c.before_known || !c.after_known) return { usd: null, tokens: 0, partial: true, excludesOwnCost: !c.own_cost_known };
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
export function compactionsInRange(db: Database, range: Range, overrides: Overrides = {}, now = Date.now(), projectId?: string) {
  const { from, to } = rangeBounds(range, now);
  type Row = Compaction & { id: string; thread_id: string; title: string; at: number; origin: 'bb' | 'idle-compact' };
  const rows = db.prepare(`SELECT c.*,COALESCE(t.title,'') AS title FROM compactions c LEFT JOIN threads t ON t.id=c.thread_id
    WHERE c.at>=? AND c.at<=? ${projectId === undefined ? '' : 'AND t.project_id=?'} ORDER BY c.at DESC`).all(from,to,...(projectId === undefined ? [] : [projectId])) as Row[];
  const effects = db.prepare(`SELECT e.* FROM compaction_effect e JOIN compactions c ON c.id=e.compaction_id
    LEFT JOIN threads t ON t.id=c.thread_id WHERE c.at>=? AND c.at<=? ${projectId === undefined ? '' : 'AND t.project_id=?'}`)
    .all(from,to,...(projectId === undefined ? [] : [projectId])) as (Effect & { compaction_id: string })[];
  const grouped = new Map<string, Effect[]>();
  for (const e of effects) { const list = grouped.get(e.compaction_id) ?? []; list.push(e); grouped.set(e.compaction_id,list); }
  return { items: rows.map(c => ({ id: c.id, threadId: c.thread_id, title: c.title, at: c.at, beforeTokens: c.before_tokens, afterTokens: c.after_tokens, origin: c.origin, saving: compactionEstimate(grouped.get(c.id) ?? [],c,overrides) })) };
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
  const byRoot = new Map<string, string[]>();
  for (const e of edges) { const ids = byRoot.get(e.root); if (ids) ids.push(e.id); else byRoot.set(e.root, [e.id]); }
  const unknown = threadIds.some(id => !byRoot.has(id));
  const threads = [...byRoot].map(([threadId, ids]) => {
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
  const roots = new Set(edges.map(e => e.root));
  cost.partial ||= threadIds.some(id => !roots.has(id));
  return { priceVersion: PRICE_TABLE_VERSION, cost, threadCount: ids.length, updatedAt: Math.max(0,...[...data.values()].map(d => d.updatedAt)) };
}
export type Span = { threadId: string; from: number; to: number | null };
type Interval = [number, number];
function merge(list: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const [a, b] of [...list].sort((x, y) => x[0] - y[0])) {
    const last = out.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b); else out.push([a, b]);
  }
  return out;
}
/**
 * costs.sum limited to time windows: a call counts only inside its thread's spans (a descendant
 * uses the union of its roots' spans). Whole hours come from hourly rollups; an hour cut by a span
 * edge is counted per call while raw rows are kept, and whole (marking the result estimated) after.
 */
export function costSumSpans(db: Database, spans: Span[], includeDescendants: boolean, o: { overrides?: Overrides; now: number; rawRetentionDays: number; rollupRetentionDays: number }) {
  const rootSpans = new Map<string, Interval[]>();
  for (const s of spans) {
    const to = Math.min(s.to ?? o.now, o.now);
    const list = rootSpans.get(s.threadId) ?? [];
    if (to > s.from) list.push([s.from, to]);
    rootSpans.set(s.threadId, list);
  }
  const edges = tree(db, [...rootSpans.keys()], includeDescendants);
  const perThread = new Map<string, Interval[]>();
  for (const e of edges) perThread.set(e.id, [...(perThread.get(e.id) ?? []), ...rootSpans.get(e.root)!]);
  const rawFloor = Math.ceil((o.now - o.rawRetentionDays * 86_400_000) / HOUR) * HOUR, rollupFloor = o.now - o.rollupRetentionDays * 86_400_000;
  const groupCols = `provider,model,tier,band,SUM(fresh_in) AS fresh_in,SUM(cache_read) AS cache_read,SUM(cache_write_short) AS cache_write_short,SUM(cache_write_long) AS cache_write_long,SUM(output) AS output`;
  const rawStmt = db.prepare(`SELECT ${groupCols},COUNT(*) AS calls,MAX(ts) AS last FROM usage_raw WHERE thread_id=? AND ts>=? AND ts<? GROUP BY provider,model,tier,band`);
  const hourStmt = db.prepare(`SELECT ${groupCols},SUM(calls) AS calls,MAX(hour) AS last FROM usage_hourly WHERE thread_id=? AND hour>=? AND hour<? GROUP BY provider,model,tier,band`);
  const price = priceContext(o.overrides ?? {});
  let cost = empty(), updatedAt = 0;
  const counted = new Set<string>();
  const roots = new Set(edges.map(e => e.root));
  cost.partial = [...rootSpans.keys()].some(id => !roots.has(id));
  for (const [threadId, list] of perThread) {
    const intervals = merge(list), hours: Interval[] = [];
    const rows: (Group & { last: number })[] = [];
    for (const [a, b] of intervals) {
      if (a < rollupFloor) cost.partial = true;
      // Whole hours come from the hourly rollup; only the cut hours at the edges need per-call rows.
      const A = Math.ceil(a / HOUR) * HOUR, B = Math.floor(b / HOUR) * HOUR;
      if (A < B) hours.push([A, B]);
      const edges: Interval[] = A > B ? [[a, b]] : [[a, A], [B, b]];
      for (const [x, y] of edges) {
        if (x >= y) continue;
        const h = Math.floor(x / HOUR) * HOUR;
        if (h >= rawFloor) rows.push(...rawStmt.all(threadId, x, y) as (Group & { last: number })[]);
        else { hours.push([h, h + HOUR]); cost.estimated = true; }
      }
    }
    // Expanded hours of neighbouring spans may meet; merge so each hour counts once.
    for (const [h0, h1] of merge(hours)) rows.push(...hourStmt.all(threadId, h0, h1) as (Group & { last: number })[]);
    for (const r of rows) {
      if (!r.calls) continue;
      counted.add(threadId); cost = add(cost, price(r)); updatedAt = Math.max(updatedAt, r.last);
    }
  }
  const cov = db.prepare('SELECT 1 FROM thread_cov WHERE partial=1 AND thread_id IN (SELECT value FROM json_each(?)) LIMIT 1').get(JSON.stringify([...counted]));
  if (cov) cost.partial = true;
  return { priceVersion: PRICE_TABLE_VERSION, cost, threadCount: counted.size, updatedAt };
}
export function topThreads(db: Database, range: Range, offset: number, limit: number, overrides: Overrides = {}, now = Date.now(), projectId?: string, projectNames = new Map<string,string>()) {
  const { from,to } = rangeBounds(range,now);
  const rows = db.prepare(`SELECT thread_id,provider,model,tier,band,${sums} FROM usage_hourly WHERE hour>=? AND hour<=? AND thread_id!=''
    ${projectId === undefined ? '' : 'AND project_id=?'} GROUP BY thread_id,provider,model,tier,band`).all(from,to,...(projectId === undefined ? [] : [projectId])) as (Group & { thread_id: string })[];
  const costs = new Map<string, Cost>(), calls = new Map<string,number>(), models = new Map<string,Map<string,number>>(), price = priceContext(overrides);
  for (const r of rows) {
    costs.set(r.thread_id,costs.has(r.thread_id) ? add(costs.get(r.thread_id)!,price(r)) : price(r));
    calls.set(r.thread_id,(calls.get(r.thread_id) ?? 0)+r.calls);
    const m = models.get(r.thread_id) ?? new Map<string,number>();
    m.set(r.model,(m.get(r.model) ?? 0)+r.calls); models.set(r.thread_id,m);
  }
  const ids = [...costs].sort((a,b) => (b[1].usd ?? 0)-(a[1].usd ?? 0) || a[0].localeCompare(b[0])).slice(offset,offset+limit).map(([id]) => id);
  const lifetime = new Map(threadCosts(db,ids,true,overrides).threads.map(t => [t.threadId,t]));
  const info = db.prepare('SELECT id,title,project_id,provider_id FROM threads WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids)) as { id: string; title: string; project_id: string; provider_id: string }[];
  const items = ids.flatMap(threadId => {
    const t = info.find(t => t.id===threadId), all = lifetime.get(threadId);
    if (!t || !all) return [];
    const rangeCost = costs.get(threadId)!;
    return [{ threadId, title: t.title, projectId: t.project_id, provider: t.provider_id, own: all.own, total: all.total,
      calls: calls.get(threadId)!, tokens: Object.values(rangeCost.tokens).reduce((a,b) => a+b,0), rangeCost,
      model: [...models.get(threadId)!].sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0]))[0][0],
      projectName: projectNames.get(t.project_id) ?? null, childCount: all.descendantCount }];
  });
  return { items, hasMore: costs.size>offset+limit };
}
export function prices(overrides: Overrides = {}) { return { version: PRICE_TABLE_VERSION, entries: listPrices(overrides) }; }
export function status(db: Database) {
  const sources = db.prepare(`SELECT source AS id,MAX(ts) AS lastIngestAt,COUNT(*) AS rows FROM usage_raw GROUP BY source`).all() as { id: string; lastIngestAt: number | null; rows: number }[];
  const states = db.prepare('SELECT source,MAX(state) AS state FROM thread_source GROUP BY source').all() as { source: string; state: string }[];
  for (const id of ['claude-file','codex-file','local-log','agy-log','bb-events']) if (!sources.some(s => s.id===id)) sources.push({ id,lastIngestAt: null,rows: 0 });
  const health = db.prepare('SELECT source,last_ingest_at,last_error,state FROM source_status').all() as { source: string; last_ingest_at: number | null; last_error: string | null; state: string }[];
  const saved = db.prepare("SELECT value FROM cursor WHERE name='backfill-progress'").get() as {value:string}|undefined;
  const backfill = saved ? JSON.parse(saved.value) as {processedThreads:number;totalThreads:number;done:boolean;startedAt:number|null} : {processedThreads:0,totalThreads:0,done:false,startedAt:null};
  return { backfill, sources: sources.map(s => { const h = health.find(h => h.source === s.id); return { ...s, lastIngestAt: h?.last_ingest_at ?? s.lastIngestAt, lastError: h?.last_error ?? null, state: h?.state ?? states.find(t => t.source===s.id)?.state ?? (s.rows ? 'ok' : 'no-data') }; }),
    degradedThreads: (db.prepare("SELECT COUNT(*) AS n FROM thread_source WHERE state='degraded'").get() as { n: number }).n, disk: diskStats(db) };
}
