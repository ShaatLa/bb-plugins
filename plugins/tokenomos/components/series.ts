import type { Cost, Range } from "../contract";
import type { SummaryOutput } from "./types";
import { bucketLabel, bucketTitle, providerName, totalTokens, type By, type Metric, type Shown } from "./format";
import type { T } from "./i18n";

/** Chart slots map to the host tokens --chart-1..5. Slot 5 collects everything else. */
export const OTHER_SLOT = 5;
const PROVIDER_SLOT: Record<string, number> = { "claude-code": 1, codex: 2, "local-models": 3, antigravity: 4 };

export type Slot = { id: string; n: number; label: string };
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

/** Plots the chosen metric. Colors follow the provider, or the model's rank. */
export function buildChart(summary: SummaryOutput, by: By, range: Range, t: T, chosen: Metric = "cost"): ChartModel {
  const keys = [...new Set(summary.buckets.flatMap((b) => Object.keys(b.series)))];
  const labels = new Map(summary.breakdown.map((b) => [b.key, b.label]));
  const metric = resolveMetric(summary, chosen);
  const value = (c: CallCost) => (metric === "usd" ? (c.usd ?? 0) : metric === "calls" ? c.calls : totalTokens(c.tokens));

  const slotOf = new Map<string, number>();
  const names = new Map<number, string>();
  if (by === "provider") {
    for (const k of keys) {
      const n = PROVIDER_SLOT[k] ?? OTHER_SLOT;
      slotOf.set(k, n);
      names.set(n, n === OTHER_SLOT ? t("series.other") : providerName(k, t));
    }
  } else {
    const weight = (k: string) => summary.buckets.reduce((sum, b) => sum + (b.series[k] ? value(b.series[k]) : 0), 0);
    keys.sort((a, b) => weight(b) - weight(a));
    keys.forEach((k, i) => {
      const n = i < 4 ? i + 1 : OTHER_SLOT;
      slotOf.set(k, n);
      if (n !== OTHER_SLOT) names.set(n, labels.get(k) ?? k);
    });
    if ([...slotOf.values()].includes(OTHER_SLOT)) names.set(OTHER_SLOT, t("series.others"));
  }

  const slots = [...names].sort(([a], [b]) => a - b).map(([n, label]) => ({ id: `s${n}`, n, label }));
  const totalCost: Record<string, CallCost> = {};
  const rows = summary.buckets.map((bucket): Row => {
    const costs: Record<string, CallCost> = {};
    for (const [k, cost] of Object.entries(bucket.series)) {
      const id = `s${slotOf.get(k)}`;
      costs[id] = addCost(costs[id] ?? zero(), cost);
      totalCost[id] = addCost(totalCost[id] ?? zero(), cost);
    }
    const row: Row = { start: bucket.start, label: bucketLabel(range, bucket.start, t), title: bucketTitle(range, bucket.start, t), total: 0, costs };
    for (const [id, cost] of Object.entries(costs)) { row[id] = value(cost); row.total += value(cost); }
    if (metric === "usd" && bucket.localSavedUsd) row.saved = bucket.localSavedUsd;
    return row;
  });
  return { slots, rows, metric, totalCost, saved: rows.some((r) => Number(r.saved) > 0) };
}
