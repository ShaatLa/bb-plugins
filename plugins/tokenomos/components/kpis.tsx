import type { Cost, Saving } from "../contract";
import { fmtCost, fmtInt, fmtPercent, fmtSaving, fmtTokens, fmtUsd, pctChange, totalTokens } from "./format";
import { useT, type T } from "./i18n";
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
export function delta(now: Cost, before: Cost | null, t: T): string | null {
  if (!before) return null;
  const usd = now.usd !== null && before.usd !== null && before.usd > 0;
  const [a, b] = usd ? [now.usd!, before.usd!] : [totalTokens(now.tokens), totalTokens(before.tokens)];
  const value = pctChange(a, b, t);
  return value && t(usd ? "kpi.deltaUsd" : "kpi.deltaTokens", { value });
}

const vsPrevious = (now: number, before: number | null, t: T) => {
  const value = pctChange(now, before, t);
  return value ? t("kpi.vsPrevious", { value }) : t("kpi.noPrevious");
};

function SavingNote({ s, t }: { s: Saving; t: T }) {
  return (
    <>
      <div>{s.usd === null ? t("noPrice") : t("saving.tokens", { tokens: fmtTokens(s.tokens, t) })}</div>
      {s.usd !== null && s.usd < 0 && <div>{t("saving.cost")}</div>}
      {s.excludesOwnCost && <div>{t("saving.excludesOwnCost")}</div>}
      {s.partial && <div>{t("saving.partial")}</div>}
    </>
  );
}

/** `incomplete` marks money as approximate while the history import is still running. */
export function Kpis({ summary, incomplete = false }: { summary: SummaryOutput; incomplete?: boolean }) {
  const t = useT();
  const { kpis, totals, previous, compactionSavings: comp, localSavings: local } = summary;
  const noMoney = (n: number) => t("tokShort", { value: fmtTokens(n, t) });
  const spend = fmtCost({ usd: kpis.spendUsd, estimated: kpis.estimated || incomplete, partial: kpis.partial }, t);
  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label={t("kpi.spend")} value={spend ?? noMoney(totalTokens(totals.tokens))}>
          {spend === null && <div>{t("noPrice")}</div>}
          <div>{delta(totals, previous, t) ?? t("kpi.noPrevious")}</div>
        </Tile>
        <Tile label={t("kpi.threads")} value={fmtInt(kpis.threads, t)}><div>{t("kpi.threadsSub")}</div></Tile>
        <Tile label={t("kpi.median")} value={kpis.medianThreadUsd === null ? "—" : fmtUsd(kpis.medianThreadUsd, t)}>
          <div>{kpis.perCallUsd === null ? t("noPrice") : t("kpi.perCall", { value: fmtUsd(kpis.perCallUsd, t) })}</div>
        </Tile>
        <Tile label={t("kpi.cacheHit")} value={kpis.cacheHitRate === null ? "—" : fmtPercent(kpis.cacheHitRate, t)}><div>{t("kpi.cacheHitSub")}</div></Tile>
        <Tile label={t("kpi.tokens")} value={fmtTokens(kpis.tokens, t)}><div>{vsPrevious(kpis.tokens, kpis.tokensPrev, t)}</div></Tile>
        <Tile label={t("kpi.calls")} value={fmtInt(kpis.calls, t)}><div>{vsPrevious(kpis.calls, kpis.callsPrev, t)}</div></Tile>
        <Tile label={t("kpi.compaction")} value={fmtSaving(comp, t) ?? noMoney(comp.tokens)}><SavingNote s={comp} t={t} /></Tile>
        <Tile label={t("kpi.local")} value={fmtSaving(local, t) ?? noMoney(local.tokens)}>
          <div>{t("kpi.vsModel", { model: local.referenceModel })}</div>
          <SavingNote s={local} t={t} />
        </Tile>
      </div>
      <p className="text-xs text-muted-foreground">{t("kpi.footnote")}</p>
    </div>
  );
}
