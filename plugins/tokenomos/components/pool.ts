import type { z } from "zod";
import { RUN_OUT_MARGIN, type limitsSchema, type limitWindowSchema } from "../contract";

type LimitWindow = z.infer<typeof limitWindowSchema>;
export type Account = z.infer<typeof limitsSchema>["accounts"][number];

/** Percent used from which a window's dollars per 1% count as a capacity estimate. */
const RELIABLE = 10;
const HOUR = 3_600_000;
/** How far ahead the pool is walked: four weekly refills of every subscription. */
const HORIZON = 28 * 24 * HOUR;
const RANK: Record<string, number> = { weekly: 3, daily: 2, "five-hour": 1 };

export type Outlook = { kind: "lasts"; until: number } | { kind: "runsOut"; at: number; refillAt: number | null };
export type Pool = {
  providerId: string;
  accounts: Account[];
  /** One row per window kind (and per model for model windows), shaped like a window so the same rows draw it. */
  rows: LimitWindow[];
  /** Share of the main window's pooled capacity left, and the same in API-equivalent dollars when capacities are known. */
  leftShare: number;
  leftUsd: number | null;
  /** Some capacity was borrowed from another subscription, or all of them count as equal. */
  estimated: boolean;
  outlook: Outlook | null;
  /** Id of the row the outlook is about: the longest general window. */
  mainId: string;
  /** Spend rate in API-equivalent dollars per hour, and how long what is left lasts at it with no refill. */
  ratePerHour: number | null;
  runway: number | null;
  /** The subscription to spend first: its window resets soonest, and what it still holds then is lost. */
  first: { account: Account; resetsAt: number; burnsShare: number } | null;
};

const used = (w: LimitWindow) => Math.min(100, Math.max(0, w.usedPercent)) / 100;

/**
 * Capacity of each window. Plan sizes (multipliers) set the proportions; a subscription without one counts as
 * size 1 and makes the result an estimate. Spend is known per provider, not per subscription, so one rate covers
 * the pool: the spend since the earliest window start over the plan units used. It is trusted once the pool is
 * 10% used; before that the sizes alone still give the pooled percent.
 */
export function capacities(ws: LimitWindow[], sizes: (number | null)[] = ws.map(() => null)): { caps: number[]; money: boolean; estimated: boolean } {
  const s = sizes.map((x) => x ?? 1), total = s.reduce((n, x) => n + x, 0);
  const first = ws.filter((w) => w.startsAt !== null && w.usage).sort((x, y) => x.startsAt! - y.startsAt!)[0];
  const spent = first ? first.usage!.heavy.usd + first.usage!.other.usd : 0;
  const units = ws.reduce((n, w, i) => n + used(w) * s[i]!, 0);
  const money = spent > 0 && units / total >= RELIABLE / 100;
  return { caps: s.map((x) => x * (money ? spent / units : 100)), money, estimated: sizes.some((x) => x === null) };
}

/** "pro=20, plus=1" as a map; the settings schema has validated it. */
export function parseSizes(text: string): Map<string, number> {
  return new Map(text.split(",").flatMap((p) => { const [k, v] = p.split("=").map((s) => s.trim()); return k && v ? [[k.toLowerCase(), Number(v)] as [string, number]] : []; }));
}

/** A subscription's plan size: reported by the provider, else set by the user for its plan id (or plan name). */
export function planSize(a: Account, sizes: Map<string, number>): number | null {
  if (a.multiplier) return a.multiplier;
  const keys = [a.planId, a.plan].flatMap((k) => (k ? [k.toLowerCase(), k.toLowerCase().replace(/\s+/g, "_")] : []));
  for (const k of keys) { const s = sizes.get(k); if (s) return s; }
  return null;
}

type Slot = { left: number; cap: number; resetsAt: number | null; length: number | null };

/**
 * Walks the pool forward at a steady spend rate, drawing on the subscription that resets soonest first and
 * refilling each one at its reset, for four of its windows (at most four weeks). Either the pool lasts that
 * long, or it runs out and stays empty until the next refill.
 */
export function simulate(slots: Slot[], ratePerMs: number, now: number): Outlook {
  const s = slots.map((x) => ({ ...x }));
  const resets = s.flatMap((x) => (x.resetsAt === null ? [] : [x.resetsAt]));
  const nearest = resets.length ? Math.min(...resets) : now;
  if (ratePerMs <= 0) return { kind: "lasts", until: nearest };
  const lengths = s.flatMap((x) => (x.length ? [x.length] : []));
  const horizon = now + Math.min(HORIZON, lengths.length ? 4 * Math.max(...lengths) : HORIZON);
  let t = now;
  for (let guard = 0; guard < 256; guard++) {
    const pending = s.flatMap((x) => (x.resetsAt === null || x.resetsAt <= t ? [] : [x.resetsAt]));
    const next = Math.min(pending.length ? Math.min(...pending) : Infinity, horizon);
    const left = s.reduce((n, x) => n + x.left, 0);
    if (left < ratePerMs * (next - t)) return { kind: "runsOut", at: t + left / ratePerMs, refillAt: pending.length ? Math.min(...pending) : null };
    let need = ratePerMs * (next - t);
    for (const x of [...s].sort((a, b) => (a.resetsAt ?? Infinity) - (b.resetsAt ?? Infinity))) { const take = Math.min(x.left, need); x.left -= take; need -= take; }
    t = next;
    if (t >= horizon) return { kind: "lasts", until: nearest };
    for (const x of s) if (x.resetsAt === t) { x.left = x.cap; x.resetsAt = x.length ? t + x.length : null; }
  }
  return { kind: "lasts", until: nearest };
}

/** Capacity-weighted mean of a per-window figure; null unless every window has it. */
function weighted(ws: LimitWindow[], caps: number[], pick: (w: LimitWindow) => number | null): number | null {
  const xs = ws.map(pick);
  if (xs.some((x) => x === null)) return null;
  return xs.reduce((n: number, x, i) => n + x! * caps[i]!, 0) / caps.reduce((n, c) => n + c, 0);
}

const groupKey = (w: LimitWindow) => `${w.kind === "custom" ? w.label : w.kind}|${w.model ?? ""}`;

function makePool(providerId: string, accounts: Account[], now: number, sizes: Map<string, number>): Pool | null {
  const ok = accounts.filter((a) => a.status === "ok" && a.windows.length > 0);
  if (ok.length < 2) return null;
  const groups = new Map<string, { a: Account; w: LimitWindow }[]>();
  for (const a of ok) for (const w of a.windows) groups.set(groupKey(w), [...(groups.get(groupKey(w)) ?? []), { a, w }]);
  // The pool's budget is its longest general window; model windows and shorter ones are rows of their own.
  const mainKey = [...groups.keys()].filter((k) => k.endsWith("|")).sort((x, y) => (RANK[y.split("|")[0]!] ?? 0) - (RANK[x.split("|")[0]!] ?? 0))[0];
  if (!mainKey) return null;
  let estimated = false, outlook: Outlook | null = null, first: Pool["first"] = null, leftShare = 1, leftUsd: number | null = null, ratePerHour: number | null = null;
  const rows = [...groups].map(([key, entries]) => {
    const ws = entries.map((e) => e.w), c = capacities(ws, entries.map((e) => planSize(e.a, sizes))), total = c.caps.reduce((n, x) => n + x, 0);
    const pooled = ws.reduce((n, w, i) => n + used(w) * c.caps[i]!, 0) / total;
    const resets = ws.flatMap((w) => (w.resetsAt === null ? [] : [w.resetsAt]));
    const row: LimitWindow = {
      id: `pool:${key}`, label: ws[0]!.label, kind: ws[0]!.kind, model: ws[0]!.model, usedPercent: pooled * 100,
      resetsAt: resets.length ? Math.min(...resets) : null, startsAt: null, runsOutAt: null, usage: null,
      // The pace tick and forecast of the pool: each window's own, weighted by its capacity like the used share.
      elapsedShare: weighted(ws, c.caps, (w) => w.elapsedShare), forecastPercent: weighted(ws, c.caps, (w) => w.forecastPercent),
    };
    const main = key === mainKey;
    if (main) { estimated = c.estimated && ws.length > 1; leftShare = 1 - pooled; }
    // A row only one subscription has (a five-hour window of one plan) keeps that window's own forecast.
    if (ws.length === 1) row.runsOutAt = ws[0]!.runsOutAt;
    if (!c.money) return row;
    if (main) leftUsd = total * leftShare;
    // Spend rate: the provider's last week for long windows (as their own forecasts), else its spend over the longest-running window.
    const longest = ws.filter((w) => w.startsAt !== null && w.usage).sort((x, y) => x.startsAt! - y.startsAt!)[0];
    const elapsed = longest ? now - longest.startsAt! : 0;
    const recent = longest?.usage?.recentUsdPerHour;
    const rate = recent != null ? recent / HOUR : longest && elapsed >= HOUR ? (longest.usage!.heavy.usd + longest.usage!.other.usd) / elapsed : null;
    if (rate === null) return row;
    const slots = ws.map((w, i) => ({ left: c.caps[i]! * (1 - used(w)), cap: c.caps[i]!, resetsAt: w.resetsAt, length: w.resetsAt !== null && w.startsAt !== null ? w.resetsAt - w.startsAt : null }));
    let o = simulate(slots, rate, now);
    // The same margin as a window's forecast: a pool that lasts at a tenth less spend is not called as running out.
    if (o.kind === "runsOut") { const calm = simulate(slots, rate / (RUN_OUT_MARGIN / 100), now); if (calm.kind === "lasts") o = calm; }
    // The pool's own walk gives every row its "out in" and colour: the margin draws a limit that runs out, null a calm one.
    if (o.kind === "runsOut") { row.runsOutAt = o.at; row.forecastPercent = RUN_OUT_MARGIN; } else { row.runsOutAt = null; row.forecastPercent = null; }
    if (!main) return row;
    ratePerHour = rate * HOUR;
    outlook = o;
    const soonest = entries.map((e, i) => ({ ...e, slot: slots[i]! })).filter((e) => e.slot.left > 0 && e.slot.resetsAt !== null).sort((x, y) => x.slot.resetsAt! - y.slot.resetsAt!)[0];
    if (soonest) first = { account: soonest.a, resetsAt: soonest.slot.resetsAt!, burnsShare: Math.max(0, soonest.slot.left - rate * (soonest.slot.resetsAt! - now)) / soonest.slot.cap };
    return row;
  });
  // As providers list their windows: shortest first (5h, then weekly), model windows last.
  rows.sort((x, y) => Number(x.model !== null) - Number(y.model !== null) || (RANK[x.kind] ?? 0) - (RANK[y.kind] ?? 0));
  const runway = leftUsd !== null && ratePerHour ? (leftUsd / ratePerHour) * HOUR : null;
  return { providerId, accounts, rows, leftShare, leftUsd, estimated, outlook, mainId: `pool:${mainKey}`, ratePerHour, runway, first };
}

export const isPool = (x: Account | Pool): x is Pool => "rows" in x;

/** Accounts as shown: a provider with two or more working subscriptions becomes one pool, in the place of its first. */
export function poolAccounts(accounts: Account[], now: number, sizes: Map<string, number> = new Map()): (Account | Pool)[] {
  const byProvider = new Map<string, Account[]>();
  for (const a of accounts) byProvider.set(a.providerId, [...(byProvider.get(a.providerId) ?? []), a]);
  const out: (Account | Pool)[] = [], done = new Set<string>();
  for (const a of accounts) {
    if (done.has(a.providerId)) continue;
    const pool = makePool(a.providerId, byProvider.get(a.providerId)!, now, sizes);
    if (pool) { out.push(pool); done.add(a.providerId); } else out.push(a);
  }
  return out;
}
