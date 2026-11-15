import { experimental_useRpcQuery as useQuery, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../contract";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { RANGE_LABELS, RANGE_SEGMENTS, parseSubPath, toSubPath, type By } from "./format";
import { Kpis } from "./kpis";
import { Limits } from "./limits";
import { Card, Muted, SkeletonBlock, useHeld } from "./shared";
import { Breakdown, Compactions, Threads } from "./tables";
import { UsageChart } from "./usage-chart";

export function TokenomosPage({ subPath }: { subPath: string }) {
  const nav = useBbNavigate();
  const { range, by } = parseSubPath(subPath);
  const go = (r: typeof range, b: By) => nav.toPluginPanel("tokenomos", { subPath: toSubPath(r, b), replace: true });
  const query = useQuery({ contract: rpcContract, method: "summary", input: { range, by } });
  // Reads keep old data during refresh; a range switch dims the held page instead of showing skeletons.
  const { value: summary, stale, key } = useHeld(query.data, `${range}/${by}`);
  return (
    <div className="h-full overflow-y-auto p-4 md:p-5">
      <div className="mx-auto w-full max-w-5xl space-y-4">
        <Limits />
        <div className="flex flex-wrap items-center gap-3">
          <Tabs value={range} onValueChange={(v) => go(v as typeof range, by)}>
            <TabsList>{RANGE_SEGMENTS.map((r) => <TabsTrigger key={r} value={r}>{RANGE_LABELS[r]}</TabsTrigger>)}</TabsList>
          </Tabs>
          <Tabs value={by} onValueChange={(v) => go(range, v as By)}>
            <TabsList>
              <TabsTrigger value="provider">По провайдерам</TabsTrigger>
              <TabsTrigger value="model">По моделям</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        {!summary ? (query.error ? <Card><Muted>Не удалось загрузить данные.</Muted></Card> : <SkeletonBlock rows={5} />) : (
          <div className={stale ? "space-y-4 opacity-60 transition-opacity" : "space-y-4 transition-opacity"}>
            <Kpis summary={summary} />
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
