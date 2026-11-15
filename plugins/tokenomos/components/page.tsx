import { useState } from "react";
import { experimental_useRpcQuery as useQuery, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../contract";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { NativeSelect } from "./ui/native-select";
import { METRICS, RANGE_SEGMENTS, parseSubPath, toSubPath, type By, type Metric } from "./format";
import { ActivityHeatmap } from "./activity";
import { BackfillBanner, useBackfilling } from "./backfill";
import { useT } from "./i18n";
import { Kpis } from "./kpis";
import { TokenMix } from "./mix";
import { Card, Muted, SkeletonBlock, scope, useHeld } from "./shared";
import { Compactions, Threads } from "./tables";
import { Watchlist } from "./watchlist";
import { UsageChart } from "./usage-chart";

/** "All projects" plus the known projects; a project from the URL that is not listed stays selectable. */
function ProjectSelect({ value, onChange }: { value?: string; onChange: (project?: string) => void }) {
  const t = useT();
  const { data } = useQuery({ contract: rpcContract, method: "projects", input: {} });
  const items = data?.items ?? [];
  return (
    <NativeSelect aria-label={t("project.label")} value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)}>
      <option value="">{t("project.all")}</option>
      {value && !items.some((p) => p.projectId === value) && <option value={value}>{value}</option>}
      {items.map((p) => <option key={p.projectId} value={p.projectId}>{p.name}</option>)}
    </NativeSelect>
  );
}

export function TokenomosPage({ subPath }: { subPath: string }) {
  const nav = useBbNavigate();
  const t = useT();
  const backfill = useBackfilling();
  const [metric, setMetric] = useState<Metric>("cost");
  const { range, by, project } = parseSubPath(subPath);
  const go = (r: typeof range, b: By, p?: string) => nav.toPluginPanel("tokenomos", { subPath: toSubPath(r, b, p), replace: true });
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
        </div>
        {!summary ? (query.error ? <Card><Muted>{t("loadError")}</Muted></Card> : <SkeletonBlock rows={5} />) : (
          <div className={stale ? "space-y-4 opacity-60 transition-opacity" : "space-y-4 transition-opacity"}>
            <Kpis summary={summary} incomplete={!!backfill} />
            <UsageChart summary={summary} by={key.split("/")[1] === "model" ? "model" : "provider"} metric={metric} stale={false} />
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <TokenMix summary={summary} />
              <ActivityHeatmap summary={summary} metric={metric} range={summary.range} />
            </div>
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
