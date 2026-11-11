---
name: answers
description: Track user questions, later answers, non-blocking questions for the user, and saved chat messages.
---

# Answers

Answers tracks user messages across threads (except plugin-sent messages and agent-spawned threads) and pairs them with the final reply from a successfully completed turn. It also tracks small non-blocking questions agents ask the user and messages the user saves manually.

When the answer will arrive in a later turn, such as after delegated work, call `answers_defer`. When a later turn delivers the answer, call `answers_list`, then `answers_resolve`; put the answer in that turn's final message. Use `answers_ask` to ask the user a question, including a decision that blocks your work. Do not wait for the reply in the same turn: end the turn, and the reply arrives as a new user message that quotes the question. Optional `options` accepts 1–6 unique quick replies of up to 200 characters; `recommended` must equal one option and `reason` (up to 300 characters) explains it. A decision about a specific Work Board task belongs on that task, where it stays recorded with the card.

CLI:

- `bb answers list [--view unread|waiting|for_me|pinned|saved|all] [--thread ID] [--json]`
- `bb answers read <ids...> | --all [--thread ID]`
- `bb answers status`
- `bb answers digest [--since 24h|7d|ISO-date] [--json]`

Statuses: `mine` items are `waiting`, `deferred`, or `answered`; `for_me` items are `open` or `replied`; saved items have status `saved`.

The Answers page defaults to Inbox: unread answers and open questions for the user grouped by recipient thread. Opening a recipient marks its items read and retains that recipient while selected. History is oldest to newest; Load earlier preserves the reading position. Waiting, For me, Pinned, Saved and All retain search and project filters.

Selecting agent text in Inbox opens a Markdown quote draft under the selection. Send calls quoteReply immediately; Add to pool saves the quote and note and opens Reply pools. The draft survives refreshes and recipient changes until closed, outside focus/pointer, Esc or a successful action. In regular chat, Add to reply pool uses selected text or the whole message and opens My questions.

Reply pools are stacked by recipient in the Answers side panel and appear above items in My questions. Notes autosave after 800 ms idle or blur, with optimistic revisions. Send all first awaits dirty note saves and aborts on save failure. Edited entries retained during delivery are reported and kept. On uncertain delivery, check the thread before retrying; never auto-resend. Quote limit: 20,000 characters; note: 8,000; combined pool message: 32,000. Oversized content is rejected rather than truncated.
