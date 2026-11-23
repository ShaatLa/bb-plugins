---
name: agent-hub
description: Track user questions, later answers, non-blocking questions for the user, and saved chat messages.
---

# Agent Hub

Agent Hub tracks user messages across threads (except plugin-sent messages and agent-spawned threads) and pairs them with the final reply from a successfully completed turn. It also tracks small non-blocking questions agents ask the user and messages the user saves manually.

## Rules for agents

Where the plugin can check a rule it does, and the refusal or warning names the fix.

- **Later answer.** When the answer will arrive in a later turn (delegated work), call `agent_hub_defer`; without `id` it defers this thread's newest waiting message. When the answer arrives, call `agent_hub_list`, then `agent_hub_resolve` with the listed `id` (required) and put the answer in that turn's final message. An id that is not a waiting or deferred message of this thread is refused.
- **Owner decisions.** You must ask with `agent_hub_ask`, then end the turn; never put the question in your chat text (a chat question earns an `[agent-hub]` warning). Do not wait in the same turn: the reply arrives as a new user message quoting the question. A decision about a specific Work Board task belongs on that task, where it stays recorded with the card.
  - One question: `question`, plus optional `options` (1–6 unique, up to 200 characters each), `multiSelect` (needs `options`), `recommended` (must equal one option) and `reason` (up to 300 characters, explains `recommended`, so it needs `recommended`). Example: `{question: "Which database?", options: ["SQLite", "Postgres"], recommended: "SQLite", reason: "No server to run"}`.
  - Several related decisions: `questions` (2–10 parts, each with its own `question`, `header`, `options`, `multiSelect`, `recommended`) instead of `question`; `question` is then only the form title and may be left out. Asks in the same turn merge into one form of up to 10 parts.
  - `urgency`: `blocking`, `normal` or `low` (no push). `deadlineMinutes` (optional integer 5–10080) answers with `recommended` if the owner does not reply; on a single question it needs `recommended`, and a part without `recommended` defaults to Your call.
- **Handoff.** With no pending question, call `agent_hub_report` in the same turn when you deliver a result the owner awaits or hand work to the owner (ready for review, decisions awaiting them). If you missed it, the `[agent-hub]` warning says so: call `agent_hub_report` and restate the handoff in that turn's final message.
- **Withdraw.** `agent_hub_withdraw` takes `id` and `reason` (both required) and closes only your own unanswered question of this thread; a merged form is withdrawn whole. An answered, already withdrawn or foreign id is refused; `agent_hub_list` shows your open questions under "Your open questions to the user".
- **Scripts.** A script that wakes its own thread with `bb thread tell` must start the text with a `[tag]` (see below). The plugin cannot enforce it: bb records the message as the owner's.
- **Old names.** `answers_*` tools are deprecated aliases of `agent_hub_*` with the same rules; call the `agent_hub_*` name.

### Messages to other threads

Start with one short sentence that says what you need or report. Use short
paragraphs or bullets with one point each. Put commands, IDs and field names
in inline code. Put JSON objects in fenced `json` blocks. Leave a blank line
between paragraphs and before and after code blocks. With `bb thread tell`,
pass `--message-file -` to keep the line breaks.

For example, send this message body:

> Please verify the new launch contract.
>
> - The request uses the `providerId` field.
> - To check it, run `bb provider list`.
>
> ```json
> {"providerId":"example-provider"}
> ```


As a safety net, a turn that answers while sub-sessions it started itself are still running is deferred automatically, and once the last of them reports, the plugin keeps waiting if sub-sessions started by the turns their reports woke (a later wave) still run, otherwise your latest report answers the question; explicit `agent_hub_defer`/`agent_hub_resolve` calls always win.

With `handoffWarnings` enabled (default), a live top-level completion that misses the matching explicit channel receives an `[agent-hub]` plugin warning in the same thread. Archived threads and backfilled completions never warn. The warning-triggered reply never warns again and stays read without push unless you call `agent_hub_report` or `agent_hub_ask`. Existing handoff guessing and **Asked in chat** filing remain as a safety net.

To link the owner to a conversation in Agent Hub, use `/plugins/agent-hub/agent-hub?thread=<thread id>`.

CLI:

- `bb agent-hub list [--view unread|waiting|for_me|pinned|saved|all] [--thread ID] [--project ID] [--query TEXT] [--limit 1-50] [--cursor C] [--json]`
- `bb agent-hub get ID [--json]`
- `bb agent-hub read <ids...> | --all [--thread ID]`
- `bb agent-hub status [--thread ID]`
- Read in small portions: `list` returns 20 items per page (`--limit`, `--cursor` from `More:`), `get ID` shows one item in full.
- `bb agent-hub digest [--since 24h|7d|ISO-date] [--json]`

Statuses: `mine` items are `waiting`, `deferred`, or `answered`; `for_me` items are `open` or `replied`; `update` items (the final message of a top-level turn that answered nothing of the user's: a child finished, another thread or a plugin wrote) are `answered`; saved items have status `saved`. Consecutive `update` items that ask nothing collapse into one "N background updates" group in the conversation, carry no unread state and are never pushed; an update that ends a phrase with `?` (outside code, links and quotes) or hands work to the user ("EXA-1 готова к вашей проверке", "ready for your review") has `asks: true` and stays a separate, pushed message — so end a message with a question only when you need the user's answer.

Where the user sees things (name these places when you point the user to them; there is no "Inbox" any more): the Agent Hub page has a **Chats | Questions | Saved** switch (Saved lists messages kept with Save). **Questions** stacks every open `agent_hub_ask` question and every pending bb question form from all threads, oldest first, so the user can answer them in one place; questions written only in the final chat reply also appear as **Asked in chat**, as a safety net. The same open questions also show as a **Questions for you** card above the composer of that thread, in bb's chat and in the Chats conversation, so the user can answer where the chat is open. **Chats** lists contacts (threads) and each one's conversation: the user's messages, your answers and updates, oldest to newest. In a thread, the **My questions** side-panel tab shows the same for that thread, with reply pools above.

A script or background process that wakes its own thread with `bb thread tell` must start the text with a `[tag]` (a letter first, 3–60 characters, then a space), e.g. `[example-watcher] build finished`; bb records such messages as the user's, and without the tag Agent Hub treats them as the user's questions.

Reply pools: the user collects quotes from answers (Add to reply pool in the send menu of the quote and comment popups) and sends them as one message. Quote limit: 20,000 characters; note: 8,000; combined pool message: 32,000. On uncertain delivery, check the thread before retrying; never auto-resend.

Channel detection is project-specific: `channelCommands` defaults to `["work-board question add"]`. Commands containing any configured fragment count as an explicit question channel; `agent_hub_ask` always counts. Threads without a project use the default. This detection does not prescribe where agents must ask questions.

```sh
bb agent-hub config get [<key>] [--project <id>] [--json]
bb agent-hub config set <key> <value> [--project <id>] [--json]
```

Omit `--project` for global preferences; include it for project settings (currently only `channelCommands`, CLI/RPC only). With no key, `get` lists that scope; with a key it returns only its value. `set` returns the stored value.
RPC: `config.get {projectId?, key?}`, `config.set {projectId?, key, value}`. Existing whole-object preference RPCs remain available. Global changes use the settings page’s validation and live-change path. Unknown keys list valid keys. Booleans and numbers accept JSON literals; selects and quiet hours accept strings. `channelCommands` accepts a JSON array of non-empty strings (including `[]` to disable extra channels) or a comma-separated list.

The CLI command is `bb agent-hub`.
