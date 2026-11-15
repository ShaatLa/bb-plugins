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

const threadIds = z.array(z.string().min(1)).min(1).max(200);

// ---- Public RPC (PLAN §6.1) ----

const costsInput = z.object({ threadIds, includeDescendants: z.boolean() });

const threadCostSchema = z.object({
  threadId: z.string(), own: costSchema, total: costSchema, descendantCount: count, updatedAt: num,
});

// ---- UI RPC ----

const topThreadItem = z.object({
  threadId: z.string(), title: z.string(), projectId: z.string(), provider: z.string(), own: costSchema, total: costSchema,
});

const limitWindow = z.object({
  provider: z.string(), id: z.string(), label: z.string(), kind: z.string(), usedPercent: num,
  resetsAt: z.string().nullable(), model: z.string().nullable(), since: nullableNum,
  byModel: z.array(z.object({ model: z.string(), cost: costSchema })).nullable(),
});

export const rpcContract = defineRpcContract({
  "costs.threads": {
    tags,
    input: costsInput,
    output: z.object({ priceVersion: z.string(), threads: z.array(threadCostSchema) }),
  },
  "costs.sum": {
    tags,
    input: costsInput,
    output: z.object({ priceVersion: z.string(), cost: costSchema, threadCount: count, updatedAt: num }),
  },
  summary: {
    tags,
    input: z.object({ range: rangeSchema, by: z.enum(["provider", "model"]) }),
    output: z.object({
      range: rangeSchema, from: num, to: num,
      buckets: z.array(z.object({ start: num, series: z.record(z.string(), costSchema) })),
      totals: costSchema,
      previous: costSchema.nullable(),
      cacheReadShare: nullableNum,
      breakdown: z.array(z.object({ key: z.string(), label: z.string(), cost: costSchema, calls: count })),
      compactionSavings: savingSchema,
      localSavings: savingSchema.extend({ referenceModel: z.string() }),
    }),
  },
  topThreads: {
    tags,
    input: z.object({ range: rangeSchema, offset: z.number().int().min(0), limit: z.number().int().min(1).max(50) }),
    output: z.object({ items: z.array(topThreadItem), hasMore: z.boolean() }),
  },
  compactions: {
    tags,
    input: z.object({ range: rangeSchema }),
    output: z.object({
      items: z.array(z.object({
        id: z.string(), threadId: z.string(), title: z.string(), at: num, beforeTokens: num, afterTokens: num,
        origin: z.enum(["bb", "idle-compact"]), saving: savingSchema,
      })),
    }),
  },
  limits: {
    tags,
    input: z.object({}),
    output: z.object({ fetchedAt: num, windows: z.array(limitWindow) }),
  },
  status: {
    tags,
    input: z.object({}),
    output: z.object({
      sources: z.array(z.object({
        id: z.string(), lastIngestAt: nullableNum, rows: count, lastError: z.string().nullable(), state: z.string(),
      })),
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
