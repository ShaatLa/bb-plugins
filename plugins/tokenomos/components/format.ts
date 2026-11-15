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

/** Brand names stay as they are; only the generic provider is translated. */
const BRAND_NAMES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", antigravity: "Antigravity" };
export const providerName = (id: string, t: T) => (id === "local-models" ? t("provider.local-models") : BRAND_NAMES[id] ?? id);

export const RANGE_SEGMENTS = ["day", "week", "month", "3m"] as const;
export type By = "provider" | "model";

/** subPath `week/model` ↔ { range, by }; anything unknown falls back to week/provider. */
export function parseSubPath(subPath: string): { range: Range; by: By } {
  const [r, b] = subPath.split("/").map(decodeURIComponent);
  return { range: (RANGE_SEGMENTS as readonly string[]).includes(r) ? (r as Range) : "week", by: b === "model" ? "model" : "provider" };
}
export const toSubPath = (range: Range, by: By) => `${range}/${by}`;
