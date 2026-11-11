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

Statuses: `mine` items are `waiting`, `deferred`, or `answered`; `for_me` items are `open` or `replied`; `update` items (the final message of a top-level turn that answered nothing of the user's: a child finished, another thread or a plugin wrote) are `answered`; saved items have status `saved`. Consecutive `update` items that ask nothing collapse into one "N agent updates" group in the conversation, count as one unread per thread and are never pushed; an update that ends a phrase with `?` (outside code, links and quotes) has `asks: true` and stays a separate, pushed message — so end a message with a question only when you need the user's answer.

Where the user sees things (name these places when you point the user to them; there is no "Inbox" any more): the Answers page has a **Chats | Questions** switch. **Questions** stacks every open `answers_ask` question and every pending bb question form from all threads, oldest first, so the user can answer them in one place; questions written only in chat text never get there. **Chats** lists contacts (threads) and each one's conversation: the user's messages, your answers and updates, oldest to newest. In a thread, the **My questions** side-panel tab shows the same for that thread, with reply pools above.

A script or background process that wakes its own thread with `bb thread tell` must start the text with a `[tag]` (a letter first, 3–60 characters, then a space), e.g. `[merge-queue watcher] …`; bb records such messages as the user's, and without the tag Answers treats them as the user's questions.

Reply pools: the user collects quotes from answers (Add to reply pool in the send menu of the quote and comment popups) and sends them as one message. Quote limit: 20,000 characters; note: 8,000; combined pool message: 32,000. On uncertain delivery, check the thread before retrying; never auto-resend.
