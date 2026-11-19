# Agent Hub

Plugin id `agent-hub` (formerly named Answers); its agent tools are `agent_hub_*`; the old `answers_*` names stay as deprecated aliases for sessions started before the rename.

Open Full transcript from the conversation toolbar or an expanded work step. It embeds bb’s ThreadChat for the selected thread; Back to Agent Hub restores the mounted feed and its scroll position. Transcript sends inherit the thread’s permission mode.

The thread table of contents button beside search lists your messages in order. Search results and ?msg= links open an anchored Agent Hub window directly; scrolling loads earlier or newer windows as needed, and Scroll to latest returns to current history. Anchors missing from Agent Hub’s stored history offer the full transcript.

Expand a work-log step to load its command, output, exit code, tool arguments or file diff. Other payloads link to the full transcript. The current agent plan appears once below the conversation as a compact checklist when bb exposes todos.

The @ menu searches workspace files and folders in the selected thread’s environment after a short debounce (up to eight paths and eight threads). Selecting a path inserts a native workspace mention pill and sends its typed metadata.

English | [Русский](README.ru.md)

Agent Hub solves a simple problem: answers to your questions get lost among agent messages in active threads.

The plugin tracks your messages in all threads except those initiated by agents (which have a parent thread), linking them to the final response of a successfully completed run, agent queries directed at you, and messages you manually saved.

A run that did not respond to your message (a child thread finished, another thread received a message, or a plugin triggered an action) also appears in the conversation as an **update**: the agent's final message without your bubble, annotated with a source label ("After … finished", "Message from …" naming the thread or the plugin, with its message quoted under it). The label shows as soon as the agent takes the message, with the robot until the reply arrives; a script's wake-up shows only with the reply. One that reaches the agent while it is answering your message stands above your message, so the question and its answer stay together. If the agent had already written your full answer when it saw such a message mid-turn, and did little work after, its last message is the reply to that message: it goes under that message, after your answer, and your answer stays the earlier one. Consecutive updates are collapsed into a single "N background updates" group showing a preview of the last one (expandable by clicking). They do not have a read status (are excluded from notification counters) and are not sent via push. If an update contains what appears to be a question (`?` at the end of a phrase outside code blocks, links, or quotes), it remains a separate message, is marked as unread, and triggers a push when `notify: questions` or `all` is configured. Reports marked by the agent via `agent_hub_report` behave identically. Once a thread and its sub-sessions go quiet, the most recent message in the group is not collapsed: the full result after a series of updates remains visible. While work is in progress, new updates are collapsed like the rest.

BB logs `bb thread tell` (used by a script to wake its own thread) as a user message. Therefore, such messages must begin with a square-bracket label, e.g., `[example-watcher] build finished`: Agent Hub does not treat them as user questions, and the run they trigger is displayed as an update bearing that label. Links like `[EXA-12](…)` and `[x]` at the start of a message do not count as labels.

## Interface

The **Agent Hub** navigation panel shows a count of unread replies and open questions addressed to you. Views, search, project filter, and **Mark all read** are available. Cards let you open a message in chat, mark it as read, pin it, close it via **Done**, or reply. Each thread includes a **My questions** tab, and the message menu features **Save to Agent Hub**.

The **Agent Hub contacts** list replaces the thread list in the BB sidebar with the same contacts, projects, sub-sessions, and unread counts as the Agent Hub page. Clicking a contact opens its conversation in Agent Hub or switches it without reloading an already open page. Clicking the open contact again marks it read; the chevron beside its sub-session summary expands or collapses the tree without opening the contact. Dragging a contact or sub-session from the sidebar opens its Agent Hub conversation in a separate panel; each panel keeps its own selected conversation, and clicking the list switches the most recently used panel. The **Hide contacts / Show contacts** button beside the chat controls fully hides or restores the page’s left column; the choice persists between visits. While the Agent Hub list is open in the sidebar, the page hides its own contacts column and this button. The phone layout stays the same, and when the column is hidden you can choose a conversation from the sidebar. Restore the standard list in **Settings → Appearance → Sidebar**; the list slot is exclusive.

## Agent tools

- `agent_hub_defer` — indicate that a response will be provided in a subsequent turn, for example after delegation. Without `id` it defers the thread’s newest waiting message.
- `agent_hub_list` and `agent_hub_resolve` — find a deferred question and associate it with the current turn's response. `agent_hub_resolve` requires the `id` that `agent_hub_list` shows; an id that is not a waiting or deferred message of the calling thread is refused. The final answer must be included in the turn's final message.
- `agent_hub_report` — display the turn's final message in the owner's history as a report rather than a background update. Call it in the same turn whenever handing work to the owner (ready for review, decisions awaiting them). Also use it for wrap-up messages when the turn was initiated by someone other than the owner (another agent, sub-session, or script) and no one is expecting further questions.
- `agent_hub_ask` — prompt the user with a question, including blocking decisions. The response arrives in the thread as a new message quoting the question. `options` accepts 1–6 distinct choices of up to 200 characters each, `recommended` highlights one, and `reason` explains the choice. Agents must use it instead of writing the question in chat, then end the turn. A single question requires `question`; `reason` requires `recommended`, and `recommended` must equal one of `options`. Decisions regarding a specific Work Board task are tracked on its card.
- A multipart question: `agent_hub_ask` with `questions` instead of `question` (`question` then only titles the form and may be omitted; 2–10 questions, each with its own `header`, `options`, `multiSelect`, and `recommended`) appears as a tabbed BB form. The agent receives one response, with a line for each question. `multiSelect` (also available for a single question with `options`) allows multiple choices using checkboxes; any form accepts a custom choice.
- Repeated `agent_hub_ask` calls in the same turn merge into one form of up to 10 parts: choices and recommendations are preserved, urgency increases, and the earliest deadline applies. Merging does not send a new push unless urgency rises to `blocking`.
- `handoffWarnings` (default on) warns agents who hand work over without `agent_hub_report` or ask in chat without `agent_hub_ask` or a command matching the project’s `channelCommands`. Live top-level completions only; archived threads and backfilled completions never warn. The `[agent-hub]` plugin message names the fix and queues in the same thread; for a missed handoff the agent calls `agent_hub_report` and restates the handoff in that turn’s final message. Its reply stays read and sends no push unless the agent uses `agent_hub_report` or `agent_hub_ask`; it never triggers another warning. Existing handoff detection and **Asked in chat** filing remain as a safety net.
- `remindHours` in notification settings sets the reminder interval for open `blocking` questions (3 hours by default; 0 disables reminders). At most three reminders are sent; each arrives separately, includes the question’s age, and respects quiet hours.
- `urgency`: `blocking` raises the question in lists and sends a separate `Blocking` push; `normal` is the default, and `low` sends no push. Notification settings and quiet hours always apply.
- `deadlineMinutes` (an integer from 5 to 10080) sets a deadline, after which the agent receives the default answer marked `Defaulted`. Optional; on a single question it requires `recommended`, and parts without a recommendation receive `Your call`. The owner’s answer before the deadline takes priority.
- Partial answers: you can answer only some parts of a form; empty parts arrive as `Skipped`, and `Your call` arrives as `Your call (decide yourself)`. It excludes other checkboxes; at least one answer is required.
- A question the agent asks the user as plain text in its final reply also lands in Questions, marked **Asked in chat**, counted in the badge and push like an `agent_hub_ask` question. It is the last sentence ending in "?" outside code, links, quotes and tables, unless it names a channel ("on the card", "in Agent Hub") or the agent called `agent_hub_ask` or a command matching `channelCommands` in that turn. A short question ("Want it?") is taken together with the previous sentence. The reply goes to the thread quoting the question; a rhetorical question is closed with **Not a question**.
- `agent_hub_withdraw` — withdraw your own open question from Questions with a reason when an answer is no longer needed (the agent found it, changed course, or asked twice). `id` and `reason` are both required. Only unanswered questions from your own thread can be withdrawn, including questions caught from chat text; an answered, already withdrawn or foreign id is refused with the fix. A merged multi-part form is withdrawn whole. The question leaves the counter and For me, sends no push, and stays in history marked **Withdrawn** with the reason; it can still be answered. `agent_hub_list` shows the agent’s open questions and their IDs.

## CLI and Installation

```sh
bb agent-hub list [--view unread|waiting|for_me|pinned|saved|all] [--thread ID] [--project ID] [--query TEXT] [--limit 1-50] [--cursor C] [--json]
bb agent-hub get ID [--json]
bb agent-hub read <ids...> | --all [--thread ID]
bb agent-hub status [--thread ID]
bb agent-hub digest [--since 24h|7d|ISO-date] [--json]
bb plugin install git:https://github.com/ShaatLa/bb-plugins.git@main --plugin agent-hub
```

## Limitations

- Plugin messages (CI Dashboard, Slots, etc.) and anything sent to threads initiated by agents are not treated as questions, since the "user" messages in those threads are generated by agents and scripts. Questions from agents in these threads via `agent_hub_ask` are routed to "For me".
- Multiple questions asked in a single turn share the same response for that turn.
- If an agent forgets to call `agent_hub_defer`, a message like "Delegated, I’ll report back later" is treated as a final answer. The **Looks like an interim reply** chip offers **Keep waiting** or **It's the answer**.
- Currently running threads will receive tools after the next provider session starts.
- The initial history load covers threads active within the last 48 hours, up to approximately 1,500 relevant events per thread, and a maximum of 1,000 threads.
- Responses with undetermined delivery status are not automatically resent.
- Failed question-resolution turns cannot be retried using the **Retry** action.
- Push events that occur during the initial history load after startup are ignored.

## Inbox, quotes and reply pools (0.2)

By default, **Inbox** opens: threads with unread replies and questions directed at you appear on the left, while the history of the selected thread (from oldest to newest) is on the right. If you navigate away from a thread by scrolling up, it reopens in the same spot (newer messages below remain separated by the **New** divider, and there is a **Scroll to latest** option). Otherwise, a thread opens at the first unread message below the **New** divider, or at the very latest message if everything has been read. Like in Telegram, a message is marked as read automatically without a timer: as soon as its end appears on screen or scrolls out of view. Short messages are marked immediately; long ones are marked once you scroll to the bottom. Clicking the selected thread again marks the entire thread as read. The selected thread remains in the list. **Load earlier** fetches older history while preserving your reading position. On narrow screens, **Back** returns you to the thread list. The legacy views **Waiting**, **For me**, **Pinned**, **Saved**, and **All** retain search and project filtering.

In the thread's **My questions** tab, view options are selected via the top-left menu: **Unread** shows new replies in this thread, **Awaiting answer** lists your unanswered questions, **Saved** displays starred and saved replies, and **History** shows all messages with search capability. **Mark all read** is available in Inbox and Unread.

Card actions only appear where they change the status: **Mark read** for unread items; **Stop waiting** for your unanswered questions (removes them from Awaiting answer); **Won’t reply**, a quiet button beside an agent question's choices (removes it from the Questions section and Inbox); **Remove from Saved** for saved messages. All cleared items remain in History.

Short messages without a question mark (up to 60 characters) that receive a short agent reply (up to 160 characters) are automatically marked as read and don’t appear in the Inbox. Messages containing a “?” are tagged as “Question”.

On the Agent Hub page, the top toggle **Chats | Questions | Saved** switches between conversations and a dedicated questions section. (Questions shows a count of pending items; Saved contains messages saved via the Save action, with project search and filtering.) It presents a single stack of all pending questions from every thread, ordered oldest to newest, including blocking **bb** forms (questions and approvals, including child threads) and non-blocking agent questions directed at you.

Each card displays the thread, project, age, and an **Open thread** link. The card disappears after you reply.

You can also reply directly in the open chat: above the thread composer in **bb** and in the Chats conversation, a **Questions for you** card shows the agent’s open questions for that thread (in Chats, blocking **bb** forms are also shown alongside). The composer stays visible, and replying anywhere closes the question across all views;

open agent questions only appear in the history after a reply, but they count toward the contact’s total (explicit sub-agent asks count in Questions and the badge without creating a contact) and remain there until answered, even after being marked as “read”; a thread with a pending question displays a badge on the avatar. Form hotkeys (numbers, actions) only work when the form has focus.

For contacts with sub-sessions, a summary replaces the preview (showing direct and nested sessions, how many are working, and how many are idle). The chevron at the end of the summary expands or collapses their tree, and the choice persists between visits. Rows keep the nested guides, provider icon, and working status glyph from the **bb** sidebar. Clicking a sub-session opens its chat in Agent Hub and closes the mobile sidebar; dragging it opens that Agent Hub chat in a split pane, falling back to a bb thread split when navigation splitting is unavailable. The selected Agent Hub chat or active bb thread is highlighted. Sub-sessions load history on first opening and ingest live events through the same bounded driver as contacts. Their chat items stay read and are excluded from contacts, Inbox, counts, cross-thread history, Saved, search, Questions, Owed and push notifications; chat text never files an “Asked in chat” question. Explicit `agent_hub_ask` calls remain owner-facing questions, including notifications and blocking reminders; `agent_hub_report` output stays in the sub-session’s read history. The chat header, composer and Info, Diff and Work Board tabs follow the selected sub-session. The **bb** right-click menu includes **Copy ID**.

Select text from an agent’s reply, intermediate response, or question to show a compact action bar without moving focus or clearing the selection (copy still works). **Add to chat** appends a Markdown quote to the current thread draft; **Add to reply pool** saves the passage with an empty note; **Comment** opens the quote reply form; **Save** saves the passage to Agent Hub when its message sequence is available. The bar opens below the selection (above it only when there is no room below); touch selection shows it after a short delay. Escape or collapsing the selection closes the bar.

**Send** immediately submits the quote along with your text; **Add to reply pool** (accessible via the arrow menu next to the send button) saves it and opens the **Reply pools** side tab (the same option is available in the **Comment** popup in the **bb** chat).

Drafts are preserved during data refreshes and recipient switches. Close it using **Close**, Esc, losing focus/clicking outside, or after a successful send.

The composer always has two rows: a full-width editor above a toolbar with attachments and, in the main chat, bb’s model, reasoning level and service tier picker. Voice input is separated from Send by at least 12px. The picker starts from the latest run or provider default; choices are saved per thread with the compose draft and reused for sends, steers, schedules and drafts.

Enter sends the reply; Shift+Enter adds a line break.

Lines starting with `> ` in the input field are rendered as blockquotes. Pressing Shift+Enter inside a quote continues it, while an empty quote line exits back to regular text. Right-clicking selected text and choosing **Quote**, or pressing ⌘⇧9 (Ctrl+Shift+9), converts selected lines (or the line containing the cursor) into a quote; pressing it again removes the quote formatting. This is the Agent Hub menu (Undo, Redo, Quote, Cut, Copy, Paste, Delete, Select All): the bb plugin cannot add items to this menu. If no text is selected, the standard bb menu with spell-check suggestions appears. The input field has its own undo functionality (⌘Z, ⇧⌘Z, and Edit → Undo/Redo): it covers text insertion, quotes, and thread links; typing without a one-second pause is undone in a single step.

**Reply pools** displays all thread pools. Notes are saved when you leave the field and after 800 ms of inactivity. **Send all** waits for all notes to save first, then sends the quotes as a single message; a save error cancels the send operation. If a version conflict occurs, the local text is kept for reapplication. Records modified during sending are saved, and the interface shows how many were updated. If delivery status is uncertain, check the chat before resending.

As long as the thread pool contains at least one record, the quote form keeps adding to it: pressing Enter or the main button appends to the pool, while direct send moves to the button’s menu as **Send now**. Once the pool is sent, everything reverts to its default state.

The chat message menu’s **Add to reply pool** option adds selected text or the entire message, then opens **My questions**, where the thread pool appears above the questions. Quotes are limited to 20,000 characters, notes to 8,000, and pool messages to 32,000; exceeding these limits is not silently truncated. Table and formula formatting may differ from the original when converting HTML to Markdown.

## New in 0.3

**Inbox** shows all conversations, including read ones. After mass marking, an **Undo** option is available for 8 seconds. **Save to Agent Hub** displays a confirmation and a link to **Saved**. Use the **Edit message** button to correct your sent message, similar to BB: the thread rolls back to that point, restarts with the new text, and discards everything that came after, removing it from both the chat and Agent Hub. If you interrupt a turn, the message stays in the chat unanswered but is removed from Inbox.

Each conversation includes a search feature for questions and answers that jumps directly to the matching message. Questions from a single turn that share an answer are grouped into a card. The bottom bar lets you type a message, attach files, schedule delivery, save a draft, or route the message into the active turn. Questions using `agent_hub_ask` with `options` render as quick reply buttons. Agent links to local files open in BB’s file viewer on the right, as in thread chat: files in the thread’s environment open as working-copy files, and other files as host files; `#L12` and `:12` open the specified line. In the input field, “/” (or “$”) opens the thread provider’s commands and skills, as in BB chat; the selection is inserted as a pill, while the message text remains `/name`.

With the **Tokenomos** plugin enabled, the conversation header displays the session cost in USD based on API rates (the session's own cost). A tilde (`~`) indicates an estimate or partial data. A click opens today's and the last 7 days' cost, the models and the sub-sessions. Without Tokenomos, the header is unaffected.

The chat draws every message by its author, in one of three kinds: the **owner's** bubble (time, Copy, Copy link, Save to Agent Hub, Edit), the **agent's** text, and an **incoming** message that someone else put into the thread (another thread, a plugin, a bb notice such as a finished or failed child, or a script's `[tag]`). An incoming message has one header (icon, sender, optional verb, time) and its text quoted under it, clamped to three lines; its row has only expand and Copy link, and the agent's reply stands under it as an ordinary agent message. Every clamped body expands from the same chevron icon at the left of its message's row. Rows are always visible on touch screens, with 32px touch areas.

Agent text has one row: Copy, Copy link, and a **More** menu. The **More** menu includes **Save** / **Remove from Saved**, **Remind later**, and, when Work Board is available, **Create task** with project selection. A reminder hides the item until the scheduled time; **Unsnooze** restores it. Failed turns are flagged as **Turn failed** and include a **Retry** button.

The `notify` setting controls alerts: `off` disables them, `asked` covers agent questions directed at you, `questions` adds answers to your messages that end with a question mark, and `all` triggers for all matching events. The default is `asked` since BB already notifies when turns complete, so separate answer notifications are unnecessary. `quietHours` defines a local `HH:MM-HH:MM` window; events during this period are batched into a single notification once it ends. Fallback delivery requires the Push Notifications plugin.

`bb agent-hub digest` lists new answers from the past 24 hours, pending questions, and direct questions from the agent. Use `--since 7d` or an ISO date to adjust the lookback window, and add `--json` for JSON output. For instance, within the Automations plugin you can schedule a daily agent task running `bb agent-hub digest --since 24h`.

`bb agent-hub list` returns one page, 20 items by default (`--limit` up to 50); its text output truncates each item to one line and ends with `More: --cursor C` when there is a next page. `bb agent-hub get ID` prints one item in full. `bb agent-hub status` shows counts, active and archived tracked threads, and the 10 latest ingestion errors; `--thread ID` shows one thread.

The Agent Hub side panel has Info, Diff, and Work Board tabs that follow the open chat. Info shows its environment, branch, commits, and changed files; Diff compares uncommitted or branch changes and saves Viewed marks through bb’s Git plugin. Work Board shows Work Board’s own board for the project linked to the chat (filters, drag and drop, task details), drawn by Work Board itself, with the chat’s own tasks outlined. Tabs read only while visible and refresh after the chat’s turn completes; unavailable integrations show an empty or error state.

The chat’s Owed card lets you jump to, confirm or dismiss older deferred answers; they expire after three days without answer movement.

Owner messages remain plain text: links, Work Board tasks, thread mentions, and known commands or skills after `/` and `$` appear as pills, as in the input field. This also applies to quotes, reply echoes, the queue, and owed answers. The Background updates preview keeps a two-line clamp and preserves thread pills; agent replies and plugin messages use BB Markdown.

Agent and owner messages offer Copy (Markdown) and Copy link beside the message actions, with brief inline clipboard feedback. Links use the native thread route and message sequence when available.

Coarse-pointer controls have at least 40×40px targets, with desktop spacing and glyphs unchanged. Questions and approvals collapse together, with per-thread state in memory; stacks taller than 40% of the viewport start collapsed on touch devices. Attachments use bb’s save/share path.

The selected chat header shows the host-rendered title, a parent link that opens in Agent Hub, and bb’s thread actions menu. Rename uses bb’s dialog; lifecycle confirmations and selection fallback remain host-driven.

Copy link is its own icon in every message row; interim replies use the same icon.

With a chat open on desktop, its avatar and title, section selector, inline search, Mark all read and thread actions share one toolbar row. Phones keep Back, title, inline search and thread actions in the chat header.

Failed turns show the provider’s completion error when available and retain Retry. Interrupted turns have a quiet label and leave waiting and Owed, including deferred questions.

The permission picker beside the model uses the thread’s resolved execution options. Choices stay in each thread’s draft and apply to send, steer, drafts and schedules; unknown modes are omitted. Queue edits retain their own request permission.

Focused Agent Hub chats register rebindable Focus composer (Mod+Alt+L), Search conversation (Mod+Alt+F), and Thread actions (Mod+Alt+T) commands. Other panels keep their shortcuts. Up at the start of an empty composer recalls this thread’s prompt history; Up/Down browse it and Down past the newest restores the draft and attachments.

Changing provider prepares a Handoff to new thread. Exit handoff restores the source provider. The next send creates and selects a thread in the same project and environment, using the selected provider/model and a `Continue from @thread:<source-id>` mention followed by a blank line and your message. The source thread is unchanged.

## Settings

Open **Settings → Plugins → Agent Hub**. Notifications controls push activity, quiet hours (local From/To times), and blocking reminders. Chat chooses Agent Hub or bb chat. Contacts can group conversations by project and reset the dragged project order. Agents controls warnings about handoffs and questions made without Agent Hub tools. Changes apply live across clients. All seven preferences are stored in plugin KV under `preferences`; existing settings are copied once, without replacing later choices. Legacy Configuration controls may remain for the migration load; reload the plugin once to remove them.

Chat also controls **Show "Mark all read"** (off by default), **Working animation** (Desktop only by default; coarse pointers show a still robot), **Enter on touch screens** (New line by default; Send is optional and Shift+Enter always adds a line), **Group background updates** (on), and **Actions on selected text** (on). Disabling selection actions preserves normal selection and copying; message menus remain available. Disabled animation and reduced motion use a still robot without animation loops. These five preferences use the same KV store and apply live.

Channel detection is project-specific: `channelCommands` defaults to `["work-board question add"]`. Commands containing any configured fragment count as an explicit question channel; `agent_hub_ask` always counts. Threads without a project use the default. This detection does not prescribe where agents must ask questions.

```sh
bb agent-hub config get [<key>] [--project <id>] [--json]
bb agent-hub config set <key> <value> [--project <id>] [--json]
```

Omit `--project` for global preferences; include it for project settings (currently only `channelCommands`, CLI/RPC only). With no key, `get` lists that scope; with a key it returns only its value. `set` returns the stored value.
RPC: `config.get {projectId?, key?}`, `config.set {projectId?, key, value}`. Existing whole-object preference RPCs remain available. Global changes use the settings page’s validation and live-change path. Unknown keys list valid keys. Booleans and numbers accept JSON literals; selects and quiet hours accept strings. `channelCommands` accepts a JSON array of non-empty strings (including `[]` to disable extra channels) or a comma-separated list.

The CLI command is `bb agent-hub`.

First start reads the old `plugins/answers/data.db` with SQLite online backup before ingestion starts, including all cursors. KV (`preferences`, `config:project:*`) and legacy settings are read from the host's `bb.db` in read-only mode; legacy settings become preferences. Secret files, if present, are copied with mode 0600. Old data stays in place for rollback. A completion record in the new database prevents another migration. Failures roll back copied KV and secrets and retry on the next start; a populated new database is never overwritten.

`bb agent-hub migration status --json` returns `{ran, completedAt, kvKeys, secrets, error, oldItemCount, newItemCount, matchingItemIds}`. Counts are current; matching IDs sample up to twenty new rows. `completedAt` is an ISO timestamp or null; a missing old database has a null count.

The question card header toggles the pending stack, keeping the header and count visible. Collapse is remembered per thread; tall stacks start collapsed on phones.

Choose **Add to reply pool** from the main composer’s send menu to move its text and attachments into this thread’s pool and open the Pools tab. The action appears when the composer has content.

Drop files or images from the OS onto a reply pool header or its empty area to create an entry, or onto an existing entry to add attachments. Uploads use the thread’s project and the same ten-attachment limit as the composer. Attachment chips do not provide a custom drag-out format.

If import fails, the empty database stays read-only and automatic ingestion pauses until restart, keeping retries safe. Preferences and migration status remain available. An already populated new database is preserved and reported as a migration conflict.

While a bb window with Agent Hub is open and notification permission is granted, Agent Hub shows desktop/web notifications itself; clicking opens its conversation (or the Agent Hub page for a summary). One tab per browser holds the notifier lock. With no fresh notifier, delivery falls back to Push Notifications; phone clicks open bb chat. Opening a chat from any notification (bb's, Work Board's, the phone) continues in Agent Hub. Permission is managed by Push Notifications.

The last five opened conversations stay mounted. Hidden chats pause their subscriptions and effects; returning preserves scroll position, expanded cards, transcript and composer state immediately, then refreshes in place. Opening a sixth chat evicts the least recently opened; evicted chats and page reloads use remembered scroll restoration.
