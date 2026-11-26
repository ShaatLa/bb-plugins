# Epics, hierarchy and coordination

Read this file when you work with epics, spawn child threads, link dependencies, claim sequence numbers, take a lock or read a card's activity.

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


## Dependencies (0.22.0)

Read `bb work-board dependency list KEY --json` before starting a task. Add `bb work-board dependency add ABC-2 --blocked-by ABC-1`; remove with `dependency remove ABC-2 --blocked-by ABC-1`. Reverse the keys to express Blocks instead. Only the predecessor's Done status satisfies a link; Canceled stays unresolved, and reopening restores the warning. These links warn; they never forbid dispatch or status changes. Respect the ordering and report blockers instead of assuming a permitted command means the task is ready. `show --json` provides `dependencies: {blockedBy, blocks}` and `blocked`; `list --json` adds unresolved `blockedBy`. Dispatch context includes unresolved predecessors. Both endpoints receive a system history comment on add/remove.

Use the Dependencies section in the task UI to search/add/remove links or open either endpoint. Board/list Blocked badges identify unfinished predecessors. Links are within one project; self-links and cycles are rejected. Move all connected endpoints together in a task family or remove the links before a project move. Exports store each task's outgoing dependency IDs, validates the graph and restores it atomically. Older imports preserve local links; conflicting imported sets need --overwrite. No merge condition or automatic workflow moves are inferred.

Related links (0.29.0) connect tasks that share context without blocking either one: `bb work-board dependency add ABC-2 --relates-to ABC-1`, `dependency remove ABC-2 --relates-to ABC-1`. The link is symmetric and same-project; `dependency list` and `show --json` return it under `dependencies.related`. Use it instead of a blocker when a task only needs to be read alongside another. Export v15 carries related links; imports accept v1–v14.


Agents can add/remove links with `bb work-board dependency add KEY --blocked-by OTHER` and `dependency remove KEY --blocked-by OTHER`.
