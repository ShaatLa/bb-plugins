---
name: tasks
description: "Work on or manage records in BB Tasks, including task keys such as ABC-12."
---

# Tasks Plus

Use the `bb tasks` CLI to understand the assigned task, keep its record useful,
and report the outcome where the work is tracked.

For task dispatch and execution presets, read
[references/delegation.md](references/delegation.md).

## Epics

Create a large initiative with `bb tasks create --project ABC --title "Initiative" --type epic`.
Assign an existing task with `bb tasks update ABC-2 --epic ABC-1`, or pass `--epic ABC-1` when creating it.
Use `bb tasks list --type epic` to discover epics and `bb tasks list --epic ABC-1` or `bb tasks show ABC-1` for their member tasks.
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

Questions belong to tasks and epics. Use `bb tasks question add KEY --prompt 'Question?' --option 'A' --option 'B' [--multiple] --json`, `question list KEY --json`, and `question answer KEY --question <id> --answer <option-id> [--answer <id>] --revision <current-revision>`. Use `--clear` instead of `--answer` to clear. IDs identify questions/options; labels can change. Single choice allows at most one selected ID. A stale revision is rejected; read again before changing it. The card UI can create questions and save answers. A changed answer automatically notifies the first attached worker (active workers take precedence), otherwise the latest agent responder, using queue-if-active delivery. Read the current question before acting on a notification: later answers may supersede it. No-op saves do not notify again; delivery failure preserves the answer and is reported as notification=failed in JSON and a warning in the UI. This is one shared decision per question, not separate votes per participant. Do not select an owner's answer on their behalf unless authorized.

`bb tasks comment KEY --body 'remark' --kind review --pr 123 --head <40hex> --verdict approve --thread thr_x [--lens security]` creates an append-only evidence comment. Other kinds: `qa` requires head/verdict(pass|fail|partial)/thread and permits pr/target(local|development|localenv)/note(repo-relative path); `merge` requires pr/head/merge and permits part(k/m); `deploy` requires merge/run/env(development|production); `exemption` requires row/reason, with owner-quote/date only as a pair. Do not invent owner quotes or waivers. `bb tasks evidence KEY [--pr N] [--head SHA] [--kind review --kind qa] --json` lists evidence and the newest head/kinds summary. Older heads remain visible as superseded. The index makes no completeness judgement and never changes workflow status. Evidence and all optional fields are also in `show --json`. Add a newer record to supersede one; import cannot edit existing evidence even with `--overwrite`.

`bb tasks template set --project ABC --name task --body-file <path> [--label <name>]`, `template show|list|delete --project ABC [--name task]`. `create --template task` uses the project template and appends any explicit description. A bound label applies its template automatically; ambiguous bound labels require explicit `--template`. Template filling is not validated. Template files use the invoking machine, like other CLI file options.

Question text/options, evidence and template text use the secret guard. Export format v2 stores questions in task records, optional evidence in comments, and project templates in project.json, with no new directories; v1 imports remain supported. Update external closed-schema validators before installing 0.2.0.

## Project snapshots in Git

Export with `bb tasks export --project ABC --out .bb/tasks/<project-id>` and restore with `bb tasks import --from .bb/tasks/<project-id>`.
All task and attachment filenames use immutable IDs. The directory contains versioned `project.json`, `tasks/<id>.json`, and binary `attachments/<id>` files.
Export includes project/folder/label metadata, task and epic fields, Markdown descriptions, comments, thread links, key aliases, and attachments owned by tasks or comments.

Use a dedicated output directory: export replaces its previous snapshot and refuses unrelated files. Import validates the snapshot and attachment hashes and commits database changes atomically.
New records merge by ID; conflicting existing values require explicit `--overwrite`. Missing records never imply deletion. Imported task label assignments are replaced only after conflict checks.
Pull and import repository changes before exporting BB changes. Neither command commits or pushes Git changes, runs agents, nor restores full BB chats, external PR contents, global presets or account settings.
Paths target the invoking thread's machine, otherwise the server; `--machine <id-or-name>` selects another enrolled host. Add `--json` for a bounded machine-readable result.

## Work a task

1. Find and read the task before acting:

   ```sh
   bb tasks show ABC-12
   ```

   The detail includes the description, status, priority, labels, subtasks,
   comments, attachments, attached worker threads, and the GitHub pull
   requests those threads produced (from environment metadata, with state
   open/draft/merged/closed). Use
   `bb tasks show ABC-12 --json` when the result will drive commands or code.

   For project-wide discovery, `bb tasks list` returns at most 100 rows by
   default. Pass `--limit 1-500`; in JSON, continue with `nextCursor` via the
   same filters/sort and `--cursor <value>` (human output prints the exact
   continuation option). A task-list mutation makes an old cursor stale, so
   restart without it.

2. Fetch every relevant attachment before making assumptions about it:

   ```sh
   bb tasks attachment get <attachment-id> --out <path>
   ```

3. Do the work. Post one substantive comment at each meaningful milestone,
   such as a completed investigation, an implementation ready for validation,
   or a concrete blocker:

   ```sh
   bb tasks comment ABC-12 --body "Implemented the change; focused validation now passes."
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
   bb tasks attachment add ABC-12 --file ./report.md
   bb tasks attachment add ABC-12 --file ./screenshot.png
   ```

   Read `references/attachments.md` for comment attachments, initial files,
   removal rules, and machine selection.

5. Set the status to match the completion criteria. Use `done` when they are
   met, or `in_review` when required review remains:

   ```sh
   bb tasks update ABC-12 --status in_review
   ```

   Change task hierarchy with `bb tasks update ABC-12 --parent ABC-10`, using
   either a task key or ID for the parent. Promote a subtask to the top level
   with `bb tasks update ABC-12 --no-parent`; the two parent flags cannot be
   combined.

   Move a task and its sub-tasks to another tracker project with
   `bb tasks move ABC-12 --project XYZ`. The task gets a new key in that
   project; the old key keeps resolving, so use the new key from then on.

   If the work cannot proceed, leave the status accurate and comment with the
   specific blocker, what you tried, and what would unblock it. Do not mark a
   blocked task complete.

6. Delegated threads are attached automatically. If this thread was not
   delegated from Tasks, attach it yourself so the task shows the active work:

   ```sh
   bb tasks attach ABC-12
   ```

   When a thread is done with a task (hand-off, respawned replacement, or a
   predecessor that died), detach it so `bb tasks threads ABC-12` (live threads
   first, newest first) stays accurate. Omit `--thread` to detach the current
   thread:

   ```sh
   bb tasks detach ABC-12 --thread thr_dead_predecessor
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

- `bb tasks --help` lists every command, and `bb tasks <command> --help` prints
  that command's arguments, accepted values, and limits. Both exit 0.
- `--project` takes a tracker project prefix or id such as `ABC`, never a bb
  project id (`proj_...`). `bb tasks project list` shows both columns.
- `bb tasks status` reports the plugin's name and version. A task's workflow
  status is `bb tasks list --status <status>` and
  `bb tasks update ABC-12 --status <status>`.
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

Use `bb tasks dispatch ABC-12 --thread thr_existing` to send task context without creating a thread. Use exactly one of `--thread` or `--preset`. Busy threads receive the task in their queue; idle threads start a turn. Existing model, permission mode, and environment settings are preserved. Optional `--instructions "..."` adds task-specific instructions.

## Default screen

Tasks Plus settings expose `defaultScreen`: `last-project-board` (default), `last-project-list`, `all`, or `active`. Change it through the plugin's settings page or `bb plugin config tasks-plus set defaultScreen <value>`. The last selected project is remembered in this device's browser storage. The default applies when opening Tasks at its root; explicit project and task links keep their targets.

## Kanban in the side panel

On the Tasks page, use the project header's `Open kanban in side panel` button to select the native `Kanban` tab beside Browser and Terminal while showing the project list in the main area. The tab follows the current project, including when viewing one of its tasks; all-tasks screens use the last selected or first available project. Board edits and task changes refresh both views through realtime. Opening is an explicit action, with no separate auto-open setting.

## Default existing thread

The task detail's existing-thread control appears above the preset. In its picker, `Use this thread by default` remembers the selected thread for that tracker project on this device after a successful send. The main button then sends directly to that thread; its arrow opens the thread picker immediately, with `Clear default thread` inside that picker. Defaults are UI preferences and do not alter CLI dispatch: the CLI still requires exactly one explicit `--thread` or `--preset`.

When a task already has an attached thread, the primary existing-thread button becomes `Go to thread` and opens the first thread from the task’s live-first thread list without dispatching again. The arrow still opens the thread picker.
