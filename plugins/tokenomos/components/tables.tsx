import { useEffect, useState } from "react";
import { experimental_useRpcQuery as useQuery, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { rpcContract, type Range } from "../contract";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { fmtCost, fmtSaving, fmtTokens, fmtWhen, providerName } from "./format";
import { Card, Muted, Section, SkeletonBlock, useHeld } from "./shared";
import type { CompactionsOutput, SummaryOutput } from "./types";

const num = "text-right tabular-nums";

export function Breakdown({ summary }: { summary: SummaryOutput }) {
  return (
    <Section title="Разбивка">
      <Card className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Название</TableHead>
              <TableHead className={num}>Свежий вход</TableHead>
              <TableHead className={num}>Чтение кэша</TableHead>
              <TableHead className={num}>Запись кэша</TableHead>
              <TableHead className={num}>Выход</TableHead>
              <TableHead className={num}>Вызовов</TableHead>
              <TableHead className={num}>~$</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {summary.breakdown.length === 0 && <TableRow><TableCell colSpan={7} className="text-muted-foreground">Нет данных.</TableCell></TableRow>}
            {summary.breakdown.map((b) => (
              <TableRow key={b.key}>
                <TableCell className="font-medium">{b.label}</TableCell>
                <TableCell className={num}>{fmtTokens(b.cost.tokens.freshIn)}</TableCell>
                <TableCell className={num}>{fmtTokens(b.cost.tokens.cacheRead)}</TableCell>
                <TableCell className={num}>{fmtTokens(b.cost.tokens.cacheWrite)}</TableCell>
                <TableCell className={num}>{fmtTokens(b.cost.tokens.output)}</TableCell>
                <TableCell className={num}>{b.calls}</TableCell>
                <TableCell className={num}>{fmtCost(b.cost) ?? "нет цены"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </Section>
  );
}

const PAGE = 50;

/** One page of top threads; the last mounted page offers «Ещё» while the server says more exist. */
function ThreadsPage({ range, offset, isLast, onMore }: { range: Range; offset: number; isLast: boolean; onMore: () => void }) {
  const { toThread } = useBbNavigate();
  const query = useQuery({ contract: rpcContract, method: "topThreads", input: { range, offset, limit: PAGE } });
  const { value: data, stale } = useHeld(query.data, range);
  if (!data) return query.isLoading ? <SkeletonBlock rows={3} /> : null;
  return (
    <ul className={stale ? "divide-y divide-border opacity-60" : "divide-y divide-border"}>
      {data.items.map((t) => (
        <li key={t.threadId}>
          <button type="button" onClick={() => toThread(t.threadId)}
            className="grid w-full grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-4 px-3 py-2 text-left text-sm hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
            <span className="min-w-0 truncate">{t.title || t.threadId}<span className="text-xs text-muted-foreground"> · {providerName(t.provider)}</span></span>
            <span className={`${num} w-20`} title="Сам тред">{fmtCost(t.own) ?? "нет цены"}</span>
            <span className={`${num} w-24 text-muted-foreground`} title="С подтредами">{fmtCost(t.total) ?? "нет цены"}</span>
          </button>
        </li>
      ))}
      {isLast && data.hasMore && <li className="p-2"><Button variant="ghost" size="sm" onClick={onMore}>Ещё</Button></li>}
    </ul>
  );
}

export function Threads({ range }: { range: Range }) {
  const [pages, setPages] = useState(1);
  const first = useQuery({ contract: rpcContract, method: "topThreads", input: { range, offset: 0, limit: PAGE } });
  useEffect(() => setPages(1), [range]);
  return (
    <Section title="Треды">
      {first.data && first.data.items.length === 0 ? <Card><Muted>Нет тредов с расходом за период.</Muted></Card> : (
        <Card className="p-0">
          <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-4 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
            <span>Тред</span><span className={`${num} w-20`}>~$ сам</span><span className={`${num} w-24`}>~$ с подтредами</span>
          </div>
          <div className="divide-y divide-border">
            {Array.from({ length: pages }, (_, i) => <ThreadsPage key={i} range={range} offset={i * PAGE} isLast={i === pages - 1} onMore={() => setPages(pages + 1)} />)}
          </div>
        </Card>
      )}
    </Section>
  );
}

const ORIGIN: Record<CompactionsOutput["items"][number]["origin"], string> = { "idle-compact": "Idle Compact", bb: "bb" };

export function Compactions({ range }: { range: Range }) {
  const { toThread } = useBbNavigate();
  const query = useQuery({ contract: rpcContract, method: "compactions", input: { range } });
  const { value: data, stale } = useHeld(query.data, range);
  return (
    <Section title="Компакции">
      {!data && query.isLoading ? <SkeletonBlock rows={2} /> : !data?.items.length ? <Card><Muted>Компакций за период не было.</Muted></Card> : (
        <Card className={stale ? "p-0 opacity-60" : "p-0"}>
          <ul className="divide-y divide-border">
            {data.items.map((c) => {
              const net = fmtSaving(c.saving);
              return (
                <li key={c.id}>
                  <button type="button" onClick={() => toThread(c.threadId)}
                    className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-0.5 px-3 py-2 text-left text-sm hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                    <span className="min-w-0 truncate">{c.title || c.threadId}</span>
                    <span className={`${num} font-medium`}>{net ? `${net}${c.saving.usd! < 0 ? " (затраты)" : ""}` : `${fmtTokens(c.saving.tokens)} ток.`}</span>
                    <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground tabular-nums">
                      {fmtWhen(c.at)} · {fmtTokens(c.beforeTokens)} → {fmtTokens(c.afterTokens)}
                      <Badge variant="outline" className="px-1.5 py-0 font-normal">{ORIGIN[c.origin]}</Badge>
                    </span>
                    <span className="text-right text-xs text-muted-foreground">
                      {c.saving.excludesOwnCost && "без учёта стоимости самой компакции"}{c.saving.excludesOwnCost && c.saving.partial && " · "}{c.saving.partial && "частично"}
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
