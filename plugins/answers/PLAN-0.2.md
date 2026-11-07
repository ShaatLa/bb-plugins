# Answers 0.2.0 — inbox by recipient and quoted reply pools

Builds on 0.1.0 (`PLAN.md`, shipped code in this folder). Not shipped (excluded from `files`).

## Goal (owner decisions)

1. The Answers page gets a Telegram-like **Inbox**: a narrow left column of
   recipients (threads) that have something unread, the selected recipient's
   messages on the right.
   - A recipient is listed while it has an unread answer (`mine`, `answered`,
     `read_at IS NULL`) or an unread open question for me (`for_me`, `open`,
     `read_at IS NULL`).
   - Opening a recipient marks all of its items read, but it **stays listed while
     selected**; it disappears when the user selects another recipient or leaves the page.
   - The old views stay as a switch: **Inbox** (default) · Waiting · For me · Pinned ·
     Saved · All. Non-Inbox views keep the current card list.
2. **Quote-reply.** Selecting text inside an agent message on the right shows a popup
   under the selection: textarea + **Send** (immediately) + **Add to pool**.
3. **Reply pools** live in the page's right side panel (a fixed nav-panel tab
   "Reply pools"). Pools accumulate per recipient and are shown stacked, all at once;
   each pool lists entries in the order they were added, each pool has one
   **Send all** button that sends a single message with every quote + note.
4. **From the regular bb chat** too: bb's message action (also offered in the
   assistant-message text-selection menu) "Add to reply pool" adds the selected text
   (or the whole message) to that thread's pool.
5. Agent message formatting is preserved in the Inbox (host `Markdown`, the chat
   renderer). Known limit: a quote is the selection's plain text
   (`Selection.toString()`), so lists/code/bold inside the quote become plain lines.

## Data model (migration 2, append-only)

```sql
CREATE TABLE pool_entries (
  id          TEXT PRIMARY KEY,           -- "pool_" + random
  thread_id   TEXT NOT NULL,
  quote       TEXT NOT NULL,              -- ≤ 4,000 chars, plain text
  quote_seq   INTEGER,                    -- message seq the quote came from, if known
  item_id     TEXT,                       -- source Answers item, if any
  note        TEXT NOT NULL DEFAULT '',   -- user's reply to this quote, ≤ 8,000
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX pool_thread ON pool_entries(thread_id, created_at);
```

`thread.deleted` / authoritative removal deletes the thread's pool entries.

## RPC additions (`contract.ts`; existing methods unchanged)

New tag `answers:pools`. Every pool write invalidates it (and items/counts when items change).

- `recipients({ selected? })` → `{ recipients: { threadId, threadTitle, projectId,
  projectName, unread, lastAt, preview }[] }` — threads with unread answers or unread
  open `for_me`, newest `lastAt` first, ≤ 100. `selected` (a thread id) is always
  included even with `unread = 0`, so the open recipient does not vanish while
  viewed. `preview` = first 160 chars of the newest unread answer/question. Tagged items.
- `markThreadRead({ threadId })` — sets `read_at` on that thread's `mine` answered
  and `for_me` open items with `read_at IS NULL`.
- `counts()` gains `inbox` = unread answers + unread open `for_me`. The nav badge
  switches to `inbox` (label "N unread answers and questions").
- `pools()` → `{ pools: { threadId, threadTitle, projectId, entries: PoolEntry[] }[] }`,
  pools ordered by their oldest entry, entries by `created_at`.
- `poolAdd({ threadId, quote, quoteSeq?, itemId?, note? })` → `{ id }`.
  Rejects deleted/unknown threads (`threads.get`).
- `poolUpdate({ id, note })`, `poolRemove({ id })`.
- `poolSend({ threadId })` → `{ delivery, sent: number }`: builds one message from the
  thread's entries (snapshot of ids taken before sending), `threads.send` mode `auto`,
  then deletes exactly those entry ids. In-flight guard per thread (in memory, like
  `reply`); a send error keeps the entries and surfaces "Delivery uncertain — check the
  thread before retrying"; never auto-resend. Total message ≤ 32,000 chars, else reject
  with a clear error (user splits the pool).
- `quoteReply({ threadId, quote, text, itemId? })` → `{ delivery }` — the popup's
  immediate **Send**; same format with one entry, same guard and error semantics.
  If `itemId` is a `for_me` `open` item of that thread, mark it `replied` like `reply`.
  `poolSend` does the same for entries whose `item_id` is such an item.

Message format (Markdown, as bb renders it):

```
> quoted line 1
> quoted line 2

note text

> next quote

next note
```

Quote lines are prefixed `> ` (empty lines become `>`); an entry with an empty note
sends just the quote. Ingestion already ignores these sends (`originPluginId`).

## UI

### Answers page (`navPanel` component)

- Header row: view switch (Inbox default), search + project filter only for non-Inbox
  views (Inbox has no filters in 0.2.0).
- **Inbox** layout: CSS grid `[minmax(220px, 280px) 1fr]`, both columns scroll
  independently; on narrow widths (< 640 px) show one column at a time with Back.
  - Left: recipient rows (title, project, unread count badge, relative time,
    1-line preview), keyboard navigable (`role="listbox"`/`option`, arrows + Enter).
    Selecting a row calls `markThreadRead`; selection kept in component state.
    Empty state: "No unread answers".
  - Right: the selected recipient's items (`list({ view: 'all', threadId })`), shown
    oldest→newest like a chat (question bubble as the user, answer/interim via
    `Markdown` as the agent; `for_me` question as the agent with a "Question for you"
    label). Card actions stay (Open in chat, Pin, Done, Reply).
  - Selection popup: on `mouseup`/`keyup` inside an agent message body, if
    `getSelection()` is non-empty and within one message, show a popover anchored under
    the selection rect (fixed position, clamped to viewport) with textarea
    (Cmd+Enter = Send), **Send** (`quoteReply`), **Add to pool** (`poolAdd` with
    `quoteSeq = answerSeq`, `itemId`), Esc/blur closes. Pending state disables buttons.
- Keep the 0.1.0 side-panel restore hook.

### Right side panel tab "Reply pools"

`experimental_tab({ context: { kind: 'nav-panel', panelId: 'answers' },
availability: 'fixed', id: 'pools', title: 'Reply pools', icon: 'Sent' })`.

- Stacked pools (thread title header with link to the thread, entry count), each entry:
  quote (blockquote style, clamped, expandable), editable note (textarea, saved on blur
  via `poolUpdate`), remove button. Footer per pool: **Send all** (`poolSend`, pending
  state, result "Sent"/"Queued" or the uncertain-delivery error).
- Empty state: "Select text in an answer and choose Add to pool."
- When the popup's Add to pool succeeds, the page opens this tab
  (`experimental_useAppPanel().openTab({ tab: { id: 'pools', context: { kind: 'nav-panel',
  panelId: 'answers' }, availability: 'fixed' } })`).

### Thread view

- New `messageAction` "Add to reply pool" (icon `Sent`): `poolAdd({ threadId,
  quote: selectedText ?? message.text, quoteSeq: message.experimental_messageSeq })`,
  then opens the thread's "My questions" tab via `context.experimental_panel.openTab`.
- The thread tab "My questions" shows this thread's pool (same pool component, filtered)
  above the item list, so notes can be written right in the thread.
- "Save to Answers" stays.

## Tests

- server: migration 2; `recipients` grouping, ordering, `selected` kept with 0 unread,
  `for_me` read semantics; `markThreadRead`; pool CRUD + ordering; message builder
  (multi-line quotes, empty notes, length cap); `poolSend` deletes only the snapshot
  ids, keeps entries on send failure, rejects concurrent sends; `quoteReply` and
  `for_me` → `replied`; deletion removes pools; invalidation of the pools tag.
- app: Inbox renders recipients, selecting marks read and keeps the row until another
  is selected; selection popup Send / Add to pool (mock `getSelection`); pools tab
  renders stacked pools, edits note, Send all pending state; message action calls
  `poolAdd`.
- `npm run typecheck && npm test && npm run build` green.

## Delegation

| # | Task | Model | Depends on |
|---|------|-------|------------|
| D | Migration 2, RPC additions, message builder, server tests, contract | `gpt-6.1-sol`, medium | — |
| E | Inbox layout, selection popup, Reply pools tab, message action, thread tab pool, app tests, README/SKILL updates, version 0.2.0 | `gpt-6.1-sol`, medium | D merged |

Terra is skipped: in 0.1.0 it stopped twice without a blocker.

## Risks

- `experimental_tab` for nav panels and `experimental_useAppPanel` are experimental APIs.
- Selection inside host `Markdown` relies on plain DOM selection in the plugin page.
- Plain-text quotes lose inner formatting (accepted).
