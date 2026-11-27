import type { Database } from 'better-sqlite3';
import { RUN_OUT_MARGIN } from '../contract.js';
import { costUsd, type Overrides } from '../pricing/price.js';

const HOUR = 3_600_000;
/** How far back the pace of a long window looks: one full week, so busy weekdays and quiet weekends both count. */
export const RECENT = 7 * 24 * HOUR;
export const DEFAULT_HEAVY_MODELS = 'fable, opus, sol, astra, argon';

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
/** Model families named in the `heavyModels` setting, as lower-case words. */
export const parseHeavy = (setting: string) => [...new Set(words(setting))];
/** A model is heavy when one of the words of its id is a heavy family: `claude-opus-5-5`, `gpt-6.2-astra`. */
export const isHeavy = (model: string, heavy: string[]) => words(model).some(w => heavy.includes(w));

const LENGTH: Record<string, number> = { 'five-hour': 5 * HOUR, daily: 24 * HOUR, weekly: 7 * 24 * HOUR };
/** Window length from its kind; custom windows name it in the label ("5h", "7d · Argon"). */
export function windowLength(kind: string, label: string): number | null {
  if (LENGTH[kind]) return LENGTH[kind];
  const m = /^(\d+)\s*([hd])\b/i.exec(label.trim());
  return m ? Number(m[1]) * (m[2]!.toLowerCase() === 'h' ? HOUR : 24 * HOUR) : null;
}

/** Words of a window's model scope ("fable", "Gemini 4 Argon"); generic words like "models" scope nothing. */
const scopeWords = (scope: string | null) => (scope ? words(scope).filter(w => w !== 'models' && w !== 'model') : []);

type Part = { usd: number; calls: number };
export type WindowUsage = { heavy: Part; other: Part; heavyShare: number | null; usdPerPercent: number | null; partial: boolean; recentUsdPerHour?: number | null };
type SpendRow = { model: string; tier: string; band: number; fresh_in: number; cache_read: number; cache_write_short: number; cache_write_long: number; output: number; calls: number };
const SUMS = 'model,tier,band,SUM(fresh_in) fresh_in,SUM(cache_read) cache_read,SUM(cache_write_short) cache_write_short,SUM(cache_write_long) cache_write_long,SUM(output) output';
const hourly = (db: Database, provider: string, from: number, to: number) =>
  db.prepare(`SELECT ${SUMS},SUM(calls) calls FROM usage_hourly WHERE provider=? AND hour>=? AND hour<? GROUP BY model,tier,band`).all(provider, from, to) as SpendRow[];
const raw = (db: Database, provider: string, from: number, to: number) => from >= to ? []
  : db.prepare(`SELECT ${SUMS},COUNT(*) calls FROM usage_raw WHERE provider=? AND ts>=? AND ts<? GROUP BY model,tier,band`).all(provider, from, to) as SpendRow[];

/** Priced spend of some usage rows in a window's model scope, heavy vs other models. */
function priced(rows: SpendRow[], scope: string | null, heavy: string[], overrides: Overrides) {
  const only = scopeWords(scope);
  const result: WindowUsage = { heavy: { usd: 0, calls: 0 }, other: { usd: 0, calls: 0 }, heavyShare: null, usdPerPercent: null, partial: false };
  for (const r of rows) {
    const w = words(r.model);
    if (only.some(s => !w.includes(s))) continue;
    const usd = costUsd({ freshIn: r.fresh_in, cacheRead: r.cache_read, cacheWriteShort: r.cache_write_short, cacheWriteLong: r.cache_write_long, output: r.output }, r.model, r.tier, r.band, overrides);
    const part = isHeavy(r.model, heavy) ? result.heavy : result.other;
    part.usd += usd ?? 0; part.calls += r.calls; result.partial ||= usd === null;
  }
  return result;
}
const total = (u: WindowUsage) => u.heavy.usd + u.other.usd;

/**
 * API-equivalent spend of one provider since a window start, heavy vs other models. Counts usage outside bb too:
 * the subscription limit does. Hour granularity: the hour the window starts in is counted whole.
 */
export function windowUsage(db: Database, provider: string, from: number, usedPercent: number, scope: string | null, heavy: string[], overrides: Overrides): WindowUsage {
  const result = priced(hourly(db, provider, Math.floor(from / HOUR) * HOUR, Infinity), scope, heavy, overrides);
  const sum = total(result);
  // A window scoped to a heavy model (Claude's Fable week) is all heavy by definition; its share says nothing.
  if (sum > 0 && !scopeWords(scope).some(s => heavy.includes(s))) result.heavyShare = result.heavy.usd / sum;
  if (usedPercent >= 1) result.usdPerPercent = sum / usedPercent;
  return result;
}

/**
 * Spend in exactly `[from, to)`: whole hours from the rollups, the partial hours at both ends from raw records.
 * Raw records are complete from `rawFloor` on (pruning deletes only older ones), so an empty partial hour there means
 * no calls; a partial hour before it cannot be counted exactly and gives null.
 */
export function exactSpend(db: Database, provider: string, from: number, to: number, scope: string | null, heavy: string[], overrides: Overrides, rawFloor: number) {
  const first = Math.ceil(from / HOUR) * HOUR, last = Math.floor(to / HOUR) * HOUR;
  if ((first > from && from < rawFloor) || (last < to && last < rawFloor)) return null;
  const rows = first > last ? raw(db, provider, from, to) : [...raw(db, provider, from, first), ...hourly(db, provider, first, last), ...raw(db, provider, last, to)];
  const u = priced(rows, scope, heavy, overrides);
  return { usd: total(u), partial: u.partial };
}

/** Spend per hour over the last week before `asOf`, in whole hours only, divided by exactly the span they cover. */
export function recentRate(db: Database, provider: string, asOf: number, scope: string | null, heavy: string[], overrides: Overrides) {
  const first = Math.ceil((asOf - RECENT) / HOUR) * HOUR, last = Math.floor(asOf / HOUR) * HOUR;
  const u = priced(hourly(db, provider, first, last), scope, heavy, overrides);
  return { usdPerHour: total(u) / ((last - first) / HOUR), partial: u.partial };
}

/** A window's last fresh reading; `prev` is the last reading of the window before it. */
export type Reading = { startsAt: number; resetsAt: number; observedAt: number; usedPercent: number };
export type Tracked = Record<string, { last: Reading; prev?: Reading }>;
const KEEP_TRACKED = 30 * 24 * HOUR;
/** Keeps the reading; a reset at least half a window later starts a new window, and the kept reading becomes `prev`. */
export function track(t: Tracked, key: string, r: Reading, length: number, now: number) {
  const e = t[key];
  if (!e) t[key] = { last: r };
  else if (r.resetsAt - e.last.resetsAt >= length / 2) t[key] = { last: r, prev: e.last };
  else if (r.observedAt >= e.last.observedAt) e.last = r;
  for (const [k, v] of Object.entries(t)) if (now - v.last.observedAt > KEEP_TRACKED) delete t[k];
}
/**
 * The account's own average pace over the previous window, percent per ms; null unless that reading covers at least
 * half of its window (weekdays and the weekend, not a few whole percent of noise) and is the window right before this one.
 */
export function previousPace(e: Tracked[string] | undefined, startsAt: number, length: number) {
  const p = e?.prev;
  if (!p || p.observedAt - p.startsAt < length / 2 || Math.abs(p.resetsAt - startsAt) >= length / 2) return null;
  return p.usedPercent / (p.observedAt - p.startsAt);
}

/** Whether a window's own average since its start is a signal: 5% of it gone or 5 points used. */
export const steadyAt = (usedPercent: number, startsAt: number, length: number, asOf: number) =>
  asOf > startsAt && ((asOf - startsAt) / length >= 0.05 || usedPercent >= 5);

const FILE_SOURCE: Record<string, string> = { 'claude-code': 'claude-file', codex: 'codex-file', antigravity: 'agy-log' };
/**
 * Whether the provider's token history up to `asOf` is complete enough to convert spend to percent: every ingest source
 * that feeds it has reported ok (a stopped or failing source shows here; downtime alone leaves no gap, since sources are
 * re-read from their cursors), the backfill is done, and its first stored hour is at least a week back. Not provable:
 * transcripts deleted before Tokenomos read them.
 */
export function historyComplete(db: Database, provider: string, asOf: number) {
  const sources = [FILE_SOURCE[provider], 'bb-events'].filter((x): x is string => !!x), q = sources.map(() => '?').join(',');
  // Each source must have reported ok: a source with no status yet has not shown that it ingests.
  const ok = (db.prepare(`SELECT COUNT(*) n FROM source_status WHERE source IN (${q}) AND state='ok'`).get(...sources) as { n: number }).n;
  const degraded = (db.prepare(`SELECT COUNT(*) n FROM thread_source WHERE source IN (${q}) AND state='degraded'`).get(...sources) as { n: number }).n;
  let backfilled = false;
  try { backfilled = JSON.parse((db.prepare("SELECT value FROM cursor WHERE name='backfill-progress'").get() as { value: string } | undefined)?.value ?? 'null')?.done === true; }
  catch { /* unreadable: not done */ }
  const first = (db.prepare('SELECT MIN(hour) h FROM usage_hourly WHERE provider=?').get(provider) as { h: number | null }).h;
  return ok === sources.length && degraded === 0 && backfilled && first !== null && first <= asOf - RECENT;
}

/** How much observed time the previous window's pace counts for against the burn since the reset (owner decision: 2 days). */
export const PRIOR_MS = 2 * 24 * HOUR;
/**
 * Percent per ms early and through a long window: the previous window's pace weighs as PRIOR_MS of observed time, the
 * burn since the reset as the time it covers. At the reset it is last week's pace; a sustained burst gains weight as the
 * week goes on, with no switch at any threshold.
 */
export const blendedPace = (prevPace: number, usedPercent: number, elapsedMs: number) =>
  (usedPercent + prevPace * PRIOR_MS) / (Math.max(0, elapsedMs) + PRIOR_MS);

export type ForecastMethod = 'previous-window' | 'recent-spend' | 'window-average';
export type NoForecast = 'exhausted' | 'no-reset' | 'too-early' | 'no-previous-window';

/**
 * Pace of a limit window as of `asOf`, when its percent was measured: share of its time elapsed, the percent expected at
 * reset, and when 100% is reached first. With a rate (percent per ms: the last week's spend, or the previous window's own
 * pace) the forecast projects it from `asOf` as soon as the window has started. Without one it is the window's own
 * average since the start, once that is a signal. "Runs out" needs the projected use to be RUN_OUT_MARGIN of what is left.
 */
export function windowPace(usedPercent: number, resetsAt: number | null, length: number | null, asOf: number, rate: number | null = null, method: 'previous-window' | 'recent-spend' = 'recent-spend') {
  if (resetsAt === null || length === null) return { startsAt: null, elapsedShare: null, forecastPercent: null, runsOutAt: null, method: null, reason: 'no-reset' as NoForecast };
  const startsAt = resetsAt - length, elapsedShare = Math.min(1, Math.max(0, (asOf - startsAt) / length));
  // A window that has not started yet (a reset further out than its length) has no pace to project.
  const started = asOf > startsAt;
  // Under 5% of the window gone, its own average from a percent or two mostly amplifies noise.
  const steady = steadyAt(usedPercent, startsAt, length, asOf);
  const used: ForecastMethod | null = !started ? null : rate !== null ? method : steady ? 'window-average' : null;
  // An exhausted limit has nothing left to forecast.
  const forecastPercent = usedPercent >= 100 || used === null ? null
    : rate !== null ? usedPercent + rate * Math.max(0, resetsAt - asOf) : usedPercent / elapsedShare;
  let runsOutAt: number | null = null;
  if (usedPercent >= 100) runsOutAt = asOf;
  else if (forecastPercent !== null && forecastPercent - usedPercent >= (RUN_OUT_MARGIN / 100) * (100 - usedPercent)) {
    runsOutAt = rate !== null ? asOf + (100 - usedPercent) / rate : startsAt + (100 / usedPercent) * (asOf - startsAt);
  }
  const reason: NoForecast | null = forecastPercent !== null ? null : usedPercent >= 100 ? 'exhausted'
    : started && length >= RECENT ? 'no-previous-window' : 'too-early';
  return { startsAt, elapsedShare, forecastPercent, runsOutAt, method: forecastPercent === null ? null : used, reason };
}
