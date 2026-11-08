# Answers 0.3.0 — attention, notifications, faster replies, integrations

Status: draft v2 for review (v1 review: `review-1.md`, 9 majors / 6 minors, all addressed below).
Base: branch `feat/answers` (0.2.0, SDK 0.6.132). Every feature was accepted by the owner.
Behaviour is the spec; file/line hints are guidance.

## SDK facts this plan relies on (verified 2026-11-08)

- Push: built-in plugin `push-notifications` registers RPC `notifications.send`, strict input
  `{title: string(1..4000), body?: string(..4000), threadId?: string}` (display cuts title to 80, body to 180),
  output `{ok:true, channels:[...]}`; empty `channels` = nothing delivered. Server call:
  `bb.sdk.plugins.callRpc({pluginId:'push-notifications', method:'notifications.send', input, outputSchema})`
  (pattern: `plugins/work-board/git-sync/environment-prs.ts`). bb already notifies per thread on turn
  completion, so answer pushes can duplicate those.
- Retry: `bb.sdk.threads.retry({threadId, turnRequestId?, sendAt?, reason?})`. `turnRequestId` must be the
  **latest failed attempt's** request id (a retry's failure reports the retry's id); a mismatch is refused.
  A retry arrives as `client/turn/requested` with `retryOfRequestId`, which `ingest.ts` already aliases.
- Failures: thread events carry `turn/completed {status:'failed'}` (input accepted) and
  `client/turn/rejected {requestId, reason, message}`; the live hook `bb.events.on('turn.failed')` gives
  `{threadId, requestId, turnId|null, inputAccepted, attemptNumber}`.
- `bb.sdk.threads.send` from the plugin server stamps `originPluginId`; the send result carries no request id
  and the `client/turn/requested` event carries no `pluginSubmission`.
- Settings: `bb.settings.define({...})` (`string|boolean|number|select`), `onChange` exists;
  example `plugins/ci-dashboard/server.ts`.
- Work Board (installed 0.27.3, `/Users/shaatla/bb-plugins/releases/work-board-0.27.3/shared/contract.ts`):
  `listProjects({folderId?})`, `createTask({projectId,title,description,requesterThreadId?})` →
  `{ok:true, task:{key,...}}` | `{ok:false, error:{message}}`. Validate its output with a local schema.
- No toast API for plugin pages; `useTransientText` (`empty.tsx`) is the house status-line helper.
  The only menu primitive is the `role="menu"` popover inside `SendButton` (`composer.tsx:71`).
- Node timers clamp delays > 2,147,483,647 ms to 1 ms.
- Icon names must exist in bb's registry (`/Applications/bb.app/.../app/dist/assets/index-*.js`); verify each
  new one, fall back to an existing name.

## Cross-cutting: one attention predicate

The unread predicate is copy-pasted in `server.ts` (`counts`, `list` view `unread`, `unreadWhere`,
`markThreadRead`, `markRead`) and `app.tsx` (`isUnread`). Move it to one exported SQL fragment
`ATTENTION_SQL` in `ingest.ts` and one client `isUnread(item)` in `app.tsx`; use them everywhere:

```
dismissed_at IS NULL AND read_at IS NULL AND snoozed_until IS NULL AND (
  (kind='mine' AND status='answered') OR
  (kind='for_me' AND status='open') OR
  (kind='mine' AND status IN ('waiting','deferred') AND failed_at IS NOT NULL))
```

Snoozes are *consumed* when due (F8), so the predicate needs no clock. `counts.inbox`, recipient counters,
the nav badge and `view: unread` use it; `counts.unread` keeps its meaning (answered, unread, not snoozed).

## Data model — new migration entry (index 4, append-only, one string)

```
ALTER TABLE items ADD COLUMN snoozed_until INTEGER;                       -- F8
ALTER TABLE items ADD COLUMN failed_at INTEGER;                           -- F11
ALTER TABLE items ADD COLUMN attempt_request_id TEXT;                     -- F11: latest attempt's request id
ALTER TABLE items ADD COLUMN likely_interim INTEGER NOT NULL DEFAULT 0;   -- F4
ALTER TABLE items ADD COLUMN options TEXT;                                -- F7: JSON string[] or NULL
ALTER TABLE items ADD COLUMN attention_at INTEGER;                        -- F5: when it last became attention
ALTER TABLE items ADD COLUMN answered_at INTEGER;                         -- F13: when it became answered
ALTER TABLE items ADD COLUMN read_batch TEXT;                             -- F2
ALTER TABLE items ADD COLUMN task_key TEXT;                               -- F12
UPDATE items SET attention_at=updated_at, answered_at=CASE WHEN status='answered' THEN updated_at END,
  attempt_request_id=request_id;
CREATE TABLE own_sends (thread_id TEXT NOT NULL, text_hash TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX own_sends_key ON own_sends(thread_id, text_hash);
CREATE INDEX items_thread_recent ON items(thread_id, updated_at);
```

`itemSchema` gains `snoozedUntil`, `failedAt`, `likelyInterim: boolean`, `options: string[] | null`,
`taskKey: string | null`. Internal columns (`attempt_request_id`, `attention_at`, `answered_at`,
`read_batch`) stay out of the RPC item. The row mapper parses `options` JSON.

**Event-time rule:** ingest stamps `attention_at` / `answered_at` with the triggering event's `createdAt`
(fallback `now`), so catch-up of old events is recognisably old (F5).

## Features

### F1. All conversations in the Inbox list (Telegram-style)

- `recipients` returns every thread with at least one item where `thread_deleted=0` (dismissed items still
  count for presence, not for counters). Order: threads with attention > 0 first, by `lastAt` desc; then the
  rest by `lastAt` desc. `lastAt` = max `updated_at` of the thread's items. Cap 200 rows (`shortcut:` comment).
- `questions: true` keeps only threads that have a question item (`kind='for_me' OR QUESTION_SQL`); counters
  then count only those items, as today.
- Preview = newest attention item (answer for `mine`, question for `for_me`), else the newest item's
  `answer ?? question`, 160 chars.
- One SQL with window functions (`ROW_NUMBER() OVER (PARTITION BY thread_id ...)`) instead of today's per-row
  queries; keep the `selected` handling.
- UI: rows with `unread=0` show no counter and muted title/preview. A thin "All caught up" line tops the list
  when nothing has attention but the list is not empty; the empty state stays for a truly empty list.

### F2. Undo for bulk reads; Mark all read covers the whole Inbox

- `markRead({all, threadId?})` and `markThreadRead` mark exactly the attention set (so agent questions and
  failed turns are included, matching the Inbox), set `read_batch=<random id>` with `read_at`, and return
  `{ok:true, batch: string|null, count}` (`batch` null when `count` is 0). `markRead({ids})` returns
  `{ok:true}` and sets `read_batch=NULL`.
- New RPC `undoRead({batch})`: `UPDATE items SET read_at=NULL, read_batch=NULL WHERE read_batch=? AND
  read_at>=now-10min`; returns `{ok:true, count}`; `count` 0 → UI says "Undo expired".
- UI: after a bulk read, a status line at the bottom of the Answers page (and the thread tab):
  "Marked N read · Undo" for 8 s. Not shown for read-on-view or single Mark read.
- CLI `bb answers read --all` prints the count.

### F3. Save to Answers confirms

- `save` output becomes `{id, created: boolean}` (false on dedupe hit).
- The message action dispatches `window.dispatchEvent(new CustomEvent('answers:saved', {detail:{id, created,
  at}}))`, also writes the same detail to localStorage `bb-plugin-answers:saved-flash`, then opens the
  **My questions** tab (`experimental_panel.openTab`, like the pool action).
- The tab listens for the event while mounted and checks the key on mount (accept if `at` < 5 s old, then
  remove the key). It shows "Saved to Answers" or "Already in Saved" via `useTransientText` (4 s) with a
  "Show in Saved" link.

### F4. Interim-looking replies are flagged

- In `turn/completed` (status completed), after the `answered` updates, set `likely_interim=1` on items this
  turn just answered with `answer_source='turn'` when the last 600 chars of the answer match `INTERIM_RE`
  (exported from `ingest.ts`, case-insensitive):
  RU `делегир|доложу|сообщу, когда|отпишусь|вернусь с (ответом|результат)|как (только )?(будет|закончит)|жду (результат|ответ|завершени)`,
  EN `delegat|will report back|i'll (get back|report|follow up)|once (it|they|the \w+) (finish|complete)|waiting (for|on) (the )?(child|sub-?agent|thread|result)`.
  `answer_source='agent'` (from `answers_resolve`) is never flagged.
- UI on a flagged answered item: a muted chip "Looks like an interim reply" in its own wrapping row, with
  **Keep waiting** → RPC `keepWaiting({id})` (only from `kind='mine' AND status='answered'`): `status='deferred',
  interim=answer, interim_seq=answer_seq, answer=NULL, answer_seq=NULL, answer_source=NULL, answered_at=NULL,
  read_at=NULL, likely_interim=0`; and **It's the answer** → RPC `setInterim({id, value:false})`.
- The deferred item is then answered like any deferred one (agent's `answers_resolve`); README notes this.

### F5. Push notifications

Settings (`bb.settings.define`): `notify` (`select`): `off` | `asked` (default; agent questions to you) |
`questions` (also answers to your messages with "?" and failed turns of them) | `all` (every attention item);
`quietHours` (`string`, default empty, schema `^(\d\d:\d\d-\d\d:\d\d)?$`, local server time, may wrap midnight).

`notify.ts`, created by `server.ts` and run after every write that can create attention (driver
invalidation, `answers_ask`, snooze wake-ups):

1. **Cursor, not per-item flags.** KV `notify:cursor` (ms). First run ever: cursor = now. Each run selects
   attention items with `attention_at > cursor`, then sets cursor = max `attention_at` seen — whether or not
   they are sent. So items excluded by the level (or by `off`) are consumed, and switching `off → all` never
   pushes a backlog.
2. **Live only.** Of those, only items with `attention_at >= now - 10 min` are eligible. Catch-up of events
   that happened while bb or the plugin was down carries old event times (event-time rule) and is skipped;
   first-sight backfill of a thread is skipped the same way, while a question still waiting at upgrade or at
   discovery pushes when it is answered later (its `attention_at` is set then).
3. **New episode → new push.** `attention_at` is (re)set whenever an item enters attention: answered,
   failed, `for_me` created, snooze woken, `keepWaiting` → later answered. Leaving attention does not reset it.
4. **Coalescing.** Eligible ids queue for 10 s. At flush, re-read the queue and keep only ids still attention
   and still matching the current `notify` level; drop an empty batch. One item: title = thread title or
   "Answers" (trimmed, 1–80 chars), body = question (`for_me`) / answer (`mine`) / "Turn failed: <question>",
   whitespace-collapsed and cut to 180 chars, `threadId` set. Several: title "N new in Answers", body = up to
   3 thread titles (180 chars), `threadId` only if shared.
5. **Quiet hours.** Inside the window nothing is queued (cursor still advances). At the window end one summary
   push "While you were away: N new in M threads" counts items still attention with `attention_at` inside that
   window — a query, so nothing is held in memory. The end timer is recomputed at startup and on
   `settings.onChange`; a window that ended while the server was down gets no summary (accepted). KV
   `notify:summaryFor` = last window end summarised, to avoid doubles.
6. `notify` changed to `off` clears the queue and the quiet timer. Push plugin missing/failing or
   `channels: []`: one debug log per hour, no retry. All timers `unref()` and cleared on dispose.

### F6. Reply from the Inbox without quoting

- Composer pinned to the bottom of the open conversation (reuse `Composer` + `SendButton` modes +
  attachments). It is keyed by thread (`key={threadId}`) so upload/error state belongs to one thread.
- Drafts: one localStorage map `bb-plugin-answers:page:compose` = `{[threadId]: {text, files}}`, read and
  written through a small helper (not `useStoredState`, which reads only on mount). Every upload and send
  captures its thread id and updates only that entry. On successful send, remove the entry only if it still
  equals the sent snapshot (edits made meanwhile survive); failed send keeps it.
- New RPC `send({threadId, text(1..8000), attachments?, send?})`. Before `deliver()` it inserts
  `own_sends(thread_id, sha256(text), expires_at = (sendAt ?? now) + 24 h)`; on delivery error it deletes
  that row. No `Re:` prefix, no item state change.
- Ingest: a `client/turn/requested` with `originPluginId === <this plugin id>` and `initiator` user is a
  question **only** if an unexpired `own_sends` row matches `(thread_id, sha256(joined text))`; that one row is
  deleted in the same transaction. Expired rows are pruned at startup. Quote replies, pools and `reply` record
  no row, so they stay excluded as today. `applyEvents` gets the plugin id as a parameter.
- The quote popup still works; the bottom composer hides while it is open. After send the conversation
  scrolls to the bottom. Mobile: sticky inside the scroll column, stays above the keyboard.

### F7. Quick replies to agent questions

- `answers_ask` gains `options?: string[]` (1–6, each trimmed 1–80 chars, unique). Stored as JSON in
  `items.options`. Tool description and `INSTRUCTIONS` mention it (`INSTRUCTIONS` ≤ 600 chars).
- UI: an open `for_me` item with options shows them as small wrapping buttons under the question; click →
  existing `reply({id, text: option})`. Free-text Reply stays. Buttons disappear once `replied`.

### F8. Remind me later (snooze)

- RPC `snooze({id, until: number|null})`: `until` in (now, now + 30 days]; `null` unsnoozes (and counts as a
  wake). Allowed for any non-saved item; sets `read_at=NULL`.
- **Wake = consume.** `wakeDue()` runs at startup and on each timer fire, in one transaction:
  `UPDATE items SET snoozed_until=NULL, read_at=NULL, attention_at=now WHERE snoozed_until<=now`, then
  invalidate and run the notifier if anything changed, then arm one timer for the nearest future deadline with
  `min(delay, 2^31-1)` (re-evaluated on fire). Re-armed after every `snooze` call; cleared on dispose.
- Snoozed items are not attention; conversations and History show "Snoozed until <time>" and **Unsnooze**;
  read-on-view ignores them.
- UI: "Remind later" menu (reuse the `SendButton` menu markup): In 1 hour, This evening (18:00 today; if past,
  +3 h), Tomorrow 9:00, Next Monday 9:00 — computed in local time on the client.

### F9. Search in the open conversation

- A search button in the conversation header opens an input; results from
  `list({view:'all', threadId, query, limit: 20})` in a dropdown (snippet + date).
- Picking a result: if loaded, scroll it below the sticky header and flash it (`data-flash`, 1.5 s fade);
  else raise `depth` until it is loaded (max 20 pages), then scroll; if still absent, "Older than loaded
  history — open in chat" with the existing open-in-chat link. Esc closes. Jumping releases the open pin.

### F10. Several questions, one answer

- In the Inbox conversation, consecutive `kind='mine'` items with the same non-null `turnId` and the same
  non-null `answerSeq` render as one card: question bubbles in order, then the answer once.
- `ItemCard` gets an optional `members?: Item[]` prop (owned by task C, used by task D): read-on-view and
  Mark read act on all member ids; Pin/Save/quote/reply/snooze/task act on the last member; ✓✓ when all read.
- History and the thread tab are unchanged.

### F11. Failed turns can be retried

Ingest (persisted events, so restart/replay behaves the same as live):
- `turn/input/accepted` (existing binding) also sets `attempt_request_id = clientRequestId` and clears
  `failed_at`. `client/turn/requested` with `retryOfRequestId` that aliases an item sets
  `attempt_request_id = requestId` (the alias stays as today).
- `turn/completed {status:'failed'}`: items with `turn_id = turn` still `waiting`/`deferred` get
  `failed_at = event time, attention_at = event time, read_at = NULL`.
- `client/turn/rejected {requestId}` (add to `RELEVANT`): the item whose `request_id` or alias is
  `requestId` and still `waiting` gets the same, and `attempt_request_id = requestId`.
- Live hook `turn.failed` with `inputAccepted=false` and no matching persisted event yet: same update by
  `requestId` through the alias table (idempotent with the line above).
- `failed_at` is cleared when the item becomes `answered` or on a new accepted attempt.
- Failed **resolution** turns (`resolve_turn_id`) are out of scope: the binding is cleared as today and the
  item stays `deferred` without `failed_at`; the agent resolves again in a later turn. Interrupted turns keep
  today's behaviour.

RPC `retryTurn({id})` → `bb.sdk.threads.retry({threadId, turnRequestId: attempt_request_id})`; errors shown
as returned. UI: "Turn failed" (destructive text) + **Retry**; **Stop waiting** stays.

### F12. Create a Work Board task from an item

- RPC `workBoardProjects({})` → `{available, projects: {id, name}[]}` via `callRpc(work-board, listProjects)`;
  any error → `available:false`.
- RPC `createTask({id, projectId})` → `callRpc(work-board, createTask, {projectId, title, description,
  requesterThreadId})`: title = first line of the question (≤120); description = question, answer if any,
  and `[Open thread](/projects/<p>/threads/<t>)` (or `/threads/<t>`). Stores `task.key` in `items.task_key`,
  returns `{key}`; `{ok:false}` → error with `error.message`.
- UI: "Create task" in the item's More menu (hidden when unavailable); project picker remembers the last
  choice in localStorage; items with `taskKey` show a chip linking to `/plugins/work-board/work-board/task/<KEY>`.

### F13. Digest for automations

- CLI `bb answers digest [--since 24h|7d|<ISO>] [--json]` (default 24h), one dedicated read query per section
  with a total count:
  **New answers** — `answered_at >= since` (unread first); **Still waiting** — all `waiting`/`deferred`,
  failed first (not filtered by `since`); **Asked of you** — all open `for_me` (not filtered).
  Lines `thread title — snippet (age)`, 20 per section, then "+N more". `--json` → `{newAnswers, waiting,
  askedOfYou}` each `{total, items}`. Read-only.
- README shows scheduling it with the automations plugin.

### Item actions on narrow screens

`ItemCard` keeps Mark read / Reply / Open in chat as icon buttons; Pin, Save, Remind later, Create task,
Stop waiting / Won't reply move into one **More** menu (the `SendButton` menu markup, keyboard reachable,
labelled). Interim and quick-reply buttons wrap in their own rows. Verified at 320 px wide.

## RPC summary (contract.ts; existing inputs unchanged)

New: `undoRead`, `keepWaiting`, `setInterim`, `send`, `snooze`, `retryTurn`, `workBoardProjects`, `createTask`.
Additive output changes: `markRead`, `markThreadRead` (`batch`, `count`), `save` (`created`).
All mutations invalidate `ITEMS_TAG` + `COUNTS_TAG`.

## Tests (vitest, existing style)

- ingest: failed turn → `failed_at`/attention; A → B(retry) fails → `attempt_request_id` = B; accepted retry
  clears; answered clears; `client/turn/rejected` before acceptance and for a retry; interrupted unchanged;
  failed resolution stays deferred; `INTERIM_RE` RU/EN samples, `answer_source='agent'` ignored;
  own-send: matching row admits one question and is consumed, a second identical request is ignored, quote/
  pool sends ignored; event-time stamping of `attention_at`/`answered_at`.
- server: attention predicate everywhere (counts, list, recipients, markThreadRead); recipients include read
  threads, order, questions filter; markRead all → batch → undoRead, expired; keepWaiting/setInterim; snooze
  bounds, overdue at startup, 30-day timer clamp, several deadlines, dispose with timer pending (fake timers);
  `send` records/deletes `own_sends`; ask options validation; `retryTurn` passes `attempt_request_id`;
  Work Board RPCs with mocked `callRpc` (available, thrown error, `ok:false`).
- notify: first run consumes history; `off → all` no backlog; restart catch-up of old events not pushed;
  question waiting at upgrade pushes when answered; failed → retry → answered pushes twice; read/replied/
  snoozed during the 10 s window drops it; 20,000-char answer passes a mock that parses the real strict push
  schema; quiet window summary once, settings change re-arms, `off` cancels; missing push plugin.
- app: muted read recipients, "All caught up"; Undo line; quick replies; interim chip; Retry; More menu;
  grouped card marks all members read; search jump loads earlier pages; composer: switch thread during upload
  and during send, failed send keeps draft, edit after send survives; snooze menu times (fixed clock);
  save notice with tab already mounted, fresh mount, dedupe hit.
- CLI: digest sections, totals beyond 20, old question answered today counts, old answer pinned today does
  not, `--since` parsing.

## Delegation

Each task runs in its own worktree from `feat/answers` (`.worktrees/answers-f…`), commits on its branch. The
coordinator (Claude) reviews each, merges in the order below, runs `npm test`, `tsc` and a browser check after
every merge, then deploys.

| # | Task | Files it owns | Model (Codex) | Starts after |
|---|------|---------------|---------------|--------------|
| A | Migration, `ATTENTION_SQL`, item schema, F11 ingest + `retryTurn` + `turn.failed` hook, F4 ingest + RPCs, F8 server, F2 server, F1 query, F6 `send` + `own_sends` ingest, F7 tool + storage, F3 `save.created`, F12 RPCs, contract for all; server/ingest tests | `ingest.ts`, `driver.ts`, `schema.ts`, `contract.ts`, `server.ts`, `cli.ts` (read count) | `gpt-6.1-sol`, medium | — |
| B | F5 `notify.ts` + settings + hooks into driver/ask/wake; F13 digest CLI; notify/CLI tests | `notify.ts`, `cli.ts`, small hook calls in `server.ts` | `gpt-6-sol`, medium | A merged |
| C | Item UI: `isUnread`, More menu, F2 Undo line, F3 notice, F4 chip, F7 buttons, F8 menu, F11 Retry, F12 picker/chip, `members` prop; app tests | `app.tsx`, `empty.tsx` | `gpt-6-sol`, medium | A merged |
| D | Conversation UI: F1 list styling, F6 composer + drafts, F9 search jump, F10 grouping (uses C's `members`); app tests | `inbox.tsx`, `composer.tsx` | `gpt-6-luna`, high | A merged |
| E | README, SKILL, `INSTRUCTIONS` wording check, version 0.3.0 | docs, `package.json` | `gpt-6-luna`, low | B, C, D merged |

Merge order: A → B → C → D (rebased on C; it consumes `members`) → E. B, C, D work in parallel on A.

## Risks

- Answer pushes duplicate bb's per-thread notifications → default `notify=asked`.
- Own-send matching applies only to requests stamped with this plugin's id, by thread + exact text within
  24 h; quote/pool/`reply` sends record no row. Two identical Inbox sends record two rows and match twice.
- `INTERIM_RE` false positives only add a chip; negatives are today's behaviour.
- `threads.retry` can still refuse (thread moved on); the error is shown.
- Work Board is another plugin's contract; degrade to hidden.
- Timers use server local time; a sleeping laptop fires late (snoozes are consumed on wake/startup).
