import { defineRpcContract } from "@get-bb/plugin-sdk";
import { DisclosureSummary } from "./disclosure";
import { experimental_useRpcQuery as useQuery } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { z } from "zod";
import { useTasksQuery } from "../shell/data";
import { useOpenThread } from "./open-thread";

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

const costSchema = z.object({
  usd: z.number().nullable(),
  tokens: z.object({ freshIn: z.number(), cacheRead: z.number(), cacheWrite: z.number(), output: z.number() }),
  estimated: z.boolean(),
  partial: z.boolean(),
});
type Cost = z.infer<typeof costSchema>;
export type ModelCost = { provider: string; model: string; cost: Cost; calls: number };

// Local copy of Tokenomos' costs.sum: Work Board must not import or require that plugin.
// Tagged like Tokenomos' own contract, so its "usage" invalidations refresh this read live.
const tokenomosContract = defineRpcContract({
  "costs.sum": {
    tags: () => ["usage"],
    input: z.object({
      spans: z.array(z.object({ threadId: z.string(), from: z.number(), to: z.number().nullable() })),
      includeDescendants: z.boolean(),
      breakdown: z.boolean(),
    }),
    // threads and models arrive only from Tokenomos versions that support breakdown.
    output: z.object({
      cost: costSchema,
      threadCount: z.number(),
      threads: z.array(z.object({ threadId: z.string(), title: z.string(), model: z.string(), cost: costSchema })).optional(),
      models: z.array(z.object({ provider: z.string(), model: z.string(), cost: costSchema, calls: z.number() })).optional(),
    }),
  },
});

const tokenTotal = ({ freshIn, cacheRead, cacheWrite, output }: Cost["tokens"]) => freshIn + cacheRead + cacheWrite + output;
const approx = (cost: Cost) => (cost.estimated || cost.partial ? "~" : "");
const money = (cost: Cost) =>
  cost.usd === null ? `${approx(cost)}${compact.format(tokenTotal(cost.tokens))} tokens` : `${approx(cost)}$${cost.usd.toFixed(2)}`;

export function formatTaskCost(cost: Cost): { amount: string; detail: string } {
  const { freshIn, cacheRead, cacheWrite, output } = cost.tokens;
  const detail = [
    `Input ${compact.format(freshIn)}, cache read ${compact.format(cacheRead)}, cache write ${compact.format(cacheWrite)}, output ${compact.format(output)} tokens`,
    cost.usd === null ? "no price for some models" : "API-equivalent price",
    cost.estimated ? "includes estimates" : "",
    cost.partial ? "some threads are not counted yet" : "",
  ].filter(Boolean).join(" · ");
  return { amount: money(cost), detail };
}

// Categorical slots of the validated default palette, in fixed order; the tail folds into a neutral "Other".
// Same provider hues as Tokenomos' charts, so a provider reads the same color in both plugins.
const PROVIDER_COLORS: Record<string, string> = {
  "claude-code": "light-dark(#ea580c, #fb923c)",
  codex: "light-dark(#2563eb, #60a5fa)",
  "local-models": "light-dark(#9333ea, #c084fc)",
  antigravity: "light-dark(#e11d48, #fb7185)",
};
const UNKNOWN_PROVIDER_COLOR = "light-dark(#65a30d, #a3e635)";
const OTHER_COLOR = "light-dark(#8a8a86, #6b6b67)";
// A provider's second and third models take lighter shades of its hue; the legend names them.
const SHADES = [100, 65, 40];
const MAX_SLICES = 6;

export type ModelSlice = { label: string; title: string; share: number; amount: string; color: string };

/** Pie slices by price, or by tokens when some model has no price; the largest six keep their own color. */
export function modelSlices(models: ModelCost[]): ModelSlice[] {
  const priced = models.every((entry) => entry.cost.usd !== null);
  const weight = (entry: ModelCost) => (priced ? entry.cost.usd! : tokenTotal(entry.cost.tokens));
  const sorted = models.filter((entry) => weight(entry) > 0).sort((a, b) => weight(b) - weight(a));
  const total = sorted.reduce((sum, entry) => sum + weight(entry), 0);
  if (!total) return [];
  const head = sorted.length > MAX_SLICES ? sorted.slice(0, MAX_SLICES - 1) : sorted;
  const tail = sorted.slice(head.length);
  const perProvider = new Map<string, number>();
  const color = (provider: string) => {
    const index = perProvider.get(provider) ?? 0;
    perProvider.set(provider, index + 1);
    const base = PROVIDER_COLORS[provider] ?? UNKNOWN_PROVIDER_COLOR;
    const shade = SHADES[Math.min(index, SHADES.length - 1)]!;
    return shade === 100 ? base : `color-mix(in oklab, ${base} ${shade}%, transparent)`;
  };
  const slices = head.map((entry) => ({
    label: entry.model,
    title: `${entry.provider} · ${entry.model} · ${entry.calls} calls`,
    share: weight(entry) / total,
    amount: money(entry.cost),
    color: color(entry.provider),
  }));
  if (tail.length) {
    const rest = tail.reduce((sum, entry) => sum + weight(entry), 0);
    slices.push({
      label: `Other (${tail.length})`,
      title: tail.map((entry) => entry.model).join(", "),
      share: rest / total,
      amount: priced ? `$${rest.toFixed(2)}` : `${compact.format(rest)} tokens`,
      color: OTHER_COLOR,
    });
  }
  return slices;
}

export type CostUnit = "%" | "$";

function UnitToggle({ unit, onChange }: { unit: CostUnit; onChange: (unit: CostUnit) => void }) {
  return (
    <div className="flex items-center rounded-md bg-muted p-0.5" aria-label="Show models as">
      {(["%", "$"] as const).map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={unit === value}
          aria-label={value === "%" ? "Share" : "Amount"}
          onClick={() => onChange(value)}
          className={`rounded-sm px-1.5 text-2xs tabular-nums ${unit === value ? "bg-background text-foreground shadow-2xs" : "text-muted-foreground hover:text-foreground"}`}
        >
          {value}
        </button>
      ))}
    </div>
  );
}

function ModelPie({ slices, unit }: { slices: ModelSlice[]; unit: CostUnit }) {
  // Hovering a slice or its legend row highlights that model and dims the rest.
  const [active, setActive] = useState<string | null>(null);
  const dim = (label: string) => (active !== null && active !== label ? "opacity-35" : "");
  // A circle of circumference 100 lets each slice's dash length be its percentage.
  let offset = 25;
  const gap = slices.length > 1 ? 0.6 : 0;
  return (
    <div className="flex items-start gap-3" onMouseLeave={() => setActive(null)}>
      <svg viewBox="0 0 42 42" className="size-16 shrink-0" role="img" aria-label="Cost by model">
        {slices.map((slice) => {
          const length = slice.share * 100;
          const dash = Math.max(length - gap, 0.1);
          const circle = (
            <circle
              key={slice.label}
              cx="21" cy="21" r="15.9155" fill="none" style={{ stroke: slice.color }}
              strokeWidth={active === slice.label ? 9 : 7}
              strokeDasharray={`${dash} ${100 - dash}`}
              strokeDashoffset={offset}
              className={`cursor-default transition-[opacity,stroke-width] ${dim(slice.label)}`}
              onMouseEnter={() => setActive(slice.label)}
            >
              <title>{`${slice.label}: ${Math.round(slice.share * 100)}% · ${slice.amount}`}</title>
            </circle>
          );
          offset -= length;
          return circle;
        })}
      </svg>
      <ul className="min-w-0 flex-1 space-y-0.5">
        {slices.map((slice) => (
          <li
            key={slice.label}
            className={`flex min-w-0 items-center gap-1.5 rounded-sm transition-opacity ${dim(slice.label)} ${active === slice.label ? "font-medium" : ""}`}
            title={`${slice.title} · ${Math.round(slice.share * 100)}% · ${slice.amount}`}
            onMouseEnter={() => setActive(slice.label)}
          >
            <span className="size-2 shrink-0 rounded-sm" style={{ backgroundColor: slice.color }} />
            <span className="min-w-0 flex-1 truncate">{slice.label}</span>
            <span className="shrink-0 text-right tabular-nums">
              {unit === "%" ? `${Math.round(slice.share * 100)}%` : slice.amount}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Spend of every thread that worked on the task or its epic members and subtasks, from the optional Tokenomos plugin. */
export function TaskCostSection({ taskId, epic }: { taskId: string; epic: boolean }) {
  const openThread = useOpenThread();
  const [unit, setUnit] = useState<CostUnit>("%");
  const spans = useTasksQuery(
    async (rpc) => rpc.call("getTaskCostSpans", { taskId }),
    ["threads:changed", "comments:changed"],
    [taskId],
    { relevantTaskIds: [taskId] },
  ).data;
  const query = useQuery({
    pluginId: "tokenomos",
    contract: tokenomosContract,
    method: "costs.sum",
    input: { spans: spans?.spans ?? [], includeDescendants: true, breakdown: true },
    enabled: !!spans?.spans.length,
  });
  const result = query.data;
  // Tokenomos is optional: missing, outdated or failing means no section. Nothing counted yet
  // (Tokenomos still importing history) would show a misleading "~$0.00".
  if (!spans?.spans.length || !result || result.threadCount === 0) return null;
  const cost = { ...result.cost, partial: result.cost.partial || spans.truncated };
  const { amount, detail } = formatTaskCost(cost);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const slices = modelSlices(result.models ?? []);
  const threads = result.threads ?? [];
  return (
    <section aria-label="Task cost" className="mt-4 min-w-0 space-y-2 border-t border-border-hairline pt-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-muted-foreground">Cost</h3>
        {slices.length ? <UnitToggle unit={unit} onChange={setUnit} /> : null}
      </div>
      <div title={detail}>
        <span className="text-sm font-medium tabular-nums">{amount}</span>
        <span className="text-muted-foreground">
          {" · "}{plural(result.threadCount, "thread")}
          {epic || spans.taskCount > 1 ? ` across ${plural(spans.taskCount, "task")}` : ""}
        </span>
      </div>
      {slices.length ? <ModelPie slices={slices} unit={unit} /> : null}
      {threads.length ? (
        <details>
          <DisclosureSummary className="text-muted-foreground hover:text-foreground">
            Threads ({threads.length})
          </DisclosureSummary>
          <ul className="mt-1 space-y-0.5">
            {threads.map((thread) => (
              <li key={thread.threadId} className="flex min-w-0 items-center gap-1.5">
                <button
                  type="button"
                  title={`${thread.title || thread.threadId} · ${thread.model}`}
                  className="min-w-0 flex-1 truncate text-left hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  onClick={() => openThread(thread.threadId)}
                >
                  {thread.title || thread.threadId}
                </button>
                <span className="max-w-24 shrink-0 truncate text-muted-foreground">{thread.model}</span>
                <span className="w-14 shrink-0 text-right tabular-nums">{money(thread.cost)}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
