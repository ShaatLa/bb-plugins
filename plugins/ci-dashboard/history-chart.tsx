import { useId, useState } from "react";
import type { Metrics } from "./metrics";
import { Card } from "./components/ui/card";
import { Button } from "./components/ui/button";
import { LoadingSkeleton, Skeleton } from "./components/ui/skeleton";

export function HistoryCharts({ repo, onSelect }: {
  repo: Metrics; onSelect: (since: string, until: string) => void;
}) {
  const [expanded, setExpanded] = useState<"ci" | "deployments" | null>(null);
  const columns = expanded === "ci" ? "xl:grid-cols-[minmax(0,1fr)_minmax(0,0fr)] gap-0"
    : expanded === "deployments" ? "xl:grid-cols-[minmax(0,0fr)_minmax(0,1fr)] gap-0"
      : "xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3";
  return <div role="group" aria-label="History charts" style={{ containerType: "inline-size" }} className={`grid min-w-0 grid-cols-1 transition-[grid-template-columns,gap] duration-300 ease-in-out motion-reduce:transition-none ${columns}`}>
    {(["ci", "deployments"] as const).map((kind) => {
      const hidden = expanded !== null && expanded !== kind;
      return <div key={kind} aria-hidden={hidden || undefined} inert={hidden} className={`min-w-0 overflow-hidden transition-opacity duration-300 ease-in-out motion-reduce:transition-none ${hidden ? "hidden opacity-0 xl:block" : "opacity-100"}`}>
        {/* Keep shrinking labels from wrapping and increasing the row height. */}
        <div className="h-full xl:min-w-[calc((100cqw_-_0.75rem)/2)]">
          <HistoryChart title={kind === "ci" ? "CI pass rate over time" : "Deployment throughput"} metric={repo[kind]} range={repo.range} percent={kind === "ci"} onSelect={onSelect}
            expanded={expanded === kind} onToggle={() => setExpanded((current) => current === kind ? null : kind)} />
        </div>
      </div>;
    })}
  </div>;
}

export function HistoryChart({ title, metric, range, onSelect, percent = false, expanded, onToggle }: {
  title: string; metric: Metrics["deployments"]; range: Metrics["range"]; onSelect: (since: string, until: string) => void; percent?: boolean; expanded: boolean; onToggle: () => void;
}) {
  const headingId = useId();
  const calendarDay = range.label === "today";
  const series = metric.series?.map((point, index) => calendarDay && Date.parse(range.since) + index * range.bucketMs > Date.parse(range.until)
    ? { ...point, value: null } : point);
  const maximum = percent ? 100 : Math.max(1, ...(series?.map((point) => point.value ?? 0) ?? []));
  const format = (value: number | null) => value === null ? "—" : percent ? `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%` : value.toLocaleString();
  const dateLabel = (date: string, index: number) => calendarDay
    ? new Date(Date.parse(range.since) + index * range.bucketMs).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })
    : new Date(date).toLocaleString(undefined, { month: "short", day: "numeric", ...(range.bucketMs < 86_400_000 ? { hour: "2-digit", minute: "2-digit" } : {}), timeZone: "UTC" });
  return <Card className="h-full min-w-0 p-4">
    <figure id={`${headingId}-chart`} aria-labelledby={headingId}>
      <figcaption className="flex items-start justify-between gap-3">
        <div className="min-w-0"><h4 id={headingId} className="text-sm font-medium">{title}</h4>
        <p className="mt-1 text-xs text-muted-foreground">{range.label} · {range.bucketMs / 3_600_000}-hour intervals · UTC · click a bar for details{percent ? " · — means no runs" : ""}</p>
        </div>
        <Button type="button" variant="ghost" size="icon" className={`shrink-0 ${expanded ? "" : "hidden xl:inline-flex"}`} aria-label={`${expanded ? "Restore" : "Expand"} ${title}`} aria-expanded={expanded} aria-controls={`${headingId}-chart`} onClick={(event) => { event.currentTarget.focus(); onToggle(); }}>
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="size-4">
            <path d={expanded ? "m4 8 4 4-4 4m16-8-4 4 4 4M2 12h6m8 0h6" : "m8 8-4 4 4 4m8-8 4 4-4 4M4 12h16"} />
          </svg>
        </Button>
      </figcaption>
      {series ? <div className="mt-5 overflow-x-auto" role="group" aria-label={`${title}: ${series.map((point, index) => `${dateLabel(point.date, index)}: ${format(point.value)}`).join(", ")}`}>
        <div className="grid gap-2 border-b border-border" style={{ gridTemplateColumns: `repeat(${series.length}, minmax(38px, 1fr))` }}>
          {series.map((point, index) => {
            const since = index === 0 ? range.since : series[index - 1].date;
            // Adjacent buckets share a boundary; include it only in the later bucket.
            const until = new Date(Math.min(Date.parse(range.until), Date.parse(point.date) - (index === series.length - 1 ? 0 : 1))).toISOString();
            const upcoming = Date.parse(since) > Date.parse(range.until);
            return <button key={point.date} type="button" aria-haspopup="dialog" disabled={upcoming}
              aria-label={`${title} · ${dateLabel(point.date, index)} · ${format(point.value)} · ${upcoming ? "Upcoming interval" : "Show statistics"}`}
              onClick={(event) => { event.currentTarget.focus(); onSelect(since, until); }}
              className="flex min-w-0 cursor-pointer flex-col items-center justify-end rounded-t-md hover:bg-emerald-500/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:cursor-default disabled:opacity-50"
              title={upcoming ? "Upcoming interval" : `Interval ${new Date(since).toUTCString()} – ${new Date(until).toUTCString()}: ${format(point.value)}`}>
              <span className="mb-2 text-xs tabular-nums text-muted-foreground">{format(point.value)}</span>
              <span className="flex h-32 w-full items-end">
                <span className={`w-full rounded-t-md transition-colors ${index === series.length - 1 ? "bg-emerald-500" : "bg-emerald-500/30 hover:bg-emerald-500/60"}`} style={{ height: `${(point.value ?? 0) / maximum * 100}%` }} />
              </span>
            </button>;
          })}
        </div>
        <div className="mt-2 grid gap-2 text-center text-xs text-muted-foreground" style={{ gridTemplateColumns: `repeat(${series.length}, minmax(38px, 1fr))` }}>
          {series.map((point, index) => <span key={point.date}>{dateLabel(point.date, index)}</span>)}
        </div>
      </div> : !metric.error && !metric.seriesError && metric.detail.startsWith("Loading") ? <LoadingSkeleton label={`Loading ${title}`} className="mt-5 min-h-48">
        <div className="grid h-40 grid-cols-6 items-end gap-2 border-b border-border pb-2">{[0, 1, 2, 3, 4, 5].map((key) => <Skeleton key={key} className="h-32 w-full rounded-b-none" />)}</div>
        <div className="grid grid-cols-6 gap-2">{[0, 1, 2, 3, 4, 5].map((key) => <Skeleton key={key} className="h-3 w-full" />)}</div>
      </LoadingSkeleton> : <p role="status" className="flex min-h-48 items-center justify-center text-center text-sm text-muted-foreground">
        {metric.error || metric.seriesError || (metric.detail.startsWith("Loading") ? metric.detail : "History is unavailable.")}
      </p>}
    </figure>
  </Card>;
}
