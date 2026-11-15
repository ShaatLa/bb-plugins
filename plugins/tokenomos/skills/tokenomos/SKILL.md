---
name: tokenomos
description: Read token usage and API-equivalent cost of BB threads (limits, spend by provider and model, savings estimates) with the tokenomos CLI, and call the costs.sum and costs.threads RPCs from other plugins.
---

# Tokenomos

Tokenomos counts tokens and API-equivalent spend across BB threads: what the same tokens would cost at API list prices. It is not a bill. Use money figures to compare threads, models and periods, not to report what the user paid.

## When to use it

- The user asks what a period cost, which model used their limit, or what compaction or local models saved: run `bb tokenomos summary`.
- Numbers look wrong or stale, or you need to know which source covers a thread: run `bb tokenomos status`.
- Another plugin needs the cost of some threads: call `costs.sum` or `costs.threads`.

## CLI

```sh
bb tokenomos wake-cost <threadId> [--json]
bb tokenomos status [--json]
bb tokenomos summary [--range day|week|month|3m] [--json]
```

`status` (plain output):

- First line: `Disk: <bytes> bytes; degraded threads: <n>`.
- Then one line per source (at most 50): `<id>: <rows> rows; <state>; last ingest <ISO time or never>`.
- `state` is `ok`, `degraded` (a fallback or coverage problem is active) or `no-data`.
- `--json`: `{ sources: [{ id, lastIngestAt, rows, lastError, state }], degradedThreads, disk: { bytes, pages, freePages, rows } }`.

`summary` (default range `week`, plain output):

- First line: `<range>: <money>` with the total.
- `Providers:` then one line per provider: `<key>: <money>; <calls> calls`.
- `Models:` then the same per model.
- Money format: `$` and four decimals; `?` when the price is unknown; ` (partial)` and ` ~` suffixes as described below.
- `--json`: `{ providers, models }`. Each is a summary result: `{ range, from, to, buckets: [{ start, series }], totals, previous, cacheReadShare, breakdown: [{ key, label, cost, calls }], compactionSavings, localSavings }`.

Cost shape everywhere: `{ usd: number | null, tokens: { freshIn, cacheRead, cacheWrite, output }, estimated: boolean, partial: boolean }`.

## Public RPCs (plugin id `tokenomos`)

Other plugins should use only these two. Both are tagged `usage` and accept 1 to 200 thread IDs.

- `costs.sum` input `{ threadIds: string[], includeDescendants: boolean }` → `{ priceVersion, cost: Cost, threadCount, updatedAt }`. `cost` is the deduplicated sum.
- `costs.threads` same input → `{ priceVersion, threads: [{ threadId, own: Cost, total: Cost, descendantCount, updatedAt }] }`. `total` includes descendants when `includeDescendants` is true.

Unknown thread IDs are skipped and make the result `partial`.

Call them fail-soft through the SDK, with a timeout, and hide the cost on any error:

```ts
const sum = await sdk.plugins.callRpc({
  pluginId: "tokenomos",
  method: "costs.sum",
  input: { threadIds, includeDescendants: true },
  outputSchema, // your own zod schema for the result
  signal: AbortSignal.timeout(3000),
}).catch(() => null);
// null: plugin missing, timeout or error. Hide the figure; never show 0.
```

Answers and Work Board do not call these RPCs in this version; the contract is ready for them.

Other UI methods (`summary`, `topThreads`, `compactions`, `limits`, `status`, `prices`, `setPriceOverride`, `prune`) belong to the Tokenomos page and CLI. Do not build on them from another plugin.

## What "partial" and "estimated" mean

- `partial: true`: something is missing from the number. Causes: unknown model or tier, unknown thread IDs, gaps recovered from BB events, a degraded thread, or compaction effects that could not be priced. Treat the figure as a lower bound.
- `estimated: true`: the number contains an estimate. Causes: unverified prices (Gemini), totals from the BB-events fallback, or any saving figure. The UI shows it as `~`.
- `usd: null`: the price is unknown. The token counts are still valid.
- Local models cost 0 in spend. Their savings (`localSavings`) are a separate estimate priced against the reference model.
- Antigravity has no usage source in this repository, so its threads show no data until its plugin exposes `usage.list`.
- Tokenomos stores token counts, IDs, timestamps, model names and thread titles. It never stores message text.

## Before waking an idle thread

Before sending work to a thread idle longer than its cache TTL, run `bb tokenomos wake-cost <threadId> --json`. If `cacheLikelyExpired` is true and `coldCostUsd` exceeds $0.50, prefer a fresh child thread. Unknown context or cost is not zero. An assumed TTL and its expiry prediction are estimates. The command distinguishes unknown context from a `not_found` thread.
