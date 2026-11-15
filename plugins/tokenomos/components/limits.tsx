import { experimental_useRpcQuery as useQuery } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../contract";
import { cn } from "../lib/utils";
import { fmtCost, fmtReset, fmtTokens, providerName, totalTokens } from "./format";
import { Card, Muted, Section, SkeletonBlock } from "./shared";
import type { LimitsOutput } from "./types";

type Window = LimitsOutput["windows"][number];

function Meter({ percent, label }: { percent: number; label: string }) {
  const value = Math.max(0, Math.min(100, percent));
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value)}
      className="h-1 w-full overflow-hidden rounded-full bg-primary/15">
      <div className={cn("h-full rounded-full", value >= 90 ? "bg-destructive" : "bg-primary")} style={{ width: `${value}%` }} />
    </div>
  );
}

/** Top three models by money, then tokens; null byModel means the server could not attribute the window. */
function topModels(byModel: NonNullable<Window["byModel"]>) {
  const tokens = (m: (typeof byModel)[number]) => totalTokens(m.cost.tokens);
  return [...byModel].sort((a, b) => (b.cost.usd ?? -1) - (a.cost.usd ?? -1) || tokens(b) - tokens(a)).slice(0, 3);
}

function LimitRow({ w }: { w: Window }) {
  const reset = fmtReset(w.resetsAt);
  const models = w.byModel ? topModels(w.byModel) : [];
  return (
    <li className="space-y-1.5 py-2.5">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1.5 sm:grid-cols-[14rem_minmax(0,1fr)_auto_8rem]">
        <div className="min-w-0 text-sm">
          <span className="font-medium">{providerName(w.provider)}</span>
          <span className="text-muted-foreground"> · {w.label}</span>
        </div>
        <div className="order-3 col-span-2 sm:order-none sm:col-span-1"><Meter percent={w.usedPercent} label={`${providerName(w.provider)} ${w.label}`} /></div>
        <div className="text-right text-sm font-medium tabular-nums">{Math.round(w.usedPercent)} %</div>
        <div className="hidden text-right text-xs text-muted-foreground sm:block">{reset}</div>
      </div>
      {reset && <div className="text-xs text-muted-foreground sm:hidden">{reset}</div>}
      {models.length > 0 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground" aria-label="Модели в этом окне">
          {models.map((m) => (
            <li key={m.model} className="tabular-nums">
              <span className="text-foreground">{m.model}</span> {fmtCost(m.cost) ?? "нет цены"} · {fmtTokens(totalTokens(m.cost.tokens))}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function Limits() {
  const { data, isLoading } = useQuery({ contract: rpcContract, method: "limits", input: {} });
  return (
    <Section title="Лимиты">
      {!data && isLoading ? <SkeletonBlock rows={3} /> : !data?.windows.length ? (
        <Card><Muted>Нет данных о лимитах.</Muted></Card>
      ) : (
        <Card className="py-1"><ul className="divide-y divide-border">{data.windows.map((w) => <LimitRow key={`${w.provider}:${w.id}`} w={w} />)}</ul></Card>
      )}
    </Section>
  );
}
