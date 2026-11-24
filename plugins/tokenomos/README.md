# Tokenomos

English | [Русский](README.ru.md)

Tokenomos shows how many tokens and API-equivalent costs BB threads consume, and how much compaction and local models have saved.

All amounts are **API-equivalent**: what those same tokens would cost at public API prices. Since you pay differently under a subscription, treat this number as a measure of volume rather than a bill.

## What the page shows

- **Ranges.** Day (24 hours), Week (7 days), Month (30 days), 3 months (13 weeks). Boundaries are calendar-aligned and follow the server time zone.
- **Tiles.** "Spending (API equivalent)" with change vs. the previous period; "Tokens" with cache-read share; "Compaction ~" — estimated savings from compaction; "Local models ~" — estimated savings from local models.
- **Chart and table.** Columns by interval with a tooltip for each segment; a "By provider / By model" toggle.
- **Breakdown.** Fresh input, cache read, cache write, output, number of calls, and ~$.
- **Top threads.** 50 per page, with a "More" button. Each thread shows its own ~$ and the ~$ including sub-threads; clicking a thread opens it.
- **Compactions in range.** Thread, time, tokens "before → after", source, and ~ net savings.
- **Provider limits.** Shown when a plugin reports limits over `provider-usage.v1` (the Claude Code, Codex and Antigravity providers, Account Pooler). One card per account; for each window: percent used, time elapsed, the forecast at reset or when the limit runs out, ~$ per 1% of the limit, and the share of heavy models in the window's API-equivalent cost (compared with the target from the settings, 50% by default), with the share of calls for reference. The window spend is provider-wide and includes usage outside BB, because the subscription counts it. Limits are collected at most once a minute and only while the page or CLI asks.

## Where the numbers come from

| Source | What it provides | When it is used |
| --- | --- | --- |
| **Claude Code** | Transcripts `~/.claude/projects/**/*.jsonl` on the BB server machine, including subagents. | The Claude Code thread for which the file was found. |
| **Codex** | Transcripts `~/.codex/sessions` and `~/.codex/archived_sessions` on the BB server machine, including child threads (e.g., guardian checks). | The root Codex thread for which the file was found. |
| **BB Events** | `thread/tokenUsage/updated`, step counts, context, compactions. | All other providers, remote machines, and threads where the file does not appear within 10 minutes after the first BB event. If the file does not cover three consecutive steps, Tokenomos switches to BB events for that interval. |
| **local-models** | RPC `usage.list` of the local-models plugin — one record per model request. | Local models; cost is 0, and savings are calculated based on the reference model. |
| **Antigravity** | RPC `usage.list` of the antigravity plugin (per model steps from the `agy` stream-json). | A version of the antigravity plugin with `usage.list` is required (branch `feat/antigravity-usage`, not yet released). Without it, Antigravity threads are not accounted for. Usage prior to its installation cannot be recovered. |
| **Idle Compact** | RPC `compactions.list` of the `idle-compact` plugin. | Marks compactions as `idle-compact` and verifies them against BB compactions by thread and time (±2 minutes). |

Update: BB events and transcripts are read at ~5-second intervals for modified threads; `usage.list` and `compactions.list` are polled every 60 seconds; BB rate limits are cached for 60 seconds.

## Limitations and Notations

- **“~”** — indicates an estimate: the price has not been verified, the row was reconstructed from BB events, or the figure is a counterfactual estimate of savings.
- **“(partial)”** — some costs are unaccounted for. Reasons include: an unknown model or pricing tier (cost shown as “?” instead of zero), an unrecognized thread in the request, missing BB events (resulting in reconstructed rows), threads with incomplete coverage, and for compaction savings, counterfactual calls that fell into a different pricing tier due to prompt size and thus lack a monetary estimate.
- **Remote machines** do not have transcripts stored on the server, so their usage is sourced from BB events. This data may be incomplete, and such totals are marked as “(partial)”.
- **Prices.** Anthropic and OpenAI rates are verified against official documentation; Gemini rates are not, so any Gemini usage is marked with “~”. The price table and its version are visible in Settings.
- **Savings are estimates.** Compaction calculates what the context would have cost without it under the same calls and models, using current prices at the time of viewing. Savings for local models reflect the same token volume priced at the reference model’s rates, rather than actual monetary savings.

## Settings

The "Tokenomos" section in BB settings shows them in groups (General, Provider limits, Watchlist, Savings and prices, Data) in place of bb's flat list. They stay native fields: `bb plugin config tokenomos set <key> <value>` changes one, and so does RPC `config.set { key, value }`, validated by that setting's own rules; `config.get` reads them.

| Setting | Default | Range / Options | Description |
| --- | --- | --- | --- |
| Language | `en` | `en` (English), `ru` (Russian) | Interface language for the page and settings section; numbers, dates, and times are formatted according to the selected language. The labels for the settings themselves in BB are predefined and do not switch: they are always in English. |
| Default chart grouping | `provider` | `provider`, `model` | What the page opens with when the link names no grouping; the toggle above the chart still switches it. |
| Keep raw records, days | 30 | 7–60 | Retention period for line-level records. Hourly aggregates are kept longer. |
| Keep hourly aggregates, days | 200 | 184–400 | Retention period for hourly aggregates; 200 days cover the "3 months" comparison period. |
| Reference model for cost savings | `claude-sonnet-5-5` | any model in the price table; the picker lists the priced models bb's providers offer, asked afresh each time the settings open; when they cannot be reached, the last list they gave, or a built-in list before the first answer | Model whose prices are used to calculate the savings of local models. |
| Track usage outside BB | off | on / off | Claude Code and Codex sessions in the same directories that are not linked to any BB thread go into a separate "Outside BB" group. Directories are scanned every 5 minutes. These entries are not included in thread totals. |
| Watchlist context threshold | 300000 | 50000–1000000 | Threads with high current context and calls within the last hour. |
| Pool subscriptions of one provider (experimental) | on | on / off | Two or more subscriptions of one provider show as one pool in the limits section and the sidebar widget: what is left in all of them (capacity estimated from the provider's spend per 1% of each window), whether it lasts until the next reset, and which subscription to spend first. Each subscription opens under the pool. Display only. |
| Plan sizes for the pool | empty | `plan=multiplier` pairs | Plan sizes for providers that do not report one (`plan.multiplier` in provider-usage), such as `pro=20, plus=1`; the plan id is the subscription's plan in lower case. With a size for every subscription of a provider, the pool weighs them by size; otherwise their capacity is estimated from spend. |
| Heavy model target, % | 50 | 0–100 | Ceiling for the heavy-model share of a limit window's API-equivalent cost: above it the share turns orange and the hints name the target. `0` turns the target off; the share is still shown. |
| Heavy model families | `fable, opus, sol, astra, argon` | comma-separated words | A model is heavy when a word of its id is in this list (`claude-opus-5-5`, `gpt-6.2-astra`); all other models count as medium and light. Used by the provider limits section. |
| Custom prices ($/MTok, JSON) | `{}` | JSON object; values are validated against the schema | Override model rates (`input`, `output`, `cacheRead`, `cacheWriteShort`, `cacheWriteLong`, $/MTok). Only changes the rates and applies to the entire history at once. |

Additionally, the settings section shows the status of each source, disk volume, and row count, a **Clear old data** button, and a versioned price table. Background cleanup runs daily at 04:17 according to the BB schedule.

## Integrations with Work Board and Agent Hub

Public contract: RPC `costs.threads` and `costs.sum`; other methods refuse plugin callers with `forbidden`. Both are optional in either direction: Tokenomos does not require other plugins, and the calling plugin must work without Tokenomos—with a timeout and without displaying the value on error.

Work Board calls `costs.sum` for the Cost section of a task. Agent Hub calls `costs.threads` with `includeDescendants` for the cost label of the open chat: the session itself plus its sub-sessions.

Schemas from `contract.ts`:

```ts
// Shared cost type
Cost = {
  usd: number | null,                         // null: price unknown
  tokens: { freshIn, cacheRead, cacheWrite, output: number },
  estimated: boolean,                         // "~"
  partial: boolean,                           // "(partial)"
}

// costs.threads
input:  { threadIds: string[] /* 1–2000 */, includeDescendants: boolean }
output: { priceVersion: string,
          threads: { threadId: string, own: Cost, total: Cost,
                     descendantCount: int >= 0, updatedAt: number }[] }

// costs.sum
input:  { threadIds: string[] /* 1–2000 */, includeDescendants: boolean, breakdown?: boolean }
     |  { spans: { threadId: string, from: number, to: number | null }[] /* 1–2000 */,
          includeDescendants: boolean, breakdown?: boolean }
output: { priceVersion: string, cost: Cost, threadCount: int >= 0, updatedAt: number,
          // only with breakdown: true, sorted by usd descending:
          threads?: { threadId: string, title: string, model: string, cost: Cost }[],
          models?: { provider: string, model: string, cost: Cost, calls: int >= 0 }[] }
// breakdown: one row per counted thread (descendants separately); the rows sum to cost;
// model is the thread's most expensive model.
// spans: a call counts only if its time falls inside its thread's window (to: null means until now).
// Overlapping windows of one thread are merged, so a call counts once. A descendant counts
// by the union of its roots' windows. threadCount: threads with at least one counted call.
// Whole hours come from hourly totals; an hour cut by a window edge is counted per call
// while raw records are kept (30 days), and later as a whole hour, marked estimated.
```

Both RPCs carry the `usage` tag and are called via `bb.sdk.plugins.callRpc({ pluginId: "tokenomos", method, input, outputSchema, signal })`. Example call with a 3-second timeout:

```ts
const sum = await sdk.plugins.callRpc({
  pluginId: "tokenomos",
  method: "costs.sum",
  input: { threadIds, includeDescendants: true },
  outputSchema: yourCostSumSchema,   // the calling plugin's zod schema
  signal: AbortSignal.timeout(3000),
}).catch(() => null);                 // error or no Tokenomos: hide the total
```

## CLI

```sh
bb tokenomos wake-cost <threadId> [--json]
bb tokenomos status [--json]
bb tokenomos summary [--range day|week|month|3m] [--json]
bb tokenomos limits [--json]
```

- `status` — sources (id, number of rows, status `ok` / `degraded` / `no-data`, last import time), number of failed threads, and disk usage.
- `summary` — results by provider and model for the selected range; defaults to `week`. Without `--json`, it outputs a summary and breakdown string; with `--json`, it returns a `{ providers, models }` object.
- `limits` — provider limit windows with pace, forecast, ~$ per 1% and the heavy-model share of cost; for a coordinating agent that distributes work across providers.

## Privacy

Tokenomos reads only token counts, session and message identifiers, timestamps, and model and tier names from the transcripts. From BB, it collects thread identifiers, projects, move models, and usage events. The text of messages, prompts, and responses is not stored; the only text retained is thread names, which are needed for the top list and compacts.

## Requirements

- **BB 0.46 or newer** (`engines.bb` ≥ 0.46).
- **Plugin SDK 0.6.132** (`@get-bb/plugin-sdk` 0.6.132; `engines.bbPluginSdk` ≥ 0.6.132).
- For Claude Code and Codex data, these CLIs must be available on the BB server machine; without them, only BB events are supported.
- For building and testing: Node.js 22.19, run `npm ci` in `plugins/tokenomos`.

Installation:

```sh
bb plugin install git:https://github.com/ShaatLa/bb-plugins.git@0.x --plugin tokenomos --tag-prefix tokenomos/
```

- `wake-cost`: current context, estimated cost for cold and warm wake-ups, cache TTL, and its origin; an unknown context is distinct from an unknown thread.
