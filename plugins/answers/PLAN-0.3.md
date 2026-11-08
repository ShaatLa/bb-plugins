# Answers 0.3.0 — attention, notifications, faster replies, integrations

Status: draft v3 for review (review-1: 9 majors / 6 minors; review-2: 6 majors / 2 minors; all addressed).
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
- `bb.sdk.threads.send` from the plugin **server** is wrapped to stamp `originPluginId` (bundled
  `start-server.js`: `send(args){return sdk.threads.send({...args, originPluginId: pluginId})}`). The
  **browser** SDK (`useSdk().threads`, `PluginBoundThreadsArea`, SDK:23183) stamps only `spawn`/`fork`, so a
  send from the plugin page is an ordinary user message (verify once in the browser: its
  `client/turn/requested` has no `originPluginId`). Grouped queued dispatch carries `inputGroups`; ingest
  already treats such a request as one question, like chat.
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
ALTER TABLE items ADD COLUMN notify_state INTEGER NOT NULL DEFAULT 0;    -- F5: 0 none, 1 pending, 2 held for quiet summary
ALTER TABLE items ADD COLUMN answered_at INTEGER;                         -- F13: when it became answered
ALTER TABLE items ADD COLUMN read_batch TEXT;                             -- F2
ALTER TABLE items ADD COLUMN task_key TEXT;                               -- F12
UPDATE items SET answered_at=CASE WHEN status='answered' THEN updated_at END, attempt_request_id=request_id;
CREATE INDEX items_thread_recent ON items(thread_id, updated_at);
```

`itemSchema` gains `snoozedUntil`, `failedAt`, `likelyInterim: boolean`, `options: string[] | null`,
`taskKey: string | null`. Internal columns (`attempt_request_id`, `notify_state`, `answered_at`,
`read_batch`) stay out of the RPC item. The row mapper parses `options` JSON.

**Event time:** ingest stamps `answered_at` and `failed_at` with the triggering event's `createdAt`
(fallback `now`).

**Entering attention** (used by F5): an item *enters attention* when it becomes answered, gets `failed_at`,
is created by `answers_ask`, or is woken from a snooze. `applyEvents` takes `live: boolean`; when an item
enters attention it sets `notify_state = live ? 1 : 0` (the RPC/tool/wake paths always set 1).

## Features

### F1. All conversations in the Inbox list (Telegram-style)

- `recipients` returns every thread with at least one item where `thread_deleted=0` (dismissed items still
  count for presence, not for counters). Order: threads with attention > 0 first, by `lastAt` desc; then the
  rest by `lastAt` desc. `lastAt` = max `updated_at` of the thread's items. Cap 200 rows (`shortcut:` comment).
- `questions: true` keeps only threads that have a question item (`kind='for_me' OR QUESTION_SQL`); counters
  then count only those items, as today.
- Preview = newest attention item: answer for answered `mine`, question for `for_me`, `Turn failed: <question>`
  for failed `mine`; else the newest item's `answer ?? question`; 160 chars, never empty-crashing.
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
  read_at=NULL, likely_interim=0, notify_state=0`; and **It's the answer** → RPC `setInterim({id, value:false})`.
- The deferred item is then answered like any deferred one (agent's `answers_resolve`); README notes this.

### F5. Push notifications

Settings (`bb.settings.define`): `notify` (`select`): `off` | `asked` (default; agent questions to you) |
`questions` (also answers to and failures of your messages with "?") | `all` (every attention item);
`quietHours` (`string`, default empty, schema `^(?:([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d)?$` with
equal endpoints rejected; local server time; may wrap midnight). `level(item)` = whether an item matches `notify`.

`notify.ts`, created by `server.ts`; `run()` is called after any write that can make `notify_state=1`
(driver invalidation, `answers_ask`, snooze wake, settings change). Runs are serialized (one promise chain).

1. **Live vs history (no age heuristics).** The driver passes `live=false` to `applyEvents` for first-sight
   backfill and for every drain that starts before startup `reconcile()` has finished its tracked-thread pass;
   `live=true` afterwards. So downtime catch-up and discovery never push, whatever their age; a question
   still waiting at that time pushes when it is answered later (that later turn is live).
   `shortcut:` events arriving during the few seconds of startup reconcile do not push.
   At plugin load: `UPDATE items SET notify_state=0 WHERE notify_state=1`, and also `=2` when not inside quiet hours.
2. **Claim in write order.** `run()` in one transaction selects `notify_state=1` rows and sets them all to 0
   (consumed whatever the level, so `off → all` pushes no backlog). Of the claimed rows, those still attention
   and matching `level` are queued in memory — or, inside quiet hours, set to `notify_state=2` instead.
3. **Coalescing.** The queue flushes 10 s after its first id. At flush it re-reads the ids and keeps those
   still attention and matching the current `level`; if quiet hours began meanwhile they become
   `notify_state=2`; an empty batch sends nothing. One item: title = thread title or "Answers" (trimmed,
   1–80 chars), body = question (`for_me`) / answer (`mine`) / `Turn failed: <question>`, whitespace-collapsed,
   ≤ 180 chars, `threadId` set. Several: title "N new in Answers", body = up to 3 thread titles (≤ 180),
   `threadId` only if shared. Losing an unflushed queue on reload is accepted.
4. **Quiet hours.** At the window end (timer computed at startup and on `settings.onChange`) count
   `notify_state=2` rows still attention and matching the current `level`, set all `2 → 0`, and if N > 0 push
   "While you were away: N new in M threads" (no threadId). Only items that matched the level while
   notifications were on are ever held, so items consumed while `off` never reappear.
5. `notify` → `off` clears the queue and sets `2 → 0`. Push plugin missing/failing or `channels: []`: one
   debug log per hour, no retry. All timers `unref()` and cleared on dispose; dispose waits for a running claim.

### F6. Reply from the Inbox without quoting

- Composer pinned to the bottom of the open conversation (reuse `Composer` + `SendButton` modes +
  attachments), keyed by thread (`key={threadId}`) so upload/error state belongs to one thread.
- Sending uses the **browser SDK** `useSdk().threads.send({threadId, mode, input, sendAt?})` (input built the
  same way as `deliver()` in `server.ts`); Draft mode passes
  `pluginSubmission: {pluginId: 'answers', data: {kind: 'draft'}}`, which the existing `message.dispatch`
  hook holds. No new RPC. Because the browser send is not plugin-stamped, the message is ingested as a normal
  question (first implementation step: confirm this in the browser; if it turns out stamped, stop and report).
- Drafts: one localStorage map `bb-plugin-answers:page:compose` = `{[threadId]: {text, files}}`, read and
  written through a small helper (not `useStoredState`, which reads only on mount). Every upload and send
  captures its thread id and updates only that entry. On success, remove the entry only if it still equals
  the sent snapshot; on error keep it and show "Delivery uncertain — check the thread before retrying"
  (as the quote popup does).
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
  `UPDATE items SET snoozed_until=NULL, read_at=NULL, notify_state=1 WHERE snoozed_until<=now`, then
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
- `turn/input/accepted` (existing binding) also sets `attempt_request_id = clientRequestId`. Clearing a
  non-null `failed_at` there is a separate UPDATE counted as a **visible** change (the plain binding stays
  hidden), so the Retry state disappears as soon as the retry is accepted. `client/turn/requested` with `retryOfRequestId` that aliases an item sets
  `attempt_request_id = requestId` (the alias stays as today).
- `turn/completed {status:'failed'}`: items with `turn_id = turn` still `waiting`/`deferred` get
  `failed_at = event time, read_at = NULL` (enters attention).
- `client/turn/rejected {requestId}` (add to `RELEVANT`): the item whose `request_id` or alias is
  `requestId` and still `waiting` gets the same, and `attempt_request_id = requestId`.
- Live hook `turn.failed` with `inputAccepted=false` and no matching persisted event yet: same update by
  `requestId` through the alias table (idempotent with the line above).
- `failed_at` is cleared (visible change) when the item becomes `answered` or on a new accepted attempt.
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

New: `undoRead`, `keepWaiting`, `setInterim`, `snooze`, `retryTurn`, `workBoardProjects`, `createTask`.
Additive output changes: `markRead`, `markThreadRead` (`batch`, `count`), `save` (`created`).
All mutations invalidate `ITEMS_TAG` + `COUNTS_TAG`.

## Tests (vitest, existing style)

- ingest: failed turn → `failed_at`/attention; A → B(retry) fails → `attempt_request_id` = B; accepted retry
  clears; answered clears; `client/turn/rejected` before acceptance and for a retry; interrupted unchanged;
  failed resolution stays deferred; `INTERIM_RE` RU/EN samples, `answer_source='agent'` ignored;
  acceptance clearing `failed_at` in its own event page returns visible (driver invalidates) while a plain
  acceptance stays hidden (extend the visible-vs-hidden test); `live=false` sets `notify_state=0`, `live=true`
  sets 1; event-time stamping of `answered_at`/`failed_at`.
- server: attention predicate everywhere (counts, list, recipients, markThreadRead); recipients include read
  threads, order, questions filter; markRead all → batch → undoRead, expired; keepWaiting/setInterim; snooze
  bounds, overdue at startup, 30-day timer clamp, several deadlines, dispose with timer pending (fake timers);
  ask options validation; `retryTurn` passes `attempt_request_id`;
  Work Board RPCs with mocked `callRpc` (available, thrown error, `ok:false`).
- driver: drains before reconcile's tracked pass and first-sight backfill pass `live=false` (a 2-minute-old
  downtime answer and a 2-minute-old answer in a newly discovered thread do not push); later drains `live=true`.
- notify: claim consumes every pending row in one transaction; two threads ingested in reverse event order
  both push; equal timestamps in separate transactions both push; overlapping `run()` calls claim once;
  `off → all` no backlog; failed → retry → answered pushes twice; read/replied/snoozed during the 10 s window
  drops it; 20,000-char answer passes a mock that parses the real strict push schema; under `asked` an
  ordinary answer is neither pushed nor summarised; `off → asked` near window end does not revive consumed
  items; a batch whose flush crosses the quiet start is held; summary once; settings change re-arms; `off`
  cancels; quiet-hours schema rejects `24:00`, `12:60`, equal endpoints; missing push plugin.
- app: muted read recipients, "All caught up"; Undo line; quick replies; interim chip; Retry; More menu;
  grouped card marks all members read; search jump loads earlier pages; composer sends via the browser SDK
  (mocked `useSdk`), switch thread during upload and during send, failed send keeps draft, edit after send
  survives, Draft mode passes the Answers `pluginSubmission`; failed recipient preview; snooze menu times (fixed clock);
  save notice with tab already mounted, fresh mount, dedupe hit.
- CLI: digest sections, totals beyond 20, old question answered today counts, old answer pinned today does
  not, `--since` parsing.

## Delegation

Each task runs in its own worktree from `feat/answers` (`.worktrees/answers-f…`), commits on its branch. The
coordinator (Claude) reviews each, merges in the order below, runs `npm test`, `tsc` and a browser check after
every merge, then deploys.

| # | Task | Files it owns | Model (Codex) | Starts after |
|---|------|---------------|---------------|--------------|
| A | Migration, `ATTENTION_SQL`, item schema, F11 ingest + `retryTurn` + `turn.failed` hook, F4 ingest + RPCs, F8 server, F2 server, F1 query, `live` flag + `notify_state` writes, F7 tool + storage, F3 `save.created`, F12 RPCs, contract for all; server/ingest tests | `ingest.ts`, `driver.ts`, `schema.ts`, `contract.ts`, `server.ts`, `cli.ts` (read count) | `gpt-6.1-sol`, medium | — |
| B | F5 `notify.ts` + settings + hooks into driver/ask/wake; F13 digest CLI; notify/CLI tests | `notify.ts`, `cli.ts`, small hook calls in `server.ts` | `gpt-6-sol`, medium | A merged |
| C | Item UI: `isUnread`, More menu, F2 Undo line, F3 notice, F4 chip, F7 buttons, F8 menu, F11 Retry, F12 picker/chip, `members` prop; app tests | `app.tsx`, `empty.tsx` | `gpt-6-sol`, medium | A merged |
| D | Conversation UI: F1 list styling, F6 composer + drafts (browser send), F9 search jump, F10 grouping (uses C's `members`); app tests | `inbox.tsx`, `composer.tsx` | `gpt-6-luna`, high | A merged |
| E | README, SKILL, `INSTRUCTIONS` wording check, version 0.3.0 | docs, `package.json` | `gpt-6-luna`, low | B, C, D merged |

Merge order: A → B → C → D (rebased on C; it consumes `members`) → E. B, C, D work in parallel on A.

## Risks

- Answer pushes duplicate bb's per-thread notifications → default `notify=asked`.
- F6 relies on browser sends not being plugin-stamped; task D verifies this first and stops if not.
- `INTERIM_RE` false positives only add a chip; negatives are today's behaviour.
- `threads.retry` can still refuse (thread moved on); the error is shown.
- Work Board is another plugin's contract; degrade to hidden.
- Timers use server local time; a sleeping laptop fires late (snoozes are consumed on wake/startup).
