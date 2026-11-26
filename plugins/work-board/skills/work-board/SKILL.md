---
name: work-board
description: "Work on or manage records in Work Board, including task keys such as ABC-12."
---

# Work Board

Use the `bb work-board` CLI to understand the assigned task, keep its record useful,
and report the outcome where the work is tracked.

For task dispatch and execution presets, read
[references/delegation.md](references/delegation.md).

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

When you take a task from Backlog or Todo, move it as `bb work-board show` suggests (In progress, or the planning status when the project requires a plan) before you start; its epic follows automatically.

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

`bb work-board show KEY` and `create` print this link ready to copy. Use `::task{key="EXA-12"}` on its own line only when the person needs the live status card.

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

## Ask the owner on the task

Keep the task attached to your agent thread. Set Current state to explain what you need and why, and keep the workflow status accurate.
Use a decision when you cannot proceed without a choice, or a check when you know the next step and need validation.

Rules for owner questions (long questions are hard to answer):
1. One question = one decision or one thing to check: one state or topic, in one or two short plain sentences.
2. Split a multi-part acceptance into several `--kind check` questions, each answerable on its own, each with its own single link. The prompt and all `--step` lines together may carry at most one link (Markdown or bare URL); `question add` and `question update` refuse more. A check (and a `--reopen` of one) is refused while the card has plan debt: get the plan approved first, then ask the owner to verify.
3. What the owner has to do goes into `--step` (repeat it, at most 10 short steps; the card lists them under the question). Wrap a value the owner has to paste (a pattern, a JSON value, a command) in single backticks: the card shows it as code with a one-click copy of exactly that value. A value of 61 characters or more (a full command, a pattern, a JSON object) shows as its own block with a Copy button, so give a long value its own step or put it at the end of the sentence, and never split one value across several backtick pairs. One `--step` is one action or one observation in one sentence: "press A, then B and check C" is three steps. A step with several sentences is refused, and so is a step that chains actions with "then", "and" or a comma before another action; nothing is saved, so reword the step and add the question once. Evidence, tables, quotes of earlier remarks, inventories and history go into a task comment (attachment if long), never into the question. An agent cannot move a card to Done or Canceled while an owner question is open: the refusal lists each open question and its withdraw command.
4. Acceptance material is links only (a local design/canvas server or the product), never screenshots or image pairs.
5. Never ask the owner to accept or approve a plan. Put the plan in `plan`, run `plan submit KEY --reviewer <thread, or owner only when the user asked to approve the plan>` and wait for the approval or the notes (see Task plan → Review loop). `question add` refuses a question that links a task plan, and, on a task that has a plan, one that asks to accept or approve a plan.

For a readiness-gated check (`--smoke`, `--beyond-design`), question warnings and reopening a check, see `references/questions.md`.

A question that no longer matters, for example on a card you are canceling, is closed with `question withdraw` and a reason; never answer it yourself.

When an existing check's state changes, never add a parallel check. Open check: edit it with `question update`. Answered check, same prompt and steps: `--reopen`. Any changed prompt link or step: replace it with `bb work-board question add KEY --kind check --supersedes ID --supersedes-revision N --prompt ...` (N is the revision you read; RPC `supersedes: {questionId, revision}`). The old check closes with its answer and remark kept and gets `supersededBy`/`supersededAt`; the new one gets `supersedes`. A superseded check is never open (Waiting on me, badges, plan pause, auto-archive) and refuses answer, clear, update and reopen: act on its `supersededBy`. Refused: a target on another card, a decision target, an already superseded target, a newer revision or answer than N, `--supersedes` on a decision, and plan debt. Questions in a supersede chain cannot be deleted. A `--kind check` without `--supersedes` whose prompt matches a non-superseded check on the card is saved with a warning naming that check's id, revision and state and what to do with it.

One question asks one decision or one check in one or two short plain sentences, with at most one link. Put what the owner has to do in `--step` (repeat it; the steps show as a numbered list under the question), not in a comment. Split a multi-part acceptance into several `--kind check` questions, each answerable on its own with its own link. Evidence, tables, quotes of earlier remarks, inventories and history go into a task comment, not the question. Acceptance material is a link to a local design server or the product, never screenshots. When an existing check's state changes, never add a parallel check: edit an open one with `question update`, `--reopen` an answered one whose prompt and steps are unchanged, and replace it after any changed link or step with `bb work-board question add KEY --kind check --supersedes ID --supersedes-revision N`. Start the new prompt with what changed since the previous check.

## Topics

Open the reference when the task involves its topic; each file starts with what it covers.

- `references/questions.md`: question types and recommendations, evidence and templates, answer attachments; replace or reopen a failed check, the check flow (numbers, rounds, held checks), a withdrawn answer, `question update`, examples.
- `references/plans.md`: `plan show|set|edit|submit|reply`, plan debt, and the review loop (as the author or as the reviewer).
- `references/pr-ci.md`: `pr link`, `pr wait`, `sync`, linked-PR messages, review, QA and merge evidence, the Done-after-review rule, Check receipt, pausing an unfinished card.
- `references/threads.md`: attached sessions and worker recovery, `dispatch` to an existing thread, thread health, sharing task context, UI screens.
- `references/hierarchy.md`: epics, sub-agent hierarchy and provider limits, dependencies, sequence claims, locks, activity, recurring cards.
- `references/project.md`: project workflows and statuses, status push notifications, manager attention, repository checks, secret guard.
- `references/storage.md`: Git snapshots (export, import), task archive, archive queries, storage maintenance.
- `references/attachments.md`: files and images on tasks, comments and answers.
- `references/delegation.md`: dispatch and execution presets.
