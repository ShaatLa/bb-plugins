import { useEffect, useState } from "react";
import { experimental_Icon as Icon, experimental_useRpcQuery as useQuery, useSettings } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../contract";
import { accountName, fmtPercent, fmtPlan, fmtSpan, providerName } from "./format";
import { useT, type T } from "./i18n";
import { Hint, useOpen } from "./shared";
import { BAD, Tick, WARN, paceColor, poolMember, tickHint, type LimitWindow } from "./limits";
import { isPool, parseSizes, poolAccounts, type Account, type Pool } from "./pool";

const KIND_LABEL: Record<string, string> = { weekly: "7d", daily: "1d", "five-hour": "5h" };
/** Short window names as bb's usage panel writes them: "7d", "7d · Fable"; custom windows keep their own label. */
const shortLabel = (w: LimitWindow) => {
  const kind = KIND_LABEL[w.kind];
  if (!kind) return w.label;
  return w.model ? `${kind} · ${w.label.replace(/^weekly\s*·?\s*/i, "")}` : kind;
};

/** What a row's time shows: "out in" or the time until the reset, picked per row by a click and remembered. */
type TimeMode = "forecast" | "reset";
const MODE_KEY = "tokenomos:footer:time";
// Rows switched to the reset time, by account and window; the rest show the forecast.
const readModes = (): Record<string, TimeMode> => { try { return JSON.parse(localStorage.getItem(MODE_KEY) ?? "{}") ?? {}; } catch { return {}; } };
const EASTER_MS = 3000;
const EASTER = ["footer.easter0", "footer.easter1", "footer.easter2", "footer.easter3"] as const;

/**
 * A row's time. An exhausted limit always shows its reset (red). In forecast mode a limit that runs out early
 * shows "out in"; one that lasts shows its reset, and a click on it says it is fine for a moment.
 */
function timeText(w: LimitWindow, now: number, mode: TimeMode, easter: boolean, t: T): { text: string; color?: string } {
  const toReset = w.resetsAt === null ? "" : t("footer.reset", { span: fmtSpan(w.resetsAt - now, t) });
  if (w.usedPercent >= 100) return { text: toReset, color: BAD };
  if (mode === "forecast" && w.runsOutAt !== null) return { text: t("footer.runsOut", { span: fmtSpan(w.runsOutAt - now, t) }), color: paceColor(w) };
  if (mode === "forecast" && easter) {
    return { text: t(EASTER[[...w.id].reduce((n, c) => n + c.charCodeAt(0), 0) % EASTER.length]!) };
  }
  return { text: toReset };
}

export function Row({ w, now, target, mode, easter, onClick }: { w: LimitWindow; now: number; target: number | null; mode: TimeMode; easter: boolean; onClick(hasForecast: boolean): void }) {
  const t = useT();
  const used = Math.min(100, Math.max(0, w.usedPercent)), f = timeText(w, now, mode, easter, t), color = paceColor(w), share = w.kind === "five-hour" ? null : w.usage?.heavyShare ?? null;
  const variants = [...new Set([timeText(w, now, "forecast", false, t).text, timeText(w, now, "reset", false, t).text, timeText(w, now, "forecast", true, t).text])];
  // The whole row is the hover target: the time tick explained, plus the heavy-model share for the window that has one.
  const hint = (tickHint(w, t) || share !== null) && (
    <div className="max-w-64 space-y-1">
      {tickHint(w, t) && <p>{tickHint(w, t)}</p>}
      {share !== null && (
        <p style={target !== null && share > target ? { color: WARN } : undefined}>
          {target === null ? t("footer.heavyLine", { share: fmtPercent(share, t) }) : t("footer.heavyLineTarget", { share: fmtPercent(share, t), pct: fmtPercent(target, t) })}
        </p>
      )}
    </div>
  );
  return (
    <Hint text={hint || undefined}>
    <li className={`col-span-4 grid cursor-default grid-cols-subgrid items-center text-[11px]`}>
      <span className="truncate text-muted-foreground" title={w.label}>{shortLabel(w)}</span>
      <div role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={used} aria-label={`${w.label}: ${fmtPercent(used / 100, t)}`} className="relative h-1 rounded-full bg-muted">
        <div className="h-full min-w-1 rounded-full" style={{ width: `${used}%`, background: color ?? "var(--foreground)" }} />
        {/* An exhausted limit has no pace left to compare with: no tick. */}
        {w.elapsedShare !== null && w.usedPercent < 100 && <Tick share={w.elapsedShare} className="h-2.5" />}
      </div>
      <span className="text-right tabular-nums" style={{ color: color ?? "var(--foreground)" }}>{fmtPercent(w.usedPercent / 100, t)}</span>
      {/* Every text this cell can show sits invisibly in the same grid cell, so the column keeps the width of the
          longest one and the bars do not jump when a row switches. */}
      <button type="button" onClick={() => onClick(w.runsOutAt !== null && w.usedPercent < 100)} aria-label={t(mode === "forecast" ? "footer.showReset" : "footer.showForecast")}
        className="grid min-w-0 cursor-default justify-items-end whitespace-nowrap rounded-sm text-right tabular-nums text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        style={f.color ? { color: f.color } : undefined}>
        {variants.map((v) => <span key={v} aria-hidden className="invisible col-start-1 row-start-1 max-w-full truncate">{v}</span>)}
        <span data-time className="col-start-1 row-start-1 max-w-full truncate">{f.text}</span>
      </button>
    </li>
    </Hint>
  );
}

/** A provider's subscriptions as one pool: pooled rows when folded, the subscriptions instead of them when unfolded. */
function PoolSection({ pool, now, first, rows, account }: { pool: Pool; now: number; first: boolean; rows: React.ReactNode; account: (a: Account) => React.ReactNode }) {
  const t = useT();
  const [open, toggle] = useOpen(`footer-pool:${pool.providerId}`, false);
  return (
    <section className={`col-span-4 grid grid-cols-subgrid gap-y-1 ${first ? "" : "mt-1.5 border-t border-border pt-2.5"}`}>
      <button type="button" onClick={toggle} aria-expanded={open} aria-label={t("pool.accounts", { n: pool.accounts.length })}
        className="col-span-4 flex min-w-0 cursor-default items-center gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
        <span className="min-w-0 truncate font-medium text-foreground">{providerName(pool.providerId, t)}</span>
        <Icon name={open ? "ChevronDown" : "ChevronRight"} className="ml-auto size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      </button>
      {open ? pool.accounts.map(account) : rows}
    </section>
  );
}

/** Sidebar-footer disclosure: every provider limit with its forecast, and the heavy-model share per account. */
export function LimitsFooter() {
  const t = useT();
  const { data, error } = useQuery({ contract: rpcContract, method: "limits", input: {} });
  const settings = useSettings().values;
  const pooled = settings?.poolAccounts !== false, sizes = parseSizes(String(settings?.planMultipliers ?? ""));
  const now = Date.now();
  const [modes, setModes] = useState<Record<string, TimeMode>>(readModes);
  const [easter, setEaster] = useState<string | null>(null);
  useEffect(() => { if (!easter) return; const id = setTimeout(() => setEaster(null), EASTER_MS); return () => clearTimeout(id); }, [easter]);
  // A row with a forecast flips between "out in" and its reset; a row without one just says it is fine for a moment.
  const click = (key: string, hasForecast: boolean) => {
    // A second click while the phrase shows brings the time back at once.
    if (!hasForecast) { setEaster(easter === key ? null : key); return; }
    const next = { ...modes };
    if (next[key] === "reset") delete next[key]; else next[key] = "reset";
    setModes(next);
    try { localStorage.setItem(MODE_KEY, JSON.stringify(next)); } catch { /* storage unavailable: the choice lasts this session */ }
  };
  return (
    // One grid for every account, so labels, bars, percents and times line up down the whole panel. The bar takes
    // what the text leaves, down to 2rem, so a narrow panel still shows the time and forecast in full.
    <div className="grid w-full grid-cols-[max-content_minmax(2rem,1fr)_max-content_minmax(0,max-content)] items-center gap-x-2 gap-y-1 overflow-hidden p-3 text-xs">
      {!data ? <p className="col-span-4 text-xs text-muted-foreground">{error ? t("loadError") : t("footer.loading")}</p>
        : data.accounts.length === 0 ? <p className="col-span-4 text-xs text-muted-foreground">{t("footer.empty")}</p>
        : (pooled ? poolAccounts(data.accounts, now, sizes) : data.accounts).map((x, i) => {
          const rows = (a: Account | Pool, windows: LimitWindow[]) => (
            <ul className="col-span-4 grid grid-cols-subgrid gap-y-1">{windows.map((w) => { const k = `${a.providerId}:${w.id}`; return <Row key={w.id} w={w} now={now} target={data.heavyTarget} mode={modes[k] ?? "forecast"} easter={easter === k} onClick={(f) => click(k, f)} />; })}</ul>
          );
          const account = (a: Account, nested: boolean) => (
            <section key={`${a.providerId}:${a.label}`} className={`col-span-4 grid grid-cols-subgrid gap-y-1 ${nested ? "mt-1.5 rounded-md bg-muted/50 px-2 py-1.5" : i ? "mt-1.5 border-t border-border pt-2.5" : ""}`}>
              <div className="col-span-4 flex items-center gap-2">
                <span className="min-w-0 truncate font-medium text-foreground" title={a.label}>{nested ? poolMember(a) : accountName(a, data.accounts, t)}</span>
                {a.plan && !nested && <span className="min-w-0 truncate rounded bg-muted px-1 py-px text-[10px] text-muted-foreground" title={a.plan}>{fmtPlan(a.plan)}</span>}
              </div>
              {a.status !== "ok" || a.windows.length === 0
                ? <p className="col-span-4 text-[11px] text-muted-foreground">{t("limits.unavailable", { status: a.message ?? a.status })}</p>
                : rows(a, a.windows)}
            </section>
          );
          return isPool(x) ? <PoolSection key={`pool:${x.providerId}`} pool={x} now={now} first={i === 0} rows={rows(x, x.rows)} account={(a) => account(a, true)} /> : account(x, false);
        })}
    </div>
  );
}
