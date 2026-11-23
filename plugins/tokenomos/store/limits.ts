import type { Database } from 'better-sqlite3';
import { costUsd, type Overrides } from '../pricing/price.js';

const HOUR = 3_600_000;
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
export type WindowUsage = { heavy: Part; other: Part; heavyShare: number | null; usdPerPercent: number | null; partial: boolean };

/**
 * API-equivalent spend of one provider since a window start, heavy vs other models. Counts usage outside bb too:
 * the subscription limit does. Hour granularity: the hour the window starts in is counted whole.
 */
export function windowUsage(db: Database, provider: string, from: number, usedPercent: number, scope: string | null, heavy: string[], overrides: Overrides): WindowUsage {
  const rows = db.prepare(`SELECT model,tier,band,SUM(fresh_in) fresh_in,SUM(cache_read) cache_read,SUM(cache_write_short) cache_write_short,
      SUM(cache_write_long) cache_write_long,SUM(output) output,SUM(calls) calls
    FROM usage_hourly WHERE provider=? AND hour>=? GROUP BY model,tier,band`).all(provider, Math.floor(from / HOUR) * HOUR) as
    { model: string; tier: string; band: number; fresh_in: number; cache_read: number; cache_write_short: number; cache_write_long: number; output: number; calls: number }[];
  const only = scopeWords(scope);
  const result: WindowUsage = { heavy: { usd: 0, calls: 0 }, other: { usd: 0, calls: 0 }, heavyShare: null, usdPerPercent: null, partial: false };
  for (const r of rows) {
    const w = words(r.model);
    if (only.some(s => !w.includes(s))) continue;
    const usd = costUsd({ freshIn: r.fresh_in, cacheRead: r.cache_read, cacheWriteShort: r.cache_write_short, cacheWriteLong: r.cache_write_long, output: r.output }, r.model, r.tier, r.band, overrides);
    const part = isHeavy(r.model, heavy) ? result.heavy : result.other;
    part.usd += usd ?? 0; part.calls += r.calls; result.partial ||= usd === null;
  }
  const total = result.heavy.usd + result.other.usd;
  // A window scoped to a heavy model (Claude's Fable week) is all heavy by definition; its share says nothing.
  if (total > 0 && !only.some(s => heavy.includes(s))) result.heavyShare = result.heavy.usd / total;
  if (usedPercent >= 1) result.usdPerPercent = total / usedPercent;
  return result;
}

/** Pace of a limit window: share of its time elapsed, the percent expected at reset, and when 100% is reached first. */
export function windowPace(usedPercent: number, resetsAt: number | null, length: number | null, now: number) {
  if (resetsAt === null || length === null) return { startsAt: null, elapsedShare: null, forecastPercent: null, runsOutAt: null };
  const startsAt = resetsAt - length, elapsedShare = Math.min(1, Math.max(0, (now - startsAt) / length));
  // Under 5% of the window gone, a projection from a percent or two mostly amplifies noise; 5 points used is a real signal.
  // A window that has not started yet (a reset further out than its length) has no pace to project.
  const steady = now > startsAt && (elapsedShare >= 0.05 || usedPercent >= 5);
  // An exhausted limit has nothing left to forecast.
  const forecastPercent = steady && usedPercent < 100 ? usedPercent / elapsedShare : null;
  let runsOutAt: number | null = null;
  if (usedPercent >= 100) runsOutAt = now;
  else if (steady && usedPercent > 0) { const at = startsAt + (100 / usedPercent) * (now - startsAt); runsOutAt = at < resetsAt ? at : null; }
  return { startsAt, elapsedShare, forecastPercent, runsOutAt };
}
