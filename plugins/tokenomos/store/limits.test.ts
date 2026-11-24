import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS } from './schema.js';
import { createStore } from './write.js';
import type { UsageRow } from '../contract.js';
import { isHeavy, parseHeavy, windowLength, windowPace, windowUsage, DEFAULT_HEAVY_MODELS } from './limits.js';

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
    expect(windowPace(50, null, 7 * DAY, now)).toEqual({ startsAt: null, elapsedShare: null, forecastPercent: null, runsOutAt: null });
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
});
