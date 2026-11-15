import { BAND_EDGES } from "../contract";

/**
 * Token prices in USD per million tokens.
 */
export type Rates = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWriteShort: number;
  cacheWriteLong: number;
};

export type Entry = {
  /** Band-0 (standard) rates */
  rates: Rates;
  /** Long-context rates; aboveTokens must be in BAND_EDGES */
  long?: { aboveTokens: number; rates: Rates };
  /** Tier name → multiplier applied to every rate */
  tiers: Record<string, number>;
  verified: boolean;
  source: string;
};

/** Version date string for the pricing table. */
export const PRICE_TABLE_VERSION = "2026-11-15";

/**
 * All known model price entries.
 * All numbers are USD per million tokens.
 * Anthropic cache writes: cacheWriteShort = 1.25 × input, cacheWriteLong = 2 × input.
 */
export const PRICES: Record<string, Entry> = {
  // ────────────────────────────────────────── Anthropic ──────────────────────────────────────────

  "claude-opus-5-5": {
    rates: { input: 4, output: 20, cacheRead: 0.20, cacheWriteShort: 5, cacheWriteLong: 8 },
    tiers: { standard: 1, fast: 2 },
    verified: true,
    source: "claude-api skill 2026-11-03",
  },
  "claude-opus-5": {
    rates: { input: 5, output: 25, cacheRead: 0.50, cacheWriteShort: 6.25, cacheWriteLong: 10 },
    tiers: { standard: 1, fast: 2 },
    verified: true,
    source: "claude-api skill 2026-11-03",
  },
  "claude-opus-4-8": {
    rates: { input: 5, output: 25, cacheRead: 0.50, cacheWriteShort: 6.25, cacheWriteLong: 10 },
    tiers: { standard: 1, fast: 2 },
    verified: true,
    source: "claude-api skill 2026-11-03",
  },
  "claude-opus-4-7": {
    rates: { input: 5, output: 25, cacheRead: 0.50, cacheWriteShort: 6.25, cacheWriteLong: 10 },
    tiers: { standard: 1 },
    verified: true,
    source: "claude-api skill 2026-11-03",
  },
  "claude-opus-4-6": {
    rates: { input: 5, output: 25, cacheRead: 0.50, cacheWriteShort: 6.25, cacheWriteLong: 10 },
    tiers: { standard: 1 },
    verified: true,
    source: "claude-api skill 2026-11-03",
  },
  "claude-fable-5-2": {
    rates: { input: 8, output: 40, cacheRead: 0.20, cacheWriteShort: 10, cacheWriteLong: 16 },
    tiers: { standard: 1, fast: 2 },
    verified: true,
    source: "claude-api skill 2026-11-03",
  },
  "claude-fable-5-1": {
    rates: { input: 10, output: 50, cacheRead: 0.25, cacheWriteShort: 12.5, cacheWriteLong: 20 },
    tiers: { standard: 1 },
    verified: true,
    source: "claude-api skill 2026-11-03",
  },
  "claude-fable-5": {
    rates: { input: 10, output: 50, cacheRead: 1, cacheWriteShort: 12.5, cacheWriteLong: 20 },
    tiers: { standard: 1 },
    verified: true,
    source: "claude-api skill 2026-11-03",
  },
  "claude-sonnet-5-5": {
    rates: { input: 2, output: 10, cacheRead: 0.10, cacheWriteShort: 2.5, cacheWriteLong: 4 },
    tiers: { standard: 1 },
    verified: true,
    source: "claude-api skill 2026-11-03",
  },
  "claude-sonnet-5": {
    rates: { input: 2, output: 10, cacheRead: 0.20, cacheWriteShort: 2.5, cacheWriteLong: 4 },
    tiers: { standard: 1 },
    verified: true,
    source: "claude-api skill 2026-11-03",
  },
  "claude-sonnet-4-6": {
    rates: { input: 3, output: 15, cacheRead: 0.30, cacheWriteShort: 3.75, cacheWriteLong: 6 },
    tiers: { standard: 1 },
    verified: true,
    source: "claude-api skill 2026-11-03",
  },
  "claude-haiku-5-5": {
    rates: {
      input: 0.10,
      output: 0.50,
      cacheRead: 0.01,
      cacheWriteShort: 0.125,
      cacheWriteLong: 0.20,
    },
    long: {
      aboveTokens: 100_000,
      rates: {
        input: 0.50,
        output: 2.50,
        cacheRead: 0.05,
        cacheWriteShort: 0.625,
        cacheWriteLong: 1.0,
      },
    },
    tiers: { standard: 1 },
    verified: true,
    source: "claude-api skill 2026-11-03",
  },
  "claude-haiku-4-5": {
    rates: { input: 1, output: 5, cacheRead: 0.10, cacheWriteShort: 1.25, cacheWriteLong: 2 },
    tiers: { standard: 1 },
    verified: true,
    source: "claude-api skill 2026-11-03",
  },

  // ────────────────────────────────────────────── OpenAI ──────────────────────────────────────────

  "gpt-6.1-sol": {
    rates: { input: 2, cacheRead: 0.10, cacheWriteShort: 2.50, cacheWriteLong: 5, output: 10 },
    long: {
      aboveTokens: 272_000,
      rates: { input: 4, cacheRead: 0.20, cacheWriteShort: 5, cacheWriteLong: 10, output: 15 },
    },
    tiers: { standard: 1, fast: 2, flex: 0.5, batch: 0.5, ultrafast: 6 },
    verified: true,
    source: "developers.openai.com/api/docs/pricing 2026-11-15",
  },
  "gpt-6-astra": {
    rates: { input: 10, cacheRead: 1, cacheWriteShort: 12.50, cacheWriteLong: 25, output: 50 },
    long: {
      aboveTokens: 272_000,
      rates: { input: 20, cacheRead: 2, cacheWriteShort: 25, cacheWriteLong: 50, output: 75 },
    },
    tiers: { standard: 1, fast: 2, flex: 0.5, batch: 0.5, ultrafast: 6 },
    verified: true,
    source: "developers.openai.com/api/docs/pricing 2026-11-15",
  },
  "gpt-6.1-terra": {
    rates: { input: 1, cacheRead: 0.05, cacheWriteShort: 1.25, cacheWriteLong: 2.50, output: 5 },
    long: {
      aboveTokens: 272_000,
      rates: { input: 2, cacheRead: 0.10, cacheWriteShort: 2.50, cacheWriteLong: 5, output: 7.50 },
    },
    tiers: { standard: 1, fast: 2, flex: 0.5, batch: 0.5 },
    verified: true,
    source: "developers.openai.com/api/docs/pricing 2026-11-15",
  },
  "gpt-6-sol": {
    rates: { input: 2, cacheRead: 0.20, cacheWriteShort: 2.50, cacheWriteLong: 5, output: 10 },
    long: {
      aboveTokens: 272_000,
      rates: { input: 4, cacheRead: 0.40, cacheWriteShort: 5, cacheWriteLong: 10, output: 15 },
    },
    tiers: { standard: 1, fast: 2, flex: 0.5, batch: 0.5 },
    verified: true,
    source: "developers.openai.com/api/docs/pricing 2026-11-15",
  },
  "gpt-6-luna": {
    rates: { input: 0.10, cacheRead: 0.01, cacheWriteShort: 0.125, cacheWriteLong: 0.25, output: 0.50 },
    long: {
      aboveTokens: 272_000,
      rates: { input: 0.20, cacheRead: 0.02, cacheWriteShort: 0.25, cacheWriteLong: 0.50, output: 0.75 },
    },
    tiers: { standard: 1, fast: 2, flex: 0.5, batch: 0.5 },
    verified: true,
    source: "developers.openai.com/api/docs/pricing 2026-11-15",
  },
  "gpt-5.6-sol": {
    rates: { input: 4, cacheRead: 0.40, cacheWriteShort: 5, cacheWriteLong: 10, output: 20 },
    long: {
      aboveTokens: 272_000,
      rates: { input: 8, cacheRead: 0.80, cacheWriteShort: 10, cacheWriteLong: 20, output: 30 },
    },
    tiers: { standard: 1, fast: 2, flex: 0.5, batch: 0.5 },
    verified: true,
    source: "developers.openai.com/api/docs/pricing 2026-11-15",
  },
  "gpt-5.6-terra": {
    rates: { input: 2, cacheRead: 0.20, cacheWriteShort: 2.50, cacheWriteLong: 5, output: 12 },
    long: {
      aboveTokens: 272_000,
      rates: { input: 4, cacheRead: 0.40, cacheWriteShort: 5, cacheWriteLong: 10, output: 18 },
    },
    tiers: { standard: 1, fast: 2, flex: 0.5, batch: 0.5 },
    verified: true,
    source: "developers.openai.com/api/docs/pricing 2026-11-15",
  },
  "gpt-5.6-luna": {
    rates: { input: 0.20, cacheRead: 0.02, cacheWriteShort: 0.25, cacheWriteLong: 0.50, output: 1.20 },
    long: {
      aboveTokens: 272_000,
      rates: { input: 0.40, cacheRead: 0.04, cacheWriteShort: 0.50, cacheWriteLong: 1, output: 1.80 },
    },
    tiers: { standard: 1, fast: 2, flex: 0.5, batch: 0.5 },
    verified: true,
    source: "developers.openai.com/api/docs/pricing 2026-11-15",
  },

  // ───────────────────────────────────────────── Gemini ──────────────────────────────────────────

  "gemini-4-argon": {
    rates: { input: 2, output: 10, cacheRead: 0.10, cacheWriteShort: 0, cacheWriteLong: 0 },
    tiers: { standard: 1 },
    verified: false,
    source: "AI Studio pricing page, unverified",
  },
  "gemini-4-hydrogen": {
    rates: { input: 1.50, output: 7.50, cacheRead: 0, cacheWriteShort: 0, cacheWriteLong: 0 },
    tiers: { standard: 1 },
    verified: false,
    source: "AI Studio pricing page, unverified",
  },
  "gemini-3.8-flash": {
    rates: { input: 0.75, output: 3.75, cacheRead: 0, cacheWriteShort: 0, cacheWriteLong: 0 },
    tiers: { standard: 1 },
    verified: false,
    source: "AI Studio pricing page, unverified",
  },

  // NOTE: gemini-pro-orchestrator-g1-pro is handled as an alias in resolveModel().
};

/** Ensure every long.aboveTokens is in BAND_EDGES at module load time. */
for (const [_key, entry] of Object.entries(PRICES)) {
  if (entry.long) {
    const idx = (BAND_EDGES as unknown as number[]).indexOf(entry.long.aboveTokens);
    if (idx === -1) {
      throw new Error(
        `long.aboveTokens (${entry.long.aboveTokens}) for "${_key}" is not in BAND_EDGES [${BAND_EDGES.join(", ")}]`
      );
    }
  }
}
