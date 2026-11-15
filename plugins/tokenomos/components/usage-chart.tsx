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

/** Segment with a square baseline and a 4px rounded data end; only the top visible segment of a stack rounds. */
function segment(slots: Slot[], index: number) {
  return function Segment(props: { x?: number; y?: number; width?: number; height?: number; fill?: string; payload?: Row }) {
    const { x = 0, y = 0, width = 0, height = 0, fill, payload } = props;
    if (height <= 0 || width <= 0) return <g />;
    const top = !slots.slice(index + 1).some((s) => Number(payload?.[s.id] ?? 0) > 0);
    const r = top ? Math.min(4, width / 2, height) : 0;
    const d = `M${x},${y + height} V${y + r} Q${x},${y} ${x + r},${y} H${x + width - r} Q${x + width},${y} ${x + width},${y + r} V${y + height} Z`;
    // The 2px card-colored stroke is the surface gap between touching segments.
    return <path d={d} fill={fill} className="stroke-card transition-opacity hover:opacity-80" strokeWidth={2} />;
  };
}

export function Legend({ slots }: { slots: Slot[] }) {
  const t = useT();
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label={t("chart.legend")}>
      {slots.map((s) => (
        <li key={s.id} className="flex items-center gap-1.5">
          <span aria-hidden className="size-2.5 rounded-[2px]" style={{ background: seriesColor(s.n) }} />
          {s.label}
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
            {model.slots.map((s) => <TableHead key={s.id} className="text-right">{s.label}</TableHead>)}
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
  const config = useMemo<ChartConfig>(() => Object.fromEntries(model.slots.map((s) => [s.id, { label: s.label, color: seriesColor(s.n) }])), [model]);
  const empty = model.rows.every((r) => r.total === 0);
  const interval = range === "day" ? 2 : range === "month" ? 4 : 0;
  return (
    <Card className={cn("space-y-3 transition-opacity", stale && "opacity-60")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {model.slots.length > 1 ? <Legend slots={model.slots} /> : <span className="text-xs text-muted-foreground">{heading(model.metric, t)}</span>}
        <Button variant="ghost" size="sm" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>{t("chart.table")}</Button>
      </div>
      {empty ? <Muted>{t("chart.empty")}</Muted> : asTable ? <DataTable model={model} summary={summary} t={t} /> : (
        <ChartContainer config={config} className="aspect-auto h-64 w-full" role="img" aria-label={t("chart.aria", { n: model.rows.length })} data-bucket-count={model.rows.length}>
          <BarChart data={model.rows} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} barCategoryGap="20%">
            <CartesianGrid vertical={false} />
            <XAxis dataKey="label" tickLine={false} axisLine={false} interval={interval} tickMargin={6} />
            <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={(v: number) => axisTick(model.metric, v, t)} />
            <ChartTooltip shared={false} cursor={false} content={
              <ChartTooltipContent hideLabel formatter={(_v, _n, item) => {
                const row = item.payload as Row, id = String(item.dataKey), cost = row.costs[id];
                const slot = model.slots.find((s) => s.id === id);
                if (!cost || !slot) return null;
                return (
                  <div className="grid w-full gap-1">
                    <div className="text-muted-foreground">{row.title}</div>
                    <div className="flex items-center gap-2">
                      <span aria-hidden className="h-0.5 w-3 rounded-full" style={{ background: seriesColor(slot.n) }} />
                      <span className="text-muted-foreground">{slot.label}</span>
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
            {model.slots.map((s, i) => <Bar key={s.id} dataKey={s.id} stackId="usage" fill={`var(--color-${s.id})`} maxBarSize={56} shape={segment(model.slots, i)} isAnimationActive={false} />)}
          </BarChart>
        </ChartContainer>
      )}
    </Card>
  );
}
