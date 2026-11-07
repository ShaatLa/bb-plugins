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
5. Agent message formatting is preserved, both in the Inbox (host `Markdown`, the
   chat renderer) and **inside quotes**: do it the way bb's own chat "Add to chat"
   selection action does. bb (thread-detail bundle) takes the single selection range,
   clips it to the message body node and serializes the range to **Markdown**
   (`ig(range, node, "markdown")`), then quotes that into the composer. That
   serializer is internal (not in SDK 0.6.132), so the plugin does the same with
   `turndown` (headings, lists, code spans/blocks, bold/italic, links, blockquotes)
   on a reconstructed fragment, mirroring what bb's `ig` does:
   - clip the range to the message body node;
   - `range.cloneContents()`, then re-wrap it in shallow clones of every formatting
     ancestor between `range.commonAncestorContainer` and the body (`strong`, `em`,
     `a` with `href`, `code`, `pre`, `li`/`ol` with its `start`/`ul`, `blockquote`,
     `h1`–`h6`), so a selection wholly inside bold/link/code keeps it and a partial
     list keeps its list context and numbering;
   - drop renderer chrome from the fragment (`button`, `[aria-hidden="true"]`,
     `[data-copy]`/copy controls, `svg`).
   Fallback when conversion throws or yields empty: the clipped range's `toString()`.

## Data model (migration 2, append-only)

```sql
CREATE TABLE pool_entries (
  id          TEXT PRIMARY KEY,           -- "pool_" + random
  thread_id   TEXT NOT NULL,
  quote       TEXT NOT NULL,              -- Markdown, ≤ 20,000 chars (an answer's cap)
  quote_seq   INTEGER,                    -- message seq the quote came from, if known
  item_id     TEXT,                       -- source Answers item, if any
  note        TEXT NOT NULL DEFAULT '',   -- user's reply to this quote, ≤ 8,000
  revision    INTEGER NOT NULL DEFAULT 0, -- bumped by every poolUpdate
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
- `poolAdd({ threadId, quote ≤ 20,000, quoteSeq?, itemId?, note? })` → `{ id }`.
  Rejects deleted/unknown threads (`threads.get`). Oversized quotes are rejected with
  a visible error, never truncated silently.
- `poolUpdate({ id, note, revision })` → `{ revision }` (optimistic: rejects a stale
  `revision`), `poolRemove({ id })`.
- `poolSend({ threadId })` → `{ delivery, sent, keptEdited }`: inside the thread's send
  guard, snapshot the entries as `(id, revision, quote, note, item_id)`, build one
  message, `threads.send` mode `auto`; after success, in **one transaction** delete
  `WHERE id = ? AND revision = ?` for each snapshot row and apply the `for_me`
  status updates below. Rows edited during the send survive and are reported as
  `keptEdited` ("N edited entries were not sent"). A send error keeps every entry and
  surfaces "Delivery uncertain — check the thread before retrying"; never auto-resend.
  Total message ≤ 32,000 chars, else reject before sending (user splits the pool).
- `quoteReply({ threadId, quote ≤ 20,000, text, itemId? })` → `{ delivery }` — the
  popup's immediate **Send**; same format with one entry, same guard and errors.
- **One send guard for all three paths.** `reply`, `quoteReply` and `poolSend` share
  an in-memory guard keyed by thread id (replacing 0.1.0's per-item set): a second send
  to the same thread while one is in flight is rejected ("A reply to this thread is
  already sending"). Source-item checks run inside the guard: a `for_me` item that is
  already `replied` makes `reply` fail as today; `quoteReply`/`poolSend` still send
  (they are follow-ups) but do not change it.
- `for_me` linkage: after a successful `quoteReply`/`poolSend`, each referenced `for_me`
  `open` item of that thread becomes `replied` with `answer_source = 'user'` and
  `answer` = the notes of the sent entries that reference it, joined by a blank line
  (the quote alone when every such note is empty), in the same transaction.

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
  - Right: an Inbox history component for the selected recipient. It loads the newest
    page (`list({ view: 'all', threadId, limit: 50 })`, newest-first from the server),
    renders it reversed (oldest→newest, like a chat) scrolled to the bottom; a
    "Load earlier" control at the top fetches `nextCursor` and **prepends** that page
    (reversed), keeping the viewport anchored by adjusting `scrollTop` by the added
    height. Live updates (tag invalidation) refetch the newest page only and merge by
    id. Bubbles (question bubble as the user, answer/interim via
    `Markdown` as the agent; `for_me` question as the agent with a "Question for you"
    label). Card actions stay (Open in chat, Pin, Done, Reply).
  - Selection popup, modelled on bb's chat selection menu (floating, anchored to the
    selection rect, `sideOffset` 6, collision padding, does not steal focus on open):
    on `mouseup`/`keyup` inside a message body (answer, interim or `for_me` question),
    if `getSelection()` is one non-collapsed range, clip it to that body (like bb),
    convert it to Markdown and **snapshot** `{ threadId, itemId, quote, quoteSeq, rect }`
    — `quoteSeq` is the seq of the selected body (`answerSeq`, `interimSeq` or
    `questionSeq`). From then on the popup owns the draft and no longer depends on the
    live selection or DOM: it survives focus moving into its textarea, query refreshes
    and recipient switches. It closes only on Esc, its Close button, a successful
    action, or focus/pointer leaving the whole popup (`focusout` whose `relatedTarget`
    is outside it — clicking its own buttons does not close it). Contents: the quote
    preview, textarea (Cmd+Enter = Send), **Send** (`quoteReply`), **Add to pool**
    (`poolAdd`). Pending state disables the buttons; on failure the text is kept and
    the error shown in the popup. Quotes over 20,000 chars show an error instead.
- Keep the 0.1.0 side-panel restore hook.

### Right side panel tab "Reply pools"

`experimental_tab({ context: { kind: 'nav-panel', panelId: 'answers' },
availability: 'fixed', id: 'pools', title: 'Reply pools', icon: 'Sent' })`.

- Stacked pools (thread title header with link to the thread, entry count), each entry:
  quote (rendered with `Markdown` as a blockquote, clamped, expandable), editable note
  (textarea with local draft state, saved by `poolUpdate` on blur and after 800 ms of
  idle typing, carrying the last known `revision`; shows "Saving…/Saved/Not saved"),
  remove button. Footer per pool: **Send all**: first flush and **await** every dirty
  note of that pool; if any save fails, abort the send and keep the drafts; only then
  `poolSend` (pending state; result "Sent"/"Queued", the `keptEdited` notice, or the
  uncertain-delivery error). A stale-`revision` rejection reloads the entry and keeps
  the local draft for the user to re-apply.
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

- server: migration 2; revision bump and stale-revision rejection; `poolSend` keeps
  rows edited mid-send (`keptEdited`) and commits deletes + `for_me` updates together;
  the shared thread guard across `reply`/`quoteReply`/`poolSend`; `for_me` answer from
  several entries; `recipients` grouping, ordering, `selected` kept with 0 unread,
  `for_me` read semantics; `markThreadRead`; pool CRUD + ordering; message builder
  (multi-line quotes, empty notes, length cap); `poolSend` deletes only the snapshot
  ids, keeps entries on send failure, rejects concurrent sends; `quoteReply` and
  `for_me` → `replied`; deletion removes pools; invalidation of the pools tag.
- app: selection→Markdown on real jsdom DOM ranges (selection fully inside bold, link,
  inline code; partial ordered list keeps numbering; chrome dropped; fallback);
  popup draft survives textarea focus, own-button clicks and refreshes, closes on Esc
  and outside focus; Send all awaits a delayed note save and aborts on a failed one;
  Inbox history prepends older pages in order;
  Inbox renders recipients, selecting marks read and keeps the row until another
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
- In the chat, `messageAction` receives bb's `selectedText`; use it as-is.
- Markdown reconstruction from rendered HTML can differ from the agent's source in
  edge cases (tables, math); the quote still reads correctly. `turndown` is a new
  runtime dependency (~10 kB).
