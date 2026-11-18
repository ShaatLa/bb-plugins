---
name: answers
description: Track user questions, later answers, non-blocking questions for the user, and saved chat messages.
---

# Agent Hub

Agent Hub tracks user messages across threads (except plugin-sent messages and agent-spawned threads) and pairs them with the final reply from a successfully completed turn. It also tracks small non-blocking questions agents ask the user and messages the user saves manually.

When the answer will arrive in a later turn, such as after delegated work, call `answers_defer`. When a later turn delivers the answer, call `answers_list`, then `answers_resolve`; put the answer in that turn's final message. Use `answers_ask` to ask the user a question, including a decision that blocks your work. Do not wait for the reply in the same turn: end the turn, and the reply arrives as a new user message that quotes the question. Optional `options` accepts 1–6 unique quick replies of up to 200 characters; `recommended` must equal one option and `reason` (up to 300 characters) explains it. A decision about a specific Work Board task belongs on that task, where it stays recorded with the card.
As a safety net, a turn that answers while sub-sessions it started itself are still running is deferred automatically, and once the last of them reports, the plugin keeps waiting if sub-sessions started by the turns their reports woke (a later wave) still run, otherwise your latest report answers the question; explicit `answers_defer`/`answers_resolve` calls always win.

When handing work to the owner (ready for review, decisions awaiting them), call `answers_report` in that turn. Also use it for a completed result the owner awaits when no question is pending. Ask questions through `answers_ask` or the Work Board card, then end the turn.

With `handoffWarnings` enabled (default), a live top-level completion that misses the matching explicit channel receives an `[answers]` plugin warning in the same thread. Archived threads and backfilled completions never warn. The warning-triggered reply never warns again and stays read without push unless you call `answers_report` or `answers_ask`. Existing handoff guessing and **Asked in chat** filing remain as a safety net.

CLI:

- `bb answers list [--view unread|waiting|for_me|pinned|saved|all] [--thread ID] [--json]`
- `bb answers read <ids...> | --all [--thread ID]`
- `bb answers status`
- `bb answers digest [--since 24h|7d|ISO-date] [--json]`

Statuses: `mine` items are `waiting`, `deferred`, or `answered`; `for_me` items are `open` or `replied`; `update` items (the final message of a top-level turn that answered nothing of the user's: a child finished, another thread or a plugin wrote) are `answered`; saved items have status `saved`. Consecutive `update` items that ask nothing collapse into one "N background updates" group in the conversation, carry no unread state and are never pushed; an update that ends a phrase with `?` (outside code, links and quotes) or hands work to the user ("EXA-1 готова к вашей проверке", "ready for your review") has `asks: true` and stays a separate, pushed message — so end a message with a question only when you need the user's answer.

Where the user sees things (name these places when you point the user to them; there is no "Inbox" any more): the Agent Hub page has a **Chats | Questions | Saved** switch (Saved lists messages kept with Save). **Questions** stacks every open `answers_ask` question and every pending bb question form from all threads, oldest first, so the user can answer them in one place; questions written only in the final chat reply also appear as **Asked in chat**, as a safety net. The same open questions also show as a **Questions for you** card above the composer of that thread, in bb's chat and in the Chats conversation, so the user can answer where the chat is open. **Chats** lists contacts (threads) and each one's conversation: the user's messages, your answers and updates, oldest to newest. In a thread, the **My questions** side-panel tab shows the same for that thread, with reply pools above.

A script or background process that wakes its own thread with `bb thread tell` must start the text with a `[tag]` (a letter first, 3–60 characters, then a space), e.g. `[merge-queue watcher] …`; bb records such messages as the user's, and without the tag Agent Hub treats them as the user's questions.

Reply pools: the user collects quotes from answers (Add to reply pool in the send menu of the quote and comment popups) and sends them as one message. Quote limit: 20,000 characters; note: 8,000; combined pool message: 32,000. On uncertain delivery, check the thread before retrying; never auto-resend.

Channel detection is project-specific: `channelCommands` defaults to `["work-board question add"]`. Commands containing any configured fragment count as an explicit question channel; `answers_ask` always counts. Threads without a project use the default. This detection does not prescribe where agents must ask questions.

```sh
bb answers config get [<key>] [--project <id>] [--json]
bb answers config set <key> <value> [--project <id>] [--json]
```

Omit `--project` for global preferences; include it for project settings (currently only `channelCommands`, CLI/RPC only). With no key, `get` lists that scope; with a key it returns only its value. `set` returns the stored value.
RPC: `config.get {projectId?, key?}`, `config.set {projectId?, key, value}`. Existing whole-object preference RPCs remain available. Global changes use the settings page’s validation and live-change path. Unknown keys list valid keys. Booleans and numbers accept JSON literals; selects and quiet hours accept strings. `channelCommands` accepts a JSON array of non-empty strings (including `[]` to disable extra channels) or a comma-separated list.
