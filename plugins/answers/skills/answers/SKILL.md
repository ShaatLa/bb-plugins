---
name: answers
description: Track user questions, later answers, non-blocking questions for the user, and saved chat messages.
---

# Answers

Answers tracks user messages across threads (except plugin-sent messages and agent-spawned threads) and pairs them with the final reply from a successfully completed turn. It also tracks small non-blocking questions agents ask the user and messages the user saves manually.

When the answer will arrive in a later turn, such as after delegated work, call `answers_defer`. When a later turn delivers the answer, call `answers_list`, then `answers_resolve`; put the answer in that turn's final message. Use `answers_ask` for a small non-blocking question to the user. Keep blocking decisions in Work Board.

CLI:

- `bb answers list [--view unread|waiting|for_me|pinned|saved|all] [--thread ID] [--json]`
- `bb answers read <ids...> | --all [--thread ID]`
- `bb answers status`

Statuses: `mine` items are `waiting`, `deferred`, or `answered`; `for_me` items are `open` or `replied`; saved items have status `saved`.
