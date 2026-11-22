import { useState } from "react";
import { experimental_Icon as Icon, experimental_useRpcQuery as useQuery, useBbNavigate, useSettings } from "@get-bb/plugin-sdk/app";
import { Button } from "./ui/button";
import { rpcContract } from "../contract";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { METRICS, RANGE_SEGMENTS, parseSubPath, toSubPath, type By, type Metric } from "./format";
import type { Range } from "../contract";

const RANGE_KEY = "tokenomos:range", METRIC_KEY = "tokenomos:metric";
const readMetric = (): Metric => {
  try { const m = localStorage.getItem(METRIC_KEY); return (METRICS as readonly string[]).includes(m ?? "") ? (m as Metric) : "cost"; } catch { return "cost"; }
};
const remember = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* storage unavailable: the choice lasts this visit */ } };
const readRange = (): Range => {
  try { const r = localStorage.getItem(RANGE_KEY); return (RANGE_SEGMENTS as readonly string[]).includes(r ?? "") ? (r as Range) : "week"; } catch { return "week"; }
};
import { ActivityHeatmap } from "./activity";
import { BackfillBanner, useBackfilling } from "./backfill";
import { useT } from "./i18n";
import { Kpis } from "./kpis";
import { TokenMix } from "./mix";
import { Card, Muted, SkeletonBlock, scope, useHeld } from "./shared";
import { Compactions, Threads } from "./tables";
import { Watchlist } from "./watchlist";
import { Limits } from "./limits";
import { UsageChart } from "./usage-chart";

// Radix Select forbids an empty item value, so "all projects" gets a sentinel.
const ALL = "__all__";

/** "All projects" plus the known projects; a project from the URL that is not listed stays selectable. */
function ProjectSelect({ value, onChange }: { value?: string; onChange: (project?: string) => void }) {
  const t = useT();
  const { data } = useQuery({ contract: rpcContract, method: "projects", input: {} });
  const items = data?.items ?? [];
  return (
    <Select value={value ?? ALL} onValueChange={(v) => onChange(v === ALL ? undefined : v)}>
      <SelectTrigger aria-label={t("project.label")} className="w-auto min-w-40 max-w-56 gap-3"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{t("project.all")}</SelectItem>
        {value && !items.some((p) => p.projectId === value) && <SelectItem value={value}>{value}</SelectItem>}
        {items.map((p) => <SelectItem key={p.projectId} value={p.projectId}>{p.name}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

export function TokenomosPage({ subPath }: { subPath: string }) {
  const nav = useBbNavigate();
  const t = useT();
  const backfill = useBackfilling();
  // The metric is remembered in this browser too.
  const [metric, setMetricState] = useState<Metric>(readMetric);
  const setMetric = (m: Metric) => { setMetricState(m); remember(METRIC_KEY, m); };
  const defaultBy: By = useSettings().values?.defaultGrouping === "model" ? "model" : "provider";
  // The last range the user picked is remembered in this browser and used when the link names none.
  const { range, by, project } = parseSubPath(subPath, defaultBy, readRange());
  const go = (r: typeof range, b: By, p?: string) => {
    remember(RANGE_KEY, r);
    nav.toPluginPanel("tokenomos", { subPath: toSubPath(r, b, p), replace: true });
  };
  const query = useQuery({ contract: rpcContract, method: "summary", input: { range, by, ...scope(project) } });
  // Reads keep old data during refresh; a range switch dims the held page instead of showing skeletons.
  const { value: summary, stale, key } = useHeld(query.data, `${range}/${by}/${project ?? ""}`);
  return (
    <div className="h-full overflow-y-auto p-4 md:p-5">
      <div className="mx-auto w-full max-w-6xl space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <Tabs value={range} onValueChange={(v) => go(v as typeof range, by, project)}>
            <TabsList aria-label={t("range.label")}>{RANGE_SEGMENTS.map((r) => <TabsTrigger key={r} value={r}>{t(`range.${r}`)}</TabsTrigger>)}</TabsList>
          </Tabs>
          <Tabs value={metric} onValueChange={(v) => setMetric(v as Metric)}>
            <TabsList aria-label={t("metric.label")}>{METRICS.map((m) => <TabsTrigger key={m} value={m}>{t(`metric.${m}`)}</TabsTrigger>)}</TabsList>
          </Tabs>
          <ProjectSelect value={project} onChange={(p) => go(range, by, p)} />
          <Tabs value={by} onValueChange={(v) => go(range, v as By, project)}>
            <TabsList aria-label={t("by.label")}>
              <TabsTrigger value="provider">{t("by.provider")}</TabsTrigger>
              <TabsTrigger value="model">{t("by.model")}</TabsTrigger>
            </TabsList>
          </Tabs>
          <Button asChild variant="ghost" size="icon" className="ml-auto size-8 text-muted-foreground hover:text-foreground">
            <a href="/settings/plugins/tokenomos" aria-label={t("settings.open")} title={t("settings.open")}>
              <Icon name="Settings" className="size-4" aria-hidden />
            </a>
          </Button>
        </div>
        {!summary ? (query.error ? <Card><Muted>{t("loadError")}</Muted></Card> : <SkeletonBlock rows={5} />) : (
          <div className={stale ? "space-y-4 opacity-60 transition-opacity" : "space-y-4 transition-opacity"}>
            <Kpis summary={summary} incomplete={!!backfill} />
            <UsageChart summary={summary} by={key.split("/")[1] === "model" ? "model" : "provider"} metric={metric} stale={false} />
          </div>
        )}
        {/* Limits matter more than the token mix and hours, and do not depend on the range, so they sit between. */}
        <Limits />
        {summary && (
          <div className={stale ? "grid grid-cols-1 gap-4 opacity-60 transition-opacity lg:grid-cols-2" : "grid grid-cols-1 gap-4 transition-opacity lg:grid-cols-2"}>
            <TokenMix summary={summary} />
            <ActivityHeatmap summary={summary} metric={metric} range={summary.range} />
          </div>
        )}
        <Watchlist />
        <Threads range={range} project={project} />
        <Compactions range={range} project={project} />
        <BackfillBanner backfill={backfill} />
      </div>
    </div>
  );
}
