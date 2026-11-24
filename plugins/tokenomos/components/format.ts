import type { Cost, Range, Saving } from "../contract";
import type { Key, T } from "./i18n";

export type Tokens = Cost["tokens"];

export const totalTokens = (t: Tokens) => t.freshIn + t.cacheRead + t.cacheWrite + t.output;

const formats = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>();
/** Intl formatters are costly to build, so each (kind, locale, options) is created once. */
function cached<F extends Intl.NumberFormat | Intl.DateTimeFormat>(kind: "n" | "d", locale: string, opts: object, make: () => F): F {
  const key = `${kind}|${locale}|${JSON.stringify(opts)}`;
  let f = formats.get(key) as F | undefined;
  if (!f) formats.set(key, (f = make()));
  return f;
}
const nf = (t: T, opts: Intl.NumberFormatOptions) => cached("n", t.locale, opts, () => new Intl.NumberFormat(t.locale, opts));
const df = (t: T, opts: Intl.DateTimeFormatOptions) => cached("d", t.locale, opts, () => new Intl.DateTimeFormat(t.locale, opts));

/** Locale-aware integer, e.g. 1,234 / 1 234. */
export const fmtInt = (n: number, t: T) => nf(t, { maximumFractionDigits: 0 }).format(n);

/** 1.2M / 340K / 950; one decimal below 100 of a unit, none above. */
export function fmtTokens(n: number, t: T): string {
  const abs = Math.abs(n);
  const unit = (v: number, suffix: string) => `${nf(t, { maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 1 }).format(v)}${suffix}`;
  if (abs >= 1e9) return unit(n / 1e9, "B");
  if (abs >= 1e6) return unit(n / 1e6, "M");
  if (abs >= 1e3) return unit(n / 1e3, "K");
  return fmtInt(n, t);
}

/** Two decimals, four below one cent. */
export function fmtUsd(n: number, t: T): string {
  const abs = Math.abs(n);
  const digits = abs > 0 && abs < 0.01 ? 4 : 2;
  const text = nf(t, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(abs);
  return `${n < 0 ? "−" : ""}$${text}`;
}

/** "~$12.40" for estimated or partial money, "$12.40" otherwise; null when there is no price. */
export function fmtCost(cost: Pick<Cost, "usd" | "estimated" | "partial">, t: T): string | null {
  if (cost.usd === null) return null;
  return `${cost.estimated || cost.partial ? "~" : ""}${fmtUsd(cost.usd, t)}`;
}

/** Savings are always estimates; a negative net is a cost and keeps its sign. */
export function fmtSaving(saving: Pick<Saving, "usd">, t: T): string | null {
  if (saving.usd === null) return null;
  return `${saving.usd < 0 ? "−" : ""}~${fmtUsd(Math.abs(saving.usd), t)}`;
}

export const fmtPercent = (fraction: number, t: T) => nf(t, { style: "percent", maximumFractionDigits: 0 }).format(fraction);

export function fmtBytes(bytes: number, t: T): string {
  const one = (v: number, unit: Key) => `${nf(t, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(v)} ${t(unit)}`;
  if (bytes >= 1024 ** 3) return one(bytes / 1024 ** 3, "unit.gb");
  if (bytes >= 1024 ** 2) return one(bytes / 1024 ** 2, "unit.mb");
  return `${fmtInt(Math.max(1, Math.round(bytes / 1024)), t)} ${t("unit.kb")}`;
}

const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (d: Date, t: T) => df(t, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
const ddmm = (d: Date, t: T) => df(t, { day: "2-digit", month: "2-digit" }).format(d);
const weekday = (d: Date, t: T) => df(t, { weekday: "short" }).format(d);

/** Axis label: hours for a day, weekday for a week, date otherwise. */
export function bucketLabel(range: Range, start: number, t: T): string {
  const d = new Date(start);
  if (range === "day") return `${pad(d.getHours())}:00`;
  if (range === "week") return weekday(d, t);
  return ddmm(d, t);
}

/** Tooltip and table label for the same bucket. */
export function bucketTitle(range: Range, start: number, t: T): string {
  const d = new Date(start);
  if (range === "day") return `${ddmm(d, t)} ${pad(d.getHours())}:00`;
  if (range === "week") return `${weekday(d, t)}, ${ddmm(d, t)}`;
  if (range === "month") return ddmm(d, t);
  return t("weekOf", { date: ddmm(d, t) });
}

export const fmtWhen = (ms: number, t: T) => `${ddmm(new Date(ms), t)} ${hhmm(new Date(ms), t)}`;
/** A moment with its weekday: "Sat, 11/21 11:51". */
export const fmtDay = (ms: number, t: T) => `${weekday(new Date(ms), t)}, ${fmtWhen(ms, t)}`;
/** A span in its two largest units: "3 d 15 h", "4 h 59 min", "12 min", "<1 min". */
// Providers may report a raw plan id such as "self_serve_business_pro".
export function fmtPlan(plan: string): string {
  const s = plan.replace(/[_-]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

type Account = { providerId: string; label: string; plan: string | null };
// Provider name instead of the account label (often an email); the label stays when two accounts would read the same.
export function accountName(a: Account, all: Account[], t: T): string {
  const twin = all.some((b) => b !== a && b.providerId === a.providerId && b.plan === a.plan);
  return twin ? a.label : providerName(a.providerId, t);
}

export function fmtSpan(ms: number, t: T): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000), hours = Math.floor(minutes / 60), d = Math.floor(hours / 24);
  if (minutes === 0) return t("span.lessThanMinute");
  const parts = d ? [t("span.days", { n: d }), hours % 24 ? t("span.hours", { n: hours % 24 }) : ""]
    : hours ? [t("span.hours", { n: hours }), minutes % 60 ? t("span.minutes", { n: minutes % 60 }) : ""]
    : [t("span.minutes", { n: minutes })];
  return parts.filter(Boolean).join(" ");
}

/** Brand names stay as they are; only the generic provider is translated. */
const BRAND_NAMES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", antigravity: "Antigravity" };
export const providerName = (id: string, t: T) => (id === "local-models" ? t("provider.local-models") : BRAND_NAMES[id] ?? id);

export const RANGE_SEGMENTS = ["day", "week", "month", "3m"] as const;
export type By = "provider" | "model";
/** What the chart and heatmap plot; "cost" falls back to tokens while nothing is priced. */
export type Metric = "cost" | "tokens" | "calls";
export const METRICS = ["cost", "tokens", "calls"] as const;
export type Shown = "usd" | "tokens" | "calls";

export const fmtMetric = (metric: Shown, v: number, t: T) => (metric === "usd" ? fmtUsd(v, t) : fmtTokens(v, t));

/** Signed whole-percent change "+24%" / "−5%"; null when there is nothing to compare against. */
export function pctChange(now: number, before: number | null, t: T): string | null {
  if (before === null || before <= 0) return null;
  const pct = Math.round(((now - before) / before) * 100);
  return `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${fmtPercent(Math.abs(pct) / 100, t)}`;
}

/** Monday-first weekday index (as the server counts it) → short local name. 2024-01-01 is a Monday. */
export const weekdayName = (index: number, t: T) => weekday(new Date(2024, 0, 1 + index), t);
export const hourLabel = (hour: number) => `${pad(hour)}:00`;

/** subPath `week/model/<projectId>` ↔ { range, by, project }; anything unknown falls back to week/provider, all projects. */
/** The view in the URL; a range or grouping missing from it falls back to the given defaults. */
export function parseSubPath(subPath: string, defaultBy: By = "provider", defaultRange: Range = "week"): { range: Range; by: By; project?: string } {
  const [r, b, p] = subPath.split("/").map((part) => { try { return decodeURIComponent(part); } catch { return part; } });
  const by: By = b === "model" || b === "provider" ? b : defaultBy;
  return { range: (RANGE_SEGMENTS as readonly string[]).includes(r!) ? (r as Range) : defaultRange, by, project: p || undefined };
}
export const toSubPath = (range: Range, by: By, project?: string) => `${range}/${by}${project ? `/${encodeURIComponent(project)}` : ""}`;
