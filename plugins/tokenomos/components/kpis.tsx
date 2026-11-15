import type { Cost, Saving } from "../contract";
import { fmtCost, fmtPercent, fmtSaving, fmtTokens, totalTokens } from "./format";
import { Card } from "./shared";
import type { SummaryOutput } from "./types";

function Tile({ label, value, children }: { label: string; value: string; children?: React.ReactNode }) {
  return (
    <Card className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="space-y-0.5 text-xs text-muted-foreground">{children}</div>
    </Card>
  );
}

/** Percent change vs the previous equal period; dollars when both periods are priced, otherwise tokens. */
export function delta(now: Cost, before: Cost | null): string | null {
  if (!before) return null;
  const usd = now.usd !== null && before.usd !== null && before.usd > 0;
  const [a, b] = usd ? [now.usd!, before.usd!] : [totalTokens(now.tokens), totalTokens(before.tokens)];
  if (b <= 0) return null;
  const pct = Math.round(((a - b) / b) * 100);
  return `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct)} % к прошлому периоду${usd ? "" : " (токены)"}`;
}

function SavingNote({ s }: { s: Saving }) {
  return (
    <>
      <div>{s.usd === null ? "нет цены" : `${fmtTokens(s.tokens)} токенов`}</div>
      {s.usd !== null && s.usd < 0 && <div>затраты, а не экономия</div>}
      {s.excludesOwnCost && <div>без учёта стоимости самой компакции</div>}
      {s.partial && <div>частично</div>}
    </>
  );
}

export function Kpis({ summary }: { summary: SummaryOutput }) {
  const { totals, previous, cacheReadShare, compactionSavings: comp, localSavings: local } = summary;
  const change = delta(totals, previous);
  const t = totals.tokens;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Tile label="Расход (API-эквивалент)" value={fmtCost(totals) ?? `${fmtTokens(totalTokens(t))} ток.`}>
        {totals.usd === null && <div>нет цены</div>}
        <div>{change ?? "нет данных за прошлый период"}</div>
      </Tile>
      <Tile label="Токены" value={fmtTokens(totalTokens(t))}>
        <div>{cacheReadShare === null ? "чтение из кэша —" : `чтение из кэша ${fmtPercent(cacheReadShare)}`}</div>
        <div className="tabular-nums">вход {fmtTokens(t.freshIn)} · кэш {fmtTokens(t.cacheRead)} · запись {fmtTokens(t.cacheWrite)} · выход {fmtTokens(t.output)}</div>
      </Tile>
      <Tile label="Компакция ~" value={fmtSaving(comp) ?? `${fmtTokens(comp.tokens)} ток.`}><SavingNote s={comp} /></Tile>
      <Tile label="Локальные модели ~" value={fmtSaving(local) ?? `${fmtTokens(local.tokens)} ток.`}>
        <div>vs {local.referenceModel}</div>
        <SavingNote s={local} />
      </Tile>
    </div>
  );
}
