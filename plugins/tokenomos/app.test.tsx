// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Cost } from "./contract";
import { buildChart } from "./components/series";
import { bucketLabel, fmtCost, fmtReset, fmtTokens, fmtUsd, parseSubPath, toSubPath } from "./components/format";
import { delta } from "./components/kpis";

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

const limits = {
  fetchedAt: 1,
  windows: [
    { provider: "claude-code", id: "w1", label: "5 часов", kind: "five-hour", usedPercent: 63, resetsAt: new Date(Date.now() + 2 * HOUR).toISOString(), model: null, since: 0,
      byModel: [
        { model: "claude-opus-4", cost: cost(9) }, { model: "claude-sonnet-4", cost: cost(3) }, { model: "claude-haiku", cost: cost(1) }, { model: "tiny-model", cost: cost(0.5) },
      ] },
    { provider: "codex", id: "w2", label: "Неделя", kind: "weekly", usedPercent: 12, resetsAt: new Date(Date.now() + 4 * 24 * HOUR).toISOString(), model: null, since: null, byModel: null },
  ],
};
const thread = (id: string) => ({ threadId: id, title: `Тред ${id}`, projectId: "p", provider: "codex", own: cost(1.25), total: cost(2.5) });
const compaction = {
  id: "c1", threadId: "t9", title: "Компакт-тред", at: Date.UTC(2026, 10, 3, 12), beforeTokens: 900_000, afterTokens: 120_000, origin: "idle-compact" as const,
  saving: { usd: -0.05, tokens: 780_000, partial: true, excludesOwnCost: true },
};

function handlers(over: Record<string, (input: any) => unknown> = {}): Record<string, (input: any) => unknown> {
  return {
    limits: () => limits,
    summary: (i: Input) => summary(i),
    topThreads: (i: { offset: number }) => (i.offset === 0 ? { items: Array.from({ length: 50 }, (_, n) => thread(`t${n}`)), hasMore: true } : { items: [thread("t-next")], hasMore: false }),
    compactions: () => ({ items: [compaction] }),
    ...over,
  };
}

async function page(subPath = "week/provider", over: Record<string, (input: any) => unknown> = {}) {
  const app = await loadPluginApp(() => import("./app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath }, { rpc: handlers(over) });
  return { app, slot };
}

describe("registration", () => {
  it("registers the page and the settings section", async () => {
    const app = await loadPluginApp(() => import("./app"));
    expect(app.navPanels[0]).toMatchObject({ id: "tokenomos", path: "tokenomos", title: "Tokenomos" });
    expect(app.settingsSections?.[0]).toMatchObject({ id: "tokenomos-settings", title: "Tokenomos" });
  });
});

describe("page", () => {
  it("shows limits first with top 3 models only when byModel is known", async () => {
    const { slot } = await page();
    await slot.findByText("5 часов", { exact: false });
    const rows = slot.getAllByRole("listitem").filter((li) => li.textContent?.includes("Claude Code") || li.textContent?.includes("Codex"));
    const [claude, codex] = rows;
    expect(claude!.textContent).toContain("63 %");
    expect(claude!.textContent).toContain("claude-opus-4");
    expect(claude!.textContent).not.toContain("tiny-model");
    expect(within(claude!).getAllByRole("listitem")).toHaveLength(3);
    expect(codex!.textContent).toContain("12 %");
    expect(codex!.textContent).toContain("через 4 д");
    expect(within(codex!).queryAllByRole("listitem")).toHaveLength(0);
    expect(slot.getAllByRole("meter")).toHaveLength(2);
    // Limits come before the KPI tiles in document order.
    expect(slot.getByText("Лимиты").compareDocumentPosition(await slot.findByText("Расход (API-эквивалент)")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders KPI tiles with the cache-read share and estimated money", async () => {
    const { slot } = await page();
    expect(await slot.findByText("~$12.40")).toBeTruthy();
    expect(slot.getByText("чтение из кэша 87 %")).toBeTruthy();
    expect(slot.getByText("+24 % к прошлому периоду")).toBeTruthy();
    expect(slot.getByText("Компакция ~")).toBeTruthy();
    expect(slot.getByText("~$1.50")).toBeTruthy();
    expect(slot.getByText("vs claude-sonnet-4")).toBeTruthy();
    expect(slot.getAllByText("без учёта стоимости самой компакции").length).toBeGreaterThan(0);
  });

  it("says there is no previous period when previous is null", async () => {
    const { slot } = await page("week/provider", { summary: (i: Input) => summary(i, { previous: null }) });
    expect(await slot.findByText("нет данных за прошлый период")).toBeTruthy();
  });

  it("shows tokens only and «нет цены» when usd is null", async () => {
    const { slot } = await page("week/provider", { summary: (i: Input) => summary(i, { totals: cost(null), previous: null }) });
    const tile = (await slot.findByText("Расход (API-эквивалент)")).parentElement!;
    expect(tile.textContent).toContain("нет цены");
    expect(tile.textContent).not.toContain("$");
  });

  it.each(Object.entries(COUNTS))("draws %s with %i buckets", async (range, count) => {
    const { slot } = await page(`${range}/provider`);
    await waitFor(() => expect(slot.container.querySelector("[data-bucket-count]")?.getAttribute("data-bucket-count")).toBe(String(count)));
    fireEvent.click(slot.getByRole("button", { name: "Таблица" }));
    const table = (await slot.findAllByRole("table"))[0]!;
    expect(within(table).getAllByRole("row")).toHaveLength(count + 1);
  });

  it("offers exactly four ranges and writes range and grouping to the URL", async () => {
    const { slot } = await page();
    await slot.findByText("~$12.40");
    const tabs = slot.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual(["День", "Неделя", "Месяц", "3 месяца", "По провайдерам", "По моделям"]);
    fireEvent.mouseDown(slot.getByRole("tab", { name: "Месяц" }), { button: 0 });
    fireEvent.mouseDown(slot.getByRole("tab", { name: "По моделям" }), { button: 0 });
    // Radix fires on both mouse-down and focus, so check membership rather than the exact log.
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "tokenomos", options: { subPath: "month/provider", replace: true } });
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "tokenomos", options: { subPath: "week/model", replace: true } });
  });

  it("shows skeletons on the first load only, not on refetch", async () => {
    let calls = 0;
    const gates: (() => void)[] = [];
    const gate = () => new Promise<void>((resolve) => gates.push(resolve));
    const { slot } = await page("week/provider", { summary: async (i: Input) => { calls++; await gate(); return summary(i); } });
    expect(slot.getAllByTestId("skeleton").length).toBeGreaterThan(0);
    gates[0]!();
    await slot.findByText("~$12.40");
    void slot.experimental_invalidateRpc(null); // the refetch stays pending behind its gate
    await waitFor(() => expect(calls).toBe(2));
    expect(slot.queryAllByTestId("skeleton")).toHaveLength(0);
    expect(slot.getByText("~$12.40")).toBeTruthy();
    gates[1]!();
  });

  it("opens a thread from the list and pages with «Ещё»", async () => {
    const { slot } = await page();
    const row = await slot.findByRole("button", { name: /Тред t3\b/ });
    fireEvent.click(row);
    expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toThread", threadId: "t3" });
    fireEvent.click(slot.getByRole("button", { name: "Ещё" }));
    expect(await slot.findByRole("button", { name: /Тред t-next/ })).toBeTruthy();
    expect(slot.queryByRole("button", { name: "Ещё" })).toBeNull();
    expect(slot.inspection.rpcCalls).toBeDefined();
  });

  it("lists compactions with a negative net shown as a cost", async () => {
    const { slot } = await page();
    const row = await slot.findByRole("button", { name: /Компакт-тред/ });
    expect(row.textContent).toContain("−~$0.05");
    expect(row.textContent).toContain("затраты");
    expect(row.textContent).toContain("Idle Compact");
    expect(row.textContent).toContain("900K → 120K");
    expect(row.textContent).toContain("без учёта стоимости самой компакции");
    expect(row.textContent).toContain("частично");
  });
});

describe("settings", () => {
  it("renders sources and saves or resets a price override", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const setPriceOverride = vi.fn(() => ({ ok: true as const }));
    const rates = { input: 3, output: 15, cacheRead: 0.3, cacheWriteShort: 3.75, cacheWriteLong: 6 };
    const slot = renderSlot(app.settingsSections![0]!, {}, {
      rpc: {
        status: () => ({
          sources: [{ id: "claude-file", lastIngestAt: Date.UTC(2026, 10, 3, 12), rows: 1234, lastError: "boom", state: "ok" }],
          degradedThreads: 2, disk: { bytes: 5 * 1024 * 1024, pages: 100, freePages: 3, rows: { usage_hourly: 77 } },
        }),
        prices: () => ({ version: "v1", entries: [{ model: "claude-opus-4", rates, overridden: true, verified: true }] }),
        setPriceOverride, prune: () => ({ deletedRows: 7 }),
      },
    });
    expect(await slot.findByText("Claude Code (файлы)")).toBeTruthy();
    expect(slot.getByText("1234")).toBeTruthy();
    expect(slot.getByText("boom")).toBeTruthy();
    expect(slot.getByText(/Деградировавших тредов: 2/)).toBeTruthy();
    expect(slot.getByText(/usage_hourly: 77/)).toBeTruthy();

    const save = await slot.findByRole("button", { name: "Сохранить" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(slot.getByLabelText("claude-opus-4: Вход"), { target: { value: "4.5" } });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(slot.inspection.rpcCalls.filter((c) => c.method === "setPriceOverride")).toEqual([{ method: "setPriceOverride", input: { model: "claude-opus-4", rates: { input: 4.5 } } }]));

    fireEvent.click(slot.getByRole("button", { name: "Сбросить" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.at(-1)).toEqual({ method: "setPriceOverride", input: { model: "claude-opus-4", rates: null } }));

    fireEvent.click(slot.getByRole("button", { name: "Очистить старые данные" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.some((c) => c.method === "prune")).toBe(true));
  });
});

describe("helpers", () => {
  it("formats tokens, money and resets", () => {
    expect(fmtTokens(1_200_000)).toBe("1.2M");
    expect(fmtTokens(340_000)).toBe("340K");
    expect(fmtTokens(950)).toBe("950");
    expect(fmtUsd(12.4)).toBe("$12.40");
    expect(fmtUsd(0.004)).toBe("$0.0040");
    expect(fmtCost(cost(12.4, 1, 1, 1, { partial: true }))).toBe("~$12.40");
    expect(fmtCost(cost(12.4))).toBe("$12.40");
    expect(fmtCost(cost(null))).toBeNull();
    const now = Date.UTC(2026, 10, 15, 8);
    expect(fmtReset(new Date(now + 2 * 86_400_000).toISOString(), now)).toBe("через 2 д");
    expect(fmtReset(new Date(now + HOUR).toISOString(), now)).toMatch(/^сброс в \d\d:\d\d$/);
    expect(fmtReset(null, now)).toBeNull();
    expect(bucketLabel("day", Date.UTC(2026, 10, 1, 5))).toMatch(/^\d\d:00$/);
  });

  it("round-trips the sub path and falls back to week/provider", () => {
    expect(parseSubPath(toSubPath("3m", "model"))).toEqual({ range: "3m", by: "model" });
    expect(parseSubPath("nonsense")).toEqual({ range: "week", by: "provider" });
    expect(parseSubPath("")).toEqual({ range: "week", by: "provider" });
  });

  it("computes the delta from dollars, falling back to tokens", () => {
    expect(delta(cost(12), cost(10))).toBe("+20 % к прошлому периоду");
    expect(delta(cost(null, 2000, 0, 0), cost(null, 1000, 0, 0))).toContain("(токены)");
    expect(delta(cost(1), null)).toBeNull();
  });

  it("keeps provider colors fixed and folds models beyond the top four into Другие", () => {
    const s = summary({ range: "week", by: "provider" }, {});
    const byProvider = buildChart(s as never, "provider", "week");
    expect(byProvider.slots.map((x) => [x.id, x.label])).toEqual([["s1", "Claude Code"], ["s2", "Codex"]]);
    const byModel = buildChart(summary({ range: "week", by: "model" }) as never, "model", "week");
    expect(byModel.slots.map((x) => x.n)).toEqual([1, 2, 3, 4, 5]);
    expect(byModel.slots.at(-1)!.label).toBe("Другие");
    expect(byModel.rows).toHaveLength(7);
  });
});
