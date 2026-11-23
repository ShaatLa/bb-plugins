import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

// ---- Internal types (PLAN §3.1) ----

export type SourceId = "claude-file" | "codex-file" | "local-log" | "agy-log" | "bb-events";

export const RECOVERED = 1;
export const BACKFILLED = 2;
export const ESTIMATED = 4;

/** Prompt-size band edges (PLAN §3.7); a row's band is the number of edges strictly below its prompt. */
export const BAND_EDGES = [100_000, 272_000] as const;
export const bandOf = (promptTokens: number): number => BAND_EDGES.filter((edge) => edge < promptTokens).length;

export type UsageRow = {
  key: string;
  writeSplit?: boolean;
  providerThreadId?: string;
  ts: number;
  threadId: string; // "" outside bb
  projectId: string; // "" unknown, "~outside", "~local-calls"
  provider: string;
  model: string; // "unknown" when unknown
  tier: string; // pricing tier after normalisation
  tierRaw: string;
  promptTokens: number; // fresh + read + write
  band: number;
  conv: string; // "" main conversation; subagent/native-child file id otherwise
  freshIn: number;
  cacheRead: number;
  cacheWriteShort: number;
  cacheWriteLong: number;
  output: number;
  reasoning: number; // informational, inside output
  turnId: string | null;
  source: SourceId;
  flags: number;
};

export type ThreadDtoLike = {
  id: string;
  projectId?: string | null;
  providerId?: string | null;
  parentThreadId?: string | null;
  lifecycleOwnerThreadId?: string | null;
  sourceThreadId?: string | null;
  title?: string | null;
  titleFallback?: string | null;
  createdAt?: string | number | null;
  archivedAt?: string | number | null;
  deletedAt?: string | number | null;
};

export type ApplyResult = { inserted: number; updated: number; touchedThreads: string[] };

// ---- Shared schemas ----

export const USAGE_TAG = "usage";
const tags = () => [USAGE_TAG];
const num = z.number();
const count = z.number().int().nonnegative();
const nullableNum = num.nullable();

export const costSchema = z.object({
  usd: nullableNum,
  tokens: z.object({ freshIn: num, cacheRead: num, cacheWrite: num, output: num }),
  estimated: z.boolean(),
  partial: z.boolean(),
});
export type Cost = z.infer<typeof costSchema>;

export const savingSchema = z.object({ usd: nullableNum, tokens: num, partial: z.boolean(), excludesOwnCost: z.boolean() });
export type Saving = z.infer<typeof savingSchema>;

export const ratesSchema = z.object({
  input: num.min(0), output: num.min(0), cacheRead: num.min(0), cacheWriteShort: num.min(0), cacheWriteLong: num.min(0),
});
export type Rates = z.infer<typeof ratesSchema>;

export const rangeSchema = z.enum(["day", "week", "month", "3m"]);
export type Range = z.infer<typeof rangeSchema>;

const threadIds = z.array(z.string().min(1)).min(1, "Pass at least one thread ID.").max(2000, "Pass at most 2000 thread IDs per call; a larger set needs several calls, and a thread shared between them counts in each.");

// ---- Public RPC (PLAN §6.1) ----

const costsInput = z.object({ threadIds, includeDescendants: z.boolean() });
// costs.sum only: breakdown adds per-thread and per-model rows to the total.
const breakdown = z.boolean().optional();
const costsSumInput = costsInput.extend({ breakdown });
// Time-window form: a call counts only while its thread was inside one of its spans (to: null = until now).
const span = z.object({ threadId: z.string().min(1), from: z.number().int().nonnegative(), to: z.number().int().nonnegative().nullable() })
  .refine(s => s.to === null || s.to >= s.from, { message: "to must be null (until now) or not earlier than from." });
const costsSpansInput = z.object({ spans: z.array(span).min(1, "Pass at least one span.").max(2000, "Pass at most 2000 spans per call."), includeDescendants: z.boolean(), breakdown });
const sumThread = z.object({ threadId: z.string(), title: z.string(), model: z.string(), cost: costSchema });
const sumModel = z.object({ provider: z.string(), model: z.string(), cost: costSchema, calls: count });

const threadCostSchema = z.object({
  threadId: z.string(), own: costSchema, total: costSchema, descendantCount: count, updatedAt: num,
});

// ---- UI RPC ----

const topThreadItem = z.object({
  threadId: z.string(), title: z.string(), projectId: z.string(), provider: z.string(), own: costSchema, total: costSchema,
  calls: count, tokens: num, rangeCost: costSchema, model: z.string(), projectName: z.string().nullable(), childCount: count,
});

const heatmapCell = z.object({
  weekday: count.max(6), hour: count.max(23), usd: nullableNum, tokens: num, calls: count,
});

export const watchlistItemSchema = z.object({
  threadId:z.string(), title:z.string(), provider:z.string(), model:z.string(), contextTokens:num,
  callsLastHour:count, readCostPerCallUsd:nullableNum, costLastHourUsd:nullableNum, lastCallAt:num,
});
export const wakeCostSchema = z.object({
  threadId:z.string(), provider:z.string(), model:z.string(), contextTokens:nullableNum,
  lastCallAt:nullableNum, idleMinutes:nullableNum, ttlMinutes:num, ttlSource:z.enum(['observed','assumed']),
  cacheLikelyExpired:z.boolean().nullable(), coldCostUsd:nullableNum, warmCostUsd:nullableNum,
});

const limitPart = z.object({ usd: num, calls: count });
export const limitWindowSchema = z.object({
  id: z.string(), label: z.string(), kind: z.string(), model: z.string().nullable(), usedPercent: num, resetsAt: nullableNum,
  startsAt: nullableNum, elapsedShare: nullableNum, forecastPercent: nullableNum, runsOutAt: nullableNum,
  stale: z.boolean().optional(), seenAt: num.optional(),
  usage: z.object({ heavy: limitPart, other: limitPart, heavyShare: nullableNum, usdPerPercent: nullableNum, partial: z.boolean() }).nullable(),
});
export const limitsSchema = z.object({
  heavyModels: z.array(z.string()),
  /** Target ceiling for the heavy-model share of cost, as a fraction; null when the user turned it off. */
  heavyTarget: nullableNum,
  accounts: z.array(z.object({
    providerId: z.string(), label: z.string(), plan: z.string().nullable(), status: z.string(), message: z.string().nullable(),
    observedAt: nullableNum, windows: z.array(limitWindowSchema), stale: z.boolean().optional(),
  })),
});

export const rpcContract = defineRpcContract({
  limits:{tags,input:z.object({}),output:limitsSchema},
  // One global setting at a time; the value is validated by that setting's own schema on the server.
  'config.get': { input: z.object({}), output: z.object({ values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])) }) },
  'config.options': { input: z.object({}), output: z.object({ referenceModels: z.array(z.object({ model: z.string(), label: z.string(), provider: z.string().nullable() })) }) },
  // `key` is checked against settings.ts on the server; importing it here would cycle through the price table.
  'config.set': { input: z.object({ key: z.string().min(1), value: z.union([z.string(), z.number(), z.boolean()]) }), output: z.object({ ok: z.literal(true) }) },
  watchlist:{tags,input:z.object({}),output:z.object({items:z.array(watchlistItemSchema).max(20)})},
  wakeCost:{tags,input:z.object({threadId:z.string().min(1)}),output:wakeCostSchema},
  "costs.threads": {
    tags,
    input: costsInput,
    output: z.object({ priceVersion: z.string(), threads: z.array(threadCostSchema) }),
  },
  "costs.sum": {
    tags,
    input: z.union([costsSumInput, costsSpansInput]),
    output: z.object({ priceVersion: z.string(), cost: costSchema, threadCount: count, updatedAt: num, threads: z.array(sumThread).optional(), models: z.array(sumModel).optional() }),
  },
  summary: {
    tags,
    input: z.object({ range: rangeSchema, by: z.enum(["provider", "model"]), projectId: z.string().optional() }),
    output: z.object({
      range: rangeSchema, from: num, to: num,
      buckets: z.array(z.object({ start: num, series: z.record(z.string(), costSchema.extend({ calls: count })), localSavedUsd: num.optional() })),
      kpis: z.object({
        spendUsd: nullableNum, spendPrevUsd: nullableNum, tokens: num, tokensPrev: nullableNum,
        calls: count, callsPrev: count.nullable(), threads: count, medianThreadUsd: nullableNum,
        perCallUsd: nullableNum, cacheHitRate: nullableNum, estimated: z.boolean(), partial: z.boolean(),
      }),
      mix: z.object({
        rows: z.array(z.object({
          component: z.enum(["freshIn", "cacheWrite", "cacheRead", "output"]),
          tokens: num, usd: nullableNum, usdPerMTok: nullableNum,
        })),
        reasoningTokens: num,
      }),
      heatmap: z.object({ cells: z.array(heatmapCell), busiest: heatmapCell.nullable() }),
      totals: costSchema,
      previous: costSchema.nullable(),
      cacheReadShare: nullableNum,
      breakdown: z.array(z.object({ key: z.string(), label: z.string(), provider: z.string(), cost: costSchema, calls: count })),
      compactionSavings: savingSchema,
      localSavings: savingSchema.extend({ referenceModel: z.string() }),
    }),
  },
  topThreads: {
    tags,
    input: z.object({ range: rangeSchema, offset: z.number().int().min(0), limit: z.number().int().min(1).max(50), projectId: z.string().optional() }),
    output: z.object({ items: z.array(topThreadItem), hasMore: z.boolean() }),
  },
  compactions: {
    tags,
    input: z.object({ range: rangeSchema, projectId: z.string().optional() }),
    output: z.object({
      items: z.array(z.object({
        id: z.string(), threadId: z.string(), title: z.string(), at: num, beforeTokens: num, afterTokens: num,
        origin: z.enum(["bb", "idle-compact"]), saving: savingSchema,
      })),
    }),
  },
  projects: {
    tags,
    input: z.object({}),
    output: z.object({ items: z.array(z.object({ projectId: z.string(), name: z.string() })) }),
  },
  status: {
    tags,
    input: z.object({}),
    output: z.object({
      sources: z.array(z.object({
        id: z.string(), lastIngestAt: nullableNum, rows: count, lastError: z.string().nullable(), state: z.string(),
      })),
      loop: z.object({ p99Ms: num.nonnegative(), maxMs: num.nonnegative() }).optional(),
      backfill: z.object({ processedThreads:count, totalThreads:count, done:z.boolean(), startedAt:nullableNum }),
      degradedThreads: count,
      disk: z.object({ bytes: num, pages: num, freePages: num, rows: z.record(z.string(), num) }),
    }),
  },
  prices: {
    tags,
    input: z.object({}),
    output: z.object({
      version: z.string(),
      entries: z.array(z.object({ model: z.string(), rates: ratesSchema, overridden: z.boolean(), verified: z.boolean() })),
    }),
  },
  setPriceOverride: {
    input: z.object({ model: z.string().min(1), rates: ratesSchema.partial().nullable() }),
    output: z.object({ ok: z.literal(true) }),
  },
  prune: {
    input: z.object({}),
    output: z.object({ deletedRows: count }),
  },
});

export type TokenomosRpcContract = typeof rpcContract;
