# Work Board

English | [Русский](README.ru.md)

## Storage management (0.22.2)

Settings → Work Board → General → **Storage** shows database/WAL usage, free database pages, logical blob contents versus allocated filesystem blocks, old unreferenced files, and missing attachment files. Statistics load when the settings page opens; Clean up and Optimize storage run only when pressed. Storage is shared across projects.

Daily cleanup removes orphan activity claims/queue markers and PR snapshots with no surviving link, plus unreferenced managed blob files older than 24 hours and empty blob directories. It rechecks references before deletion and protects active uploads/imports, including long-running imports. Symlinks are never followed. Tasks, archived cards, comments/evidence, questions, dependencies, PR links/exclusions, observed-work history and accessible attachments are retained. Missing files are reported without deleting their metadata.

**Optimize storage** also shares identical immutable blobs using filesystem hard links, preserving every attachment ID/path/URL and exact contents, then rebuilds SQLite and truncates its WAL when readers permit. The operation can take time on large boards. Unsupported hard links leave originals intact and report skips. Fresh databases use incremental vacuum; older databases enable it after the first explicit optimization. Later daily cleanups return up to 256 free pages per sweep. Retained WAL allocation is limited to 4 MiB when SQLite can reset it after checkpoints; active readers or a transaction may temporarily require more. Live data still consumes space as the board grows; this is not a retention policy that deletes accessible history.

CLI: `bb work-board storage status --json`, `storage clean --json`, `storage optimize --json`. Actions return before/after usage, removed file/cache-row counts, shared duplicate count and warnings. Statistics count allocated blocks by unique inode; filesystem compression/clones can make these differ from device-wide free space. Current export format is v18. Maintenance only touches this plugin's database and managed blob directories, not external project exports, repository files, old installation releases, BB logs or backups.


## Task plan (0.56.0)

A task has one plan: a Markdown document with numbered versions, kept apart from comments. Agents put the implementation plan there instead of posting "Plan 1/6 … 6/6" comments, revise it in place, and the current text is always one command away.

```sh
bb work-board plan show ABC-12 [--section "Steps 1–4"] [--version N] [--json]
bb work-board plan set ABC-12 --file plan.md --base-version 0 --summary "Initial plan"
bb work-board plan edit ABC-12 --section "Steps 1–4" --file part.md --base-version 1 --summary "Narrow the steps"
bb work-board plan edit ABC-12 --find-file old.md --replace-file new.md --base-version 2 --summary "Fix a number"
bb work-board plan restore ABC-12 --version 1 --base-version 3 --summary "Back to v1"
bb work-board plan log ABC-12          # versions: who, when, what, +/- lines
bb work-board plan diff ABC-12 [--from N] [--to M]
bb work-board plan submit ABC-12 --reviewer thr_example   # ready for review (owner only when the user asked to approve)
```

- Every write passes `--base-version N`, the version you read. If the plan has changed, the command refuses, names the current version and asks you to re-read with `plan show`, so nobody's edit is overwritten. The first version uses `--base-version 0`. `--summary` (up to 300 characters) says what changed.
- A section is a heading line plus its body up to the next heading of the same or a higher level (headings inside fenced code are ignored). Address it by the heading text, or by `Parent > Child` when the text repeats; a missing or ambiguous heading is refused with the list of headings. `plan edit --section` replaces the whole section including its heading, and an empty replacement deletes it. `--find-file` text must occur exactly once. A write that changes nothing is refused.
- A plan is at most 256 KB of UTF-8 and goes through the secret guard. Every version keeps its full text. The plan of an archived task is read-only.
- States: a new plan is `draft`; `plan submit` makes it `in_review`. Approve and request-changes decisions come from the reviewer (see **Plan review**); any new version returns the plan to `draft`.
- Every version, submit and state change writes a system comment on the task, for example `Plan v4 by <author>: <summary> · section "Steps 1–4" · +12 −4 lines`.
- `bb work-board show KEY` has a `Plan` line (`v4 · in_review · bb work-board plan show KEY`, or `-`); `show --with-plan` prints the plan after the description, and `show --json` has `plan` (`version`, `state`, `updatedAt`, `updatedBy`, plus `body` with `--with-plan`) or null.
- RPC: `getTaskPlan`, `listTaskPlanVersions`, `saveTaskPlan`, `diffTaskPlan`, `submitTaskPlan`, `setTaskPlanState` (`in_review | approved | changes_requested` only); the review RPC of 0.58.0 are listed under **Plan review**.
- Export **v18** stores the current plan and all its versions in the task record. Imports of v1–v17 work as before and leave local plans untouched; importing v18 over a different local plan needs `--overwrite`, which replaces the plan and its history.

## Task plan in the UI (0.57.0, polished in 0.57.1)

People read, compare and edit the plan without leaving the board.

- **Plan card.** The task detail has a **Plan** section between the description and **Current state**. Without a plan it says "No plan yet" and that agents create one with `bb work-board plan set`; **Write plan** opens the editor. With a plan it is a bordered card: the title with the state (draft, in review, changes requested, approved) next to it, the version and a **Copy link** icon on the right, the summary of the last version (two lines at most) and "Updated by … · time". The whole card opens the plan. The plan text is not repeated in the detail. The card refreshes live.
- **Plan tab.** **Open plan** opens a **Plan · ABC-12** tab in the side panel (in a thread and on the Work Board page; one tab per task). Without a side panel it opens the same view in the main area at `task/ABC-12/plan`.
  - The header has the task (click to open it) with the state next to it; on the right a compact version selector and icon buttons **Edit**, **History**, **Compare with previous** and a menu with **Copy Markdown**, **Copy link** and **Open task**. A muted line under the header says who saved the version on screen and when.
  - The plan is shown read-only with the same renderer as task descriptions, at a readable width. The table of contents lists the headings (not `#` lines inside code blocks), follows the reader while scrolling and jumps to a heading on click; it is a sticky rail to the right of the text in a wide panel and a collapsible list above the text in a narrow one.
  - **History** lists every version with author, time, operation, summary and +/− lines. Opening an older one shows it with a "Viewing v2 of v5 · Back to current" banner.
  - **Compare** shows a source diff of two versions (any pair, or a version and its previous): added and removed lines with changed words highlighted inside a revised line, and long unchanged runs folded.
  - A new version arrives live. While you read the current version it replaces the text; while you view an older version or edit, a "v6 is available · Show" notice appears instead and nothing moves under you.
- **Editing by a person.** **Edit** opens the exact Markdown source in a plain text area (no rich-text round trip, so diffs stay meaningful). A summary of the change is required (up to 300 characters). **Save** writes a new version with author "You" from the version you started on. If someone saved meanwhile, the editor says "The plan changed to vN while you were editing" and offers **Show the new version** (your text stays as a draft notice with **Copy my text** and **Continue editing**) or **Overwrite with mine**. Other refusals (no change, invalid, secret detected, archived task) are shown inline. An unsaved draft is kept per task while the app stays open. Archived tasks are read-only.
- **Links.** **Copy link** puts `[ABC-12 plan](/plugins/work-board/work-board/task/ABC-12/plan)` on the clipboard; in bb chat it opens the plan tab. **Copy Markdown** copies the source of the version on screen.

## Plan review: notes, feedback, approval (0.58.0)

The owner reviews the current plan version in the Plan tab; the agent answers each note.

- **Notes.** Select text in the plan: a small toolbar offers **Comment** (an inline popover with a text area, **Add note** / **Cancel**) and **Remove** (creates a "remove this" note at once; an optional reason is asked in the list). The header button **Add general note** writes a note about the whole plan. A note stores the selected text with about 32 characters of context on each side and the nearest heading path (`Parent > Child`); it is not tied to a position, so it follows the passage through later versions. Notes are numbered per task (N1, N2 …) and have a state: **Draft** (only the owner sees it; it can be edited and deleted), **Sent**, **Addressed** (the agent replied with `--addressed`, shown as "addressed in vN" with the reply) and **Resolved**. On an addressed note the owner can **Resolve** or **Reopen**; reopening makes it a draft again so it goes out with the next batch.
- **Where they are.** Passages with an open note are highlighted in the text (CSS Custom Highlight API; the editor DOM is not changed, and engines without the API show no highlight but keep the list); clicking a note scrolls to its passage and flashes it. A note whose quote is no longer in the version on screen gets an **Unanchored** chip and keeps its original quote; nothing is highlighted in a wrong place. In a wide panel the right column has two tabs, **Contents** and **Notes (n)**; in a narrow one a collapsible **Notes (n)** section sits above the text, like Contents. Older versions and compare mode show notes read-only and offer no selection toolbar.
- **Send feedback (N).** Sends every draft note to the agent in one message and moves the plan to **Changes requested** (the task log says `Plan v1: changes requested by You · 3 notes`). The message goes to the thread of the newest agent-written plan version, else to the thread a question answer would go to; it lists the notes in plan order (placed ones by position, then unanchored ones, then general ones), each with its section, quote and text, and tells the agent how to edit the plan and reply. If the agent cannot be reached the notes stay sent and the page says "Saved, but the agent could not be notified".
- **Approve.** Opens a confirmation with an optional note and sets the plan to **Approved**; the agent gets "plan vN approved by the owner … start the work as planned". It is disabled while the plan is approved or draft notes are unsent (the tooltip says which). Any new plan version returns an approved plan to draft.
- **Plan card.** Next to "Updated by …" the card counts "2 open notes" (sent, not yet answered), "1 draft" and "1 addressed".
- **CLI for agents.** `bb work-board plan notes KEY [--all] [--json]` prints the sent, unanswered notes in the format of the message (`--all`: every note with state and reply); `plan reply KEY N1 --body TEXT [--addressed]` answers a note; `plan show` and `show` add `· 2 open notes`; `plan submit` lists notes that are still unanswered but does not refuse.
- **Data.** Notes are kept across plan versions (each remembers the version it was made on) and are exported in format **v19**; imports of v1–v18 work and leave local notes untouched, and importing v19 over different local notes needs `--overwrite`. RPC: `listPlanNotes`, `createPlanNote`, `updatePlanNote`, `deletePlanNote`, `setPlanNoteState`, `replyPlanNote`, `sendPlanFeedback`, `approvePlan`.

### Reviewer threads, planning modes and the status gate (0.59.0)

A plan needs an approval before work starts. The author names the approver when submitting: `plan submit KEY --reviewer owner|thr_x` (owner only when the user asked to approve the plan; otherwise a reviewer thread on a stronger model). The flag is required on the first submit; later it defaults to the reviewer of the latest attempt, and another `--reviewer` takes the review over (one system line, then a wake). Work Board wakes the reviewer thread itself (`KEY · plan vN submitted for your review`, with the commands and, on a resubmission, the diff range and the number of blocking notes); a failed wake is retried by repeating `plan submit`, and an archived reviewer gets the `bb thread unarchive` hint, a deleted one the reassign hint. A thread that wrote the plan cannot review it.

- **A review is bound to one version.** Saving a new version, even during a review, returns the plan to `draft`; `plan submit` accepts only `draft`, so a plan with changes requested needs a new version first.
- **Reviewer commands (CLI, from the reviewer thread only).** `plan note KEY --version N --body TEXT [--quote TEXT [--section HEADING]] [--kind comment|remove|general]` (the quote must occur exactly once in the section or the plan; the anchor is the UI's own), `plan feedback`, `plan dismiss N1 …`, `plan resolve N1 …`, `plan reopen N1 …` and `plan approve [--note TEXT]`, each with `--version N`, the version the reviewer read. The call is refused unless the caller is the assigned reviewer, the plan is `in_review` and `N` is the submitted version. `plan approve` is refused while any reviewer-thread note is a draft or unresolved (convergence). `plan reviews KEY [--json]` lists the review attempts. The owner can approve or request changes on any plan in the UI; drafts are scoped per author, so a reviewer's drafts never block the owner.
- **Results go to the waiting author:** the thread that submitted the current attempt gets the actionable message; the author of the decided version gets an informational copy (an archived thread is replaced by its parent). The CLI and the owner UI report each recipient and name any thread that was not reached.
- **Planning is a per-project setting,** `off` (default) | `optional` | `required`, changed only by the owner in the Planning section of the project settings. Off hides the Plan UI, refuses plan commands and lifts every gate (the data is kept). Optional is plans, review and an advisory (`Plan vN is draft (not approved): …`, shown by `show`, in seed prompts and when attaching a thread). Required also refuses moving a non-epic card into the work zone, or creating it there, until its plan is approved. The work zone is the statuses the owner marked "only with an approved plan" in the status editor (chips in the Planning section, never canceled; the first switch to required prefills In progress and every later status, and nothing refills the flags afterwards; agents and `--statuses-file` never change a flag, and imports keep an existing project's flags). `project show` and `config get planning` list the marked statuses; delegation, scheduled runs and git sync skip the move instead of failing, and executors get one notice when an approved plan of a card in progress changes. Projects that already had a plan start as `optional`.
- **Data.** Export format **v20** carries the reviewer, note authors, the review history, the planning setting (with when it last changed and what it was before) and the status flags; imports of v1–v19 read a missing reviewer as the owner, never change an existing project's planning, and infer `optional` for a fresh project with plans.
- Authors and actors that are threads show as clickable thread chips throughout the UI.

### Review pause on an open decision, and the Planning status (0.62.0)

- **A review pauses while the owner has an open decision.** An open decision is an unanswered question of kind `decision` (a missing kind reads as one; `check` questions never pause). The pause is derived from the live questions, never stored: `plan show`, `plan reviews`, `show` (`plan.review.paused` in `--json`) and the Plan tab say "Waiting for the owner's decision". While it lasts, `plan submit` (and returning a plan to review in the app) is refused, and a reviewer's `plan approve` and `plan feedback` are refused; notes, dismissals and the owner's own decisions are not blocked.
- **One wake per transition.** When the open-decision count goes 0 → 1 or more, the current reviewer thread is told the review is paused; when it goes back to 0 it is told to read the decisions and judge whether the plan still holds, and the author gets an informational copy. A resume is sent only while the same review attempt is still current. An owner review has no thread to wake. A failed wake is a separate line in the `question` command output; the question is saved either way.
- **Planning status.** Turning planning on settles a `Planning` status between Todo and In progress (an existing one with the id `planning`, or the name Planning, is used instead; nothing is inserted when either is taken by a status that cannot serve, the list is full or In progress is missing). It is `workflowPolicy.planningStatus`, valid only while it is listed, not closed, not another workflow role and not marked "only with an approved plan". The first plan version moves a Backlog or Todo card there in the same write (`plan set` prints `EXA-1 moved to Planning`); delegation and scheduled starts treat it like Todo, and it counts as active work for `no_active_thread`. The manager-attention pilot set is unchanged. Turning planning off leaves the status in place.

### Plan debt (0.70.0)

- **What it is.** A card has plan debt when its project requires planning, it is not an epic, not archived and not closed (Done, the configured done status, canceled), it is in the work zone, and its plan is missing or not approved (a card already in progress when planning became required, a plan that left approval, a status marked later). Nothing blocks the card; it just has to catch up. Episodes are recorded at the committed change (start, end), and the install backfills existing debt with the install time as its start.
- **Where it shows.** A `plan-debt` advisory (`Plan debt since …: plan v2 is draft. Submit it for review: bb work-board plan submit KEY --reviewer …`) in `show`, `list --json` and the card, and `planDebt` in `show --json` (`since`, `planVersion`, `planState`, and the reminders still owed with their state). `bb work-board list --plan-debt` lists the cards with debt (the same `planDebt` filter on the `listTasks` RPC).
- **Reminders.** The card's active executors get one message each when an owner decision is answered on the card, when a PR link is confirmed (the `pr link` result also carries a `note`) and after 24 h in debt; after 24 h the manager (`manager` setting) is told too. Each reminder is a durable outbox row with its own receipt: a definite failure is retried on the next 10-minute scan, an unknown outcome is searched for and never resent blindly, and the rows stop when the debt ends. A new episode reminds again.

## Manager attention: stale-status notices

Work Board can send the manager thread one batched message about cards whose status looks stale. It is **off** for every project until the owner turns it on in the **Manager** section of the project settings (**Stale-status notices**).

- **What is sent.** A card is stale when it is In progress with no working session; In review with no open pull request and none merged in the last 2 hours; In testing with no open or merged pull request; In review or In testing when Work Board cannot read the pull request's state from GitHub; or in any of these statuses or Bugfix with a pull request closed without merging. Archived cards, cards waiting on an unfinished blocker and epics labelled `ongoing` are skipped. A problem must last 10 minutes before it is sent; the problems that come due together go out as one `Stale status` message (kind `stale-status`). While notices stay on, each problem is reported once, and again only if it clears and comes back.
- **To whom.** The manager thread chosen in the same section (`config get manager`), and nobody else: a message goes to that thread or nowhere. Picking a thread saves it at once; replacing or clearing a set manager first asks for confirmation, showing the old and the new name. The settings show a warning that names the cause when the manager cannot receive (none chosen, deleted, archived, stopping, a side chat, or could not be verified). While notices are on and the manager is unusable nothing is sent: the open problems wait, and a usable manager resumes delivery.
- **On and Off.** Turning notices on needs a linked BB project, no other Work Board project linked to it, and a usable manager; it takes effect at once and starts a fresh observation, so every card gets its 10 minutes again. Turning them off stops new messages at once; while a message is still being sent the section shows **Switching off** until it settles. Turning notices off and on starts over. By convention only the owner changes the switch (`updateAttentionMode` with `off` or `live`; `config get attentionMode` reads it); the CLI and `config set` refuse it, and the platform cannot tell the app from an agent calling the RPC, so a change is recorded (time and previous value) and logged rather than enforced. While notices are on or switching off, the project's BB project link is frozen (a restore from a snapshot included) and the project cannot be deleted.
- **Receipts.** Every send is an attempt with a batch marker and a proven outcome: `appended` (merged into the manager's queued message), `queued`, `inline` (accepted-input event seen), or `failed`/`unknown`. An `unknown` attempt is never resent by itself: the settings list it under **Notices with an unknown outcome** with **Accept the loss**, and with **Send again** while notices are on and the notice still has a card to send. A late receipt is still recorded, and an unknown attempt does not hold a switch-off.
- **Repository check reports.** While notices are on, the repository checks runner drops the script's `ACTION stale-status` lines from newly evaluated reports (the summary action count is lowered to match, and an exit 1 with nothing else left is a quiet run), so the manager is not told twice; a report staged before notices were turned on is delivered as it is. After notices are turned off, the first successful check sends the current stale-status lines as new, even when the last delivered report had the same lines.
- **Local only.** The switch, the ledger and the manager setting are never exported, and an import never changes them.

## Repository checks (0.64.0)

Work Board can run a project's repository check script on an interval and deliver its findings to the manager thread. **It is off for every project.** Nothing runs until the owner enables it, and only one Work Board project may run the checks of a BB project.

- **Settings** (per tracker, `bb work-board config get|set checks.KEY --project PREFIX`, and the **Repository checks** section of the project settings): `checks.enabled` (default off; **owner-only**: `config set` refuses it, only the settings UI changes it, and every change is logged with its time and previous value). This is a convention, exactly like the planning mode: the platform cannot authenticate the owner, so the guard is the one write path, the UI's `updateChecksEnabled` on the app's tasks RPC (not discoverable by agents, like `updateProject`), plus the audit log; agents never change it, `checks.branch`, `checks.script` (repository-relative, no `..`), `checks.args` (a JSON array of at most 100 strings; every `{manager}` becomes the manager thread id), `checks.intervalMinutes` (1–1440, default 10), `checks.timeoutSeconds` (1–300, default 300) and `checks.snapshots`. Fields are set one at a time from the CLI and validated at once; in the settings the script fields depend on each other, so they share one **Apply**, shown only while they differ from the stored values; it sends only the changed fields (`checks.configPatch`): they are validated together and written all or nothing. Unapplied edits do not lock the **Run repository checks** switch (the checks run with the applied values), and **Snapshots** is a switch that saves at once; while the runner is off, omitted fields are a draft, and enabling needs a complete, valid configuration (checked again before every run). Global native settings: `checksBbCli` (absolute path of `bb`) and `checksRuntimePath` (PATH entries for the script); `bb plugin config work-board`, or the collapsed **Runner paths (all projects)** block of the Repository checks card, whose fields save when they lose focus or on Enter (an invalid `bb` path is shown and not sent). Each write names the stored value it was edited from (`globalSettings.set` `expected`); a value changed elsewhere meanwhile is refused and shown with **Reload**, which rereads the stored values (`globalSettings.get`). A field is disabled while its own write or Reload is in flight. Writes from the settings page cannot overwrite each other or a change made in another window; a `bb plugin config set` made at the same instant may be overwritten.
- **Manager and repository.** The manager is the **Manager** section's manager setting, read as is (no fallbacks); with none set no new run starts. The Git URL comes from the linked BB project. The tracker keeps a private checkout under the plugin data directory: each tick fetches the branch with depth 1, checks out `FETCH_HEAD` detached with force, and cleans untracked and ignored files, with prompts and hooks off and 60 s per Git operation (a timed-out fetch is killed with its process group and only its own `shallow.lock` is removed). A failed refresh skips the run and backs off (doubling, at most one hour or the interval if longer).
- **Script.** Run in the checkout, `.py` through `python3`, anything else directly (executable). HOME and authentication are inherited; PATH is the server's, or `checksRuntimePath` when set, with the directory of the `bb` in use (`checksBbCli`, else the inherited `BB_CLI`) in front so bare `bb` and `BB_CLI` agree. The script gets `BB_PROJECT_ID`, `BB_THREAD_ID` (the manager), `BB_CLI`, and always `BB_CHECKS_COMMITTED_STATE` and `BB_CHECKS_CANDIDATE_SNAPSHOT`; with snapshots on it also gets `--committed-state` and `--candidate-snapshot`. Output (UTF-8, at most 1 MB) is made of `ACTION [kind]`, `ANSWER`, `WAIT`, `STATE` lines, an optional `checks: N threads, N cards checked, N actions` summary line and diagnostics; the variable names and summary prefix of older scripts still work; exit 0 quiet or baseline, 1 findings, 2 or more failure. A timeout is exit 2.
- **What is sent.** Only a change: a new action or answer, a Waiting addition or removal, a changed exit-1 diagnostic that has no parsed rows, a changed candidate (decoded as strict UTF-8 JSON; anything else is an exit-2 failure that keeps the old snapshot), or a new failure (a quiet success resets failure de-duplication). Counts, order and the known volatile counters never count. Changing the manager resets the baseline.
- **Delivery.** A staged report is delivered before anything else on every tick, even with the runner disabled (the scheduler drains it) and under refresh backoff. Each attempt is recorded before the send and judged by its receipt (`inline`, `queued`, `appended`); only these accept the report, promote the snapshot candidate and clear it, in one transaction. A definite rejection (including a definite 4xx on an append whose row reads back unchanged) or an unusable manager keeps the report pending, sends a push alert and retries the then-current manager next tick. An uncertain send keeps the report with that attempt: the next passes search the recipient's history for its marker (bounded as in manager attention) and no second attempt starts; when the evidence stays unreadable or absent the attempt becomes `unknown`, a push is sent, and the owner's **Retry** in the settings sends the exact pending bytes again to the current manager (it may duplicate). A late receipt acknowledges only its own report, once; accepting clears the delivery error it resolves, while an independent script or refresh failure stays. The status of an unknown outcome reads `blocked: delivery unknown, Retry needed`. An accepted send followed by a crash before the commit can still duplicate a message; the report id in the marker identifies it. **Notice fallback (0.72.0).** When the manager definitely did not get the report (unset, unusable, or a definite rejection), the report goes to Agent Hub 0.3.243+ as a notice (RPC `notice`, key: source `work-board` plus the original tick), shown in the manager's chat or in Questions; Agent Hub pushes the owner, so Work Board sends no push of its own. The attempt is recorded before the call; while its outcome is uncertain the report is not sent to the manager, and a replay with the same key accepts the existing notice. Only a 400 `invalid_input` (or a body over 1 MiB, formatted and raw) refuses for good; a 404 `unknown_method` or no Agent Hub keeps today's behaviour (pending plus push) and a later Agent Hub picks the report up. Bounded unproven replays end as `unknown` with one push and **Retry**. `checks status` shows `to agent-hub (notice)`, the fallback reason and `N delivered (M as notice)`.
- **One owner per BB project.** A tracker owns the runner of its linked BB project while it is enabled or *draining* (a run in progress or an undelivered report, even when disabled). Another tracker linked to the same BB project can neither enable nor run manually, and relinking, resetting or deleting the tracker (force included) is refused while enabled or draining. Staged reports and committed snapshots record their BB project; after a relink they are not applied, and the status shows `State belongs to proj_example; reset it`.
- **Commands.** `bb work-board checks status --project PREFIX [--json]` (last and next run, exit, failure stage, pending report, receipt and destination, errors, counts), `checks run --project PREFIX [--dry-run]` (refresh and run once; it never stages, delivers, promotes or counts, never retries a pending report, and the script itself may still have side effects) and `checks stats --project PREFIX [--days 1-30]` (scheduled ticks, executed, deliveries, repeats, suppressed reports, refresh, script and delivery failures, and `deliveryUnknown` for reports blocked on Retry, all for the currently linked BB project only, first-seen items by kind; a failed refresh counts as a check, a tick that only backs off or retries a pending delivery is scheduled but not executed, and an accepted retry counts at its own tick).
- **Archived worktrees (0.68.0).** After the script on each scheduled run the runner also looks for git worktrees an archived thread left under the thread storage root (the project's sources and ready git environments, managed environments excluded), measures each unreported one (size, clean or dirty; nothing is ever modified) and adds an `ACTION archived-worktree thr_…: "/path" (N KiB, clean|dirty)` line per thread to the same report, so a new path alone also sends one. A path is delivered once: it is pending while its report is staged, reported when the delivery is accepted, and forgotten only after a complete scan sees it gone. A manual `checks run` and a disabled drain never scan; `checks status` shows the reported and pending path counts.
- **Local only.** Checks settings, state, snapshots and attempts are never exported, and an import never changes them.

## Task dependencies (0.22.0)

Use the task's **Dependencies** section to add or remove **Blocked by / Blocks** links and search predecessors by key or title. Board cards and list rows show **Blocked** with the unfinished predecessors; task details retain satisfied links and their status. A predecessor satisfies its links only in **Done**. Canceled does not satisfy them, and reopening Done restores the warning. These are warnings: dispatch and status changes remain available, and workflow status is never replaced automatically.

Agents can use `bb work-board dependency add ABC-2 --blocked-by ABC-1`, `dependency list ABC-2 --json`, and `dependency remove ABC-2 --blocked-by ABC-1`. `show --json` includes `dependencies` and `blocked`; `list --json` includes unresolved `blockedBy`. Dispatch prompts include the current blockers. Add/remove operations record history on both cards. Self-links and cycles are refused. Links currently stay within one project; moving a task family is allowed only if it carries all its dependency endpoints. Exports preserve outgoing dependency IDs (introduced in v12); imports v1–v11 preserve existing local dependencies.

Performance: activity consumers share bounded SDK reads and immutable dispatch attribution; Git sync batches attached sessions and shares post-merge pages within each run; archive capture batches SQL and limits JSON I/O while keeping blobs sequential; downloads revalidate privately with ETags and avoid an extra full-size buffer copy. Browser snapshot writes are coalesced and bounded, and PR overlap preparation is reused. Small English comments describe the resource invariants beside these paths.

Project creation is available directly in **Settings → Work Board → New project**, as well as in **Manage → Projects → New project** and the Work Board sidebar. Existing projects can be opened from the **Projects** tab; the creation form uses the same name, unique prefix, color, folder, and connection to a BB project. In Settings, the new project is automatically selected for configuration.

## Agent cost (0.39.0)

With the optional Tokenomos plugin installed, the task rail shows what agents spent on the task (API-equivalent price). A thread counts from "Thread attached" to "Thread detached", or until now while linked. Workers often stay linked to old tasks while moving on, so at any moment a thread's time belongs to the task it was attached to most recently. Commenters (a manager, a reviewer) and parent-fallback links do not count. Epics and tasks with subtasks sum their whole tree: the time windows go to Tokenomos (`costs.sum` with `spans`, descendants included) in one call, so shared threads count once. The Cost section (0.42.0) shows the total, a pie of the models that did the work, and a collapsible list of every counted thread with its model and cost (`breakdown: true`; older Tokenomos versions show only the total). The browser asks Tokenomos directly, so its `usage` invalidations refresh the section live with no polling. `~` marks an estimate or incomplete data; without Tokenomos the section is hidden.

## Public RPC for other plugins (0.36.0)

`threadTasks({threadId})` is discoverable (`bb plugin rpc list work-board`) and returns the tasks currently linked to a thread, newest link first: `key`, `title`, `status {id, name, icon?, color?, iconName, cssColor}`, `projectName`, `archived`, `linkName`, `linkedAt` and `url` (the in-app path that opens the task). Call it through `bb.sdk.plugins.callRpc({ pluginId: "work-board", method: "threadTasks", ... })`. `status.iconName` is a shared app icon (`work-board/status-<glyph>`, registered with `app.experimental_icons`, drawn in currentColor), so another plugin renders `<Icon name={status.iconName} />` inside `style={{ color: status.cssColor }}` and gets the same glyph and theme color as Work Board (0.37.0). The contract only grows with fields.

Every message Work Board sends into a thread (comment and answer notices, reports to a parent, plan feedback, delegation briefs and scheduled runs) starts with bb's origin line `[bb message from plugin:work-board]`, so the receiving agent reads it as the plugin's message, not the owner's words. Text appended to a still-queued notice adds no second header (0.57.2).

`threadBoard({threadId})` returns the board of the Work Board project linked to the thread's bb project, so another plugin can show it beside a chat: `project {id, name, url}` (null when no project is linked) and `columns` in workflow order, each with `status` (same shape as above), `total` active top-level tasks and up to 30 `cards {key, title, type, priority, mine, url}`. `mine` marks tasks linked to the thread, and those cards are always included even past the cap (0.52.0).

The kanban board glyph is the shared app icon `work-board/kanban`, so a tab that shows the board can use `icon: "work-board/kanban"` (0.52.1).

To show the full Work Board board inside another plugin's UI, render an empty `<div data-work-board-host="board" data-thread-id="thr_…">` and let React leave it empty. Work Board's app overlay finds the node and renders the thread's board there: the board of the project linked to the thread's bb project, with the thread's own cards outlined, and filters, drag and drop, and task opening. It keeps Work Board's own RPC, realtime and navigation, so nothing is bundled into the host plugin. Once rendered, Work Board sets `data-work-board-ready="true"` on the node. Give the node a height (for example `h-full min-h-0`). The native thread side panel tab outlines the thread's own cards the same way (0.53.0). A plain left click on a web link inside the hosted board dispatches a bubbling, cancelable `work-board:open-url` event with `detail: { url }` from inside the node; when the host calls `preventDefault()`, Work Board leaves the link to it, so the host can open it in its own surface (0.55.1).

## Scheduled tasks CLI

`bb work-board schedule ...` manages recurring and one-time scheduled tasks through the same validated RPC
handlers as the Scheduled page: `list`, `show`, `create`, `edit`, `reschedule`, `enable`/`pause`/`resume`,
`delete --yes`, `preview`, `run-now`, `retry`, `cancel-queued`, `resolve`, `dismiss`, `runs`, `needs-attention`
and `results`. Use `--daily|--weekly|--at` with `--time`, `--timezone` and `--days`, and `--thread` or `--preset`
(`--rule`/`--target` accept the raw JSON). Schedules are addressable by UUID or by the key of their template or
result task; the template key printed by `schedule show` works with ordinary task commands. Descriptions can be
read with `--description-file` from the invoking machine. `--json` returns the contract objects with stable
state enums and bounded pages (`--limit`, `--cursor`, `--all`). Scheduled templates and not-yet-started results
stay out of the normal `list` unless `--include-scheduled` is passed. See `skills/work-board/SKILL.md` for the full guide.

## Project settings

Settings → Work Board has two groups, each made of cards with a heading and a one-line description. **General** applies to every project and is shown even without one: **Start and links** (start screen and where thread links open), **Navigation badges** (six switches) and **Storage**. Its fields are the native plugin settings, so `bb plugin config work-board` keeps working; the host's flat list of the same fields is hidden while this page is shown. **Project** has the project selector, **New project** and **Manage labels and presets**, then the selected project's cards in this order: **Workflow** (statuses and planning), **Archiving**, **Activity and notifications** (idle threads and status notifications), **Manager** (manager thread, stale-status delivery and the two PR message switches), **Git and pull requests** and **Repository checks**. One control style throughout: switches and selects save at once, text fields save when they lose focus or on Enter, never while typing, and each card shows **Saving…**, **Saved** or **Failed** with **Retry**. An invalid value shows its error and is not sent; a failed one stays in its field. Only the script fields of **Repository checks** wait for **Apply**. Stale-status notices are turned on and off by a switch on their row, without opening it. The last selected project is still remembered on each device.

Existing projects inherit the former plugin-wide archive interval and idle threshold once during upgrade. New projects default to auto-archive Off and idle warnings after 45 minutes. The migration briefly registers legacy controls to read their values; reload the plugin after the first upgrade to remove those controls. Changing a project never changes another project's policy. Export v11 includes both project settings; v1–v10 imports remain accepted and missing settings preserve existing choices (or use Off/45 for a new imported project). General preferences are local and are not exported.

```sh
bb work-board project show EXA --json
bb work-board project update EXA --auto-archive 14 --stale-idle 60
bb work-board project update EXA --auto-archive off --stale-idle off
```


Source: [ShaatLa/bb-plugins](https://github.com/ShaatLa/bb-plugins/tree/main/plugins/work-board). Install this collection entry with `bb plugin install git:https://github.com/ShaatLa/bb-plugins.git@0.x --plugin work-board --tag-prefix work-board/` after disabling built-in Tasks and completing any data import described below. Existing local-path Work Board installations can be re-registered with `bb plugin install /path/to/collection --plugin work-board` while retaining the same plugin ID and data.

Project tracker for collaborative work between humans and AI agents inside BB. Based on the built-in BB Tasks from BB 0.46.1, it retains its projects, comments, attachments, presets, and thread links.

- Lists and Kanban boards in the main and right panels, epics and subtasks, search, filters, and custom statuses for each project.
- Delegate tasks to existing threads; collect owner decisions and validation through typed questions.
- Questions with single or multiple selection, suggested options, and answer saving directly within the task.
- GitHub PR linking, CI and push-workflow monitoring after merge, structured review and QA evidence, and description templates.
- Searchable archive of completed tasks, manual and bulk archiving, and optional automatic archiving.
- Deterministic project export and import including comments, attachments, questions, and links — for storing history in Git. Works via the UI and `bb work-board` CLI.

The task card now features an **Existing thread…** button. Select an existing thread or paste its ID. A busy thread will queue the task context; an available thread will start working. The thread's model, permissions, and environment are preserved. No preset or project binding is required for this action.

The thread selection button sits above the preset, and both share the same width. In the selection dialog, **Use this thread by default** saves the chosen thread for the project on this device. The main button then displays its name and sends the task directly; an arrow immediately opens the thread list. **Clear default thread** reset is located in the same dialog. If dispatch fails, the saved selection is not changed. If a thread is already attached to a task, the main button changes to **Go to thread** and opens it without resubmitting the task.

Command: `bb work-board dispatch ABC-12 --thread thr_existing --instructions "Extra instructions"`.
To create a new thread, continue using `--preset`; both flags cannot be passed together.

In **Settings → Work Board → General → Start and links → Start screen** (native field `startScreen`), you can choose the startup screen: the last project's Kanban (default), the last project's task list, all tasks, or active tasks. The last selected project is remembered on this device. If the project is deleted, the first available project opens. Direct links continue to navigate to the screen specified in them.

Click the project name (or **All tasks**) in the header to switch to another project or to All tasks.

The **Board / List** toggle in the project (or task) header switches the main area between the full-width board and the task list, and is remembered per project (0.54.0). A project opens as a board until you pick the list (0.55.0). The right-side **Kanban** tab is independent: open it from the panel's tab strip to keep a board beside the list or a task. The board header includes a **Scheduled** button that opens the schedule in the main area. The board tracks the selected project, preserves card dragging, and updates in sync with the task list.

The **Work Board** tab in the thread's right panel defaults to the Work Board project linked to the thread's BB project. Board cards and new tasks open in the same tab; **Back to project board** returns you to the board. The task key and back button are located in the card header above the title. A copy button sits next to the key and copies only the key. The dedicated task bar at the top of the side panel is streamlined and doesn't take up extra space. Opening a specific task from a message persists across navigation. The header arrow opens the board or task in the main Work Board section. If the projects aren't linked, the panel displays **Manage projects** instead of automatically switching to the last viewed project.

Both the main screen and right panel board share the **Type**, **Status**, **Priority**, and **Label** filters, plus a **Clear** button. Filter selections are saved per project alongside the task list filters. Manual card ordering and dragging actions are preserved.

The **Search tasks** field in both the list and board accepts input immediately and displays results directly below. It searches across keys, titles, and descriptions, including epics, subtasks, and completed tasks. The search isn't constrained by the current view's filters: within a project, it's scoped to that project, while in All tasks and Active, it spans all projects. Exact keys also match previously assigned keys for moved tasks. Search results open directly in the current panel, and selection supports keyboard navigation. When in a project view, entering a task number resolves directly to its key. Upon opening the view, an index of active tasks is preloaded, including epics, subtasks, and descriptions. Input filters it locally without request latency or per-character RPC calls; incremental updates are loaded in the background. Text search returns the first 25 matches and indicates when the query should be refined. If a previously assigned key for a moved task or an exact key for an archived task isn't in the local index, the server resolves it.


## Migrating from Agent Board / Tasks Plus to Work Board (0.11.0)

This is a plugin ID change, not the installation of a second, independent board. The new ID and collection folder are `work-board`, and the command is **`bb work-board …`**. There are no legacy CLI aliases. First, update your command consumers: automations, agent roles, and strict export validation. The `project.json.format` marker is now `bb-work-board`; exports then used version **v13** (now v17). Imports also accept `bb-agent-board` and `bb-tasks-plus` (v1–v13).

Save your settings (`bb plugin config agent-board --json`) and back up the database using the SQLite backup API along with a copy of the `blobs` folder. Stop the old plugin before migration; the destination directory must not exist:

```sh
bb plugin disable agent-board
python3 scripts/import_tasks.py --source-plugin agent-board
bb plugin install git:https://github.com/ShaatLa/bb-plugins.git@0.x --plugin work-board --tag-prefix work-board/
bb work-board status --json
```

If Tasks Plus is installed, use `tasks-plus` instead of `agent-board` in the settings export, disable, and `--source-plugin` commands. The migration helper is located in the new `plugins/work-board/scripts` folder.

The helper copies the database to `~/.bb/plugins/work-board`, preserves the ID and all tables, migrates attachments, and updates only old attachment URLs to the new ID, including links in questions and the JSON history. The source remains untouched; migrating over existing data is prohibited. On first run, the previous `autoArchiveAfterDays`, `staleIdleMinutes`, and `defaultScreen` settings are migrated automatically. Archiving and idle thresholds are later adjusted in the settings of the selected project; the default page is the start screen field at the top of the settings page. PR settings and links are stored directly in the database: migrate their current values at the time of switching. Keep the old plugin disabled until you verify the migration and export, then unregister it; keep backups stored separately.

When rolling back after new entries, migrate the **latest** data back, rather than overwriting it with an old snapshot. Disable Work Board, back up both directories, and clear the destination folder, then run `--source-plugin work-board --destination-plugin agent-board` (or `tasks-plus`); install the previous frozen release and restore your settings. The `--data-dir` parameter supports an alternate BB directory.

The last project, view, filters, and preferred thread/preset are migrated to the device only once; current Agent Board preferences take priority over older Tasks Plus ones. Legacy values are retained for rollback purposes, but caches are not migrated. Historical messages and serialized mentions in BB are not rewritten. The `::task{key="ABC-1"}` directive is preserved. Old attachment links within imported archives are normalized; archives containing account data and tokens are not generated.

## Card Loading

The card displays local task data, saved threads, and comments without waiting for GitHub or agent metadata refinement. These data updates independently in the background: the card remains available, open editors stay intact, and the typed title is preserved. Git loading is indicated by a spinning arrow in the Pull requests block; synchronization does not block adding or editing PR links. The Activity section initially shows the latest 20 entries; **Show earlier activity** expands older entries in batches of 20 without discarding history. Standard comments are rendered by BB's native Markdown renderer instead of launching a separate editor for each comment, and legacy plugin special links continue to work.

The Evidence section is collapsed by default; its header shows the number of entries and, when there are warnings, their count. Expanded, it initially shows the latest 15 entries. **Show earlier evidence** expands history in batches of 15, preserving grouping by PR and head, as well as superseded markers. The limitation applies only to the UI; the full history remains in the data and exports.

The board displays the first page of tasks immediately, without waiting for metadata, questions, PRs, or Git. On subsequent opens, it uses the cached task set and updates it in the background. The board, standard list, and search share a single active task load, including subtasks; list filters and search operate locally. UI pages allow data modifications during reads and refine results via events, whereas the CLI strictly validates cursor revisions by default.

Columns are virtualized: the DOM only contains cards for the visible area with a buffer, while the rest is represented as scrollable space. Card heights are measured; expanded subtasks retain their state. Scrolling and dragging use the full column coordinates.

Attachment counters and active thread connections are read in batches of 500 IDs, with a maximum of four concurrent RPC calls. Questions and PR summaries are updated selectively. PR summaries read only the required JSON fields from SQLite, avoiding parsing of full CI reports. Git polling dispatches individual events for verified PRs instead of invalidating all project tasks. The export format, CLI behavior, and task data remain unchanged.

## Thread Health Indicators

Task cards on the board (main and side panels) and list rows display passive markers; the detail view shows a failed thread outlined in red with a failure timestamp. Nothing is sent to threads or agents, and no server-side timers or notifications are used.

- **Red marker** — an incomplete task (not `done`/`canceled`) has an attached thread in `failed` status (BB sends `thread.failed` for both crashed steps and interrupted runs: daemon restart, lost connection). Tooltip: "Thread <title> failed". The marker clears when the thread becomes active, detached, or archived.
- **Amber marker** "Thread idle 52 min, task not updated" — the task is not `done`/`canceled`, not in the project's review status (default `in_review`) and has no unanswered owner question, there is an idle thread, no working/starting thread, and `now − max(idleSince, lastTaskActivityAt) ≥ threshold`. `idleSince` is `task_threads.updated_at` (time of the last status change, no migration required; if multiple idle threads exist, the most recent is used); `lastTaskActivityAt` is the maximum of `tasks.updated_at` (field and status updates) and non-system comments, including evidence. The threshold is configured per project: `staleIdleMinutes` (off | 30 | 45 | 60 | 120, default 45). Calculation runs on read (`listTaskCardMeta`), and the UI refreshes the timer once per minute.
- `show --json` and `list --json` include `threadHealth: {failed: [threadId…], staleIdle: {threadId, idleMinutes} | null}`.

The data is not exported: it is derived state. The "needs attention" filter has not been added.

## Project Statuses

In **Settings → Plugins → Work Board → Workflow**, select a project and press **Edit** next to Statuses to open the editor (**Done** returns to the order preview). The **+ Add status** button adds a row for a new stage (e.g., **In testing**). The ID is generated automatically. Names and new statuses are drafts until **Save** (or Enter); leaving a field writes nothing, Escape reverts a name, and **Done** waits until the drafts are saved or discarded. Icon, color, order and removal are saved at once, as are the Planning controls, and none of them writes the name drafts: Save merges the drafts by status id into the latest stored statuses. Dragging the handle on the left changes the order of statuses and board columns. Keyboard shortcuts: Space, arrow keys, then Space or Enter; Escape cancels the move. Settings apply only to the selected project and are used in the list, main and right boards, filters, and card menus.

Click the icon next to the status name to select one of 20 available icons. **Default** restores the original icon. Icons are saved automatically for the selected project and appear in all task views; selecting an icon does not affect status behavior. You can also choose from 10 colors in the existing palette. The color is saved independently of the icon. Statuses without a selected color use the theme color.

The status ID is permanent and cannot be changed, but the name can be edited. IDs allow 1–64 lowercase Latin letters, digits, and `_`, and must start with a letter. Names allow 1–80 characters. A project can contain 6–32 statuses; IDs and names must be unique within the project. The six system IDs (`backlog`, `todo`, `in_progress`, `in_review`, `done`, `canceled`) are preserved; you can edit their names and reorder them. New stages are treated as incomplete. Task completion and owner notifications remain tied to `done`, while cancellation is tied to `canceled`.

```sh
bb work-board project show EXA --json
bb work-board create --project EXA --title 'Check the build' --status in_testing
bb work-board update EXA-8 --status in_testing
bb work-board list --project EXA --status in_testing
bb work-board list --project EXA --exclude-status done,canceled
bb work-board project update EXA --statuses-file ./statuses.json
```

The `statuses.json` file is a complete ordered array `[{"id":"backlog","name":"Backlog"}, …]` containing all system IDs. It is read on the calling machine; for remote machines, use `--machine`. RPC method: `updateProject({projectId, statuses:[{id,name},…]})`; the `project.statuses` field is available in the project JSON. Export **v6** stores this array in `project.json`, and `task.status` contains the ID. Importing v1–v5 restores the original six statuses. Other archive files remain unchanged.

## Secrets Protection

Starting with **0.1.1**, creating and editing tasks and epics, writing comments (including agent-generated ones), and imports check new headers, descriptions, and comment bodies for known key formats from GitHub, AWS, Slack, Google, Anthropic, OpenAI, JWT, and private key blocks. The write operation is rejected entirely; the error identifies the field and format without exposing the value. No bypass flag exists, and `import --overwrite` does not disable the check either.

The check recognizes known formats rather than detecting all possible secrets. It does not scan attachments or previously saved data, so pre-Git commit checks should still be maintained.

## Multiple-choice questions

In a task or epic card, open **Add question** in the right bar (in narrow mode, among the top properties). Add a prompt and 2–20 options; **Allow multiple answers** enables multiple-choice mode. Save the selection with **Save answer**; **Clear selection → Save answer** clears it. This captures the definitive answer to the question, not a poll where each user casts a separate vote. Answer changes are logged in the task history. Both questions and options have fixed persistent IDs; labels are not used as references. Conflicting answers from an older revision are rejected.

```sh
bb work-board question add EXA-8 --prompt 'Which size?' --option 'Small' --option 'Large' --json
bb work-board question add EXA-8 --prompt 'Which platforms?' --option macOS --option Linux --multiple --json
```

One question asks one decision or one check: the prompt and all `--step` lines together carry at most one link (Markdown or bare URL), and `question add` and `question update` refuse more. A multi-part acceptance is several `--kind check` questions, each with its own link. While the card has plan debt (in work without an approved plan), `question add --kind check` and `--reopen` of a check are refused with the plan state and the `plan submit` command, because the plan can still change what the owner would verify; decisions stay allowed (0.73.3). `question update --reopen` asks the same thing again, makes the reopening thread the asker so the new answer reaches it, and refuses steps or links the answered revision did not have: a new state is a new question (0.58.2). For an answered check the ordered steps and the prompt's links must stay exactly the same; any change is refused with the `--supersedes` command below. A changed answered decision is asked as a fresh decision question.

When the state of an existing check changes, never add a parallel check (0.76.0). An open check is edited with `question update`; an answered check whose prompt and steps are unchanged is reopened with `--reopen`; any changed prompt link or step replaces it: `bb work-board question add KEY --kind check --supersedes ID --supersedes-revision N --prompt ...`, where `N` is the revision you read. The new check is open; the old one is closed with its answer, remark and history kept, and gets `supersededBy` and `supersededAt` (the new one gets `supersedes`). A superseded check no longer counts as open anywhere (Waiting on me, badges, plan-review pause, auto-archive), refuses answer, clear, update and `--reopen` with a pointer to its successor, and shows dimmed and collapsed under its successor in the card. The add is refused when the target is on another card, is a decision, is already superseded, or has a newer revision or answer than `N`; `--supersedes` with a decision is refused, and so is a check while the card has plan debt. Questions in a supersede chain cannot be deleted. `question add --kind check` without `--supersedes` warns (stderr; `warnings` in JSON) when an open or answered check on the card has the same prompt (trimmed, case-folded, whitespace collapsed), naming its id, revision and state; it still saves the check, since two checks may differ only in their steps. `question list` marks superseded checks on stderr, and imports refuse links that are not reciprocal, cross cards or form a cycle.

Export format **v22** (0.76.0) carries `supersedes`, `supersededBy` and `supersededAt` on questions. Imports of v1–v21 still work, and a v21 or older archive that carries these fields is refused. A Work Board that reads only up to v21 refuses a v22 archive by its version, so export for an older install from an older install.

A plan is not approved through a question: `question add` and `question update` refuse a question that links a task plan, and, on a task that has a plan, one that asks to accept or approve a plan. The agent runs `plan submit KEY --reviewer …` and the reviewer approves or sends notes (0.58.3; reviewer threads 0.59.0). With planning off for the project this guard does not apply.

Each `--step` is one action or one observation in one sentence, shown as its own numbered line: `--step 'Press Retry' --step 'Close the message' --step 'Check that the list appears'`, not one step that does all three. A step with several sentences is refused; a step that chains actions with "then", "and" or a comma before another action is refused too, naming the step and the fix, and nothing is saved (0.66.0). Moving a card to Done or Canceled from an agent session (`update --status`, `boardMove`/`updateTask` with `agentThreadId`) is refused while an owner question is open, listing each question; the owner, in the UI, may still close the card.

```sh
bb work-board question list EXA-8 --json
bb work-board question answer EXA-8 --question <question-id> --answer <option-id> --revision 1
bb work-board question answer EXA-8 --question <question-id> --clear --revision 2
bb work-board question delete EXA-8 --question <question-id> --revision 3
```

For multiple selections, repeat `--answer`. Questions are visible in the main and side cards, in `show --json` output, in delegation context, and in task mentions. Exports include the questions, options, selected IDs, answer author, and revision. Secret protection covers the question and option text as well as answer metadata.

When an answer is updated, the plugin notifies askedByThread if provided; otherwise, it targets the first pinned work thread (active ones first), or the most recent responding agent. A target thread that is archived or deleted passes the notification to its parent thread. If a thread is busy, the notification is queued. Re-submitting the same answer won't trigger another notification. Delivery failures still save the answer and display a warning. Agents re-read the current answer before proceeding. Cards and rows display a question icon with a count and tooltip. The **Waiting on me** filter works across lists, the main board, and the right board, and is remembered per project.

Free text is always available. Single choice accepts either one option or text; multiple choice also permits both. Use `bb work-board question answer KEY --question ID --revision N --text "Answer"`.

Editing: use **Edit question** in the card, or run `bb work-board question update KEY --question ID --revision N --prompt "New text"`. The `--options-file` flag reads a JSON array `[{"id":"existing ULID","label":"New label"},{"label":"New option"}]` on the calling machine; retain existing IDs and omit them for new options. `--mode single|multiple` switches the selection mode. For a completed question, explicitly choose **Clear the saved answer and request a new decision** or use `--reopen`: the original answer remains in **History**, the current state is cleared, and the status reverts to Needs answer. The old revision is rejected. Each modification saves the previous snapshot; canceling and re-saving identical content leaves the history unchanged.

Recommended options are shown in bold, without a badge or auto-selection. In the editor, toggle **Recommend** next to an option and optionally fill in **Recommendation reason**. CLI: `bb work-board question add KEY --prompt 'Question?' --option A --option B --recommend 1 --recommendation-reason 'Rationale'`; indices start at 1. Update by persistent ID: `question update KEY --question ID --revision N --recommend OPTION_ID [--recommendation-reason TEXT]`; repeat `--recommend` for multiple selection, and use `--no-recommendation` to clear recommendations. The options JSON schema supports optional `recommended: true` and `recommendationReason`. Single-choice questions allow only one recommended option, while multiple-choice allow several. The reason is only valid when `recommended=true`. Secret scanning also applies to recommendation reasons. Export v4 includes these fields in history; import from v1–v3 is supported. Legacy explicit suffixes "(рекомендую)" / "(recommended)" are displayed in bold without the suffix; saved labels are not automatically updated.

## Evidence and description templates

`bb work-board comment` without `--kind` remains a regular comment. `--kind review|qa|merge|deploy|exemption|outcome` adds verified structured data; `--body` / `--body-file` still contains free-form remarks. All SHA hashes are exactly 40 hexadecimal characters. Evidence is stored as an optional `evidence` field on the comment; the top-level `kind` remains `user`, `agent`, or `system`.

```sh
bb work-board comment EXA-8 --kind review --pr 123 --head <full-sha> --verdict approve --thread thr_review --lens correctness --body 'Review passed'
bb work-board comment EXA-8 --kind qa --head <full-sha> --verdict partial --thread thr_qa --pr 123 --target localenv --note docs/qa.md --body 'Findings in the report'
bb work-board comment EXA-8 --kind merge --pr 123 --head <full-sha> --merge <full-sha> --part 1/2 --body 'Merged'
bb work-board comment EXA-8 --kind deploy --merge <full-sha> --run <ci-run-id-or-url> --env development --body 'Deployed'
bb work-board comment EXA-8 --kind exemption --row qa --reason 'Docs only' --owner-quote 'No QA needed' --date 2026-10-23 --body 'Approved'
bb work-board evidence EXA-8 --pr 123 --kind review --kind qa --json
```

For review, PR, head, verdict, and thread are required. For qa — head, verdict, and thread. For merge — PR, head, and merge. For deploy — merge, run, and env. For exemption — row and reason; owner-quote and date are passed together. Evidence appears above the history in the card and above Comments in `show`; `--json` preserves full SHA hashes and all fields. Grouping is by PR and head, with previous heads marked as superseded. A late carry-over verdict for a previously seen head does not designate it as a new head. Deploy is linked to the PR via the saved merge. The index does not determine check completeness and does not change the status. The PR link appears when its URL is already available in the card's PR links; otherwise, only the number is displayed.

### Evidence integrity

Evidence automatically saves the thread that recorded it (null for the UI); the `--thread` flag remains tied to the verifier's thread. The card and `show --json` warn when a PR author performs the verification or when approve/pass checks are missing on the merged head; no warning is issued if the author is unknown. Data is preserved in comment exports, and old archives remain compatible. Warnings do not block recording.

New records append to the history; an existing evidence comment cannot be replaced via import, even with `--overwrite`. Secret scanning also applies to structured fields.

```sh
bb work-board template set --project EXA --name task --body-file templates/task.md
bb work-board template show --project EXA --name task
bb work-board template list --project EXA --json
bb work-board create --project EXA --title 'New task' --template task --description 'Extra criteria'
bb work-board template delete --project EXA --name task
```

Templates are stored by ID within a project, contain Markdown, and can be migrated via archive. The `--description` flag appends text after the template content. The optional `template set --label <name>` binds a template to an existing label in the same project by its ID. If a task is created without `--template`, the bound label's template is applied; ambiguity requires an explicit `--template`. Template validation and automatic status transitions are not implemented.

Links formatted as `::task{key="EXA-8"}` now render as compact badges displaying a short title, with the full title shown on hover. The syntax remains a standalone leaf directive; rendering it inline within a sentence requires BB support. Board columns expand to fit the available width with a 230 px minimum; a narrow panel preserves horizontal scrolling.

## Epics

When creating an issue, select **Type → Epic**. The list provides a **Type → Epic** filter; on the board, epics are marked with a lightning bolt. In the properties of a regular task, the **Epic** field adds it to an epic within the same project. The epic card displays linked tasks and completion progress, and the **Add task** button creates a new child task. Subtasks remain attached to regular tasks and inherit the epic's context through their parent.

Epics share the project's issue numbering, statuses, descriptions, comments, attachments, and thread bindings. The epic moves from Backlog or Todo to In progress automatically when its first task or subtask starts (0.67.0); otherwise its status is manual, and it never moves back or closes automatically. Progress is calculated based on completed child tasks. The agent receives the epic description alongside its own task context.

For permanent areas, use the standard project label `ongoing`: add or remove it via **Labels**, or run `bb work-board update ABC-1 --add-label ongoing` / `--remove-label ongoing` (to create the label: `bb work-board label create --project ABC --name ongoing`). The agent instructions exclude such epics from closure checks: you should only complete the final child tasks, while the epic's status remains as decided by the owner. Fully completing current tasks is not a reason to repeatedly ask about closing the epic. Closing a permanent area requires an explicit decision from the owner. This is an agreement for agents, involving no new status or manual editing restrictions; the label is not inherited by tasks. The `task.labelIds` field is available in JSON, while label names can be viewed with `show --json` and `label list --project ABC --json`.

```sh
bb work-board create --project ABC --title "Big initiative" --type epic
bb work-board create --project ABC --title "First task" --epic ABC-1
bb work-board update ABC-2 --epic ABC-1
bb work-board list --type epic
bb work-board list --epic ABC-1
bb work-board show ABC-1
bb work-board update ABC-2 --no-epic
```

Moving an epic to another project moves its tasks and subtasks along with it, preserving links and original keys. Moving a single task removes its association with the previous epic. Deleting an epic preserves its child tasks. Nested epics are not supported; you can change the type only after removing associations and child tasks. Existing records remain as regular tasks when updated.

The **Timeframe** field in epic properties offers **No deadline**, **Due date…**, and **Ongoing** (∞). Selecting Ongoing adds the `ongoing` label and clears the deadline; choosing a date or No deadline removes only that label. The same options are available in the compact card. Regular tasks retain their Set due date option. In the CLI, use `--add-label ongoing --no-due` for permanent epics, or `--remove-label ongoing --due YYYY-MM-DD` for time-bound epics with a date.

## Resource Locks (dev environment)

A lock is an explicit "resource in use" marker within a tracker project (e.g., the shared dev environment). Name pattern: `^[a-z][a-z0-9_-]{0,63}$`. A lock is either free or owned by exactly one holder: the calling thread (or a person, in which case the thread is empty), with a reason (1–200 characters, passes secret scanning), an optional task key, and an optional `--ttl` (1–1440 minutes). There is no queue or waiting: an occupied lock immediately returns a non-zero exit code along with the holder, reason, acquisition time, and STALE flag. Waiters are not notified, and locks are not automatically released on thread idle.

```sh
bb work-board lock acquire dev --project EXA --reason "dev QA EXA-12" --task EXA-12 --ttl 90
bb work-board lock release dev --project EXA
bb work-board lock release dev --project EXA --force --reason "holder is gone"
bb work-board lock list --project EXA
bb work-board lock show dev --project EXA      # with history
bb work-board lock acquire dev --project EXA --reason "..." --takeover   # STALE only
```

A repeated `acquire` by the same holder updates the reason and TTL. Only the holder can release a lock; `--force` allows anyone, and the reason is logged to the history. A lock is considered STALE if the TTL has expired or the holder's thread has terminated with an error, been archived, or deleted (a thread read error is "unknown", not STALE); STALE locks can be claimed via `--takeover` without `--force`. Acquisition and release are atomic (one SQLite transaction). The current state and the last 50 events per lock are stored (acquired/released/taken_over/expired).

In the project header (main view, side board, and kanban panel), each occupied lock displays a chip "dev · holder · reason · duration" (amber if STALE). Clicking it opens a card with details, a link to the holder's thread, and a Release (force) button with a reason field. No empty chips are shown, and there is no dedicated settings page. RPCs: `listLocks`, `lockHistory`, `acquireLock`, `releaseLock`.

Locks are runtime state: **excluded from export and import** (the export format remains unchanged).

## Storing a Project in Git

```sh
bb work-board export --project EXA --out .bb/tasks/<project-id>
bb work-board import --from .bb/tasks/<project-id>
# Replace conflicting imported records explicitly:
bb work-board import --from .bb/tasks/<project-id> --overwrite
```

`--project` accepts a prefix or ID. `--out` specifies a directory that must not exist, must be empty, or must already contain an export of this project. Paths refer to the initiating thread's machine; outside a thread, they refer to the BB server. Use `--machine <id-or-name>` to target a different machine. Relative paths are resolved from the calling working directory.

```text
.bb/tasks/<project-id>/
  project.json
  tasks/<task-id>.json
  attachments/<attachment-id>
```

`project.json` contains the bb-work-board format marker, version 18, project metadata, folders, labels, task IDs and templates. Task files preserve Markdown, comments/evidence, questions, worker links, aliases, dependencies and attachment hashes. Attachments use immutable IDs. Export contains no storage paths. Imports support v1–v16; see the v17 field changes below.

The export is first assembled in a temporary directory, then replaces the existing copy. On write or replacement failure, the original copy is preserved. Unrelated files are not allowed in the export directory; repository sources must be kept outside it.

Import validates the format, references, ID ownership, and attachment integrity, then applies changes to the database in a single transaction. New records are inserted, duplicates are skipped. Existing records with differing data require `--overwrite`; ID collisions across different projects or owners are rejected even with this flag. Tasks, comments, labels, and attachments absent from the export are left untouched. The `labelIds` field on an imported task defines its label set; updating it also requires `--overwrite`. The task number counter only increments.

The exported directory reflects the current BB state: import any pending Git changes first to avoid overwriting them with BB data. The commands do not commit, push, or trigger agents. Thread links are preserved as references; full chats, external PR content, global presets, and BB settings are excluded from the project snapshot.

## Switching from the built-in plugin

Work Board uses the ID `work-board`: the built-in ID `tasks` is reserved by BB. The `bb work-board` command remains unchanged, so both plugins cannot be enabled simultaneously.

Execute from this directory after the active agents finish logging tasks:

```sh
bb plugin disable tasks
python3 scripts/import_tasks.py
bb plugin install .
```

If you do not need the previous data, skip the import. For a different BB data directory: `python3 scripts/import_tasks.py --data-dir /path/to/bb-data`.

Perform the import **before installing Work Board**: it copies the SQLite database via the backup API and preserves IDs, keys, projects, presets, comments, relationships, and attachment files. It updates attachment URLs in copied descriptions and comments to the new plugin ID. The original data remains in place. The import will fail if either plugin is enabled or if the target directory already exists. Interface view settings and old mentions targeting the built-in plugin ID will not be migrated.

After disabling the built-in plugin, old attachment links in the chat history may stop working; task cards that have been migrated will have updated links. New mentions and cards will use Work Board.

To revert: `bb plugin disable work-board`, then `bb plugin enable tasks`. New changes from Work Board will not be automatically migrated back.

## Verification and Build

```sh
bun install
npm run typecheck
npm test
python3 -m unittest discover -s scripts -p 'test_*.py'
npm run build
```

Source release and license: [UPSTREAM.md](UPSTREAM.md), [LICENSE](LICENSE).

---

## Daily workflow

Work Board is a Linear-style tracker inside bb for planning work, delegating it to
agents, and keeping the task record connected to the threads doing the work.
It provides projects and folders, task keys, statuses and priorities, labels,
subtasks, Markdown comments, attachments, agent presets, and a full CLI.

## Install

Install Work Board from this collection after completing any required migration:

```sh
bb plugin install git:https://github.com/ShaatLa/bb-plugins.git@0.x --plugin work-board --tag-prefix work-board/
```

The plugin adds the Work Board sidebar panel, the `bb work-board` command, and an agent
skill that teaches workers how to report progress back to tasks.

## Quick start

Install the plugin with `bb plugin install git:https://github.com/ShaatLa/bb-plugins.git@0.x --plugin work-board --tag-prefix work-board/`. Then use the `bb work-board` CLI
to create a tracker project. Link it to the bb project where delegated agents
will run:

```sh
bb work-board project create \
  --name "Product" \
  --prefix PROD \
  --link-bb-project proj_your_bb_project

bb work-board create \
  --project PROD \
  --title "Ship task delegation" \
  --description "Implement the flow and run focused validation." \
  --priority high

bb work-board list --project PROD
bb work-board show PROD-1
bb work-board preset list
bb work-board dispatch PROD-1 --preset "GPT-5.6 · high"
```

When the CLI runs inside a linked bb project, `create` and `list` infer the
tracker project, so `--project` can be omitted. Task keys are case-insensitive
at the CLI boundary. You can also delegate from a task's **Delegate** menu,
choose or create presets under **Manage → Presets**, and type `@` in the bb
composer to send a task mention to an agent.

The comment composer shows a **Notify last responding agent** switch. When the
task has an agent reply, leave it on to send the new comment to the thread that
authored the latest reply, resuming that thread when it is idle. Turn it off to
keep the comment in Work Board only. If no agent has replied, the disabled control
says so explicitly. Agents and scripts can use the same behavior with
`bb work-board comment PROD-1 --body "New context" --notify`.
The app and Work Board RPC return the saved comment before notification delivery,
with `notifiedCount` initially 0. Comment change events publish immediately and
again when delivery finishes. The CLI waits for delivery, so `--notify --json`
includes the final `notifiedCount`. Failed delivery leaves that count at 0.
When run from a thread, the CLI preserves that agent thread and any explicit
`--author`; notification still targets the prior latest responder rather than
the newly recorded agent comment itself.

## CLI reference

Run `bb work-board --help` or `bb work-board <command> --help` for exact options; help
works at every level, lists each option's accepted values and limits, and exits 0. Unknown commands and options are rejected with the nearest real name, every
missing required value is reported in one error, and a failing invocation that
carries `--json` prints `{ "ok": false, "error": { "code", "message", "hint"? } }`
on stdout while stderr keeps the readable text. Add `--json` to commands when
another command or agent will consume the output.

`--project` takes a tracker project prefix or id such as `PROD`, never a bb
project id (`proj_...`); `bb work-board project list` shows both columns. Repeatable
options (`--label`, `--status`, `--exclude-status`, `--priority`, `--add-label`, `--remove-label`)
also accept one comma-separated list. File paths (`--file`, `--attach`,
`--out`, `--description-file`, `--body-file`) resolve on the invoking machine:
inside an agent thread that is the thread's machine, otherwise the server's
machine; pass `--machine <id-or-name>` to target another enrolled machine.

| Command                                        | Purpose                                                                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `bb work-board status`                              | Show the installed Work Board plugin name and version. Task workflow status lives on `bb work-board list --status` and `bb work-board update --status`.   |
| `bb work-board project create\|list\|show\|update`  | Manage tracker projects, folders, colors, prefixes, and bb-project links.                                                                  |
| `bb work-board folder create\|list\|update\|delete` | Organize tracker projects into nested folders. Deleting a folder moves its projects and subfolders to the top level; no tasks are deleted. |
| `bb work-board create`                              | Create a task with description, priority, labels, due date, optional parent, and file attachments (repeatable `--attach <path>`).          |
| `bb work-board list`                                | Page/filter tasks by project, status, priority, label, active agents, or search text; supports `--sort`, `--limit`, and `--cursor`.        |
| `bb work-board show <key-or-id>`                    | Show the complete task record, including comments, attachments, subtasks, and attached threads.                                            |
| `bb work-board update <key-or-id>`                  | Update status, priority, title, description, due date, or labels.                                                                          |
| `bb work-board move <key-or-id>`                    | Move a task and its sub-tasks to `--project`. Moved tasks get new keys; old keys keep resolving, and labels are matched by name.           |
| `bb work-board comment <key-or-id>`                 | Add a Markdown comment from inline text or a file; optionally notify the latest responding task agent.                                     |
| `bb work-board attachment add\|get\|list\|remove`   | Add, fetch, list, or remove attachments. Referenced attachments require `remove --remove-references`.                                      |
| `bb work-board preset list\|create\|update\|delete` | Manage reusable agent execution presets.                                                                                                   |
| `bb work-board dispatch <key>`                      | Start and attach a new agent thread with `--preset`, or send the task to an existing thread with `--thread`.                              |
| `bb work-board report <key>`                        | From a child thread: wake the parent with `--kind ready\|question\|blocker`; the report becomes Current state.                           |
| `bb work-board children <key>`                      | From a parent thread: list its child threads with their tasks.                                                                             |
| `bb work-board question add\|list\|answer\|update\|delete` | Ask the owner one decision or check on the task; `--step` lists how to check.                                                    |
| `bb work-board config get\|set`                     | Read or change one project setting (`--project`).                                                                                           |
| `bb work-board attach <key-or-id>`                  | Attach the current bb thread to a task when it was not delegated from Work Board.                                                               |
| `bb work-board detach <key-or-id>`                  | Detach the current bb thread (or `--thread <id>`) from a task, for example a dead predecessor after a respawn.                             |
| `bb work-board threads <key>`                       | List the bb threads attached to a task: live threads first, newest first.                                                                  |
| `bb work-board label create\|list\|delete`          | Manage project-scoped labels.                                                                                                              |
| `bb work-board seed-demo --yes`                     | Create sample folders, projects, labels, tasks, and comments for evaluation.                                                               |

Status ids are per project (`project show --json`); the system ids `backlog`,
`todo`, `in_progress`, `in_review`, `done` and `canceled` always exist. Priorities are `urgent`, `high`, `medium`, `low`, and `none`.

Task lists default to 100 rows and accept `--limit 1-500`. JSON output is
`{ tasks, nextCursor, limit }`; human output prints the continuation option
when another page exists. The cursor is opaque and tied to the filters, sort,
and current task-list revision. If tasks are added, removed, reordered, or
updated between requests—or label links/names, active task threads, or project
prefixes change—the old cursor is rejected. Restart from the first page rather
than traversing an inconsistent snapshot.

## Agents, delegation, and presets

Linking a Work Board project to a bb project enables delegation. Open a task, choose
**Delegate**, select a preset, and optionally add instructions. A preset
defines the provider, model, reasoning level, optional service tier, permission
mode, and reusable instructions. Presets are user-defined, so create the worker profiles your team
uses repeatedly before dispatching work.

Delegation creates a worker thread in the linked bb project, attaches that
thread to the task, and advances a `backlog` or `todo` task to the project's
in-progress status (default `in_progress`).
The worker receives the task description, subtasks, attachments, recent
comments, preset instructions, and a report-back contract. Its installed Work Board
skill tells it to keep Current state up to date, post results and evidence as
comments, ask the owner with task questions, and move finished work to the
project's review status. A child thread also reports to its parent with
`bb work-board report`.

If work begins outside the Delegate action, the agent can associate its current
thread with `bb work-board attach KEY`. The inverse is `bb work-board detach KEY
[--thread <id>]`, and each thread card on the task page has a detach control;
use either to drop a thread that died or moved on to other work. A done or
canceled card releases a thread by itself once that thread finishes its current
turn or starts a new one ("Thread detached (automatic)"), so a session reused for
other work neither warns on the closed card nor adds to its cost. The task
page and `bb work-board threads` list live threads before completed or failed ones,
newest first.

### Threads of closed cards (0.60.0)

When a card moves to Done or Canceled (or the project's done status), the sessions
Work Board itself created for it are archived: a thread spawned by Delegate with a
preset, or by a scheduled run that started a fresh thread. Everything else is only
kept: sessions linked by title, "Existing thread", a manual `attach`, a parent
fallback, a scheduled run in an existing thread, and links from before 0.60.0 or
from an import. An idle session is archived at once; one that is still working
(including the session that closed the card) is archived on the first idle of the
turn that was running, and a new turn cancels that. Before every archive Work
Board re-checks the card, the link, other open cards, an open plan review, an enabled schedule's target, pinned
state, queued input and live children, and any doubt or SDK error keeps the thread.
A restart cancels pending archives. The result is listed in the card's activity log
and in the output of `bb work-board update KEY --status …` (and the board drag
RPC) as `closedThreads`; `--json` carries the same list.

Since 0.75.0, a kept or still-working session whose turn after the close changed files in its
environment hears about it once, at the end of that turn, and so does its parent
(an archived parent is replaced by its own parent); a turn that only answered a
message adds no notice of its own. Work Board compares the environment's Git state
(HEAD and each uncommitted file's revision, read through the built-in Git plugin)
at the turn start and end. Any doubt sends nothing and logs one info line: no
environment, the Git plugin missing or disabled, a failed, truncated or slow (5 s)
read, a missing HEAD SHA, an environment switched during the turn, or another thread
on the same environment that was running or active between the two reads. A
restart, or the thread failing, being deleted or archived during the turn, discards
the comparison without a log line. A failed notice is retried once, at the end of
a later turn, so an answer-only turn can deliver a notice owed from earlier. Project settings, one key at a time with
`bb work-board config get|set KEY VALUE --project PREFIX` or in Settings:
`archiveThreadsOnClose` (on by default, Archiving) and
`archiveReviewerOnApproval` (on by default, Planning). A plan reviewer is archived
after it approves only when it was submitted with `plan submit KEY --reviewer thr_x
--dedicated-reviewer` (a reviewer spawned for that review; a reused thread never
is) and has no other open work. Export format **v21** carries both settings; an
import never changes an existing project's own and never archives anything.

## Task mentions

Type `@` in the bb composer and select **Work Board** to search by task key or title.
Sending the mention gives the agent the task's description, status, priority,
labels, subtasks, attachments, recent comments, attached threads, and CLI
action contract as context. Work Board linked to the current bb project rank first.

Inside a task description or comment, `@` also inserts a task pill. These
references are stored in Markdown as `[PROD-1](bbtask://PROD-1)`, so they remain
portable in task content.

Mentioning a task key such as `PROD-1` in an agent request also activates the
Work Board skill, which directs the worker to read and update the tracked task.

## Known limitations

- The **Auto** delegation preset is deferred; choose an explicit preset.
- List filters are local UI state and are not persisted in the URL.

## Fast follow

- Batch task-list enrichment for comments and attached-thread state.
- Add notifications and an inbox for task activity.
- Add a command palette entry for Work Board to cmd-K.


## Ask the owner on the task

Keep the task attached to your agent thread. Set Current state to explain what you need and why, and keep the workflow status accurate.
Use a decision when you cannot proceed without a choice, or a check when you know the next step and need validation.

```sh
bb work-board question add ABC-12 --kind decision --prompt 'Which approach?' --option 'Use the existing service'
bb work-board question add ABC-12 --kind check --prompt 'Does the form save?' --step 'Open the form' --step 'Press Save'
```

Repeat `--step` to give a check its "How to check" steps: the card lists them, numbered, between the question and the answers, so the owner does not look for them in comments. `question update --step …` replaces the steps; without `--step` it keeps them.

Both types use options and always-available free text. Decisions require at least one option. Checks default to Confirmed and Problem found when no options are supplied; explicit options replace those defaults. Multiple choice permits several options. Type is a label, not a different answer workflow. The answer is delivered to the asking agent thread (queue-if-active), falling back to an attached thread or the latest agent commenter for older questions.

Waiting on me means a live unfinished task with at least one unanswered question of either type. Cards use an orange border and question type badges. Open questions appear in the order they were asked, oldest first; answered questions are under Earlier in timeline order.

Archive v17 removes the task execution and requester fields. Question records add kind (decision/check) and askedByThread (thread ID or null), including history snapshots. Imports v1–v16 discard the old task fields and default questions to decision with no asking thread. No questions are created by the database migration.

Project status pushes apply to agent and plugin automation changes. Owner changes in the UI or CLI outside an agent thread never send a status push, including Done.


### Excluding statuses in the CLI

```sh
bb work-board list --project EXA --exclude-status done --json
bb work-board list --project EXA --exclude-status done,canceled --json
bb work-board list --project EXA --status todo,done --exclude-status done --json
```

The flag can be repeated. Exclusions are subtracted from `--status`, or from all statuses if the flag is omitted. If no statuses remain, the output is empty. The filter is applied before pagination and combines with the other filters. The archive format remains v5.


The copy button next to the card key copies both the key and the current title as `ABC-12 · Task Title`. It works on the main screen and the side panel; a checkmark indicates a successful copy, while an error shows a message.


Sub-task questions are visible on both boards and in the Kanban tab via the parent card. The top counter sums questions from the parent and its sub-tasks; the tooltip shows the breakdown. Click the counter to expand sub-tasks, or use **Sub-tasks · completed/total**. The expanded list shows the key, title, status, and question count; tasks with questions appear first. Clicking an item opens the sub-task in the current panel. The **Waiting on me** filter keeps the parent visible when questions exist within sub-tasks, and automatically expands only sub-tasks waiting for a response, excluding completed and canceled ones. The counter and filter update after a response is submitted. Sub-tasks do not become independent cards/columns and are not involved in board drag-and-drop. In the list, **Waiting on me** shows a waiting sub-task as its own row, since the list has no parent cards to expand (0.55.1).


### Archived worker threads (0.7.2)

Work Board keep multiple worker links. Opening a task's thread list, notifying a worker, and BB's archive event check actual thread state. Archived, deleted and missing workers are detached; an available replacement stays attached. If none remains, follow the latest worker's `parentThreadId` chain to the nearest available ancestor, up to the root. If that ancestor is later archived, continue up its parent chain. The task becomes unassigned only when the chain has no available ancestor. Cycles, missing threads and private side-chat boundaries stop traversal. Transient lookup failures preserve the links for a later check.

New and replacement workers should run `bb work-board attach KEY`; this preserves other current workers. `bb work-board detach KEY --thread thr_old` detaches explicitly, without automatic parent fallback. Attachments and detachments are recorded as system events in Activity with thread links; these comments also survive export/import in the unchanged archive v6. Unarchiving a detached worker does not reattach it automatically. Notifications never retry a failed send to another worker, avoiding duplicate deliveries.


### Task archive (0.8.0)

The **Archive** section keeps completed cards off working lists and both boards. Archiving is manual: open a Done/Canceled card and click **Archive task**, or select a project in **Archive** and click **Archive completed**. A family with unfinished children stays on the board. Archiving a task or epic archives its completed children too; restoring it restores the family. Individually archived sub-tasks whose parent is archived require restoring that parent first. Status, IDs, descriptions, questions, evidence, comments, attachments and worker history are preserved. Completing a card does not immediately archive it. In plugin settings, **Automatically archive completed tasks** offers Off (default), 3, 7, 14 or 30 days. The hourly check requires the whole active family to be Done/Canceled and inactive for that period. Task edits, comments, attachments and question changes restart the inactivity period. Unanswered questions and working agents prevent automatic archival. A restored card gets a fresh inactivity period.

The archive has project filtering, search, card links and **Restore**. Archived cards remain directly accessible by key. Agents use `bb work-board archive KEY`, `bb work-board restore KEY`, `bb work-board archive-completed --project PREFIX`, and `bb work-board list --project PREFIX --archived [--search TEXT] --json`. `--include-archived` lists both scopes; the two flags are mutually exclusive. `bb work-board show KEY` also works for archived cards. Dispatch requires restoring the card first.

Export v7 always includes both archived and live cards, with required `task.archivedAt` (`null` or a UTC ISO timestamp with milliseconds). Import v1–v6 defaults an absent timestamp to null. No task is deleted by archiving or restoration.

### Archive queries and automatic retention (0.8.1)

The Archive view supports project and text search (key, title or description), inclusive UTC date bounds, a date field (archived, created or updated), and pages of the latest 25/50/100/500 matching cards. Use equal start/end dates for one day. Previous/Next browse further results; restart results if a concurrent write makes a pagination cursor stale.

Agents can combine these with the existing status, type, priority and label filters:

```sh
bb work-board show EXA-8 --json
bb work-board list --project EXA --archived --latest 20 --json
bb work-board list --project EXA --archived --search "registry access" --json
bb work-board list --project EXA --archived --on 2026-10-24 --json
bb work-board list --project EXA --archived --from 2026-10-01 --to 2026-10-24 --latest 50 --json
bb work-board list --project EXA --archived --date-field created --on 2026-10-01 --json
```

`--latest N` selects newest order and the page size (1–500); a `nextCursor` permits continuing with the same filters. `--sort newest` also works with `--limit`. Dates are `YYYY-MM-DD`, inclusive in UTC. With `--archived`, the default date field is archived; otherwise it is created. `--date-field updated` selects last task-record modification (including archival/restoration), not the last comment. `--on` cannot be combined with `--from`/`--to`. Exact key/ID lookup is `show`, which reads either archive scope. The RPC uses `dateField`, `dateFrom`, `dateTo`, `sort: "newest"` and the existing `limit`/`cursor`.

Automatic retention is a per-project setting (`project update --auto-archive` or `config set autoArchiveAfterDays`) and is off until enabled. It runs while BB has the plugin loaded; missed checks are caught by the next hourly sweep. It preserves the existing manual and bulk actions. Export stays v7, includes all records, and carries no device settings.


### Waiting for PR CI (0.30.0)

`bb work-board pr wait --url <PR URL> [--head <SHA>] [--timeout 45m] [--ignore-context NAME]... [--json]` blocks on the bb server until every required check of the PR head settles: exit 0 green, 1 red (failed names printed), 2 cancelled or superseded, 3 no verdict (DIRTY, draft, no run, unknown required set, timeout). The required set comes from branch protection and rulesets; Actions checks older than the PR's latest `ready_for_review` are ignored, so a finished draft run is never judged, and of several runs of one workflow on the head only the newest counts. Required checks that a project gate posts only after CI (for example a ready-check status) go into the project Git setting "Checks outside CI" (`prWaitIgnoredChecks`) or `--ignore-context`; the wait does not judge them and names their state in the green message. See the work-board skill, section "Waiting for PR CI".

### PR file overlaps

Open linked PRs in the same repository show shared files across different tasks. Configure up to 50 `overlapRules` in Git/PR Advanced settings (the **Highlight shared files** switch, then one row per rule with a pattern and Changed or Added; turning the switch off keeps the rules and disables only rule matches; ordinary shared files are still listed. The switch is the per-project key `git.overlapEnabled`; while it is absent it follows the rules, and `config get` returns the effective value) or `git-config --file`, for example `[{"pattern":"migrations/**","match":"added"},{"pattern":"docs/traceability/*.json","match":"changed"}]`. `changed` highlights shared matching paths; `added` highlights matching additions or rename targets even when their names differ. Patterns support `*`, `**` and `?`. Cards show a marker and PR details list matched files; `show --json` and `pr list --json` include `overlaps`. File lists are fetched during sync only when the PR head changes, capped at 3,000 files with `truncated` recorded. Cached files and overlap results are local and not exported; rules round-trip in export v8.

### GitHub PR/CI synchronization (0.9.0, export v8)

Open **Work Board settings** with the gear icon next to Refresh on the Work Board page, or use **Settings → Plugins → Work Board**. Choose a tracker project, then **Git and pull requests**. Each tracker project has its own repository list (`owner/repo`), optional periodic synchronization (off initially, five minutes when enabled), title discovery, lookback and check/workflow settings. Each GitHub repository discovered in BB projects is a switch that saves at once. **Other repositories** expands a manual `owner/repo` field, an **Add** button and a removable repository list. Every control of the card edits one draft, the whole intended configuration. Switches, rule matches and added or removed entries save at once; typed text (numbers, rule patterns, check names) on Enter or when focus leaves the card, never while typing. Moving to another control of the card commits nothing by itself: a switch or rule match then saves the whole draft with the edited text, **Discard** reverts it, and **Add rule** only adds its row. The values are checked with the server's schema first, and an invalid one is shown and not sent; nothing saves while a new rule has no pattern. A write sends the whole draft with `setGitSyncConfig` `baseConfig` = the stored configuration this page last knew; while it, a **Reload** or a sync is in flight the card is disabled, and on success the base and the draft are exactly what was sent. A clean card follows later reads. A change made elsewhere is caught by the server's `baseConfig` refusal: the edits stay, and **Reload** discards them and shows the stored settings; **Advanced settings** contains lookback, post-merge observation, required checks and workflow names. Check and workflow names are entered as separate removable entries: type a name and press Enter or a comma; a pasted list is split into names. Multiple projects can watch the same repository; multiple repositories and PRs per task are supported. The first connector supports public and private repositories on github.com. Other hosting providers and GitHub Enterprise hosts are not implemented.

The connector reads GitHub using `GH_TOKEN`, `GITHUB_TOKEN`, then the server's existing `gh auth token --hostname github.com`; public repositories can use anonymous access. It never switches accounts, writes PR comments/labels, merges PRs or changes a local checkout. Private repositories need read access to PRs, contents/commit statuses, checks and (for post-merge observation) Actions. Optional protection/review metadata can remain unknown if unavailable; a required-check override avoids requiring additional administration access. Tokens and account data never enter exports.

The compact **Pull requests** list appears below the task properties in the right column (below the content in narrow panels). PR, check, workflow and evidence links use BB’s native URL navigation. Expand a PR row for checks, merge/review details and link actions; the header icons refresh or add a link. **Link PR** in a task card accepts a full canonical GitHub PR URL, a role (**delivers**, **design**, **related**) and optional delivery part `k/m`. Explicit links are confirmed. Whole keys in PR titles and worker-environment metadata produce suggested related links. Environment PRs are suggested only for attached tasks whose whole key (including historical aliases) appears in the PR title, head branch or body. PRs naming only other tasks, or no task key, are skipped; link these explicitly when needed. This does not alter manual links or persistent exclusions. A single-repository project's structured evidence `--pr` can also suggest a reference; bare numbers are ambiguous across multiple repositories. Ordinary PR-body/comment mentions and branch names do not create delivery links. Task key aliases work after prefix changes. Confirm/edit a suggested link to choose its role. **Exclude** persists across polling; **Relink** explicitly restores it. Links survive thread archival and task title changes, and include immutable task/remote PR IDs. Renamed GitHub repositories update their configured path after a successful direct lookup.

Cards in the list, central board and side board show a compact PR/CI summary. Task details on both surfaces show every linked PR, current head SHA, check states, required/optional/unknown requirements, review decision, merge state/queue, unresolved-thread count when available, freshness and errors. CI uses the current PR head, latest check IDs and latest commit statuses; failed, pending, skipped, neutral and cancelled checks stay distinct. Green CI is not a merge approval. These checks describe the PR head; test-merge/merge-group check evaluation and complete signing/ruleset diagnostics are not claimed. GitHub's reported merge blockers are displayed separately.

Task statuses stay owner/agent controlled with one exception: when a confirmed `delivers` PR is open or draft, a linked task in one of the project's `earlyStatuses` (default `todo`, `in_progress`) moves to the project's `reviewStatus` (default `in_review`). Set `earlyStatuses` to `[]` or `reviewStatus` to `null` to turn this off. Automatic merge evidence and other workflow transitions are not implemented. No generic definition of “task complete” is inferred from discovered PRs or their roles.

#### PR lifecycle messages (0.77.0)

Git sync sends the card's working session a short message when a linked PR changes; nobody subscribes. Each message starts with Work Board's origin line and the card key, and is sent once:

- **CI verdict** — every required check of the current head has finished: `EXA-1 · PR #42 CI green on abc1234 (required checks passed).` or `… CI red on abc1234: failed lint, unit-tests.` Required means the `requiredChecks` setting, or GitHub's own requirements when it is empty, minus `prWaitIgnoredChecks`. There is no verdict while any required check is pending, while the requirements are unknown, or when none are required. Success, neutral and skipped count as passed; failure, cancelled, timed out and action required as failed. Each new head gets its own verdict; a head that goes red, then green, then red again on a rerun is reported red and green once each.
- **Merge queue removal** — a queue entry Work Board saw is gone while the PR is still open. The entry's own removal is found on the timeline by pairing it with the one add within ±2 s of the entry's stored enqueue time; the message then gives the removal time (UTC) and GitHub's reason, and for a failed-checks removal up to 5 failed checks of the commit the queue tested (`+N more` beyond that, `and more` or `(first 100 checks inspected)` when only the first 100 checks were read, `none found (first 100 checks inspected)` when none of them failed). When the pairing is not certain or the timeline is unreadable it says `reason unavailable`. It ends with whether the PR was back in the merge queue at that poll. A merge-generated removal sends nothing. A whole queue visit between two polls is not detected.
- **Merged** — `EXA-1 · PR #42 merged as def5678 at 2026-01-01 12:00 UTC.`
- **Deployed** — the first successful push run of a `postMergeWorkflows` workflow on the base branch whose commit contains the merge, and whose successful attempt completed within `postMergeDays` of the merge. The message asks the session to collect the deployment evidence, run the final check and close the card.
- **Stopped waiting** — no such run within `postMergeDays`: `… Work Board saw no successful deploy run with merge def5678 within 7 days; it stopped waiting.` When the runs could not be read to the end it says it could not verify one instead. No wait starts when `postMergeWorkflows` is empty.

A PR seen for the first time (also right after the upgrade) is only recorded: states it is already in send nothing, and a merge older than `postMergeDays` gets no messages. A failed refresh sends nothing.

A message goes out as soon as the refresh that produced it is saved, while the pass reads the next PRs. Each scheduled pass reads open and draft PRs before merged and closed ones; a PR due for 15 minutes goes first within its group. The deployment search runs after the PR refresh, with one 45-second budget per pass shared by every project: waits go least recently searched first, a wait cut by the budget keeps its progress and resumes on the next pass, and a cut pass never counts toward the three final passes. The log notes how many waits the search advanced and how many it left for the next pass.

The recipient is the session that opened the PR, chosen by one rule: the PR link's owner, named with `pr link KEY --url URL --owner self` (or `--owner thr_x`; RPC `linkPr` field `ownerThreadId`), and the parent of an archived owner; otherwise the card's only linked session; otherwise the root of the card's session tree, the one linked session with no other linked session among its ancestors (a lead whose readers, critics or executors are linked too; unlinked sessions in between do not count); otherwise the one linked session whose environment is on the PR, when GitHub PR Status could read every linked session's environment. Only `--owner` sets the owner: a plain relink, title or environment discovery and a refresh keep it. When none of these picks one session (several roots, such as two unrelated sessions, with two on the PR branch or none on it, or an environment read that failed or took over 5 s), the message waits as `awaiting_owner`, is checked again every 30 minutes (a recheck that finds a single match sends it) and goes out as soon as `--owner` names the owner; after 24 hours it ends as `no_recipient:ambiguous` and is no longer sent. The session that opens a PR should therefore link it with `--owner self`. A card with no linked session drops the message (`no_recipient`); a thread read that fails, or a chosen session that is stopping, is retried later with a growing delay. Done and canceled cards still get merge and post-merge messages but no CI or queue messages. Two per-project keys control the messages: `prEvents` (`on` by default; `off` stops them) and `prEventsManager` (`off` by default; `on` also sends a copy to the project's attention manager, `config get manager`, unless it is archived, deleted, a side chat or stopping). Read and change them one at a time with `bb work-board config get prEvents --project ABC` and `config set prEventsManager on --project ABC`, or with the **PR lifecycle messages** and **Copy PR messages to the manager** switches in the project's **Manager** card. `bb work-board pr events EXA-1 [--json]` lists a card's messages and their delivery state (`sent`, `unknown`, `failed`, `awaiting_owner`, `no_recipient`, `no_recipient:ambiguous`, `skipped:<reason>`). A delivery whose outcome is unknown is never sent again; a refused one gets three transport attempts in total (at most two retries). Delivery history is kept for 30 days.

Work Board never closes or moves a card because of these messages: the session collects the evidence and closes the card itself.

```sh
bb work-board git-config --project ABC --json
bb work-board git-config --project ABC --file ./git-sync.json
bb work-board pr link ABC-12 --url https://github.com/example/service/pull/42 --role delivers --part 1/2
bb work-board pr link ABC-12 --url https://github.com/example/service/pull/42 --owner self
bb work-board pr list ABC-12 --json
bb work-board pr unlink ABC-12 --url https://github.com/example/service/pull/42
bb work-board sync --project ABC --json
bb work-board show ABC-12 --json
```

A configuration file accepts `enabled`, `repositories`, `pollMinutes` (1–60, default 5), `lookbackDays` (1–365, default 30), `titleDiscovery` (default true), `requiredChecks` (up to 50 unique names, empty reads available GitHub requirements), `prWaitIgnoredChecks` (up to 50 required check names that `pr wait` does not judge), `postMergeWorkflows` (up to 10 unique names or workflow ID strings) and `postMergeDays` (1–90, default 7). Omitted settings use their defaults. `git-config --file` replaces the whole configuration, not a partial patch. CLI file paths use the invoking machine or `--machine`; credentials belong on the BB server. `pr list --json` includes snapshots and errors; `show --json` exposes the same data as `prLinks` in addition to legacy environment PR checks. The public RPC contract exposes get/setGitSyncConfig, linkPr, unlinkPr, listPrLinks, prSummaries and syncGit.

### Settings one key at a time

Every per-project setting can be read and changed on its own: `bb work-board config get [KEY] --project PREFIX [--json]` lists all keys or shows one, and `bb work-board config set KEY VALUE --project PREFIX` validates and saves only that key, printing `KEY=value`. Keys: `autoArchiveAfterDays`, `staleIdleMinutes`, `statusNotifications`, the read-only `attentionMode` and `manager` (changed by the owner in the project settings, 0.61.0), every repository-check field with a `checks.` prefix (`checks.branch`, `checks.script`, `checks.args`, `checks.intervalMinutes`, `checks.timeoutSeconds`, `checks.snapshots`; the read-only `checks.enabled` is the owner's, 0.64.0) and every Git/PR field with a `git.` prefix (`git.enabled`, `git.repositories`, `git.requiredChecks`, `git.prWaitIgnoredChecks`, `git.pollMinutes` and so on; `git.overlapEnabled` returns the effective boolean, derived from `git.overlapRules` while the key is absent). VALUE is JSON or plain text; list keys also take a comma-separated value (`config set git.requiredChecks "CI, Lint" --project EXA`). The same calls are RPC `config.get {projectId, key?}` and `config.set {projectId, key, value}`; for `git.*` keys `config.set` also takes `expected`, the stored value the change was built on, and refuses the write when it differs (the settings page sends it for repository membership and rule matches). `git-config --file` and `project update` keep working.

Global preferences are native plugin settings: `bb plugin config work-board` lists them, and `bb plugin config work-board set startScreen active` or `set badgeInReview true` changes one. Fields (ten): `startScreen`, `openThreadsIn` (`bb` or `agent-hub`), `checksBbCli` and `checksRuntimePath` (the repository-check runner's `bb` path and script PATH; empty inherits the server environment), and one boolean per navigation badge criterion (`badgeOpen` and `badgeWaitingOnOwner` on by default; `badgeInReview`, `badgeNeedsAnswer`, `badgeFailedThread`, `badgeStaleIdle` off). Values saved before 0.44.0 move there once on upgrade. The settings page's General group edits the same fields through RPC `globalSettings.set {values, expected?}`, which writes only the given keys after checking each against its field, so one invalid value rejects the whole patch; with `expected`, a stored value that differs from it rejects the patch too. `globalSettings.get {}` returns every field with its default.

`openThreadsIn` (`bb` by default) chooses where Work Board's own thread links open: session rows, comment authors, thread mentions in descriptions and the open-session buttons. The choices are **bb chat** (`bb`) and **Agent Hub** (`agent-hub`). With `agent-hub` they open the conversation in the Agent Hub plugin; when it is not installed and enabled they keep opening bb chat. `answers`, Agent Hub's former id, is no longer offered; a stored `answers` opens bb chat until Agent Hub is chosen again. Thread mentions inside rendered comment Markdown are routed by bb and always open bb chat.

Periodic scans share repository discovery, revalidate current checks independently of PR updatedAt, retain last good snapshots on errors, use conditional authenticated REST requests and rate-limit backoff, and stop writes after disposal/configuration changes. All open PRs and recent closed/merged PRs are discoverable, within bounded pages (100/page, up to 20). Linked PRs are fetched directly. Old merged PRs stop background fetching after the post-merge window; old unmerged closed links are rechecked hourly to catch reopening. Manual Sync bypasses these observation intervals. A large repository/window can exceed the bounded discovery limit; narrow the lookback or explicitly link a PR. Failed discovery never removes an established link. Snapshots indicate stale state rather than treating an unavailable API as success/closure.

**Post-merge workflows** are optional, read-only push-run observation on the PR base branch. Configure exact workflow names or stable workflow ID strings. A cancelled run remains pending; a later run covers it only if it is the same workflow/base branch/repository and the compare API confirms its commit contains the merge commit. The card then shows **Superseded … covered by run X on commit C**, with the covering run's pending/passed/failed/skipped result. Diverged/behind commits do not cover it. Ambiguous names across workflow IDs yield unknown. This records workflow coverage, not a task-completion or deployment guarantee.

Export v8 adds required top-level `project.json.gitSync` and `tasks/<id>.json.pullRequests` arrays (including exclusions), preserves v7 archival fields, and contains no CI snapshots, credentials, HTTP caches, cursors or last-poll timestamps. Files/directories are unchanged. Imports accept v1–v14; legacy imports without these fields preserve existing local sync settings/links. Conflicting imported links/config require `--overwrite`; missing links are not deletions. Imported snapshots are never trusted—remote state is fetched again. Coordinate downstream strict export checkers before upgrading to the v13 exporter.

## Dispatch and Thread Hierarchy

`bb work-board dispatch KEY --preset NAME`, when called from a thread, makes the new thread a child of the caller (`BB_THREAD_ID`), so lifecycle notifications and archiving follow the hierarchy. `--parent-notifications auto|stuck|off` specifies which child turns wake the parent (without the flag, bb's default value applies); `--no-parent` runs the thread outside the hierarchy (the flags are mutually exclusive). Launching from the UI by a user and `--thread` do not change the parent. Agent recommendations are in the "Building a hierarchy without burning provider limits" section of `skills/work-board/SKILL.md`.

## Sequence claims

Create a project sequence with `bb work-board seq create registry_version --project EXA --next 234 --format '1.{n}'`. Use `seq list`, `seq show`, `seq set-next` and `seq delete` with `--project`. Claim with `bb work-board claim registry_version --project EXA --task EXA-12 [--pr URL] [--another]`; plain output is the rendered value. Release with `claim release registry_version 234 --project EXA --reason 'reason'`. Active claims appear on the task. Claims are idempotent per task unless `--another` is supplied; released values are never reused. `set-next --force` permits a lower counter, but allocation remains blocked until it exceeds all prior claims. Sequence state is not exported or imported, and PR close or merge does not release claims automatically.

## Right Panel Tab and Task Links (0.14.0)

**Work Board** is a permanent right panel tab for the thread, located next to Info and Diff, rather than a closable tab from the “+” menu. A `::task` card opens a task in this tab. The tab remembers what was open in the thread (a task or board) until the app is restarted; a “open task” request from chat executes only once and is not repeated when returning to the thread. The Navigation and Kanban tabs on the Work Board page are registered in the same way (`experimental_tab`), and their IDs remain unchanged. The open task counter is visible on the navigation item again (`experimental_useBadge`).

In bb chat responses, task links use standard Markdown syntax `[EXA-12](/plugins/work-board/work-board/task/EXA-12)`. Clicking the link on a thread page opens the task in the right panel Work Board tab without leaving the chat; clicking with ⌘/Ctrl/Shift/Alt or clicking outside the thread opens the Work Board page in the main area. The `bb work-board show` and `create` commands output it in ready format (the `link` field when using `--json`), and mentioning a task via `@` passes it to the agent. The plugin adds a brief rule about these links to the system instructions for threads in bb-projects connected to Work Board. It appears for threads started or resumed after installation.

PRs from worker environments are read via the built-in GitHub PR Status plugin (`bb--github-pr-status`) in a single batch request: in bb 0.48, `bb.sdk.environments.pullRequest` no longer exists. If the GitHub PR Status plugin is disabled, such PRs are marked as unavailable; explicit PR links and Git synchronization continue to work as before.

## Work Board Badge Counter (0.15.1)

In Work Board settings (Settings → Plugins → Work Board or the gear icon on the Work Board page), the **Navigation badges** switches under General choose what the Work Board navigation badge counts: open tasks and tasks waiting on you (both on by default), tasks in review, tasks with unanswered questions, tasks with failed threads, and tasks with idle threads that lack updates (threshold controlled by the Flag idle threads after setting). You can select multiple criteria: the badge shows the number of unique tasks matching at least one criterion, counting each task only once. The tooltip provides a breakdown, for example, "3 tasks: 2 with unanswered questions, 1 in review". If no criteria are selected, the badge is hidden. Only non-archived tasks are counted; `done` and `canceled` statuses are excluded everywhere. Settings are native plugin fields (`bb plugin config work-board`) shared across all devices; RPC: `getNavigationBadgeCriteria`, `setNavigationBadgeCriteria`, `navigationBadge`. The badge updates on task and thread events, when criteria change, and additionally once per minute when thread idle monitoring is enabled.

### Upgrade and rollback (0.16.0)

Export v9 preserves optional workflow status icons and colors. Imports accept v1–v9, including v8 archives that already contain this metadata. Update strict archive consumers before upgrading. Before rolling back, keep a v9 backup: older releases may reject v9 archives or status metadata; do not remove icons or colors from live data to make a rollback work.

Each project can configure workflow rules with `bb work-board project update PREFIX --workflow-policy-file policy.json` (also accepts `--machine`). RPC clients can set `updateProject({projectId, workflowPolicy})`. The JSON object accepts `bugfixStatus`, `doneStatus`, `inProgressStatus`, `reviewStatus`, `testingStatus`, `planningStatus`, `earlyStatuses`, and `ownerDecisionLabel`; omitted fields use defaults. `earlyStatuses` are the statuses an open delivering PR moves to `reviewStatus`. While a task has an open question, Work Board adds the label named by `ownerDecisionLabel` (default `owner decision`; projects created before 0.47.0 keep `решение владельца`), creating it if missing. Set a status or label to `null` to disable rules that depend on it, or use an empty array for `earlyStatuses`. The default bugfix-to-done transition is rejected because review or testing failed; other exits remain available. Policy travels with project exports.

### Upgrade and rollback (0.28.0)

Export v14 includes optional per-project workflow policy, outcome evidence and deploy PR citations. Imports retain support for v1–v13. Update strict archive consumers before upgrading; keep a backup before rollback because older releases cannot read v10 archives. Diagnostic flags are calculated from local records and are not completion evidence.

### Related tasks (0.29.0)

The Dependencies section has one Add button (pick Blocked by, Blocks or Related, then a task) and lists every link on its own line. Related is for tasks that share context without blocking each other. The link is symmetric, stays within one project and never affects Blocked badges or advisories. CLI: `dependency add KEY --relates-to KEY` and `dependency remove KEY --relates-to KEY`; `dependency list` and `show --json` include `related`. Export v15 carries related links; imports accept v1–v14.
Question creation, answer changes, revisions and deletion reconcile the configured owner decision label with open questions. Manual task label edits, label renames/deletion, policy changes and archive imports do not reconcile existing questions; the next question change does. A null ownerDecisionLabel disables this reconciliation.
`bb work-board list --stale-status` filters diagnostic flags before pagination. List and show JSON expose `staleStatusFlags`; list RPC returns flags separately from task records. These diagnostics use the last recorded thread statuses and PR snapshots, not a live remote check. An unavailable PR snapshot is reported as `pr_state_unavailable`, except that a PR last seen merged stays merged when a later refresh fails (0.55.2); recorded active thread status may be out of date. A task in the review or testing status with no open PR gets `no_open_pr`; in the testing status a merged PR also counts, since testing after the merge is expected (0.55.3). In the review status a PR merged less than 2 hours ago counts too (0.75.0), while the lead collects post-merge evidence; the latest merge time that parses and is not in the future is used, and a merged PR without one gets no grace. After the grace the flag appears, and the attention pilot's 10-minute hold starts then. One request uses one clock: `list --stale-status` selects and shows the flags of the same instant, and a cursor from before an expiry is refused as stale. Nonexcluded closed PRs produce `closed_unmerged_pr`. A done task clears `no_merge_or_outcome` with structured merge evidence or `bb work-board comment KEY --kind outcome --body '…'`. Existing done tasks with a non-system comment are grandfathered until they change status. Diagnostics never move tasks.
## Card activity (0.18.0)

Card activity is separate from task workflow status. An attached session with both thread and runtime status active makes the card Working; idle or host-waiting sessions stay Attached. This applies to every card linked to that session, including parent links. Unattached sessions never imply card work. Accepted request markers and manual activity start/stop claims are diagnostic context only; they cannot hide or fabricate live execution. Pending owner interactions produce Waiting for owner, and queued card dispatches produce Queued when the session is not executing. A failure to read extra event/request metadata does not suppress verified live runtime activity. Missing thread/runtime data is treated as unknown. Observed execution or agent comments records work history; with no remaining sessions it gives Abandoned, except on done/canceled cards. Active work on terminal cards is warned about. Archive v10 preserves work history, not live claims or queue identities; imports v1–v9 remain accepted.


### Activity diagnostics (0.19.0)

Central and thread task details show the workflow status picker, live activity and attached-session links in a compact panel. Dispatch controls sit directly below it. The new-session preset button is shown only when no session is attached; attached cards keep the existing-session navigation and picker. Wide cards place this group above the properties rail; narrow cards show it inline. Technical explanations and identities are available through CLI diagnostics rather than in the task form.

`bb work-board show KEY` includes activity explanations and links to recent agent reports. `show KEY --json` exposes the same `activity` object as `listTaskCardMeta`: optional `diagnostics` contains `explanation`, `hasWorked`, `complete`, `checkedAt` and `inactiveSessions`; each session's optional `diagnostics` includes the source explanation, runtime/thread status, focused task, turn, request, queue and interaction identities. Diagnostics contain identifiers, not request or interaction contents. Check `complete` before interpreting missing activity; unavailable thread/runtime data leaves unverified sessions Attached; missing supplementary event data does not override a verified active runtime. Work history predating diagnostics records only that work happened, not the exact original execution or detachment event. Agent reports remain in `comments`; no history is fabricated.


### Sessions created outside Work Board

A session created directly in BB is automatically attached to every unfinished agent card explicitly named anywhere in its title, within the linked BB project. Examples: `Designer (Codex): EXA-455 Reference scenes`, `EXA-405, EXA-441`, and `EXA-202+359` (both EXA-202 and EXA-359). Duplicate keys are ignored; existing manual links remain intact.

Created/active lifecycle events attach immediately. Card metadata and thread reads also discover currently running sessions, sharing a bounded read for 10 seconds; titles generated later are picked up on a subsequent refresh. Only running ids are fetched, in batches of at most 200; idle history is not scanned. Manual detachment prevents rediscovery for that card while other named cards can still attach. Archived/done/canceled cards, unrelated projects and unavailable/private side-chat sessions are skipped. A system comment records the exact title reference. Runtime activity continues to determine Working versus Attached. Missing/malformed keys are not guessed. Failed discovery marks diagnostics incomplete without hiding verified execution or falsely marking an orphan Abandoned.


### Advisory checks

Cards, task details, and CLI `list` / `show` expose advisory warnings (`advisories` in JSON). An unresolved predecessor with a confirmed delivering PR that has merged prompts an acceptance-criteria or remaining-work check; the evidence includes the predecessor, PR URL, merge SHA, merge time, observation time and expiry. Related, design-only, excluded and unconfirmed links never count. Evidence requires enabled repository sync, a successful snapshot, and freshness within the configured polling interval; missing, failed or stale data remains unknown.

Agent tasks in `in_progress` with complete activity diagnostics and no live attached session prompt reassignment or queueing. The report includes the latest retained attachment and task activity; removed attachment details may no longer be retained. Session checks expire after one minute. When advice expires, an open board, list or task view rechecks only the affected tasks in one batched metadata read and keeps the last answer visible meanwhile, so a warning does not blink out between checks; a hidden view rechecks when shown again. Advice that could not be rechecked disappears one minute after expiry. There are no extra GitHub requests. PR refreshes invalidate both predecessor and dependent advice. These checks never move statuses, remove dependency links, block commands or send notifications. Only Done satisfies a dependency; a merged PR alone does not.

Label and preset management is available from the top panel: **gear icon → Manage labels and presets → Labels**. The **Plugin settings** item in the same menu opens Work Board settings.

The card header includes a **Copy task link** button next to the key, which copies a Markdown link for pasting into the agent chat; the card does not have a separate duplicate Share button. The original Share option remains available in Scheduled.

### Reports to the parent thread (0.40.0)

`bb work-board report KEY --kind ready|question|blocker [--need <text>] (--body <markdown> | --body-file <path>)` is how a child session tells its parent what the parent must act on. It must run inside a bb thread. A question or blocker requires `--need`, one or two sentences on what the recipient must decide or do; without it, with a blank one, or with one that asks nothing (starting with `nothing`, `none`, `no action` or `n/a` in any case, or a lone `-`), the command exits non-zero, delivers nothing, and points progress to `update KEY --progress`. The need leads the report on its own line as `Needed: …`. A question or blocker is also refused while the reporting thread has its own open owner question on the same card asked within the last 30 minutes; the parent already sees that wait on the card, so the hint points to `update KEY --progress`. `--kind ready` and `--progress` are not affected. The report does not go to the card log; the log keeps evidence, owner decisions and system records. The caller's own `parentThreadId` is woken with `queue-if-active`, and the message starts with `KEY · KIND`. If the parent is busy and its last queued message is a Work Board notice, the report is appended to it instead of queued separately. When the caller is the card's session, the report (led by **READY**, **QUESTION** or **BLOCKER**) also replaces the card's Current state; a line starting with `Handoff:` in the previous Current state is kept above the report, and a report over 4 KB is cut there and ends with a pointer to the parent thread. A helper, meaning a thread whose parent is already attached to the card, only wakes that parent and leaves Current state alone. A thread without a parent, or with an archived parent, gets an error and nothing is saved. If waking fails, Current state stays replaced and the command exits 1 with a hint to tell the parent manually. Progress is not a report kind: `update KEY --progress` replaces the card's state note and wakes nobody.

A session that took its card by message is not attached by the title scan. Its first `report`, or its first `update --progress`, attaches it to the card when the thread has a parent, is not attached yet and is not a helper. Top-level threads such as a manager and helpers are never attached this way; other updates never attach.

### Children's state notes (0.41.0)

`bb work-board children [--thread <id>] [--all] [--json]` lists the open (non-archived) child threads of the invoking thread, or of `--thread`. For each child it shows the unarchived cards it is linked to, excluding Parent thread fallback links, with each card's status and Current state note (`progressNote`, `progressUpdatedAt`). Done and Canceled cards are hidden unless `--all` is given; each child reports how many it hid in `hiddenFinishedCards` (0.41.1). The text output shortens each note to one 200-character line; `--json` returns full notes. It reads one page of 200 children (`truncated: true` when there may be more) and wakes nobody.

### Held cards are not stale (0.41.2)

An in-progress card that has an unfinished blocked-by predecessor (one in any status except Done, including Canceled) is held by rule. It no longer gets the `no_active_thread` stale flag or the `no-live-session` advisory. An in-progress card with no live thread and no unfinished predecessor is still flagged.
