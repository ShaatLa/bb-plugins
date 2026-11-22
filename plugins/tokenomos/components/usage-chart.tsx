import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import type { Range } from "../contract";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "./ui/chart";
import { Button } from "./ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { cn } from "../lib/utils";
import { fmtCost, fmtMetric, fmtTokens, totalTokens, type By, type Metric, type Shown } from "./format";
import { buildChart, type ChartModel, type Row, type Slot } from "./series";
import { seriesColor } from "./colors";
import { useT, type T } from "./i18n";
import { Card, Muted } from "./shared";
import type { SummaryOutput } from "./types";

const axisTick = (metric: Shown, v: number, t: T) => (metric !== "usd" ? fmtTokens(v, t) : v < 10 ? `$${fmtTokens(+v.toFixed(2), t)}` : `$${fmtTokens(v, t)}`);
const unitLabel = (metric: Shown, t: T) => (metric === "usd" ? "~$" : metric === "calls" ? t("chart.unitCalls") : t("chart.unitTokens"));
const heading = (metric: Shown, t: T) => t(metric === "usd" ? "chart.spend" : metric === "calls" ? "chart.calls" : "chart.tokens");

type SegmentProps = { x?: number; y?: number; width?: number; height?: number; fill?: string; payload?: Row };

/**
 * A segment inside its provider's block: models are 1px apart, and each provider block has a thin
 * border-colored frame with a 4px gap to the next block. The block's bottom segment draws the whole frame,
 * sized from the block's values (the value axis is linear), so its rounded corners are never cut.
 */
function segment(slots: Slot[], index: number) {
  const slot = slots[index]!, group = slot.group;
  return function GroupedSegment(props: SegmentProps) {
    const { x = 0, y = 0, width = 0, height = 0, fill, payload } = props;
    if (height <= 0 || width <= 0) return <g />;
    const value = (s: Slot) => Number(payload?.[s.id] ?? 0);
    const shown = (s: Slot) => s.group === group && value(s) > 0;
    const top = !slots.slice(index + 1).some(shown), bottom = !slots.slice(0, index).some(shown);
    const own = value(slot), sum = slots.filter(shown).reduce((n, s) => n + value(s), 0), block = own > 0 ? (sum / own) * height : height;
    // Insets shrink with the whole provider block, not this segment; a sliver too thin for its inset grows into the
    // block (down from the top edge, else up), so every non-zero segment shows 2 px of fill inside the frame.
    const k = Math.min(1, Math.max(0, block - 2) / 8), inTop = (top ? 4 : 0.5) * k, inBottom = (bottom ? 4 : 0.5) * k;
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
        {fh > 0 && <rect x={x + 2} y={fy0} width={Math.max(0, width - 4)} height={fh} rx={rx} ry={rx} fill={fill} className="transition-opacity hover:opacity-80" />}
      </g>
    );
  };
}

const LOCAL = seriesColor(3);
const HATCH = `repeating-linear-gradient(135deg, ${LOCAL} 0 1.5px, transparent 1.5px 4px)`;

/** The saved segment: hatched in the local-models colour, with a thin outline and a rounded top. */
function SavedSegment(props: { x?: number; y?: number; width?: number; height?: number }) {
  const { x = 0, y = 0, width = 0, height = 0 } = props;
  if (height <= 0 || width <= 0) return <g />;
  const r = Math.min(4, width / 2, height);
  const d = `M${x},${y + height} V${y + r} Q${x},${y} ${x + r},${y} H${x + width - r} Q${x + width},${y} ${x + width},${y + r} V${y + height} Z`;
  return <path d={d} fill="url(#tokenomos-saved)" stroke={LOCAL} strokeOpacity={0.7} strokeWidth={1} className="transition-opacity hover:opacity-80" />;
}

function Swatch({ slot }: { slot: Slot }) {
  return (
    <li className="flex items-center gap-1.5">
      <span aria-hidden className="size-2.5 rounded-[2px]" style={{ background: slot.color }} />
      {slot.label}
    </li>
  );
}

export function Legend({ slots, saved }: { slots: Slot[]; saved?: boolean }) {
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
      {saved && (
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="size-2.5 rounded-[2px] border" style={{ background: HATCH, borderColor: LOCAL }} />
          {t("chart.saved")}
        </li>
      )}
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
            {model.saved && <TableHead className="text-right">{t("chart.saved")}</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {model.rows.map((row) => (
            <TableRow key={row.start}>
              <TableCell className="whitespace-nowrap">{row.title}</TableCell>
              {model.slots.map((s) => <TableCell key={s.id} className="text-right tabular-nums">{row[s.id] ? fmtMetric(model.metric, Number(row[s.id]), t) : "—"}</TableCell>)}
              <TableCell className="text-right tabular-nums">{fmtMetric(model.metric, row.total, t)}</TableCell>
              {model.saved && <TableCell className="text-right tabular-nums">{row.saved ? fmtMetric("usd", Number(row.saved), t) : "—"}</TableCell>}
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
  const config = useMemo<ChartConfig>(() => Object.fromEntries(model.slots.map((s) => [s.id, { label: s.title, color: s.color }])), [model]);
  const empty = model.rows.every((r) => r.total === 0);
  const interval = range === "day" ? 2 : range === "month" ? 4 : 0;
  return (
    <Card className={cn("space-y-3 transition-opacity", stale && "opacity-60")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {model.slots.length > 0 || model.saved ? <Legend slots={model.slots} saved={model.saved} /> : <span className="text-xs text-muted-foreground">{heading(model.metric, t)}</span>}
        <Button variant="ghost" size="sm" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>{t("chart.table")}</Button>
      </div>
      {empty ? <Muted>{t("chart.empty")}</Muted> : asTable ? <DataTable model={model} summary={summary} t={t} /> : (
        <ChartContainer config={config} className="aspect-auto h-80 w-full" role="img" aria-label={t("chart.aria", { n: model.rows.length })} data-bucket-count={model.rows.length}>
          <BarChart data={model.rows} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} barCategoryGap="14%">
            <defs>
              <pattern id="tokenomos-saved" width={4} height={4} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width={1.5} height={4} fill={LOCAL} />
              </pattern>
            </defs>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="label" tickLine={false} axisLine={false} interval={interval} tickMargin={6} />
            <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={(v: number) => axisTick(model.metric, v, t)} />
            <ChartTooltip shared={false} cursor={false} content={
              <ChartTooltipContent hideLabel formatter={(_v, _n, item) => {
                const row = item.payload as Row, id = String(item.dataKey), cost = row.costs[id];
                if (id === "saved") return (
                  <div className="grid w-full gap-1">
                    <div className="text-muted-foreground">{row.title}</div>
                    <div className="flex items-center gap-2">
                      <span aria-hidden className="h-0.5 w-3 rounded-full" style={{ background: LOCAL }} />
                      <span className="text-muted-foreground">{t("chart.saved")}</span>
                      <span className="ml-auto font-medium tabular-nums text-foreground">{fmtMetric("usd", Number(row.saved), t)}</span>
                    </div>
                    <div className="text-muted-foreground">{t("chart.savedTip", { model: summary.localSavings.referenceModel })}</div>
                  </div>
                );
                const slot = model.slots.find((s) => s.id === id);
                if (!cost || !slot) return null;
                return (
                  <div className="grid w-full gap-1">
                    <div className="text-muted-foreground">{row.title}</div>
                    <div className="flex items-center gap-2">
                      <span aria-hidden className="h-0.5 w-3 rounded-full" style={{ background: slot.color }} />
                      <span className="text-muted-foreground">{slot.title}</span>
                      <span className="ml-auto font-medium tabular-nums text-foreground">{fmtCost(cost, t) ?? t("noPrice")}</span>
                    </div>
                    <div className="text-muted-foreground tabular-nums">
                      {t("chart.tipDetail", { total: fmtTokens(totalTokens(cost.tokens), t), cacheRead: fmtTokens(cost.tokens.cacheRead, t), output: fmtTokens(cost.tokens.output, t) })}
                      {" · "}{t("calls.count", { n: cost.calls })}
                    </div>
                  </div>
                );
              }} />
            } />
            {model.slots.map((s, i) => <Bar key={s.id} dataKey={s.id} stackId="usage" fill={`var(--color-${s.id})`} maxBarSize={76} shape={segment(model.slots, i)} isAnimationActive={false} />)}
            {/* Recharts stacks in registration order: re-key with the series so the saving re-registers last, on top. */}
            {model.saved && <Bar key={`saved:${model.slots.map((s) => s.id).join()}`} dataKey="saved" stackId="usage" maxBarSize={76} shape={<SavedSegment />} isAnimationActive={false} />}
          </BarChart>
        </ChartContainer>
      )}
    </Card>
  );
}
