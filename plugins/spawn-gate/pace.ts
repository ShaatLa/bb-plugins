import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const weekMs = 7 * 24 * 60 * 60 * 1000;
const maxAgeMs = 60 * 60 * 1000;
export const defaultPaceThreshold = 1.25;

const providerId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/);
const model = z.string().min(1).max(1000);
const candidate = z.object({ providerId, model: model.optional() }).strict();
export const providerPolicy = z.object({
  eligible: z.array(candidate).min(1).max(16)
    .refine(items => new Set(items.map(item => item.providerId)).size === items.length, "List each eligible provider once"),
  reason: z.string().max(2000).optional(),
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
export const paceReport = z.object({
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
  const unknown = { providerId: item.providerId, source, window: null, usedPercent: null, elapsedShare: null, pace: null };
  if (!hostId || !source) return { row: unknown, room: false };
  try {
    const inventory = await bb.sdk.plugins.callRpc({ pluginId: source, method: "provider-usage.v1.listResources", input: {}, outputSchema: resources, signal });
    const matches = inventory.resources.filter(resource => resource.providerId === item.providerId &&
      (resource.scope.kind === "shared" || resource.scope.kind === "host" && resource.scope.hostId === hostId));
    if (matches.length !== 1) return { row: unknown, room: false };
    const [resource] = matches;
    const reading = await bb.sdk.plugins.callRpc({ pluginId: source, method: "provider-usage.v1.getResource",
      input: { resourceId: resource.id, refresh: false }, outputSchema: measurement, signal });
    const now = Date.now(), observedAt = reading.observedAt;
    if (reading.usage.status !== "ok" || observedAt === null || observedAt > now || now - observedAt > maxAgeMs ||
      resource.accountKey && reading.accountKey && resource.accountKey !== reading.accountKey) return { row: unknown, room: false };
    const weekly = reading.usage.windows.filter(window => applies(window, item));
    const rows = weekly.flatMap(window => {
      const resetAt = Date.parse(window.resetsAt ?? "");
      const elapsedShare = 1 - (resetAt - observedAt) / weekMs;
      if (!Number.isFinite(elapsedShare) || resetAt <= now || elapsedShare < 0 ||
        (elapsedShare === 0 && window.usedPercent > 0)) return [];
      const pace = window.usedPercent === 0 ? 0 : window.usedPercent / 100 / elapsedShare;
      if (!Number.isFinite(pace)) return [];
      return [{ ...unknown, window: window.label, usedPercent: window.usedPercent, elapsedShare, pace }];
    }).sort((a, b) => b.pace - a.pace);
    const row = rows[0] ?? unknown;
    const room = rows.length === weekly.length && row.pace !== null && row.pace < 1 &&
      weekly.every(window => window.usedPercent < 100);
    return { row, room };
  } catch {
    return { row: unknown, room: false };
  }
}

export async function assessPace(bb: BbPluginApi, policy: z.infer<typeof providerPolicy>, selected: Candidate,
  hostId: string | undefined, threshold: number, signal: AbortSignal) {
  const sources = hostId ? await bb.sdk.providers.list({ hostId, capability: "usage" }).catch(() => []) : [];
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  const readings = await Promise.all(policy.eligible.map(item => sample(bb, item.providerId === selected.providerId ? selected : item,
    hostId, sources.find(source => source.id === item.providerId)?.pluginId ?? null, deadline)));
  const providers = readings.map(({ row }) => row);
  const chosen = providers.find(row => row.providerId === selected.providerId);
  const alternatives = readings.filter(({ row, room }) => room && row.providerId !== selected.providerId)
    .sort((a, b) => (a.row.pace ?? Infinity) - (b.row.pace ?? Infinity));
  const alternative = alternatives[0]?.row.providerId;
  const overPace = chosen?.pace != null && chosen.pace >= threshold && alternative !== undefined;
  const report: Report = { threshold, providers, overridden: overPace && !!policy.reason?.trim() };
  const summary = providers.map(row => {
    const pace = row.pace === null ? "unknown" : row.pace.toFixed(2);
    return `${row.providerId}: ${pace} (${row.source ?? "no usage source"}${row.window ? ` · ${row.window}` : ""})`;
  }).join("; ");
  if (overPace && !report.overridden) {
    throw new Error(`Provider pace meets or exceeds ${threshold.toFixed(2)} for ${selected.providerId} while ${alternative} has room. Use ${alternative} or give an explicit reason in the launch request. ${summary}`);
  }
  return { report, summary };
}
