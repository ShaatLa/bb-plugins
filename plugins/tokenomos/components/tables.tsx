import { useEffect, useState } from "react";
import { experimental_useRpcQuery as useQuery, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { rpcContract, type Range } from "../contract";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { fmtCost, fmtInt, fmtSaving, fmtTokens, fmtWhen, providerName } from "./format";
import { useT } from "./i18n";
import { Card, Muted, Section, SkeletonBlock, scope, useHeld } from "./shared";

const num = "text-right tabular-nums";
// Fixed numeric columns keep the rows aligned: name | calls | tokens | range cost | total.
const COLS = "grid-cols-[minmax(0,1fr)_4.5rem_5rem_8rem_6.5rem]";

const PAGE = 50;

/** One page of top threads; the last mounted page offers "More" while the server says more exist. */
function ThreadsPage({ range, project, offset, isLast, onMore }: { range: Range; project?: string; offset: number; isLast: boolean; onMore: () => void }) {
  const { toThread } = useBbNavigate();
  const t = useT();
  const query = useQuery({ contract: rpcContract, method: "topThreads", input: { range, offset, limit: PAGE, ...scope(project) } });
  const { value: data, stale } = useHeld(query.data, `${range}/${project ?? ""}`);
  if (!data) return query.isLoading ? <SkeletonBlock rows={3} /> : null;
  return (
    <ul className={stale ? "divide-y divide-border opacity-60" : "divide-y divide-border"}>
      {data.items.map((th) => (
        <li key={th.threadId}>
          <button type="button" onClick={() => toThread(th.threadId)}
            className={`grid w-full ${COLS} items-center gap-x-3 px-3 py-2 text-left text-sm hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring`}>
            <span className="min-w-0">
              <span className="block truncate">{th.title || th.threadId}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {[th.projectName, th.model, providerName(th.provider, t), th.childCount > 0 ? t("threads.children", { n: th.childCount }) : null].filter(Boolean).join(" · ")}
              </span>
            </span>
            <span className={num}>{fmtInt(th.calls, t)}</span>
            <span className={num}>{fmtTokens(th.tokens, t)}</span>
            <span className={`${num} font-medium`}>{fmtCost(th.rangeCost, t) ?? t("noPrice")}</span>
            <span className={`${num} text-muted-foreground`} title={t("threads.totalTitle")}>{fmtCost(th.total, t) ?? t("noPrice")}</span>
          </button>
        </li>
      ))}
      {isLast && data.hasMore && <li className="p-2"><Button variant="ghost" size="sm" onClick={onMore}>{t("threads.more")}</Button></li>}
    </ul>
  );
}

export function Threads({ range, project }: { range: Range; project?: string }) {
  const t = useT();
  return <Section title={t("threads.title")} collapseKey="threads"><ThreadsBody range={range} project={project} /></Section>;
}

function ThreadsBody({ range, project }: { range: Range; project?: string }) {
  const t = useT();
  const [pages, setPages] = useState(1);
  const first = useQuery({ contract: rpcContract, method: "topThreads", input: { range, offset: 0, limit: PAGE, ...scope(project) } });
  useEffect(() => setPages(1), [range, project]);
  return first.data && first.data.items.length === 0 ? <Card><Muted>{t("threads.empty")}</Muted></Card> : (
    <Card className="overflow-x-auto p-0">
      <div className="min-w-[36rem]">
        <div className={`grid ${COLS} items-center gap-x-3 whitespace-nowrap border-b border-border px-3 py-1.5 text-xs text-muted-foreground`}>
          <span>{t("threads.thread")}</span>
          <span className={num}>{t("threads.calls")}</span>
          <span className={num}>{t("threads.tokens")}</span>
          <span className={num}>{t(`threads.range.${range}`)}</span>
          <span className={num} title={t("threads.totalTitle")}>{t("threads.total")}</span>
        </div>
        <div className="divide-y divide-border">
          {Array.from({ length: pages }, (_, i) => <ThreadsPage key={i} range={range} project={project} offset={i * PAGE} isLast={i === pages - 1} onMore={() => setPages(pages + 1)} />)}
        </div>
      </div>
    </Card>
  );
}

export function Compactions({ range, project }: { range: Range; project?: string }) {
  const { toThread } = useBbNavigate();
  const t = useT();
  const query = useQuery({ contract: rpcContract, method: "compactions", input: { range, ...scope(project) } });
  const { value: data, stale } = useHeld(query.data, `${range}/${project ?? ""}`);
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
