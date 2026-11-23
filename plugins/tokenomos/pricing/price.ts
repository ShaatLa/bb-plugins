import { BAND_EDGES } from "../contract";
import { PRICE_TABLE_VERSION, PRICES } from "./prices";

/** Price rates in USD per million tokens. */
export type Rates = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWriteShort: number;
  cacheWriteLong: number;
};

/** Model-keyed partial-rate overrides for band-0 standard rates. */
export type Overrides = Record<string, Partial<Rates>>;

/** Token-usage breakdown for cost calculation. */
export type Components = {
  freshIn: number;
  cacheRead: number;
  cacheWriteShort: number;
  cacheWriteLong: number;
  output: number;
};

const RATE_KEYS = new Set([
  "input",
  "output",
  "cacheRead",
  "cacheWriteShort",
  "cacheWriteLong",
]);

const ALIASES: Record<string, string> = {
  "gemini-pro-orchestrator-g1-pro": "gemini-4-argon",
};

/**
 * Normalise a user-facing model id to a table key.
 *
 * - lowercases the input
 * - strips a trailing `[...]` suffix
 * - strips a trailing `-YYYYMMDD` suffix
 * - resolves known aliases
 * - strips a trailing reasoning-level suffix (`-high`, `-medium`) that is not part of a priced id
 *
 * Returns the normalised key if it exists in PRICES, else `null`.
 */
export function resolveModel(id: string): string | null {
  let key = id.toLowerCase();
  key = key.replace(/\[.*\]$/, "");
  key = key.replace(/-\d{8}$/, "");
  key = ALIASES[key] ?? key;
  if (!(key in PRICES)) key = key.replace(/-(minimal|low|medium|high|xhigh|max)$/, "");
  return key in PRICES ? key : null;
}

/**
 * Look up rates for a model, tier, and band, with optional overrides.
 *
 * - Unknown model or unknown tier → `null`.
 * - For long-context models when the band exceeds the long threshold, uses
 *   the long-context rates (overrides do NOT affect long rates).
 * - Otherwise uses band-0 standard rates with any overrides applied.
 * - Every output rate is multiplied by the tier's multiplier.
 */
export function ratesFor(
  model: string,
  tier: string,
  band: number,
  overrides?: Overrides,
): Rates | null {
  const key = resolveModel(model);
  if (key === null) return null;

  const entry = PRICES[key];
  const tierMult = entry.tiers[tier];
  if (tierMult === undefined) return null;

  let baseRates: Rates;
  const isLong =
    entry.long !== undefined &&
    band > (BAND_EDGES as unknown as number[]).indexOf(entry.long.aboveTokens);

  if (isLong) {
    baseRates = { ...entry.long!.rates };
  } else {
    baseRates = { ...entry.rates };
    if (overrides && overrides[key]) {
      const o = overrides[key];
      for (const rk of RATE_KEYS) {
        if ((rk as string) in o) {
          (baseRates as Record<string, number>)[rk] = (o as Record<string, number>)[rk]!;
        }
      }
    }
  }

  return {
    input: baseRates.input * tierMult,
    output: baseRates.output * tierMult,
    cacheRead: baseRates.cacheRead * tierMult,
    cacheWriteShort: baseRates.cacheWriteShort * tierMult,
    cacheWriteLong: baseRates.cacheWriteLong * tierMult,
  };
}

/**
 * Compute the USD cost for a set of token usages.
 * Returns `null` when the model/tier combination is unknown.
 */
export function costUsd(
  c: Components,
  model: string,
  tier: string,
  band: number,
  overrides?: Overrides,
): number | null {
  const rates = ratesFor(model, tier, band, overrides);
  if (rates === null) return null;
  return (
    (c.freshIn * rates.input +
      c.cacheRead * rates.cacheRead +
      c.cacheWriteShort * rates.cacheWriteShort +
      c.cacheWriteLong * rates.cacheWriteLong +
      c.output * rates.output) / 1_000_000
  );
}

/**
 * Return one record per table key with band-0 standard rates, applying any
 * overrides.  `overridden` is true when that model had an override entry.
 */
export function listPrices(overrides?: Overrides): Array<{
  model: string;
  rates: Rates;
  overridden: boolean;
  verified: boolean;
}> {
  const result: Array<{
    model: string;
    rates: Rates;
    overridden: boolean;
    verified: boolean;
  }> = [];
  for (const [key, entry] of Object.entries(PRICES)) {
    const baseRates = { ...entry.rates };
    let overridden = false;
    if (overrides && overrides[key]) {
      const o = overrides[key];
      for (const rk of RATE_KEYS) {
        if ((rk as string) in o) {
          (baseRates as Record<string, number>)[rk] = (o as Record<string, number>)[rk]!;
          overridden = true;
        }
      }
    }
    result.push({ model: key, rates: baseRates, overridden, verified: entry.verified });
  }
  return result;
}

/**
 * Parse a JSON string into an Overrides object.  Throws `Error` on any
 * structural or value-level problem.
 */
export function parseOverrides(json: string): Overrides {
  const parsed = JSON.parse(json);

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("parseOverrides: expected a JSON object");
  }

  const result: Overrides = {};
  for (const [modelKey, val] of Object.entries(parsed)) {
    if (val === null || typeof val !== "object" || Array.isArray(val)) {
      throw new Error(
        `parseOverrides: value for "${modelKey}" must be an object`,
      );
    }
    const rates: Partial<Rates> = {};
    for (const [rk, v] of Object.entries(val)) {
      if (!RATE_KEYS.has(rk)) {
        throw new Error(
          `parseOverrides: unknown key "${rk}" in override for "${modelKey}"`,
        );
      }
      if (
        typeof v !== "number" ||
        !Number.isFinite(v) ||
        v < 0 ||
        v > 100_000
      ) {
        throw new Error(
          `parseOverrides: rate for "${modelKey}.${rk}" must be 0..100000, got ${v}`,
        );
      }
      (rates as Record<string, number>)[rk] = v;
    }
    result[modelKey] = rates;
  }
  return result;
}

export { PRICE_TABLE_VERSION, PRICES };
