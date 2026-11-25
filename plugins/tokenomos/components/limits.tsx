import { experimental_Icon as Icon, experimental_useRpcQuery as useQuery, useSettings } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import { rpcContract, type limitWindowSchema } from "../contract";
import { accountName, fmtDay, fmtPercent, fmtPlan, fmtSpan, fmtUsd, providerName } from "./format";
import { useT, type T } from "./i18n";
import { Row } from "./limits-footer";
import { isPool, parseSizes, poolAccounts, type Account, type Pool } from "./pool";
import { Card, Hint, Section, useOpen } from "./shared";

/** A subscription inside a pool goes by its plan; the provider name is the pool's. */
export const poolMember = (a: { label: string; plan: string | null }) => (a.plan ? fmtPlan(a.plan) : a.label);

export type LimitWindow = z.infer<typeof limitWindowSchema>;
export const WARN = "var(--warning-text, #b45309)";
export const BAD = "var(--destructive-text, #dc2626)";

// Projected percent at reset from which the overrun counts as large and turns red.
const FAR_AHEAD = 150;
/**
 * Bar color by pace: neutral while usage keeps up with time (or it is too early to tell), orange once it runs
 * ahead of the tick, so the limit would end before the reset, red when it is far ahead or already exhausted.
 */
export function paceColor(w: LimitWindow): string | undefined {
  if (w.usedPercent >= 100) return BAD;
  // Coloured only when it is called as running out, so the colour and the "out in" always agree.
  if (w.runsOutAt === null || w.forecastPercent === null) return undefined;
  return w.forecastPercent >= FAR_AHEAD ? BAD : WARN;
}

/** Hover hint for the elapsed-time tick: how much of the window has passed and whether usage outpaces it. */
export function tickHint(w: LimitWindow, t: T): string | undefined {
  if (w.elapsedShare === null || w.usedPercent >= 100) return undefined;
  const share = fmtPercent(w.elapsedShare, t), used = w.usedPercent / 100;
  // Within two points of the tick counts as on pace.
  const pace = used > w.elapsedShare + 0.02 ? "ahead" : used < w.elapsedShare - 0.02 ? "behind" : "even";
  return t(`limits.tick.${pace}`, { share });
}

/** The elapsed-time tick, with a wider invisible hover target than its 2px line. */
export function Tick({ share, hint, className }: { share: number; hint?: string; className: string }) {
  return (
    <Hint text={hint}>
      <span role={hint ? "img" : undefined} aria-label={hint} aria-hidden={hint ? undefined : true} className={`absolute top-1/2 flex w-3 -translate-x-1/2 -translate-y-1/2 justify-center py-1 ${hint ? "cursor-help" : ""}`} style={{ left: `${share * 100}%` }}>
        <span aria-hidden className={`${className} w-0.5 rounded-full bg-foreground/60`} />
      </span>
    </Hint>
  );
}

type Tone = "bad" | "warn" | "ok" | "muted";

/** What the window's pace means for the user, as a headline and a detail line. */
function status(w: LimitWindow, now: number, t: T): { tone: Tone; title: string; detail?: string; hint?: string } | null {
  if (w.usedPercent >= 100) return { tone: "bad", title: t("limits.exhausted") };
  if (w.runsOutAt !== null) return { tone: "warn", title: t("limits.runsOut", { span: fmtSpan(w.runsOutAt - now, t) }), hint: fmtDay(w.runsOutAt, t) };
  if (w.usedPercent === 0) return null; // an empty bar says it already
  // Over 100% at the reset but inside the margin: too close to call either way.
  if (w.forecastPercent !== null && w.forecastPercent > 100) return { tone: "muted", title: t("limits.tight"), detail: t("limits.lastsDetail", { pct: fmtPercent(w.forecastPercent / 100, t) }) };
  if (w.forecastPercent !== null) return { tone: "ok", title: t("limits.lasts"), detail: t("limits.lastsDetail", { pct: fmtPercent(w.forecastPercent / 100, t) }) };
  return { tone: "muted", title: t("limits.early") };
}

/** One figure under the bar: the value with its unit inline, as the "used" percent above it, and an optional second line. */
function Stat({ label, value, unit, detail, color, title }: { label: string; value: string; unit: string; detail?: string; color?: string; title?: string }) {
  return (
    <Hint text={title}>
    <div className="min-w-0 cursor-default">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="truncate leading-6"><span className="text-base font-semibold tabular-nums" style={{ color: color ?? "var(--foreground)" }}>{value}</span><span className="ml-1 text-[11px] text-muted-foreground">{unit}</span></dd>
      {detail && <dd className="text-[11px] leading-4 tabular-nums text-muted-foreground">{detail}</dd>}
    </div>
    </Hint>
  );
}

function Window({ w, target }: { w: LimitWindow; target: number | null }) {
  const t = useT();
  const now = Date.now(), used = Math.min(100, Math.max(0, w.usedPercent)), s = status(w, now, t), u = w.usage;
  const calls = u ? u.heavy.calls + u.other.calls : 0, over = target !== null && u?.heavyShare != null && u.heavyShare > target;
  // Limit colors follow bb's usage panel: neutral until the limit is exhausted, then red. Orange is kept for the heavy-model share.
  const tint = paceColor(w);
  return (
    <li className="space-y-2.5">
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">{w.label}</div>
          {w.resetsAt !== null && <Hint text={fmtDay(w.resetsAt, t)}><div className="w-fit cursor-default text-[11px] text-muted-foreground">{t("limits.resets", { span: fmtSpan(w.resetsAt - now, t) })}</div></Hint>}
        </div>
        <div className="shrink-0 text-right leading-none">
          <span className="text-xl font-semibold tabular-nums" style={{ color: tint ?? "var(--foreground)" }}>{fmtPercent(w.usedPercent / 100, t)}</span>
          <span className="ml-1 text-[11px] text-muted-foreground">{t("limits.usedShort")}</span>
        </div>
      </div>
      <div role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={used}
        aria-label={t("limits.aria", { label: w.label, used: fmtPercent(used / 100, t), elapsed: w.elapsedShare === null ? "?" : fmtPercent(w.elapsedShare, t) })}
        className="relative h-2 rounded-full bg-muted">
        <div className="h-full rounded-full" style={{ width: `${used}%`, background: tint ?? "var(--foreground)" }} />
        {/* The tick marks how much of the window's time has passed: a bar ahead of it burns faster than the window. */}
        {w.elapsedShare !== null && w.usedPercent < 100 && <Tick share={w.elapsedShare} hint={tickHint(w, t)} className="h-4" />}
      </div>
      {/* Relative time reads at a glance; the exact moment is in the hint. */}
      {s && (
        <Hint text={s.hint}>
          <p className="-mt-1 w-fit text-xs" style={{ color: tint ?? (s.tone === "warn" ? "var(--foreground)" : "var(--muted-foreground)") }}>
            <span className={s.tone === "muted" ? undefined : "font-medium"}>{s.title}</span>{s.detail && <span className="opacity-80"> · {s.detail}</span>}
          </p>
        </Hint>
      )}
      {/* A five-hour window is too short for the heavy-model share and the cost per percent to say much. */}
      {w.kind !== "five-hour" && (u?.heavyShare != null || u?.usdPerPercent != null) && <dl className="grid grid-cols-2 gap-4 border-t border-border pt-2.5">
        {u?.heavyShare != null && (
          <Stat label={t("limits.heavyLabel")} value={fmtPercent(u.heavyShare, t)} color={over ? WARN : undefined} title={`${target === null ? t("footer.heavyTitle") : t("footer.heavyTitleTarget", { pct: fmtPercent(target, t) })}. ${t("limits.heavyCallsHint")}`}
            unit={t("limits.heavyUnit")} detail={t("limits.heavyCalls", { calls: fmtPercent(calls ? u.heavy.calls / calls : 0, t) })} />
        )}
        {u?.usdPerPercent != null && <Stat label={t("limits.perPercentLabel")} value={`~${fmtUsd(u.usdPerPercent, t)}`} unit="" detail={t("limits.perPercentUnit")} />}
      </dl>}
    </li>
  );
}

/**
 * A provider's subscriptions as one pool, each fact once: what is left and the forecast, the bars with their own
 * times, then one line of pace and what to spend first.
 */
function PoolCard({ pool, target }: { pool: Pool; target: number | null }) {
  const t = useT();
  const now = Date.now(), o = pool.outlook, f = pool.first;
  const [open, toggle] = useOpen(`limits-pool:${pool.providerId}`, false);
  const outlook = !o ? { text: t("pool.noForecast") }
    : o.kind === "lasts" ? { text: t("pool.lasts") }
    : { text: o.refillAt === null ? t("pool.runsOutNoRefill", { span: fmtSpan(o.at - now, t) }) : t("pool.runsOut", { span: fmtSpan(o.at - now, t), gap: fmtSpan(o.refillAt - o.at, t) }), color: WARN, hint: fmtDay(o.at, t) };
  // The headline already says when the main window runs out, so its bar shows the reset; times a bar shows are not repeated below.
  const mainReset = pool.rows.find((w) => w.id === pool.mainId)?.resetsAt ?? null;
  const runway = pool.runway === null ? null : fmtSpan(pool.runway, t);
  const runsOut = o?.kind === "runsOut" ? fmtSpan(o.at - now, t) : null;
  const firstText = f && (() => {
    const name = poolMember(f.account), shown = f.resetsAt === mainReset;
    return f.burnsShare >= 0.005
      ? shown ? t("pool.firstBurns", { name, pct: fmtPercent(f.burnsShare, t) }) : t("pool.firstBurnsIn", { name, pct: fmtPercent(f.burnsShare, t), span: fmtSpan(f.resetsAt - now, t) })
      : shown ? t("pool.first", { name }) : t("pool.firstIn", { name, span: fmtSpan(f.resetsAt - now, t) });
  })();
  const secondary = [
    pool.ratePerHour !== null ? t("pool.pace", { usd: fmtUsd(pool.ratePerHour, t) }) : null,
    runway !== null && runway !== runsOut ? t("pool.runway", { span: runway }) : null,
    firstText,
  ].filter(Boolean).join(" · ");
  return (
    <Card className="space-y-3">
      <h3 className="text-sm font-medium text-foreground">{providerName(pool.providerId, t)}</h3>
      <div className="space-y-1">
        {pool.leftUsd !== null && (
          <Hint text={pool.estimated ? t("pool.estimated") : undefined}>
            <div className="w-fit cursor-default">
              <span className="text-xl font-semibold tabular-nums text-foreground">{t("pool.leftUsd", { usd: `${pool.estimated ? "≈" : "~"}${fmtUsd(pool.leftUsd, t)}` })}</span>
              <span className="ml-2 text-[11px] text-muted-foreground">{t("pool.apiEquivalent")}</span>
            </div>
          </Hint>
        )}
        <Hint text={"hint" in outlook ? outlook.hint : undefined}><p className="w-fit text-xs font-medium" style={{ color: "color" in outlook ? outlook.color : "var(--foreground)" }}>{outlook.text}</p></Hint>
      </div>
      <ul className="grid grid-cols-[max-content_minmax(2rem,1fr)_max-content_max-content] items-center gap-x-2 gap-y-1 border-t border-border pt-2.5">
        {pool.rows.map((w) => <Row key={w.id} w={w} now={now} target={target} mode={w.id === pool.mainId ? "reset" : "forecast"} easter={false} onClick={() => {}} />)}
      </ul>
      {secondary && <p className="text-xs text-muted-foreground">{secondary}</p>}
      <button type="button" onClick={toggle} aria-expanded={open}
        className="flex items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
        <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5" aria-hidden />{t("pool.accounts", { n: pool.accounts.length })}
      </button>
      {open && pool.accounts.map((a) => (
        <div key={a.label} className="space-y-3 border-l-2 border-border pl-3">
          <h4 className="text-sm font-medium text-foreground" title={a.label}>{poolMember(a)}</h4>
          <AccountWindows a={a} target={target} />
        </div>
      ))}
    </Card>
  );
}

function AccountWindows({ a, target }: { a: Account; target: number | null }) {
  const t = useT();
  return a.status !== "ok" || a.windows.length === 0
    ? <p className="text-xs text-muted-foreground">{t("limits.unavailable", { status: a.message ?? a.status })}</p>
    : <ul className="space-y-5">{a.windows.map((w) => <Window key={w.id} w={w} target={target} />)}</ul>;
}

/** Provider limit windows next to what Tokenomos counted in them; absent when no plugin reports limits. */
export function Limits() {
  const t = useT();
  const { data } = useQuery({ contract: rpcContract, method: "limits", input: {} });
  const settings = useSettings().values;
  const pooled = settings?.poolAccounts !== false, sizes = parseSizes(String(settings?.planMultipliers ?? ""));
  if (!data || data.accounts.length === 0) return null;
  return (
    <Section title={t("limits.title")} subtitle={t("limits.subtitle", { models: data.heavyModels.join(", ") })} collapseKey="limits">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {(pooled ? poolAccounts(data.accounts, Date.now(), sizes) : data.accounts).map((a, i) => isPool(a) ? <PoolCard key={`pool:${a.providerId}`} pool={a} target={data.heavyTarget} /> : (
          <Card key={`${a.providerId}:${i}`} className="space-y-3">
            <h3 className="flex flex-wrap items-baseline justify-between gap-x-2 text-sm font-medium text-foreground"><span title={a.label}>{accountName(a, data.accounts, t)}{a.plan && <span className="font-normal text-muted-foreground"> · {fmtPlan(a.plan)}</span>}</span></h3>
            <AccountWindows a={a} target={data.heavyTarget} />
          </Card>
        ))}
      </div>
    </Section>
  );
}
