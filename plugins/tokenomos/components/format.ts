import type { Cost, Range, Saving } from "../contract";

export type Tokens = Cost["tokens"];

export const totalTokens = (t: Tokens) => t.freshIn + t.cacheRead + t.cacheWrite + t.output;

/** 1.2M / 340K / 950; one decimal below 100 of a unit, none above. */
export function fmtTokens(n: number): string {
  const abs = Math.abs(n);
  const unit = (v: number, suffix: string) => `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10}${suffix}`;
  if (abs >= 1e9) return unit(n / 1e9, "B");
  if (abs >= 1e6) return unit(n / 1e6, "M");
  if (abs >= 1e3) return unit(n / 1e3, "K");
  return String(Math.round(n));
}

/** Two decimals, four below one cent. */
export function fmtUsd(n: number): string {
  const abs = Math.abs(n);
  const digits = abs > 0 && abs < 0.01 ? 4 : 2;
  const text = abs.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${n < 0 ? "−" : ""}$${text}`;
}

/** "~$12.40" for estimated or partial money, "$12.40" otherwise; null when there is no price. */
export function fmtCost(cost: Pick<Cost, "usd" | "estimated" | "partial">): string | null {
  if (cost.usd === null) return null;
  return `${cost.estimated || cost.partial ? "~" : ""}${fmtUsd(cost.usd)}`;
}

/** Savings are always estimates; a negative net is a cost and keeps its sign. */
export function fmtSaving(saving: Pick<Saving, "usd">): string | null {
  if (saving.usd === null) return null;
  return `${saving.usd < 0 ? "−" : ""}~${fmtUsd(Math.abs(saving.usd))}`;
}

export const fmtPercent = (fraction: number) => `${Math.round(fraction * 100)} %`;

export function fmtBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} ГБ`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} МБ`;
  return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const ddmm = (d: Date) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
const weekday = (d: Date) => d.toLocaleDateString("ru-RU", { weekday: "short" });

/** «сброс в 14:30» within a day, «через 2 д» beyond; null when unknown. */
export function fmtReset(iso: string | null, now = Date.now()): string | null {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return null;
  const ms = at - now, day = 86_400_000;
  if (ms < day) return ms <= 0 ? "сброс сейчас" : `сброс в ${hhmm(new Date(at))}`;
  return `через ${Math.round(ms / day)} д`;
}

/** Axis label: hours for a day, weekday for a week, date otherwise. */
export function bucketLabel(range: Range, start: number): string {
  const d = new Date(start);
  if (range === "day") return `${pad(d.getHours())}:00`;
  if (range === "week") return weekday(d);
  return ddmm(d);
}

/** Tooltip and table label for the same bucket. */
export function bucketTitle(range: Range, start: number): string {
  const d = new Date(start);
  if (range === "day") return `${ddmm(d)} ${pad(d.getHours())}:00`;
  if (range === "week") return `${weekday(d)}, ${ddmm(d)}`;
  if (range === "month") return ddmm(d);
  return `нед. с ${ddmm(d)}`;
}

export const fmtWhen = (ms: number) => `${ddmm(new Date(ms))} ${hhmm(new Date(ms))}`;

export const PROVIDER_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "local-models": "Локальные модели",
  antigravity: "Antigravity",
};
export const providerName = (id: string) => PROVIDER_NAMES[id] ?? id;

export const RANGE_SEGMENTS = ["day", "week", "month", "3m"] as const;
export const RANGE_LABELS: Record<Range, string> = { day: "День", week: "Неделя", month: "Месяц", "3m": "3 месяца" };
export type By = "provider" | "model";

/** subPath `week/model` ↔ { range, by }; anything unknown falls back to week/provider. */
export function parseSubPath(subPath: string): { range: Range; by: By } {
  const [r, b] = subPath.split("/").map(decodeURIComponent);
  return { range: (RANGE_SEGMENTS as readonly string[]).includes(r) ? (r as Range) : "week", by: b === "model" ? "model" : "provider" };
}
export const toSubPath = (range: Range, by: By) => `${range}/${by}`;
