# Answers 0.3.0 — attention, notifications, faster replies, integrations

Status: draft for review. Base: branch `feat/answers` at 4cc7f13 (0.2.0, SDK 0.6.132).
Every feature below was accepted by the owner. Behaviour is the spec; file/line hints are guidance.

## SDK facts this plan relies on (verified 2026-11-08)

- Push: built-in plugin `push-notifications` (0.1.0) registers RPC `notifications.send`, input
  `{title: string(1..), body?: string, threadId?: string}` (strict; title cut to 80, body to 180),
  output `{ok:true, channels:[...]}`; empty `channels` = nothing delivered. Call from the server:
  `bb.sdk.plugins.callRpc({pluginId:'push-notifications', method:'notifications.send', input, outputSchema})`
  (same pattern as `plugins/work-board/git-sync/environment-prs.ts`). bb already notifies per thread on
  turn completion (`bb push-notifications thread` levels), so answer pushes can duplicate those.
- Retry: `bb.sdk.threads.retry({threadId, turnRequestId?, sendAt?, reason?})` re-submits a failed turn.
  The retried request carries `retryOfRequestId`, which `ingest.ts` already aliases to the original item.
- Settings: `bb.settings.define({...})` with `type: 'string' | 'boolean' | 'number' | 'select'`
  (`select` has `options` + labels); example `plugins/ci-dashboard/server.ts`.
- Work Board (installed 0.27.3 from `/Users/shaatla/bb-plugins/releases/work-board-0.27.3`; repo copy is
  older — verify against the installed release): RPC `listProjects({folderId?})`,
  `createTask({projectId,title,description,requesterThreadId?(thr_…),...defaults})` →
  `{ok:true, task}` | `{ok:false,...}`.
- No generic toast API for plugin pages; plugin draws its own status bar.
- `experimental_Icon` names must exist in bb's registry (`/Applications/bb.app/.../app/dist/assets/index-*.js`);
  verify every new icon name, fall back to an existing one.

## Cross-cutting: one "needs attention" predicate

Today the unread predicate is copy-pasted in `server.ts` (`counts`, `list` view `unread`, `unreadWhere`,
`markThreadRead`, `markRead`) and `app.tsx` (`isUnread`). F2, F8 and F11 change it, so first move it
into one exported SQL fragment `ATTENTION_SQL(nowParam)` in `ingest.ts` and one client function
`isUnread(item, now)` in `app.tsx`, and use them everywhere. Definition after 0.3:

```
dismissed_at IS NULL AND read_at IS NULL AND (snoozed_until IS NULL OR snoozed_until <= :now) AND (
  (kind='mine' AND status='answered') OR
  (kind='for_me' AND status='open') OR
  (kind='mine' AND status IN ('waiting','deferred') AND failed_at IS NOT NULL))
```

`counts.inbox`, the Inbox recipient counters, the nav badge and `view: unread` all use it.
`counts.unread` stays "answered and unread" (CLI compatibility) but also respects snooze.

## Data model — migration 4 (append-only, one statement string)

```
ALTER TABLE items ADD COLUMN snoozed_until INTEGER;          -- F8
ALTER TABLE items ADD COLUMN failed_at INTEGER;              -- F11
ALTER TABLE items ADD COLUMN likely_interim INTEGER NOT NULL DEFAULT 0;  -- F4
ALTER TABLE items ADD COLUMN options TEXT;                   -- F7, JSON string[] or NULL
ALTER TABLE items ADD COLUMN notified_at INTEGER;            -- F5
ALTER TABLE items ADD COLUMN read_batch TEXT;                -- F2
ALTER TABLE items ADD COLUMN task_key TEXT;                  -- F12
UPDATE items SET notified_at = updated_at;                   -- nothing old is ever pushed
CREATE INDEX items_thread_recent ON items(thread_id, updated_at);
```

`itemSchema` gains `snoozedUntil`, `failedAt`, `likelyInterim: boolean`, `options: string[] | null`,
`taskKey: string | null` (not `notified_at`, `read_batch`). The row→item mapper parses `options` JSON.

## Features

### F1. All conversations in the Inbox list (Telegram-style)

- `recipients` returns every thread that has at least one item with `thread_deleted=0`, not only unread
  ones. Order: threads with attention > 0 first (by `lastAt` desc), then the rest (by `lastAt` desc).
  `lastAt` = max `updated_at` of the thread's items. Cap 200 rows (`shortcut:` comment).
- `questions: true` keeps only threads that have a question item (`kind='for_me' OR QUESTION_SQL`);
  counters then count only those items, as today.
- Preview = newest attention item's text if any, else the newest item's (answer ?? question).
- One query with window functions instead of the current per-row `SELECT` (N+1); keep `selected` handling.
- UI: rows with `unread=0` show no counter and a muted title/preview (`text-muted-foreground`).
  A thin "All caught up" line at the top of the list when no row has attention but the list is not empty;
  the existing empty state stays for a truly empty list.

### F2. Undo for bulk reads; Mark all read covers the whole Inbox

- `markRead({all})` and `markThreadRead` set `read_batch = <random id>` with `read_at`, use the
  attention predicate (so agent questions and failed turns are covered too, matching the Inbox), and return
  `{ok:true, batch: string | null, count: number}` (`batch` null when count is 0). Explicit `markRead({ids})`
  keeps `{ok:true}` plus the same optional fields; it sets `read_batch=NULL`.
- New RPC `undoRead({batch})`: `UPDATE items SET read_at=NULL, read_batch=NULL WHERE read_batch=?`;
  returns `{ok:true, count}`. A batch older than 10 minutes is refused (`Undo expired`).
- UI: a status bar at the bottom of the Answers page (and the thread tab) after a bulk read:
  "Marked N read · Undo", visible 8 s, Undo calls `undoRead`. Not shown for auto-read (read-on-view) or
  single Mark read. Reuse `useTransientText` from `empty.tsx` if it fits.
- CLI `bb answers read --all` prints the count.

### F3. Save to Answers confirms

- After a successful `save`, the message action opens the thread's **My questions** tab
  (`experimental_panel.openTab`, same as the pool action) and the tab shows "Saved to Answers" with a
  link-styled "Show in Saved" for 4 s. Hand-off: the action writes `{id, at}` to localStorage key
  `bb-plugin-answers:saved-flash`; the tab shows the notice when `at` is < 5 s old and clears the key.
- A repeated save of the same text (dedupe hit) says "Already in Saved".
  `save` output becomes `{id, created: boolean}`.

### F4. Interim-looking replies are flagged

- In `turn/completed` (status completed), after the `answered` updates, set `likely_interim=1` on items this
  turn just answered with `answer_source='turn'` when the answer matches `INTERIM_RE` — exported from
  `ingest.ts`, case-insensitive, checked on the last 600 chars of the answer only:
  RU `делегир|доложу|сообщу, когда|отпишусь|вернусь с (ответом|результат)|как (только )?(будет|закончит)|жду (результат|ответ|завершени)`,
  EN `delegat|will report back|i'll (get back|report|follow up)|once (it|they|the \w+) (finish|complete)|waiting (for|on) (the )?(child|sub-?agent|thread|result)`.
  Answers from `answers_resolve` (`answer_source='agent'`) are never flagged.
- UI on a flagged unread/read answered item: a muted chip "Looks like an interim reply" with two actions:
  **Keep waiting** → RPC `keepWaiting({id})`: `status='deferred', interim=answer, interim_seq=answer_seq,
  answer=NULL, answer_seq=NULL, answer_source=NULL, read_at=NULL, likely_interim=0` (only from
  `kind='mine' AND status='answered'`); **It's the answer** → RPC `setInterim({id, value:false})`.
- README "Ограничения" bullet about forgotten `answers_defer` is updated.

### F5. Push notifications

- Settings (`bb.settings.define`):
  - `notify` (`select`): `off` | `asked` (default: agent questions to you) | `questions` (also answers to
    your messages with "?") | `all` (every attention item). Labels in English.
  - `quietHours` (`string`, default empty): `HH:MM-HH:MM` local server time, may wrap midnight; schema-validated.
- Notifier in a new `notify.ts`, called after any write that can create attention (driver invalidation,
  `answers_ask`, snooze wake-ups from F8):
  candidates = attention items with `notified_at IS NULL` matching the `notify` level. Mark them
  `notified_at=now` first (in one transaction), then send — never resend, never backfill.
- First sight of a thread (the desc backfill in `driver.ts drain`) marks its new items `notified_at=now`
  so discovery after install/restart never pushes history.
- Coalescing: candidates collected within 10 s go out as one push. One item: title = thread title (≤80),
  body = question for `for_me` / answer for `mine`, collapsed whitespace; `threadId` set. Several items:
  title "N new in Answers", body = up to 3 thread titles; `threadId` only if all items share it.
- Quiet hours: during the window nothing is sent; candidates are still marked notified but counted; at the
  window end one summary push "While you were away: N new in M threads" (no threadId) if N > 0 and they
  are still attention items. Timer is `unref()`'d and cleared on dispose.
- `push-notifications` missing/disabled or `channels: []`: log once at debug level, no retries.
- Tests mock `bb.sdk.plugins.callRpc` and the clock.

### F6. Reply from the Inbox without quoting

- A composer pinned to the bottom of the open conversation (reuse `Composer` from `composer.tsx`, with
  `SendButton` modes and attachments). Draft text/files stored per thread in localStorage
  (`bb-plugin-answers:page:compose` = `{[threadId]: {text, files}}`, entries removed on send).
- New RPC `send({threadId, text(1..8000), attachments?, send?})` → `guarded()` + `deliver()` (no quote,
  no `Re:` prefix). It does not change item state; the message is ingested as a new question like any chat
  message. After send the conversation scrolls to the bottom.
- The quote popup still works; the bottom composer is hidden while the popup is open.
- Mobile: composer stays visible above the keyboard (sticky bottom inside the scroll column).

### F7. Quick replies to agent questions

- `answers_ask` gains `options?: string[]` (1–6 items, each trimmed 1–80 chars, unique). Stored in
  `items.options` as JSON. Tool description and `INSTRUCTIONS` mention it (keep `INSTRUCTIONS` ≤ 600 chars).
- UI: an open `for_me` item with options shows them as small buttons under the question; click →
  existing `reply({id, text: option})`. A free-text Reply stays available. After reply the buttons disappear
  (status `replied`).
- `answers_list`/CLI unaffected.

### F8. Remind me later (snooze)

- RPC `snooze({id, until: number | null})`: `until` must be in (now, now+30 days]; `null` unsnoozes.
  Snoozing also sets `read_at=NULL` so the item returns as unread; allowed for any non-saved item.
- Snoozed items (`snoozed_until > now`) are not attention (predicate above); in conversations and History
  they show "Snoozed until <time>" and an **Unsnooze** action; read-on-view does not mark them.
- Wake-ups: server keeps one `setTimeout` to the nearest future `snoozed_until` (recomputed at startup and
  after every snooze change; unref; cleared on dispose); on fire → `invalidate()` and run the notifier
  (woken items count as new candidates: set `notified_at=NULL` on wake).
- UI: action "Remind later" with a menu: In 1 hour, This evening (18:00 today; if past, +3 h), Tomorrow 9:00,
  Next Monday 9:00 — computed on the client in local time.

### F9. Search in the open conversation

- A search button in the conversation header (and on desktop the header row) opens an input; results come
  from `list({view:'all', threadId, query, limit: 20})`, shown as a dropdown (question snippet + date).
- Picking a result: if the item is loaded, scroll it into view below the sticky header and flash it
  (`data-flash` with a 1.5 s background fade); otherwise raise `depth` page by page (max 20 pages) until it
  is loaded, then scroll. If still not found, show "Older than loaded history — open in chat" with the
  existing open-in-chat link. Esc closes the search. Jumping releases the open-position pin.

### F10. Several questions, one answer

- In the Inbox conversation, consecutive `kind='mine'` items with the same non-null `turnId` and the same
  non-null `answerSeq` render as one card: all question bubbles in order, then the answer once.
- Read state of the group = all members; read-on-view and Mark read act on all member ids. Pin / Save /
  quote / reply act on the last member. The ✓✓ mark shows when every member is read.
- History and the thread tab are unchanged.

### F11. Failed turns can be retried

- Ingest: on `turn/completed` with `status='failed'`, items of that turn (`turn_id=turn OR resolve_turn_id=turn`)
  still `waiting`/`deferred` get `failed_at=now, read_at=NULL` (visible change → refetch).
  `failed_at` is cleared when the item becomes `answered`, and on `turn/input/accepted` for its request or
  an alias (the retry). Interrupted turns keep today's behaviour (no `failed_at`).
- Failed items are attention (predicate above) so they appear in the Inbox.
- UI: such items show "Turn failed" (destructive text) and **Retry** → RPC `retryTurn({id})` →
  `bb.sdk.threads.retry({threadId, turnRequestId: item.request_id})`; errors are shown as returned
  ("thread moved on" etc.). **Stop waiting** stays available.

### F12. Create a Work Board task from an item

- RPC `workBoardProjects({})` → `{available: boolean, projects: {id, name, prefix?}[]}` via
  `callRpc(work-board, listProjects)`; any error → `available:false`.
- RPC `createTask({id, projectId})` → `callRpc(work-board, createTask, {projectId, title, description,
  requesterThreadId})`: title = first line of the question (≤120 chars); description = question, answer if any,
  and a link back `[Open thread](/threads/<threadId>)` (project-qualified when known). Stores the returned
  task key in `items.task_key`; returns `{key}`. `{ok:false}` → error with its message.
- UI: action "Create task" (hidden when `available` is false; cached query). Opens a small project picker;
  last choice remembered in localStorage. Items with `taskKey` show a chip linking to
  `/plugins/work-board/work-board/task/<KEY>`.

### F13. Digest for automations

- CLI `bb answers digest [--since 24h|7d|<ISO date>] [--json]` (default 24h): Markdown with sections
  **New answers** (answered since, unread first), **Still waiting** (incl. failed), **Asked of you** (open),
  each line `thread title — snippet (age)`; capped at 20 lines per section with "+N more".
  `--json` returns the three arrays of items. Read-only; no item state changes.
- README shows how to schedule it with the automations plugin.

## RPC summary (contract.ts; existing methods keep their inputs)

New: `undoRead`, `keepWaiting`, `setInterim`, `send`, `snooze`, `retryTurn`, `workBoardProjects`,
`createTask`. Changed outputs (additive): `markRead`, `markThreadRead` (`batch`, `count`), `save` (`created`).
All mutations invalidate `ITEMS_TAG` + `COUNTS_TAG`; `send` also refreshes nothing else.

## Tests (vitest, existing style)

- ingest: failed turn sets `failed_at` and attention; retry alias clears it; answered clears it; interrupted
  unchanged; `INTERIM_RE` flags RU and EN samples, ignores `answer_source='agent'` and plain answers.
- server: attention predicate (snooze, failed, for_me); recipients include read threads, ordering, questions
  filter; markRead all → batch → undoRead restores, expired batch refused; keepWaiting/setInterim; snooze
  bounds and wake timer (fake timers); send uses deliver; answers_ask options validation and storage;
  retryTurn calls `threads.retry` with request id; Work Board RPCs with mocked `callRpc` (available, error,
  `ok:false`); notifier levels, never re-sends, backfill marked, coalescing, quiet hours summary, missing plugin.
- app: muted read recipients and "All caught up"; Undo bar; quick reply buttons; Keep waiting chip; Retry;
  grouped card marks all members read; search jump loads earlier pages; composer sends and clears draft;
  snooze menu computes times (fixed clock).
- CLI: digest sections and `--since` parsing.

## Delegation

Each task runs in its own worktree from `feat/answers` (`.worktrees/answers-f…`), commits on its branch;
the coordinator (Claude) reviews, merges into `feat/answers`, deploys and checks in the browser.

| # | Task | Model (Codex) | Depends on |
|---|------|---------------|------------|
| A | Migration 4, attention predicate refactor, item schema fields, F11 ingest + `retryTurn`, F4 ingest + `keepWaiting`/`setInterim`, F8 server (`snooze`, wake timer), F2 server (`batch`, `undoRead`), F1 `recipients` query; server/ingest tests | `gpt-6.1-sol`, medium | — |
| B | F5 notifier + settings (`notify.ts`), driver backfill marking; tests | `gpt-6-sol`, medium | A |
| C | UI for F1, F2, F4, F8, F11 (+ `isUnread(item, now)` client side); app tests | `gpt-6-sol`, medium | A |
| D | F6 `send` RPC + bottom composer, F7 options (tool, storage, buttons), F3 save confirmation; tests | `gpt-6-luna`, medium | A |
| E | F9 search jump, F10 grouping; app tests | `gpt-6-sol`, medium | C |
| F | F12 Work Board RPCs + UI, F13 digest CLI, README/SKILL/INSTRUCTIONS, version 0.3.0; tests | `gpt-6-luna`, medium | A, D |

B, C, D run in parallel after A; E after C; F after D. Conflicts in `app.tsx`/`inbox.tsx` are expected
between C, D, E: D touches only `composer.tsx`, the conversation footer and `ItemCard`'s `for_me` block;
C owns `ItemCard` actions and the recipient list.

## Risks

- Answer pushes duplicate bb's own per-thread turn notifications → default `notify=asked`.
- `INTERIM_RE` false positives only add a chip; false negatives are today's behaviour.
- `threads.retry` refuses when the thread moved on; the error is shown as is.
- Work Board contract is another plugin's; validate its output with a local schema and degrade to hidden.
- More columns in `list` payloads: `options` only for `for_me`; others are small scalars.
- Snooze/quiet-hours timers use server local time; a sleeping laptop fires them late, which is acceptable.
