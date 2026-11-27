import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS } from './schema.js';
import { createStore } from './write.js';
import type { UsageRow } from '../contract.js';
import { blendedPace, exactSpend, PRIOR_MS, historyComplete, isHeavy, parseHeavy, previousPace, recentRate, track, windowLength, windowPace, windowUsage, DEFAULT_HEAVY_MODELS, type Tracked } from './limits.js';

const HOUR = 3_600_000, DAY = 24 * HOUR, now = +new Date(2026, 10, 18, 12);
const heavy = parseHeavy(DEFAULT_HEAVY_MODELS);
const rates = { input: 1, output: 1, cacheRead: 1, cacheWriteShort: 1, cacheWriteLong: 1 };
const overrides = { 'claude-opus-5-5': rates, 'claude-sonnet-5-5': rates, 'claude-fable-5-2': rates };
let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); for (const sql of MIGRATIONS) db.exec(sql); });
afterEach(() => db.close());
// One million fresh input tokens at $1/MTok: every row costs exactly $1.
const row = (key: string, model: string, ts = now - HOUR, extra: Partial<UsageRow> = {}): UsageRow => ({
  key, ts, threadId: 'a', projectId: 'p', provider: 'claude-code', model, tier: 'standard', tierRaw: '', promptTokens: 0, band: 0, conv: '',
  freshIn: 1_000_000, cacheRead: 0, cacheWriteShort: 0, cacheWriteLong: 0, output: 0, reasoning: 0, turnId: null, source: 'claude-file', flags: 0, ...extra,
});

describe('model classes', () => {
  it('matches heavy families by whole words of the model id', () => {
    for (const m of ['claude-opus-5-5', 'claude-fable-5-2', 'gpt-6.2-sol', 'gpt-6.2-astra', 'gemini-4-argon-medium']) expect(isHeavy(m, heavy)).toBe(true);
    for (const m of ['claude-sonnet-5-5', 'claude-haiku-5-5', 'gpt-6.1-terra', 'gpt-6.2-luna', 'gemini-3.8-flash-medium', 'console-model']) expect(isHeavy(m, heavy)).toBe(false);
    expect(parseHeavy(' Opus,,SOL ;fable ')).toEqual(['opus', 'sol', 'fable']);
  });
});

describe('limit windows', () => {
  it('derives window lengths from the kind or a custom label', () => {
    expect(windowLength('weekly', 'Weekly limit')).toBe(7 * DAY);
    expect(windowLength('five-hour', 'x')).toBe(5 * HOUR);
    expect(windowLength('custom', '7d · Argon')).toBe(7 * DAY);
    expect(windowLength('custom', '5h')).toBe(5 * HOUR);
    expect(windowLength('custom', 'Monthly credits')).toBeNull();
  });

  it('projects the percent at reset and when the limit runs out', () => {
    const resetsAt = now + 6 * DAY; // one day of seven elapsed
    expect(windowPace(10, resetsAt, 7 * DAY, now)).toMatchObject({ startsAt: now - DAY, elapsedShare: 1 / 7, runsOutAt: null });
    expect(windowPace(10, resetsAt, 7 * DAY, now).forecastPercent).toBeCloseTo(70);
    expect(windowPace(20, resetsAt, 7 * DAY, now).runsOutAt).toBe(now - DAY + 5 * DAY);
    expect(windowPace(100, resetsAt, 7 * DAY, now)).toMatchObject({ runsOutAt: now, forecastPercent: null });
    expect(windowPace(1, now + 7 * DAY - HOUR, 7 * DAY, now)).toMatchObject({ forecastPercent: null, runsOutAt: null }); // too early to tell
    // A reset further out than the window length puts its start in the future: no pace, never an infinite forecast.
    expect(windowPace(6, now + 6 * HOUR, 5 * HOUR, now)).toMatchObject({ elapsedShare: 0, forecastPercent: null, runsOutAt: null });
    // Half a week gone at 52%: 52 more points for the 48 left is within the margin, so no "runs out"; 60% (120%) is.
    expect(windowPace(52, now + 3.5 * DAY, 7 * DAY, now)).toMatchObject({ runsOutAt: null });
    expect(windowPace(60, now + 3.5 * DAY, 7 * DAY, now).runsOutAt).not.toBeNull();
    // The last week's pace of 10% a day, not the 120% the front-loaded half week projects: 95% at the reset.
    expect(windowPace(60, now + 3.5 * DAY, 7 * DAY, now, 10 / DAY)).toMatchObject({ runsOutAt: null });
    expect(windowPace(60, now + 3.5 * DAY, 7 * DAY, now, 10 / DAY).forecastPercent).toBeCloseTo(95);
    expect(windowPace(60, now + 3.5 * DAY, 7 * DAY, now, 20 / DAY)).toMatchObject({ runsOutAt: now + 2 * DAY });
    // Nearly exhausted, the margin is on what is left: 99% with 8 points to come runs out.
    expect(windowPace(99, now + 14 * HOUR, 7 * DAY, now, 0.6 / HOUR).runsOutAt).toBeCloseTo(now + HOUR / 0.6);
    // A fresh week already 10% used (after 4 h) is a burst worth a forecast, not noise.
    expect(windowPace(10, now + 7 * DAY - 4 * HOUR, 7 * DAY, now)).toMatchObject({ runsOutAt: now - 4 * HOUR + 40 * HOUR });
    expect(windowPace(50, null, 7 * DAY, now)).toEqual({ startsAt: null, elapsedShare: null, forecastPercent: null, runsOutAt: null, method: null, reason: 'no-reset' });
  });

  it('splits the window spend into heavy and other models and prices one percent', () => {
    createStore(db).applyRows([
      row('o1', 'claude-opus-5-5'), row('o2', 'claude-opus-5-5'), row('s', 'claude-sonnet-5-5'), row('f', 'claude-fable-5-2'),
      row('old', 'claude-opus-5-5', now - 3 * DAY), row('cx', 'gpt-6.2-sol', now - HOUR, { provider: 'codex' }),
    ]);
    const all = windowUsage(db, 'claude-code', now - DAY, 20, null, heavy, overrides);
    expect(all).toMatchObject({ heavy: { usd: 3, calls: 3 }, other: { usd: 1, calls: 1 }, partial: false });
    expect(all.heavyShare).toBeCloseTo(0.75);
    expect(all.usdPerPercent).toBeCloseTo(0.2);
    // A window scoped to a heavy model counts only that model and carries no share.
    expect(windowUsage(db, 'claude-code', now - DAY, 0, 'fable', heavy, overrides)).toMatchObject({ heavy: { usd: 1, calls: 1 }, heavyShare: null, usdPerPercent: null });
    expect(windowUsage(db, 'claude-code', now - DAY, 5, 'Claude Models', heavy, overrides).heavyShare).toBeCloseTo(0.75);
    expect(windowUsage(db, 'claude-code', now - DAY, 5, null, heavy, {}).partial).toBe(false); // the price table knows these models
  });

  it('projects the previous window\'s pace early in a long window, and says why there is no forecast', () => {
    const resetsAt = now + 7 * DAY - 0.07 * DAY; // 1% of the week gone
    expect(windowPace(0, resetsAt, 7 * DAY, now, 10 / DAY, 'previous-window')).toMatchObject({ method: 'previous-window', reason: null });
    expect(windowPace(0, resetsAt, 7 * DAY, now, 10 / DAY, 'previous-window').forecastPercent).toBeCloseTo(69.3);
    expect(windowPace(0, resetsAt, 7 * DAY, now)).toMatchObject({ forecastPercent: null, method: null, reason: 'no-previous-window' });
    expect(windowPace(1, now + 5 * HOUR - 60_000, 5 * HOUR, now)).toMatchObject({ forecastPercent: null, reason: 'too-early' });
    expect(windowPace(100, resetsAt, 7 * DAY, now)).toMatchObject({ reason: 'exhausted', runsOutAt: now });
    expect(windowPace(10, now + 6 * DAY, 7 * DAY, now)).toMatchObject({ method: 'window-average', reason: null });
  });

  it('keeps each window\'s last reading and the last one of the window before', () => {
    const L = 7 * DAY, start = now - 6 * DAY, reading = (startsAt: number, observedAt: number, usedPercent: number, jitter = 0) =>
      ({ startsAt: startsAt + jitter, resetsAt: startsAt + L + jitter, observedAt, usedPercent });
    const t: Tracked = {};
    track(t, 'k', reading(start, now - 2 * DAY, 30), L, now);
    track(t, 'k', reading(start, now - DAY, 40, 5 * 60_000), L, now); // minutes of jitter in the reset: the same window
    expect(t.k).toEqual({ last: reading(start, now - DAY, 40, 5 * 60_000) });
    track(t, 'k', reading(start + L, now + 1.5 * DAY, 1), L, now + 1.5 * DAY);
    expect(t.k!.prev).toEqual(reading(start, now - DAY, 40, 5 * 60_000));
    // 40% over the 5 days (less the jitter) the reading covers: 8% a day.
    expect(previousPace(t.k, start + L, L)! * DAY).toBeCloseTo(8, 1);
    // A reading from under half its window, or from two windows ago, is no pace for this one.
    expect(previousPace({ last: reading(start + L, now, 1), prev: reading(start, start + 3 * DAY, 20) }, start + L, L)).toBeNull();
    expect(previousPace({ last: reading(start + 2 * L, now, 1), prev: reading(start, now - DAY, 40) }, start + 2 * L, L)).toBeNull();
    // An unused previous window forecasts no more use.
    expect(previousPace({ last: reading(start + L, now, 1), prev: reading(start, now - DAY, 0) }, start + L, L)).toBe(0);
    // Readings unseen for 30 days are dropped.
    track(t, 'other', reading(start + 6 * L, now + 40 * DAY, 1), L, now + 40 * DAY);
    expect(Object.keys(t)).toEqual(['other']);
  });

  it('counts spend exactly up to the measurement, from raw records at the partial hours', () => {
    const startsAt = now - 3 * DAY + 20 * 60_000, asOf = now + 30 * 60_000, M = 60_000;
    createStore(db).applyRows([
      row('before-start', 'claude-opus-5-5', startsAt - M), row('after-start', 'claude-opus-5-5', startsAt + M),
      row('middle', 'claude-opus-5-5', now - DAY), row('before-asOf', 'claude-opus-5-5', asOf - M), row('after-asOf', 'claude-opus-5-5', asOf + M),
    ]);
    const rawFloor = now - 10 * DAY;
    expect(exactSpend(db, 'claude-code', startsAt, asOf, null, heavy, overrides, rawFloor)).toEqual({ usd: 3, partial: false });
    // Measured 40 minutes before `now`: a later call in the same hour does not count.
    expect(exactSpend(db, 'claude-code', startsAt, asOf - 40 * M + 2 * M, null, heavy, overrides, rawFloor)!.usd).toBe(2);
    // Start and measurement in one hour.
    expect(exactSpend(db, 'claude-code', asOf - 10 * M, asOf, null, heavy, overrides, rawFloor)!.usd).toBe(1);
    // An empty partial hour within raw retention is no calls; a start before it cannot be counted exactly.
    expect(exactSpend(db, 'claude-code', now - 5 * DAY + 20 * M, now - 4 * DAY + 20 * M, null, heavy, overrides, rawFloor)).toEqual({ usd: 0, partial: false });
    expect(exactSpend(db, 'claude-code', startsAt, asOf, null, heavy, overrides, now - DAY)).toBeNull();
  });

  it('takes the last week\'s spend rate from whole hours only', () => {
    const asOf = now + 30 * 60_000;
    createStore(db).applyRows([row('edge-old', 'claude-opus-5-5', asOf - 7 * DAY + 60_000), row('in', 'claude-opus-5-5', now - DAY), row('edge-new', 'claude-opus-5-5', asOf - 60_000)]);
    // Hours from ceil(asOf - 7d) to floor(asOf): one call in 7 days less half an hour on each end.
    expect(recentRate(db, 'claude-code', asOf, null, heavy, overrides)).toEqual({ usdPerHour: 1 / (7 * 24 - 1), partial: false });
    expect(recentRate(db, 'claude-code', asOf, null, heavy, {}).partial).toBe(false);
  });

  it('trusts the spend history only when the provider\'s sources are healthy, the backfill is done and it reaches a week back', () => {
    createStore(db).applyRows([row('old', 'claude-sonnet-5-5', now - 8 * DAY)]);
    const backfill = (done: boolean) => db.prepare("INSERT INTO cursor(name,value) VALUES ('backfill-progress',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value").run(JSON.stringify({ done }));
    db.prepare("INSERT INTO source_status(source,state) VALUES ('claude-file','ok')").run();
    expect(historyComplete(db, 'claude-code', now)).toBe(false); // backfill not done
    backfill(true);
    expect(historyComplete(db, 'claude-code', now)).toBe(false); // bb-events has not reported yet
    db.prepare("INSERT INTO source_status(source,state) VALUES ('bb-events','ok')").run();
    expect(historyComplete(db, 'claude-code', now)).toBe(true);
    expect(historyComplete(db, 'claude-code', now - 2 * DAY)).toBe(false); // under a week of history then
    expect(historyComplete(db, 'codex', now)).toBe(false); // no history for that provider
    db.prepare("UPDATE source_status SET state='degraded' WHERE source='claude-file'").run();
    expect(historyComplete(db, 'claude-code', now)).toBe(false);
    db.prepare("UPDATE source_status SET state='ok'").run();
    db.prepare("INSERT INTO thread_source(thread_id,source,state) VALUES ('t','bb-events','degraded')").run();
    expect(historyComplete(db, 'claude-code', now)).toBe(false);
  });

  it('blends the previous window\'s pace with the burn since the reset', () => {
    const prev = 10 / DAY, forecast = (used: number, elapsed: number) => used + blendedPace(prev, used, elapsed) * (7 * DAY - elapsed);
    expect(PRIOR_MS).toBe(2 * DAY);
    expect(blendedPace(prev, 0, 0)).toBe(prev); // at the reset: last week's pace
    expect(forecast(5, 2 * HOUR)).toBeCloseTo(88, 0); // 5% in 2 h: not the 420% the window average says
    expect(forecast(60, DAY)).toBeCloseTo(220, 0); // a heavy first day still shows
    expect(blendedPace(prev, 50, 100 * DAY) * DAY).toBeCloseTo((50 / 100 + 0.2) / (1 + 0.02), 2); // late: near its own average
  });
});
