// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Cost } from "./contract";
import { buildChart, spread } from "./components/series";
import { pickColumn, pickSegment } from "./components/usage-chart";
import { accountName, bucketLabel, fmtCost, fmtPlan, fmtSpan, fmtTokens, fmtUsd, parseSubPath, toSubPath } from "./components/format";
import { delta } from "./components/kpis";
import { DICTIONARIES, makeT, translate, type Lang } from "./components/i18n";

// jsdom has no scrollIntoView; the host Select calls it on open.
Element.prototype.scrollIntoView ??= () => {};

// Remembered view choices (range, metric, widget time mode) must not leak from one test into the next.
afterEach(() => { cleanup(); localStorage.removeItem("tokenomos:range"); localStorage.removeItem("tokenomos:metric"); localStorage.removeItem("tokenomos:footer:time"); });

const cost = (usd: number | null, freshIn = 1000, cacheRead = 8000, output = 500, flags: Partial<Cost> = {}): Cost => ({
  usd, tokens: { freshIn, cacheRead, cacheWrite: 200, output }, estimated: false, partial: false, ...flags,
});
const COUNTS = { day: 24, week: 7, month: 30, "3m": 13 } as const;
const HOUR = 3_600_000;
const STEP = { day: HOUR, week: 24 * HOUR, month: 24 * HOUR, "3m": 7 * 24 * HOUR } as const;

type Input = { range: keyof typeof COUNTS; by: "provider" | "model" };
// Mon 09:00 is busy in calls, Sun 09:00 in dollars, Wed 14:00 in tokens; weekdays count from Monday = 0.
const HEAT = [
  { weekday: 0, hour: 9, usd: 20, tokens: 1_000_000, calls: 50 },
  { weekday: 6, hour: 9, usd: 277, tokens: 5_000_000, calls: 40 },
  { weekday: 2, hour: 14, usd: 5, tokens: 9_000_000, calls: 900 },
];
const kpis = (over: Record<string, unknown> = {}) => ({
  spendUsd: 12.4, spendPrevUsd: 10, tokens: 94_000_000, tokensPrev: 80_000_000, calls: 1234, callsPrev: 1000, threads: 37,
  medianThreadUsd: 0.42, perCallUsd: 0.01, cacheHitRate: 0.87, estimated: true, partial: false, ...over,
});

function summary({ range, by }: Input, over: Record<string, unknown> = {}) {
  const from = Date.UTC(2026, 10, 1);
  const keys = by === "provider" ? ["claude-code", "codex"] : ["claude-opus-4", "gpt-5", "qwen3", "m4", "m5", "m6"];
  return {
    range, from, to: from + COUNTS[range] * STEP[range],
    buckets: Array.from({ length: COUNTS[range] }, (_, i) => ({ start: from + i * STEP[range], series: Object.fromEntries(keys.map((k, j) => [k, { ...cost(i + j + 1), calls: i + j + 1 }])) })),
    totals: cost(12.4, 5_000_000, 87_000_000, 2_000_000, { estimated: true }),
    previous: cost(10),
    cacheReadShare: 0.87,
    kpis: kpis(),
    mix: {
      rows: [
        { component: "freshIn", tokens: 5_000_000, usd: 25, usdPerMTok: 5 },
        { component: "cacheWrite", tokens: 1_000_000, usd: 6.25, usdPerMTok: 6.25 },
        { component: "cacheRead", tokens: 87_000_000, usd: 43.5, usdPerMTok: 0.5 },
        { component: "output", tokens: 2_000_000, usd: 50, usdPerMTok: 25 },
      ],
      reasoningTokens: 400_000,
    },
    heatmap: { cells: HEAT, busiest: HEAT[1] },
    breakdown: keys.map((k) => ({ key: k, label: k === "claude-code" ? "Claude Code" : k, provider: k.startsWith("gpt") || k === "codex" ? "codex" : "claude-code", cost: cost(3), calls: 42 })),
    compactionSavings: { usd: 1.5, tokens: 340_000, partial: true, excludesOwnCost: true },
    localSavings: { usd: 0.8, tokens: 1_200_000, partial: false, excludesOwnCost: false, referenceModel: "claude-sonnet-4" },
    ...over,
  };
}

const thread = (id: string) => ({ threadId: id, title: `Thread ${id}`, projectId: "p", provider: "codex", own: cost(1.25), total: cost(2.5), calls: 321, tokens: 4_500_000, rangeCost: cost(1.75), model: "gpt-5", projectName: "Atlas", childCount: 3 });
const compaction = {
  id: "c1", threadId: "t9", title: "Compacted thread", at: Date.UTC(2026, 10, 3, 12), beforeTokens: 900_000, afterTokens: 120_000, origin: "idle-compact" as const,
  saving: { usd: -0.05, tokens: 780_000, partial: true, excludesOwnCost: true },
};


/** Expected texts per UI language; number formats follow the locale (en-US vs ru-RU). */
const L = {
  en: {
    spend: "Spend (API equivalent)", money: "~$12.40", cacheHit: "Cache hit rate", pct87: "87%", delta: "+24% vs previous period",
    median: "Median thread", medianValue: "$0.42", perCall: "$0.01 per call", footnote: "~ includes list-price estimates", tokensDelta: "+18% vs previous period", callsDelta: "+23% vs previous period",
    allProjects: "All projects", projectLabel: "Project", local: "Local models", legendLabel: "Legend", metrics: ["Cost", "Tokens", "Calls"], calls: "Calls", callsUnit: "Interval (calls)",
    mixTitle: "Token mix", mixSub: "where tokens go vs where money goes", mixHead: ["Component", "Tokens", "%", "Cost", "%", "$/1M"], mixRows: ["Input", "Cache write", "Cache read", "Output"], reasoning: "↳ reasoning tokens",
    activity: "Activity by hour", busiestCost: "busiest: Sun 09:00, ~$277.00", busiestCalls: "busiest: Wed 14:00, 900 calls", tip: "~$277.00 · 5M tok. · 40 calls", wk: "Mon", children: "3 child threads",
    threadHead: ["Thread", "Calls", "Tokens", "Last 7 days", "Total"], threadSub: "Atlas · gpt-5 · Codex · 3 child threads", threadNums: ["321", "4.5M", "$1.75", "$2.50"],
    compaction: "Compaction ~", saving: "~$1.50", ownCost: "excludes the cost of the compaction itself", noPrevious: "no data for the previous period",
    noPrice: "no price", table: "Table", tabs: ["Day", "Week", "Month", "3 months", "Cost", "Tokens", "Calls", "By provider", "By model"],
    more: "More", cost: "(cost)", netCost: "−~$0.05", partial: "partial", month: "Month", byModel: "By model",
    sourceName: "Claude Code (files)", rows: "1,234", degraded: /Degraded threads: 2/, save: "Save", reset: "Reset", prune: "Clear old data", input: "claude-opus-4: Input",
  },
  ru: {
    spend: "Расход (API-эквивалент)", money: "~$12,40", cacheHit: "Попадание в кэш", pct87: "87 %", delta: "+24 % к прошлому периоду",
    median: "Медианный тред", medianValue: "$0,42", perCall: "$0,01 за вызов", footnote: "~ включает оценки по прайс-листу", tokensDelta: "+18 % к прошлому периоду", callsDelta: "+23 % к прошлому периоду",
    allProjects: "Все проекты", projectLabel: "Проект", local: "Локальные модели", legendLabel: "Легенда", metrics: ["Расход", "Токены", "Вызовы"], calls: "Вызовы", callsUnit: "Интервал (вызовы)",
    mixTitle: "Структура токенов", mixSub: "куда уходят токены и куда — деньги", mixHead: ["Компонент", "Токены", "%", "Стоимость", "%", "$/1 млн"], mixRows: ["Вход", "Запись кэша", "Чтение кэша", "Выход"], reasoning: "↳ токены рассуждений",
    activity: "Активность по часам", busiestCost: "пик: вс 09:00, ~$277,00", busiestCalls: "пик: ср 14:00, 900 вызовов", tip: "~$277,00 · 5M ток. · 40 вызовов", wk: "пн", children: "3 дочерних треда",
    threadHead: ["Тред", "Вызовы", "Токены", "Последние 7 дней", "Всего"], threadSub: "Atlas · gpt-5 · Codex · 3 дочерних треда", threadNums: ["321", "4,5M", "$1,75", "$2,50"],
    compaction: "Компакция ~", saving: "~$1,50", ownCost: "без учёта стоимости самой компакции", noPrevious: "нет данных за прошлый период",
    noPrice: "нет цены", table: "Таблица", tabs: ["День", "Неделя", "Месяц", "3 месяца", "Расход", "Токены", "Вызовы", "По провайдерам", "По моделям"],
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

async function page(subPath = "week/provider", over: Record<string, (input: any) => unknown> = {}, lang: Lang = "en", settings: Record<string, string> = {}) {
  const app = await loadPluginApp(() => import("./app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath }, { rpc: handlers(over), settings: { ...settingsFor(lang), ...settings } });
  return { app, slot };
}

describe("registration", () => {
  it("registers the page and the settings section", async () => {
    const app = await loadPluginApp(() => import("./app"));
    expect(app.navPanels[0]).toMatchObject({ id: "tokenomos", path: "tokenomos", title: "Tokenomos" });
    expect(app.settingsSections?.[0]).toMatchObject({ id: "tokenomos-settings", title: "Tokenomos" });
  });
});

describe.each(LANGS)("sidebar footer limits (%s)", (lang) => {
  it("lists each window with its forecast and the account's heavy share", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const item = app.experimentalSidebarFooterItems.find((i) => i.id === "limits")!;
    expect(item).toMatchObject({ kind: "disclosure", icon: "tokenomos/mark" });
    const now = Date.now(), H = 3_600_000;
    const win = (over: Record<string, unknown>) => ({ id: "w", label: "Weekly limit", kind: "weekly", model: null, usedPercent: 13, resetsAt: now + 157.5 * H, startsAt: now - 11 * H,
      elapsedShare: 0.06, forecastPercent: 200, runsOutAt: now + 71.5 * H, usage: { heavy: { usd: 84, calls: 2 }, other: { usd: 16, calls: 1 }, heavyShare: 0.84, usdPerPercent: 23, partial: false }, ...over });
    const limits = () => ({ heavyModels: ["opus"], heavyTarget: 0.5, accounts: [
      { providerId: "claude-code", label: "Claude Code", plan: "Ultra", status: "ok", message: null, observedAt: 1,
        windows: [win({}), win({ id: "f", label: "Fable", model: "fable", usedPercent: 0, forecastPercent: 0, runsOutAt: null, usage: null })] },
      { providerId: "codex", label: "Codex", plan: "Pro", status: "ok", message: null, observedAt: 1, windows: [win({ id: "c", usedPercent: 100, runsOutAt: now, resetsAt: now + 46.5 * H, usage: null })] },
    ] });
    const slot = renderSlot(item as never, { dismiss: () => {} }, { rpc: { limits }, settings: settingsFor(lang) });
    // A row reads as label, percent and the time it shows (the reserved-width copies are hidden).
    const rows = (await slot.findAllByRole("meter")).map((m) => { const li = m.closest("li")!; return norm(li.firstElementChild) + norm(li.children[2]!) + norm(li.querySelector("[data-time]")); });
    expect(rows).toEqual(lang === "en"
      ? ["7d13%out in 2 d 23 h", "7d · Fable0%6 d 13 h", "7d100%1 d 22 h"]
      : ["7d13 %хватит на 2 д 23 ч", "7d · Fable0 %6 д 13 ч", "7d100 %1 д 22 ч"]);
    // Each row switches on its own, and the choice is remembered per row.
    const times = () => slot.getAllByRole("meter").map((m) => m.closest("li")!.querySelector("[data-time]")!.textContent);
    const button = (i: number) => slot.getAllByRole("meter")[i]!.closest("li")!.querySelector("button")!;
    fireEvent.click(button(0));
    expect(times()).toEqual(lang === "en" ? ["6 d 13 h", "6 d 13 h", "1 d 22 h"] : ["6 д 13 ч", "6 д 13 ч", "1 д 22 ч"]);
    expect(JSON.parse(localStorage.getItem("tokenomos:footer:time")!)).toEqual({ "claude-code:w": "reset" });
    fireEvent.click(button(0));
    expect(times()[0]).toMatch(lang === "en" ? /^out in/ : /^хватит на/);
    // A row with no forecast says it is fine for a moment, alone, then shows its reset again.
    fireEvent.click(button(1));
    expect(times()[1]).not.toMatch(/\d/);
    expect(times()[0]).toMatch(lang === "en" ? /^out in/ : /^хватит на/);
    await waitFor(() => expect(times()[1]).toBe(lang === "en" ? "6 d 13 h" : "6 д 13 ч"), { timeout: 4000 });
    fireEvent.click(button(1));
    expect(times()[1]).not.toMatch(/\d/);
    fireEvent.click(button(1)); // a second click does not wait for the timer
    expect(times()[1]).toBe(lang === "en" ? "6 d 13 h" : "6 д 13 ч");
    localStorage.removeItem("tokenomos:footer:time");

    // The heavy share lives in the row's hover hint, next to the time tick explained.
    fireEvent.pointerMove(slot.getAllByRole("meter")[0]!.closest("li")!, { pointerType: "mouse" });
    const tip = norm(await slot.findByRole("tooltip"));
    expect(tip).toContain(lang === "en" ? "Heavy models: 84%" : "Тяжёлые модели: 84 %");
    expect(tip).toContain(lang === "en" ? "Usage runs ahead of time" : "Расход идёт быстрее времени");
    expect(tip).toContain(lang === "en" ? "(target under 50%)" : "(цель — меньше 50 %)");
  });

  it("drops the target from the hint when the user turned it off", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const item = app.experimentalSidebarFooterItems.find((i) => i.id === "limits")!;
    const usage = { heavy: { usd: 84, calls: 2 }, other: { usd: 16, calls: 1 }, heavyShare: 0.84, usdPerPercent: 23, partial: false };
    const limits = () => ({ heavyModels: ["opus"], heavyTarget: null, accounts: [{ providerId: "claude-code", label: "Claude Code", plan: null, status: "ok", message: null, observedAt: 1,
      windows: [{ id: "w", label: "Weekly limit", kind: "weekly", model: null, usedPercent: 13, resetsAt: Date.now() + 9e7, startsAt: 0, elapsedShare: 0.5, forecastPercent: 26, runsOutAt: null, usage }] }] });
    const slot = renderSlot(item as never, { dismiss: () => {} }, { rpc: { limits }, settings: settingsFor(lang) });
    fireEvent.pointerMove((await slot.findByRole("meter")).closest("li")!, { pointerType: "mouse" });
    const tip = await slot.findByRole("tooltip");
    expect(norm(tip)).toContain(lang === "en" ? "Heavy models: 84%" : "Тяжёлые модели: 84 %");
    expect(norm(tip)).not.toMatch(lang === "en" ? /target/ : /цель/);
    expect(within(tip).getByText(/84/).getAttribute("style")).toBeNull(); // no orange without a target
  });
});

describe.each(LANGS)("page (%s)", (lang) => {
  const x = L[lang];
  const open = (subPath = "week/provider", over: Record<string, (input: any) => unknown> = {}) => page(subPath, over, lang);

  it("starts with the range tabs and shows no limits when no plugin reports them", async () => {
    const { slot } = await open("week/provider", { limits: () => ({ heavyModels: ["opus"], heavyTarget: 0.5, accounts: [] }) });
    await slot.findByText(x.money);
    expect(slot.getAllByRole("tab")[0]!.textContent).toBe(x.tabs[0]);
    await waitFor(() => expect(slot.inspection.rpcCalls.some((c) => c.method === "limits")).toBe(true));
    expect(slot.queryByRole("meter")).toBeNull();
  });

  it("shows each limit window with its pace and the heavy-model share of its cost", async () => {
    localStorage.clear();
    const part = (usd: number, calls: number) => ({ usd, calls });
    const win = (over: Record<string, unknown>) => ({
      id: "0:Weekly", label: "Weekly limit", kind: "weekly", model: null, usedPercent: 40, resetsAt: Date.UTC(2026, 10, 25), startsAt: Date.UTC(2026, 10, 18),
      elapsedShare: 0.25, forecastPercent: 160, runsOutAt: Date.UTC(2026, 10, 22), usage: { heavy: part(60, 10), other: part(40, 30), heavyShare: 0.6, usdPerPercent: 2.5, partial: false }, ...over,
    });
    const { slot } = await open("week/provider", { limits: () => ({ heavyModels: ["opus"], heavyTarget: 0.5, accounts: [
      { providerId: "claude-code", label: "Claude Code", plan: "Max", status: "ok", message: null, observedAt: 1, windows: [win({})] },
      { providerId: "codex", label: "Codex", plan: null, status: "ok", message: "timeout", observedAt: Date.UTC(2026, 10, 18, 9), stale: true, windows: [win({ id: "c", label: "Codex week", usedPercent: 100, runsOutAt: 1, usage: null })] },
      { providerId: "antigravity", label: "Antigravity", plan: null, status: "unauthenticated", message: null, observedAt: null, windows: [] },
    ] }) });
    const meters = await slot.findAllByRole("meter");
    expect(meters).toHaveLength(2);
    expect(meters[0]!.getAttribute("aria-valuenow")).toBe("40");
    expect(within(meters[0]!).getByRole("img").getAttribute("aria-label")!.replace(/\s/g, " ")).toContain(lang === "en" ? "25% of the window has passed. Usage runs ahead of time" : "прошло 25 % окна. Расход идёт быстрее времени");
    const claude = norm(meters[0]!.closest("li"));
    expect(claude).toContain(lang === "en" ? "Heavy models60%of cost25% of calls" : "Тяжёлые модели60 %стоимости25 % вызовов");
    // 40% used at a quarter of the window projects 160% at reset: far ahead, so the bar is red.
    expect((meters[0]!.firstElementChild as HTMLElement).style.background).toContain("destructive");
    expect(claude).toContain(lang === "en" ? "Runs out in ~" : "Закончится через ~");
    expect(norm(meters[1]!.closest("li"))).toContain(lang === "en" ? "Limit exhausted" : "Лимит исчерпан");
    expect(within(meters[1]!).queryByRole("img")).toBeNull(); // nothing to forecast once exhausted: no pace tick
    expect(slot.queryByText(lang === "en" ? /^data from / : /^данные на /)).toBeNull(); // a failed source shows its last numbers unmarked
    expect(slot.getByText(lang === "en" ? "no data: unauthenticated" : "нет данных: unauthenticated")).toBeTruthy();
  });

  it("renders KPI tiles with the cache-read share and estimated money", async () => {
    const { slot } = await open();
    expect(await slot.findByText(x.money)).toBeTruthy();
    expect(norm((await slot.findByText(x.cacheHit)).parentElement)).toContain(x.pct87);
    expect(norm(slot.getByText(x.median).parentElement)).toContain(`${x.medianValue}${x.perCall}`);
    expect(norm(slot.getByText(x.footnote))).toBe(x.footnote);
    expect(slot.getByText(x.delta)).toBeTruthy();
    expect(slot.getByText(x.tokensDelta)).toBeTruthy();
    expect(slot.getByText(x.callsDelta)).toBeTruthy();
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
    const { slot } = await open("week/provider", { summary: (i: Input) => summary(i, { totals: cost(null), previous: null, kpis: kpis({ spendUsd: null, medianThreadUsd: null, perCallUsd: null }) }) });
    const tile = (await slot.findByText(x.spend)).parentElement!;
    expect(norm(tile)).toContain(x.noPrice);
    expect(norm(tile)).not.toContain("$");
  });

  it("leaves local models and their saving out of the usage chart; the savings card covers them", async () => {
    const { slot } = await open("week/provider", { summary: (i: Input) => { const s = summary(i) as { buckets: { localSavedUsd?: number }[] }; s.buckets[2]!.localSavedUsd = 1.5; (s.buckets[2] as unknown as { series: Record<string, unknown> }).series["local-models"] = { ...cost(5), calls: 3 }; return s; } });
    await slot.findByText(x.money);
    const legend = slot.getByRole("list", { name: x.legendLabel }).textContent!;
    expect(legend).not.toContain(x.local);
    fireEvent.click(slot.getByRole("button", { name: x.table }));
    const table = (await slot.findAllByRole("table"))[0]!;
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).not.toContain(x.local);
    expect(within(table).getAllByRole("columnheader").at(-1)!.textContent).toBe(lang === "en" ? "Total" : "Всего");
  });

  it("switches the metric: the chart table follows Cost / Tokens / Calls", async () => {
    const { slot } = await open();
    await slot.findByText(x.money);
    expect(slot.getAllByRole("tab").filter((t) => t.getAttribute("aria-selected") === "true").map((t) => t.textContent)).toContain(x.metrics[0]);
    fireEvent.mouseDown(slot.getByRole("tab", { name: x.metrics[2] }), { button: 0 });
    fireEvent.click(slot.getByRole("button", { name: x.table }));
    expect(norm((await slot.findAllByRole("table"))[0]!.querySelector("th"))).toBe(x.callsUnit);
  });

  it("lists the projects and keeps the chosen one in the URL and the requests", async () => {
    const { slot } = await open("week/model/p1", { projects: () => ({ items: [{ projectId: "p1", name: "Atlas" }, { projectId: "p2", name: "Borealis" }] }) });
    const trigger = await slot.findByRole("combobox", { name: x.projectLabel });
    await waitFor(() => expect(trigger.textContent).toBe("Atlas"));
    await waitFor(() => expect(slot.inspection.rpcCalls.filter((c) => ["summary", "topThreads", "compactions"].includes(c.method)).every((c) => (c.input as { projectId?: string }).projectId === "p1")).toBe(true));
    const pick = async (name: string) => {
      fireEvent.keyDown(trigger, { key: "Enter" });
      fireEvent.keyDown(await within(document.body).findByRole("option", { name }), { key: "Enter" });
    };
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(within(document.body).getAllByRole("option").map((o) => o.textContent)).toEqual([x.allProjects, "Atlas", "Borealis"]);
    fireEvent.keyDown(document.activeElement ?? trigger, { key: "Escape" });
    await pick("Borealis");
    expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toPluginPanel", options: { subPath: "week/model/p2", replace: true } });
    await pick(x.allProjects);
    expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ options: { subPath: "week/model", replace: true } });
  });

  it("explains the token mix: bars for tokens and cost, a table with a reasoning row", async () => {
    const { slot } = await open();
    const card = (await slot.findByText(x.mixTitle)).closest("div.rounded-lg") as HTMLElement;
    expect(norm(card)).toContain(x.mixSub);
    expect(within(card).getAllByRole("img").length).toBe(2);
    const table = within(card).getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((h) => norm(h))).toEqual(x.mixHead);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => norm(row.querySelector("td")))).toEqual([...x.mixRows, x.reasoning].map((n) => n.trim()));
    expect(norm(rows[2]!)).toContain("87M");
    expect(norm(rows[2]!)).toContain(lang === "en" ? "$0.50" : "$0,50"); // $ per 1M for cache read
  });

  it("draws the activity heatmap, names the busiest hour and follows the metric", async () => {
    const { slot } = await open();
    const header = (await slot.findByText(x.activity)).parentElement!;
    expect(norm(header)).toContain(x.busiestCost);
    const grid = slot.getByRole("grid");
    expect(within(grid).getAllByRole("row")).toHaveLength(7);
    expect(within(grid).getAllByRole("gridcell")).toHaveLength(7 * 24);
    // Week rows start at the range's first local weekday, so Sunday's row index follows the test timezone.
    const first = (new Date(Date.UTC(2026, 10, 1)).getDay() + 6) % 7;
    const cell = within(grid).getAllByRole("gridcell")[((6 - first + 7) % 7) * 24 + 9]!;
    expect(cell.getAttribute("data-level")).toBe("4"); // the busiest cell is the strongest tint
    fireEvent.pointerEnter(cell);
    expect(norm(slot.getByRole("tooltip"))).toContain(x.tip);
    fireEvent.pointerLeave(grid);
    expect(slot.queryByRole("tooltip")).toBeNull();
    fireEvent.mouseDown(slot.getByRole("tab", { name: x.metrics[2] }), { button: 0 });
    expect(norm((await slot.findByText(x.activity)).parentElement)).toContain(x.busiestCalls);
  });

  it("leaves the hours after now blank on today's row", async () => {
    const from = new Date(2026, 10, 1).getTime(), to = new Date(2026, 10, 7, 12, 30).getTime();
    const { slot } = await open("week/provider", { summary: (i: Input) => summary(i, { from, to }) });
    await slot.findByText(x.activity);
    expect(within(slot.getByRole("grid")).getAllByRole("gridcell")).toHaveLength(7 * 24 - 11); // 13:00..23:00 not yet
  });

  it("shows a single row when the day range covers one weekday", async () => {
    const from = new Date(2026, 10, 4, 0).getTime(), to = new Date(2026, 10, 4, 23).getTime(); // a Wednesday
    const { slot } = await open("day/provider", { summary: (i: Input) => summary(i, { from, to, heatmap: { cells: [HEAT[2]], busiest: HEAT[2] } }) });
    await slot.findByText(x.activity);
    expect(within(slot.getByRole("grid")).getAllByRole("row")).toHaveLength(1);
    expect(within(slot.getByRole("grid")).getAllByRole("row")[0]!.textContent).toContain(x.wk === "Mon" ? "Wed" : "ср");
  });

  it("draws both weekdays the last 24 hours span, Sunday before Monday, even with no calls on one of them", async () => {
    const from = new Date(2026, 10, 1, 18).getTime(), to = new Date(2026, 10, 2, 17).getTime(); // Sunday 18:00 to Monday 17:00
    const { slot } = await open("day/provider", { summary: (i: Input) => summary(i, { from, to, heatmap: { cells: [HEAT[1]], busiest: HEAT[1] } }) });
    await slot.findByText(x.activity);
    const rows = within(slot.getByRole("grid")).getAllByRole("row").map((r) => r.textContent);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain(x.wk === "Mon" ? "Sun" : "вс");
    expect(rows[1]).toContain(x.wk === "Mon" ? "Mon" : "пн");
  });

  it("lays out the thread rows: name, then project · model · provider · children, then fixed numeric columns", async () => {
    const { slot } = await open();
    const row = await slot.findByRole("button", { name: /Thread t3(?!\d)/ });
    expect(norm(row)).toContain(x.threadSub);
    expect(norm(row)).toContain(x.threadNums.join(""));
    const head = (await slot.findByText(x.threadHead[0]!)).parentElement!;
    expect(Array.from(head.children).map((c) => norm(c))).toEqual(x.threadHead);
  });

  it.each(Object.entries(COUNTS))("draws %s with %i buckets", async (range, count) => {
    const { slot } = await open(`${range}/provider`);
    await waitFor(() => expect(slot.container.querySelector("[data-bucket-count]")?.getAttribute("data-bucket-count")).toBe(String(count)));
    fireEvent.click(slot.getByRole("button", { name: x.table }));
    const table = (await slot.findAllByRole("table"))[0]!;
    expect(within(table).getAllByRole("row")).toHaveLength(count + 1);
  });

  it("remembers the last range and metric and opens with them", async () => {
    localStorage.clear();
    const first = await page("week/provider", {}, lang);
    await first.slot.findByText(x.money);
    fireEvent.mouseDown(first.slot.getByRole("tab", { name: x.month }), { button: 0 });
    expect(localStorage.getItem("tokenomos:range")).toBe("month");
    fireEvent.mouseDown(first.slot.getByRole("tab", { name: x.metrics[2] }), { button: 0 });
    expect(localStorage.getItem("tokenomos:metric")).toBe("calls");
    cleanup();
    const { slot } = await page("", {}, lang);
    await waitFor(() => expect(slot.inspection.rpcCalls.find((c) => c.method === "summary")?.input).toMatchObject({ range: "month" }));
    expect((await slot.findByRole("tab", { name: x.metrics[2] })).getAttribute("aria-selected")).toBe("true");
    localStorage.clear();
  });

  it("opens with the default grouping from the settings when the URL has none", async () => {
    const { slot } = await page("", {}, lang, { defaultGrouping: "model" });
    await waitFor(() => expect(slot.inspection.rpcCalls.find((c) => c.method === "summary")?.input).toMatchObject({ range: "week", by: "model" }));
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
    const row = await slot.findByRole("button", { name: /Thread t3(?!\d)/ });
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
    const { slot } = await page("week/provider", { status: status(running), summary: (i: Input) => summary(i, { kpis: kpis({ estimated: false }) }) }, lang);
    expect(await slot.findByText(banner)).toBeTruthy();
    expect(await slot.findByText(L[lang].money)).toBeTruthy();
  });

  it.each([["done", { ...running, done: true }], ["absent", undefined]])("hides the banner when the import is %s", async (_name, backfill) => {
    const { slot } = await page("week/provider", { status: status(backfill), summary: (i: Input) => summary(i, { kpis: kpis({ estimated: false }) }) }, lang);
    expect(await slot.findByText(lang === "en" ? "$12.40" : "$12,40")).toBeTruthy();
    expect(slot.queryByRole("status")).toBeNull();
  });
});

describe.each(LANGS)("settings (%s)", (lang) => {
  const x = L[lang];
  it("groups the settings and saves each one on its own, hiding bb's flat list", async () => {
    const app = await loadPluginApp(() => import("./app"));
    // Stand-in for bb's own native list, which the grouped settings replace.
    const native = document.createElement("div");
    native.innerHTML = '<h3>Configuration</h3><div id="card"><div id="native"><input aria-label="Language"><input aria-label="Count usage outside BB"></div></div>';
    document.body.append(native);
    const slot = renderSlot(app.settingsSections![0]!, {}, {
      settings: { ...settingsFor(lang), contextWatchTokens: 300000, includeOutsideBb: false },
      rpc: { "config.set": () => ({ ok: true }), status: () => ({ sources: [], degradedThreads: 0, disk: { bytes: 0, pages: 0, freePages: 0, rows: {} } }), prices: () => ({ version: "v1", entries: [] }) },
    });
    const groups = lang === "en" ? ["General", "Provider limits", "Watchlist", "Savings and prices", "Data"] : ["Общие", "Лимиты провайдеров", "Под наблюдением", "Экономия и цены", "Данные"];
    for (const g of groups) expect(await slot.findByRole("heading", { name: g })).toBeTruthy();
    await waitFor(() => expect((document.getElementById("card") as HTMLElement).style.display).toBe("none")); // the empty host card goes too
    fireEvent.click(slot.getByRole("switch", { name: lang === "en" ? "Count usage outside bb" : "Учитывать использование вне bb" }));
    const threshold = slot.getByLabelText(lang === "en" ? "Context threshold, tokens" : "Порог контекста, токенов");
    fireEvent.change(threshold, { target: { value: "400000" } });
    fireEvent.blur(threshold);
    await waitFor(() => expect(slot.inspection.rpcCalls.filter((c) => c.method === "config.set").map((c) => c.input)).toEqual([
      { key: "includeOutsideBb", value: true }, { key: "contextWatchTokens", value: 400000 },
    ]));
    native.remove();
  });

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

    // No Save button: a rate saves itself when its field loses focus; an unchanged field sends nothing.
    const input = await slot.findByLabelText(x.input);
    expect(slot.queryByRole("button", { name: x.save })).toBeNull();
    fireEvent.blur(input);
    fireEvent.change(input, { target: { value: "4.5" } });
    fireEvent.blur(input);
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
    expect(await en.slot.findByText("Token mix")).toBeTruthy();
    cleanup();
    const ru = await page("week/provider", {}, "ru");
    expect(await ru.slot.findByText("Структура токенов")).toBeTruthy();
    cleanup();
    // An unknown value falls back to English.
    const app = await loadPluginApp(() => import("./app"));
    const odd = renderSlot(app.navPanels[0]!, { subPath: "week/provider" }, { rpc: handlers(), settings: { language: "de" } });
    expect(await odd.findByText("Token mix")).toBeTruthy();
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
    expect(parseSubPath("month", "model")).toMatchObject({ range: "month", by: "model" }); // a URL without grouping takes the default
    expect(parseSubPath("month/provider", "model").by).toBe("provider");
    expect([fmtSpan(87 * 3_600_000 + 59_000, en), fmtSpan(15 * 3_600_000, ru), fmtSpan(48 * 3_600_000, en), fmtSpan(10_000, en)]).toEqual(["3 d 15 h", "15 ч", "2 d", "<1 min"]);
    const accounts = [{ providerId: "codex", label: "a@example.com", plan: "pro" }, { providerId: "codex", label: "b@example.com", plan: "pro" }, { providerId: "claude-code", label: "c@example.com", plan: "max" }];
    expect(accounts.map((x) => accountName(x, accounts, en))).toEqual(["a@example.com", "b@example.com", "Claude Code"]);
    expect(fmtPlan("self_serve_business_pro")).toBe("Self serve business pro");
    expect([fmtSpan(4 * 3_600_000 + 59 * 60_000, en), fmtSpan(12 * 60_000 + 5_000, ru)]).toEqual(["4 h 59 min", "12 мин"]);
    expect(parseSubPath(toSubPath("day", "provider", "~outside"))).toEqual({ range: "day", by: "provider", project: "~outside" });
    expect(toSubPath("day", "provider", "a/b")).toBe("day/provider/a%2Fb");
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

  it("keeps provider colors fixed and groups models by provider, each provider's rest last", () => {
    const s = summary({ range: "week", by: "provider" }, {});
    const byProvider = buildChart(s as never, "provider", "week", en);
    expect(byProvider.slots.map((x) => [x.id, x.label])).toEqual([["s1", "Claude Code"], ["s2", "Codex"]]);
    const keys = ["gpt-5", "claude-sonnet-4", "other:claude-code", "claude-opus-4"];
    const provider = (k: string) => (k.startsWith("gpt") ? "codex" : "claude-code");
    const base = summary({ range: "week", by: "model" });
    const m = {
      ...base,
      buckets: base.buckets.map((b, i) => ({ ...b, series: Object.fromEntries(keys.map((k, j) => [k, { ...cost(k === "claude-opus-4" ? 50 : j + i + 1), calls: 1 }])) })),
      breakdown: keys.map((k) => ({ key: k, label: k, provider: provider(k), cost: cost(1), calls: 1 })),
    };
    const byModel = buildChart(m as never, "model", "week", en);
    expect(byModel.slots.map((x) => [x.label, x.group])).toEqual([
      ["claude-opus-4", "claude-code"], ["claude-sonnet-4", "claude-code"], ["Other", "claude-code"], ["gpt-5", "codex"],
    ]);
    expect(byModel.slots[0]!.color).not.toBe(byModel.slots[1]!.color); // shades of one provider color
    expect(byModel.slots[2]!.title).toBe("Claude Code · Other");
    expect(buildChart(m as never, "model", "week", ru).slots[2]!.title).toBe("Claude Code · Другое");
    expect(byModel.rows).toHaveLength(7);
  });

  it("draws small segments at a minimum height, keeps order and the column total", () => {
    const h = spread([1000, 10, 0.1, 0], 30);
    expect(h[3]).toBe(0);
    expect(h[2]).toBe(30);
    expect(h[0]!).toBeGreaterThan(h[1]!);
    expect(h[1]!).toBeGreaterThan(30);
    expect(h.reduce((a, b) => a + b, 0)).toBeCloseTo(1010.1);
    expect(spread([1, 2], 30)).toEqual([30, 30]); // a column too short for its minimums grows to hold them
  });

  it("finds the hovered column only inside the bar and the nearest segment across its gaps", () => {
    const segs = (pairs: [string, number, number][]) => new Map(pairs.map(([id, a, b]) => [id, [a, b] as [number, number]]));
    const geo = new Map([[1, { x: 10, w: 20, segs: segs([["s1", 100, 200], ["s2", 50, 96]]) }], [2, { x: 50, w: 20, segs: segs([["s1", 180, 200]]) }]]);
    // Between the bars, beside a bar and above its top segment there is no column.
    expect([pickColumn(geo, 20, 98), pickColumn(geo, 60, 190), pickColumn(geo, 40, 190), pickColumn(geo, 5, 150), pickColumn(geo, 20, 40), pickColumn(geo, 60, 150)])
      .toEqual([1, 2, null, null, null, null]);
    expect([pickSegment(geo.get(1)!.segs, 98), pickSegment(geo.get(1)!.segs, 60), pickSegment(geo.get(1)!.segs, 150)]).toEqual(["s1", "s2", "s1"]);
  });
});

describe.each(LANGS)("watchlist (%s)", (lang) => {
  const x = lang === "en"
    ? { title: "Watchlist", sub: "threads with a large context that are still working", head: ["Thread", "Context", "Calls / h", "~$ per call", "~$ last hour"], row: "Codex · gpt-5412K12$0.35$4.20", threads: "Threads" }
    : { title: "Под наблюдением", sub: "треды с большим контекстом, которые продолжают работать", head: ["Тред", "Контекст", "Вызовов / ч", "~$ за вызов", "~$ за час"], row: "Codex · gpt-5412K12$0,35$4,20", threads: "Треды" };
  const item = { threadId: "w1", title: "Long refactor", provider: "codex", model: "gpt-5", contextTokens: 412_000, callsLastHour: 12, readCostPerCallUsd: 0.35, costLastHourUsd: 4.2, lastCallAt: Date.UTC(2026, 10, 3, 12) };
  const open = (items: unknown[]) => page("week/provider", { watchlist: () => ({ items }) }, lang);

  it("renders the section with a subtitle, the column headers and the row numbers", async () => {
    localStorage.clear();
    const { slot } = await open([item]);
    const header = await slot.findByRole("button", { name: x.title });
    expect(norm(header.parentElement)).toContain(x.sub);
    const row = await slot.findByRole("button", { name: /Long refactor/ });
    expect(norm(row.closest("ul")!.previousElementSibling).replace(/\s/g, "")).toBe(x.head.join("").replace(/\s/g, ""));
    expect(norm(row).replace(/Long refactor/, "").replace(/\s/g, "")).toBe(x.row.replace(/\s/g, ""));
    // It sits above the Threads section and does not depend on the range or project.
    expect(header.compareDocumentPosition(await slot.findByRole("button", { name: x.threads })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(slot.inspection.rpcCalls.find((c) => c.method === "watchlist")?.input).toEqual({});
  });

  it("shows no price for null costs", async () => {
    const { slot } = await open([{ ...item, readCostPerCallUsd: null, costLastHourUsd: null }]);
    expect(norm(await slot.findByRole("button", { name: /Long refactor/ }))).toContain(L[lang].noPrice);
  });

  it("is hidden entirely when there are no items", async () => {
    const { slot } = await open([]);
    await slot.findByText(L[lang].money);
    await waitFor(() => expect(slot.inspection.rpcCalls.some((c) => c.method === "watchlist")).toBe(true));
    expect(slot.queryByText(x.title)).toBeNull();
  });

  it("opens the thread on click and collapses like Threads", async () => {
    localStorage.clear();
    const { slot } = await open([item]);
    fireEvent.click(await slot.findByRole("button", { name: /Long refactor/ }));
    expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toThread", threadId: "w1" });
    fireEvent.click(slot.getByRole("button", { name: x.title }));
    expect(localStorage.getItem("tokenomos:section:watchlist")).toBe("closed");
    expect(slot.queryByRole("button", { name: /Long refactor/ })).toBeNull();
    localStorage.clear();
  });
});

describe("collapsible sections and compaction total", () => {
  it("collapses Threads without fetching it and remembers the choice", async () => {
    localStorage.clear();
    const topThreads = vi.fn((i: { offset: number }) => ({ items: [thread(`t${i.offset}`)], hasMore: false }));
    const { slot } = await page("week/provider", { topThreads });
    const header = await slot.findByRole("button", { name: "Threads" });
    expect(header.getAttribute("aria-expanded")).toBe("true");
    header.click();
    expect(localStorage.getItem("tokenomos:section:threads")).toBe("closed");
    slot.unmount();
    topThreads.mockClear();
    const again = await page("week/provider", { topThreads });
    expect((await again.slot.findByRole("button", { name: "Threads" })).getAttribute("aria-expanded")).toBe("false");
    expect(topThreads).not.toHaveBeenCalled();
    localStorage.clear();
  });

  it("shows the overall compaction saving and how many have no data", async () => {
    localStorage.clear();
    const items = [
      { ...compaction, id: "a", saving: { usd: 1.25, tokens: 1, partial: false, excludesOwnCost: false } },
      { ...compaction, id: "b", saving: { usd: 0.75, tokens: 1, partial: false, excludesOwnCost: false } },
      { ...compaction, id: "c", saving: { usd: null, tokens: 0, partial: true, excludesOwnCost: true } },
    ];
    const { slot } = await page("week/provider", { compactions: () => ({ items }) });
    const header = await slot.findByText(/3 compactions/);
    expect(norm(header)).toContain("saved ~$2.00");
    expect(norm(header)).toContain("1 without data");
  });
});
