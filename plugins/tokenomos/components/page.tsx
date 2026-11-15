import { experimental_useRpcQuery as useQuery, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../contract";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { RANGE_SEGMENTS, parseSubPath, toSubPath, type By } from "./format";
import { BackfillBanner, useBackfilling } from "./backfill";
import { useT } from "./i18n";
import { Kpis } from "./kpis";
import { Card, Muted, SkeletonBlock, useHeld } from "./shared";
import { Breakdown, Compactions, Threads } from "./tables";
import { UsageChart } from "./usage-chart";

export function TokenomosPage({ subPath }: { subPath: string }) {
  const nav = useBbNavigate();
  const t = useT();
  const backfill = useBackfilling();
  const { range, by } = parseSubPath(subPath);
  const go = (r: typeof range, b: By) => nav.toPluginPanel("tokenomos", { subPath: toSubPath(r, b), replace: true });
  const query = useQuery({ contract: rpcContract, method: "summary", input: { range, by } });
  // Reads keep old data during refresh; a range switch dims the held page instead of showing skeletons.
  const { value: summary, stale, key } = useHeld(query.data, `${range}/${by}`);
  return (
    <div className="h-full overflow-y-auto p-4 md:p-5">
      <div className="mx-auto w-full max-w-5xl space-y-4">
        <BackfillBanner backfill={backfill} />
        <div className="flex flex-wrap items-center gap-3">
          <Tabs value={range} onValueChange={(v) => go(v as typeof range, by)}>
            <TabsList>{RANGE_SEGMENTS.map((r) => <TabsTrigger key={r} value={r}>{t(`range.${r}`)}</TabsTrigger>)}</TabsList>
          </Tabs>
          <Tabs value={by} onValueChange={(v) => go(range, v as By)}>
            <TabsList>
              <TabsTrigger value="provider">{t("by.provider")}</TabsTrigger>
              <TabsTrigger value="model">{t("by.model")}</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        {!summary ? (query.error ? <Card><Muted>{t("loadError")}</Muted></Card> : <SkeletonBlock rows={5} />) : (
          <div className={stale ? "space-y-4 opacity-60 transition-opacity" : "space-y-4 transition-opacity"}>
            <Kpis summary={summary} incomplete={!!backfill} />
            <UsageChart summary={summary} by={key.endsWith("/model") ? "model" : "provider"} stale={false} />
            <Breakdown summary={summary} />
          </div>
        )}
        <Threads range={range} />
        <Compactions range={range} />
      </div>
    </div>
  );
}
