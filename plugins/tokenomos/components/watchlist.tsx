import { experimental_useRpcQuery as useQuery, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../contract";
import { fmtInt, fmtTokens, fmtUsd, providerName } from "./format";
import { useT } from "./i18n";
import { Card, Section } from "./shared";

const num = "text-right tabular-nums";
// Same fixed numeric column style as the Threads table: name | context | calls / h | ~$ per call | ~$ last hour.
const COLS = "grid-cols-[minmax(0,1fr)_5rem_5.5rem_6.5rem_7rem]";

/** Threads with a large context that are still being called; not tied to the range or project, and absent when empty. */
export function Watchlist() {
  const { toThread } = useBbNavigate();
  const t = useT();
  const { data } = useQuery({ contract: rpcContract, method: "watchlist", input: {} });
  if (!data || data.items.length === 0) return null;
  const money = (usd: number | null) => (usd === null ? t("noPrice") : fmtUsd(usd, t));
  return (
    <Section title={t("watchlist.title")} subtitle={t("watchlist.subtitle")} collapseKey="watchlist">
      <Card className="overflow-x-auto p-0">
        <div className="min-w-[36rem]">
          <div className={`grid ${COLS} items-center gap-x-3 whitespace-nowrap border-b border-border px-3 py-1.5 text-xs text-muted-foreground`}>
            <span>{t("threads.thread")}</span>
            <span className={num}>{t("watchlist.context")}</span>
            <span className={num}>{t("watchlist.calls")}</span>
            <span className={num}>{t("watchlist.perCall")}</span>
            <span className={num}>{t("watchlist.lastHour")}</span>
          </div>
          <ul className="divide-y divide-border">
            {data.items.map((w) => (
              <li key={w.threadId}>
                <button type="button" onClick={() => toThread(w.threadId)}
                  className={`grid w-full ${COLS} items-center gap-x-3 px-3 py-2 text-left text-sm hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring`}>
                  <span className="min-w-0">
                    <span className="block truncate">{w.title || w.threadId}</span>
                    <span className="block truncate text-xs text-muted-foreground">{providerName(w.provider, t)} · {w.model}</span>
                  </span>
                  <span className={num}>{fmtTokens(w.contextTokens, t)}</span>
                  <span className={num}>{fmtInt(w.callsLastHour, t)}</span>
                  <span className={num}>{money(w.readCostPerCallUsd)}</span>
                  <span className={`${num} font-medium`}>{money(w.costLastHourUsd)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </Card>
    </Section>
  );
}
