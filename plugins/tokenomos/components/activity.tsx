import { useRef, useState } from "react";
import type { Range } from "../contract";
import { fmtMetric, fmtTokens, fmtUsd, hourLabel, weekdayName, type Metric, type Shown } from "./format";
import { seriesColor } from "./colors";
import { useT, type T } from "./i18n";
import { Card, Muted } from "./shared";
import type { SummaryOutput } from "./types";

type Cell = SummaryOutput["heatmap"]["cells"][number];
const LEVELS = 5;
// Tint steps of the one sequential hue over the card surface, light to strong; step 0 is "no activity".
const TINT = [14, 32, 50, 70, 92];

const valueOf = (c: Cell, m: Shown) => (m === "usd" ? (c.usd ?? 0) : m === "calls" ? c.calls : c.tokens);
const level = (v: number, max: number) => (v <= 0 || max <= 0 ? -1 : Math.min(LEVELS - 1, Math.floor(Math.sqrt(v / max) * LEVELS - 1e-9)));
const tint = (lv: number) => (lv < 0 ? "var(--muted)" : `color-mix(in oklab, ${seriesColor(1)} ${TINT[lv]}%, transparent)`);

function describe(c: Cell, t: T, estimated: boolean) {
  const money = c.usd === null ? t("noPrice") : `${estimated ? "~" : ""}${fmtUsd(c.usd, t)}`;
  return `${money} · ${t("tokShort", { value: fmtTokens(c.tokens, t) })} · ${t("calls.count", { n: c.calls })}`;
}

/** Weekday × hour grid in one hue: tint = the chosen metric relative to the busiest cell. */
export function ActivityHeatmap({ summary, metric, range }: { summary: SummaryOutput; metric: Metric; range: Range }) {
  const t = useT();
  const [hover, setHover] = useState<{ cell: Cell | null; weekday: number; hour: number; left: number; top: number } | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const { cells } = summary.heatmap;
  const estimated = summary.kpis.estimated || summary.kpis.partial;
  const shown: Shown = metric === "cost" ? (cells.some((c) => c.usd !== null) ? "usd" : "tokens") : metric;
  const byKey = new Map(cells.map((c) => [c.weekday * 24 + c.hour, c]));
  const max = Math.max(0, ...cells.map((c) => valueOf(c, shown)));
  const busiest = cells.reduce<Cell | null>((best, c) => (valueOf(c, shown) > (best ? valueOf(best, shown) : 0) ? c : best), null);
  // A single day only has one weekday, so only that row is drawn.
  const days = range === "day" ? [cells[0]?.weekday ?? (new Date().getDay() + 6) % 7] : [0, 1, 2, 3, 4, 5, 6];
  const show = (weekday: number, hour: number, el: HTMLElement) => setHover({ cell: byKey.get(weekday * 24 + hour) ?? null, weekday, hour, left: el.offsetLeft + el.offsetWidth / 2, top: el.offsetTop });
  const money = (v: number) => (shown === "usd" ? `${estimated ? "~" : ""}${fmtMetric(shown, v, t)}` : shown === "calls" ? t("calls.count", { n: v }) : fmtMetric(shown, v, t));
  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h2 className="text-sm font-medium text-foreground">{t("activity.title")}</h2>
        {busiest && <span className="text-xs text-muted-foreground tabular-nums">{t("activity.busiest", { when: `${weekdayName(busiest.weekday, t)} ${hourLabel(busiest.hour)}`, value: money(valueOf(busiest, shown)) })}</span>}
      </div>
      {!busiest ? <Muted>{t("chart.empty")}</Muted> : (
        <>
          <div ref={grid} role="grid" aria-label={t("activity.aria")} className="relative grid grid-cols-[2rem_repeat(24,minmax(0,1fr))] items-center gap-0.5" onPointerLeave={() => setHover(null)}>
            <span />
            {Array.from({ length: 24 }, (_, h) => <span key={h} aria-hidden className="text-center text-[10px] leading-none text-muted-foreground tabular-nums">{h % 3 === 0 ? String(h).padStart(2, "0") : ""}</span>)}
            {days.map((wd) => (
              <div key={wd} role="row" className="contents">
                <span className="pr-1 text-xs text-muted-foreground">{weekdayName(wd, t)}</span>
                {Array.from({ length: 24 }, (_, h) => {
                  const cell = byKey.get(wd * 24 + h);
                  const lv = cell ? level(valueOf(cell, shown), max) : -1;
                  return (
                    <span key={h} role="gridcell" tabIndex={0} data-level={lv}
                      aria-label={`${weekdayName(wd, t)} ${hourLabel(h)}: ${cell ? describe(cell, t, estimated) : t("calls.count", { n: 0 })}`}
                      className="h-5 rounded-[2px] outline-none transition-opacity hover:opacity-80 focus-visible:ring-1 focus-visible:ring-ring"
                      style={{ background: tint(lv) }}
                      onPointerEnter={(e) => show(wd, h, e.currentTarget)} onFocus={(e) => show(wd, h, e.currentTarget)} onBlur={() => setHover(null)} />
                  );
                })}
              </div>
            ))}
            {hover && (
              <div role="tooltip" className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md" style={{ left: hover.left, top: hover.top - 4 }}>
                <div className="text-muted-foreground">{weekdayName(hover.weekday, t)} {hourLabel(hover.hour)}</div>
                <div className="tabular-nums">{hover.cell ? describe(hover.cell, t, estimated) : t("calls.count", { n: 0 })}</div>
              </div>
            )}
          </div>
          <div className="flex items-center justify-end gap-1.5 text-xs text-muted-foreground" aria-hidden>
            {t("activity.less")}
            {[-1, ...TINT.map((_, i) => i)].map((lv) => <span key={lv} className="size-2.5 rounded-[2px]" style={{ background: tint(lv) }} />)}
            {t("activity.more")}
          </div>
        </>
      )}
    </Card>
  );
}
