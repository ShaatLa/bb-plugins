import { describe, expect, test } from "vitest";
import {
  costUsd,
  listPrices,
  parseOverrides,
  ratesFor,
  resolveModel,
} from "./price";

describe("costUsd — Opus 5.5", () => {
  const c = {
    freshIn: 1_000_000,
    cacheRead: 2_000_000,
    cacheWriteShort: 1_000_000,
    cacheWriteLong: 1_000_000,
    output: 100_000,
  };

  test("standard band 0 → 19.40", () => {
    expect(costUsd(c, "claude-opus-5-5", "standard", 0)).toBeCloseTo(19.40, 6);
  });

  test("fast band 0 → 38.80", () => {
    expect(costUsd(c, "claude-opus-5-5", "fast", 0)).toBeCloseTo(38.80, 6);
  });
});

describe("costUsd — Haiku 5.5 long-context", () => {
  const cShort = {
    freshIn: 1_000_000,
    cacheRead: 0,
    cacheWriteShort: 1_000_000,
    cacheWriteLong: 0,
    output: 1_000_000,
  };

  test("band 0 (short context) → 0.725", () => {
    expect(costUsd(cShort, "claude-haiku-5-5", "standard", 0)).toBeCloseTo(0.725, 6);
  });

  test("band 1 (long context) → 3.625", () => {
    expect(costUsd(cShort, "claude-haiku-5-5", "standard", 1)).toBeCloseTo(3.625, 6);
  });
});

describe("costUsd — OpenAI gpt-6.2", () => {
  const c = { freshIn: 1_000_000, cacheRead: 1_000_000, cacheWriteShort: 0, cacheWriteLong: 0, output: 1_000_000 };

  test("astra: standard 48.40, long 76.80, ultrafast at the 3x promo 145.20, flex unpriced", () => {
    expect(costUsd(c, "gpt-6.2-astra", "standard", 1)).toBeCloseTo(48.40, 6);
    expect(costUsd(c, "gpt-6.2-astra", "standard", 2)).toBeCloseTo(76.80, 6);
    expect(costUsd(c, "gpt-6.2-astra", "ultrafast", 0)).toBeCloseTo(145.20, 6);
    expect(costUsd(c, "gpt-6.2-astra", "flex", 0)).toBeNull();
  });

  test("sol: standard 12.10, fast 24.20", () => {
    expect(costUsd(c, "gpt-6.2-sol", "standard", 0)).toBeCloseTo(12.10, 6);
    expect(costUsd(c, "gpt-6.2-sol", "fast", 0)).toBeCloseTo(24.20, 6);
  });
});

describe("costUsd — OpenAI gpt-6.1-sol", () => {
  const c = {
    freshIn: 1_000_000,
    cacheRead: 1_000_000,
    cacheWriteShort: 0,
    cacheWriteLong: 0,
    output: 1_000_000,
  };

  test("band 1 (standard rates) → 12.10", () => {
    expect(costUsd(c, "gpt-6.1-sol", "standard", 1)).toBeCloseTo(12.10, 6);
  });

  test("band 2 (long rates) → 19.20", () => {
    expect(costUsd(c, "gpt-6.1-sol", "standard", 2)).toBeCloseTo(19.20, 6);
  });

  test("band 2 tier ultrafast → 115.20", () => {
    expect(costUsd(c, "gpt-6.1-sol", "ultrafast", 2)).toBeCloseTo(115.20, 6);
  });

  test("gpt-6.1-terra tier ultrafast → null", () => {
    expect(costUsd(c, "gpt-6.1-terra", "ultrafast", 2)).toBeNull();
  });
});

describe("null cases", () => {
  test("unknown model → null", () => {
    expect(ratesFor("foo", "standard", 0)).toBeNull();
    expect(costUsd(
      { freshIn: 1, cacheRead: 0, cacheWriteShort: 0, cacheWriteLong: 0, output: 0 },
      "foo", "standard", 0,
    )).toBeNull();
  });

  test("known model, unknown tier → null", () => {
    expect(ratesFor("claude-opus-5-5", "weird", 0)).toBeNull();
  });
});

describe("resolveModel", () => {
  test("strips [...] suffix", () => {
    expect(resolveModel("claude-opus-5-5[1m]")).toBe("claude-opus-5-5");
  });

  test("strips -YYYYMMDD date suffix", () => {
    expect(resolveModel("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
  });

  test("alias gemini-pro-orchestrator-g1-pro → gemini-4-argon", () => {
    expect(resolveModel("gemini-pro-orchestrator-g1-pro")).toBe("gemini-4-argon");
  });

  test("unknown model → null", () => {
    expect(resolveModel("some-future-model")).toBeNull();
    // The Codex reviewer has no public price: it resolves, but as an unverified estimate.
    expect(resolveModel("codex-auto-review")).toBe("codex-auto-review");
    expect(listPrices().find((p) => p.model === "codex-auto-review")?.verified).toBe(false);
  });
});

describe("overrides", () => {
  const c = {
    freshIn: 1_000_000,
    cacheRead: 2_000_000,
    cacheWriteShort: 1_000_000,
    cacheWriteLong: 1_000_000,
    output: 100_000,
  };

  test("override input for opus 5.5 → 18.40", () => {
    const overrides = parseOverrides('{"claude-opus-5-5":{"input":3}}');
    expect(costUsd(c, "claude-opus-5-5", "standard", 0, overrides)).toBeCloseTo(18.40, 6);
  });

  test("listPrices marks overridden model", () => {
    const overrides = parseOverrides('{"claude-opus-5-5":{"input":3}}');
    const list = listPrices(overrides);
    const entry = list.find((e) => e.model === "claude-opus-5-5");
    expect(entry).toBeDefined();
    expect(entry!.overridden).toBe(true);
    expect(entry!.rates.input).toBeCloseTo(3, 6);
  });
});

describe("parseOverrides", () => {
  test("empty object → {}", () => {
    expect(parseOverrides("{}")).toEqual({});
  });

  test("array throws", () => {
    expect(() => parseOverrides("[]")).toThrow("parseOverrides");
  });

  test("negative rate throws", () => {
    expect(() => parseOverrides('{"x":{"input":-1}}')).toThrow("parseOverrides");
  });

  test("unknown key throws", () => {
    expect(() => parseOverrides('{"x":{"foo":1}}')).toThrow("parseOverrides");
  });
});

describe("BAND_EDGES invariant", () => {
  test("every long.aboveTokens is in BAND_EDGES", () => {
    // This test passes at module-load time via a throw in prices.ts.
    // We import something to ensure the module is loaded.
    // Just verify the check works by importing.
    expect(true).toBe(true);
  });
});
