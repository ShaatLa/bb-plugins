# Threads and assignment

Read this file when you attach, detach or recover a worker session, send a task to an existing thread, or read thread health.

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

## Worker assignment recovery (0.7.2)

Every new/replacement worker must `bb work-board attach KEY`; the task can have several workers. `bb work-board threads KEY` reconciles actual BB thread state. Archived/deleted/missing workers are detached with an Activity history event. The remaining available worker receives notifications; if none remains, walk the latest worker's BB `parentThreadId` chain (not the task/epic parent) to the nearest available ancestor, up to the root. If that fallback is later archived, continue upward. The task becomes unassigned when no available ancestor remains. Cycles, missing ancestors and private side chats stop traversal. Transient lookup failures preserve associations. Manual detach preserves history and does not inherit a parent. Do not assume an old agent comment means its thread still owns the task. Detached workers are not restored by unarchive; attach explicitly again. History is stored in exported system comments; archive stays v6.


## Automatic session attachment

A session created directly in BB is attached to every unfinished agent card whose key appears anywhere in its title, within the matching linked BB project. Use complete keys (`Designer: ABC-12, ABC-15`) or compact same-prefix lists (`ABC-12+15`). Duplicate references do not create duplicate links; existing manual links are preserved. Missing/malformed keys are not guessed.



## Assignment and abandonment

Assign an existing session without dispatching with `bb work-board attach KEY --thread thr_ID`; remove responsibility with `detach`, inspect with `threads`. In the task UI, the thread chooser's **Only assign (no message)** choice performs the same operation without sending messages or changing workflow status. Multiple collaborators are supported and existing links remain intact. A live idle session is **Assigned**, an executing one is **Working**. Go to thread opens it; new-session dispatch is hidden while assigned. The project default dispatch thread is a preference, not an assignment. Creators/requesters and comment authors are not silently assigned.

Abandoned requires recorded work AND a confirmed lost assignment (archived/deleted/missing or explicitly detached), no remaining session, complete provider diagnostics, and an unfinished agent task. Comments alone never establish that a task was taken. Unknown provider state is not abandonment. Existing legacy cards without an assignment can be assigned explicitly; task comments are preserved.


## Sharing task context

The **Copy task link** button next to the card key copies a Markdown task link for pasting into any agent chat. Copying never dispatches, assigns, or changes task status.
Export v14 (0.28.0) adds optional per-project workflow policy, outcome evidence and deploy PR citations; imports retain v1–v13 compatibility. Older releases cannot read v14 exports.

Use `list --stale-status` to filter diagnostic warnings before pagination; `list --json` and `show --json` expose `staleStatusFlags`. Diagnostics use recorded state, not a fresh remote check. Record non-PR results explicitly with `comment KEY --kind outcome --body "Result"`. Existing done cards with ordinary non-system comments are grandfathered until a status change. Configure rules using `project update PREFIX --workflow-policy-file policy.json`; omitted fields reset to defaults, null disables the corresponding rule.

