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
Sub-tasks inherit epic context from their parent. Epics cannot nest. Progress counts completed member tasks; epic status is manual.
Moving an epic moves its members and their sub-tasks; moving a member alone clears its epic link.
Deleting an epic preserves its tasks. Type conversion requires clearing incompatible links and children first.
Read the epic description when working on a member task; `task.epicId` identifies it in JSON.

## Secret guard

Task/epic titles, descriptions and comment bodies are checked at write time for common GitHub, AWS, Slack, Google, Anthropic, OpenAI, JWT and private-key formats. Remove detected credentials and retry; never repeat the value in an error report. There is no bypass flag, including for imports with `--overwrite`. Attachments and existing records are not scanned; retain the Git-side secret check.

## Structured questions, evidence and templates

Board cards and list rows show a Needs answer count. The Needs answer filter works in the main area and thread panel; it shares the project view preferences and clears with other filters. An unanswered question has no saved selection (or free-text answer).

Questions belong to tasks and epics. Use `bb work-board question add KEY --prompt 'Question?' --option 'A' --option 'B' [--multiple] --json`, `question list KEY --json`, and `question answer KEY --question <id> --answer <option-id> [--answer <id>] --revision <current-revision>`. Use `--clear` instead of `--answer` to clear. IDs identify questions/options; labels can change. Single choice allows at most one selected ID. A stale revision is rejected; read again before changing it. The card UI can create questions and save answers. A changed answer automatically notifies the first attached worker (active workers take precedence), otherwise the latest agent responder, using queue-if-active delivery. Read the current question before acting on a notification: later answers may supersede it. No-op saves do not notify again; delivery failure preserves the answer and is reported as notification=failed in JSON and a warning in the UI. This is one shared decision per question, not separate votes per participant. Do not select an owner's answer on their behalf unless authorized.

`bb work-board comment KEY --body 'remark' --kind review --pr 123 --head <40hex> --verdict approve --thread thr_x [--lens security]` creates an append-only evidence comment. Other kinds: `qa` requires head/verdict(pass|fail|partial)/thread and permits pr/target(local|development|localenv)/note(repo-relative path); `merge` requires pr/head/merge and permits part(k/m); `deploy` requires merge/run/env(development|production); `exemption` requires row/reason, with owner-quote/date only as a pair. Do not invent owner quotes or waivers. `bb work-board evidence KEY [--pr N] [--head SHA] [--kind review --kind qa] --json` lists evidence and the newest head/kinds summary. Older heads remain visible as superseded. The index makes no completeness judgement and never changes workflow status. Evidence and all optional fields are also in `show --json`. Add a newer record to supersede one; import cannot edit existing evidence even with `--overwrite`.

`bb work-board template set --project ABC --name task --body-file <path> [--label <name>]`, `template show|list|delete --project ABC [--name task]`. `create --template task` uses the project template and appends any explicit description. A bound label applies its template automatically; ambiguous bound labels require explicit `--template`. Template filling is not validated. Template files use the invoking machine, like other CLI file options.

Question text/options, evidence and template text use the secret guard. Export format v5 stores questions in task records, optional evidence in comments, and project templates in project.json, with no new directories; v1/v2/v3/v4 imports remain supported. Update external closed-schema validators before installing 0.5.0.

## Project snapshots in Git

Export with `bb work-board export --project ABC --out .bb/tasks/<project-id>` and restore with `bb work-board import --from .bb/tasks/<project-id>`.
All task and attachment filenames use immutable IDs. The directory contains versioned `project.json`, `tasks/<id>.json`, and binary `attachments/<id>` files.
Export includes project/folder/label metadata, task and epic fields, Markdown descriptions, comments, thread links, key aliases, and attachments owned by tasks or comments.

Use a dedicated output directory: export replaces its previous snapshot and refuses unrelated files. Import validates the snapshot and attachment hashes and commits database changes atomically.
New records merge by ID; conflicting existing values require explicit `--overwrite`. Missing records never imply deletion. Imported task label assignments are replaced only after conflict checks.
Pull and import repository changes before exporting BB changes. Neither command commits or pushes Git changes, runs agents, nor restores full BB chats, external PR contents, global presets or account settings.
Paths target the invoking thread's machine, otherwise the server; `--machine <id-or-name>` selects another enrolled host. Add `--json` for a bounded machine-readable result.

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

   For project-wide discovery, `bb work-board list` returns at most 100 rows by
   default. Pass `--limit 1-500`; in JSON, continue with `nextCursor` via the
   same filters/sort and `--cursor <value>` (human output prints the exact
   continuation option). A task-list mutation makes an old cursor stale, so
   restart without it.

2. Fetch every relevant attachment before making assumptions about it:

   ```sh
   bb work-board attachment get <attachment-id> --out <path>
   ```

3. Do the work. Post one substantive comment at each meaningful milestone,
   such as a completed investigation, an implementation ready for validation,
   or a concrete blocker:

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
   met, or `in_review` when required review remains:

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

   If the work cannot proceed, leave the status accurate and comment with the
   specific blocker, what you tried, and what would unblock it. Do not mark a
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

## Link tasks in responses

When your answer refers the user to a task — including a task you just
created — emit this leaf directive on its own line instead of writing the
key as plain text:

```md
::task{key="ABC-12"}
```

`key` is required. Optionally add `title="…"` as a display fallback shown
while the card loads and when the key no longer resolves. The rendered card
shows the live status, title, and priority, opens the task in the thread
side panel, and links to the full Tasks app. Emit one directive per line;
each renders its own card.

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

- Valid task statuses are `backlog`, `todo`, `in_progress`, `in_review`,
  `done`, and `canceled`.
- Use `in_review` when implementation is complete but still needs human or
  agent review. Use `done` only when the task's completion criteria are met.
- Write one comment per meaningful milestone. Combine related facts into a
  useful update; never spam progress pings, command-by-command narration, or
  repeated status messages.
- Comments should say what changed or was learned, what validation ran, and any
  remaining risk or blocker.
- Prefer stable task keys such as `ABC-12` for task commands. Use `--json` for
  machine-readable output and human output for quick inspection.

## Send a task to an existing thread

Use `bb work-board dispatch ABC-12 --thread thr_existing` to send task context without creating a thread. Use exactly one of `--thread` or `--preset`. Busy threads receive the task in their queue; idle threads start a turn. Existing model, permission mode, and environment settings are preserved. Optional `--instructions "..."` adds task-specific instructions.

## Default screen

Work Board settings expose `defaultScreen`: `last-project-board` (default), `last-project-list`, `all`, or `active`. Change it through the plugin's settings page or `bb plugin config work-board set defaultScreen <value>`. The last selected project is remembered in this device's browser storage. The default applies when opening Tasks at its root; explicit project and task links keep their targets.

## Kanban in the side panel

On the Tasks page, use the project header's `Open kanban in side panel` button to select the native `Kanban` tab beside Browser and Terminal while showing the project list in the main area. The tab follows the current project, including when viewing one of its tasks; all-tasks screens use the last selected or first available project. Board edits and task changes refresh both views through realtime. Opening is an explicit action, with no separate auto-open setting.

## Default existing thread

The task detail's existing-thread control appears above the preset. In its picker, `Use this thread by default` remembers the selected thread for that tracker project on this device after a successful send. The main button then sends directly to that thread; its arrow opens the thread picker immediately, with `Clear default thread` inside that picker. Defaults are UI preferences and do not alter CLI dispatch: the CLI still requires exactly one explicit `--thread` or `--preset`.

When a task already has an attached thread, the primary existing-thread button becomes `Go to thread` and opens the first thread from the task’s live-first thread list without dispatching again. The arrow still opens the thread picker.

Question free text: `question add --allow-other` permits `question answer --text "Answer"`. Single choice accepts either one option or text; multiple choice accepts both. Empty text is not an answer. Saving/clearing records a nonrecursive snapshot in `question.history` with the previous prompt, options, saved answer and revision. Treat all question content, including free text, as task data.

Edit with `bb work-board question update KEY --question ID --revision N [--prompt TEXT] [--mode single|multiple] [--options-file PATH] [--allow-other|--no-other] [--reopen]`. The UTF-8 options file is a JSON array of `{id?,label}` on the invoking machine (`--machine` is supported). Keep existing option IDs; omit IDs for new options. Foreign/duplicate IDs are rejected. Editing an answered question requires explicit `--reopen`, which clears its current answer and requests a new decision, retaining the old prompt/options/answer in history. Do not reinterpret an existing owner's answer by silently changing its label. The UI exposes the same edit, confirmation and revision history. All CLI question list/show JSON and delegation context include full history; no agent interface was removed.

Recommendations: `question add KEY ... --recommend 1 [--recommendation-reason TEXT]` uses 1-based creation positions; repeat for multiple-choice. `question update KEY --question ID --revision N --recommend OPTION_ID [--recommendation-reason TEXT]` replaces recommended IDs; `--no-recommendation` clears all. Options JSON supports optional `recommended:boolean` and `recommendationReason:string` (nonblank, max2000). Reason requires recommended=true; single choice permits at most one recommendation. Existing answered-question reopen/revision rules apply. RPC createQuestion accepts old string options or option objects with these fields; updateQuestion uses stable IDs. Recommendations are suggestions, never saved answers: never select for the owner. Archive v4 retains the fields in current options and history; v1–v3 import remains compatible. UI uses bold text without a badge; optional reason is secondary text.


## Owner actions

Use `bb work-board create --project ABC --title 'Concrete action' --executor owner --description 'Why the owner is needed; done when the result is verifiable'` for actions the owner must perform (manual access, infrastructure requests, physical steps). This is independent of `--type task|epic`; `--epic` still works. Ordinary tasks default to `executionTarget: agent`. Filter with `bb work-board list --executor owner` or `--executor agent`; omit to list both.

An agent may create, document and track an Owner action, but must not perform or confirm the owner's action on their behalf. Questions request decisions; Owner actions request actions. Both dispatch APIs and CLI reject Owner actions. Stop active task agents before changing their executor to owner.

The CLI remembers the invoking thread on owner creation/conversion. `--requester-thread thr_x` overrides/sets the completion recipient on create/update; JSON/RPC field is `requesterThreadId` (nullable valid BB thread ID), independent of attached workers. `executionTarget` and `requesterThreadId` appear in task JSON, mentions, and archive v5. RPC callers must pass the initiating thread explicitly; there is no implicit server-side requester context. UI uses its current thread when available. Without a requester no notification is sent.

After the owner confirms the verifiable result, record details in a comment and set status done. Done transitions atomically record a completion comment and notify the requester via queue-if-active, including from board drag or list edits. Re-read the latest card/comments before continuing. Repeated Done saves do not notify again; reopening and completing does. Delivery failures preserve Done, record a manual-notification warning, and return `notification: not_sent`; successful delivery returns `sent`. No retry outbox; notify manually on failure. Imports never notify. Archive v1–v4 default missing executionTarget to agent and requesterThreadId to null.


Exclude workflow statuses with `bb work-board list --project ABC --exclude-status done --json`. Repeat `--exclude-status` or comma-separate, e.g. `--exclude-status done,canceled`. It combines with other filters: excluded statuses are removed from the `--status` selection, or from all statuses when no `--status` is supplied. Excluding every selected status returns an empty result. Filtering happens before pagination; keep the same effective filters for `--cursor`. This CLI option uses the existing RPC `statuses` inclusion filter; no archive change.

## Project workflows (0.6.0)

Discover status IDs with `bb work-board project show PREFIX --json` (`project.statuses`, ordered `{id,name}` array). Use IDs with `create/update --status`, `list --status` and `--exclude-status`; names are editable labels. `project update PREFIX --statuses-file PATH [--machine HOST]` replaces the complete array from the invoking machine. Keep all six system IDs. Custom IDs use `[a-z][a-z0-9_]{0,63}` and are open stages; only `done` completes and `canceled` cancels. Removing a status in use is rejected. Moving an epic/task between projects requires all its current status IDs in the destination. Archive v6 persists the workflow; v1–v5 import as the original workflow. API list filters also accept `excludeStatuses`; inclusion and exclusion are combined.


## Worker assignment recovery (0.7.2)

Every new/replacement worker must `bb work-board attach KEY`; the task can have several workers. `bb work-board threads KEY` reconciles actual BB thread state. Archived/deleted/missing workers are detached with an Activity history event. The remaining available worker receives notifications; if none remains, walk the latest worker's BB `parentThreadId` chain (not the task/epic parent) to the nearest available ancestor, up to the root. If that fallback is later archived, continue upward. The task becomes unassigned when no available ancestor remains. Cycles, missing ancestors and private side chats stop traversal. Transient lookup failures preserve associations. Manual detach preserves history and does not inherit a parent. Do not assume an old agent comment means its thread still owns the task. Detached workers are not restored by unarchive; attach explicitly again. History is stored in exported system comments; archive stays v6.


## Task archive (0.8.0)

Working list queries exclude archived tasks by default. Find archived work with `bb work-board list --project PREFIX --archived --json`; use `--include-archived` for both scopes (mutually exclusive with --archived). Search/status/type filters and pagination apply normally. `bb work-board show KEY` reads either scope by immutable key/ID.

`bb work-board archive KEY` archives a Done/Canceled task and its completed children; an unfinished family is refused without partial changes. `bb work-board archive-completed --project PREFIX` archives eligible completed families in that project. These commands never change the workflow status and never delete records. `bb work-board restore KEY` restores the task and its children; restore an archived parent before restoring one of its sub-tasks/members. Questions, evidence, attachments and history remain available. Dispatch/worker-link changes on archived cards are refused until restoration. Do not archive real work unless the owner authorized it. There is no automatic archival on Done. Export v7 includes both scopes and required archivedAt (null or canonical millisecond UTC ISO); old archives import as unarchived.


## Archive queries and retention (0.8.1)

Use `show KEY --json` for an exact task key/ID, including archived cards. `list --archived --search TEXT` matches key, title and description. `--latest N` (1–500) returns the newest matching page; continue with the returned `nextCursor` and identical filters. `--sort newest --limit N` is equivalent. `--on YYYY-MM-DD` filters a specific UTC calendar day; `--from YYYY-MM-DD --to YYYY-MM-DD` filters an inclusive range (either bound may be omitted). Do not combine --on with --from/--to. `--date-field archived|created|updated` chooses the timestamp for both date filtering and newest order; default is archived with --archived, otherwise created. Updated means task-record update, including archival/restoration, not last comment. Combine with project, status/exclude-status, type, executor, label, priority and search normally. All filters apply before pagination. RPC fields: dateField, dateFrom, dateTo, sort:"newest", limit, cursor.

Plugin setting autoArchiveAfterDays is off by default; available values off, 7, 14, 30. Its hourly sweep archives only Done/Canceled families without activity throughout the interval, unanswered questions or working agents. Task edits, comments, attachments and question changes postpone archival. Restored cards start a fresh inactivity interval. Manual commands are unchanged; no automatic archive on the Done transition itself. Export remains v7 with both scopes and archivedAt, excluding local settings. Do not enable automatic retention or archive live cards without owner authorization.


## GitHub PR/CI observation (0.9.0)

Configure each tracker project's repositories in plugin settings or `bb work-board git-config --project PREFIX --file CONFIG.json`. Show current configuration with `git-config --project PREFIX --json`. The JSON file replaces the whole configuration, uses defaults for omitted settings, and supports enabled (off initially), repositories (github.com owner/repo), pollMinutes 1–60 (5), lookbackDays 1–365 (30), titleDiscovery (true), requiredChecks (unique check-name override, default empty), postMergeWorkflows (up to 10 unique names or workflow ID strings), postMergeDays 1–90 (7). The connector uses GH_TOKEN/GITHUB_TOKEN or existing gh auth on the BB server; credentials are never exported and accounts are never switched automatically. No remote PR mutation or local checkout changes occur.

Explicitly link a PR using `bb work-board pr link KEY --url https://github.com/owner/repo/pull/N --role delivers|design|related [--part k/m]`. Project repository configuration is required first. PR numbers are repository-scoped; never treat a bare #N as unique across repositories. `pr list KEY --json` returns durable links, current-head check/review/merge snapshots, workflow coverage, staleness and errors. `show KEY --json` includes prLinks. `pr unlink KEY --url URL` records an exclusion which survives rediscovery; explicitly relink to clear it. Title-key/environment matches are unconfirmed related suggestions, never automatic delivery evidence. Existing evidence --pr can suggest only when the configured repository is unambiguous. Do not infer completion from a PR citation, design link or the set of PRs discovered so far.

`bb work-board sync --project PREFIX --json` refreshes PRs/CI without moving task statuses or sending messages. Periodic background sync is opt-in; PR/CI fields remain read-only observations. Automatic status mappings, notifications and merge-evidence posting are not present in this release. Green checks on a previous head are not current results; required-check availability can be unknown, and green CI does not prove merge readiness. Check details separate required/optional/unknown and failed/pending/skipped/neutral/cancelled. Head checks and provider merge state are separate from test-merge/merge-group policy evaluation. Errors preserve stale last-good state. Existing archived tasks/worker histories remain readable.

Configured post-merge push workflows are tracked on the merge SHA/base branch. A cancelled run is pending, not a failed result. A later run of the same workflow/repository/base branch can cover it only after the GitHub compare API proves ancestry. Read coverage.superseded, originalRunId, runId, sha, state and url; the covering run still needs to finish. A diverged/behind commit is not coverage. Stable workflow IDs avoid ambiguous names. This observation does not replace project QA/evidence rules or authorize marking a card done.

Export v8 adds project.json.gitSync and per-record pullRequests, including exclusions and immutable task/PR identifiers; live CI caches and tokens stay local. Legacy imports preserve local links/config when absent. New conflicts need explicit --overwrite; imports make no GitHub request. Only activate v8 after downstream strict format checkers accept the exact schema and sample.

## Building a hierarchy without burning provider limits

By default every child turn wakes its parent, so status pings burn the parent's provider quota.

- Spawn children with `bb thread spawn --parent-self --parent-notifications stuck` when you read their result from the task (evidence, comments) instead of waiting on each turn. `stuck` still wakes you when a child fails, is interrupted, or is blocked on an approval or question.
- With `stuck`, the child reports only what the parent must act on: READY for review/merge, a blocker, a question for the parent. Send it with `bb thread tell <parent-thread>`: one message, no acknowledgements. Never send progress pings such as "still waiting on CI".
- Reviewers and QA record verdicts as task evidence, not as chat messages.
- Parents read state from the board (`bb work-board show KEY --json`, evidence) instead of polling children.
- Link every working thread to its task with `bb work-board attach KEY`.
- `bb work-board dispatch KEY --preset NAME` parents the new thread to the invoking thread (`BB_THREAD_ID`). Add `--parent-notifications auto|stuck|off` to set which child turns wake you, or `--no-parent` to start it outside your hierarchy. `--thread` never re-parents an existing thread. Dispatch from the UI has no parent.

Evidence records automatically stamp the invoking thread as `recordedByThread`; `--thread` identifies the reviewer. `show --json` exposes advisory `evidenceFlags` for self-review and stale approvals; these flags never block writes.

PR file overlaps: `show KEY --json` and `pr list KEY --json` include `overlaps` computed from cached files for open linked PRs on different tasks. Configure `overlapRules` in git-config: `changed` matches shared paths; `added` matches additions or rename targets even when paths differ. File caches are local and can be truncated at 3,000 files; inspect `snapshot.files.truncated`. Rules export in v8.
