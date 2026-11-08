import { useId, useState, type CSSProperties, type ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { Metrics } from "./metrics";
import { defaultWorkflow, type RunTrends, type TrendPoint } from "./ci-insights";
import { elapsed } from "./ci-cards";
import { Card } from "./components/ui/card";
import { Button } from "./components/ui/button";
import { LoadingSkeleton, Skeleton } from "./components/ui/skeleton";
import { chevronClass } from "./components/ui/summary";

export type ChartKey = "passRate" | "deployments" | "durationMedian" | "durationP90" | "runs" | "failedRuns" | "startDelay" | "commits" | "lines";
type Part = { key: string; sign: string; word: string; latest: string; other: string };
type ChartSpec = {
  title: string; format: (value: number) => string; note?: string;
  /** `pending` entry that must finish before a trends series exists. */
  source?: "ci" | "commitActivity"; fixedMax?: number;
  /** Run-based series that can be narrowed to one workflow. */
  byWorkflow?: boolean;
  /** Components drawn as bars side by side within one column, left to right (their values sum to the point value). */
  parts?: Part[];
};
const count = (value: number) => value.toLocaleString();
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const DEFAULT_PART = { latest: "bg-diff-added", other: "bg-diff-added/60 group-hover:bg-diff-added/80" };
export const CHARTS: Record<ChartKey, ChartSpec> = {
  passRate: { title: "CI pass rate over time", format: (value) => `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`, fixedMax: 100 },
  deployments: { title: "Deployment throughput", format: count },
  durationMedian: { byWorkflow: true, title: "Median CI run duration", format: elapsed, source: "ci", note: "successful runs" },
  durationP90: { byWorkflow: true, title: "CI run duration p90", format: elapsed, source: "ci", note: "successful runs" },
  runs: { byWorkflow: true, title: "CI runs", format: count, source: "ci", },
  failedRuns: { byWorkflow: true, title: "Failed CI runs", format: count, source: "ci" },
  startDelay: { byWorkflow: true, title: "Median wait before a run starts", format: elapsed, source: "ci", note: "first attempts" },
  commits: { title: "Commits to default branch", format: count, source: "commitActivity" },
  lines: { title: "Lines changed", format: count, source: "commitActivity", parts: [
    { key: "additions", sign: "+", word: "added", latest: "bg-diff-added", other: "bg-diff-added/60 group-hover:bg-diff-added/80" },
    { key: "deletions", sign: "−", word: "deleted", latest: "bg-diff-removed", other: "bg-diff-removed/60 group-hover:bg-diff-removed/80" },
  ] },
};
export const CHART_KEYS = Object.keys(CHARTS) as ChartKey[];
/** Trend series that arrive with each `pending` source; used to keep the previous values while it refreshes. */
export const trendKeysBySource = { ci: ["durationMedian", "durationP90", "runs", "failedRuns", "startDelay", "workflows"], commitActivity: ["commits", "lines"] } as const;
const STORAGE_KEY = "ci-dashboard:history-charts";
/** One card: the chart and, for run-based charts, the chosen workflow (undefined = the default workflow). */
type Slot = { chart: ChartKey; workflow?: number | "all" };
const DEFAULTS: [Slot, Slot] = [{ chart: "passRate" }, { chart: "deployments" }];

function readSlots(): [Slot, Slot] {
  try {
    const saved: unknown = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? "null");
    // Entries saved before workflow selection are plain chart keys.
    const slots = Array.isArray(saved) ? saved.map((entry): Slot | null => {
      const { chart, workflow } = typeof entry === "string" ? { chart: entry, workflow: undefined } : entry ?? {};
      return CHART_KEYS.includes(chart) ? { chart, ...(workflow === "all" || Number.isInteger(workflow) ? { workflow } : {}) } : null;
    }) : [];
    if (slots.length === 2 && slots[0] && slots[1] && slots[0].chart !== slots[1].chart) return [slots[0], slots[1]];
  } catch { /* unavailable or corrupt storage: use the defaults */ }
  return DEFAULTS;
}
function saveSlots(slots: [Slot, Slot]) {
  try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(slots)); } catch { /* the choice just will not persist */ }
}

export function HistoryCharts({ repo, onSelect }: {
  repo: Metrics; onSelect: (since: string, until: string) => void;
}) {
  const [slots, setSlots] = useState(readSlots);
  const [expanded, setExpanded] = useState<0 | 1 | null>(null);
  const columns = expanded === 0 ? "xl:grid-cols-[minmax(0,1fr)_minmax(0,0fr)] gap-0"
    : expanded === 1 ? "xl:grid-cols-[minmax(0,0fr)_minmax(0,1fr)] gap-0"
      : "xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3";
  return <div role="group" aria-label="History charts" style={{ containerType: "inline-size" }} className={`grid min-w-0 grid-cols-1 transition-[grid-template-columns,gap] duration-300 ease-in-out motion-reduce:transition-none ${columns}`}>
    {([0, 1] as const).map((slot) => {
      const hidden = expanded !== null && expanded !== slot;
      return <div key={slot} aria-hidden={hidden || undefined} inert={hidden} className={`min-w-0 overflow-hidden transition-opacity duration-300 ease-in-out motion-reduce:transition-none ${hidden ? "hidden opacity-0 xl:block" : "opacity-100"}`}>
        {/* Keep shrinking labels from wrapping and increasing the row height. */}
        <div className="h-full xl:min-w-[calc((100cqw_-_0.75rem)/2)]">
          <HistoryChart chart={slots[slot].chart} workflow={slots[slot].workflow} options={CHART_KEYS.filter((key) => key !== slots[1 - slot].chart)} selectLabel={slot === 0 ? "First chart" : "Second chart"}
            onChange={(change) => { const next = slots.map((current, index) => index === slot ? { ...current, ...change } : current) as [Slot, Slot]; setSlots(next); saveSlots(next); }}
            repo={repo} onSelect={onSelect} expanded={expanded === slot} onToggle={() => setExpanded((current) => current === slot ? null : slot)} />
        </div>
      </div>;
    })}
  </div>;
}

/** The workflow a run-based chart shows: the stored choice if it is still in the data, else the main pipeline; null = all workflows pooled. */
function pickWorkflow(workflows: NonNullable<NonNullable<Metrics["trends"]>["workflows"]>, choice: Slot["workflow"]) {
  return choice === "all" ? null : workflows.find((entry) => entry.id === choice) ?? defaultWorkflow(workflows) ?? null;
}

/** Series plus the state to show while there is none (loading skeleton or a message). */
function resolve(chart: ChartKey, repo: Metrics, choice: Slot["workflow"]): { series: TrendPoint[] | null; loading: boolean; message: string; workflows: { id: number; name: string }[]; selected: { id: number; name: string } | null } {
  const spec = CHARTS[chart];
  const metric = chart === "passRate" ? repo.ci : chart === "deployments" ? repo.deployments : null;
  if (metric) {
    const loading = metric.detail.startsWith("Loading");
    return { series: metric.series, loading: !metric.series && !metric.error && !metric.seriesError && loading, workflows: [], selected: null,
      message: metric.error || metric.seriesError || (loading ? metric.detail : "History is unavailable.") };
  }
  const workflows = spec.byWorkflow ? repo.trends?.workflows ?? [] : [];
  const selected = pickWorkflow(workflows, choice);
  const series = (selected ? selected[chart as keyof RunTrends] : repo.trends?.[chart as "commits"]) ?? null;
  const error = spec.source === "ci" ? repo.ci.error || repo.ci.seriesError : repo.commitActivity.error;
  return { series, loading: !series && !!repo.pending?.includes(spec.source!), message: error || "History is unavailable.", workflows, selected };
}

export function HistoryChart({ chart, workflow, options, selectLabel, onChange, repo, onSelect, expanded, onToggle }: {
  chart: ChartKey; workflow: Slot["workflow"]; options: ChartKey[]; selectLabel: string; onChange: (change: Partial<Slot>) => void;
  repo: Metrics; onSelect: (since: string, until: string) => void; expanded: boolean; onToggle: () => void;
}) {
  const headingId = useId();
  const { title, format: formatValue, note, fixedMax, parts } = CHARTS[chart];
  const range = repo.range;
  const { series: raw, loading, message, workflows, selected } = resolve(chart, repo, workflow);
  const calendarDay = range.label === "today";
  const series = raw?.map((point, index) => calendarDay && Date.parse(range.since) + index * range.bucketMs > Date.parse(range.until)
    ? { date: point.date, value: null } : point);
  const partValues = (point: TrendPoint) => parts?.map((part) => ({ part, value: point.parts?.find((entry) => entry.key === part.key)?.value ?? 0 }));
  // Grouped charts scale to the largest single part, not to the column total.
  const maximum = fixedMax ?? Math.max(1, ...(series?.flatMap((point) => partValues(point)?.map((entry) => entry.value) ?? [point.value ?? 0]) ?? []));
  // Full text for labels and tooltips; the bar label itself may be compacted for grouped charts.
  const format = (point: TrendPoint) => point.value === null ? "—"
    : parts ? partValues(point)!.map(({ part, value }) => `${value.toLocaleString()} ${part.word}`).join(", ") : formatValue(point.value);
  const shortFormat = (point: TrendPoint) => parts && point.value ?  partValues(point)!.map(({ part, value }) => `${part.sign}${compact.format(value)}`).join(" ") : point.value === null ? "—" : formatValue(point.value);
  const dateLabel = (_date: string, index: number) => calendarDay
    ? new Date(Date.parse(range.since) + index * range.bucketMs).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })
    // A bar is labelled with its start (each point's date is its end): a calendar-day bar reads as that day.
    : new Date(index === 0 ? range.since : series![index - 1]!.date).toLocaleString(undefined, { month: "short", day: "numeric", ...(range.bucketMs < 86_400_000 ? { hour: "2-digit", minute: "2-digit" } : {}), timeZone: "UTC" });
  return <Card className="flex h-full min-w-0 flex-col p-4">
    {/* Bars sit at the bottom so both cards share a baseline whatever their header height. */}
    <figure id={`${headingId}-chart`} aria-label={title} className="flex flex-1 flex-col">
      <figcaption className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <ChevronSelect id={headingId} label={selectLabel} value={chart} onChange={(value) => onChange({ chart: value as ChartKey })} className="text-sm font-medium text-foreground hover:text-foreground/80">
            {options.map((key) => <option key={key} value={key}>{CHARTS[key].title}</option>)}
          </ChevronSelect>
          <p className="mt-1 text-xs text-muted-foreground">{[range.bucketMs === 86_400_000 ? null : `${range.bucketMs / 3_600_000}-hour intervals`, note].filter(Boolean).join(" · ")}
            {parts?.map((part) => <span key={part.key} className="ml-2 whitespace-nowrap"><span aria-hidden="true" className={`mr-1 inline-block size-2 rounded-sm align-baseline ${part.latest}`} />{part.word}</span>)}</p>
          {workflows.length > 0 && <div className="mt-1">
            <ChevronSelect label={`${selectLabel} workflow`} value={selected ? String(selected.id) : "all"} className="text-xs text-muted-foreground hover:text-foreground"
              onChange={(value) => onChange({ workflow: value === "all" ? "all" : Number(value) })}>
              <option value="all">All workflows</option>
              {workflows.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
            </ChevronSelect>
          </div>}
        </div>
        <Button type="button" variant="ghost" size="icon" className={`shrink-0 ${expanded ? "" : "hidden xl:inline-flex"}`} aria-label={`${expanded ? "Restore" : "Expand"} ${title}`} aria-expanded={expanded} aria-controls={`${headingId}-chart`} onClick={(event) => { event.currentTarget.focus(); onToggle(); }}>
          <Icon name={expanded ? "Minimize2" : "Maximize2"} aria-hidden className="size-4" />
        </Button>
      </figcaption>
      {series ? <div className="mt-auto overflow-x-auto pt-5" role="group" aria-label={`${title}: ${series.map((point, index) => `${dateLabel(point.date, index)}: ${format(point)}`).join(", ")}`}>
        <div className="grid gap-2 border-b border-border" style={{ gridTemplateColumns: `repeat(${series.length}, minmax(38px, 1fr))` }}>
          {series.map((point, index) => {
            const since = index === 0 ? range.since : series[index - 1].date;
            // Adjacent buckets share a boundary; include it only in the later bucket.
            const until = new Date(Math.min(Date.parse(range.until), Date.parse(point.date) - (index === series.length - 1 ? 0 : 1))).toISOString();
            const upcoming = Date.parse(since) > Date.parse(range.until);
            return <button key={point.date} type="button" aria-haspopup="dialog" disabled={upcoming}
              aria-label={`${title} · ${dateLabel(point.date, index)} · ${format(point)} · ${upcoming ? "Upcoming interval" : "Show statistics"}`}
              onClick={(event) => { event.currentTarget.focus(); onSelect(since, until); }}
              className="group flex min-w-0 cursor-pointer flex-col items-center justify-end rounded-t-md hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50"
              title={upcoming ? "Upcoming interval" : `Interval ${new Date(since).toUTCString()} – ${new Date(until).toUTCString()}: ${format(point)}`}>
              <span className="mb-2 text-xs tabular-nums text-muted-foreground">{shortFormat(point)}</span>
              <span className="flex h-32 w-full items-end">
                {/* Parts are bars side by side from the axis; a plain series is a single green part. */}
                <span className="flex h-full w-full items-end gap-0.5">
                  {(partValues(point) ?? [{ part: DEFAULT_PART, value: point.value ?? 0 }]).map(({ part, value }, partIndex) => <span key={partIndex}
                    className={`min-w-0 flex-1 rounded-t-md transition-colors ${index === series.length - 1 ? part.latest : part.other}`} style={{ height: `${value / maximum * 100}%` }} />)}
                </span>
              </span>
            </button>;
          })}
        </div>
        <div className="mt-2 grid gap-2 text-center text-xs text-muted-foreground" style={{ gridTemplateColumns: `repeat(${series.length}, minmax(38px, 1fr))` }}>
          {series.map((point, index) => <span key={point.date}>{dateLabel(point.date, index)}</span>)}
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

/** A borderless select that reads as text, with a chevron so it still looks like a control. */
function ChevronSelect({ id, label, value, onChange, className, children }: {
  id?: string; label: string; value: string; onChange: (value: string) => void; className: string; children: ReactNode;
}) {
  return <span className="relative inline-flex max-w-full items-center">
    <select id={id} aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} style={{ fieldSizing: "content" } as CSSProperties}
      className={`max-w-full cursor-pointer appearance-none truncate rounded-sm bg-transparent py-0.5 pr-5 outline-none hover:bg-state-hover focus-visible:bg-state-hover ${className}`}>
      {children}
    </select>
    <Icon name="ChevronDown" aria-hidden className={`pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 ${chevronClass}`} />
  </span>;
}
