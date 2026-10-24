import { useId } from "react";
import type { Metrics } from "./metrics";
import { Card } from "./components/ui/card";

export function HistoryChart({ title, metric, range, onSelect, percent = false }: {
  title: string; metric: Metrics["deployments"]; range: Metrics["range"]; onSelect: (since: string, until: string) => void; percent?: boolean;
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
  return <Card className="p-4">
    <figure aria-labelledby={headingId}>
      <figcaption>
        <h4 id={headingId} className="text-sm font-medium">{title}</h4>
        <p className="mt-1 text-xs text-muted-foreground">{range.label} · {range.bucketMs / 3_600_000}-hour intervals · UTC · click a bar for details{percent ? " · — means no runs" : ""}</p>
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
      </div> : <p role="status" className="flex min-h-48 items-center justify-center text-center text-sm text-muted-foreground">
        {metric.error || metric.seriesError || (metric.detail.startsWith("Loading") ? metric.detail : "History is unavailable.")}
      </p>}
    </figure>
  </Card>;
}
