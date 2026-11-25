import { z } from 'zod';

/** One usage-limit window as a provider plugin reports it over the provider-usage.v1 protocol. */
export type LimitWindow = {
  id: string; label: string; kind: string; usedPercent: number; resetsAt: number | null; model: string | null;
  /** The account's latest report left this window out; these are its last numbers, seen at `seenAt`. */
  stale?: boolean; seenAt?: number;
};
export type LimitAccount = {
  providerId: string; label: string; plan: string | null; status: string; message: string | null; observedAt: number | null; windows: LimitWindow[];
  /** The provider's plan id and, when it reports one, the plan's size relative to its base plan (5 for a 5x plan). */
  planId?: string | null; multiplier?: number | null;
  /** The source failed this time; these are its last good numbers, measured at `observedAt`. */
  stale?: boolean;
  /** The machine a host-scoped source reports this account from; null when several machines (or a shared source) report it. */
  host?: { id: string; name: string } | null;
};
export type CallRpc = (pluginId: string, method: string, input: unknown, signal: AbortSignal) => Promise<unknown>;
export type Discover = (method: string) => Promise<{ pluginId: string }[]>;

// Other plugins' output is untrusted: parse it loosely and drop what does not fit.
const scopeSchema = z.object({ kind: z.string(), hostId: z.string().optional(), hostName: z.string().optional() }).nullish().catch(null);
const listSchema = z.object({ resources: z.array(z.object({ id: z.string().min(1), providerId: z.string().min(1), label: z.string(), accountKey: z.string().nullish(), scope: scopeSchema })) });
const windowSchema = z.object({
  id: z.string().optional(), label: z.string(), kind: z.string().optional(), usedPercent: z.number(), resetsAt: z.string().nullish(), model: z.string().nullish(),
});
const resourceSchema = z.object({
  accountKey: z.string().nullish(), observedAt: z.number().nullish(),
  usage: z.object({
    status: z.string(), planLabel: z.string().nullish(), message: z.string().nullish(), windows: z.array(windowSchema).optional(),
    plan: z.object({ id: z.string(), multiplier: z.number().positive().nullish() }).nullish().catch(null),
  }),
});

const LIST = 'provider-usage.v1.listResources', GET = 'provider-usage.v1.getResource';

/**
 * The plan name from an Account Pooler account's raw fields, or null to keep bb's label. bb names every Claude
 * `max_Nx` tier "Ultra" or "Max", a Team seat included, and shows some Codex plan ids raw.
 * shortcut: a copy of bb's plan naming; delete it (and its `account.list` call) once bb names these plans right.
 */
export function poolPlanName(provider: string, subscriptionType: string | null | undefined, rateLimitTier: string | null | undefined): string | null {
  if (provider === 'claude') {
    if (subscriptionType === 'claude_team') return 'Team';
    if (subscriptionType === 'pro') return 'Pro';
    const size = /max_(\d+)x/u.exec(rateLimitTier ?? '')?.[1];
    if (subscriptionType === 'max' && size) return `Max ${size}x`;
  }
  if (provider === 'codex' && subscriptionType === 'self_serve_business_prolite') return 'Business Pro Lite';
  return null;
}
const POOL = 'account-pool';
const poolSchema = z.array(z.object({
  id: z.string(), provider: z.string(), subscriptionType: z.string().nullish().catch(null), rateLimitTier: z.string().nullish().catch(null),
})).catch([]);

/**
 * Every account's limit windows from the plugins that publish provider-usage.v1. Provider plugins come before
 * aggregators (account-pool), and an account reported twice is kept once, by its provider-issued accountKey,
 * preferring a successful report over a failed one. Accounts with an unknown key are never merged, as the
 * protocol requires. Each call gets its own timeout, so one slow resource does not fail its siblings.
 */
export async function collectLimits(discover: Discover, callRpc: CallRpc, selfId: string, timeoutMs = 8000, knownKeys = new Map<string, string>()): Promise<{ id: string; account: LimitAccount }[]> {
  const plugins = [...new Set((await discover(LIST)).map(m => m.pluginId))].filter(p => p !== selfId)
    .sort((a, b) => Number(!a.startsWith('provider-')) - Number(!b.startsWith('provider-')) || a.localeCompare(b));
  // Account Pooler account ids are its provider-usage resource ids.
  const poolPlans = new Map(plugins.includes(POOL)
    ? poolSchema.parse(await callRpc(POOL, 'account.list', null, AbortSignal.timeout(timeoutMs)).catch(() => []))
      .flatMap(a => { const name = poolPlanName(a.provider, a.subscriptionType, a.rateLimitTier); return name ? [[a.id, name] as const] : []; })
    : []);
  const plans = new Map<string, string>();
  const perPlugin = await Promise.all(plugins.map(async pluginId => {
    try {
      const { resources } = listSchema.parse(await callRpc(pluginId, LIST, {}, AbortSignal.timeout(timeoutMs)));
      return await Promise.all(resources.map(async r => {
        // Resource ids are stable, so a key learned earlier still names the account when the source stops reporting it.
        const resource = `${pluginId}\0${r.id}`, listed = r.accountKey ?? knownKeys.get(resource);
        if (r.accountKey) knownKeys.set(resource, r.accountKey);
        const fallbackId = `${r.providerId}\0${listed ?? resource}`, plan = pluginId === POOL ? poolPlans.get(r.id) : undefined;
        try {
          const got = resourceSchema.parse(await callRpc(pluginId, GET, { resourceId: r.id, refresh: false }, AbortSignal.timeout(timeoutMs)));
          const key = got.accountKey ?? listed;
          if (key) knownKeys.set(resource, key);
          const id = key ? `${r.providerId}\0${key}` : fallbackId;
          if (plan) plans.set(id, plan);
          return { id, account: toAccount(r, got) };
        } catch (error) {
          return { id: fallbackId, account: failed(r, error) };
        }
      }));
    } catch { return []; }
  }));
  const out = new Map<string, LimitAccount>();
  for (const { id, account } of perPlugin.flat()) {
    const kept = out.get(id);
    if (!kept) { out.set(id, account); continue; }
    // An aggregator standing in for a failed provider plugin keeps the provider's own label.
    const next = kept.status !== 'ok' && account.status === 'ok' ? { ...account, label: kept.label } : kept;
    // An account several machines (or a shared source) report belongs to none of them.
    out.set(id, kept.host?.id === account.host?.id ? next : { ...next, host: null });
  }
  // Set on the merged account, so it also replaces the label a provider plugin reports for the same account.
  return [...out].map(([id, account]) => ({ id, account: plans.has(id) ? { ...account, plan: plans.get(id)! } : account }));
}

/** How long an account's last good report is shown after its source stops answering. */
const KEEP_LAST_GOOD_MS = 24 * 3_600_000;

/**
 * Remembers each account's last successful report and shows it, marked stale, while the source fails or drops
 * out, instead of hiding the numbers behind an error. A window a successful report leaves out (sources do not always
 * report every window) is kept the same way for a day; once it resets it shows as empty with no known reset, since
 * sources leave out a window that has not started again (no use since its reset). A model window is matched by kind and
 * model, since sources name it differently ("Fable", "Weekly · fable"); others by label.
 */
// Custom windows can share a model scope (an aggregate "Gemini Models" in 5h and 7d), so they keep their label.
const windowKey = (w: LimitWindow) => w.kind !== 'custom' && w.model ? `${w.kind}:${w.model.toLowerCase()}` : w.label;

export type CollectorState = { good?: [string, { at: number; account: LimitAccount }][]; keys?: [string, string][] };

/** `seed` is a previous `state()`, so a restart still has the last good reports and account keys to fall back on. */
export function createLimitCollector(discover: Discover, callRpc: CallRpc, selfId: string, timeoutMs = 8000, seed: CollectorState = {}) {
  const lastGood = new Map(seed.good ?? []);
  const lastWindows = new Map<string, Map<string, { at: number; w: LimitWindow }>>();
  const knownKeys = new Map(seed.keys ?? []);
  const withMissing = (id: string, account: LimitAccount, now: number): LimitAccount => {
    const seen = lastWindows.get(id) ?? new Map<string, { at: number; w: LimitWindow }>();
    lastWindows.set(id, seen);
    for (const w of account.windows) seen.set(windowKey(w), { at: now, w });
    const kept: LimitWindow[] = [];
    for (const [key, s] of seen) {
      if (s.at === now) continue;
      if (now - s.at > KEEP_LAST_GOOD_MS) seen.delete(key);
      else if (s.w.resetsAt !== null && s.w.resetsAt <= now) kept.push({ ...s.w, usedPercent: 0, resetsAt: null });
      else kept.push({ ...s.w, stale: true, seenAt: s.at });
    }
    return kept.length ? { ...account, windows: [...account.windows, ...kept] } : account;
  };
  const collect = async (now = Date.now()): Promise<LimitAccount[]> => {
    const fresh = await collectLimits(discover, callRpc, selfId, timeoutMs, knownKeys);
    const out: LimitAccount[] = [];
    for (const [id, last] of lastGood) if (now - last.at > KEEP_LAST_GOOD_MS) lastGood.delete(id);
    for (const { id, account } of fresh) {
      const last = lastGood.get(id);
      // Kept with the windows this report left out, so a later fallback still has them.
      if (account.status === 'ok') { const full = withMissing(id, account, now); lastGood.set(id, { at: now, account: full }); out.push(full); }
      else if (last) out.push({ ...last.account, stale: true, message: account.message ?? account.status });
      else out.push(account);
    }
    const ids = new Set(fresh.map(f => f.id));
    for (const [id, last] of lastGood) {
      if (!ids.has(id)) out.push({ ...last.account, stale: true, message: 'not reported' });
    }
    return out;
  };
  return Object.assign(collect, { state: (): CollectorState => ({ good: [...lastGood], keys: [...knownKeys] }) });
}

function toAccount(r: z.infer<typeof listSchema>['resources'][number], got: z.infer<typeof resourceSchema>): LimitAccount {
  const u = got.usage;
  return {
    providerId: r.providerId, label: r.label, host: hostOf(r), plan: u.planLabel ?? null, planId: u.plan?.id ?? null, multiplier: u.plan?.multiplier ?? null, status: u.status, message: u.message ?? null, observedAt: got.observedAt ?? null,
    windows: (u.windows ?? []).map((w, i) => {
      const resetsAt = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
      // Sources lowercase a model family after the separator ("Weekly · fable"); names are capitalized as bb writes them.
      const label = w.label.replace(/(^|· )(\p{Ll})/gu, (_, sep: string, c: string) => sep + c.toUpperCase());
      return { id: w.id ?? `${i}:${label}`, label, kind: w.kind ?? 'custom', usedPercent: w.usedPercent, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null, model: w.model ?? null };
    }),
  };
}

const hostOf = ({ scope: s }: z.infer<typeof listSchema>['resources'][number]) =>
  s?.kind === 'host' && s.hostId ? { id: s.hostId, name: s.hostName || s.hostId } : null;

const failed = (r: z.infer<typeof listSchema>['resources'][number], error: unknown): LimitAccount => ({
  providerId: r.providerId, label: r.label, host: hostOf(r), plan: null, status: 'error', message: error instanceof Error ? error.message : String(error), observedAt: null, windows: [],
});
