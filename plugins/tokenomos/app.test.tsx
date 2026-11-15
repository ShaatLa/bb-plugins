// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Cost } from "./contract";
import { buildChart } from "./components/series";
import { bucketLabel, fmtCost, fmtTokens, fmtUsd, parseSubPath, toSubPath } from "./components/format";
import { delta } from "./components/kpis";
import { DICTIONARIES, makeT, translate, type Lang } from "./components/i18n";

afterEach(() => cleanup());

const cost = (usd: number | null, freshIn = 1000, cacheRead = 8000, output = 500, flags: Partial<Cost> = {}): Cost => ({
  usd, tokens: { freshIn, cacheRead, cacheWrite: 200, output }, estimated: false, partial: false, ...flags,
});
const COUNTS = { day: 24, week: 7, month: 30, "3m": 13 } as const;
const HOUR = 3_600_000;
const STEP = { day: HOUR, week: 24 * HOUR, month: 24 * HOUR, "3m": 7 * 24 * HOUR } as const;

type Input = { range: keyof typeof COUNTS; by: "provider" | "model" };
function summary({ range, by }: Input, over: Record<string, unknown> = {}) {
  const from = Date.UTC(2026, 10, 1);
  const keys = by === "provider" ? ["claude-code", "codex"] : ["claude-opus-4", "gpt-5", "qwen3", "m4", "m5", "m6"];
  return {
    range, from, to: from + COUNTS[range] * STEP[range],
    buckets: Array.from({ length: COUNTS[range] }, (_, i) => ({ start: from + i * STEP[range], series: Object.fromEntries(keys.map((k, j) => [k, cost(i + j + 1)])) })),
    totals: cost(12.4, 5_000_000, 87_000_000, 2_000_000, { estimated: true }),
    previous: cost(10),
    cacheReadShare: 0.87,
    breakdown: keys.map((k) => ({ key: k, label: k === "claude-code" ? "Claude Code" : k, cost: cost(3), calls: 42 })),
    compactionSavings: { usd: 1.5, tokens: 340_000, partial: true, excludesOwnCost: true },
    localSavings: { usd: 0.8, tokens: 1_200_000, partial: false, excludesOwnCost: false, referenceModel: "claude-sonnet-4" },
    ...over,
  };
}

const thread = (id: string) => ({ threadId: id, title: `Thread ${id}`, projectId: "p", provider: "codex", own: cost(1.25), total: cost(2.5) });
const compaction = {
  id: "c1", threadId: "t9", title: "Compacted thread", at: Date.UTC(2026, 10, 3, 12), beforeTokens: 900_000, afterTokens: 120_000, origin: "idle-compact" as const,
  saving: { usd: -0.05, tokens: 780_000, partial: true, excludesOwnCost: true },
};


/** Expected texts per UI language; number formats follow the locale (en-US vs ru-RU). */
const L = {
  en: {
    spend: "Spend (API equivalent)", money: "~$12.40", cache: "cache read 87%", delta: "+24% vs previous period",
    compaction: "Compaction ~", saving: "~$1.50", ownCost: "excludes the cost of the compaction itself", noPrevious: "no data for the previous period",
    noPrice: "no price", table: "Table", tabs: ["Day", "Week", "Month", "3 months", "By provider", "By model"],
    more: "More", cost: "(cost)", netCost: "−~$0.05", partial: "partial", month: "Month", byModel: "By model",
    sourceName: "Claude Code (files)", rows: "1,234", degraded: /Degraded threads: 2/, save: "Save", reset: "Reset", prune: "Clear old data", input: "claude-opus-4: Input",
  },
  ru: {
    spend: "Расход (API-эквивалент)", money: "~$12,40", cache: "чтение из кэша 87 %", delta: "+24 % к прошлому периоду",
    compaction: "Компакция ~", saving: "~$1,50", ownCost: "без учёта стоимости самой компакции", noPrevious: "нет данных за прошлый период",
    noPrice: "нет цены", table: "Таблица", tabs: ["День", "Неделя", "Месяц", "3 месяца", "По провайдерам", "По моделям"],
    more: "Ещё", cost: "затраты", netCost: "−~$0,05", partial: "частично", month: "Месяц", byModel: "По моделям",
    sourceName: "Claude Code (файлы)", rows: "1 234", degraded: /Деградировавших тредов: 2/, save: "Сохранить", reset: "Сбросить", prune: "Очистить старые данные", input: "claude-opus-4: Вход",
  },
} as const;
const LANGS = ["en", "ru"] as const;
const norm = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ");
const settingsFor = (lang: Lang) => (lang === "ru" ? { language: "ru" } : undefined); // English is the default

function handlers(over: Record<string, (input: any) => unknown> = {}): Record<string, (input: any) => unknown> {
  return {
    summary: (i: Input) => summary(i),
    topThreads: (i: { offset: number }) => (i.offset === 0 ? { items: Array.from({ length: 50 }, (_, n) => thread(`t${n}`)), hasMore: true } : { items: [thread("t-next")], hasMore: false }),
    compactions: () => ({ items: [compaction] }),
    ...over,
  };
}

async function page(subPath = "week/provider", over: Record<string, (input: any) => unknown> = {}, lang: Lang = "en") {
  const app = await loadPluginApp(() => import("./app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath }, { rpc: handlers(over), settings: settingsFor(lang) });
  return { app, slot };
}

describe("registration", () => {
  it("registers the page and the settings section", async () => {
    const app = await loadPluginApp(() => import("./app"));
    expect(app.navPanels[0]).toMatchObject({ id: "tokenomos", path: "tokenomos", title: "Tokenomos" });
    expect(app.settingsSections?.[0]).toMatchObject({ id: "tokenomos-settings", title: "Tokenomos" });
  });
});

describe.each(LANGS)("page (%s)", (lang) => {
  const x = L[lang];
  const open = (subPath = "week/provider", over: Record<string, (input: any) => unknown> = {}) => page(subPath, over, lang);

  it("starts with the range tabs and no longer shows or requests limits", async () => {
    const { slot } = await open();
    await slot.findByText(x.money);
    expect(slot.getAllByRole("tab")[0]!.textContent).toBe(x.tabs[0]);
    expect(slot.queryByRole("meter")).toBeNull();
    expect(slot.inspection.rpcCalls.some((c) => c.method === "limits")).toBe(false);
  });

  it("renders KPI tiles with the cache-read share and estimated money", async () => {
    const { slot } = await open();
    expect(await slot.findByText(x.money)).toBeTruthy();
    expect(slot.getByText(x.cache)).toBeTruthy();
    expect(slot.getByText(x.delta)).toBeTruthy();
    expect(slot.getByText(x.compaction)).toBeTruthy();
    expect(slot.getByText(x.saving)).toBeTruthy();
    expect(slot.getByText("vs claude-sonnet-4")).toBeTruthy();
    expect(slot.getAllByText(x.ownCost).length).toBeGreaterThan(0);
  });

  it("says there is no previous period when previous is null", async () => {
    const { slot } = await open("week/provider", { summary: (i: Input) => summary(i, { previous: null }) });
    expect(await slot.findByText(x.noPrevious)).toBeTruthy();
  });

  it("shows tokens only and the no-price text when usd is null", async () => {
    const { slot } = await open("week/provider", { summary: (i: Input) => summary(i, { totals: cost(null), previous: null }) });
    const tile = (await slot.findByText(x.spend)).parentElement!;
    expect(norm(tile)).toContain(x.noPrice);
    expect(norm(tile)).not.toContain("$");
  });

  it.each(Object.entries(COUNTS))("draws %s with %i buckets", async (range, count) => {
    const { slot } = await open(`${range}/provider`);
    await waitFor(() => expect(slot.container.querySelector("[data-bucket-count]")?.getAttribute("data-bucket-count")).toBe(String(count)));
    fireEvent.click(slot.getByRole("button", { name: x.table }));
    const table = (await slot.findAllByRole("table"))[0]!;
    expect(within(table).getAllByRole("row")).toHaveLength(count + 1);
  });

  it("offers exactly four ranges and writes range and grouping to the URL", async () => {
    const { slot } = await open();
    await slot.findByText(x.money);
    expect(slot.getAllByRole("tab").map((t) => t.textContent)).toEqual(x.tabs);
    fireEvent.mouseDown(slot.getByRole("tab", { name: x.month }), { button: 0 });
    fireEvent.mouseDown(slot.getByRole("tab", { name: x.byModel }), { button: 0 });
    // Radix fires on both mouse-down and focus, so check membership rather than the exact log.
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "tokenomos", options: { subPath: "month/provider", replace: true } });
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "tokenomos", options: { subPath: "week/model", replace: true } });
  });

  it("shows skeletons on the first load only, not on refetch", async () => {
    let calls = 0;
    const gates: (() => void)[] = [];
    const gate = () => new Promise<void>((resolve) => gates.push(resolve));
    const { slot } = await open("week/provider", { summary: async (i: Input) => { calls++; await gate(); return summary(i); } });
    expect(slot.getAllByTestId("skeleton").length).toBeGreaterThan(0);
    gates[0]!();
    await slot.findByText(x.money);
    void slot.experimental_invalidateRpc(null); // the refetch stays pending behind its gate
    await waitFor(() => expect(calls).toBe(2));
    expect(slot.queryAllByTestId("skeleton")).toHaveLength(0);
    expect(slot.getByText(x.money)).toBeTruthy();
    gates[1]!();
  });

  it("opens a thread from the list and pages with the more button", async () => {
    const { slot } = await open();
    const row = await slot.findByRole("button", { name: /Thread t3\b/ });
    fireEvent.click(row);
    expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toThread", threadId: "t3" });
    fireEvent.click(slot.getByRole("button", { name: x.more }));
    expect(await slot.findByRole("button", { name: /Thread t-next/ })).toBeTruthy();
    expect(slot.queryByRole("button", { name: x.more })).toBeNull();
  });

  it("lists compactions with a negative net shown as a cost", async () => {
    const { slot } = await open();
    const row = await slot.findByRole("button", { name: /Compacted thread/ });
    expect(norm(row)).toContain(x.netCost);
    expect(norm(row)).toContain(x.cost);
    expect(norm(row)).toContain("Idle Compact");
    expect(norm(row)).toContain("900K → 120K");
    expect(norm(row)).toContain(x.ownCost);
    expect(norm(row)).toContain(x.partial);
  });
});

describe.each(LANGS)("backfill banner (%s)", (lang) => {
  const banner = { en: "Loading history: 860 of 4,690 threads — numbers are incomplete", ru: "Загружается история: 860 из 4 690 тредов — цифры неполные" }[lang];
  const status = (backfill?: object) => () => ({ sources: [], degradedThreads: 0, disk: { bytes: 1, pages: 1, freePages: 0, rows: {} }, ...(backfill ? { backfill } : {}) });
  const running = { processedThreads: 860, totalThreads: 4690, done: false, startedAt: 1 };

  it("shows progress and marks the KPI money with ~ while the import runs", async () => {
    const { slot } = await page("week/provider", { status: status(running), summary: (i: Input) => summary(i, { totals: cost(12.4) }) }, lang);
    expect(await slot.findByText(banner)).toBeTruthy();
    expect(await slot.findByText(L[lang].money)).toBeTruthy();
  });

  it.each([["done", { ...running, done: true }], ["absent", undefined]])("hides the banner when the import is %s", async (_name, backfill) => {
    const { slot } = await page("week/provider", { status: status(backfill), summary: (i: Input) => summary(i, { totals: cost(12.4) }) }, lang);
    expect(await slot.findByText(lang === "en" ? "$12.40" : "$12,40")).toBeTruthy();
    expect(slot.queryByRole("status")).toBeNull();
  });
});

describe.each(LANGS)("settings (%s)", (lang) => {
  const x = L[lang];
  it("renders sources and saves or resets a price override", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const setPriceOverride = vi.fn(() => ({ ok: true as const }));
    const rates = { input: 3, output: 15, cacheRead: 0.3, cacheWriteShort: 3.75, cacheWriteLong: 6 };
    const slot = renderSlot(app.settingsSections![0]!, {}, {
      settings: settingsFor(lang),
      rpc: {
        status: () => ({
          sources: [{ id: "claude-file", lastIngestAt: Date.UTC(2026, 10, 3, 12), rows: 1234, lastError: "boom", state: "ok" }],
          degradedThreads: 2, disk: { bytes: 5 * 1024 * 1024, pages: 100, freePages: 3, rows: { usage_hourly: 77 } },
        }),
        prices: () => ({ version: "v1", entries: [{ model: "claude-opus-4", rates, overridden: true, verified: true }] }),
        setPriceOverride, prune: () => ({ deletedRows: 7 }),
      },
    });
    expect(await slot.findByText(x.sourceName)).toBeTruthy();
    expect(slot.getByText(x.rows)).toBeTruthy();
    expect(slot.getByText("boom")).toBeTruthy();
    expect(slot.getByText(x.degraded)).toBeTruthy();
    expect(slot.getByText(/usage_hourly: 77/)).toBeTruthy();

    const save = await slot.findByRole("button", { name: x.save });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(slot.getByLabelText(x.input), { target: { value: "4.5" } });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(slot.inspection.rpcCalls.filter((c) => c.method === "setPriceOverride")).toEqual([{ method: "setPriceOverride", input: { model: "claude-opus-4", rates: { input: 4.5 } } }]));

    fireEvent.click(slot.getByRole("button", { name: x.reset }));
    await waitFor(() => expect(slot.inspection.rpcCalls.at(-1)).toEqual({ method: "setPriceOverride", input: { model: "claude-opus-4", rates: null } }));

    fireEvent.click(slot.getByRole("button", { name: x.prune }));
    await waitFor(() => expect(slot.inspection.rpcCalls.some((c) => c.method === "prune")).toBe(true));
  });
});

describe("language", () => {
  it("defaults to English and switches to Russian through the language setting", async () => {
    const en = await page("week/provider", {}, "en");
    expect(await en.slot.findByText("Breakdown")).toBeTruthy();
    cleanup();
    const ru = await page("week/provider", {}, "ru");
    expect(await ru.slot.findByText("Разбивка")).toBeTruthy();
    cleanup();
    // An unknown value falls back to English.
    const app = await loadPluginApp(() => import("./app"));
    const odd = renderSlot(app.navPanels[0]!, { subPath: "week/provider" }, { rpc: handlers(), settings: { language: "de" } });
    expect(await odd.findByText("Breakdown")).toBeTruthy();
  });

  it("has the same keys and placeholders in both dictionaries", () => {
    const keys = (d: Record<string, unknown>) => Object.keys(d).sort();
    expect(keys(DICTIONARIES.ru)).toEqual(keys(DICTIONARIES.en));
    const holes = (v: unknown) => [...JSON.stringify(v).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((n, i, all) => all.indexOf(n) === i).sort();
    for (const k of keys(DICTIONARIES.en)) expect([k, holes(DICTIONARIES.ru[k as never])]).toEqual([k, holes(DICTIONARIES.en[k as never])]);
  });

  it("picks plural forms with Intl.PluralRules", () => {
    expect([1, 2].map((n) => translate("en", "chart.intervals", { n }))).toEqual(["1 interval", "2 intervals"]);
    expect([1, 2, 5, 21].map((n) => translate("ru", "chart.intervals", { n }))).toEqual(["1 интервал", "2 интервала", "5 интервалов", "21 интервал"]);
  });

  it("keeps Cyrillic out of the UI sources except i18n.ts", () => {
    const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
    const offenders = [...files("components"), "app.tsx"].filter((f) => /\.tsx?$/.test(f) && !f.endsWith("i18n.ts") && /[\u0400-\u04FF]/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("helpers", () => {
  const en = makeT("en"), ru = makeT("ru");

  it("formats tokens and money per locale", () => {
    expect(fmtTokens(1_200_000, en)).toBe("1.2M");
    expect(fmtTokens(1_200_000, ru)).toBe("1,2M");
    expect(fmtTokens(340_000, en)).toBe("340K");
    expect(fmtTokens(950, en)).toBe("950");
    expect(fmtUsd(12.4, en)).toBe("$12.40");
    expect(fmtUsd(12.4, ru)).toBe("$12,40");
    expect(fmtUsd(0.004, en)).toBe("$0.0040");
    expect(fmtCost(cost(12.4, 1, 1, 1, { partial: true }), en)).toBe("~$12.40");
    expect(fmtCost(cost(12.4), en)).toBe("$12.40");
    expect(fmtCost(cost(null), en)).toBeNull();
    expect(bucketLabel("day", Date.UTC(2026, 10, 1, 5), en)).toMatch(/^\d\d:00$/);
  });

  it("round-trips the sub path and falls back to week/provider", () => {
    expect(parseSubPath(toSubPath("3m", "model"))).toEqual({ range: "3m", by: "model" });
    expect(parseSubPath("nonsense")).toEqual({ range: "week", by: "provider" });
    expect(parseSubPath("")).toEqual({ range: "week", by: "provider" });
  });

  it("computes the delta from dollars, falling back to tokens", () => {
    expect(delta(cost(12), cost(10), en)).toBe("+20% vs previous period");
    expect(delta(cost(12), cost(10), ru)).toMatch(/^\+20\s%\sк прошлому периоду$/);
    expect(delta(cost(null, 2000, 0, 0), cost(null, 1000, 0, 0), en)).toContain("(tokens)");
    expect(delta(cost(null, 2000, 0, 0), cost(null, 1000, 0, 0), ru)).toContain("(токены)");
    expect(delta(cost(1), null, en)).toBeNull();
  });

  it("keeps provider colors fixed and folds models beyond the top four into Others", () => {
    const s = summary({ range: "week", by: "provider" }, {});
    const byProvider = buildChart(s as never, "provider", "week", en);
    expect(byProvider.slots.map((x) => [x.id, x.label])).toEqual([["s1", "Claude Code"], ["s2", "Codex"]]);
    const byModel = buildChart(summary({ range: "week", by: "model" }) as never, "model", "week", en);
    expect(byModel.slots.map((x) => x.n)).toEqual([1, 2, 3, 4, 5]);
    expect(byModel.slots.at(-1)!.label).toBe("Others");
    expect(buildChart(summary({ range: "week", by: "model" }) as never, "model", "week", ru).slots.at(-1)!.label).toBe("Другие");
    expect(byModel.rows).toHaveLength(7);
  });
});
