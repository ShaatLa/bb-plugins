import { useEffect, useMemo, useRef, useState } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import type { Range } from "../contract";
import { ChartContainer, type ChartConfig } from "./ui/chart";
import { Button } from "./ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { cn } from "../lib/utils";
import { fmtCost, fmtInt, fmtMetric, fmtTokens, fmtUsd, totalTokens, type By, type Metric, type Shown } from "./format";
import { buildChart, tipOrder, type ChartModel, type Row, type Slot } from "./series";
import { useT, type T } from "./i18n";
import { Card, Muted } from "./shared";
import type { SummaryOutput } from "./types";

// Whole dollars on the money axis: "$1.2K" reads like a token count.
const axisTick = (metric: Shown, v: number, t: T) => (metric !== "usd" ? fmtTokens(v, t) : v < 10 ? fmtUsd(v, t).replace(/\.00$/, "") : `$${fmtInt(v, t)}`);
const tipValue = (metric: Shown, v: number, t: T) => (metric === "usd" ? fmtUsd(v, t) : metric === "calls" ? t("calls.count", { n: v }) : t("chart.tokensValue", { n: fmtTokens(v, t) }));
const unitLabel = (metric: Shown, t: T) => (metric === "usd" ? "~$" : metric === "calls" ? t("chart.unitCalls") : t("chart.unitTokens"));
const heading = (metric: Shown, t: T) => t(metric === "usd" ? "chart.spend" : metric === "calls" ? "chart.calls" : "chart.tokens");

type SegmentProps = { x?: number; y?: number; width?: number; height?: number; fill?: string; payload?: Row };
/** Where each drawn segment sits, by column start, so the hover card can find the column and segment under the cursor. */
type Geo = Map<number, { x: number; w: number; segs: Map<string, [number, number]> }>;

function record(geo: Geo, payload: Row | undefined, id: string, x: number, y: number, width: number, height: number) {
  if (!payload) return;
  const col = geo.get(payload.start) ?? { x, w: width, segs: new Map() };
  if (height > 0 && width > 0) col.segs.set(id, [y, y + height]);
  else col.segs.delete(id);
  geo.set(payload.start, { ...col, x, w: width });
}

/**
 * A segment inside its provider's block: models are 1px apart, and each provider block has a thin
 * border-colored frame with a 4px gap to the next block. The block's bottom segment draws the whole frame,
 * sized from the block's drawn heights (`disp`), so its rounded corners are never cut.
 */
/**
 * The hovered segment (`start:slotId`). The hover card sets it and restyles the two affected rects directly, so
 * hovering never re-renders the chart; a rect Recharts remounts on a data refresh reads it and keeps the highlight.
 */
type Hover = { key: string | null };
const HIGHLIGHT = "0.8";

function segment(slots: Slot[], index: number, geo: Geo, hover: Hover) {
  const slot = slots[index]!, group = slot.group;
  return function GroupedSegment(props: SegmentProps) {
    const { x = 0, y = 0, width = 0, height = 0, fill, payload } = props;
    record(geo, payload, slot.id, x, y, width, height);
    if (height <= 0 || width <= 0) return <g />;
    const value = (s: Slot) => payload?.disp[s.id] ?? 0;
    const shown = (s: Slot) => s.group === group && value(s) > 0;
    const top = !slots.slice(index + 1).some(shown), bottom = !slots.slice(0, index).some(shown);
    const own = value(slot), sum = slots.filter(shown).reduce((n, s) => n + value(s), 0), block = own > 0 ? (sum / own) * height : height;
    // Insets shrink with the whole provider block, not this segment (a 16 px block keeps half its fill); a sliver
    // too thin for its inset grows into the block (down from the top edge, else up), so it shows 2 px of fill.
    const k = Math.min(1, block / 16), inTop = (top ? 4 : 0.5) * k, inBottom = (bottom ? 4 : 0.5) * k;
    let fy0 = y + inTop, fy1 = y + height - inBottom;
    if (fy1 - fy0 < 2) { if (top && !bottom) fy1 = fy0 + 2; else fy0 = fy1 - 2; }
    const fh = fy1 - fy0, rx = Math.min(1.5, fh / 2);
    let frame = null;
    if (bottom) {
      const y1 = y + height - 2, y0 = y + height - block + 2, h = y1 - y0 - 1;
      // A block too short for its frame shows the fill alone.
      if (h > 4) frame = <rect x={x + 0.5} y={y0 + 0.5} width={Math.max(0, width - 1)} height={h} rx={Math.min(3, h / 2)} fill="none" className="stroke-border" strokeWidth={1} />;
    }
    return (
      <g>
        {frame}
        {fh > 0 && <rect x={x + 2} y={fy0} width={Math.max(0, width - 4)} height={fh} rx={rx} ry={rx} fill={fill} data-seg={`${payload?.start}:${slot.id}`}
          className="transition-opacity duration-150" style={hover.key === `${payload?.start}:${slot.id}` ? { opacity: HIGHLIGHT } : undefined} />}
      </g>
    );
  };
}

const FADE_MS = 120;
// Stable ref callbacks, so they run once per mounted element; jsdom has no Web Animations.
const fadeIn = (el: HTMLElement | null) => { el?.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: "ease-out" }); };
const fadeOut = (el: HTMLElement | null) => { el?.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, easing: "ease-in", fill: "forwards" }); };

/** The column under the cursor: inside the bar's own box, from its top segment down to its bottom one. */
export function pickColumn(geo: Geo, px: number, py: number): number | null {
  for (const [start, c] of geo) {
    const ys = [...c.segs.values()];
    if (px >= c.x && px <= c.x + c.w && py >= Math.min(...ys.map((s) => s[0])) && py <= Math.max(...ys.map((s) => s[1]))) return start;
  }
  return null;
}

/** The segment under the cursor, else the nearest one, so the gaps between blocks still count. */
export function pickSegment(segs: Map<string, [number, number]>, py: number): string | null {
  let best: string | null = null, gap = Infinity;
  for (const [id, [y0, y1]] of segs) {
    const d = py < y0 ? y0 - py : py > y1 ? py - y1 : 0;
    if (d < gap) { best = id; gap = d; }
  }
  return best;
}

type Tip = { start: number; seg: string; x: number; y: number; flipX: boolean; flipY: boolean };

function TipBody({ tip, model, t }: { tip: Tip; model: ChartModel; t: T }) {
  const row = model.rows.find((r) => r.start === tip.start);
  if (!row) return null;
  const id = tip.seg, cost = row.costs[id];
  // Every segment of the column, largest first; the hovered one is highlighted.
  const items = tipOrder(model, row);
  const amount = (s: Slot) => (model.metric === "usd" ? fmtCost(row.costs[s.id]!, t) ?? t("noPrice") : tipValue(model.metric, Number(row[s.id]), t));
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">{row.title}</span>
        <span className="ml-auto font-medium tabular-nums text-foreground">{t("chart.total")} {tipValue(model.metric, row.total, t)}</span>
      </div>
      <ul className="grid">
        {items.map((s, i) => (
          <li key={s.id} className="grid">
            {s.groupLabel !== undefined && s.group !== items[i - 1]?.group && <span className={cn("text-[10px] text-muted-foreground", i > 0 && "mt-1")}>{s.groupLabel}</span>}
            <span className={cn("-mx-1.5 flex items-center gap-2 rounded px-1.5 py-0.5 transition-colors duration-150", s.id === id ? "bg-muted text-foreground" : "text-muted-foreground")}>
              <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: s.color }} />
              <span className={cn("truncate", s.id === id && "font-medium")}>{s.groupLabel !== undefined ? s.label : s.title}</span>
              <span className={cn("ml-auto pl-3 tabular-nums", s.id === id && "font-medium")}>{amount(s)}</span>
            </span>
          </li>
        ))}
      </ul>
      {/* Keyed by segment: moving within the column fades the hovered segment's details in, the card itself stays. */}
      {cost && (
        <div key={id} ref={fadeIn} className="text-muted-foreground tabular-nums">
          {t(model.metric === "tokens" ? "chart.tipDetailParts" : "chart.tipDetail", { total: fmtTokens(totalTokens(cost.tokens), t), cacheRead: fmtTokens(cost.tokens.cacheRead, t), output: fmtTokens(cost.tokens.output, t) })}
          {" · "}{t("calls.count", { n: cost.calls })}
          {model.metric !== "usd" && <>{" · "}{fmtCost(cost, t) ?? t("noPrice")}</>}
        </div>
      )}
    </>
  );
}

/**
 * The hover card: fades in beside the cursor and follows it. Within one column (gaps between blocks included)
 * only its content changes; moving to another column fades this card out and a new one in.
 */
function HoverTip({ geo, hover, model }: { geo: Geo; hover: Hover; model: ChartModel }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const rehit = useRef(() => {});
  const [tip, setTip] = useState<Tip | null>(null);
  const [gone, setGone] = useState<(Tip & { n: number }) | null>(null);
  useEffect(() => {
    const host = ref.current?.parentElement;
    if (!host) return;
    let current: Tip | null = null, n = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const show = (next: Tip | null) => {
      if (current && current.start !== next?.start) {
        setGone({ ...current, n: ++n });
        clearTimeout(timer);
        timer = setTimeout(() => setGone(null), FADE_MS);
      }
      current = next;
      const key = next && `${next.start}:${next.seg}`;
      if (key !== hover.key) {
        const rect = (k: string | null) => (k ? host.querySelector<SVGElement>(`[data-seg="${k}"]`) : null);
        rect(hover.key)?.style.removeProperty("opacity");
        rect(key)?.style.setProperty("opacity", HIGHLIGHT);
        hover.key = key;
      }
      setTip(next);
    };
    let last: MouseEvent | null = null;
    const move = (e: MouseEvent) => {
      last = e;
      const svg = host.querySelector("svg.recharts-surface");
      if (!svg) return;
      const s = svg.getBoundingClientRect(), h = host.getBoundingClientRect();
      const px = e.clientX - s.left, py = e.clientY - s.top, start = pickColumn(geo, px, py), seg = start === null ? null : pickSegment(geo.get(start)!.segs, py);
      if (start === null || seg === null) return show(null);
      const x = e.clientX - h.left, y = e.clientY - h.top;
      show({ start, seg, x, y, flipX: x > h.width / 2, flipY: y > h.height / 2 });
    };
    const leave = () => { last = null; show(null); };
    rehit.current = () => { if (last) move(last); };
    host.addEventListener("mousemove", move);
    host.addEventListener("mouseleave", leave);
    return () => { host.removeEventListener("mousemove", move); host.removeEventListener("mouseleave", leave); clearTimeout(timer); };
  }, [geo, hover]);
  // A data refresh moves the segments under a still cursor: pick again once the bars have been redrawn.
  useEffect(() => {
    const frame = requestAnimationFrame(() => rehit.current());
    return () => cancelAnimationFrame(frame);
  }, [model]);
  const box = (x: Tip) => ({
    left: x.x, top: x.y,
    transform: `translate(${x.flipX ? "calc(-100% - 14px)" : "14px"}, ${x.flipY ? "calc(-100% - 14px)" : "14px"})`,
  });
  const cls = "pointer-events-none absolute z-10 grid w-max min-w-[8rem] max-w-80 items-start gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl";
  return (
    <div ref={ref} className="contents">
      {gone && <div key={`gone:${gone.n}`} ref={fadeOut} aria-hidden className={cls} style={box(gone)}><TipBody tip={gone} model={model} t={t} /></div>}
      {tip && <div key={tip.start} ref={fadeIn} role="tooltip" className={cls} style={box(tip)}><TipBody tip={tip} model={model} t={t} /></div>}
    </div>
  );
}

function Swatch({ slot }: { slot: Slot }) {
  return (
    <li className="flex items-center gap-1.5">
      <span aria-hidden className="size-2.5 rounded-[2px]" style={{ background: slot.color }} />
      {slot.label}
    </li>
  );
}

export function Legend({ slots }: { slots: Slot[] }) {
  const t = useT();
  // Model series are listed under their provider; provider series are listed flat.
  const groups = slots.reduce<{ label?: string; slots: Slot[] }[]>((out, s) => {
    const last = out.at(-1);
    if (last && s.group !== undefined && last.slots[0]!.group === s.group) last.slots.push(s);
    else out.push({ label: s.groupLabel, slots: [s] });
    return out;
  }, []);
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label={t("chart.legend")}>
      {groups.map((g) => g.label === undefined ? <Swatch key={g.slots[0]!.id} slot={g.slots[0]!} /> : (
        <li key={g.slots[0]!.id} className="flex items-center gap-x-2.5 rounded-sm border border-border px-1.5 py-0.5">
          <span className="font-medium text-foreground">{g.label}</span>
          <ul className="flex flex-wrap items-center gap-x-2.5" aria-label={g.label}>{g.slots.map((s) => <Swatch key={s.id} slot={s} />)}</ul>
        </li>
      ))}
    </ul>
  );
}

function DataTable({ model, summary, t }: { model: ChartModel; summary: SummaryOutput; t: T }) {
  const unit = unitLabel(model.metric, t);
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("chart.interval", { unit })}</TableHead>
            {model.slots.map((s) => <TableHead key={s.id} className="text-right">{s.title}</TableHead>)}
            <TableHead className="text-right">{t("chart.total")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {model.rows.map((row) => (
            <TableRow key={row.start}>
              <TableCell className="whitespace-nowrap">{row.title}</TableCell>
              {model.slots.map((s) => <TableCell key={s.id} className="text-right tabular-nums">{row[s.id] ? fmtMetric(model.metric, Number(row[s.id]), t) : "—"}</TableCell>)}
              <TableCell className="text-right tabular-nums">{fmtMetric(model.metric, row.total, t)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <span className="sr-only">{t("chart.intervals", { n: summary.buckets.length })}</span>
    </div>
  );
}

export function UsageChart({ summary, by, metric, stale }: { summary: SummaryOutput; by: By; metric: Metric; stale: boolean }) {
  const t = useT();
  const [asTable, setAsTable] = useState(false);
  const range: Range = summary.range;
  const model = useMemo(() => buildChart(summary, by, range, t, metric), [summary, by, range, t, metric]);
  // Series, shapes and the geometry map change only with the set of series, not with every data refresh:
  // new dataKey functions would make Recharts re-register the bars and redraw the hovered one.
  const series = model.slots.map((s) => `${s.id}:${s.group}:${s.color}:${s.title}`).join("|");
  const slots = useMemo(() => model.slots, [series]);
  const config = useMemo<ChartConfig>(() => Object.fromEntries(slots.map((s) => [s.id, { label: s.title, color: s.color }])), [slots]);
  const geo = useMemo<Geo>(() => new Map(), [slots]);
  const hover = useMemo<Hover>(() => ({ key: null }), [slots]);
  const bars = useMemo(() => slots.map((s, i) => ({ shape: segment(slots, i, geo, hover), value: (r: Row) => r.disp[s.id] })), [slots, geo, hover]);
  // Columns that left the range are dropped from the hover geometry.
  useEffect(() => { for (const start of geo.keys()) if (!model.rows.some((r) => r.start === start)) geo.delete(start); }, [geo, model]);
  const empty = model.rows.every((r) => r.total === 0);
  const interval = range === "day" ? 2 : range === "month" ? 4 : 0;
  return (
    <Card className={cn("space-y-3 transition-opacity", stale && "opacity-60")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {model.slots.length > 0 ? <Legend slots={model.slots} /> : <span className="text-xs text-muted-foreground">{heading(model.metric, t)}</span>}
        <Button variant="ghost" size="sm" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>{t("chart.table")}</Button>
      </div>
      {empty ? <Muted>{t("chart.empty")}</Muted> : asTable ? <DataTable model={model} summary={summary} t={t} /> : (
        <div className="relative">
        <ChartContainer config={config} className="aspect-auto h-80 w-full" role="img" aria-label={t("chart.aria", { n: model.rows.length })} data-bucket-count={model.rows.length}>
          <BarChart accessibilityLayer={false} data={model.rows} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} barCategoryGap="14%">
            <CartesianGrid vertical={false} />
            <XAxis dataKey="label" tickLine={false} axisLine={false} interval={interval} tickMargin={6} />
            <YAxis tickLine={false} axisLine={false} width={model.metric === "usd" ? 56 : 44} tickFormatter={(v: number) => axisTick(model.metric, v, t)} />
            {slots.map((s, i) => <Bar key={s.id} dataKey={bars[i]!.value} stackId="usage" fill={`var(--color-${s.id})`} maxBarSize={76} shape={bars[i]!.shape} isAnimationActive={false} />)}
          </BarChart>
        </ChartContainer>
        <HoverTip geo={geo} hover={hover} model={model} />
        </div>
      )}
    </Card>
  );
}
