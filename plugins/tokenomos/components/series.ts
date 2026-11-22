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

/** A chart series. `group` is the provider a model belongs to; `title` names it outside its legend group. */
export type Slot = { id: string; color: string; label: string; title: string; group?: string; groupLabel?: string };
/** A cost with the number of calls behind it, as a bucket series carries it. */
export type CallCost = Cost & { calls: number };
export type Row = { start: number; label: string; title: string; total: number; costs: Record<string, CallCost> } & Record<string, unknown>;
// `saved`: local-model calls priced at the reference model, drawn on top of the cost bar but not in its total.
export type ChartModel = { slots: Slot[]; rows: Row[]; metric: Shown; totalCost: Record<string, CallCost>; saved: boolean };

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

/** The cost metric plots dollars when any segment is priced, otherwise tokens. */
export function resolveMetric(summary: SummaryOutput, metric: Metric): Shown {
  if (metric !== "cost") return metric;
  return summary.buckets.some((b) => Object.values(b.series).some((c) => c.usd !== null)) ? "usd" : "tokens";
}

/** Plots the chosen metric. Colors follow the provider; models are shades of their provider's color. */
export function buildChart(summary: SummaryOutput, by: By, range: Range, t: T, chosen: Metric = "cost"): ChartModel {
  const keys = [...new Set(summary.buckets.flatMap((b) => Object.keys(b.series)))];
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
    slots = [...names].sort(([a], [b]) => a - b).map(([n, label]) => ({ id: `s${n}`, color: seriesColor(n), label, title: label, group: `s${n}` }));
  } else {
    // Models stack grouped by provider (provider order as in the provider view), costliest first, the provider's rest last.
    const providers = new Map(summary.breakdown.map((b) => [b.key, b.provider]));
    const providerOf = (k: string) => providers.get(k) ?? (k.startsWith("other:") ? k.slice(6) : "");
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
      slots.push({ id: `m${i}`, color: shade(rank(group), index), label, title: k.startsWith("other:") ? `${groupLabel} · ${label}` : label, group, groupLabel });
    });
  }

  const totalCost: Record<string, CallCost> = {};
  const rows = summary.buckets.map((bucket): Row => {
    const costs: Record<string, CallCost> = {};
    for (const [k, cost] of Object.entries(bucket.series)) {
      const id = slotOf.get(k)!;
      costs[id] = addCost(costs[id] ?? zero(), cost);
      totalCost[id] = addCost(totalCost[id] ?? zero(), cost);
    }
    const row: Row = { start: bucket.start, label: bucketLabel(range, bucket.start, t), title: bucketTitle(range, bucket.start, t), total: 0, costs };
    for (const [id, cost] of Object.entries(costs)) { row[id] = value(cost); row.total += value(cost); }
    if (metric === "usd" && bucket.localSavedUsd) row.saved = bucket.localSavedUsd;
    return row;
  });
  // A series that is zero in this metric (local models in dollars) would only add an empty legend entry.
  const shown = slots.filter((s) => rows.some((r) => Number(r[s.id]) > 0));
  return { slots: shown.length ? shown : slots, rows, metric, totalCost, saved: rows.some((r) => Number(r.saved) > 0) };
}
