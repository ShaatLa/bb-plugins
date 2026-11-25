---
name: tokenomos
description: Read token usage and API-equivalent cost of BB threads (spend by provider and model, savings estimates, provider limit pace and heavy-model share) with the tokenomos CLI, and call the costs.sum and costs.threads RPCs from other plugins.
---

# Tokenomos

Tokenomos counts tokens and API-equivalent spend across BB threads: what the same tokens would cost at API list prices. It is not a bill. Use money figures to compare threads, models and periods, not to report what the user paid.

## When to use it

- The user asks what a period cost, which model used their limit, or what compaction or local models saved: run `bb tokenomos summary`.
- You coordinate work across providers, or the user asks whether a limit will last or whether heavy models are overused: run `bb tokenomos limits`.
- Numbers look wrong or stale, or you need to know which source covers a thread: run `bb tokenomos status`.
- Another plugin needs the cost of some threads: call `costs.sum` or `costs.threads`.

## CLI

```sh
bb tokenomos wake-cost <threadId> [--json]
bb tokenomos status [--json]
bb tokenomos summary [--range day|week|month|3m] [--json]
bb tokenomos limits [--json]
```

`status` (plain output):

- First line: `Backfill: <processed>/<total> threads; complete` or `...; history is loading, numbers are incomplete`. While history loads, totals are lower bounds.
- Then `Disk: <bytes> bytes; degraded threads: <n>`, and `Event loop (last minute): p99 <ms> ms; max <ms> ms` when measured.
- Then one line per source (at most 50): `<id>: <rows> rows; <state>; last ingest <ISO time or never>`.
- `state` is `ok`, `degraded` (a fallback or coverage problem is active), `no-data`, or `error` on the `priceOverrides` line when the saved price table is invalid (fix it in the Tokenomos settings).
- `--json`: `{ backfill: { processedThreads, totalThreads, done, startedAt }, sources: [{ id, lastIngestAt, rows, lastError, state }], degradedThreads, disk: { bytes, pages, freePages, rows }, loop?: { p99Ms, maxMs } }`.

`summary` (default range `week`, plain output):

- First line: `<range>: <money>` with the total.
- `Providers:` then one line per provider: `<key>: <money>; <calls> calls`.
- `Models:` then the same per model.
- Money format: `$` and four decimals; `?` when the price is unknown; ` (partial)` and ` ~` suffixes as described below.
- `--json`: `{ providers, models }`. Each is a summary result: `{ range, from, to, buckets: [{ start, series }], totals, previous, cacheReadShare, breakdown: [{ key, label, provider, cost, calls }], compactionSavings, localSavings }`. In `models`, each provider keeps its three costliest models; the rest of a provider is the key `other:<provider>`.

`limits` (plain output; not tied to a range or project):

- One line per account: `<label> [<providerId>] <plan>: <status>` (`stale, last known data from <time>` when the source did not answer this time; those numbers are kept up to 24 hours), then one line per limit window: percent used, share of the window elapsed, reset time (UTC), then `exhausted until reset`, `runs out <time>` (the limit is projected to end before its reset) or `~<n>% at reset`, then the window's API-equivalent spend, the heavy-model share of that cost, heavy calls of all calls, and `$ per 1%`.
- Last line: the heavy model families (setting `heavyModels`, default `fable, opus, sol, astra, argon`) and the target for their share of the cost (setting `heavyTargetPercent`, default 50; `no target set` when it is 0).
- `--json`: `{ heavyModels, heavyTarget /* fraction, null when off */, accounts: [{ providerId, label, plan, status, message, observedAt, stale?, windows: [{ id, label, kind, model, usedPercent, resetsAt, startsAt, elapsedShare, forecastPercent, runsOutAt, usage: { heavy: { usd, calls }, other: { usd, calls }, heavyShare, usdPerPercent, partial, recentUsdPerHour? } | null }] }] }`. `recentUsdPerHour` is the spend per hour over the last seven days, set for windows of a week or longer, whose forecast projects it. Times are epoch ms; a window at 0% with `resetsAt: null` has reset and not started again (the source leaves it out until the next request); `usage` is null when the window length is unknown; `heavyShare` is null for a window scoped to a heavy model (Claude's Fable week).
- Reading it: a window that runs out before its reset needs load moved to another provider; a heavy share above the target means routine work should move to medium and light models (Sonnet, Terra, Haiku, Luna, Flash). The window spend is provider-wide and includes usage outside BB.

Cost shape everywhere: `{ usd: number | null, tokens: { freshIn, cacheRead, cacheWrite, output }, estimated: boolean, partial: boolean }`.

## Public RPCs (plugin id `tokenomos`)

Other plugins must use only these two: Tokenomos refuses a plugin caller on any other method with code `forbidden`, and the refusal names these two. Both are tagged `usage` and accept 1 to 2000 thread IDs (2000 spans in the time-window form); one call dedupes shared threads and descendants, so send a whole set (an epic) in one call rather than summing per-item results.

- `costs.sum` input `{ threadIds: string[], includeDescendants: boolean }` → `{ priceVersion, cost: Cost, threadCount, updatedAt }`. `cost` is the deduplicated sum.
- `costs.sum` also accepts `{ spans: { threadId, from, to: number | null }[], includeDescendants }` to count only calls made while each thread was inside its time windows (epoch ms; `to: null` means now). Overlapping spans are merged, a descendant uses the union of its roots' spans, and `threadCount` counts threads with at least one counted call. Hours cut by a span edge are exact for the last 30 days and whole-hour estimates (`estimated: true`) before that.
- Both `costs.sum` forms take `breakdown: true` to add `threads: { threadId, title, model, cost }[]` (one row per counted thread, descendants included, summing to `cost`; `model` is the thread's top model by usd) and `models: { provider, model, cost, calls }[]`, both sorted by usd descending.
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

Work Board calls `costs.sum` for a task's Cost section. Agent Hub calls `costs.threads` with `includeDescendants` for the cost label of the open chat: the session itself plus its sub-sessions.

The other methods (`summary`, `limits`, `topThreads`, `compactions`, `projects`, `status`, `watchlist`, `wakeCost`, `prices`, `setPriceOverride`, `prune`, `config.*`) belong to the Tokenomos page and CLI, change without notice, and refuse plugin callers. For a period's spend from another plugin, call `costs.sum` with `spans` and `breakdown: true`; an agent runs `bb tokenomos summary --json`.

## What "partial" and "estimated" mean

- `partial: true`: something is missing from the number. Causes: unknown model or tier, unknown thread IDs, gaps recovered from BB events, a degraded thread, or compaction effects that could not be priced. Treat the figure as a lower bound.
- `estimated: true`: the number contains an estimate. Causes: unverified prices (Gemini), totals from the BB-events fallback, or any saving figure. The UI shows it as `~`.
- `usd: null`: the price is unknown. The token counts are still valid.
- Local models cost 0 in spend. Their savings (`localSavings`) are a separate estimate priced against the reference model.
- Antigravity has no usage source in this repository, so its threads show no data until its plugin exposes `usage.list`.
- Tokenomos stores token counts, IDs, timestamps, model names and thread titles. It never stores message text.

## Before waking an idle thread

Before sending work to a thread idle longer than its cache TTL, run `bb tokenomos wake-cost <threadId> --json`. If `cacheLikelyExpired` is true and `coldCostUsd` exceeds $0.50, a fresh child thread is cheaper: start one if you may start threads, otherwise give the user the cold cost and let them choose. Unknown context or cost is not zero. An assumed TTL and its expiry prediction are estimates. An unknown thread id fails with `not_found` and names the fix; `contextTokens: null` means the thread exists but its context is unknown.
