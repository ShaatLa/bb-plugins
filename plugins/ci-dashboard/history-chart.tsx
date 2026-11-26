import { useId, useRef, useState, type ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { Metrics } from "./metrics";
import type { DateRange } from "./date-range";
import type { RunTrends, TrendPoint } from "./ci-insights";
import type { CiFilter } from "./ci-filter";
import { elapsed } from "./ci-cards";
import { Card } from "./components/ui/card";
import { Button } from "./components/ui/button";
import { ChevronSelect } from "./components/ui/chevron-select";
import { FilterMeta } from "./ci-filter-meta";
import { LoadingSkeleton, Skeleton } from "./components/ui/skeleton";

export type ChartKey = "passRate" | "deployments" | "durationMedian" | "durationP90" | "runs" | "failedRuns" | "startDelay" | "commits" | "lines";
type Part = { key: string; sign: string; word: string; tone: string };
/** What the scale counts: `percent` is fixed at 0/50/100. */
type Unit = "count" | "duration" | "percent";
type ChartSpec = {
  title: string; format: (value: number) => string; unit: Unit; note?: string;
  /** `pending` entry that must finish before a trends series exists. */
  source?: "ci" | "commitActivity"; fixedMax?: number;
  /** Run-based series that can be narrowed to one workflow and event. */
  byWorkflow?: boolean;
  /** Tooltip sentence for the sample behind a bar; `runs` reads "merge_group runs" or "runs". */
  sample?: (n: number, runs: string) => string;
  /** Components drawn as bars side by side within one column, left to right (their values sum to the point value). */
  parts?: Part[];
};
const count = (value: number) => value.toLocaleString();
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const DEFAULT_PART = { tone: "bg-diff-added/60" };
export const CHARTS: Record<ChartKey, ChartSpec> = {
  passRate: { title: "CI pass rate over time", unit: "percent", format: (value) => `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`, fixedMax: 100 },
  deployments: { title: "Deployment throughput", unit: "count", format: count },
  durationMedian: { byWorkflow: true, title: "Median CI run duration", unit: "duration", format: elapsed, source: "ci", note: "successful runs",
    sample: (n, runs) => `median of ${n} successful ${runs}; failed, cancelled and skipped runs excluded` },
  durationP90: { byWorkflow: true, title: "CI run duration p90", unit: "duration", format: elapsed, source: "ci", note: "successful runs",
    sample: (n, runs) => `p90 of ${n} successful ${runs}; failed, cancelled and skipped runs excluded` },
  runs: { byWorkflow: true, title: "CI runs", unit: "count", format: count, source: "ci", },
  failedRuns: { byWorkflow: true, title: "Failed CI runs", unit: "count", format: count, source: "ci" },
  startDelay: { byWorkflow: true, title: "Median wait before a run starts", unit: "duration", format: elapsed, source: "ci", note: "first attempts",
    sample: (n, runs) => `median of ${n} first-attempt ${runs}` },
  commits: { title: "Commits to default branch", unit: "count", format: count, source: "commitActivity" },
  lines: { title: "Lines changed", unit: "count", format: count, source: "commitActivity", parts: [
    { key: "additions", sign: "+", word: "added", tone: "bg-diff-added/60" },
    { key: "deletions", sign: "−", word: "deleted", tone: "bg-diff-removed/60" },
  ] },
};
export const CHART_KEYS = Object.keys(CHARTS) as ChartKey[];
/** Trend series that arrive with each `pending` source; used to keep the previous values while it refreshes. */
export const trendKeysBySource = { ci: ["durationMedian", "durationP90", "runs", "failedRuns", "startDelay", "workflows"], commitActivity: ["commits", "lines"] } as const;

/** Scale for a series whose largest value is `max`: ticks from 0 in equal, round steps (s/m/h for durations, 1/2/5 × 10ⁿ for counts); the last tick is the scale's top. */
export function niceTicks(max: number, unit: "count" | "duration"): { top: number; ticks: number[] } {
  const hour = 3_600_000;
  const round = (x: number) => { const p = 10 ** Math.floor(Math.log10(x)), r = x / p; return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10) * p; };
  const steps = [1, 2, 5, 10, 15, 30].map((s) => s * 1000).concat([1, 2, 5, 10, 15, 30].map((m) => m * 60_000), [1, 2, 3, 6, 12, 24].map((h) => h * hour));
  const step = unit === "duration" ? steps.find((candidate) => Math.ceil(max / candidate) <= 3) ?? round(max / 3 / hour) * hour : Math.max(1, round(max / 3));
  const top = Math.ceil(max / step) * step;
  return { top, ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, index) => index * step) };
}
function tickLabel(value: number, unit: Unit) {
  if (unit === "percent") return `${value}%`;
  if (unit === "count") return compact.format(value);
  return value === 0 ? "0" : value < 60_000 ? `${value / 1000}s` : value < 3_600_000 ? `${value / 60_000}m` : `${value / 3_600_000}h`;
}

/** The interval still running: only in a range that ends at load time (a preset, or a custom range through today), the one whose real bounds contain `range.until`. -1 = none. */
export function inProgressIndex(range: DateRange, dates: string[], now = Date.now()): number {
  const end = range.label.split(" – ")[1];
  const live = range.label === "today" || range.label.startsWith("last ") || (end !== undefined && end >= new Date(now).toISOString().slice(0, 10));
  if (!live) return -1;
  const until = Date.parse(range.until);
  // The last bucket started by `until`; not matched against bucket ends, which lag `until` while a refresh shows the previous series.
  return dates.reduce((found, _date, index) => Date.parse(index === 0 ? range.since : dates[index - 1]!) <= until ? index : found, -1);
}

const STORAGE_KEY = "ci-dashboard:history-charts";
/** One card: the chart. Workflow and event are one choice per repository (ci-filter), not per card. */
type Slot = { chart: ChartKey };
const DEFAULTS: [Slot, Slot] = [{ chart: "passRate" }, { chart: "deployments" }];

function readSlots(): [Slot, Slot] {
  try {
    const saved: unknown = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? "null");
    // Entries saved before workflow selection are plain chart keys; later ones carry a workflow and event, which ci-filter migrates.
    const slots = Array.isArray(saved) ? saved.map((entry): Slot | null => {
      const chart = typeof entry === "string" ? entry : entry?.chart;
      return CHART_KEYS.includes(chart) ? { chart } : null;
    }) : [];
    if (slots.length === 2 && slots[0] && slots[1] && slots[0].chart !== slots[1].chart) return [slots[0], slots[1]];
  } catch { /* unavailable or corrupt storage: use the defaults */ }
  return DEFAULTS;
}
function saveSlots(slots: [Slot, Slot]) {
  try {
    // Keep the old workflow and event fields: another repository may still need to migrate them.
    const old: unknown = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? "null");
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(slots.map((slot, index) => ({ ...(Array.isArray(old) && typeof old[index] === "object" ? old[index] : {}), chart: slot.chart }))));
  } catch { /* the choice just will not persist */ }
}

export function HistoryCharts({ repo, filter, onSelect }: {
  repo: Metrics; filter: CiFilter; onSelect: (since: string, until: string) => void;
}) {
  const [slots, setSlots] = useState(readSlots);
  const [expanded, setExpanded] = useState<0 | 1 | null>(null);
  const group = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ content: ReactNode; x: number; y: number; flipX: boolean; flipY: boolean } | null>(null);
  // Client point → group coordinates; the card flips to the other side past the group's middle so it stays on screen.
  const showTip: ShowTip = (content, point) => {
    const box = group.current?.getBoundingClientRect();
    if (!content || !point || !box) return setTip(null);
    const x = point.x - box.left, y = point.y - box.top;
    setTip({ content, x, y, flipX: x > box.width / 2, flipY: y > box.height / 2 });
  };
  const columns = expanded === 0 ? "xl:grid-cols-[minmax(0,1fr)_minmax(0,0fr)] gap-0"
    : expanded === 1 ? "xl:grid-cols-[minmax(0,0fr)_minmax(0,1fr)] gap-0"
      : "xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3";
  return <div ref={group} role="group" aria-label="History charts" style={{ containerType: "inline-size" }} className={`relative grid min-w-0 grid-cols-1 transition-[grid-template-columns,gap] duration-300 ease-in-out motion-reduce:transition-none ${columns}`}>
    {([0, 1] as const).map((slot) => {
      const hidden = expanded !== null && expanded !== slot;
      return <div key={slot} aria-hidden={hidden || undefined} inert={hidden} className={`min-w-0 overflow-hidden transition-opacity duration-300 ease-in-out motion-reduce:transition-none ${hidden ? "hidden opacity-0 xl:block" : "opacity-100"}`}>
        {/* Keep shrinking labels from wrapping and increasing the row height. */}
        <div className="h-full xl:min-w-[calc((100cqw_-_0.75rem)/2)]">
          <HistoryChart chart={slots[slot].chart} filter={filter} options={CHART_KEYS.filter((key) => key !== slots[1 - slot].chart)} selectLabel={slot === 0 ? "First chart" : "Second chart"}
            onChange={(chart) => { const next = slots.map((current, index) => index === slot ? { chart } : current) as [Slot, Slot]; setSlots(next); saveSlots(next); }}
            repo={repo} onSelect={onSelect} expanded={expanded === slot} onToggle={() => setExpanded((current) => current === slot ? null : slot)} onTip={showTip} />
        </div>
      </div>;
    })}
    {/* A child of the group, not of a slot: the slots clip their overflow for the expand animation, the card may leave its chart. */}
    {tip && <div role="tooltip" style={{ left: tip.x, top: tip.y, transform: `translate(${tip.flipX ? "calc(-100% - 14px)" : "14px"}, ${tip.flipY ? "calc(-100% - 14px)" : "14px"})` }}
      className="pointer-events-none absolute z-20 flex w-max min-w-32 max-w-64 flex-col gap-0.5 rounded-md border border-border bg-popover p-2 text-xs text-popover-foreground shadow-md">{tip.content}</div>}
  </div>;
}

/** Series plus the state to show while there is none (loading skeleton or a message). The workflow and event come from the shared filter. */
function resolve(chart: ChartKey, repo: Metrics, filter: CiFilter): { series: TrendPoint[] | null; loading: boolean; message: string; events: CiFilter["events"]; event: string } {
  const spec = CHARTS[chart];
  const metric = chart === "passRate" ? repo.ci : chart === "deployments" ? repo.deployments : null;
  if (metric) {
    const loading = metric.detail.startsWith("Loading");
    return { series: metric.series, loading: !metric.series && !metric.error && !metric.seriesError && loading, events: [], event: "all",
      message: metric.error || metric.seriesError || (loading ? metric.detail : "History is unavailable.") };
  }
  const { workflow: selected, events, event } = spec.byWorkflow ? filter : { workflow: null, events: [], event: "all" };
  const trend = selected ? repo.trends?.workflows?.find((entry) => entry.id === selected.id) : undefined;
  const source = trend?.events?.find((entry) => entry.event === event) ?? trend;
  const series = (source ? source[chart as keyof RunTrends] : repo.trends?.[chart as "commits"]) ?? null;
  const error = spec.source === "ci" ? repo.ci.error || repo.ci.seriesError : repo.commitActivity.error;
  return { series, loading: !series && !!repo.pending?.includes(spec.source!), message: error || "History is unavailable.", events, event };
}

type ShowTip = (content: ReactNode | null, point?: { x: number; y: number }) => void;

export function HistoryChart({ chart, filter, options, selectLabel, onChange, repo, onSelect, expanded, onToggle, onTip = () => {} }: {
  chart: ChartKey; filter: CiFilter; options: ChartKey[]; selectLabel: string; onChange: (chart: ChartKey) => void;
  repo: Metrics; onSelect: (since: string, until: string) => void; expanded: boolean; onToggle: () => void; onTip?: ShowTip;
}) {
  const headingId = useId();
  const { title, format: formatValue, note, fixedMax, unit, parts, sample } = CHARTS[chart];
  const range = repo.range;
  const { series: raw, loading, message, events, event } = resolve(chart, repo, filter);
  const calendarDay = range.label === "today";
  const series = raw?.map((point, index) => calendarDay && Date.parse(range.since) + index * range.bucketMs > Date.parse(range.until)
    ? { date: point.date, value: null } : point);
  const partValues = (point: TrendPoint) => parts?.map((part) => ({ part, value: point.parts?.find((entry) => entry.key === part.key)?.value ?? 0 }));
  // Grouped charts scale to the largest single part, not to the column total.
  const largest = Math.max(1, ...(series?.flatMap((point) => partValues(point)?.map((entry) => entry.value) ?? [point.value ?? 0]) ?? []));
  const { top, ticks } = fixedMax ? { top: fixedMax, ticks: [0, fixedMax / 2, fixedMax] } : niceTicks(largest, unit as "count" | "duration");
  const format = (point: TrendPoint) => point.value === null ? "—"
    : parts ? partValues(point)!.map(({ part, value }) => `${value.toLocaleString()} ${part.word}`).join(", ") : formatValue(point.value);
  const describe = (point: TrendPoint) => sample && point.count ? sample(point.count, `${event === "all" || !events.length ? "" : `${event} `}${point.count === 1 ? "run" : "runs"}`) : null;
  const dateLabel = (_date: string, index: number) => calendarDay
    ? new Date(Date.parse(range.since) + index * range.bucketMs).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })
    // A bar is labelled with its start (each point's date is its end): a calendar-day bar reads as that day.
    : new Date(index === 0 ? range.since : series![index - 1]!.date).toLocaleString("en-GB", { month: "short", day: "numeric", ...(range.bucketMs < 86_400_000 ? { hour: "2-digit", minute: "2-digit" } : {}), timeZone: "UTC" });
  const running = series ? inProgressIndex(range, series.map((point) => point.date)) : -1;
  const label = (date: string, index: number) => `${dateLabel(date, index)}${index === running ? " (so far)" : ""}`;
  const bars = series?.length ?? 0, gap = bars > 8 ? "0.25rem" : "0.5rem";
  const columns = `repeat(${bars}, minmax(0, 1fr))`;
  const noteText = [range.bucketMs === 86_400_000 ? null : `${range.bucketMs / 3_600_000}-hour intervals`, note].filter(Boolean).join(" · ");
  const notes = [noteText && <span key="note">{noteText}</span>, parts && <span key="parts">{parts.map((part, index) => <span key={part.key} className={`whitespace-nowrap ${index ? "ml-2" : ""}`}><span aria-hidden="true" className={`mr-1 inline-block size-2 rounded-sm align-baseline ${part.tone}`} />{part.word}</span>)}</span>].filter(Boolean);
  return <Card className="flex h-full min-w-0 flex-col p-4">
    {/* Bars sit at the bottom so both cards share a baseline whatever their header height. */}
    <figure id={`${headingId}-chart`} aria-label={title} className="flex flex-1 flex-col">
      <figcaption className="space-y-1">
        <div className="flex items-center justify-between gap-3">
          <ChevronSelect id={headingId} label={selectLabel} value={chart} onChange={(value) => onChange(value as ChartKey)} className="text-sm font-medium text-foreground hover:text-foreground/80">
            {options.map((key) => <option key={key} value={key}>{CHARTS[key].title}</option>)}
          </ChevronSelect>
          <Button type="button" variant="ghost" size="icon" className={`-my-1.5 shrink-0 ${expanded ? "" : "hidden xl:inline-flex"}`} aria-label={`${expanded ? "Restore" : "Expand"} ${title}`} aria-expanded={expanded} aria-controls={`${headingId}-chart`} onClick={(event) => { event.currentTarget.focus(); onToggle(); }}>
            <Icon name={expanded ? "Minimize2" : "Maximize2"} aria-hidden className="size-4" />
          </Button>
        </div>
        <FilterMeta filter={filter} label={selectLabel} pickers={!!CHARTS[chart].byWorkflow} notes={notes} />
      </figcaption>
      {series ? <div className="mt-auto flex gap-2 pt-5" role="group" aria-label={`${title}: ${series.map((point, index) => `${label(point.date, index)}: ${format(point)}`).join(", ")}`}>
        <div aria-hidden="true" className="relative h-32 w-9 shrink-0 text-right text-[10px] leading-none tabular-nums text-muted-foreground">
          {ticks.map((tick) => <span key={tick} className="absolute right-0 translate-y-1/2" style={{ bottom: `${tick / top * 100}%` }}>{tickLabel(tick, unit)}</span>)}
        </div>
        <div className="min-w-0 flex-1">
          {/* The bars grid below is positioned, so it paints over the gridlines. */}
          <div className="relative h-32 border-b border-border">
            {ticks.filter((tick) => tick > 0).map((tick) => <span key={tick} aria-hidden="true" className="pointer-events-none absolute inset-x-0 border-t border-dashed border-border" style={{ bottom: `${tick / top * 100}%` }} />)}
            <div className="relative grid h-full" style={{ gridTemplateColumns: columns, columnGap: gap }}>
              {series.map((point, index) => {
                const since = index === 0 ? range.since : series[index - 1].date;
                // Adjacent buckets share a boundary; include it only in the later bucket.
                const until = new Date(Math.min(Date.parse(range.until), Date.parse(point.date) - (index === series.length - 1 ? 0 : 1))).toISOString();
                const upcoming = Date.parse(since) > Date.parse(range.until);
                const sentence = describe(point);
                // Keyboard focus anchors the card to the bar's top; mouse focus leaves it at the cursor.
                const content = upcoming ? null : <><span className="font-medium">{label(point.date, index)}</span><span className="tabular-nums">{format(point)}</span>{sentence && <span className="text-muted-foreground">{sentence}</span>}</>;
                return <button key={point.date} type="button" aria-haspopup="dialog" disabled={upcoming}
                  aria-label={`${title} · ${label(point.date, index)} · ${format(point)} · ${sentence ? `${sentence} · ` : ""}${upcoming ? "Upcoming interval" : "Show statistics"}`}
                  onClick={(event) => { event.currentTarget.focus(); onSelect(since, until); }}
                  onMouseMove={(event) => onTip(content, { x: event.clientX, y: event.clientY })} onMouseLeave={() => onTip(null)}
                  onFocus={(event) => { if (event.currentTarget.matches(":focus-visible")) { const box = event.currentTarget.getBoundingClientRect(); onTip(content, { x: box.left + box.width / 2, y: box.top }); } }} onBlur={() => onTip(null)}
                  className="group flex h-full min-w-0 cursor-pointer items-end rounded-t-md hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50">
                  {/* Parts are bars side by side from the axis; a plain series is a single green part. */}
                  <span className="flex h-full w-full items-end gap-0.5">
                    {(partValues(point) ?? [{ part: DEFAULT_PART, value: point.value ?? 0 }]).map(({ part, value }, partIndex) => <span key={partIndex}
                      className={`min-w-0 flex-1 rounded-t-md transition-opacity group-hover:opacity-80 group-focus-visible:opacity-80 ${part.tone} ${index === running ? "outline outline-1 -outline-offset-1 outline-dashed outline-foreground/60" : ""}`}
                      style={{ height: `${value / top * 100}%`, ...(index === running ? { backgroundImage: "repeating-linear-gradient(135deg, transparent 0 3px, rgb(255 255 255 / 0.45) 3px 5px)" } : {}) }} />)}
                  </span>
                </button>;
              })}
            </div>
          </div>
          <div className="mt-2 grid text-xs text-muted-foreground" style={{ gridTemplateColumns: columns, columnGap: gap }}>
            {/* Above 8 bars every second label, ending with the last. */}
            {series.map((point, index) => <span key={point.date} className="flex min-w-0 flex-col items-center whitespace-nowrap">
              {bars <= 8 || (bars - 1 - index) % 2 === 0 || index === running ? dateLabel(point.date, index) : ""}
              {index === running && <span className="text-[10px] leading-3">so far</span>}
            </span>)}
          </div>
        </div>
      </div> : loading ? <LoadingSkeleton label={`Loading ${title}`} className="mt-auto min-h-48 pt-5">
        <div className="grid h-40 grid-cols-6 items-end gap-2 border-b border-border pb-2">{[0, 1, 2, 3, 4, 5].map((key) => <Skeleton key={key} className="h-32 w-full rounded-b-none" />)}</div>
        <div className="grid grid-cols-6 gap-2">{[0, 1, 2, 3, 4, 5].map((key) => <Skeleton key={key} className="h-3 w-full" />)}</div>
      </LoadingSkeleton> : <p role="status" className="mt-auto flex min-h-48 items-center justify-center text-center text-sm text-muted-foreground">
        {message}
      </p>}
    </figure>
  </Card>;
}
