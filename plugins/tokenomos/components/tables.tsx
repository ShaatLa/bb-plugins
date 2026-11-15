import { useEffect, useState } from "react";
import { experimental_useRpcQuery as useQuery, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { rpcContract, type Range } from "../contract";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { fmtCost, fmtInt, fmtSaving, fmtTokens, fmtWhen, providerName } from "./format";
import { useT, type T } from "./i18n";
import { Card, Muted, Section, SkeletonBlock, useHeld } from "./shared";
import type { SummaryOutput } from "./types";

const num = "text-right tabular-nums";

/** The server labels provider rows with the raw id, so known providers get their display name. */
const rowName = (b: { key: string; label: string }, t: T) => {
  const name = providerName(b.key, t);
  return name === b.key ? b.label : name;
};

export function Breakdown({ summary }: { summary: SummaryOutput }) {
  const t = useT();
  return (
    <Section title={t("breakdown.title")}>
      <Card className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("breakdown.name")}</TableHead>
              <TableHead className={num}>{t("breakdown.freshIn")}</TableHead>
              <TableHead className={num}>{t("breakdown.cacheRead")}</TableHead>
              <TableHead className={num}>{t("breakdown.cacheWrite")}</TableHead>
              <TableHead className={num}>{t("breakdown.output")}</TableHead>
              <TableHead className={num}>{t("breakdown.calls")}</TableHead>
              <TableHead className={num}>~$</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {summary.breakdown.length === 0 && <TableRow><TableCell colSpan={7} className="text-muted-foreground">{t("breakdown.empty")}</TableCell></TableRow>}
            {summary.breakdown.map((b) => (
              <TableRow key={b.key}>
                <TableCell className="font-medium">{rowName(b, t)}</TableCell>
                <TableCell className={num}>{fmtTokens(b.cost.tokens.freshIn, t)}</TableCell>
                <TableCell className={num}>{fmtTokens(b.cost.tokens.cacheRead, t)}</TableCell>
                <TableCell className={num}>{fmtTokens(b.cost.tokens.cacheWrite, t)}</TableCell>
                <TableCell className={num}>{fmtTokens(b.cost.tokens.output, t)}</TableCell>
                <TableCell className={num}>{fmtInt(b.calls, t)}</TableCell>
                <TableCell className={num}>{fmtCost(b.cost, t) ?? t("noPrice")}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </Section>
  );
}

const PAGE = 50;

/** One page of top threads; the last mounted page offers "More" while the server says more exist. */
function ThreadsPage({ range, offset, isLast, onMore }: { range: Range; offset: number; isLast: boolean; onMore: () => void }) {
  const { toThread } = useBbNavigate();
  const t = useT();
  const query = useQuery({ contract: rpcContract, method: "topThreads", input: { range, offset, limit: PAGE } });
  const { value: data, stale } = useHeld(query.data, range);
  if (!data) return query.isLoading ? <SkeletonBlock rows={3} /> : null;
  return (
    <ul className={stale ? "divide-y divide-border opacity-60" : "divide-y divide-border"}>
      {data.items.map((th) => (
        <li key={th.threadId}>
          <button type="button" onClick={() => toThread(th.threadId)}
            className="grid w-full grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-4 px-3 py-2 text-left text-sm hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
            <span className="min-w-0 truncate">{th.title || th.threadId}<span className="text-xs text-muted-foreground"> · {providerName(th.provider, t)}</span></span>
            <span className={`${num} w-20`} title={t("threads.ownTitle")}>{fmtCost(th.own, t) ?? t("noPrice")}</span>
            <span className={`${num} w-32 text-muted-foreground`} title={t("threads.totalTitle")}>{fmtCost(th.total, t) ?? t("noPrice")}</span>
          </button>
        </li>
      ))}
      {isLast && data.hasMore && <li className="p-2"><Button variant="ghost" size="sm" onClick={onMore}>{t("threads.more")}</Button></li>}
    </ul>
  );
}

export function Threads({ range }: { range: Range }) {
  const t = useT();
  return <Section title={t("threads.title")} collapseKey="threads"><ThreadsBody range={range} /></Section>;
}

function ThreadsBody({ range }: { range: Range }) {
  const t = useT();
  const [pages, setPages] = useState(1);
  const first = useQuery({ contract: rpcContract, method: "topThreads", input: { range, offset: 0, limit: PAGE } });
  useEffect(() => setPages(1), [range]);
  return first.data && first.data.items.length === 0 ? <Card><Muted>{t("threads.empty")}</Muted></Card> : (
    <Card className="p-0">
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-4 whitespace-nowrap border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
        <span>{t("threads.thread")}</span><span className={`${num} w-20`}>{t("threads.own")}</span><span className={`${num} w-32`}>{t("threads.total")}</span>
      </div>
      <div className="divide-y divide-border">
        {Array.from({ length: pages }, (_, i) => <ThreadsPage key={i} range={range} offset={i * PAGE} isLast={i === pages - 1} onMore={() => setPages(pages + 1)} />)}
      </div>
    </Card>
  );
}

export function Compactions({ range }: { range: Range }) {
  const { toThread } = useBbNavigate();
  const t = useT();
  const query = useQuery({ contract: rpcContract, method: "compactions", input: { range } });
  const { value: data, stale } = useHeld(query.data, range);
  return (
    <Section title={t("compactions.title")} collapseKey="compactions" action={data && data.items.length > 0 ? <CompactionTotal items={data.items} /> : null}>
      {!data && query.isLoading ? <SkeletonBlock rows={2} /> : !data?.items.length ? <Card><Muted>{t("compactions.empty")}</Muted></Card> : (
        <Card className={stale ? "p-0 opacity-60" : "p-0"}>
          <ul className="divide-y divide-border">
            {data.items.map((c) => {
              const net = fmtSaving(c.saving, t);
              return (
                <li key={c.id}>
                  <button type="button" onClick={() => toThread(c.threadId)}
                    className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-0.5 px-3 py-2 text-left text-sm hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                    <span className="min-w-0 truncate">{c.title || c.threadId}</span>
                    <span className={`${num} font-medium`}>{net ? `${net}${c.saving.usd! < 0 ? ` ${t("compactions.cost")}` : ""}` : t("tokShort", { value: fmtTokens(c.saving.tokens, t) })}</span>
                    <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground tabular-nums">
                      {fmtWhen(c.at, t)} · {fmtTokens(c.beforeTokens, t)} → {fmtTokens(c.afterTokens, t)}
                      <Badge variant="outline" className="px-1.5 py-0 font-normal">{t(`origin.${c.origin}`)}</Badge>
                    </span>
                    <span className="text-right text-xs text-muted-foreground">
                      {c.saving.excludesOwnCost && t("saving.excludesOwnCost")}{c.saving.excludesOwnCost && c.saving.partial && " · "}{c.saving.partial && t("saving.partial")}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </Section>
  );
}

/** Overall saving for the period: sum of known estimates, with the count of compactions that have no estimate. */
function CompactionTotal({ items }: { items: { saving: { usd: number | null; partial: boolean; excludesOwnCost: boolean } }[] }) {
  const t = useT();
  const known = items.filter((c) => c.saving.usd !== null);
  const usd = known.reduce((sum, c) => sum + (c.saving.usd ?? 0), 0);
  const unknown = items.length - known.length;
  const approx = known.some((c) => c.saving.partial || c.saving.excludesOwnCost);
  const total = known.length ? fmtSaving({ usd }, t) : null;
  return (
    <span className="text-xs text-muted-foreground tabular-nums">
      {t("compactions.count", { n: items.length, count: fmtInt(items.length, t) })}
      {total && <> · {t("compactions.saved")} <span className="font-medium text-foreground">{total}</span>{approx ? "*" : ""}</>}
      {unknown > 0 && <> · {t("compactions.noData", { n: unknown, count: fmtInt(unknown, t) })}</>}
    </span>
  );
}
