import { describe, expect, it } from "vitest";
import { capacities, isPool, parseSizes, planSize, poolAccounts, simulate, type Account } from "./pool";

const H = 3_600_000, NOW = 1_000 * H;
const win = (o: { id?: string; kind?: string; model?: string | null; used: number; resetsIn: number; length?: number; perPercent?: number | null; spend?: number }) => ({
  id: o.id ?? o.kind ?? "weekly", label: o.kind === "five-hour" ? "Five-hour limit" : "Weekly limit", kind: o.kind ?? "weekly", model: o.model ?? null,
  usedPercent: o.used, resetsAt: NOW + o.resetsIn * H, startsAt: NOW + (o.resetsIn - (o.length ?? 168)) * H,
  elapsedShare: ((o.length ?? 168) - o.resetsIn) / (o.length ?? 168), forecastPercent: null, runsOutAt: null,
  usage: { heavy: { usd: o.spend ?? 0, calls: 1 }, other: { usd: 0, calls: 0 }, heavyShare: null, usdPerPercent: o.perPercent ?? null, partial: false },
});
const account = (providerId: string, label: string, plan: string, windows: ReturnType<typeof win>[]): Account =>
  ({ providerId, label, plan, status: "ok", message: null, observedAt: NOW, windows });

describe("subscription pool", () => {
  it("prices the pool with one rate: the provider's spend over the plan units used, once 10% is used", () => {
    // Spend is per provider: $600 since the earliest start paid for 50% + 10% of two equal plans, so 100% is $1000 each.
    expect(capacities([win({ used: 50, resetsIn: 10, spend: 600 }), win({ used: 10, resetsIn: 100, spend: 300 })]))
      .toEqual({ caps: [1000, 1000], money: true, estimated: true });
    expect(capacities([win({ used: 2, resetsIn: 10 }), win({ used: 0, resetsIn: 10 })])).toEqual({ caps: [100, 100], money: false, estimated: true });
  });

  it("weighs subscriptions by plan size when every one has a size, with dollars only as the scale", () => {
    // 92% of a 20x plan and 0% of a 5x one: 73.6% of the pool is used, not the 46% of equal weights.
    const c = capacities([win({ used: 92, resetsIn: 90, spend: 1472 }), win({ used: 0, resetsIn: 160 })], [20, 5]);
    expect(c).toMatchObject({ money: true, estimated: false });
    expect(c.caps[0]).toBeCloseTo(1600);
    expect(c.caps[1]).toBeCloseTo(400);
    expect((0.92 * c.caps[0]!) / (c.caps[0]! + c.caps[1]!)).toBeCloseTo(0.736);
    expect(capacities([win({ used: 2, resetsIn: 10 }), win({ used: 0, resetsIn: 10 })], [20, 5])).toEqual({ caps: [2000, 500], money: false, estimated: false });
    const sizes = parseSizes(" Pro=20, self_serve_business_prolite = 5,");
    expect([...sizes]).toEqual([["pro", 20], ["self_serve_business_prolite", 5]]);
    const a = account("codex", "x@example.com", "Self_serve_business_prolite", []);
    expect([planSize({ ...a, planId: "self_serve_business_prolite" }, sizes), planSize(a, sizes), planSize({ ...a, multiplier: 2 }, sizes), planSize({ ...a, plan: "Plus" }, sizes)]).toEqual([5, 5, 2, null]);
  });

  it("lasts when refills come in time, runs out with the gap to the next refill otherwise", () => {
    // 100 left, refilled to 1000 in 10 h, at 5/h: lasts.
    expect(simulate([{ left: 100, cap: 1000, resetsAt: NOW + 10 * H, length: 168 * H }], 5 / H, NOW)).toEqual({ kind: "lasts", until: NOW + 10 * H });
    // 100 + 50 left at 10/h, first refill in 20 h: empty after 15 h, 5 h without a limit.
    const out = simulate([{ left: 100, cap: 1000, resetsAt: NOW + 20 * H, length: 168 * H }, { left: 50, cap: 1000, resetsAt: NOW + 40 * H, length: 168 * H }], 10 / H, NOW);
    expect(out).toEqual({ kind: "runsOut", at: NOW + 15 * H, refillAt: NOW + 20 * H });
    // Past the first refill: 500 a week at 5/h lasts 100 h, so the pool runs dry 110 h out until the next reset.
    expect(simulate([{ left: 100, cap: 500, resetsAt: NOW + 10 * H, length: 168 * H }], 5 / H, NOW)).toEqual({ kind: "runsOut", at: NOW + 110 * H, refillAt: NOW + 178 * H });
  });

  it("pools two subscriptions of a provider, leaves a single one alone, and says which to spend first", () => {
    const shown = poolAccounts([
      account("claude-code", "a@example.com", "Ultra", [win({ used: 90, resetsIn: 30, perPercent: 20, spend: 1800 })]),
      account("codex", "c@example.com", "Pro", [win({ used: 40, resetsIn: 50, perPercent: 10, spend: 400 })]),
      account("claude-code", "b@example.com", "Max", [win({ kind: "five-hour", used: 80, resetsIn: 2, length: 5, spend: 240 }), win({ used: 5, resetsIn: 160 })]),
    ], NOW);
    expect(shown.map((x) => (isPool(x) ? `pool:${x.providerId}` : x.label))).toEqual(["pool:claude-code", "c@example.com"]);
    const pool = shown[0]!;
    if (!isPool(pool)) throw new Error("expected a pool");
    // Weekly: 90% and 5% of two equal plans used → 52.5% left; the five-hour window is a row of its own.
    expect(pool.rows.map((r) => [r.kind, Math.round(r.usedPercent * 10) / 10])).toEqual([["five-hour", 80], ["weekly", 47.5]]);
    expect(pool.leftShare).toBeCloseTo(0.525);
    // The five-hour row gets its own "out in": $240 bought 80%, so $60 is left; at $80/h it runs dry in 45 min, before its reset in 2 h.
    expect((pool.rows[0]!.runsOutAt! - NOW) / H).toBeCloseTo(0.75);
    expect(pool.rows[1]!.runsOutAt).toBeNull();
    // Pace tick: Ultra's week is 138/168 through and Max's 8/168; with equal capacity the pool's is the mean.
    expect(pool.rows[1]!.elapsedShare).toBeCloseTo((138 / 168 + 8 / 168) / 2);
    // $1800 since Ultra's start paid for 95% of one plan: $1894.7 a plan, 52.5% of two left.
    expect(pool.leftUsd).toBeCloseTo((1800 / 0.95) * 2 * 0.525);
    expect(pool.estimated).toBe(true);
    // Spend 1800 over 138 h ≈ 13/h: Ultra's $95 runs dry before its reset in 30 h, Max covers the rest, and the pool lasts.
    expect(pool.outlook).toEqual({ kind: "lasts", until: NOW + 30 * H });
    expect(pool.ratePerHour).toBeCloseTo(1800 / 138);
    expect(pool.runway! / H).toBeCloseTo(pool.leftUsd! / (1800 / 138));
    expect(pool.first).toMatchObject({ resetsAt: NOW + 30 * H, burnsShare: 0 });
    expect(pool.first!.account.plan).toBe("Ultra");
  });

  it("takes the last week's pace for long windows and needs a 10% margin to call a run-out", () => {
    const pool = (perHour: number) => {
      const w = (used: number, resetsIn: number) => ({ ...win({ used, resetsIn, spend: 1000 }), usage: { ...win({ used, resetsIn, spend: 1000 }).usage, recentUsdPerHour: perHour } });
      const x = poolAccounts([account("codex", "a@example.com", "Pro", [w(50, 100)]), account("codex", "b@example.com", "Plus", [w(50, 100)])], NOW)[0]!;
      if (!isPool(x)) throw new Error("expected a pool");
      return x;
    };
    // The provider's $1000 bought 50% of each of two equal plans: $1000 a plan, $1000 left in all, 100 h to the shared reset.
    expect(pool(5).outlook?.kind).toBe("lasts");
    expect(pool(10.5).outlook?.kind).toBe("lasts"); // needs $1050 by the reset: under 10% over, not called
    expect(pool(15).outlook).toMatchObject({ kind: "runsOut", at: NOW + (1000 / 15) * H });
    expect(pool(15).ratePerHour).toBeCloseTo(15);
  });
});
