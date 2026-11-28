import type { Cost, Range } from "../contract";
import type { SummaryOutput } from "./types";
import { bucketLabel, bucketTitle, providerName, totalTokens, type By, type Metric, type Shown } from "./format";
import type { T } from "./i18n";
import { seriesColor } from "./colors";

/** Provider color slots 1..5 (colors.ts); slot 1 is Claude, slot 2 Codex. Slot 5 collects everything else. */
export const OTHER_SLOT = 5;
const PROVIDER_SLOT: Record<string, number> = { "claude-code": 1, codex: 2, "local-models": 3, antigravity: 4 };
// Models of one provider are shades of its color, the costliest strongest.
const SHADES = [100, 70, 48, 32];
const shade = (n: number, i: number) => (i === 0 ? seriesColor(n) : `color-mix(in oklab, ${seriesColor(n)} ${SHADES[Math.min(i, SHADES.length - 1)]}%, var(--card))`);

/** A chart series. `group` is the provider a model belongs to; `title` names it outside its legend group; `rest` marks an "Other" bucket. */
export type Slot = { id: string; color: string; label: string; title: string; group?: string; groupLabel?: string; rest?: boolean };
/** A cost with the number of calls behind it, as a bucket series carries it. */
export type CallCost = Cost & { calls: number };
export type Row = { start: number; label: string; title: string; total: number; costs: Record<string, CallCost>; disp: Record<string, number> } & Record<string, unknown>;
// `disp`: drawn segment heights (see `spread`); the real values stay under the slot ids.
export type ChartModel = { slots: Slot[]; rows: Row[]; metric: Shown; totalCost: Record<string, CallCost> };

const zero = (): CallCost => ({ usd: null, tokens: { freshIn: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, estimated: false, partial: false, calls: 0 });
export function addCost(a: CallCost, b: CallCost): CallCost {
  return {
    calls: (a.calls ?? 0) + (b.calls ?? 0),
    usd: a.usd === null && b.usd === null ? null : (a.usd ?? 0) + (b.usd ?? 0),
    tokens: {
      freshIn: a.tokens.freshIn + b.tokens.freshIn, cacheRead: a.tokens.cacheRead + b.tokens.cacheRead,
      cacheWrite: a.tokens.cacheWrite + b.tokens.cacheWrite, output: a.tokens.output + b.tokens.output,
    },
    estimated: a.estimated || b.estimated,
    partial: a.partial || b.partial,
  };
}

/** Smallest drawn segment as a share of the tallest column: about 10 px, so a block-edge segment keeps ~5 px of fill. */
const MIN_SEGMENT = 0.035;

/**
 * Drawn heights for one column's segments: shares are compressed (value^0.6) so small segments stay visible
 * and the largest stays largest, then each non-zero segment gets at least `min`. The column keeps its true
 * total unless it is too short to hold every minimum.
 */
export function spread(values: number[], min: number, power = 0.6): number[] {
  const weight = values.map((v) => (v > 0 ? v ** power : 0));
  const count = weight.filter(Boolean).length;
  const height = Math.max(values.reduce((a, b) => a + b, 0), count * min);
  const out = values.map(() => 0), floored = new Set<number>();
  // Segments below the minimum are pinned to it; the rest share what is left by weight, until none falls below.
  for (let changed = true; changed;) {
    changed = false;
    const left = height - floored.size * min, sum = weight.reduce((s, w, i) => (floored.has(i) ? s : s + w), 0);
    weight.forEach((w, i) => {
      if (!w || floored.has(i)) return;
      out[i] = (left * w) / sum;
      if (out[i]! < min) { floored.add(i); changed = true; }
    });
  }
  floored.forEach((i) => { out[i] = min; });
  return out;
}

/** The cost metric plots dollars when any segment is priced, otherwise tokens. */
export function resolveMetric(summary: SummaryOutput, metric: Metric): Shown {
  if (metric !== "cost") return metric;
  return summary.buckets.some((b) => Object.values(b.series).some((c) => c.usd !== null)) ? "usd" : "tokens";
}

/** Plots the chosen metric. Colors follow the provider; models are shades of their provider's color. */
export function buildChart(summary: SummaryOutput, by: By, range: Range, t: T, chosen: Metric = "cost"): ChartModel {
  const providers = new Map(summary.breakdown.map((b) => [b.key, b.provider]));
  const providerOf = (k: string) => (by === "provider" ? k : providers.get(k) ?? (k.startsWith("other:") ? k.slice(6) : ""));
  // Local models have their own savings card; on this chart they would only be a sliver.
  const keys = [...new Set(summary.buckets.flatMap((b) => Object.keys(b.series)))].filter((k) => providerOf(k) !== "local-models");
  const labels = new Map(summary.breakdown.map((b) => [b.key, b.label]));
  const metric = resolveMetric(summary, chosen);
  const value = (c: CallCost) => (metric === "usd" ? (c.usd ?? 0) : metric === "calls" ? c.calls : totalTokens(c.tokens));

  const slotOf = new Map<string, string>();
  let slots: Slot[] = [];
  if (by === "provider") {
    const names = new Map<number, string>();
    for (const k of keys) {
      const n = PROVIDER_SLOT[k] ?? OTHER_SLOT;
      slotOf.set(k, `s${n}`);
      names.set(n, n === OTHER_SLOT ? t("series.other") : providerName(k, t));
    }
    // Each provider is its own block; no group label, so the legend lists providers flat.
    slots = [...names].sort(([a], [b]) => a - b).map(([n, label]) => ({ id: `s${n}`, color: seriesColor(n), label, title: label, group: `s${n}`, rest: n === OTHER_SLOT }));
  } else {
    // Models stack grouped by provider (provider order as in the provider view), costliest first, the provider's rest last.
    const weight = (k: string) => summary.buckets.reduce((sum, b) => sum + (b.series[k] ? value(b.series[k]) : 0), 0);
    const rank = (p: string) => PROVIDER_SLOT[p] ?? OTHER_SLOT;
    keys.sort((a, b) => rank(providerOf(a)) - rank(providerOf(b)) || providerOf(a).localeCompare(providerOf(b))
      || Number(a.startsWith("other:")) - Number(b.startsWith("other:")) || weight(b) - weight(a));
    const seen = new Map<string, number>();
    keys.forEach((k, i) => {
      const group = providerOf(k), index = seen.get(group) ?? 0, groupLabel = group ? providerName(group, t) : t("series.other");
      seen.set(group, index + 1);
      const label = k.startsWith("other:") ? t("series.other") : labels.get(k) ?? k;
      slotOf.set(k, `m${i}`);
      slots.push({ id: `m${i}`, color: shade(rank(group), index), label, title: k.startsWith("other:") ? `${groupLabel} · ${label}` : label, group, groupLabel, rest: k.startsWith("other:") });
    });
  }

  const totalCost: Record<string, CallCost> = {};
  const rows = summary.buckets.map((bucket): Row => {
    const costs: Record<string, CallCost> = {};
    for (const [k, cost] of Object.entries(bucket.series)) {
      const id = slotOf.get(k);
      if (!id) continue;
      costs[id] = addCost(costs[id] ?? zero(), cost);
      totalCost[id] = addCost(totalCost[id] ?? zero(), cost);
    }
    const row: Row = { start: bucket.start, label: bucketLabel(range, bucket.start, t), title: bucketTitle(range, bucket.start, t), total: 0, costs, disp: {} };
    for (const [id, cost] of Object.entries(costs)) { row[id] = value(cost); row.total += value(cost); }
    return row;
  });
  const min = Math.max(0, ...rows.map((r) => r.total)) * MIN_SEGMENT;
  for (const row of rows) {
    const heights = spread(slots.map((s) => Number(row[s.id] ?? 0)), min);
    row.disp = Object.fromEntries(slots.map((s, i) => [s.id, heights[i]!]));
  }
  // A series that is zero in this metric would only add an empty legend entry.
  const shown = slots.filter((s) => rows.some((r) => Number(r[s.id]) > 0));
  return { slots: shown.length ? shown : slots, rows, metric, totalCost };
}

/**
 * A column's series for its hover card, largest first by the column's own values: providers by their total, the models
 * of each provider by value, each "Other" bucket last in its list. Provider series form one flat list. Ties keep the stack order.
 */
export function tipOrder(model: ChartModel, row: Row): Slot[] {
  const v = (s: Slot) => Number(row[s.id]);
  const lists = new Map<string | undefined, Slot[]>();
  for (const s of model.slots) {
    if (!row.costs[s.id] || !(v(s) > 0)) continue;
    const key = s.groupLabel === undefined ? undefined : s.group;
    lists.set(key, [...(lists.get(key) ?? []), s]);
  }
  const sum = (l: Slot[]) => l.reduce((n, s) => n + v(s), 0);
  return [...lists.values()].map((l) => l.sort((a, b) => Number(!!a.rest) - Number(!!b.rest) || v(b) - v(a))).sort((a, b) => sum(b) - sum(a)).flat();
}
