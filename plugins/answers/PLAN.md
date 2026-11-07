# Answers plugin — implementation plan

Status: draft v4 (2026-11-07), revised after Codex review rounds 1–3
(@thread:thr_ttjazdccwy). Owner: Dmitriy. Design/review: Claude. Implementation: Codex.

## Problem

The user asks questions in busy threads (e.g. the Manager thread). Other agents keep
messaging that thread (`bb thread tell`), so the reply to the user's question is
buried under dozens of agent/system turns. Measured on the Manager thread: of ~14.5k
`client/turn/requested` events, 976 were `initiator: "user"`, 4,696 `"agent"`,
8,873 `"system"` — about one user turn in fifteen.

Work Board already covers blocking decisions (agent → user). Answers covers:

1. **My questions** (`mine`) — every user-initiated message in any thread, paired with
   the reply it got, including replies that arrive turns later.
2. **For me** (`for_me`) — small, non-blocking questions an agent wants the user to
   see. Blocking ones stay in Work Board.
3. **Saved** (`saved`) — any chat message or selected text the user pins manually.

## Non-goals (v1)

- No LLM summarization or classification. Pairing is deterministic.
- No Work Board integration, no push notifications, no editing of stored text.

## SDK facts (verified against SDK 0.6.132 `bundled-types/bb-plugin-sdk.d.ts`, bb 0.49.0)

Line numbers refer to
`/Users/shaatla/bb-plugins/releases/slots-0.3.1/node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts`.

- `bb.sdk.threads.events.list({ threadId, afterSeq?, beforeSeq?, limit?, order?, types?, signal? })`
  → `ThreadEventRow[]`. **`afterSeq`, `beforeSeq`, `limit` are strings** (~19116).
  `types` filters server-side — always pass the five types below.
- Relevant event types and fields (confirmed on live Manager log, seq 172701–174823):
  - `client/turn/requested`: `data.initiator` (`user|agent|system`),
    `data.senderThreadId`, `data.requestId`, `data.originPluginId?` (~3300),
    `data.retryOfRequestId?` / `data.retryAttempt?` (~3309; a retry gets a new requestId),
    `data.input[]` (`{ type: "text", text, mentions[] }`), `data.target.kind`.
  - `turn/started`: `scope.turnId`, `data.parentToolCallId?` (~899; set ⇒ nested turn).
  - `turn/input/accepted`: `scope.turnId`, `data.clientRequestId` (= `requestId`).
  - `item/completed` with `data.item.type === "agentMessage"`, `data.item.text`,
    `data.item.parentToolCallId?` (~984; set ⇒ nested sub-agent output, not a root reply).
  - `turn/completed`: `data.status` ∈ `completed|failed|interrupted` (~909).
  - Sequences have gaps: never compute cursors arithmetically, use returned `seq`s.
- `threads.list({ threadIds ≤ 200, includeHidden, archived, limit, offset, … })` (~18814):
  no updated-time filter or ordering; hidden threads are excluded unless
  `includeHidden: true`; unknown/deleted ids are left out. Thread rows carry `updatedAt`.
- Hydrated event responses over 8 MiB fail with `413 event_data_too_large`.
- Plugin events: `experimental_thread.events` → `{ thread, sequence: number }` (~19927),
  `thread.deleted`. **Events are not replayed after a plugin restart**
  (`references/backend-events.md:93`).
- `threads.send` returns `{ ok, delivery: "sent" }` or `{ ok, delivery: "queued", queuedMessage }`
  — no request id (~13344). Modes: `auto | queue-if-active | steer-if-active` (~13316).
  Messages sent through the plugin-bound SDK carry `originPluginId = "answers"`.
- `bb.agents.registerTool({ name, description, parameters, execute(params, { threadId, projectId, signal }) })`
  — **no turn id** in the context (~20678). `bb.agents.contributeInstructions(({ threadId, projectId }) => string | null)`
  is synchronous and only reaches provider sessions started after install (~21262).
- Storage: `bb.storage.database()`, append-only `bb.storage.migrate`.
- RPC: tagged reads + `bb.rpc.experimental_invalidate(tags)` after each committed write
  (~20496, `references/frontend-hooks-and-ui.md:445–480`). No separate realtime channel.
- UI: `app.slots.navPanel` with `experimental_useBadge` returning `{ count, label } | null`;
  `app.slots.experimental_tab` with `context: { kind: "thread" }` and
  `availability: "fixed" | "action"` (component gets `{ threadId }`);
  `app.slots.messageAction` (`run({ threadId, message: { role, text, experimental_messageSeq }, selectedText? })`);
  `Markdown({ content, className? })` host component.
- Navigation: `useBbNavigate().toThread(id)` has **no** message option. Message
  deep links use the thread route with `?msg=<seq>` (the anchor `sdk.threads.message`
  and `bb thread log --message` use). Implementer: find the SDK link/route helper that
  produces that URL (e.g. a link component or `navigate(url)`); if none, build the
  route the same way bb's own message links do and note it in the PR.

## Package

- Path `plugins/answers/`, package `bb-plugin-answers`, plugin id `answers`,
  display name "Answers", version `0.1.0`, `engines.bb >= 0.49.0`, SDK 0.6.132.
- Copy package layout, tsconfig, vitest setup from `plugins/slots`; copy only the
  vendored `components/ui` files actually used, plus `lib/cn`.
- UI in English (collection convention), README in Russian (like Work Board).
- Add `.bb/plugins.json` entry and a root `README.md` row.
- `skills/answers/SKILL.md` for agents (tools, CLI, statuses).
- `PLAN.md` is not shipped (exclude from `files`).

## Data model (plugin SQLite, append-only migrations)

```sql
CREATE TABLE items (
  id               TEXT PRIMARY KEY,          -- "ans_" + random
  kind             TEXT NOT NULL,             -- 'mine' | 'for_me' | 'saved'
  thread_id        TEXT NOT NULL,
  project_id       TEXT,
  status           TEXT NOT NULL,             -- see state machine
  question         TEXT NOT NULL,             -- ≤ 4,000 chars
  question_seq     INTEGER,                   -- anchor of the question message
  request_id       TEXT,                      -- 'mine': client requestId
  turn_id          TEXT,                      -- 'mine': turn that accepted the question
  candidate        TEXT,                      -- latest root agentMessage seen for the bound turn
  candidate_seq    INTEGER,
  interim          TEXT,                      -- reply of a deferred / unsuccessful turn
  interim_seq      INTEGER,
  answer           TEXT,                      -- ≤ 20,000 chars
  answer_seq       INTEGER,
  answer_source    TEXT,                      -- 'turn' | 'agent' | 'user'
  resolve_turn_id  TEXT,                      -- set by answers_resolve
  note             TEXT,                      -- agent note for deferred
  read_at          INTEGER,
  pinned           INTEGER NOT NULL DEFAULT 0,
  dismissed_at     INTEGER,                   -- user "Done": hides from inbox, keeps status
  thread_deleted   INTEGER NOT NULL DEFAULT 0,
  dedupe_key       TEXT,                      -- 'saved': sha256(thread_id|seq|text)
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE UNIQUE INDEX items_mine_q ON items(thread_id, question_seq) WHERE kind = 'mine';
CREATE UNIQUE INDEX items_saved ON items(dedupe_key) WHERE kind = 'saved';
CREATE INDEX items_turn ON items(thread_id, turn_id);
CREATE INDEX items_resolve ON items(thread_id, resolve_turn_id);
CREATE INDEX items_request ON items(thread_id, request_id);
CREATE INDEX items_inbox ON items(dismissed_at, kind, status, created_at);
CREATE TABLE request_aliases (
  thread_id        TEXT NOT NULL,
  alias_request_id TEXT NOT NULL,
  item_id          TEXT NOT NULL,
  PRIMARY KEY (thread_id, alias_request_id)
);
CREATE TABLE threads_state (
  thread_id      TEXT PRIMARY KEY,
  last_seq       INTEGER NOT NULL,
  active_turn_id TEXT,                        -- last turn/started without turn/completed
  last_error     TEXT,
  updated_at     INTEGER NOT NULL
);
```

## State machine

`mine.status`:
- `waiting` — recorded, no successful answer yet.
- `deferred` — agent said the real answer comes later (`answers_defer`).
- `answered` — `answer` set; unread until `read_at`.

`for_me.status`: `open` → `replied` (only after a successful send).

`saved.status`: `saved` (`read_at` set at creation; text ≤ 20,000 chars).

Orthogonal flags: `pinned`, `dismissed_at` (Done — never changes `status`),
`read_at`.

Counts (badge = `unread + forMe`):
- `unread` = `mine`, `answered`, `read_at IS NULL`, `dismissed_at IS NULL`.
- `waiting` = `mine`, `waiting|deferred`, `dismissed_at IS NULL`.
- `forMe` = `for_me`, `open`, `dismissed_at IS NULL`.

## Ingestion (server)

Module `ingest.ts`: pure `applyEvents(dbTx, threadId, events)` + a driver.

**Driver.**
- Per-thread single-flight lock; triggers during a drain coalesce into one extra pass.
- Global concurrency bound of 2 drains.
- `experimental_thread.events` → schedule drain. Failed drain → `last_error`, retry
  with backoff (30 s doubling to 5 min) without waiting for another event.
- Drain: `events.list({ threadId, afterSeq: String(last_seq), limit: String(pageSize), order: "asc", types: RELEVANT })`
  in a loop until a short page. `pageSize` starts at 200; on `413` halve it (down to 1)
  and retry the same cursor; restore to 200 after a successful page. A `413` at size 1
  (a single > 8 MiB event) marks the thread `last_error = "oversized event after seq N"`,
  keeps the cursor, and is retried only with the normal backoff; `bb answers status`
  shows it. Accepted v1 limitation. Each page is applied **in one transaction together
  with `threads_state` (last_seq = max returned seq, active_turn_id)**. A crash
  between pages is safe because all pairing state lives in the DB (no in-memory
  candidates).
- **Startup reconcile** (after listeners are registered, non-blocking for load):
  1. For tracked threads, batch `threads.list({ threadIds, includeHidden: true })`
     (≤ 200 per call). Ids absent from a **successful** response are confirmed one by one
     with `threads.get`; only an explicit not-found result triggers deletion (below).
     Any other error keeps the data. Drain the rest.
  2. Discovery: page `threads.list({ limit: 200, offset })` (archived and hidden excluded)
     up to 5 pages (1,000 threads); keep rows with `updatedAt` within 48 h and no state
     row → first-sight backfill. Threads beyond that coverage are picked up on their
     next live event. Documented limit.
- **First-sight backfill** (no `threads_state` row, either from reconcile or a live
  event): read up to 3 pages of 500 relevant events (same 413 halving) with `order: "desc"` and `types: RELEVANT`,
  reverse, apply ascending. Turns whose start lies before the window are ignored
  (an answer without its question in the window creates nothing). Cursor = newest
  returned seq.
- `thread.deleted`: take the thread's lock (waits for an in-flight drain), delete
  `mine`/`for_me` items and `threads_state`; keep `saved` items with
  `thread_deleted = 1`. A drain that starts afterwards finds no state row and the
  thread missing → stops.

**`applyEvents` rules** (RELEVANT = the five types above):
1. `client/turn/requested` is a user question iff `initiator === "user"`,
   `senderThreadId == null`, `originPluginId !== "answers"` (replies sent from the
   Answers UI), text = joined `input[type=text].text` trimmed is non-empty, and the
   text is not a lone slash command (first mention `resource.kind === "command"`
   spanning the whole text). → insert `mine/waiting` (`question_seq = seq`,
   `request_id`); conflict on the unique index = no-op.
   **Retries are checked first, before the user filter** (bb issues retries with
   `initiator: "system"`): any `client/turn/requested` with `retryOfRequestId` that
   matches an item's `request_id` or an existing alias inserts
   `request_aliases(thread_id, alias_request_id = requestId, item_id)` and creates no
   item. `request_id` keeps the original id. A request that is never accepted leaves
   its item `waiting` (the user can dismiss it).
2. Root `turn/started` (no `parentToolCallId`) → `threads_state.active_turn_id = turnId`.
   Nested starts are ignored.
3. `turn/input/accepted` → the item whose `request_id = clientRequestId`, or whose
   alias matches it, gets `turn_id = turnId`.
4. `item/completed` `agentMessage` **without `parentToolCallId`**, in turn T, seq S:
   - items with `turn_id = T`, `status IN (waiting, deferred)`, `question_seq < S`
     → `candidate = text`, `candidate_seq = S`;
   - items with `resolve_turn_id = T` → `candidate = text`, `candidate_seq = S`.
   (Text and seq are always copied together, in every transition below.)
5. `turn/completed` for T:
   - `completed`:
     - `resolve_turn_id = T` items with a non-empty candidate set in T →
       `answered`, `answer/answer_seq = candidate/candidate_seq`, `answer_source = 'agent'`,
       `read_at = NULL`; without a candidate the status is kept. Clear `resolve_turn_id`
       either way (explicit resolution takes priority over the rows below);
     - `turn_id = T`, `waiting`, non-empty candidate → `answered`,
       `answer/answer_seq = candidate/candidate_seq`, `answer_source = 'turn'`;
     - `turn_id = T`, `deferred`, non-empty candidate → `interim/interim_seq = candidate/candidate_seq`.
   - `failed | interrupted`: candidate → `interim` (if any), status unchanged,
     clear `resolve_turn_id` for this turn (the agent must resolve again).
   - Clear `candidate*` only on items bound to T (`turn_id = T` or `resolve_turn_id = T`);
     if `active_turn_id = T`, set it to NULL. A nested turn's completion touches nothing else.
6. Several user questions bound to one turn share that turn's final candidate —
   accepted v1 policy, documented in the README.

Text caps are applied at write time with a "… (truncated, open in chat)" suffix.

## Agent tools (server)

All tools first **drain the calling thread** (under its lock) so the current question
and `active_turn_id` are up to date, then mutate under the same lock. Every id-taking
tool checks the item belongs to the calling `threadId` and has kind `mine`
(or `for_me` where stated). Output ≤ 2,000 chars.

- `answers_list()` — `waiting|deferred` `mine` items of the calling thread: id, age,
  first 160 chars of the question, note. ≤ 20 rows.
- `answers_defer({ id?, note? })` — without `id`, the newest `waiting` `mine` item of
  the thread. → `deferred`, `note`.
- `answers_resolve({ id })` — item must be `waiting|deferred`; requires
  `active_turn_id` (else error "no active turn"). Sets `resolve_turn_id = active_turn_id`.
  The final root message of that turn becomes the answer when the turn completes.
- `answers_ask({ question })` — creates `for_me/open` (question ≤ 2,000 chars). Returns id.

`contributeInstructions` for all threads (≤ 600 chars), roughly:

> Answers plugin: the user's messages are tracked as questions and paired with your
> final reply. If you cannot answer in this turn (e.g. you delegated it), call
> `answers_defer`. When a later turn delivers that answer, call `answers_list`, then
> `answers_resolve`, and put the answer in your final message. For small non-blocking
> questions to the user use `answers_ask`; blocking decisions stay in Work Board.

## RPC contract (`contract.ts`, shared; frozen by task A before B starts)

Reads are tagged (`answers:items`, `answers:counts`); every write path (RPC, tools,
ingestion, deletion) calls `bb.rpc.experimental_invalidate` after commit.

- `list({ view: 'unread'|'waiting'|'for_me'|'pinned'|'saved'|'all', threadId?, projectId?, query?, cursor?, limit ≤ 50 })`
  → `{ items: Item[], nextCursor }`; dismissed items only in `all` and `pinned`.
  `Item` includes thread title + project name, resolved server-side per call (batched).
- `counts()` → `{ unread, waiting, forMe }`.
- `markRead({ ids } | { all: true, threadId? })`, `setPinned({ id, pinned })`,
  `setDismissed({ id, dismissed })`.
- `reply({ id, text ≤ 8,000 })` → `threads.send({ threadId, mode: "auto", input })`
  with text prefixed `Re: "<first 120 chars of the question>"\n\n`. Ingestion skips it
  via `originPluginId`. Concurrency: an
  in-memory per-item in-flight set (the plugin server is one process) rejects a second
  reply while one is sending; nothing is persisted before the send, so a crash cannot
  strand an item. `for_me`: after a successful send, a conditional
  `UPDATE … SET status = 'replied', answer = text, answer_source = 'user' WHERE status = 'open'`;
  a reply to an already `replied` item is rejected. A send error (or a crash after
  delivery) leaves the item `open`; the UI shows "Delivery uncertain — check the
  thread before retrying". Never resend automatically. For `mine`, it is a follow-up that
  creates no new question. Result exposes `delivery` (`sent|queued`); the UI says
  "Sent"/"Queued", never "Answered by agent". The UI disables the button while pending.
- `save({ threadId, seq, role, text })` → `saved` item (dedupe by `dedupe_key`).

All inputs zod-validated (id format, enum views, length caps).

## CLI (`bb answers …`)

- `list [--view …] [--thread <id>] [--json]` (≤ 50 rows).
- `read <id…> | --all [--thread <id>]`.
- `status` — counts, tracked threads, threads with `last_error`.

## UI (app)

1. **Nav panel "Answers"** (`navPanel`, icon `Inbox`, badge = `unread + forMe`,
   `null` when 0).
   - Views: Unread · Waiting · For me · Pinned · Saved · All. Search. Project filter.
     "Mark all read".
   - Card: thread title, relative time, status chip (text, not color only), question
     (2-line clamp, expandable), answer via host `Markdown`, interim + note for
     deferred.
   - Actions: Open in chat (deep link `?msg=<answer_seq ?? question_seq>`; marks read),
     Mark read, Pin, Done (dismiss), Reply (inline textarea, Cmd+Enter).
   - Visiting a thread does **not** mark items read (that is the missed-answer case).
2. **Thread tab "My questions"** (`experimental_tab`, `context: { kind: "thread" }`,
   `availability: "action"`): same cards filtered to `{ threadId }`, newest first.
3. **Message action "Save to Answers"** (`messageAction`): saves
   `selectedText ?? message.text` with `experimental_messageSeq`.

Accessibility: labelled buttons, keyboard-navigable list.

## Tests

- `ingest.test.ts` (core, fixtures shaped like real events): plain question →
  answered; slash command skipped; agent/system/`originPluginId` turns ignored; steer
  into an agent turn uses only messages after the question; nested
  (`parentToolCallId`) messages ignored; failed/interrupted → interim, still waiting;
  two questions in one turn; system-initiated retry (and a second retry) re-maps
  via aliases; defer → interim, later resolve → answer; resolve in an
  interrupted turn clears; page split between message and completion (apply in two
  calls); idempotent re-apply; desc backfill window with a boundary turn.
- `server.test.ts`: RPC validation, tool scope checks, deletion keeps saved items,
  reply rejects a concurrent and a second `for_me` reply, failed send leaves `open`, invalidation called after writes.
- `app.test.tsx`: nav panel with mocked RPC, mark read, reply pending state.
- `npm run typecheck && npm test && npm run build` green.

## Deployment

- `bb plugin build`, copy the package to `/Users/shaatla/bb-plugins/releases/answers-0.1.0`,
  `bb plugin install path:/Users/shaatla/bb-plugins/releases/answers-0.1.0`
  (same pattern as Slots and Work Board).
- Live check in scratch threads: question → answered, badge, tab, save action,
  defer/resolve, reply from the inbox not creating a question, restart of the plugin
  mid-turn.
- Existing threads (Manager) get the tools/instructions after their next provider
  session start.

## Delegation (after plan approval)

| # | Task | Model | Depends on |
|---|------|-------|------------|
| A | Package scaffold, DB/migrations, ingestion driver + `applyEvents`, agent tools, instructions, RPC contract + handlers, CLI, `ingest.test.ts`, `server.test.ts` | `gpt-6.1-terra`, reasoning high | — |
| B | App: nav panel + badge, thread tab, message action, `app.test.tsx` | `gpt-6.1-terra`, reasoning medium | A merged (frozen contract) |
| C | `skills/answers/SKILL.md`, README (RU), collection index + root README row | `gpt-6-luna` | A + B merged |

Each task runs in its own worktree branch off the current `feat/answers`, must be
green on typecheck/test/build, commits, and reports. Claude reviews each diff, merges
into `feat/answers`, owns the merged-tree verification, build, deploy and live check.

## Risks

- `experimental_*` SDK names can change on bb upgrades.
- ~40 questions/day in Manager alone: the inbox defaults to Unread and has Mark all read.
- Agents may ignore `answers_defer`; then a "delegated, will report" reply becomes the
  answer. Accepted for v1; the user can dismiss it.
- Drain load on very chatty threads: bounded by `types` filter, page size, single-flight
  per thread and global concurrency 2.
