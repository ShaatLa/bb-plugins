import { fmtPercent, fmtTokens, fmtUsd } from "./format";
import { seriesColor } from "./colors";
import { useT, type Key, type T } from "./i18n";
import { Card, Muted } from "./shared";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import type { SummaryOutput } from "./types";

type Component = SummaryOutput["mix"]["rows"][number]["component"];
// Six columns share a half-width card, so numeric cells use tighter padding.
const num = "px-1 text-right tabular-nums";
const share = (v: number, total: number) => (total > 0 ? v / total : null);

/** One thin segmented bar: widths follow the shares, a 2px gap separates parts, zero parts draw nothing. */
function ShareBar({ label, parts, t }: { label: string; parts: { id: Component; slot: number; value: number; name: string }[]; t: T }) {
  const total = parts.reduce((sum, p) => sum + p.value, 0);
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      {total > 0 ? (
        <div role="img" aria-label={`${label}: ${parts.filter((p) => p.value > 0).map((p) => `${p.name} ${fmtPercent(p.value / total, t)}`).join(", ")}`} className="flex h-2 gap-0.5 overflow-hidden rounded-full">
          {parts.filter((p) => p.value > 0).map((p) => (
            <span key={p.id} title={`${p.name}: ${fmtPercent(p.value / total, t)}`} className="h-full min-w-0.5 first:rounded-l-full last:rounded-r-full" style={{ flexGrow: p.value, flexBasis: 0, background: seriesColor(p.slot) }} />
          ))}
        </div>
      ) : <div className="h-2 rounded-full bg-muted" role="img" aria-label={`${label}: ${t("noPrice")}`} />}
    </div>
  );
}

/** Token mix: the same four components as share of tokens and share of cost, then the per-component table. */
export function TokenMix({ summary }: { summary: SummaryOutput }) {
  const t = useT();
  const { rows, reasoningTokens } = summary.mix;
  const tokenTotal = rows.reduce((sum, r) => sum + r.tokens, 0);
  const costTotal = rows.reduce((sum, r) => sum + (r.usd ?? 0), 0);
  const priced = rows.some((r) => r.usd !== null);
  const name = (c: Component) => t(`mix.${c}` as Key);
  const slot: Record<Component, number> = { freshIn: 1, cacheWrite: 2, cacheRead: 3, output: 4 };
  const pct = (v: number | null) => (v === null ? "—" : fmtPercent(v, t));
  return (
    <Card className="space-y-3">
      <div>
        <h2 className="text-sm font-medium text-foreground">{t("mix.title")}</h2>
        <Muted>{t("mix.subtitle")}</Muted>
      </div>
      {tokenTotal === 0 ? <Muted>{t("mix.empty")}</Muted> : (
        <>
          <div className="space-y-2">
            <ShareBar label={t("mix.tokensBar")} t={t} parts={rows.map((r) => ({ id: r.component, slot: slot[r.component], value: r.tokens, name: name(r.component) }))} />
            <ShareBar label={t("mix.costBar")} t={t} parts={rows.map((r) => ({ id: r.component, slot: slot[r.component], value: r.usd ?? 0, name: name(r.component) }))} />
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("mix.component")}</TableHead>
                <TableHead className={num}>{t("mix.tokens")}</TableHead>
                <TableHead className={num}>{t("mix.share")}</TableHead>
                <TableHead className={num}>{t("mix.cost")}</TableHead>
                <TableHead className={num}>{t("mix.share")}</TableHead>
                <TableHead className={num}>{t("mix.perMTok")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.component}>
                  <TableCell className="whitespace-nowrap">
                    <span aria-hidden className="mr-2 inline-block size-2.5 rounded-[2px] align-middle" style={{ background: seriesColor(slot[r.component]) }} />
                    {name(r.component)}
                  </TableCell>
                  <TableCell className={num}>{fmtTokens(r.tokens, t)}</TableCell>
                  <TableCell className={num}>{pct(share(r.tokens, tokenTotal))}</TableCell>
                  <TableCell className={num}>{r.usd === null ? "—" : fmtUsd(r.usd, t)}</TableCell>
                  <TableCell className={num}>{pct(r.usd === null || !priced ? null : share(r.usd, costTotal))}</TableCell>
                  <TableCell className={num}>{r.usdPerMTok === null ? "—" : fmtUsd(r.usdPerMTok, t)}</TableCell>
                </TableRow>
              ))}
              {reasoningTokens > 0 && (
                <TableRow className="text-muted-foreground">
                  <TableCell className="whitespace-nowrap pl-7">{t("mix.reasoning")}</TableCell>
                  <TableCell className={num}>{fmtTokens(reasoningTokens, t)}</TableCell>
                  <TableCell className={num}>{pct(share(reasoningTokens, tokenTotal))}</TableCell>
                  <TableCell className={num}>—</TableCell><TableCell className={num}>—</TableCell><TableCell className={num}>—</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </>
      )}
    </Card>
  );
}
