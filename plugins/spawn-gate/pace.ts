import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const weekMs = 7 * 24 * 60 * 60 * 1000;
const maxAgeMs = 60 * 60 * 1000;
export const defaultPaceThreshold = 1.25;

const providerId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/);
const model = z.string().min(1).max(1000);
const candidate = z.object({ providerId, model: model.optional(), reasoningLevel: model.optional() }).strict();
export const providerPolicy = z.object({
  eligible: z.array(candidate).min(1).max(16)
    .refine(items => new Set(items.map(item => item.providerId)).size === items.length, "List each eligible provider once"),
  reason: z.string().max(2000).optional(),
  orderedFallback: z.boolean().optional(),
  pinned: z.boolean().optional(),
}).strict();

const usageWindow = z.object({
  kind: z.string(), label: z.string(), usedPercent: z.number().nonnegative(),
  resetsAt: z.string().nullable(), model: z.string().nullable(),
});
const resources = z.object({ resources: z.array(z.object({
  id: z.string(), providerId, accountKey: z.string().nullish(),
  scope: z.object({ kind: z.string(), hostId: z.string().optional() }),
})) });
const measurement = z.object({
  accountKey: z.string().nullish(), observedAt: z.number().nullable(),
  usage: z.discriminatedUnion("status", [
    z.object({ status: z.literal("ok"), windows: z.array(usageWindow) }),
    z.object({ status: z.enum(["error", "not_installed", "unauthenticated", "expired"]) }),
  ]),
});
const poolId = "account-pool";
const poolRouting = z.object({ claude: z.boolean(), codex: z.boolean() });
const poolWindow = z.object({
  utilization: z.number().nonnegative().nullable(), resetAt: z.number().nullable(),
  observedAt: z.number(), status: z.string().nullable(),
});
const poolStatus = z.object({
  accepting: z.boolean(), routing: poolRouting,
  parent: z.object({ mode: z.string(), availability: poolRouting }).nullable(),
  accounts: z.array(z.object({
    provider: z.string(), enabled: z.boolean(), status: z.string(),
    limitWindows: z.array(poolWindow.extend({ windowMinutes: z.number().nullable() })),
    familyWeekly: z.record(z.string(), poolWindow.nullable()),
  })),
});
export const paceFallback = z.object({
  fromProviderId: providerId, toProviderId: providerId, pace: z.number(), threshold: z.number(),
});
export const paceOverride = z.object({
  providerId, pace: z.number(), threshold: z.number(), reason: z.string().min(1).max(2000),
});
export const paceReport = z.object({
  override: paceOverride.optional(),
  fallback: paceFallback.optional(),
  threshold: z.number(),
  overridden: z.boolean(),
  providers: z.array(z.object({
    providerId, source: z.string().nullable(), window: z.string().nullable(),
    usedPercent: z.number().nullable(), elapsedShare: z.number().nullable(), pace: z.number().nullable(),
  })),
});

type Report = z.infer<typeof paceReport>;
type Candidate = z.infer<typeof candidate>;
type Window = z.infer<typeof usageWindow>;
type PaceWindow = { label: string; usedPercent: number; resetAt: number; observedAt: number };

function unknownReading(item: Candidate, source: string | null) {
  const row: Report["providers"][number] = {
    providerId: item.providerId, source, window: null, usedPercent: null, elapsedShare: null, pace: null,
  };
  return { row, room: false };
}

function score(item: Candidate, source: string, weekly: PaceWindow[]) {
  const unknown = unknownReading(item, source);
  const now = Date.now();
  const rows = weekly.flatMap(({ label, usedPercent, resetAt, observedAt }) => {
    const elapsedShare = 1 - (resetAt - observedAt) / weekMs;
    if (observedAt > now || now - observedAt > maxAgeMs || !Number.isFinite(elapsedShare) ||
      resetAt <= now || elapsedShare < 0 || (elapsedShare === 0 && usedPercent > 0)) return [];
    const pace = usedPercent === 0 ? 0 : usedPercent / 100 / elapsedShare;
    return Number.isFinite(pace) ? [{ ...unknown.row, window: label, usedPercent, elapsedShare, pace }] : [];
  }).sort((a, b) => b.pace - a.pace);
  const row = rows[0];
  if (!row) return unknown;
  return { row, room: rows.length === weekly.length && row.pace < 1 && weekly.every(window => window.usedPercent < 100) };
}

function pooledReading(item: Candidate, pool: z.infer<typeof poolStatus>) {
  const provider = item.providerId === "claude-code" ? "claude" : item.providerId;
  if ((provider !== "claude" && provider !== "codex") || !pool.routing[provider]) return;
  // A nested server's local accounts do not describe the parent pool.
  if (pool.parent?.mode === "proxy") {
    return pool.parent.availability[provider] ? unknownReading(item, poolId) : undefined;
  }
  const accounts = pool.accounts.filter(account => account.provider === provider && account.enabled);
  if (!accounts.length) return;
  const unknown = unknownReading(item, poolId);
  if (!pool.accepting) return unknown;
  const now = Date.now();
  const model = (item.model ?? "").toLowerCase();
  const family = ["fable", "sonnet", "opus", "haiku"].find(name => model.includes(name)) ?? "other";
  const readings = accounts.flatMap(account => {
    if (account.status !== "ready") return [];
    const familyWindow = provider === "claude" ? account.familyWeekly[family] : null;
    const activeWindows = familyWindow ? [...account.limitWindows, familyWindow] : account.limitWindows;
    if (activeWindows.some(window => (window.resetAt === null || window.resetAt > now) &&
      (window.status?.toLowerCase() === "rejected" || (window.utilization ?? 0) >= 1))) return [];
    const weekly = account.limitWindows.filter(window => window.windowMinutes === 10_080)
      .map(window => ({ ...window, label: "Weekly limit" }));
    const windows = familyWindow ? [...weekly, { ...familyWindow, label: `Weekly · ${family}` }] : weekly;
    return [score(item, poolId, windows.map(window => ({
      label: window.label, usedPercent: (window.utilization ?? NaN) * 100,
      observedAt: window.observedAt, resetAt: window.resetAt ?? NaN,
    })))];
  }).sort((a, b) => (a.row.pace ?? Infinity) - (b.row.pace ?? Infinity));
  return readings.find(reading => reading.room) ?? readings[0] ?? unknown;
}

function applies(window: Window, { providerId, model }: Candidate) {
  if (providerId === "antigravity") {
    // Antigravity publishes these weekly buckets as custom windows to preserve its labels.
    return window.label === (/argon/i.test(model ?? "") ? "7d · Argon" : "7d");
  }
  if (window.kind !== "weekly") return false;
  if (!window.model) return true;
  const family = window.model.toLowerCase();
  const normalized = model?.toLowerCase();
  return normalized === family || normalized?.split(/[-_.\s]+/).includes(family);
}

async function sample(bb: BbPluginApi, item: Candidate, hostId: string | undefined, source: string | null, signal: AbortSignal) {
  const unknown = unknownReading(item, source);
  if (!hostId || !source) return unknown;
  try {
    const inventory = await bb.sdk.plugins.callRpc({ pluginId: source, method: "provider-usage.v1.listResources", input: {}, outputSchema: resources, signal });
    const matches = inventory.resources.filter(resource => resource.providerId === item.providerId &&
      (resource.scope.kind === "shared" || resource.scope.kind === "host" && resource.scope.hostId === hostId));
    if (matches.length !== 1) return unknown;
    const [resource] = matches;
    const reading = await bb.sdk.plugins.callRpc({ pluginId: source, method: "provider-usage.v1.getResource",
      input: { resourceId: resource.id, refresh: false }, outputSchema: measurement, signal });
    const { observedAt } = reading;
    if (reading.usage.status !== "ok" || observedAt === null ||
      resource.accountKey && reading.accountKey && resource.accountKey !== reading.accountKey) return unknown;
    return score(item, source, reading.usage.windows.filter(window => applies(window, item))
      .map(window => ({ ...window, resetAt: Date.parse(window.resetsAt ?? ""), observedAt })));
  } catch {
    return unknown;
  }
}

export async function assessPace(bb: BbPluginApi, policy: z.infer<typeof providerPolicy>, selected: Candidate,
  hostId: string | undefined, threshold: number, signal: AbortSignal) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  const [sources, pool] = await Promise.all([
    hostId ? bb.sdk.providers.list({ hostId, capability: "usage" }).catch(() => []) : [],
    hostId && policy.eligible.some(item => item.providerId === "codex" || item.providerId === "claude-code")
      ? bb.sdk.plugins.callRpc({ pluginId: poolId, method: "status.get", input: null, outputSchema: poolStatus, signal: deadline })
        .catch(() => null)
      : null,
  ]);
  const readings = await Promise.all(policy.eligible.map(async candidate => {
    const item = candidate.providerId === selected.providerId ? selected : candidate;
    const source = sources.find(source => source.id === item.providerId)?.pluginId ?? null;
    const reading = (source && pool ? pooledReading(item, pool) : undefined) ?? await sample(bb, item, hostId, source, deadline);
    return { ...reading, candidate };
  }));
  const providers = readings.map(({ row }) => row);
  const pace = providers.find(row => row.providerId === selected.providerId)?.pace;
  const alternatives = readings.filter(({ row }) => row.providerId !== selected.providerId);
  const withRoom = alternatives.filter(({ row, room }) => room && row.pace !== null && row.pace < threshold);
  const ordered = policy.orderedFallback && alternatives.length > 0;
  const report: Report = { threshold, providers, overridden: false };
  const summary = providers.map(row => {
    const pace = row.pace === null ? "unknown" : row.pace.toFixed(2);
    return `${row.providerId}: ${pace} (${row.source ?? "no usage source"}${row.window ? ` · ${row.window}` : ""})`;
  }).join("; ");
  if (pace == null || pace < threshold || (!policy.pinned && !ordered && !withRoom.length)) return { report, summary };
  const reason = policy.reason?.trim();
  if (reason) {
    report.overridden = true;
    if (policy.pinned) report.override = { providerId: selected.providerId, pace, threshold, reason };
    return { report, summary };
  }
  if (policy.pinned) {
    throw new Error(`Pinned provider ${selected.providerId} meets or exceeds pace ${threshold.toFixed(2)}. Give an explicit reason in the launch request. ${summary}`);
  }

  if (ordered) {
    const next = withRoom[0];
    if (next) {
      const fallback = next.candidate;
      report.fallback = { fromProviderId: selected.providerId, toProviderId: fallback.providerId, pace, threshold };
      return { report, summary, fallback };
    }
    const skipped = alternatives.map(({ row }) => {
      const reason = row.pace === null ? "no usable reading (including stale usage)"
        : row.pace >= threshold ? "at or above the pace threshold" : "insufficient quota room";
      return `${row.providerId}: ${reason}`;
    }).join("; ");
    throw new Error(`Provider pace meets or exceeds ${threshold.toFixed(2)} for ${selected.providerId}. No eligible alternative has room (${skipped}). Give an explicit reason in the launch request. ${summary}`);
  }

  const alternate = withRoom.sort((a, b) => (a.row.pace ?? Infinity) - (b.row.pace ?? Infinity))[0].row.providerId;
  throw new Error(`Provider pace meets or exceeds ${threshold.toFixed(2)} for ${selected.providerId} while ${alternate} has room. Use ${alternate} or give an explicit reason in the launch request. ${summary}`);
}
