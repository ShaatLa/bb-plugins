---
name: work-board
description: "Work on or manage records in Work Board, including task keys such as ABC-12."
---

# Work Board

Use the `bb work-board` CLI to understand the assigned task, keep its record useful,
and report the outcome where the work is tracked.

For task dispatch and execution presets, read
[references/delegation.md](references/delegation.md).

## Epics

Create a large initiative with `bb work-board create --project ABC --title "Initiative" --type epic`.
Assign an existing task with `bb work-board update ABC-2 --epic ABC-1`, or pass `--epic ABC-1` when creating it.
Use `bb work-board list --type epic` to discover epics and `bb work-board list --epic ABC-1` or `bb work-board show ABC-1` for their member tasks.
Use `--no-epic` on update to remove membership. Tasks and epics share project keys and workflow statuses.

An epic groups regular tasks in the same project; those tasks can still have one level of sub-tasks.
Sub-tasks inherit epic context from their parent. Epics cannot nest. Progress counts completed member tasks; an epic moves from Backlog or Todo to In progress automatically when its first task or subtask starts; otherwise its status is manual, and it never moves back or closes automatically. `show` ends with a `Next step` line when a Backlog or Todo task can be taken: move it as it says before you start.
Moving an epic moves its members and their sub-tasks; moving a member alone clears its epic link.
Deleting an epic preserves its tasks. Type conversion requires clearing incompatible links and children first.
Read the epic description when working on a member task; `task.epicId` identifies it in JSON.

An epic with the project label `ongoing` represents a permanent area, not a finite initiative.
During actuality or closure audits, do not require completion criteria for that epic, suggest closing
it, or ask the owner again merely because its current tasks are done. Review and close its finite
member tasks individually; preserve the epic's owner-chosen workflow status. Close the epic only
when the owner explicitly decides the area has ended. Do not infer this label from a vague description
or apply it to member tasks automatically.

Use the ordinary Labels picker in the UI, or `bb work-board label list --project ABC` and
`bb work-board label create --project ABC --name ongoing` if it does not exist, then
`bb work-board update ABC-1 --add-label ongoing --no-due`. Remove it with `--remove-label ongoing`.
The epic Timeframe picker offers No deadline, Due date and Ongoing. Ongoing clears the deadline;
choosing a date or No deadline removes the ongoing label, preserving other labels. In CLI edits,
pair `--due YYYY-MM-DD` with `--remove-label ongoing` when making a permanent epic finite.
For JSON audits, resolve `task.labelIds` against project labels from `label list --json`;
`show --json` also includes the task's labels. This is an agent convention, not a workflow status
or a backend restriction on manual edits.

## Secret guard

Task/epic titles, descriptions and comment bodies are checked at write time for common GitHub, AWS, Slack, Google, Anthropic, OpenAI, JWT and private-key formats. Remove detected credentials and retry; never repeat the value in an error report. There is no bypass flag, including for imports with `--overwrite`. Attachments and existing records are not scanned; retain the Git-side secret check.

## Structured questions, evidence and templates


When asking the owner a question, also set Current state with what you need and why, and keep status accurate. `question add` warns (stderr in text, `warnings` in JSON) when a task is in backlog or todo without Current state; it still saves the question.

Board cards and list rows keep the unanswered question count. The Waiting on me filter works in the main area and thread panel; it shares the project view preferences and clears with other filters. An unanswered question has no saved selection (or free-text answer).

Questions belong to tasks and epics: ask the owner about a task on the task, not in chat. Use `bb work-board question add KEY --prompt 'Question?' --option 'A' --option 'B' [--multiple] --json`, `question list KEY --json`, and `question answer KEY --question <id> --answer <option-id> [--answer <id>] --revision <current-revision>`. Use `--clear` instead of `--answer` to clear. IDs identify questions/options; labels can change. Single choice allows at most one selected ID. A stale revision is rejected; read again before changing it. The card UI can create questions and save answers. A changed answer automatically notifies askedByThread when present, otherwise the first attached worker (active workers take precedence), otherwise the latest agent responder, using queue-if-active delivery. Read the current question before acting on a notification: later answers may supersede it. No-op saves do not notify again; delivery failure preserves the answer and is reported as notification=failed in JSON and a warning in the UI. This is one shared decision per question, not separate votes per participant. Do not select an owner's answer on their behalf unless authorized.

`bb work-board comment KEY --body 'remark' --kind review --head <40hex> --verdict approve --thread thr_x [--pr 123] [--lens security]` creates an append-only evidence comment; omit `--pr` for a pre-PR review of a frozen head. Other kinds: `qa` requires head/verdict(pass|fail|partial)/thread and permits pr/target(local|development|localenv)/note(repo-relative path); `merge` requires pr/head/merge and permits part(k/m); `deploy` requires merge/run/env(development|production); `exemption` requires row/reason, with owner-quote/date only as a pair. Do not invent owner quotes or waivers. `bb work-board evidence KEY [--pr N] [--head SHA] [--kind review --kind qa] --json` lists evidence and the newest head/kinds summary. Older heads remain visible as superseded. The index makes no completeness judgement and never changes workflow status. Evidence and all optional fields are also in `show --json`. Add a newer record to supersede one; import cannot edit existing evidence even with `--overwrite`.

`bb work-board template set --project ABC --name task --body-file <path> [--label <name>]`, `template show|list|delete --project ABC [--name task]`. `create --template task` uses the project template and appends any explicit description. A bound label applies its template automatically; ambiguous bound labels require explicit `--template`. Template filling is not validated. Template files use the invoking machine, like other CLI file options.

Question text/options, evidence and template text use the secret guard. Export format v5 stores questions in task records, optional evidence in comments, and project templates in project.json, with no new directories; v1/v2/v3/v4 imports remain supported. Update external closed-schema validators before installing 0.5.0.

Answer attachments (0.34.0): add repeatable `--file <path>` to `question answer`, with `--machine` to select the source host, as for `attachment add`. Files require an option or text answer; `--clear --file` is refused. The UI supports picking, pasting and dropping files. Uploads become attachments of the answer's system comment atomically before notification; failed saves attempt to remove uploaded files. `question list --json` includes derived `answerAttachments` (id, fileName, mime, sizeBytes) for the current answer. Retrieve them with `bb work-board attachment get <id> --out <path>`. Export format is unchanged: files travel with the existing comment attachments.

## Project snapshots in Git

Export with `bb work-board export --project ABC --out .bb/tasks/<project-id>` and restore with `bb work-board import --from .bb/tasks/<project-id>`.
All task and attachment filenames use immutable IDs. The directory contains versioned `project.json`, `tasks/<id>.json`, and binary `attachments/<id>` files.
Export includes project/folder/label metadata, task and epic fields, Markdown descriptions, comments, thread links, key aliases, and attachments owned by tasks or comments.

Use a dedicated output directory: export replaces its previous snapshot and refuses unrelated files. Import validates the snapshot and attachment hashes and commits database changes atomically.
New records merge by ID; conflicting existing values require explicit `--overwrite`. Missing records never imply deletion. Imported task label assignments are replaced only after conflict checks.
Pull and import repository changes before exporting BB changes. Neither command commits or pushes Git changes, runs agents, nor restores full BB chats, external PR contents, global presets or account settings.
Paths target the invoking thread's machine, otherwise the server; `--machine <id-or-name>` selects another enrolled host. Add `--json` for a bounded machine-readable result.

## Recurring cards

Recurring card creation has moved to BB Automations. Former templates appear as ordinary cards. Open one by its original key and archive it when finished. An unfinished card needs Done or Canceled first. Its schedule history refers to it, so it cannot be deleted.

Schedule history stays in the local database and older backups. Work Board no longer runs schedules or exports their history. Importing an older archive restores its cards and leaves local history intact.

To create a weekly card, use the BB project ID for the automation, the tracker prefix for the card and a model accepted by the provider.

```sh
bb automation create --project proj_example --name 'Weekly review card' \
  --cron '0 9 * * 1' --timezone UTC \
  --provider codex --model '<model-id>' \
  --prompt 'Create one card by running: bb work-board create --project EXA --title "Weekly review"'
```

## Work a task

1. Find and read the task before acting:

   ```sh
   bb work-board show ABC-12
   ```

   The detail includes the description, status, priority, labels, subtasks,
   comments, attachments, attached worker threads, and the GitHub pull
   requests those threads produced (from environment metadata, with state
   open/draft/merged/closed). Use
   `bb work-board show ABC-12 --json` when the result will drive commands or code.

   Read in text mode; use `--json` only when output feeds a script or another
   command. Start with `bb work-board show ABC-12 --brief` before any comments.
   It includes Current state, full open questions and compact answered questions.
   Omission hints name commands for comments, evidence, full questions/history
   (`question list ABC-12`) and per-check PR details (`show ABC-12 --json --comments 0`). JSON puts
   those commands in `more`. Add `--comments N` for the latest N of all kinds.

   The responsible session replaces Current state at each milestone and hand-off:
   done, next, blockers, links to key comments/attachments. Do not append a log;
   keep history in comments. Sub-sessions do not write it. Use
   `update ABC-12 --progress "..."` or `--progress-file <path>` (invoking machine),
   or `--clear-progress`. The note is limited to 4 KB UTF-8 and secret-guarded;
   saving changes neither status nor comment history.

   Read comments newest page first:
   ```sh
   bb work-board comment list ABC-12 --preview --limit 20
   bb work-board comment show <comment-id>
   bb work-board comment list ABC-12 --after <latestCommentId> --cursor <nextCursor>
   ```
   Preview shows IDs, time, kind, author, UTF-8 size and 200 collapsed characters;
   `comment show` returns the full comment and attachments. List hides system
   comments by default and reports `hiddenSystem`; include them with repeatable
   `--kind user --kind agent --kind system`. IDs in full `show` and lists support
   `comment show`, `--after` (strictly newer) and `--cursor` (strictly older).
   Both boundaries resolve before kind filtering. JSON reports `latestCommentId`
   of any kind (also in `show`) and `nextCursor`, null when the window is exhausted.
   An unknown boundary requires restarting without that option.

   For project-wide discovery, `bb work-board list` returns at most 100 rows by
   default. Pass `--limit 1-500`; in JSON, continue with `nextCursor` via the
   same filters/sort and `--cursor <value>` (human output prints the exact
   continuation option). A task-list mutation makes an old cursor stale, so
   restart without it.

2. Fetch every relevant attachment before making assumptions about it:

   ```sh
   bb work-board attachment get <attachment-id> --out <path>
   ```

3. Do the work. At each milestone replace Current state
   (`update KEY --progress`: done, next, waiting for). Post a comment only for
   results and evidence, such as a completed investigation or an
   implementation ready for validation, one per real milestone. Only the session responsible for the task (the
   attached worker) comments on it; a sub-session you spawned reports to you,
   its parent thread, never to the task, and you fold its result into your own
   milestone comment. Keep a comment to the outcome, evidence and next step:
   agent comments over 8 KB are refused, so attach a long report as a file
   (`attachment add`, step 4) and comment a short summary that points to it:

   ```sh
   bb work-board comment ABC-12 --body "Implemented the change; focused validation now passes."
   ```

   Add `--notify` only when the new comment should be delivered to the thread
   that authored the task's most recent agent reply. This resumes an idle
   recipient; with no prior agent reply, the comment is recorded without
   targeting an unrelated thread. In agent context, the new comment keeps the
   current thread identity and an explicit `--author`, while delivery still
   targets the prior latest responder rather than the new comment itself.

4. Attach result artifacts that belong with the task, such as reports,
   screenshots, patches, or generated files:

   ```sh
   bb work-board attachment add ABC-12 --file ./report.md
   bb work-board attachment add ABC-12 --file ./screenshot.png
   ```

   Read `references/attachments.md` for comment attachments, initial files,
   removal rules, and machine selection.

5. Set the status to match the completion criteria. Use `done` when they are
   met, or the project's review status (`workflowPolicy.reviewStatus`, default
   `in_review`) when required review remains:

   ```sh
   bb work-board update ABC-12 --status in_review
   ```

   Change task hierarchy with `bb work-board update ABC-12 --parent ABC-10`, using
   either a task key or ID for the parent. Promote a subtask to the top level
   with `bb work-board update ABC-12 --no-parent`; the two parent flags cannot be
   combined.

   Move a task and its sub-tasks to another tracker project with
   `bb work-board move ABC-12 --project XYZ`. The task gets a new key in that
   project; the old key keeps resolving, so use the new key from then on.

   If the work cannot proceed, leave the status accurate and put the specific
   blocker, what you tried and what would unblock it in Current state. If the
   owner must decide or check something, ask with `question add`; a child
   thread also sends `report --kind blocker` to its parent. Do not mark a
   blocked task complete.

6. Delegated threads are attached automatically. If this thread was not
   delegated from Tasks, attach it yourself so the task shows the active work:

   ```sh
   bb work-board attach ABC-12
   ```

   When a thread is done with a task (hand-off, respawned replacement, or a
   predecessor that died), detach it so `bb work-board threads ABC-12` (live threads
   first, newest first) stays accurate. Omit `--thread` to detach the current
   thread:

   ```sh
   bb work-board detach ABC-12 --thread thr_dead_predecessor
   ```

### Taking, handing off and finishing a task

One task has one responsible worker session at a time; the board shows it as the attached thread.

- **Take.** When you start real work on a task you were not delegated from Work Board, `bb work-board attach KEY` first, then move it to the project's in-progress status (`bb work-board update KEY --status in_progress`, or the status the project's workflow names). Delegated sessions are already attached; still set the status when work actually starts.
- **Hand off.** If you stop before the completion criteria (passing it to another session, or blocked on the owner), write the exact state and next step into Current state (keep or add a `Handoff: <path>` line), leave the status accurate, and `bb work-board detach KEY` unless you stay responsible. Do not leave a task attached to a session that will not continue it.
- **Finish.** Set `done` or the project's review status per the completion criteria. No detach is needed: links stay as history.
- **Sub-sessions** (reviewers, researchers, fix sessions you spawn) do not comment on, attach to, or change the status of the task; they reply to their parent thread, and the responsible session records the result on the task once. Every comment is kept forever and travels with Git snapshots, so many writers on one card make it slow to read and too large to export.
- **Orchestrators** (a manager session that only delegates) do not attach themselves to the tasks they hand out. If a worker session disappears while its task is unfinished, Work Board attaches the worker's parent as **Parent thread** so the task stays accountable; a new worker attaching replaces it, and finishing the task (done or canceled) releases it automatically. Project-specific status rules (who moves a task to review, testing or done) belong to the project's own workflow docs and Work Board workflow policy, not to this skill.

## Link tasks in responses

When your reply to the person mentions a task, write the key as an inline
Markdown link, including for a task you just created:

```md
Fixed in [ABC-12](/plugins/work-board/work-board/task/ABC-12).
```

`bb work-board show KEY` and `create` print this link (`link` in `--json`).
In a thread, clicking it opens the task in the side panel's Work Board tab. Use it only in bb chat; GitHub, Slack and task
comments take plain keys.

When the person needs the live status card, emit this leaf directive on its
own line instead:

```md
::task{key="ABC-12"}
```

`key` is required. Optionally add `title="…"` as a display fallback shown
while the card loads and when the key no longer resolves. The card shows the
live status, title, and priority, opens the task in the thread side panel's
Work Board tab, and links to the full Work Board page. Emit one directive per
line; each renders its own card.

## CLI conventions

- `bb work-board --help` lists every command, and `bb work-board <command> --help` prints
  that command's arguments, accepted values, and limits. Both exit 0.
- `--project` takes a tracker project prefix or id such as `ABC`, never a bb
  project id (`proj_...`). `bb work-board project list` shows both columns.
- `bb work-board status` reports the plugin's name and version. A task's workflow
  status is `bb work-board list --status <status>` and
  `bb work-board update ABC-12 --status <status>`.
- Repeatable options (`--label`, `--status`, `--priority`, `--add-label`,
  `--remove-label`) accept a repeated flag or one comma-separated list.
- Unknown options and stray arguments are errors, never ignored, and every
  missing required value is reported in one error. A failing command run with
  `--json` prints `{"ok":false,"error":{"code","message","hint"?}}` on stdout.

## Invariants

- Status ids are per project: read them with `project show PREFIX --json`
  (`project.statuses`). The six system ids `backlog`, `todo`, `in_progress`,
  `in_review`, `done` and `canceled` always exist; projects can add more.
- Use the project's review status (`workflowPolicy.reviewStatus`, default
  `in_review`) when implementation is complete but still needs human or agent
  review. Use `done` only when the task's completion criteria are met.
- Current state carries progress, comments carry results and evidence,
  questions carry owner asks. Write one comment per meaningful milestone;
  never spam progress pings, command-by-command narration, or repeated status
  messages.
- Comments should say what changed or was learned, what validation ran, and any
  remaining risk or blocker.
- Prefer stable task keys such as `ABC-12` for task commands. Use `--json` for
  machine-readable output and human output for quick inspection.

## Thread health (read-only)

`show --json` and `list --json` include `threadHealth: {failed: [threadId...], staleIdle: {threadId, idleMinutes} | null}`. `failed` lists attached threads whose turn failed or was interrupted; `staleIdle` is set when an attached thread has been idle (no working thread) longer than the project's `staleIdleMinutes` setting (default 45) without a task update, comment or evidence; it is never set for done or canceled tasks, for tasks in the project's review status, or while the task has an unanswered owner question (a task the owner tests has one). Use it to find stalled workers; it sends nothing to them.

## Send a task to an existing thread

Use `bb work-board dispatch ABC-12 --thread thr_existing` to send task context without creating a thread. Use exactly one of `--thread` or `--preset`. Busy threads receive the task in their queue; idle threads start a turn. Existing model, permission mode, and environment settings are preserved. Optional `--instructions "..."` adds task-specific instructions.

## Default screen

Settings → Work Board → General exposes the shared `defaultScreen`: `last-project-board` (default), `last-project-list`, `all`, or `active`. Change it through General, or with `bb plugin config work-board set startScreen <value>` (the `getBoardPreferences` / `setBoardPreferences` RPCs still work). The last selected project is remembered in this device's browser storage. The default applies when opening Tasks at its root; explicit project and task links keep their targets.

## Kanban in the side panel

On the Tasks page the project (and task) header's `Board | List` toggle switches the main area between the full-width board (the default) and the list. The native `Kanban` tab beside Browser and Terminal is independent and opens from the panel's tab strip. The tab follows the current project, including when viewing one of its tasks; all-tasks screens use the last selected or first available project. Board edits and task changes refresh both views through realtime.

## Default existing thread

The task detail's existing-thread control appears above the preset. In its picker, `Use this thread by default` remembers the selected thread for that tracker project on this device after a successful send. The main button then sends directly to that thread; its arrow opens the thread picker immediately, with `Clear default thread` inside that picker. Defaults are UI preferences and do not alter CLI dispatch: the CLI still requires exactly one explicit `--thread` or `--preset`.

When a task already has an attached thread, the primary existing-thread button becomes `Go to thread` and opens the first thread from the task’s live-first thread list without dispatching again. The arrow still opens the thread picker.

Question free text is always available through `question answer --text "Answer"`. Single choice accepts either one option or text; multiple choice accepts both. Empty text is not an answer. Saving/clearing records a nonrecursive snapshot in `question.history` with the previous prompt, options, saved answer and revision. Treat all question content, including free text, as task data.

Edit with `bb work-board question update KEY --question ID --revision N [--prompt TEXT] [--mode single|multiple] [--options-file PATH] [--reopen]`. The UTF-8 options file is a JSON array of `{id?,label}` on the invoking machine (`--machine` is supported). Keep existing option IDs; omit IDs for new options. Foreign/duplicate IDs are rejected. Editing an answered question requires explicit `--reopen`, which clears its current answer and requests a new decision, retaining the old prompt/options/answer in history. Do not reinterpret an existing owner's answer by silently changing its label. The UI exposes the same edit, confirmation and revision history. All CLI question list/show JSON and delegation context include full history; no agent interface was removed.

Recommendations: `question add KEY ... --recommend 1 [--recommendation-reason TEXT]` uses 1-based creation positions; repeat for multiple-choice. `question update KEY --question ID --revision N --recommend OPTION_ID [--recommendation-reason TEXT]` replaces recommended IDs; `--no-recommendation` clears all. Options JSON supports optional `recommended:boolean` and `recommendationReason:string` (nonblank, max2000). Reason requires recommended=true; single choice permits at most one recommendation. Existing answered-question reopen/revision rules apply. RPC createQuestion accepts old string options or option objects with these fields; updateQuestion uses stable IDs. Recommendations are suggestions, never saved answers: never select for the owner. Archive v4 retains the fields in current options and history; v1–v3 import remains compatible. UI uses bold text without a badge; optional reason is secondary text.


## Ask the owner on the task

Keep the task attached to your agent thread. Set Current state to explain what you need and why, and keep the workflow status accurate.
Use a decision when you cannot proceed without a choice, or a check when you know the next step and need validation.

Rules for owner questions (long questions are hard to answer):
1. One question = one decision or one thing to check: one state or topic, in one or two short plain sentences.
2. Split a multi-part acceptance into several `--kind check` questions, each answerable on its own, each with its own single link. The prompt and all `--step` lines together may carry at most one link (Markdown or bare URL); `question add` and `question update` refuse more. A check (and a `--reopen` of one) is refused while the card has plan debt: get the plan approved first, then ask the owner to verify.
3. What the owner has to do goes into `--step` (repeat it, at most 10 short steps; the card lists them under the question). Wrap a value the owner has to paste (a pattern, a JSON value, a command) in single backticks: the card shows it as code with a one-click copy of exactly that value. A value of 61 characters or more (a full command, a pattern, a JSON object) shows as its own block with a Copy button, so give a long value its own step or put it at the end of the sentence, and never split one value across several backtick pairs. One `--step` is one action or one observation in one sentence: "press A, then B and check C" is three steps. A step with several sentences is refused, and so is a step that chains actions with "then", "and" or a comma before another action; nothing is saved, so reword the step and add the question once. Evidence, tables, quotes of earlier remarks, inventories and history go into a task comment (attachment if long), never into the question. An agent cannot move a card to Done or Canceled while an owner question is open: the refusal lists each open question and its withdraw command.
4. Acceptance material is links only (a local design/canvas server or the product), never screenshots or image pairs.
5. Never ask the owner to accept or approve a plan. Put the plan in `plan`, run `plan submit KEY --reviewer <thread, or owner only when the user asked to approve the plan>` and wait for the approval or the notes (see Task plan → Review loop). `question add` refuses a question that links a task plan, and, on a task that has a plan, one that asks to accept or approve a plan.

For a readiness-gated check, pass both `--smoke "what you ran and saw"` and `--beyond-design "extras or none"` on add, supersede, reopen and prompt/steps edits. Use update --reopen with both flags to ask again.

`question add` warns (stderr; `warnings` in JSON) when a prompt is longer than 300 characters; it still saves the question.

`question update --reopen` asks the same check again and makes your thread the asker, so the new answer comes to you. For an answered check the ordered steps and the prompt's links must stay exactly the same; any change is refused with the `--supersedes` command. An answered decision refuses new steps or links; ask the changed decision as a fresh decision question.

A question that no longer matters, for example on a card you are canceling, is closed with `question withdraw` and a reason; never answer it yourself.

When an existing check's state changes, never add a parallel check. Open check: edit it with `question update`. Answered check, same prompt and steps: `--reopen`. Any changed prompt link or step: replace it with `bb work-board question add KEY --kind check --supersedes ID --supersedes-revision N --prompt ...` (N is the revision you read; RPC `supersedes: {questionId, revision}`). The old check closes with its answer and remark kept and gets `supersededBy`/`supersededAt`; the new one gets `supersedes`. A superseded check is never open (Waiting on me, badges, plan pause, auto-archive) and refuses answer, clear, update and reopen: act on its `supersededBy`. Refused: a target on another card, a decision target, an already superseded target, a newer revision or answer than N, `--supersedes` on a decision, and plan debt. Questions in a supersede chain cannot be deleted. A `--kind check` without `--supersedes` whose prompt matches a non-superseded check on the card is saved with a warning naming that check's id, revision and state and what to do with it.

The owner can withdraw a saved answer. You then get a notification "Answer withdrawn (was: …)": stop acting on the earlier answer and undo or report what you already did because of it (for example move the task back from Done). Then read the question with `question list KEY`: when it has `supersededBy`, act on that successor; otherwise wait for the new answer.

```sh
bb work-board question add ABC-12 --kind decision --prompt 'Which approach?' --option 'Use the existing service'
bb work-board question add ABC-12 --kind check --prompt 'Does the form save?' --step 'Open the form' --step 'Press Save'
# One action per step. Before (one step, four actions):
#   --step 'Press Retry, close the message with the cross and press Reload. Check that the list appears.'
# After:
bb work-board question add ABC-12 --kind check --prompt 'Does Retry recover the list?' --step 'Press Retry' --step 'Close the message with the cross' --step 'Press Reload' --step 'Check that the list appears'
# Three states to accept are three checks, each with its own link, not one check with three linked steps:
bb work-board question add ABC-12 --kind check --prompt 'Does [the normal state](https://example.com/normal) look right?'
bb work-board question add ABC-12 --kind check --prompt 'Do [both notices](https://example.com/two-notices) read well together?'
bb work-board question add ABC-12 --kind check --prompt 'Is [the state after dismissing a notice](https://example.com/dismissed) right?'
```

Both types use options and always-available free text. Decisions require at least one option. Checks default to Confirmed and Problem found when no options are supplied; explicit options replace those defaults. Multiple choice permits several options. Type is a label, not a different answer workflow. The answer is delivered to the asking agent thread (queue-if-active), falling back to an attached thread or the latest agent commenter for older questions.

Waiting on me means a live unfinished task with at least one unanswered question of either type. Cards use an orange border and question type badges. Open questions appear in the order they were asked, oldest first; answered questions are under Earlier in timeline order.

Archive v17 removes the task execution and requester fields. Question records add kind (decision/check) and askedByThread (thread ID or null), including history snapshots. Imports v1–v16 discard the old task fields and default questions to decision with no asking thread. No questions are created by the database migration.

Project status pushes apply to agent and plugin automation changes. Owner changes in the UI or CLI outside an agent thread never send a status push, including Done.

Exclude workflow statuses with `bb work-board list --project ABC --exclude-status done --json`. Repeat `--exclude-status` or comma-separate, e.g. `--exclude-status done,canceled`. It combines with other filters: excluded statuses are removed from the `--status` selection, or from all statuses when no `--status` is supplied. Excluding every selected status returns an empty result. Filtering happens before pagination; keep the same effective filters for `--cursor`. This CLI option uses the existing RPC `statuses` inclusion filter; no archive change.

## Project workflows (0.6.0)

Settings → Task statuses lets owners select a status icon from 20 existing glyphs, or Default to remove the override. The optional `icon` field uses IDs validated by `shared/statuses.ts`; preserve it when replacing a workflow. The color picker offers 10 palette values, without a Default swatch. The optional `color` field still accepts all 11 values in `shared/colors.ts` so existing Teal selections remain readable; omitting the field uses the theme color. Preserve both fields when replacing workflows. Icons and colors are project-specific presentation and do not change completion semantics.

Discover status IDs with `bb work-board project show PREFIX --json` (`project.statuses`, ordered `{id,name,icon?,color?}` array). Use IDs with `create/update --status`, `list --status` and `--exclude-status`; names are editable labels. `project update PREFIX --statuses-file PATH [--machine HOST]` replaces the complete array from the invoking machine. `project update PREFIX --status-notifications off|all|done` controls status change pushes. Keep all six system IDs. Custom IDs use `[a-z][a-z0-9_]{0,63}` and are open stages; only `done` completes and `canceled` cancels. Removing a status in use is rejected. Moving an epic/task between projects requires all its current status IDs in the destination. Archive v6 persists the workflow; v1–v5 import as the original workflow. API list filters also accept `excludeStatuses`; inclusion and exclusion are combined.


## Worker assignment recovery (0.7.2)

Every new/replacement worker must `bb work-board attach KEY`; the task can have several workers. `bb work-board threads KEY` reconciles actual BB thread state. Archived/deleted/missing workers are detached with an Activity history event. The remaining available worker receives notifications; if none remains, walk the latest worker's BB `parentThreadId` chain (not the task/epic parent) to the nearest available ancestor, up to the root. If that fallback is later archived, continue upward. The task becomes unassigned when no available ancestor remains. Cycles, missing ancestors and private side chats stop traversal. Transient lookup failures preserve associations. Manual detach preserves history and does not inherit a parent. Do not assume an old agent comment means its thread still owns the task. Detached workers are not restored by unarchive; attach explicitly again. History is stored in exported system comments; archive stays v6.


## Task archive (0.8.0)

Working list queries exclude archived tasks by default. Find archived work with `bb work-board list --project PREFIX --archived --json`; use `--include-archived` for both scopes (mutually exclusive with --archived). Search/status/type filters and pagination apply normally. `bb work-board show KEY` reads either scope by immutable key/ID.

`bb work-board archive KEY` archives a Done/Canceled task and its completed children; an unfinished family is refused without partial changes. `bb work-board archive-completed --project PREFIX` archives eligible completed families in that project. These commands never change the workflow status and never delete records. `bb work-board restore KEY` restores the task and its children; restore an archived parent before restoring one of its sub-tasks/members. Questions, evidence, attachments and history remain available. Dispatch/worker-link changes on archived cards are refused until restoration. Do not archive real work unless the owner authorized it. There is no automatic archival of the card itself on Done, but closing a card with `update --status` archives the sessions Work Board created for it (the `archiveThreadsOnClose` setting); the command's own output lists what happened to each linked thread and what to do next, so read it. Export v7 includes both scopes and required archivedAt (null or canonical millisecond UTC ISO); old archives import as unarchived.


## Archive queries and retention (0.8.1)

Use `show KEY --json` for an exact task key/ID, including archived cards. `list --archived --search TEXT` matches key, title and description. `--latest N` (1–500) returns the newest matching page; continue with the returned `nextCursor` and identical filters. `--sort newest --limit N` is equivalent. `--on YYYY-MM-DD` filters a specific UTC calendar day; `--from YYYY-MM-DD --to YYYY-MM-DD` filters an inclusive range (either bound may be omitted). Do not combine --on with --from/--to. `--date-field archived|created|updated` chooses the timestamp for both date filtering and newest order; default is archived with --archived, otherwise created. Updated means task-record update, including archival/restoration, not last comment. Combine with project, status/exclude-status, type, label, priority and search normally. All filters apply before pagination. RPC fields: dateField, dateFrom, dateTo, sort:"newest", limit, cursor.

Each project has autoArchiveAfterDays, off by default; available values off, 3, 7, 14, 30. Use `bb work-board project update ABC --auto-archive 14` or `--auto-archive off`. Idle warnings are also per-project: `--stale-idle off|30|45|60|120` (default 45). Both are visible in `project show --json`, configurable under the single project selector in Settings, and portable in archive v11. Prior global values are migrated once for existing projects; reload after the first upgrade removes the temporary legacy controls. Its hourly sweep archives only Done/Canceled families without activity throughout the interval, unanswered questions or working agents. Task edits, comments, attachments and question changes postpone archival. Restored cards start a fresh inactivity interval. Manual commands are unchanged; no automatic archive on the Done transition itself. Export v11 includes both scopes, archivedAt and project archive/idle settings, excluding shared UI preferences. Do not enable automatic retention or archive live cards without owner authorization.


## GitHub PR/CI observation (0.9.0)

Read or change one project setting with `bb work-board config get [KEY] --project PREFIX` and `config set KEY VALUE --project PREFIX` (keys `autoArchiveAfterDays`, `staleIdleMinutes`, `statusNotifications`, `prEvents`, `prEventsManager`, `git.<field>`; lists take JSON or `a, b`); prefer it to rewriting the whole Git config. Global preferences are native: `bb plugin config work-board [set KEY VALUE]` (`startScreen`, `badge*`). Configure each tracker project's repositories in plugin settings or `bb work-board git-config --project PREFIX --file CONFIG.json`. Show current configuration with `git-config --project PREFIX --json`. The JSON file replaces the whole configuration, uses defaults for omitted settings, and supports enabled (off initially), repositories (github.com owner/repo), pollMinutes 1–60 (5), lookbackDays 1–365 (30), titleDiscovery (true), requiredChecks (unique check-name override, default empty), postMergeWorkflows (up to 10 unique names or workflow ID strings), postMergeDays 1–90 (7). The connector uses GH_TOKEN/GITHUB_TOKEN or existing gh auth on the BB server; credentials are never exported and accounts are never switched automatically. No remote PR mutation or local checkout changes occur.

Explicitly link a PR using `bb work-board pr link KEY --url https://github.com/owner/repo/pull/N --role delivers|design|related [--part k/m] [--owner self|thr_x]`. When you open a PR, link it with `--owner self` so its lifecycle messages come to you; only `--owner` changes the owner, and relinks or discovery keep it. Project repository configuration is required first. PR numbers are repository-scoped; never treat a bare #N as unique across repositories. `pr list KEY --json` returns durable links, current-head check/review/merge snapshots, workflow coverage, staleness and errors. `show KEY --json` includes prLinks. `pr unlink KEY --url URL` records an exclusion which survives rediscovery; explicitly relink to clear it. Title-key/environment matches are unconfirmed related suggestions, never automatic delivery evidence. Environment PRs are suggested only for attached tasks whose whole key (including historical aliases) appears in the PR title, head branch or body. PRs naming only other tasks, or no task key, are skipped; link these explicitly when needed. This does not alter manual links or persistent exclusions. Existing evidence --pr can suggest only when the configured repository is unambiguous. Do not infer completion from a PR citation, design link or the set of PRs discovered so far.

`bb work-board sync --project PREFIX --json` refreshes PRs/CI; the PR lifecycle messages below follow from what it observes. Periodic background sync is opt-in; PR/CI fields remain read-only observations. One automatic transition exists: when a confirmed `delivers` PR is open or draft, a linked task in one of the project's `earlyStatuses` (default `todo`, `in_progress`) moves to the project's `reviewStatus` (default `in_review`); set `earlyStatuses` to `[]` or `reviewStatus` to null to turn it off. No other status mapping or merge-evidence posting happens. Green checks on a previous head are not current results; required-check availability can be unknown, and green CI does not prove merge readiness. Check details separate required/optional/unknown and failed/pending/skipped/neutral/cancelled. Head checks and provider merge state are separate from test-merge/merge-group policy evaluation. Errors preserve stale last-good state. Existing archived tasks/worker histories remain readable.

Linked-PR messages: git sync sends the card's session (the link's `--owner`, or an archived owner's parent; else the card's only linked session; else the root of the card's session tree, the one linked session with no linked ancestor, so a lead gets it over its linked children; else the one linked session whose environment is on the PR after a complete lookup; with no linked session and no reachable owner it ends at once as `no_recipient`; when several linked sessions cannot be told apart it waits as `awaiting_owner`, goes out once `--owner` names one or a 30-minute recheck finds a single match, and ends as `no_recipient:ambiguous` after 24 h) a once-only message when a linked PR's required checks all finish on a head (CI green/red), it leaves the merge queue while open (removal time, GitHub's reason or `reason unavailable`, up to 5 failed checks for a failed-checks removal, and whether it was back in the queue at that poll), it merges, a `postMergeWorkflows` run containing the merge succeeds within `postMergeDays` (deployed), or that window ends without one. They start with Work Board's origin line and the card key. On a deployed message, collect the deployment evidence (`comment --kind deploy`), run the final check and close the card yourself; Work Board never closes or moves it. Done/canceled cards get only merge and post-merge messages. `pr events KEY [--json]` lists a card's messages and delivery state (a refused send gets 3 attempts in total; an unknown outcome is never resent); per-project keys `prEvents` (on) and `prEventsManager` (off; on copies to the attention manager) are read and set with `config get|set`.

Configured post-merge push workflows are tracked on the merge SHA/base branch. A cancelled run is pending, not a failed result. A later run of the same workflow/repository/base branch can cover it only after the GitHub compare API proves ancestry. Read coverage.superseded, originalRunId, runId, sha, state and url; the covering run still needs to finish. A diverged/behind commit is not coverage. Stable workflow IDs avoid ambiguous names. This observation does not replace project QA/evidence rules or authorize marking a card done.

Export v8 adds project.json.gitSync and per-record pullRequests, including exclusions and immutable task/PR identifiers; live CI caches and tokens stay local. Legacy imports preserve local links/config when absent. New conflicts need explicit --overwrite; imports make no GitHub request. Only activate v8 after downstream strict format checkers accept the exact schema and sample.

## Waiting for PR CI (0.30.0)

```
bb work-board pr wait --url https://github.com/OWNER/REPO/pull/N [--head <full 40-hex SHA>] [--timeout 45m] [--ignore-context NAME]... [--json]
```

Blocks until every **required** check of the PR head settles and exits with a verdict. It runs on the bb server with the server's `gh` login, so it works from the agent sandbox where `gh` cannot reach GitHub. It polls every 20 s (independent of the 5-minute background sync) and stops at `--timeout` (1–60 min, default 45 min).

- **Which head.** `--head` takes the full SHA (`git rev-parse HEAD`); a short one is refused. Without it the wait judges the PR head at the moment it starts. If the head moves while waiting, the result is superseded (exit 2); if the requested SHA never becomes the head within 2 minutes, exit 3.
- **What is green.** The required set is read from GitHub for the PR's base branch (branch protection plus rulesets), never hard-coded. Green means every required check passed (skipped/neutral count, as on GitHub) on that exact head **and** no workflow run for the head is still running. A single summary job such as `CI complete` passing alone is not enough when other checks are required.
- **Draft runs never count.** Actions checks that started before the PR's latest `ready_for_review` event belong to the draft run and are ignored, so a wait started right after `gh pr ready` judges the run `gh pr ready` started, not the finished draft run. Of several runs of one workflow on the head only the newest counts, so a draft-time run its successor cancelled does not make the verdict "cancelled". A PR that is still a draft after 2 minutes gives exit 3.
- **Checks outside CI (0.42.8).** A required check that a project gate posts only after CI is green (for example `example/ready-check`) is never judged when it is listed in the project Git setting "Checks outside CI" (`prWaitIgnoredChecks`, applied to every project that tracks the PR's repository) or passed with `--ignore-context`. The green message names its current state (`missing`, `pending`, `passed`...); `--json` lists them in `ignored`.
- **Complete listing.** Checks come from the head's check runs and commit statuses (all pages), not from `gh run view --json jobs`, which can omit jobs.

| Exit | Verdict | Meaning |
|---|---|---|
| 0 | green | every required check passed on the judged head |
| 1 | red | a required check failed; names are printed (`failed` in `--json`) |
| 2 | cancelled | a required check or run was cancelled, or the head moved (superseded). Terminal for that head: report it, do not re-wait the same SHA |
| 3 | no-verdict | PR DIRTY or closed, still a draft, no run 2 min after the head was first seen/marked ready, the required set is unknown or empty, timeout, or GitHub failed 5 polls in a row |

`--json` prints `{url, repository, number, sha, shaFrom, verdict, exitCode, message, failed, ignored, waitedMs}` when the command returns.

**How to wait without blocking your turn badly.** Output arrives only when the command returns, and CI usually takes 9–12 minutes.
- **Claude:** run it with Bash `run_in_background` and a tool timeout of at least 3600000 ms; act on the completion notification instead of polling.
- **Codex, Antigravity:** no background command wakes the thread, so run it in the foreground within the turn.
- Read the command's own exit code, never a wrapper's (`cmd; echo` reports the `echo`). A plugin reload aborts waits in flight.

## Building a hierarchy without burning provider limits

By default every child turn wakes its parent, so status pings burn the parent's provider quota.

- Spawn children with `bb thread spawn --parent-self --parent-notifications stuck` when you read their result from the task (evidence, comments) instead of waiting on each turn. `stuck` still wakes you when a child fails, is interrupted, or is blocked on an approval or question.
- With `stuck`, the child reports only what the parent must act on, and always through the card:
  - progress → `bb work-board update KEY --progress "..."` (replaces the card's Current state; wakes nobody);
  - ready for review/merge, a question for the parent, or a blocker → `bb work-board report KEY --kind ready|question|blocker --body "..."` (or `--body-file <path>`). A question or blocker also needs `--need "<what the parent must decide or do>"` in one or two sentences; the notice shows it first as `Needed: …`, and without it, or with a need that asks nothing (starting with "nothing", "none", "no action", "n/a" or a lone "-"), the command refuses and delivers nothing. Progress that asks nothing goes to `update KEY --progress`, which wakes nobody. A question or blocker is also refused while your own open owner question on the same card is less than 30 minutes old: your parent already sees that wait on the card, so post progress instead. It wakes your own parent thread (`queue-if-active`; reports to a busy parent merge into one queued message) and is not written to the card log. If you are the card's session, it also replaces Current state, led by the kind (a `Handoff: <path>` line already there is kept on top), and attaches your thread when it is not attached yet. If your parent is already attached to the card, you are a helper: only the parent is woken. It fails when your thread has no parent; if it says the parent could not be woken, Current state is saved and you tell the parent yourself.
  - Never `bb thread tell` your parent for these, and never send progress pings such as "still waiting on CI".
- Reviewers and QA record verdicts as task evidence, not as chat messages.
- Parents read state from the board instead of polling children: `bb work-board children` lists your open child threads, the cards each is linked to and each open card's Current state note (`--all` adds Done/Canceled cards, `--json` for full notes, `--thread <id>` for another parent); `bb work-board show KEY --json` and evidence for one card.
- Link every working thread to its task with `bb work-board attach KEY`. A child thread's first `report` or `update --progress` on a card attaches it automatically unless its parent already holds the card.
- `bb work-board dispatch KEY --preset NAME` parents the new thread to the invoking thread (`BB_THREAD_ID`). Add `--parent-notifications auto|stuck|off` to set which child turns wake you, or `--no-parent` to start it outside your hierarchy. `--thread` never re-parents an existing thread. Dispatch from the UI has no parent.

Evidence records automatically stamp the invoking thread as `recordedByThread`; `--thread` identifies the reviewer. `show --json` exposes advisory `evidenceFlags` for self-review and stale approvals; these flags never block writes.

PR file overlaps: `show KEY --json` and `pr list KEY --json` include `overlaps` computed from cached files for open linked PRs on different tasks. Configure `overlapRules` in git-config: `changed` matches shared paths; `added` matches additions or rename targets even when paths differ. File caches are local and can be truncated at 3,000 files; inspect `snapshot.files.truncated`. Rules export in v8.

## Sequence claims

For shared registry or migration numbers, use `bb work-board seq list --project ABC` and `bb work-board claim NAME --project ABC --task ABC-12 [--pr URL]`. A repeat returns the same active claim; use `--another` for an additional value. Release with `bb work-board claim release NAME VALUE --project ABC --reason 'reason'`. Values are never reused. Sequences and claims are operational state and are not exported; PR close or merge does not release them automatically.

## Resource locks

Use `bb work-board lock` instead of coordination messages when only one party may use a shared resource (e.g. the dev contour) at a time. `lock acquire NAME --project PREFIX --reason "dev QA EXA-12" [--task KEY] [--ttl MINUTES]` exits non-zero and prints the holder, reason, since and STALE state if someone else holds it; there is no waiting or queue, so retry later or ask the holder. Always `lock release NAME --project PREFIX` when you are done. Only the holder thread may release; `--force --reason "..."` overrides and is recorded. A lock is STALE when its ttl expired or the holder thread failed, was archived or deleted; only a STALE lock may be taken with `--takeover`. Re-acquiring your own lock refreshes reason/ttl. `lock list` / `lock show NAME` (with history) support `--json`. Reasons are secret-guarded. Locks are visible as chips in the project header and are not exported.

Export v9 preserves optional status icons and colors; imports accept v1–v9, including v8 with metadata. Update strict consumers before upgrading to 0.16.0. Keep a v9 backup before rollback: older releases may reject the archive or metadata.

Activity follows attached sessions automatically: a live thread with runtime active makes every linked card Working. Idle and host-waiting sessions stay Attached; pending owner input gives Waiting for owner. No dispatch marker or activity start/stop command is required. Legacy start/stop claims remain diagnostic context and do not override runtime activity. Sessions without a card link are not inferred from titles or prose. Queued card requests remain visible while the session is not executing. Extra event/request read failures do not hide a verified active runtime; unavailable thread/runtime data stays unknown. Only Working animates. Archive v10 carries observed work history, not live claims or queue IDs; v1–v10 imports remain supported.


To investigate a card indicator, use `bb work-board show KEY --json`: `activity.state` is separate from `task.status`. `activity.diagnostics` explains the rule and includes `hasWorked`, `complete`, `checkedAt`, and any archived/deleted/missing linked sessions still present before reconciliation. Session diagnostics name the attribution source and include runtime/thread status, focused task key/ID, accepted turn/request, queue and pending interaction IDs. Open the named thread, or follow agent reports in `comments`; human `show` links recent reports. Treat incomplete data as unknown, never as proof that work stopped. Historical work may retain only a fact flag and agent comments, not original execution or detach details. The task UI keeps status/activity and attached-session links compact; use CLI diagnostics for the underlying evidence.


## Automatic session attachment

A session created directly in BB is attached to every unfinished agent card whose key appears anywhere in its title, within the matching linked BB project. Use complete keys (`Designer: ABC-12, ABC-15`) or compact same-prefix lists (`ABC-12+15`). Duplicate references do not create duplicate links; existing manual links are preserved. Missing/malformed keys are not guessed.



## Task plan (0.56.0)

Put the implementation plan in the task's `plan`, not in comments, and never split it into "Plan 1/6" comments. Progress still goes to `--progress`.

1. Read it first: `bb work-board plan show KEY` prints the version, state and the `--base-version` for your next edit, then the Markdown. `--section "Heading"` prints one section; `--version N` an earlier version; `bb work-board show KEY` has a one-line `Plan` summary and `--with-plan` prints it in full.
2. Create it once: `bb work-board plan set KEY --file plan.md --base-version 0 --summary "Initial plan"`. When you start planning a card, write plan v1 first, even as a skeleton: that first version moves a Backlog or Todo card to the Planning status (the output says `KEY moved to Planning`). There is no separate start command.
3. Change it precisely instead of rewriting it: `plan edit KEY --section "Steps 1–4" --file part.md --base-version N --summary "..."` replaces one section (the heading may be written with or without its `#`; the file contains the heading line too; an empty file deletes the section; use `"Parent > Child"` when a heading repeats), and `plan edit KEY --find-file old.md --replace-file new.md --base-version N --summary "..."` replaces one exact fragment that occurs exactly once (a single trailing newline from your editor or heredoc is tolerated: if the text as given is not found, it is retried without that newline, in both files). `plan set` replaces everything; `plan restore KEY --version N --base-version M` brings back an old version.
4. Always pass `--base-version` (the version you last read; 0 for the first). On a conflict re-read with `plan show`, reapply your change to the new text and retry. Every write needs a `--summary` of up to 300 characters, because it is the entry in the task log.
5. A plan needs approval before work. If the user asked to approve it, submit with `--reviewer owner`. Otherwise spawn a fresh reviewer on a stronger model and submit with `--reviewer <its thread> --dedicated-reviewer` (the flag lets Work Board archive that reviewer after it approves; never pass it for a reused thread): `bb work-board plan submit KEY --reviewer thr_x --dedicated-reviewer` (required on the first submit; later it defaults to the current reviewer, and another `--reviewer` takes the review over). Revise until it approves with no open notes. Any new version, even during a review, returns the plan to `draft` and you submit again; a plan with changes requested needs a new version first. While the owner has an open `decision` question on the card, the review is paused (`plan show` and `plan reviews` say "Waiting for the owner's decision"): `plan submit` is refused, and a reviewer's `plan approve` and `plan feedback` are refused until the owner answers. Wait for the message that the decision is settled, read the decisions on the card, then approve or send feedback. Check the plan state before taking a card into work: an unapproved plan means wait or ask the plan author, not start.
6. `plan log KEY` lists versions and `plan diff KEY [--from N] [--to M]` shows what changed (default: previous → current).
7. Plan debt (0.70.0): a card in the work zone of a project that requires planning, without an approved plan, shows a `Plan debt since …` advisory in `show` (and `planDebt` in `show --json`). Nothing blocks you: write or finish the plan and `plan submit` it now. Work Board reminds the card's active executors when an owner decision is answered on it, when a PR link is confirmed and after 24 h (the manager too after 24 h), until the plan is approved. The manager lists such cards with `bb work-board list --plan-debt`.

The plan is Markdown up to 256 KB, passes the secret guard and is read-only while the task is archived. Each version writes a system comment (`Plan v4 by <author>: <summary> · section "..." · +12 −4 lines`). Export format v18 carries the plan and its versions; v1–v17 imports still work.

Sharing: the owner reads and edits the plan in the Plan card of the task and in a Plan tab. When you tell the owner the plan is ready or changed, you may link it as `[ABC-12 plan](/plugins/work-board/work-board/task/ABC-12/plan)` (replace both ABC-12 with the real key); in bb chat it opens the plan next to the conversation. Do not paste the plan into the chat. A person's edits arrive as new versions (author "You"): re-read with `plan show` and pass the new `--base-version`.

### Review loop (0.58.0, reviewer threads 0.59.0)

The reviewer (the owner in the Plan tab, or the reviewer thread you named) writes notes on passages (comment or remove) and general notes, sent to you in one batch, or approves. Plans apply when the project's planning is `optional` or `required`; with `required`, a card needs an approved plan before it enters a status the owner marked "only with an approved plan" (by default In progress and later statuses; the owner edits the marks, agents and `--statuses-file` cannot). `show KEY` reports the mode (`planning` in `--json`), and `show` carries a plan warning while the plan is not approved. Agents never change the setting: only the owner does, in the project settings.

- **The plan is the question.** Do not ask the owner "do you accept the plan?" with `question add`. Write the plan, `plan submit` it, and wait for approval or feedback. Questions stay for real decisions inside the work.
- **Approved is the go-ahead.** A message `KEY · plan vN approved by <owner or reviewer>` means: start the work as planned (an optional `Note from …:` line may add a remark). Any new version returns the plan to `draft` and needs a new review, so do not change an approved plan without telling the owner.
- **Feedback arrives as a message** that starts `KEY · plan vN: changes requested by <the owner or the reviewer>`, with the rules and the numbered notes in plan order. Read the same text any time with `bb work-board plan notes KEY` (only sent notes you have not answered; `--all` shows every note with its state and your reply; `--json` is structured). A note is `N1`, `N2` …: a quote of the passage (cut to 200 characters), the owner's text, and the section it sits in. A note marked `unanchored (made on vK)` quotes text that is no longer in the plan: find the passage that replaced it, or answer why not. A `Remove` note asks to drop that passage; a `General` note concerns the whole plan.
- **Do the review in this order:**
  1. `plan show KEY` to re-read the plan and take the current version.
  2. Change the plan with `plan edit` (by section or fragment) or `plan set`; never answer in comments.
  3. Answer every note: `bb work-board plan reply KEY N1 --body "what changed, or why not" --addressed`. `--addressed` marks the note done in the current version; without it the reply is only a message and the note stays open. A note you disagree with still gets a reply that says why.
  4. `bb work-board plan submit KEY --reviewer <the same reviewer>` (the feedback message prints the exact command; without `--reviewer` it goes to the current reviewer). It lists notes that are still unanswered: answer them first. Do not resubmit the plan unchanged; a resubmit needs a new version.
- The reviewer then resolves a note (done), reopens it (it goes out again with the next batch) or approves. You cannot resolve or delete notes, and a note stays readable after you answered it. `plan reviews KEY` lists the review attempts (version, reviewer thread, outcome).
- **If you are the reviewer.** You get `KEY · plan vN submitted for your review`. Read it with `plan show KEY`, then, each with `--version N` (the version you read; a decision on any other version is refused): `plan note KEY --version N --body "…" [--quote "exact text" [--section "Heading"]]` adds a draft note (the quote must occur exactly once in the section or plan), `plan feedback KEY --version N` sends your drafts and requests changes, `plan dismiss KEY N1 … --version N` withdraws unsent drafts, `plan resolve KEY N1 … --version N` / `plan reopen …` close or reopen notes (a previous reviewer's too), and `plan approve KEY --version N [--note TEXT]` approves only when no reviewer note is a draft or unresolved. Approve only when nothing is left to fix. The owner can still approve or request changes on any plan.
- RPC: `listPlanNotes`, `createPlanNote`, `updatePlanNote`, `deletePlanNote`, `setPlanNoteState` (owner), `replyPlanNote` (you), `sendPlanFeedback`, `approvePlan`. `show KEY` and `plan show KEY` add `· N open notes` (sent notes you have not answered). Export format v20 carries the notes (with their authors), the reviewer and the review history; v1–v19 imports still work.

## Manager attention: stale-status notices

Work Board can send the manager a batched stale-status notice. It is On or Off per project (`bb work-board config get attentionMode --project KEY` reads `live` or `off`), changed by the owner in the project settings; by convention agents never change it or the manager setting, and every change is recorded. If you receive a `Stale status` notice, check each listed card: move it, ask the owner on the task, or comment the reason. An occurrence clears by itself when the flag is gone. Read the manager with `config get manager`. The manager comes only from Work Board (no fallback recipient); an unusable manager (none chosen, deleted, archived, stopping, a side chat, unverifiable) blocks turning notices on and pauses delivery while they are on. While notices are on, repository check reports leave out the script's `ACTION stale-status` lines.

## Repository checks (0.64.0)

Checks fetch from the linked BB project's Git remote by default. To fetch the script from another repository, set `bb work-board config set checks.remote git@example.com:owner/process.git --project EXA`. Use an HTTPS URL without userinfo, an SSH URL with an optional username, or `user@host:path`. Omit passwords, queries and fragments. Clear the override with `bb work-board config set checks.remote null --project EXA`.

A tracker can run its repository check script and deliver the findings to its manager. It is off for every project and `checks.enabled` is the owner's (a convention like the planning mode: the platform cannot authenticate the owner, so the guard is the settings UI plus the audit log): `config set checks.enabled` is refused and you never change it by any other route. Every other field is yours to read and set one at a time (`bb work-board config get checks.branch --project KEY`, `config set checks.args '["--root","{manager}"]' --project KEY`). `bb work-board checks status --project KEY [--json]` shows the last and next run, exit, failure stage, the pending report, the receipt and destination, and errors; `checks stats --project KEY --days 7` shows the counters. `checks run --project KEY --dry-run` runs the script once without staging, delivering or counting, but the script itself may send messages: do not run it against a project another tracker owns or while the owner has not asked for a check. A delivered report is a `Needs attention` / `Check failed` message from the plugin; treat its items like any other manager notice. An `unknown` delivery (status `blocked: delivery unknown, Retry needed`) is resolved only by the owner's Retry in the project settings. On each scheduled run the runner also reports archived threads' leftover git worktrees under the thread storage root as `ACTION archived-worktree thr_…` lines (size, clean or dirty; read-only, never cleaned up by the runner) once per path; `checks status` shows how many paths are reported and pending, and a manual `checks run` never scans. On each scheduled run the runner also reports archived threads' leftover git worktrees under the thread storage root as `ACTION archived-worktree thr_…` lines (size, clean or dirty; read-only, never cleaned up by the runner) once per path; `checks status` shows how many paths are reported and pending, and a manual `checks run` never scans.


Notice fallback (0.72.0): when the manager definitely cannot take a repository-checks report, Work Board delivers it to Agent Hub as a notice (manager's chat or Questions; Agent Hub pushes the owner). `checks status` then shows `to agent-hub (notice)` and the fallback reason; while a notice's outcome is uncertain the report is not sent to the manager, and **Retry** in the settings resolves an `unknown` one.
## Dependencies (0.22.0)

Read `bb work-board dependency list KEY --json` before starting a task. Add `bb work-board dependency add ABC-2 --blocked-by ABC-1`; remove with `dependency remove ABC-2 --blocked-by ABC-1`. Reverse the keys to express Blocks instead. Only the predecessor's Done status satisfies a link; Canceled stays unresolved, and reopening restores the warning. These links warn; they never forbid dispatch or status changes. Respect the ordering and report blockers instead of assuming a permitted command means the task is ready. `show --json` provides `dependencies: {blockedBy, blocks}` and `blocked`; `list --json` adds unresolved `blockedBy`. Dispatch context includes unresolved predecessors. Both endpoints receive a system history comment on add/remove.

Use the Dependencies section in the task UI to search/add/remove links or open either endpoint. Board/list Blocked badges identify unfinished predecessors. Links are within one project; self-links and cycles are rejected. Move all connected endpoints together in a task family or remove the links before a project move. Exports store each task's outgoing dependency IDs, validates the graph and restores it atomically. Older imports preserve local links; conflicting imported sets need --overwrite. No merge condition or automatic workflow moves are inferred.

Related links (0.29.0) connect tasks that share context without blocking either one: `bb work-board dependency add ABC-2 --relates-to ABC-1`, `dependency remove ABC-2 --relates-to ABC-1`. The link is symmetric and same-project; `dependency list` and `show --json` return it under `dependencies.related`. Use it instead of a blocker when a task only needs to be read alongside another. Export v15 carries related links; imports accept v1–v14.


## Storage maintenance (0.22.2)

Use `bb work-board storage status --json` for plugin-owned disk usage, unreachable blobs older than 24h, and missing attachment files. `storage clean --json` performs the same safe cleanup as the daily sweep. `storage optimize --json` additionally shares identical immutable blobs and compacts SQLite; it may take time. Settings → Storage offers the same actions and reports before/after counts. Scope is all projects in this plugin, not the invoking machine or an export directory.

Cleanup preserves accessible/archived tasks, comments/evidence, attachments, questions, dependencies, PR links and rediscovery exclusions. It deletes only unreferenced managed blobs after a 24h grace period and unreachable transient activity/PR cache rows. Active uploads/imports are protected, symlinks skipped, missing metadata retained for recovery. Hard-linked blob paths are immutable: imports/replacements must write a fresh unique path, never modify a committed path in place. Filesystems without hard-link support retain the original files. SQLite uses bounded incremental vacuum after initial optimization (fresh databases support it immediately). External exports, release directories, BB logs and backups belong to their owners and are not pruned.

`bb work-board list --json` and `show KEY --json` include `advisories`: `merged-predecessor` (an unresolved predecessor with fresh confirmed delivery merge evidence) and `no-live-session` (Agent task in_progress, complete activity data, zero live attached sessions, and no unfinished blocked-by predecessor; a card held behind one is waiting by rule and gets neither this advisory nor the `no_active_thread` stale flag; a card with an open owner question does not get that stale flag either). Inspect the supplied PR, merge SHA, checkedAt/validUntil, retained last attachment and task activity. Expired or incomplete evidence is unknown. Check criteria or remaining work before marking a predecessor Done; consider reassignment/queueing for a sessionless task. Advice never changes status/dependencies or notifies anyone; only Done satisfies dependencies.

## Status push notifications

Settings → select a project → Activity and notifications → Notify me of status changes applies only to that project: Off (default), All status changes, or Done only. Uses the enabled BB Push notifications channels. Only agent and plugin automation status updates notify; owner UI/CLI changes are suppressed. All paths use the same store observer; no-op saves and rolled-back changes do not notify. Rapid changes to the same card are coalesced before delivery. Delivery failures are logged, never roll back work, and are not retried automatically.


## Assignment and abandonment

Assign an existing session without dispatching with `bb work-board attach KEY --thread thr_ID`; remove responsibility with `detach`, inspect with `threads`. In the task UI, the thread chooser's **Only assign (no message)** choice performs the same operation without sending messages or changing workflow status. Multiple collaborators are supported and existing links remain intact. A live idle session is **Assigned**, an executing one is **Working**. Go to thread opens it; new-session dispatch is hidden while assigned. The project default dispatch thread is a preference, not an assignment. Creators/requesters and comment authors are not silently assigned.

Abandoned requires recorded work AND a confirmed lost assignment (archived/deleted/missing or explicitly detached), no remaining session, complete provider diagnostics, and an unfinished agent task. Comments alone never establish that a task was taken. Unknown provider state is not abandonment. Existing legacy cards without an assignment can be assigned explicitly; task comments are preserved.


## Sharing task context

The **Copy task link** button next to the card key copies a Markdown task link for pasting into any agent chat. Copying never dispatches, assigns, or changes task status.
Export v14 (0.28.0) adds optional per-project workflow policy, outcome evidence and deploy PR citations; imports retain v1–v13 compatibility. Older releases cannot read v14 exports.

Use `list --stale-status` to filter diagnostic warnings before pagination; `list --json` and `show --json` expose `staleStatusFlags`. Diagnostics use recorded state, not a fresh remote check. Record non-PR results explicitly with `comment KEY --kind outcome --body "Result"`. Existing done cards with ordinary non-system comments are grandfathered until a status change. Configure rules using `project update PREFIX --workflow-policy-file policy.json`; omitted fields reset to defaults, null disables the corresponding rule.

## Done after review

Only the owner sets `doneRequiresReview` in project settings (default off). When it is on, create cards outside Done. An agent moving a card into any Done status, including from Canceled, needs a real review, not a pass through a status:

- **A card that delivers PRs** (confirmed `delivers` links, plus every PR a `merge` record names) needs, for each PR, an approving `review` (or `qa` `pass`) comment that names the PR and its gate head and comes from a thread that is neither you nor a known author of that PR. The gate head is the merged PR's final head, the head of a current open snapshot, or, with no snapshot, the head of the `merge` record. With no current snapshot (sync off or stale) the move is refused: run `bb work-board sync --project EXA` and retry. Approvals older than the last In Progress still count when they match that head.
- **A card with no PR** needs one approving review from a thread other than you, recorded after the card last entered In Progress.
- Record it with `bb work-board comment EXA-1 --kind review --pr 12 --head <sha> --verdict approve --thread thr_example --body "..."`. The manager or the owner can record it for the reviewer. The refusal names the missing evidence; it never suggests moving through In Review.
- Authors are the bb threads attached to the card whose worktree holds the PR. Work Board records them from environments it has seen, so the exclusion is best effort: a thread it never saw can still approve. A Done entry written with no known author says `(no author known)`.
- Recording a `merge` confirms the card's single matching unconfirmed or discovered `related` link as `delivers`. Two links with the same PR number, or a merge record with no link in a project of several repositories, refuse Done: unlink one, or `bb work-board pr link EXA-1 <url> --role delivers`.
- Every agent attempt, passed or refused, is kept in a local decision record; a passed Done entry reads `(review: #12 approve@1a2b3c4 by thr_example)`.

A project move applies the same rule to every newly done family member. Entering Canceled, owner moves on the board and automatic moves stay free. Raw RPC without `agentThreadId` has panel access. Archive v26 saves the switch for newly restored projects. Existing projects keep the local switch; the review log, author threads, decisions and link history stay local, and imported approval comments never satisfy the gate.

A card moves to In Review by itself when a PR it delivers becomes ready: the snapshot is open (not a draft) and the PR is new to the card, was a draft or closed before, or has a new head. The entry reads `Status changed to In Review by Work Board (owner/repo#12 ready for review at 1a2b3c4)`. A card you moved back to In Progress stays there until a new head arrives. `in_testing` and later statuses are never pulled; a `bugfix` card moves only for a new head.

An agent can enable Check receipt with a host-registered validator. For example,

```sh
bb work-board config set checkReceipt '{"validatorId":"example","hint":"Generate a receipt","linkPathPattern":"^/example/"}' --project EXA
```

To tighten the setting, pass the full value. Keep the validator, timeout and hint, and either retain the pattern and all existing wrappers (adding wrappers is allowed), or remove the pattern to cover every check, including checks without links. Without a pattern, any wrapper list is allowed. `linkHosts` (for example `["127.0.0.1"]`) limits the pattern to absolute http(s) links on those hostnames; relative and `//` links then never count. You may add a host or drop the list; setting a list or removing a host is owner-only. Each changed value requires a current host registration. Only the owner can disable the setting or make other changes in project settings.

When a check needs a UI receipt, run the project's production hint and pass the resulting UTF-8 file with `question add --receipt <file>` or `question update --receipt <file>`. Include it on supersede, reopen and edits to the prompt or steps. Supply readiness flags too when required. A wrapper may always pass a receipt: the CLI reports when it was unused. A stale validation needs another run, and a used verdict needs fresh evidence. Use reopen to clear a gated answer. Withdraw open scoped checks before moving their card family into a receipt project.

### Pausing unfinished work

When you end a turn with your card unfinished and waiting for something (a release, another session, a person, or a background run), pause it: `bb work-board pause EXA-1 --reason "waiting for a release" --for 2h`. The next real message that starts a turn on your thread (from a person or another session) ends the pause; a Work Board reminder never does and is dropped while the card is paused. `bb work-board show EXA-1` says whether automatic pause covers this card; if it does, background commands, agents and workflows you start pause it for you. Otherwise, or when unsure, pause it yourself. Use `bb work-board resume EXA-1` to resume and `bb work-board pause log EXA-1` to inspect the history. An executor-first notice asks you to address the signal, pause while waiting, or hand the card back before the manager is told.
