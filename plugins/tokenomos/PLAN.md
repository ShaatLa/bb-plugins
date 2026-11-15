# Tokenomos — plan

A standalone bb plugin (id `tokenomos`, collection entry `tokenomos`) that
counts token spend and API-equivalent cost across providers, relates it to the
providers' usage limits, estimates savings from compaction and from local
models, charts spend over four ranges, and gives Work Board and Answers optional
per-task and per-session totals.

Status: revision 4, after Codex review rounds 1 (thr_vxuunxng35, 16
findings), 2 (thr_ff2d3349i8, 9) and 3 (thr_2kcz4tyan5, 6 + 2 simplifications),
all addressed below. Facts were checked against bb 0.49.0 (`start-server.js`,
builtin provider bridges), Plugin SDK 0.6.132 typings, the owner's `~/.bb/bb.db`
(read-only), real Claude Code and Codex transcripts, OpenAI's pricing page, the
claude-api skill price table (cached 2026-11-03), and replies from the Answers,
Work Board, Idle Compact, Local models and Manager threads (2026-11-15).

## 1. Verified facts that shape the design

### 1.1 What bb records

- `thread/tokenUsage/updated` `{ providerThreadId, tokenUsage: { total, last,
  modelContextWindow, promptCacheTtlMs? } }`, breakdown `totalTokens,
  inputTokens, cachedInputTokens, cacheReadInputTokens?, cacheWriteInputTokens?,
  outputTokens, reasoningOutputTokens`. `total` is accumulated in the bridge's
  in-memory thread state (claude-code `createThreadState`/`translateResultMessage`
  start it at zero), so it restarts with the bridge and is not a durable
  session counter. `last` is one call (Codex) or one turn (Claude `result.usage`).
- No model on usage events. The model is on `client/turn/requested`
  `.execution.model` / `.serviceTier`, whose `turn_id` is NULL; the link to a
  turn is `turn/input/accepted { clientRequestId }` (has `turn_id`) matching the
  request's `requestId`. Steered and queued requests join the same way.
- Token semantics differ. Claude: `inputTokens` excludes cache,
  `cachedInputTokens = read + write`, `totalTokens = input + output + cached`.
  OpenAI/Codex: `inputTokens` includes cache reads and writes,
  `totalTokens = input + output`.
- bb prunes snapshot events (`thread/tokenUsage/updated`,
  `thread/contextWindowUsage/updated`, `turn/diff/updated`) to the latest per
  thread; on active threads pruning runs during ingestion at most every 30 s /
  250 sequences (`event-pruning.ts`). Owner's db, two weeks: claude-code 698
  usage events for 709 threads, codex 1615/1618. No ingest cadence guarantees
  that Tokenomos sees every snapshot.
- `experimental_thread.events` fires at most once a second per thread with
  `{ thread, sequence }`. `threads.events.list` takes `afterSeq`/`limit` as
  strings and `types: string[]`.
- Compaction: `thread/compacted` (has a turn reference, no token counts) and
  `contextCompaction` items. Context size: `contextWindowUsage.usedTokens`.
  A manual `threads.compact` runs as its own turn; an automatic provider
  compaction can happen inside an ordinary turn.
- Antigravity: no usage or context events in bb. thr_gmerajvzbr found that
  agy 1.5.9 stream-json `step_update.usage` (DONE) gives per-step tokens and
  added RPC `usage.list` to the antigravity plugin (§6.5, not yet deployed).
  local-models: `contextWindowUsage` only, plus RPC `usage.list` (§6.3).

### 1.2 What providers write on the server machine

- **Claude Code** — `~/.claude/projects/<cwd, non-alnum→"-">/<sessionId>.jsonl`,
  `sessionId == providerThreadId`. Assistant lines: `requestId`, `message.id`,
  `message.model`, `message.usage { input_tokens, output_tokens,
  cache_read_input_tokens, cache_creation_input_tokens, cache_creation {
  ephemeral_5m_input_tokens, ephemeral_1h_input_tokens }, speed }`,
  `timestamp`. Streamed chunks repeat one message (key `message.id+requestId`,
  last snapshot wins). Subagents: `<sessionId>/subagents/agent-*.jsonl` (the
  owner keeps provider subagents off, but support costs little).
- **Codex** — `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`. First line
  `session_meta { id, session_id (root session), parent_thread_id, source }`.
  Native children (guardian review, spawned agents) are separate rollout files
  whose `session_meta.session_id` is the root session (verified:
  guardian rollout `01a1d9b1…` → root `01a1d157…`, 5 billable records).
  `token_usage_record { response_id, turn_id, thread_id, session_id, usage {
  input_tokens (incl. cache), cached_input_tokens, cache_write_input_tokens,
  output_tokens, reasoning_output_tokens } }`; `turn_context { turn_id, model,
  service_tier }`. Archived sessions move to the flat
  `~/.codex/archived_sessions/` (verified: root `01a1d157…` lives there while
  its guardian child is still under `sessions/`); the index covers both and a
  cursor follows a moved file.
- **Local models** — RPC `usage.list` (§6.3), one entry per model request.

### 1.3 How the owner reads cost

Limits first (quota % per provider window, as in bb's usage settings), cost
second (owner, 2026-11-15). Open questions he asked: which model burns the
limit, cache-read vs fresh-input vs output share, effect of the 1M window,
day-over-day change, spend per finished Work Board task. So the page opens
with the current limit windows and what burned them, then money and tokens.

## 2. Scope

In: Claude Code and Codex exactly from transcripts on the server machine
(including Codex native children and Claude subagents); a bb-events fallback
for other providers and remote machines; local models; usage-limit windows
with per-model burn inside each window; compaction savings; local-model
savings; four chart ranges; Work Board and Answers RPCs; a thread context card
row in bb's chat; settings section; CLI `bb tokenomos`; «Вне bb» group behind
a setting.

Antigravity via its new `usage.list` (§6.5), the same consumer as local
models. Out (named, not built): transcripts on remote
machines; time-dependent prices (one current price per model); changing
long-context thresholds; budgets, alerts, forecasts; per-role spend;
before/after date views.

«Вне bb» (owner decision): sessions in `~/.claude/projects` and
`~/.codex/sessions` whose root session id matches no bb thread, changed within
`rollupRetentionDays`; scanned every 5 min by stat only, setting
`includeOutsideBb` (default off). Rows get `thread_id = ""`, `project_id =
"~outside"` and never enter thread, task or session totals.

## 3. Architecture

```
server.ts           factory: settings, db, sources, scheduler, rpc, cli, events (WP9 wires)
contract.ts         public + UI RPC schemas, internal types (WP1)
store/schema.ts     migrations (append-only)
store/write.ts      Store API: applyRows, deleteContribution, cursors (one tx per batch)
store/read.ts       series, breakdowns, totals, savings, limits join
store/prune.ts      retention, incremental_vacuum, disk stats
pricing/prices.ts   versioned built-in table (data)
pricing/price.ts    cost(tokens, model, tier, band, overrides) — pure
ingest/bb-events.ts thread events: turns, models, context, compactions, fallback rows
ingest/claude.ts    Claude transcripts (+ subagents)
ingest/codex.ts     Codex rollouts (+ native children), session index
ingest/ext.ts       local-models usage.list, idle-compact compactions.list
ingest/scheduler.ts dirty queue, 5 s flush, single flight, backfill
app.tsx             navPanel page, settings section
skills/tokenomos/   SKILL.md
```

Everything runs in the bb server process on the server machine; no host entry.

### 3.1 Internal contracts (WP1 owns them)

```ts
type UsageRow = { key: string; ts: number; threadId: string /* "" outside */;
  projectId: string /* "" unknown, "~outside", "~local-calls" */;
  provider: string; model: string /* "unknown" when unknown */;
  tier: string /* pricing tier after §3.3 normalisation */; tierRaw: string;
  promptTokens: number /* fresh+read+write */; band: number /* §3.7 BAND_EDGES index */;
  conv: string /* "" main conversation; subagent/native-child file id otherwise */;
  freshIn: number; cacheRead: number; cacheWriteShort: number; cacheWriteLong: number;
  output: number; reasoning: number /* informational, inside output */;
  turnId: string | null; source: SourceId; flags: number /* RECOVERED, BACKFILLED */ };
type SourceId = "claude-file" | "codex-file" | "local-log" | "agy-log" | "bb-events";
interface Store {
  applyRows(rows: UsageRow[]): ApplyResult;        // upsert by key, delta into rollups
  deleteContribution(threadId: string, source: SourceId): void; // only while raw retained
  getCursor<T>(name: string): T | null; setCursor(name: string, v: unknown): void;
  noteThread(dto: ThreadDtoLike): void; noteContext(...); noteCompaction(...);
}
interface Source { id: string; flush(ctx: FlushCtx): Promise<void> }
```

Sources only produce rows and cursor updates; the store owns transactions,
rollups, compaction interval effects (§3.6) and versioning.

### 3.2 Source of truth per thread (no double counting)

`thread_source(thread_id PK, source, since_ts, state: ok|degraded)`:

| Thread | Source |
|---|---|
| `claude-code`, transcript found locally | `claude-file` |
| `codex`, root rollout found locally | `codex-file` (root + all native children) |
| `local-models` | `local-log` |
| `antigravity` (when its `usage.list` answers) | `agy-log` |
| anything else, or no file 10 min after the first usage event | `bb-events` |

bb events are always ingested (turns, models, context, compactions, coverage),
but produce usage rows only for `bb-events` threads and for degraded intervals.

- Late file after a fallback: switch to the file source and
  `deleteContribution(thread, "bb-events")` only if all of that thread's
  bb-events rows are still in `usage_raw`; otherwise keep `bb-events` (status
  note). Never replays expired data.
- Degraded file source, exclusive by time interval: `source_interval(thread_id,
  from_ts, source)` says which source owns each interval of a thread; a row is
  accepted only from the owner of its `ts`, so file and fallback rows never
  overlap. A turn is *uncovered* when bb reported usage for it (`last.totalTokens
  > 0`) and the file source produced zero main-conversation rows inside
  `[turn/started, turn/completed + 2 min]`. Three consecutive uncovered turns
  open a `bb-events` interval at the first one's `turn/started` (its bb rows are
  kept as candidates in `bb_candidate` from the start, so they can be applied
  then; flag RECOVERED, thread `partial`, status warning). Opening is the only
  retroactive move: in one transaction the store subtracts the file rows
  already applied inside the new interval (from `usage_raw`; only allowed while
  they are retained, else the interval opens at the decision time) and applies
  the candidates. Closing is never retroactive: when a later turn is covered
  by file rows, the bb interval ends at that moment (`now`), and file rows with
  earlier `ts` stay skipped, so every call is counted by exactly one source.
  A turn with some file rows is covered (no fallback), so partial parsing
  undercounts but never double counts; unparsed-line counters show it in
  status. Test: degraded interval, bb row applied, transcript of the same turn
  appears later → counted once.

### 3.3 Normalisation and keys

- Claude: `freshIn = input_tokens`, `cacheRead = cache_read_input_tokens`,
  `cacheWriteShort = ephemeral_5m`, `cacheWriteLong = ephemeral_1h` (no split
  → all short), `tierRaw = usage.speed`.
- OpenAI/Codex: `cacheRead = cached_input_tokens`, `cacheWriteShort =
  cache_write_input_tokens` (30 min is the default lifetime; rollouts carry no
  lifetime split, so 12 h writes are priced short and flagged estimated when
  nonzero), `freshIn = input − cacheRead − cacheWriteShort`, `tierRaw =
  service_tier`.
- bb events (fallback): semantics chosen by `totalTokens == input + output`
  (OpenAI) vs `== input + output + cached` (Claude); anything else → Claude
  semantics, flag estimated.
- Tier normalisation (`tier` is what prices use, `tierRaw` is kept): null,
  "", "default", "standard", "auto" → `standard`; "fast", "priority" → `fast`;
  "flex" → `flex`; "batch" → `batch`; "ultrafast" → `ultrafast`; anything else
  → kept as is and unpriced (partial). bb `execution.serviceTier` uses the same
  map. Tests use real payloads (`serviceTier: "default"`, Claude `speed:
  "standard"`, Codex `service_tier: null`).
- Local: `freshIn = promptTokens − cachedTokens`, `cacheRead = cachedTokens`,
  `output = completionTokens`.
- `promptTokens = freshIn + cacheRead + cacheWriteShort + cacheWriteLong`.
- Keys: `cc:<message.id>:<requestId>`, `cx:<response_id>`,
  `bb:<threadId>:<eventId>`, `bbr:<threadId>:<turnId>` (recovered), `lm:<id>`.
- Fork ownership: a thread with `source_thread_id` (a fork) ignores file lines
  with `ts < thread.created_at` (no tolerance; the copied history all predates
  the fork). Backfill processes threads in `created_at` order so parents own
  their keys; a key already owned by another thread is never re-attributed.

### 3.4 bb-events fallback rows

Rows come from `last` of each event seen (key `bb:<thread>:<eventId>`), model
and tier from the event's turn (§1.1 join; unknown → thread's last known turn
model, flag estimated). Gap recovery per counter, scoped like the provider's own
accumulator: `(thread, providerThreadId)` for claude-code and unknown
providers (the Claude bridge keeps one `cumulativeTokens` per thread that
nested results also add to), `(thread, providerThreadId, parentToolCallId ??
"")` for codex (verified separate child counters, as in Burn): keep `prevTotal`; on an event, `gap = total −
prevTotal − last`; if `prevTotal` exists, `total ≥ prevTotal` and `gap > 0`,
add a RECOVERED row of `gap` (missed/pruned events); if `total < prevTotal`
(bridge restarted), add `max(0, total − last)` as RECOVERED. A restart whose new
total already exceeds the old one is undetectable; RECOVERED rows mark the
thread `partial`, never exact. Backfill of a `bb-events` thread: its surviving
snapshot's `total` becomes one BACKFILLED row at the event time.

### 3.5 Storage, rollups, retention

Plugin db (`bb.storage.database()`), WAL, incremental auto_vacuum. Missing
dimensions are stored as `""`, never NULL, so composite primary keys hold.

- `usage_raw` — UsageRow columns, PK `key`; retained `rawRetentionDays`
  (setting 7–60, default 30).
- `usage_hourly(hour, provider, model, tier, band, project_id, thread_id,
  calls, fresh_in, cache_read, cache_write_short, cache_write_long, output,
  reasoning)`, PK over the seven dimensions; retained `rollupRetentionDays`
  (184–400, default 200, so the 3-month delta has a full previous period).
Serves all four ranges and the limit windows. KPI deltas show «нет данных за
прошлый период» when the previous period is not fully covered.
- `thread_tokens(thread_id, provider, model, tier, band, … tokens, calls, first_ts,
  last_ts)` PK `(thread_id, provider, model, tier, band)`, all-time (provider so local
  calls inside a cloud thread price as 0), plus
  `thread_cov(thread_id PK, complete INTEGER, partial INTEGER)`: `complete`
  when a file source was read from the start.
- `threads(id PK, project_id, provider_id, parent_id, lifecycle_owner_id,
  source_thread_id, title, created_at, archived_at, deleted_at)`.
- `provider_session(provider_thread_id PK, thread_id)` from `thread/identity`.
- `turns(thread_id, turn_id, started_at, completed_at, model, tier,
  compaction_only)`, PK `(thread_id, turn_id)`; `requests(request_id PK,
  thread_id, model, tier, at)` until joined (24 h).
- `context_last(thread_id PK, used_tokens, at)`.
- `compactions(id PK, thread_id, turn_id, at, before_tokens, after_tokens,
  model, ttl_ms, origin, own_cost_known)`, `compaction_effect(compaction_id,
  model, tier, band, calls_hit, calls_miss, calls_cross, first_gap_hit,
  overhead_* tokens)` PK `(compaction_id, model, tier, band)` (§3.6).
- `file_cursor(path PK, inode, size, mtime, offset, head_hash, watermark_ts,
  thread_id, root_session)`; `codex_index(rollout_path PK, id, root_session,
  parent_id, started_at)`; `ext_cursor(source PK, cursor)`; `ext_pending`
  (unresolved local entries, 24 h).

Writes: one transaction per batch. `applyRows` upserts by key; for an existing
key it applies only the component deltas (last snapshot wins), so hourly and
thread totals change exactly once per real increase.

Replay protection without unbounded keys: each file cursor keeps
`watermark_ts`, the newest `ts` ingested from that file. A line with `ts >
watermark_ts` is new and inserted; a line with `ts ≤ watermark_ts` may only
update a key that is still in `usage_raw` (a later streamed snapshot of a
recent message) and is otherwise skipped, never inserted. This holds for every
read, so on rewrite detection (size shrinks, inode changes, first-4-KiB hash
changes) the file is simply re-read from the start: nothing at or before the
watermark can be added again, however old the file or the watermark is. Test:
dormant file, raw rows pruned, file rewritten → zero new rows; normal append
with repeated chunks of the last message → one row with the last usage. Codex native-child files and Claude
subagent files have their own cursors.

Prune: daily schedule and a settings button: delete expired raw and hourly
rows, `requests` and `ext_pending` past 24 h, then `PRAGMA
incremental_vacuum`. `thread_tokens`, `compactions`, `compaction_effect`,
`threads` are small and kept.

### 3.6 Compaction savings (estimate, tokens stored, priced at read)

At ingest, each `thread/compacted` event is its own compaction C (id = event
id; a turn can hold several, e.g. thr_wr7z5gy6db turn da3d91030d-t9 has two,
18 min apart). `before` = the last `context_last` before C's event sequence
(and after the previous compaction of T), `after` = the first snapshot after
C; skip if either is missing; `Δ = before − after`. While C is T's latest
compaction, every new main-conversation (`conv = ""`) usage row of T updates
`compaction_effect(C, model, tier, band)`: `calls_hit` when the previous main
call of T used the same model and the gap ≤ TTL (`promptCacheTtlMs` of the
latest usage event, else 1 h Claude / 30 min OpenAI), else `calls_miss` (a
model switch is a miss: caches are model-scoped); the first such call sets
`first_gap_hit`. Subagent and native-child rows count in totals but never in
compaction effects. Overhead: rows inside C's turn and before the first call
after C count as `overhead_*` only when the turn is compaction-only — its
accepted request input is the standalone builtin `/compact` command (manual
`threads.compact` dispatches exactly that; WP4 builds the fixture from the
real `/compact` turns thr_wr7z5gy6db daa6b08a7b-t1 and thr_2sivhbkntb
da416ee912-t1) and at least one usage row of that turn lies between its
`turn/started` and C. Otherwise, including manual compactions whose summary
call leaves no usage row (the daa6b08a7b-t1 transcript has a
`compact_boundary` 257,112 → 16,287 but no usage-bearing row in the turn),
`own_cost_known = 0`.

Read-time estimate, priced with current prices and per model:
`gross = Δ × (calls_hit × read + calls_miss × writeLong)` with rates of each
effect row's model, tier and band. A call whose counterfactual prompt
(`promptTokens + Δ`) falls in a different band is counted in `calls_cross`
instead and left out of the money estimate (its whole request would be priced
at another rate); tokens saved still include it, and the money figure is
marked «частично» when `calls_cross > 0`;
`rewrite = first_gap_hit ? after × (writeLong − read) : 0` (the summary prefix
must be written once where the old prefix would have been read);
`net = gross − rewrite − overhead` (negative values are shown, not clamped).
When `own_cost_known = 0`, show `net` labelled «без учёта стоимости самой
компакции». Counterfactual assumptions in a tooltip: same calls and models,
context grows identically, no extra forced compaction. Idle Compact entries
(`compactions.list`) match C by thread and `at` ±2 min → `origin =
idle-compact`. The estimate is the same before and after raw retention expires
(test).

### 3.7 Pricing

- Tokens stored; cost computed at read:
  `Σ component × rate(model, tier, band)`.
- `prices.ts`: `PRICE_TABLE_VERSION = "2026-11-15"`, entries in $/MTok
  `{ input, output, cacheRead, cacheWriteShort, cacheWriteLong, longContext?:
  { aboveTokens, input, output, cacheRead, cacheWriteShort, cacheWriteLong },
  tiers?: { [tier]: { multiplier } | rates }, source, verified }`.
- Anthropic (claude-api skill table): Opus 5.5 4/20 read 0.20; Opus 5, 4.8,
  4.7, 4.6 5/25 read 0.50; Fable 5.2 8/40 read 0.20; Fable 5.1 10/50 read 0.25;
  Fable 5 10/50 read 1.00; Sonnet 5.5 2/10 read 0.10; Sonnet 5 2/10 read 0.20;
  Sonnet 4.6 3/15 read 0.30; Haiku 5.5 0.10/0.50 read 0.01, above 100K prompt
  0.50/2.50 read 0.05; Haiku 4.5 1/5 read 0.10. Writes: short (5 min) 1.25 ×
  input, long (1 h) 2 × input of the same band. Fast tier: Opus 5.5 ×2, Fable
  5.2 ×2, Opus 5 and Opus 4.8 ×2 (research preview).
- OpenAI (developers.openai.com/api/docs/pricing, fetched 2026-11-15):

  | Model | in | read | write 30m | write 12h | out | >272K in/read/w30/w12/out |
  |---|---|---|---|---|---|---|
  | gpt-6.1-sol | 2 | 0.10 | 2.50 | 5 | 10 | 4/0.20/5/10/15 |
  | gpt-6-astra | 10 | 1 | 12.50 | 25 | 50 | 20/2/25/50/75 |
  | gpt-6.1-terra | 1 | 0.05 | 1.25 | 2.50 | 5 | 2/0.10/2.50/5/7.50 |
  | gpt-6-sol | 2 | 0.20 | 2.50 | 5 | 10 | 4/0.40/5/10/15 |
  | gpt-6-luna | 0.10 | 0.01 | 0.125 | 0.25 | 0.50 | 0.20/0.02/0.25/0.50/0.75 |
  | gpt-5.6-sol | 4 | 0.40 | 5 | 10 | 20 | 8/0.80/10/20/30 |
  | gpt-5.6-terra | 2 | 0.20 | 2.50 | 5 | 12 | 4/0.40/5/10/18 |
  | gpt-5.6-luna | 0.20 | 0.02 | 0.25 | 0.50 | 1.20 | 0.40/0.04/0.50/1/1.80 |

  Tiers: fast ×2 (all eight), flex/batch ×0.5, ultrafast ×6 (astra, 6.1-sol).
- Gemini (unverified, sources disagree; "~" always; owner can override):
  gemini-4-argon 2/10 read 0.10 (AI Studio page, until 2026-11-30, then
  4/20 read 0.20 — v1 keeps one price, the owner updates it), gemini-4-hydrogen
  1.50/7.50, gemini-3.8-flash 0.75/3.75; writes not priced (implicit caching
  only). `gemini-pro-orchestrator-g1-pro` → Argon prices.
- Unknown model or unknown tier → cost `null`, totals `partial`.
- Prompt-size bands: `BAND_EDGES = [100_000, 272_000]` (Haiku 5.5, OpenAI
  long context), built in and immutable; each row stores `band` = number of
  edges below its `promptTokens` (0, 1, 2). A model's long-context rate applies
  when `band > BAND_EDGES.indexOf(model threshold)` (tests: prompt below, equal
  to and above each edge; "above N" means strictly greater). Every model's threshold must be an
  edge (test), so any model, including a newly chosen reference model, prices
  history correctly. Adding an edge later is a migration that only affects new
  rows. Overrides (setting `priceOverrides`, multiline
  JSON validated by zod, edited from the settings table) change rates only and
  apply to all history at once. Money is always labelled «API-эквивалент»; "~"
  when anything in it is estimated, recovered or unverified.

### 3.8 Local-model savings

Local rows cost 0. Savings = the same components priced at the reference model
(setting `referenceModel`, default `claude-sonnet-5-5`), at read time; own tile
and a column in the provider breakdown, labelled «~ vs <model>». Because every
row keeps its prompt-size `band` (§3.7), any reference model whose thresholds
are in `BAND_EDGES` reprices all retained history correctly; the picker lists
only such models.

### 3.9 Usage limits

`limits` RPC: `bb.sdk.system.usageLimits()` cached 60 s on the server (one call
per minute at most, only while the page or CLI asks; no background polling).
For each window with a known length (five-hour, daily, weekly), start =
`resetsAt − length`; Tokenomos joins `usage_hourly` for that provider since the
window start (hour granularity, the partial first hour included pro rata is not
attempted: labelled «с <hour>») and returns tokens and API-equivalent cost by
model. A window with `model` set (Claude's per-model weekly windows) joins
only models whose id contains that family name case-insensitively; if none
matches or the scope is not understood, and for custom windows, only the
percentage and reset are shown, with no model breakdown.

### 3.10 Thread trees and totals

Edges `parent_id` and `lifecycle_owner_id` from our `threads` copy (refreshed
from DTOs in events, `thread.created`, `experimental_thread.parentChanged`, and
a reconcile with `bb.sdk.threads.list` on start). `total(T)` = own(T) + own of
every distinct descendant over both edges (recursive CTE with `UNION`, depth ≤
32). No server memo in v1: the WP6 perf test must show `costs.threads` for 200
ids with descendants < 100 ms on the fixture; add caching only if it fails.
Clients use one shared tag `usage` for every read, so a child's new usage or a
reparent refreshes every reader of the parent (≤ once per 5 s).

## 4. Ingest pipeline and performance

- Triggers: `experimental_thread.events` marks the thread dirty; `thread.idle`
  marks dirty; the scheduler flushes up to 50 dirty threads every 5 s, single
  flight. Per thread: `threads.events.list({ threadId, afterSeq: String(cursor),
  limit: "100", order: "asc", types: [tokenUsage, contextWindowUsage,
  thread/compacted, client/turn/requested, turn/input/accepted, turn/started,
  turn/completed, thread/identity] })`, paged. `item/completed` is NOT read:
  it is the noisiest type (1946 of 8389 events in the owner's last hour, more
  than all eight types above together, 1221); compactions come from
  `thread/compacted`, and a compaction-only turn is recognised from its
  accepted request (§3.6).
- Load: measured on the owner's db, last hour: 29 active threads, 8389
  events, 1221 of the types above (~42 per thread per hour). With the 5 s
  flush, 10 busy threads cost at most 2 small indexed reads per second, mostly
  returning 0–3 rows; idle threads cost nothing. File sources read only the
  bytes appended since the last flush.
- Files: for claude/codex threads, `stat` the session file(s) (Claude
  `subagents/`, Codex children from `codex_index`); read appended bytes only;
  hold back an incomplete last line.
- Locating: Claude by the encoded environment path, else a `sessionId → path`
  index from one scan of `projects/*`, rebuilt at most every 60 s on a miss.
  Codex: `codex_index` built by reading the first line of every rollout once,
  then incrementally for date folders whose mtime changed (stat only).
- Backfill (first start, reinstall, resumable): enumerate all bb threads
  (archived included) in `created_at` order; file sources read whole files
  (exact timestamps, lifetime `thread_tokens`, `complete = 1`), and hourly rows
  are written only for `ts` within `rollupRetentionDays`; bb-events threads per
  §3.4. Runs in the background service, yields between threads.
- External: `usage.list` and `compactions.list` every 60 s and on
  `thread.idle` of a local-models thread; `unknown_method`/`not_found` → back
  off to 15 min, status «нет данных».
- Freshness: after a batch that changed rows, `bb.rpc.experimental_invalidate
  (["usage"])` at most once per 5 s. Settings changes that affect reads
  (overrides, reference model, outside-bb) invalidate too. UI uses live RPC
  hooks (stale-while-revalidate built in); skeletons only on first load.
- Read side: every UI RPC is one indexed aggregate; budget < 50 ms for
  summary on a synthetic 120-day, 200k-raw-row fixture.

## 5. UI (bb host components, Russian strings)

Load the `dataviz` skill before building charts. bb registry components
(`npx shadcn add @bb/chart @bb/table @bb/tabs @bb/skeleton @bb/tooltip`), host
token classes only, series colors `--chart-1..5` in fixed order: Claude Code
1, Codex 2, Local models 3, Antigravity 4, other 5; by model: top 4 + «Другие».
Check light and dark in a local headless browser.

### 5.1 Page (`navPanel`, path `tokenomos`, title «Tokenomos»)

1. «Лимиты»: one row per provider window — % used (bb's numbers), reset time,
   and «в этом окне» the top models by tokens and ~$ with the cache-read share.
2. Range tabs «День · Неделя · Месяц · 3 месяца» (only these) and a «По
   провайдерам / По моделям» toggle; range in the URL subPath.
3. KPI tiles: «Расход (API-эквивалент)» with delta vs the previous equal
   period; «Токены» with the cache-read share; «Компакция ~»; «Локальные модели
   ~».
4. Stacked bars: day 24 × 1 h, week 7 × 1 d, month 30 × 1 d, 3 months 13 × 1 w;
   per-segment tooltip, legend, table view toggle.
5. Breakdown table by provider/model: fresh, cache read, cache write, output,
   calls, ~$.
6. Top threads (50 per page, «Ещё» loads the next page; no virtualisation
   needed at that size): title, project, provider, own ~$,
   with sub-threads ~$, opens the thread.
7. Compactions in range: thread, when, before → after, origin, ~net.

### 5.2 Deferred: thread context card row in bb's own chat

Not in v1: session cost in chat comes through Answers (agreed). Adding a
`experimental_threadContextCardRow` later reuses `costs.threads` as is.

### 5.3 Settings

Declarative: `rawRetentionDays`, `rollupRetentionDays`, `referenceModel`,
`includeOutsideBb`, `priceOverrides`. `settingsSection`: per-source status
(last ingest, rows, last error, degraded threads), disk use and row counts,
«Очистить старые данные», price table with editable override cells.

## 6. Public contracts

### 6.1 For Answers and Work Board (`contract.ts`, stable)

```ts
Cost = { usd: number | null, tokens: { freshIn, cacheRead, cacheWrite, output },
         estimated: boolean, partial: boolean }
costs.threads  { threadIds: string[1..200], includeDescendants: boolean }
  → { priceVersion, threads: Array<{ threadId, own: Cost, total: Cost,
       descendantCount, updatedAt }> }        tags: ["usage"]
costs.sum      { threadIds: string[1..200], includeDescendants: boolean }
  → { priceVersion, cost: Cost, threadCount, updatedAt }   tags: ["usage"]
```

Unknown ids skipped → `partial`; archived/deleted ids count from our copy;
`costs.sum` dedupes. Any caller. < 100 ms. Answers: chat header only, pull on
turn end ≤ 1 per 10 s. Work Board: `costs.sum`, includeDescendants, ~3 s
timeout, hide on error.

### 6.2 Consumed: Idle Compact (agreed, 0.2.0)

`compactions.list { since?, after?, limit? }` → `{ items: [{ id, threadId, at,
trigger, usedTokensBefore, contextWindow }], nextCursor? }`. `id` is opaque,
unique, stable and sorts in log order: use it as the `after` cursor and for
dedupe. An entry that resolves across an Idle Compact reload can land behind
the cursor, so once an hour Tokenomos also re-reads `since = now − 2 h` and
dedupes on `id`. Entries are deleted after 30 days.

### 6.3 Consumed: Local models (live in 0.1.0)

`usage.list { after?, limit? ≤ 1000 } | null` → `{ entries: [{ id, ts, source:
thread|tool|cli, threadId|null, providerThreadId|null, model, engine,
promptTokens (incl. cached), cachedTokens, completionTokens (incl. reasoning),
reasoningTokens|null, durationMs, ttftMs|null }], nextCursor|null }`. Page until
`nextCursor` is null, keep the last non-null one; dedupe on `id`. `thread`
entries resolve `providerThreadId` via `provider_session`; unresolved wait in
`ext_pending` 24 h, then go to «Локальные вызовы». `tool`/`cli` entries count
to the calling thread.

### 6.5 Consumed: Antigravity (built in thr_gmerajvzbr's worktree, deploy pending)

Plugin `antigravity`, RPC `usage.list`, same paging and cursor rules as §6.3.
`Entry = { id ("<ACP session>:<native conversation>:<step>"), ts, source:
"thread", threadId|null, providerThreadId|null, model, promptTokens (input +
cache read), cachedTokens, completionTokens (output incl. thinking),
reasoningTokens|null, durationMs|null }`. Normalise like local entries; key
`ag:<id>`; `providerThreadId` resolves via `provider_session`. Priced with the
Gemini entries (unverified, "~"), not as savings. Absent method → no data.

### 6.4 CLI `bb tokenomos`

Minimal: `status [--json]` (sources, rows, disk, degraded threads) and
`summary [--range day|week|month|3m] [--json]` (totals by provider and model),
both thin wrappers over existing RPC handlers. Bounded output; documented in
`skills/tokenomos/SKILL.md`.

## 7. Work packages

All under `plugins/tokenomos`; vitest + `@get-bb/plugin-sdk/testing`; English
comments, Russian UI strings. Every WP: `npm run typecheck`, `npm test` green;
no files outside the WP's list.

| WP | Files | Content | Depends | Executor |
|---|---|---|---|---|
| 1 | package.json, tsconfig, vitest config, contract.ts, store/schema.ts, store/write.ts, store/prune.ts | scaffold (SDK 0.6.132 exact like work-board), all schemas and internal types (§3.1, §6), migrations, Store with delta upserts, cursors, prune | — | Sonnet 5.5 |
| 2 | pricing/* | table §3.7 + pure `cost()`, tests | 1 | local Qwen3.6 |
| 3 | ingest/claude.ts, ingest/codex.ts | file sources, indexes, cursors + watermark, children/subagents, fork rule, normalisation; fixtures from trimmed real lines | 1 | Codex GPT-6.1 Terra |
| 4 | ingest/bb-events.ts | event paging, request→turn join, context, compactions + effects, fallback rows + gap recovery, coverage/degraded logic | 1 | Codex GPT-6.1 Sol |
| 5 | ingest/ext.ts | local-models and antigravity usage.list (one generic consumer), compactions.list, ext_pending | 1 | local Qwen3.6 |
| 6 | store/read.ts, rpc handlers in rpc.ts, cli.ts | series, breakdowns, totals + descendants, savings, limits join, memo, perf fixture | 1, 2 | Codex GPT-6.1 Sol |
| 7 | app.tsx, components/* | page, settings section | 6 | Sonnet 5.5 |
| 8 | ingest/scheduler.ts, server.ts | wiring: dirty queue, flush, source selection §3.2, backfill, settings onChange, invalidation, dispose; end-to-end test | 3, 4, 5, 6 | Codex GPT-6.1 Sol |
| 9 | .github/workflows/tokenomos.yml, .bb/plugins.json, root README row, README.md, skills/tokenomos/SKILL.md | CI and docs | 7, 8 | Haiku 5.5 |

Key acceptance checks:
- WP1: migrations idempotent; same key twice → rollups once; bigger snapshot →
  only the delta; NULL-free projectless/threadless bucket upserted twice stays
  one row; prune keeps in-window rows and runs incremental_vacuum.
- WP2: hand-computed cases: Opus 5.5 short/long writes; Haiku 5.5 above 100K
  incl. writes; gpt-6.1-sol >272K; fast and ultrafast tiers; unknown tier →
  null + partial; overrides replace rates only.
- WP3: duplicate chunks counted once with the last usage; partial last line
  held; rewrite → replay adds nothing (also after raw pruning); Codex guardian
  child attributed to the root bb thread; nonzero `cache_write_input_tokens`
  not double counted; fork processed before its parent does not take the
  parent's last paid call.
- WP4: request→turn join with steer and queued requests and a model switch;
  gap recovery (missed events, restart); Claude shared counter totals 100, 180,
  300 with last 100, 80, 120 → 300; Codex per-parentToolCallId counters with
  the interleaving parent 100, child 80, parent 220 → 300; degraded transition and
  recovery; compaction before/after and effects incl. cache-expiry gaps.
- WP5: unknown_method → back-off, no rows; cursor rules; ext_pending resolves
  when `thread/identity` arrives later.
- WP6: costs RPC schemas; descendants over both edges with a cycle; unknown
  ids → partial; savings identical before/after raw expiry; limits join with a
  weekly window; summary < 50 ms on the fixture.
- WP7: harness `renderSlot`; skeleton only on first load; bucket counts
  24/7/30/13; the page's reads refresh after a child-only usage change
  (shared tag); light/dark checked in a headless browser.
- WP8: end-to-end with the harness: fake bb events + temp transcript dirs →
  rows → `costs.sum`; plugin reload resumes cursors without double counting;
  source switch late file; settings change invalidates.

## 8. Rollout

1. Re-review this plan with Codex until no material findings.
2. Dispatch WPs (local-model WPs one at a time under a Machine Slots
   `local-model` lease); I review each diff and run the checks.
3. Deploy locally (`releases/tokenomos-0.1.0/`, `bb plugin install path:…
   --yes`), cross-check one Claude and one Codex thread against hand sums from
   their transcripts.
4. Codex review of the result until it converges; report to the owner; send the
   contract path to Answers and Work Board.

## 9. Risks

- bb event shapes and provider transcript formats are not public contracts:
  zod `safeParse`, unknown → skip + status counter; degraded-source fallback
  (§3.2) keeps totals approximately right and visible as partial.
- Fallback totals can miss usage after an undetectable bridge restart;
  always marked partial.
- Compaction savings rest on a stated counterfactual; shown with "~" and its
  assumptions.

## 10. Early overspend warnings (owner-approved 2026-11-15, revision 2 after review thr_cmq7rpi3es)

Source: Manager's ANV-781 investigation (thr_ukkbq8m5iq): Sonnet sessions ×2.5/week (main driver), cache reads of large contexts 57–73% of units, wakes after >1 h idle 6.6% (44 of 56 daily misses were messages from other threads), no-work notification turns 5.8% (fixed by the owner), Codex xhigh share 13%→35%.
Live check (last 24 h): latest-call context ≥ 300k in 23 threads carrying 51% of all cache reads; ≥ 400k in 9 threads (35%); 200k flags 47 threads (noise).
Constraint: plugin agent instructions apply only when a provider session is constructed and changing them busts the prompt cache, so they cannot carry live hints.

### 10.0 Shared "current context" of a thread
`currentContext(threadId)` = the newest of:
- the latest eligible call: a `usage_raw` row of that thread with `conv = ""`, `provider` = the thread's own provider, no RECOVERED/BACKFILLED flag (individual calls only); context = its `promptTokens`, model/tier/band from the row; write kind = long or short only when the row carries an explicit duration split (new `usage_raw.write_split` flag, set by the Claude reader when `cache_creation.ephemeral_*` is present; unsplit Claude totals and all bb-event/OpenAI writes leave it 0) and only one kind is non-zero; otherwise unknown (TTL assumed, cold cost priced at the long rate and labelled an estimate);
- a newer `context_last` snapshot or a newer compaction with `after_known = 1` (context = its used/after tokens), which overrides an older call; a newer compaction with unknown after makes the context unknown;
- a newer `thread/context/cleared` boundary (ingested and persisted per thread) makes every earlier call/snapshot ineligible.
Hypothetical wake/read costs use `bandOf(contextTokens)` of the chosen context; historical sums keep each row's own band.
Returns `null` when nothing eligible is retained (reported as "unknown", distinct from `not_found` for an unknown thread). All money uses `costUsd`/`ratesFor` (tier, band, overrides, /1e6).

### 10.1 Watchlist (page + RPC)
- Setting `contextWatchTokens` (number 50k–1M, default 300000).
- RPC `watchlist {}`: candidate threads = distinct thread_ids with an eligible call in the last 60 min (one ts-bounded indexed query), then `currentContext` for each candidate (bounded: at most 200 candidates, newest first); keep context ≥ threshold. Item: `{ threadId, title, provider, model, contextTokens, callsLastHour, readCostPerCallUsd | null (context × cache-read rate), costLastHourUsd | null (sum of actual row costs in the hour), lastCallAt }`, sorted by costLastHourUsd desc, max 20. Server memo 30 s.
- Freshness: the scheduler invalidates `usage` at most every 5 min while the last watchlist result was non-empty, so items age out without client polling.
- Page: collapsible "Watchlist" section under the range tabs, hidden when empty.
- Agent notification thresholds (owner, 2026-11-15): 400k, then again at 600k; delivery method pending owner decision (ans_53555bbd), not in this package.

### 10.2 Wake cost (CLI + RPC + skill rule)
- RPC `wakeCost { threadId }`, CLI `bb tokenomos wake-cost <threadId> [--json]` → `{ threadId, provider, model, contextTokens | null, lastCallAt | null, idleMinutes | null, ttlMinutes, ttlSource: "observed" | "assumed", cacheLikelyExpired: boolean | null, coldCostUsd | null, warmCostUsd | null }`.
- TTL: observed when the last eligible Claude call wrote a single cache kind (long → 60, short → 5), or when a bb `promptCacheTtlMs` was persisted with its event time and provider session id and both match the selected call (same session, event at or after the call); else assumed (Claude 60, OpenAI 30); rows without a provider-session id fail closed to assumed; `cacheLikelyExpired` only when idle > TTL, labelled an estimate when assumed.
- `coldCostUsd`: Claude = context × the write rate of the observed kind (long if unknown); OpenAI = context × fresh-input rate (OpenAI bills cold prompt tokens as input). `warmCostUsd` = context × cache-read rate.
- Skill rule (skills/tokenomos/SKILL.md): before sending work to a thread idle longer than its TTL, run `wake-cost`; if `cacheLikelyExpired` and `coldCostUsd` > $0.50, prefer a fresh child thread. The integrator sends the rule to the Manager thread (other projects' instructions are not edited by Tokenomos).

### 10.3 Growth anomaly (daily, passive only) — DEFERRED by the owner (2026-11-15): ships separately after 10.0–10.2
- Setting: `growthAlertRatio` (1.1–10, default 1.5). No messages to threads: any `threads.send` can start a paid turn (SDK: a send to an idle thread is `start-turn`), so the result is shown on the page and in `status` only. The Manager or owner reads it there (or via `bb tokenomos status`).
- Report day = the last complete local day. `growth_report(day PK, state: pending|computed|expired, payload, updated_at)`; the daily schedule (07:30) and the scheduler (after each batch) process pending days of the last 48 h; older pending days expire.
- Exact daily table: `daily_exact(day, provider, model_key, calls, fresh_tokens)` PK over the first three, updated inside `applyRows` (and `deleteContribution`) only for rows from per-call sources (`claude-file`, `codex-file`, `local-log`, `agy-log`) without RECOVERED/BACKFILLED flags; kept for rollup retention. When the table is introduced it is initialised in the same migration from retained `usage_raw` rows under the same filter, and `daily_exact_since` (the first local day fully inside raw retention at that moment, or the first complete day after a fresh install) is stored; reports require all 8 days ≥ `daily_exact_since`. bb-events rows (fallback, recovered or backfilled aggregates) never enter it, so the anomaly metric cannot see a multi-day gap lumped into one hour.
- Reports are evaluated only by the daily schedule and by the scheduler at the end of a pass when no flush is in flight.
- Completeness gate for a report day: the metadata/backfill cursor is done; after this plugin load the tail pass (paged `threads.list` comparing each DTO's `updatedAt` with `bb_cursor.flushed_at`, marking newer threads dirty and adding them to an in-memory `catchUp` set) has completed and `catchUp` is empty — a thread leaves `catchUp` after one complete flush (missing-transcript discovery retries do not re-add it); no thread whose selected source is a file source is in the continuing set (file discovery retries for missing transcripts do not block); for every plain file with mtime ≥ report-day start, no complete (newline-terminated) record lies after its cursor (a trailing fragment without a newline does not block; it is reported as incomplete coverage in status) and every `.zst` file has its `file-zstd-complete:<path>` marker; `ext_pending` holds no entry with `ts` ≤ report-day end; every available external source has a durable `caughtUpAt` later than the report-day end; no file or external source is `degraded`/`error` (`unavailable` ignored); all 8 days are after the first complete local day since install. Otherwise the day stays pending.
- Metric per (provider, `resolveModel(model) ?? lower-cased raw model id`): calls and fresh tokens (freshIn + cacheWrite + output) of the report day vs the median of the 7 previous days. A metric flags when ratio ≥ growthAlertRatio AND its own gate holds (calls ≥ 200; fresh ≥ 1M). All 7 baseline days zero → "new model" under the same gate; a zero median with some prior activity is reported as "irregular use" without a ratio. Daily totals come from `daily_exact` only. Payload keeps the top 3 threads by fresh tokens.

### 10.4 Out of scope (named)
Window pace vs quota (owner removed limits), Codex reasoning-effort share (effort not stored yet), per-task Opus-vs-Sonnet efficiency and review rounds (no role/round data).
