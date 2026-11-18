# Answers

English | [Русский](README.ru.md)

Answers solves a simple problem: answers to your questions get lost among agent messages in active threads.

The plugin tracks your messages in all threads except those initiated by agents (which have a parent thread), linking them to the final response of a successfully completed run, agent queries directed at you, and messages you manually saved.

A run that did not respond to your message (a child thread finished, another thread received a message, or a plugin triggered an action) also appears in the conversation as an **update**: the agent's final message without your bubble, annotated with a source label ("After … finished", "Message from …", or plugin ID). Consecutive updates are collapsed into a single "N background updates" group showing a preview of the last one (expandable by clicking). They do not have a read status (are excluded from notification counters) and are not sent via push. If an update contains what appears to be a question (`?` at the end of a phrase outside code blocks, links, or quotes), it remains a separate message, is marked as unread, and triggers a push when `notify: questions` or `all` is configured. Reports marked by the agent via `answers_report` behave identically. Once a thread and its sub-sessions go quiet, the most recent message in the group is not collapsed: the full result after a series of updates remains visible. While work is in progress, new updates are collapsed like the rest.

BB logs `bb thread tell` (used by a script to wake its own thread) as a user message. Therefore, such messages must begin with a square-bracket label, e.g., `[merge-queue watcher] …`: Answers does not treat them as user questions, and the run they trigger is displayed as an update bearing that label. Links like `[EXA-12](…)` and `[x]` at the start of a message do not count as labels.

## Interface

The **Answers** navigation panel shows a count of unread replies and open questions addressed to you. Views, search, project filter, and **Mark all read** are available. Cards let you open a message in chat, mark it as read, pin it, close it via **Done**, or reply. Each thread includes a **My questions** tab, and the message menu features **Save to Answers**.

The **Answers contacts** list replaces the thread list in the BB sidebar with the same contacts, projects, sub-sessions, and unread counts as the Answers page. Clicking a contact opens its conversation in Answers or switches it without reloading an already open page. Clicking the open contact again marks it read; the chevron beside its sub-session summary expands or collapses the tree without opening the contact. Dragging a contact or sub-session from the sidebar opens its Answers conversation in a separate panel; each panel keeps its own selected conversation, and clicking the list switches the most recently used panel. The **Hide contacts / Show contacts** button beside the chat controls fully hides or restores the page’s left column; the choice persists between visits. While the Answers list is open in the sidebar, the page hides its own contacts column and this button. The phone layout stays the same, and when the column is hidden you can choose a conversation from the sidebar. Restore the standard list in **Settings → Appearance → Sidebar**; the list slot is exclusive.

## Agent tools

- `answers_defer` — indicate that a response will be provided in a subsequent turn, for example after delegation.
- `answers_list` and `answers_resolve` — find a deferred question and associate it with the current turn's response. The final answer must be included in the turn's final message.
- `answers_report` — display the turn's final message in the owner's history as a report rather than a background update. Call it in the same turn whenever handing work to the owner (ready for review, decisions awaiting them). Also use it for wrap-up messages when the turn was initiated by someone other than the owner (another agent, sub-session, or script) and no one is expecting further questions.
- `answers_ask` — prompt the user with a question, including blocking decisions. The response arrives in the thread as a new message quoting the question. `options` accepts 1–6 distinct choices of up to 200 characters each, `recommended` highlights one, and `reason` explains the choice. Decisions regarding a specific Work Board task are tracked on its card.
- A multipart question: `answers_ask` with `questions` (2–10 questions, each with its own `header`, `options`, `multiSelect`, and `recommended`) appears as a tabbed BB form. The agent receives one response, with a line for each question. `multiSelect` (also available for a single question with `options`) allows multiple choices using checkboxes; any form accepts a custom choice.
- Repeated `answers_ask` calls in the same turn merge into one form of up to 10 parts: choices and recommendations are preserved, urgency increases, and the earliest deadline applies. Merging does not send a new push unless urgency rises to `blocking`.
- `handoffWarnings` (default on) warns agents who hand work over without `answers_report` or ask in chat without `answers_ask` or a Work Board card question. Live top-level completions only; archived threads and backfilled completions never warn. The `[answers]` plugin message queues in the same thread. Its reply stays read and sends no push unless the agent uses `answers_report` or `answers_ask`; it never triggers another warning. Existing handoff detection and **Asked in chat** filing remain as a safety net.
- `remindHours` in notification settings sets the reminder interval for open `blocking` questions (3 hours by default; 0 disables reminders). At most three reminders are sent; each arrives separately, includes the question’s age, and respects quiet hours.
- `urgency`: `blocking` raises the question in lists and sends a separate `Blocking` push; `normal` is the default, and `low` sends no push. Notification settings and quiet hours always apply.
- `deadlineMinutes` (an integer from 5 to 10080) sets a deadline, after which the agent receives the default answer marked `Defaulted`. A single question requires `recommended`; parts without a recommendation receive `Your call`. The owner’s answer before the deadline takes priority.
- Partial answers: you can answer only some parts of a form; empty parts arrive as `Skipped`, and `Your call` arrives as `Your call (decide yourself)`. It excludes other checkboxes; at least one answer is required.
- A question the agent asks the user as plain text in its final reply also lands in Questions, marked **Asked in chat**, counted in the badge and push like an `answers_ask` question. It is the last sentence ending in "?" outside code, links, quotes and tables, unless it names a channel ("on the card", "in Answers") or the agent called `answers_ask` or `bb work-board question add` in that turn. A short question ("Want it?") is taken together with the previous sentence. The reply goes to the thread quoting the question; a rhetorical question is closed with **Not a question**.
- `answers_withdraw` — withdraw your own open question from Questions with a reason when an answer is no longer needed (the agent found it, changed course, or asked twice). Only unanswered questions from your own thread can be withdrawn, including questions caught from chat text. The question leaves the counter and For me, sends no push, and stays in history marked **Withdrawn** with the reason; it can still be answered. `answers_list` shows the agent’s open questions and their IDs.

## CLI and Installation

```sh
bb answers list [--view unread|waiting|for_me|pinned|saved|all] [--thread ID] [--json]
bb answers read <ids...> | --all [--thread ID]
bb answers status
bb answers digest [--since 24h|7d|ISO-date] [--json]
bb plugin install git:https://github.com/ShaatLa/bb-plugins.git@main --plugin answers
```

## Limitations

- Plugin messages (CI Dashboard, Slots, etc.) and anything sent to threads initiated by agents are not treated as questions, since the "user" messages in those threads are generated by agents and scripts. Questions from agents in these threads via `answers_ask` are routed to "For me".
- Multiple questions asked in a single turn share the same response for that turn.
- If an agent forgets to call `answers_defer`, a message like "Delegated, I’ll report back later" is treated as a final answer. The **Looks like an interim reply** chip offers **Keep waiting** or **It's the answer**.
- Currently running threads will receive tools after the next provider session starts.
- The initial history load covers threads active within the last 48 hours, up to approximately 1,500 relevant events per thread, and a maximum of 1,000 threads.
- Responses with undetermined delivery status are not automatically resent.
- Failed question-resolution turns cannot be retried using the **Retry** action.
- Push events that occur during the initial history load after startup are ignored.

## Inbox, quotes and reply pools (0.2)

By default, **Inbox** opens: threads with unread replies and questions directed at you appear on the left, while the history of the selected thread (from oldest to newest) is on the right. If you navigate away from a thread by scrolling up, it reopens in the same spot (newer messages below remain separated by the **New** divider, and there is a **Scroll to latest** option). Otherwise, a thread opens at the first unread message below the **New** divider, or at the very latest message if everything has been read. Like in Telegram, a message is marked as read automatically without a timer: as soon as its end appears on screen or scrolls out of view. Short messages are marked immediately; long ones are marked once you scroll to the bottom. Clicking the selected thread again marks the entire thread as read. The selected thread remains in the list. **Load earlier** fetches older history while preserving your reading position. On narrow screens, **Back** returns you to the thread list. The legacy views **Waiting**, **For me**, **Pinned**, **Saved**, and **All** retain search and project filtering.

In the thread's **My questions** tab, view options are selected via the top-left menu: **Unread** shows new replies in this thread, **Awaiting answer** lists your unanswered questions, **Saved** displays starred and saved replies, and **History** shows all messages with search capability. **Mark all read** is available in Inbox and Unread.

Card actions only appear where they change the status: **Mark read** for unread items; **Stop waiting** for your unanswered questions (removes them from Awaiting answer); **Won’t reply** for agent questions (removes them from the Questions section and Inbox); **Remove from Saved** for saved messages. All cleared items remain in History.

Short messages without a question mark (up to 60 characters) that receive a short agent reply (up to 160 characters) are automatically marked as read and don’t appear in the Inbox. Messages containing a “?” are tagged as “Question”.

On the Answers page, the top toggle **Chats | Questions | Saved** switches between conversations and a dedicated questions section. (Questions shows a count of pending items; Saved contains messages saved via the Save action, with project search and filtering.) It presents a single stack of all pending questions from every thread, ordered oldest to newest, including blocking **bb** forms (questions and approvals, including child threads) and non-blocking agent questions directed at you.

Each card displays the thread, project, age, and an **Open thread** link. The card disappears after you reply.

You can also reply directly in the open chat: above the thread composer in **bb** and in the Chats conversation, a **Questions for you** card shows the agent’s open questions for that thread (in Chats, blocking **bb** forms are also shown alongside). The composer stays visible, and replying anywhere closes the question across all views;

open agent questions only appear in the history after a reply, but they count toward the contact’s total (explicit sub-agent asks count in Questions and the badge without creating a contact) and remain there until answered, even after being marked as “read”; a thread with a pending question displays a badge on the avatar. Form hotkeys (numbers, actions) only work when the form has focus.

For contacts with sub-sessions, a summary replaces the preview (showing direct and nested sessions, how many are working, and how many are idle). The chevron at the end of the summary expands or collapses their tree, and the choice persists between visits. Rows keep the nested guides, provider icon, and working status glyph from the **bb** sidebar. Clicking a sub-session opens its chat in Answers and closes the mobile sidebar; dragging it opens that Answers chat in a split pane, falling back to a bb thread split when navigation splitting is unavailable. The selected Answers chat or active bb thread is highlighted. Sub-sessions load history on first opening and ingest live events through the same bounded driver as contacts. Their chat items stay read and are excluded from contacts, Inbox, counts, cross-thread history, Saved, search, Questions, Owed and push notifications; chat text never files an “Asked in chat” question. Explicit `answers_ask` calls remain owner-facing questions, including notifications and blocking reminders; `answers_report` output stays in the sub-session’s read history. The chat header, composer and Info, Diff and Work Board tabs follow the selected sub-session. The **bb** right-click menu includes **Copy ID**.

Select text from an agent’s reply, intermediate response, or question to show a compact action bar without moving focus or clearing the selection (copy still works). **Add to chat** appends a Markdown quote to the current thread draft; **Add to reply pool** saves the passage with an empty note; **Comment** opens the quote reply form; **Save to Answers** saves the passage when its message sequence is available. Touch selection uses a short delay and places the bar below the selection. Escape or collapsing the selection closes the bar.

**Send** immediately submits the quote along with your text; **Add to reply pool** (accessible via the arrow menu next to the send button) saves it and opens the **Reply pools** side tab (the same option is available in the **Comment** popup in the **bb** chat).

Drafts are preserved during data refreshes and recipient switches. Close it using **Close**, Esc, losing focus/clicking outside, or after a successful send.

The composer always has two rows: a full-width editor above a toolbar with attachments and, in the main chat, bb’s model, reasoning level and service tier picker. Voice input is separated from Send by at least 12px. The picker starts from the latest run or provider default; choices are saved per thread with the compose draft and reused for sends, steers, schedules and drafts.

Enter sends the reply; Shift+Enter adds a line break.

Lines starting with `> ` in the input field are rendered as blockquotes. Pressing Shift+Enter inside a quote continues it, while an empty quote line exits back to regular text. Right-clicking selected text and choosing **Quote**, or pressing ⌘⇧9 (Ctrl+Shift+9), converts selected lines (or the line containing the cursor) into a quote; pressing it again removes the quote formatting. This is the Answers menu (Undo, Redo, Quote, Cut, Copy, Paste, Delete, Select All): the bb plugin cannot add items to this menu. If no text is selected, the standard bb menu with spell-check suggestions appears. The input field has its own undo functionality (⌘Z, ⇧⌘Z, and Edit → Undo/Redo): it covers text insertion, quotes, and thread links; typing without a one-second pause is undone in a single step.

**Reply pools** displays all thread pools. Notes are saved when you leave the field and after 800 ms of inactivity. **Send all** waits for all notes to save first, then sends the quotes as a single message; a save error cancels the send operation. If a version conflict occurs, the local text is kept for reapplication. Records modified during sending are saved, and the interface shows how many were updated. If delivery status is uncertain, check the chat before resending.

As long as the thread pool contains at least one record, the quote form keeps adding to it: pressing Enter or the main button appends to the pool, while direct send moves to the button’s menu as **Send now**. Once the pool is sent, everything reverts to its default state.

The chat message menu’s **Add to reply pool** option adds selected text or the entire message, then opens **My questions**, where the thread pool appears above the questions. Quotes are limited to 20,000 characters, notes to 8,000, and pool messages to 32,000; exceeding these limits is not silently truncated. Table and formula formatting may differ from the original when converting HTML to Markdown.

## New in 0.3

**Inbox** shows all conversations, including read ones. After mass marking, an **Undo** option is available for 8 seconds. **Save to Answers** displays a confirmation and a link to **Saved**. Use the **Edit message** button to correct your sent message, similar to BB: the thread rolls back to that point, restarts with the new text, and discards everything that came after, removing it from both the chat and Answers. If you interrupt a turn, the message stays in the chat unanswered but is removed from Inbox.

Each conversation includes a search feature for questions and answers that jumps directly to the matching message. Questions from a single turn that share an answer are grouped into a card. The bottom bar lets you type a message, attach files, schedule delivery, save a draft, or route the message into the active turn. Questions using `answers_ask` with `options` render as quick reply buttons. Agent links to local files open in BB’s file viewer on the right, as in thread chat: files in the thread’s environment open as working-copy files, and other files as host files; `#L12` and `:12` open the specified line. In the input field, “/” (or “$”) opens the thread provider’s commands and skills, as in BB chat; the selection is inserted as a pill, while the message text remains `/name`.

With the **Tokenomos** plugin enabled, the conversation header displays the session cost in USD based on API rates, along with the total if sub-sessions are present (`$0.80 · $1.24 with 3 subs`). A tilde (`~`) indicates an estimate or partial data. Without Tokenomos, the header is unaffected.

The **More** menu includes **Save** / **Remove from Saved**, **Remind later**, and, when Work Board is available, **Create task** with project selection. A reminder hides the item until the scheduled time; **Unsnooze** restores it. Failed turns are flagged as **Turn failed** and include a **Retry** button.

The `notify` setting controls alerts: `off` disables them, `asked` covers agent questions directed at you, `questions` adds answers to your messages that end with a question mark, and `all` triggers for all matching events. The default is `asked` since BB already notifies when turns complete, so separate answer notifications are unnecessary. `quietHours` defines a local `HH:MM-HH:MM` window; events during this period are batched into a single notification once it ends. Delivery requires the Push Notifications plugin.

`bb answers digest` lists new answers from the past 24 hours, pending questions, and direct questions from the agent. Use `--since 7d` or an ISO date to adjust the lookback window, and add `--json` for JSON output. For instance, within the Automations plugin you can schedule a daily agent task running `bb answers digest --since 24h`.

The Answers side panel has Info, Diff, and Work Board tabs that follow the open chat. Info shows its environment, branch, commits, and changed files; Diff compares uncommitted or branch changes and saves Viewed marks through bb’s Git plugin. Work Board lists linked tasks and opens them in-app. Tabs read only while visible and refresh after the chat’s turn completes; unavailable integrations show an empty or error state.

The chat’s Owed card lets you jump to, confirm or dismiss older deferred answers; they expire after three days without answer movement.

Owner messages remain plain text: links, Work Board tasks, thread mentions, and known commands or skills after `/` and `$` appear as pills, as in the input field. This also applies to quotes, reply echoes, the queue, and owed answers. The Background updates preview keeps a two-line clamp and preserves thread pills; agent replies and plugin messages use BB Markdown.

Agent and owner messages offer Copy (Markdown) and Copy link beside the message actions, with brief inline clipboard feedback. Links use the native thread route and message sequence when available.

Coarse-pointer controls have at least 40×40px targets, with desktop spacing and glyphs unchanged. Questions and approvals collapse together, with per-thread state in memory; stacks taller than 40% of the viewport start collapsed on touch devices. Attachments use bb’s save/share path.

The selected chat header shows the host-rendered title, a parent link that opens in Answers, and bb’s thread actions menu. Rename uses bb’s dialog; lifecycle confirmations and selection fallback remain host-driven.

Copy link is in the existing More menu for agent messages; owner bubbles and interim replies without their own menu use an icon action.

With a chat open on desktop, its avatar and title, section selector, inline search, Mark all read and thread actions share one toolbar row. Phones keep Back, title, inline search and thread actions in the chat header.
