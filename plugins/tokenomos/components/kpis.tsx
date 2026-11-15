import type { Cost, Saving } from "../contract";
import { fmtCost, fmtPercent, fmtSaving, fmtTokens, totalTokens } from "./format";
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
  if (b <= 0) return null;
  const pct = Math.round(((a - b) / b) * 100);
  const value = `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${fmtPercent(Math.abs(pct) / 100, t)}`;
  return t(usd ? "kpi.deltaUsd" : "kpi.deltaTokens", { value });
}

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
  const { totals, previous, cacheReadShare, compactionSavings: comp, localSavings: local } = summary;
  const change = delta(totals, previous, t);
  const tok = (n: number) => fmtTokens(n, t);
  const noMoney = (n: number) => t("tokShort", { value: tok(n) });
  const tk = totals.tokens;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Tile label={t("kpi.spend")} value={fmtCost({ ...totals, estimated: totals.estimated || incomplete }, t) ?? noMoney(totalTokens(tk))}>
        {totals.usd === null && <div>{t("noPrice")}</div>}
        <div>{change ?? t("kpi.noPrevious")}</div>
      </Tile>
      <Tile label={t("kpi.tokens")} value={tok(totalTokens(tk))}>
        <div>{cacheReadShare === null ? t("kpi.cacheReadNone") : t("kpi.cacheRead", { value: fmtPercent(cacheReadShare, t) })}</div>
        <div className="tabular-nums">{t("kpi.split", { freshIn: tok(tk.freshIn), cacheRead: tok(tk.cacheRead), cacheWrite: tok(tk.cacheWrite), output: tok(tk.output) })}</div>
      </Tile>
      <Tile label={t("kpi.compaction")} value={fmtSaving(comp, t) ?? noMoney(comp.tokens)}><SavingNote s={comp} t={t} /></Tile>
      <Tile label={t("kpi.local")} value={fmtSaving(local, t) ?? noMoney(local.tokens)}>
        <div>{t("kpi.vsModel", { model: local.referenceModel })}</div>
        <SavingNote s={local} t={t} />
      </Tile>
    </div>
  );
}
