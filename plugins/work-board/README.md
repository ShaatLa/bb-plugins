# Work Board

English | [Русский](README.ru.md)

## Storage management (0.22.2)

Settings → Work Board → **Storage** shows database/WAL usage, free database pages, logical blob contents versus allocated filesystem blocks, old unreferenced files, and missing attachment files. Statistics load only when the section opens. Storage is shared across projects.

Daily cleanup removes orphan activity claims/queue markers and PR snapshots with no surviving link, plus unreferenced managed blob files older than 24 hours and empty blob directories. It rechecks references before deletion and protects active uploads/imports, including long-running imports. Symlinks are never followed. Tasks, archived cards, comments/evidence, questions, dependencies, PR links/exclusions, observed-work history and accessible attachments are retained. Missing files are reported without deleting their metadata.

**Optimize storage** also shares identical immutable blobs using filesystem hard links, preserving every attachment ID/path/URL and exact contents, then rebuilds SQLite and truncates its WAL when readers permit. The operation can take time on large boards. Unsupported hard links leave originals intact and report skips. Fresh databases use incremental vacuum; older databases enable it after the first explicit optimization. Later daily cleanups return up to 256 free pages per sweep. Retained WAL allocation is limited to 4 MiB when SQLite can reset it after checkpoints; active readers or a transaction may temporarily require more. Live data still consumes space as the board grows; this is not a retention policy that deletes accessible history.

CLI: `bb work-board storage status --json`, `storage clean --json`, `storage optimize --json`. Actions return before/after usage, removed file/cache-row counts, shared duplicate count and warnings. Statistics count allocated blocks by unique inode; filesystem compression/clones can make these differ from device-wide free space. Current export format is v17. Maintenance only touches this plugin's database and managed blob directories, not external project exports, repository files, old installation releases, BB logs or backups.


## Task dependencies (0.22.0)

Use the task's **Dependencies** section to add or remove **Blocked by / Blocks** links and search predecessors by key or title. Board cards and list rows show **Blocked** with the unfinished predecessors; task details retain satisfied links and their status. A predecessor satisfies its links only in **Done**. Canceled does not satisfy them, and reopening Done restores the warning. These are warnings: dispatch and status changes remain available, and workflow status is never replaced automatically.

Agents can use `bb work-board dependency add ABC-2 --blocked-by ABC-1`, `dependency list ABC-2 --json`, and `dependency remove ABC-2 --blocked-by ABC-1`. `show --json` includes `dependencies` and `blocked`; `list --json` includes unresolved `blockedBy`. Dispatch prompts include the current blockers. Add/remove operations record history on both cards. Self-links and cycles are refused. Links currently stay within one project; moving a task family is allowed only if it carries all its dependency endpoints. Exports preserve outgoing dependency IDs (introduced in v12); imports v1–v11 preserve existing local dependencies.

Performance: activity consumers share bounded SDK reads and immutable dispatch attribution; Git sync batches attached sessions and shares post-merge pages within each run; archive capture batches SQL and limits JSON I/O while keeping blobs sequential; downloads revalidate privately with ETags and avoid an extra full-size buffer copy. Browser snapshot writes are coalesced and bounded, and PR overlap preparation is reused. Small English comments describe the resource invariants beside these paths.

Project creation is available directly in **Settings → Work Board → New project**, as well as in **Manage → Projects → New project** and the Work Board sidebar. Existing projects can be opened from the **Projects** tab; the creation form uses the same name, unique prefix, color, folder, and connection to a BB project. In Settings, the new project is automatically selected for configuration.

## Agent cost (0.39.0)

With the optional Tokenomos plugin installed, the task rail shows what agents spent on the task (API-equivalent price). A thread counts from "Thread attached" to "Thread detached", or until now while linked. Workers often stay linked to old tasks while moving on, so at any moment a thread's time belongs to the task it was attached to most recently. Commenters (a manager, a reviewer) and parent-fallback links do not count. Epics and tasks with subtasks sum their whole tree: the time windows go to Tokenomos (`costs.sum` with `spans`, descendants included) in one call, so shared threads count once. The Cost section (0.42.0) shows the total, a pie of the models that did the work, and a collapsible list of every counted thread with its model and cost (`breakdown: true`; older Tokenomos versions show only the total). The browser asks Tokenomos directly, so its `usage` invalidations refresh the section live with no polling. `~` marks an estimate or incomplete data; without Tokenomos the section is hidden.

## Public RPC for other plugins (0.36.0)

`threadTasks({threadId})` is discoverable (`bb plugin rpc list work-board`) and returns the tasks currently linked to a thread, newest link first: `key`, `title`, `status {id, name, icon?, color?, iconName, cssColor}`, `projectName`, `archived`, `linkName`, `linkedAt` and `url` (the in-app path that opens the task). Call it through `bb.sdk.plugins.callRpc({ pluginId: "work-board", method: "threadTasks", ... })`. `status.iconName` is a shared app icon (`work-board/status-<glyph>`, registered with `app.experimental_icons`, drawn in currentColor), so another plugin renders `<Icon name={status.iconName} />` inside `style={{ color: status.cssColor }}` and gets the same glyph and theme color as Work Board (0.37.0). The contract only grows with fields.

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

Settings → Work Board starts with **New project** and a single project selector. Archiving, idle-thread warnings, task statuses and Git/PR synchronization below it belong to the selected project. **General** contains the shared default screen and navigation badge criteria. The last selected project is still remembered on each device.

Existing projects inherit the former plugin-wide archive interval and idle threshold once during upgrade. New projects default to auto-archive Off and idle warnings after 45 minutes. The migration briefly registers legacy controls to read their values; reload the plugin after the first upgrade to remove those controls. Changing a project never changes another project's policy. Export v11 includes both project settings; v1–v10 imports remain accepted and missing settings preserve existing choices (or use Off/45 for a new imported project). General preferences are local and are not exported.

```sh
bb work-board project show EXA --json
bb work-board project update EXA --auto-archive 14 --stale-idle 60
bb work-board project update EXA --auto-archive off --stale-idle off
```


Source: [ShaatLa/bb-plugins](https://github.com/ShaatLa/bb-plugins/tree/main/plugins/work-board). Install this collection entry with `bb plugin install git:https://github.com/ShaatLa/bb-plugins.git@main --plugin work-board` after disabling built-in Tasks and completing any data import described below. Existing local-path Work Board installations can be re-registered with `bb plugin install /path/to/collection --plugin work-board` while retaining the same plugin ID and data.

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

In the **Work Board → Open by default** settings, you can choose the startup screen: the last project's Kanban (default), the last project's task list, all tasks, or active tasks. The last selected project is remembered on this device. If the project is deleted, the first available project opens. Direct links continue to navigate to the screen specified in them.

Click the project name (or **All tasks**) in the header to switch to another project or to All tasks.

The **List / Board** toggle in the project (or task) header controls the right-side **Kanban** tab: **Board** opens it, while **List** switches to the Navigation tab without closing the Browser, Terminal, or the panel itself. The toggle's state is synced with the panel, so switching tabs or hiding the panel immediately updates it. The main area always displays the task list or an individual task, allowing you to review task details alongside the board. The board header includes a **Scheduled** button that opens the schedule in the main area. The board tracks the selected project, preserves card dragging, and updates in sync with the task list.

The **Work Board** tab in the thread's right panel defaults to the Work Board project linked to the thread's BB project. Board cards and new tasks open in the same tab; **Back to project board** returns you to the board. The task key and back button are located in the card header above the title. A copy button sits next to the key and copies only the key. The dedicated task bar at the top of the side panel is streamlined and doesn't take up extra space. Opening a specific task from a message persists across navigation. The header arrow opens the board or task in the main Work Board section. If the projects aren't linked, the panel displays **Manage projects** instead of automatically switching to the last viewed project.

Both the main screen and right panel board share the **Type**, **Status**, **Priority**, and **Label** filters, plus a **Clear** button. Filter selections are saved per project alongside the task list filters. Manual card ordering and dragging actions are preserved.

The **Search tasks** field in both the list and board accepts input immediately and displays results directly below. It searches across keys, titles, and descriptions, including epics, subtasks, and completed tasks. The search isn't constrained by the current view's filters: within a project, it's scoped to that project, while in All tasks and Active, it spans all projects. Exact keys also match previously assigned keys for moved tasks. Search results open directly in the current panel, and selection supports keyboard navigation. When in a project view, entering a task number resolves directly to its key. Upon opening the view, an index of active tasks is preloaded, including epics, subtasks, and descriptions. Input filters it locally without request latency or per-character RPC calls; incremental updates are loaded in the background. Text search returns the first 25 matches and indicates when the query should be refined. If a previously assigned key for a moved task or an exact key for an archived task isn't in the local index, the server resolves it.


## Migrating from Agent Board / Tasks Plus to Work Board (0.11.0)

This is a plugin ID change, not the installation of a second, independent board. The new ID and collection folder are `work-board`, and the command is **`bb work-board …`**. There are no legacy CLI aliases. First, update your command consumers: automations, agent roles, and strict export validation. The `project.json.format` marker is now `bb-work-board`; exports then used version **v13** (now v17). Imports also accept `bb-agent-board` and `bb-tasks-plus` (v1–v13).

Save your settings (`bb plugin config agent-board --json`) and back up the database using the SQLite backup API along with a copy of the `blobs` folder. Stop the old plugin before migration; the destination directory must not exist:

```sh
bb plugin disable agent-board
python3 scripts/import_tasks.py --source-plugin agent-board
bb plugin install git:https://github.com/ShaatLa/bb-plugins.git@main --plugin work-board
bb work-board status --json
```

If Tasks Plus is installed, use `tasks-plus` instead of `agent-board` in the settings export, disable, and `--source-plugin` commands. The migration helper is located in the new `plugins/work-board/scripts` folder.

The helper copies the database to `~/.bb/plugins/work-board`, preserves the ID and all tables, migrates attachments, and updates only old attachment URLs to the new ID, including links in questions and the JSON history. The source remains untouched; migrating over existing data is prohibited. On first run, the previous `autoArchiveAfterDays`, `staleIdleMinutes`, and `defaultScreen` settings are migrated automatically. Archiving and idle thresholds are later adjusted in the settings of the selected project; the default page is set in General. PR settings and links are stored directly in the database: migrate their current values at the time of switching. Keep the old plugin disabled until you verify the migration and export, then unregister it; keep backups stored separately.

When rolling back after new entries, migrate the **latest** data back, rather than overwriting it with an old snapshot. Disable Work Board, back up both directories, and clear the destination folder, then run `--source-plugin work-board --destination-plugin agent-board` (or `tasks-plus`); install the previous frozen release and restore your settings. The `--data-dir` parameter supports an alternate BB directory.

The last project, view, filters, and preferred thread/preset are migrated to the device only once; current Agent Board preferences take priority over older Tasks Plus ones. Legacy values are retained for rollback purposes, but caches are not migrated. Historical messages and serialized mentions in BB are not rewritten. The `::task{key="ABC-1"}` directive is preserved. Old attachment links within imported archives are normalized; archives containing account data and tokens are not generated.

## Card Loading

The card displays local task data, saved threads, and comments without waiting for GitHub or agent metadata refinement. These data updates independently in the background: the card remains available, open editors stay intact, and the typed title is preserved. Git loading is indicated by a spinning arrow in the Pull requests block; synchronization does not block adding or editing PR links. The Activity section initially shows the latest 20 entries; **Show earlier activity** expands older entries in batches of 20 without discarding history. Standard comments are rendered by BB's native Markdown renderer instead of launching a separate editor for each comment, and legacy plugin special links continue to work.

The Evidence section initially shows the latest 15 entries. **Show earlier evidence** expands history in batches of 15, preserving grouping by PR and head, as well as superseded markers. The limitation applies only to the UI; the full history remains in the data and exports.

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

In **Settings → Plugins → Work Board → Task statuses**, select a project. The **+ Add status** button adds a row for a new stage (e.g., **In testing**). The ID is generated automatically. The name is saved on Enter or when leaving the field; added statuses are removed using the trash icon. Dragging the handle on the left changes the order of statuses and board columns. Keyboard shortcuts: Space, arrow keys, then Space or Enter; Escape cancels the move. Changes are saved automatically. Settings apply only to the selected project and are used in the list, main and right boards, filters, and card menus.

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
bb work-board question list EXA-8 --json
bb work-board question answer EXA-8 --question <question-id> --answer <option-id> --revision 1
bb work-board question answer EXA-8 --question <question-id> --clear --revision 2
bb work-board question delete EXA-8 --question <question-id> --revision 3
```

For multiple selections, repeat `--answer`. Questions are visible in the main and side cards, in `show --json` output, in delegation context, and in task mentions. Exports include the questions, options, selected IDs, answer author, and revision. Secret protection covers the question and option text as well as answer metadata.

When an answer is updated, the plugin notifies askedByThread if provided; otherwise, it targets the first pinned work thread (active ones first), or the most recent responding agent. If a thread is busy, the notification is queued. Re-submitting the same answer won't trigger another notification. Delivery failures still save the answer and display a warning. Agents re-read the current answer before proceeding. Cards and rows display a question icon with a count and tooltip. The **Waiting on me** filter works across lists, the main board, and the right board, and is remembered per project.

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

Epics share the project's issue numbering, statuses, descriptions, comments, attachments, and thread bindings. The epic status is updated manually; progress is calculated based on completed child tasks. The agent receives the epic description alongside its own task context.

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

`project.json` contains the bb-work-board format marker, version 17, project metadata, folders, labels, task IDs and templates. Task files preserve Markdown, comments/evidence, questions, worker links, aliases, dependencies and attachment hashes. Attachments use immutable IDs. Export contains no storage paths. Imports support v1–v16; see the v17 field changes below.

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
bb plugin install git:https://github.com/ShaatLa/bb-plugins.git@main --plugin work-board
```

The plugin adds the Work Board sidebar panel, the `bb work-board` command, and an agent
skill that teaches workers how to report progress back to tasks.

## Quick start

Install the plugin with `bb plugin install git:https://github.com/ShaatLa/bb-plugins.git@main --plugin work-board`. Then use the `bb work-board` CLI
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
use either to drop a thread that died or moved on to other work. The task
page and `bb work-board threads` list live threads before completed or failed ones,
newest first.

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


Sub-task questions are visible on both boards and in the Kanban tab via the parent card. The top counter sums questions from the parent and its sub-tasks; the tooltip shows the breakdown. Click the counter to expand sub-tasks, or use **Sub-tasks · completed/total**. The expanded list shows the key, title, status, and question count; tasks with questions appear first. Clicking an item opens the sub-task in the current panel. The **Waiting on me** filter keeps the parent visible when questions exist within sub-tasks, and automatically expands only sub-tasks waiting for a response, excluding completed and canceled ones. The counter and filter update after a response is submitted. Sub-tasks do not become independent cards/columns and are not involved in board drag-and-drop.


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

Open linked PRs in the same repository show shared files across different tasks. Configure up to 50 `overlapRules` in Git/PR Advanced settings or `git-config --file`, for example `[{"pattern":"migrations/**","match":"added"},{"pattern":"docs/traceability/*.json","match":"changed"}]`. `changed` highlights shared matching paths; `added` highlights matching additions or rename targets even when their names differ. Patterns support `*`, `**` and `?`. Cards show a marker and PR details list matched files; `show --json` and `pr list --json` include `overlaps`. File lists are fetched during sync only when the PR head changes, capped at 3,000 files with `truncated` recorded. Cached files and overlap results are local and not exported; rules round-trip in export v8.

### GitHub PR/CI synchronization (0.9.0, export v8)

Open **Work Board settings** with the gear icon next to Refresh on the Work Board page, or use **Settings → Plugins → Work Board**. Choose a tracker project, then **Git and pull requests**. Each tracker project has its own repository list (`owner/repo`), optional periodic synchronization (off initially, five minutes when enabled), title discovery, lookback and check/workflow settings. Select GitHub repositories discovered in BB projects with checkboxes. **Other repositories** expands a manual `owner/repo` field, an **Add** button and a removable repository list. Switches control periodic sync and title discovery; **Advanced settings** contains lookback, post-merge observation, required checks and workflow names. Multiple projects can watch the same repository; multiple repositories and PRs per task are supported. The first connector supports public and private repositories on github.com. Other hosting providers and GitHub Enterprise hosts are not implemented.

The connector reads GitHub using `GH_TOKEN`, `GITHUB_TOKEN`, then the server's existing `gh auth token --hostname github.com`; public repositories can use anonymous access. It never switches accounts, writes PR comments/labels, merges PRs or changes a local checkout. Private repositories need read access to PRs, contents/commit statuses, checks and (for post-merge observation) Actions. Optional protection/review metadata can remain unknown if unavailable; a required-check override avoids requiring additional administration access. Tokens and account data never enter exports.

The compact **Pull requests** list appears below the task properties in the right column (below the content in narrow panels). PR, check, workflow and evidence links use BB’s native URL navigation. Expand a PR row for checks, merge/review details and link actions; the header icons refresh or add a link. **Link PR** in a task card accepts a full canonical GitHub PR URL, a role (**delivers**, **design**, **related**) and optional delivery part `k/m`. Explicit links are confirmed. Whole keys in PR titles and worker-environment metadata produce suggested related links. Environment PRs are suggested only for attached tasks whose whole key (including historical aliases) appears in the PR title, head branch or body. PRs naming only other tasks, or no task key, are skipped; link these explicitly when needed. This does not alter manual links or persistent exclusions. A single-repository project's structured evidence `--pr` can also suggest a reference; bare numbers are ambiguous across multiple repositories. Ordinary PR-body/comment mentions and branch names do not create delivery links. Task key aliases work after prefix changes. Confirm/edit a suggested link to choose its role. **Exclude** persists across polling; **Relink** explicitly restores it. Links survive thread archival and task title changes, and include immutable task/remote PR IDs. Renamed GitHub repositories update their configured path after a successful direct lookup.

Cards in the list, central board and side board show a compact PR/CI summary. Task details on both surfaces show every linked PR, current head SHA, check states, required/optional/unknown requirements, review decision, merge state/queue, unresolved-thread count when available, freshness and errors. CI uses the current PR head, latest check IDs and latest commit statuses; failed, pending, skipped, neutral and cancelled checks stay distinct. Green CI is not a merge approval. These checks describe the PR head; test-merge/merge-group check evaluation and complete signing/ruleset diagnostics are not claimed. GitHub's reported merge blockers are displayed separately.

Task statuses stay owner/agent controlled with one exception: when a confirmed `delivers` PR is open or draft, a linked task in one of the project's `earlyStatuses` (default `todo`, `in_progress`) moves to the project's `reviewStatus` (default `in_review`). Set `earlyStatuses` to `[]` or `reviewStatus` to `null` to turn this off. Notifications, automatic merge evidence and other workflow transitions are not implemented. No generic definition of “task complete” is inferred from discovered PRs or their roles.

```sh
bb work-board git-config --project ABC --json
bb work-board git-config --project ABC --file ./git-sync.json
bb work-board pr link ABC-12 --url https://github.com/example/service/pull/42 --role delivers --part 1/2
bb work-board pr list ABC-12 --json
bb work-board pr unlink ABC-12 --url https://github.com/example/service/pull/42
bb work-board sync --project ABC --json
bb work-board show ABC-12 --json
```

A configuration file accepts `enabled`, `repositories`, `pollMinutes` (1–60, default 5), `lookbackDays` (1–365, default 30), `titleDiscovery` (default true), `requiredChecks` (up to 50 unique names, empty reads available GitHub requirements), `prWaitIgnoredChecks` (up to 50 required check names that `pr wait` does not judge), `postMergeWorkflows` (up to 10 unique names or workflow ID strings) and `postMergeDays` (1–90, default 7). Omitted settings use their defaults. `git-config --file` replaces the whole configuration, not a partial patch. CLI file paths use the invoking machine or `--machine`; credentials belong on the BB server. `pr list --json` includes snapshots and errors; `show --json` exposes the same data as `prLinks` in addition to legacy environment PR checks. The public RPC contract exposes get/setGitSyncConfig, linkPr, unlinkPr, listPrLinks, prSummaries and syncGit.

### Settings one key at a time

Every per-project setting can be read and changed on its own: `bb work-board config get [KEY] --project PREFIX [--json]` lists all keys or shows one, and `bb work-board config set KEY VALUE --project PREFIX` validates and saves only that key, printing `KEY=value`. Keys: `autoArchiveAfterDays`, `staleIdleMinutes`, `statusNotifications`, and every Git/PR field with a `git.` prefix (`git.enabled`, `git.repositories`, `git.requiredChecks`, `git.prWaitIgnoredChecks`, `git.pollMinutes` and so on). VALUE is JSON or plain text; list keys also take a comma-separated value (`config set git.requiredChecks "CI, Lint" --project EXA`). The same calls are RPC `config.get {projectId, key?}` and `config.set {projectId, key, value}`. `git-config --file` and `project update` keep working.

Global preferences are native plugin settings: `bb plugin config work-board` lists them, and `bb plugin config work-board set startScreen active` or `set badgeInReview true` changes one. Fields: `startScreen` and one boolean per navigation badge criterion (`badgeOpen`, `badgeWaitingOnOwner`, `badgeInReview`, `badgeNeedsAnswer`, `badgeFailedThread`, `badgeStaleIdle`). Values saved before 0.44.0 move there once on upgrade.

`openThreadsIn` (`bb` by default) chooses where Work Board's own thread links open: session rows, comment authors, thread mentions in descriptions and the open-session buttons. With `agent-hub` they open the conversation in the Agent Hub plugin (or in Answers, its former id, while only that is installed); when neither is installed and enabled they keep opening bb chat. A stored `answers` value is still accepted and becomes `agent-hub` when Work Board loads. Thread mentions inside rendered comment Markdown are routed by bb and always open bb chat.

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

In Work Board settings (Settings → Plugins → Work Board or the gear icon on the Work Board page), the **Navigation badge** section lets you choose what the Work Board navigation badge counts: open tasks (default), tasks in review, tasks with unanswered questions, tasks with failed threads, and tasks with idle threads that lack updates (threshold controlled by the Flag idle threads without task updates setting). You can select multiple criteria: the badge shows the number of unique tasks matching at least one criterion, counting each task only once. The tooltip provides a breakdown, for example, "3 tasks: 2 with unanswered questions, 1 in review". If no criteria are selected, the badge is hidden. Only non-archived tasks are counted; `done` and `canceled` statuses are excluded everywhere. Settings are native plugin fields (`bb plugin config work-board`) shared across all devices; RPC: `getNavigationBadgeCriteria`, `setNavigationBadgeCriteria`, `navigationBadge`. The badge updates on task and thread events, when criteria change, and additionally once per minute when thread idle monitoring is enabled.

### Upgrade and rollback (0.16.0)

Export v9 preserves optional workflow status icons and colors. Imports accept v1–v9, including v8 archives that already contain this metadata. Update strict archive consumers before upgrading. Before rolling back, keep a v9 backup: older releases may reject v9 archives or status metadata; do not remove icons or colors from live data to make a rollback work.

Each project can configure workflow rules with `bb work-board project update PREFIX --workflow-policy-file policy.json` (also accepts `--machine`). RPC clients can set `updateProject({projectId, workflowPolicy})`. The JSON object accepts `bugfixStatus`, `doneStatus`, `inProgressStatus`, `reviewStatus`, `testingStatus`, `earlyStatuses`, and `ownerDecisionLabel`; omitted fields use defaults. `earlyStatuses` are the statuses an open delivering PR moves to `reviewStatus`. While a task has an open question, Work Board adds the label named by `ownerDecisionLabel` (default `owner decision`; projects created before 0.47.0 keep `решение владельца`), creating it if missing. Set a status or label to `null` to disable rules that depend on it, or use an empty array for `earlyStatuses`. The default bugfix-to-done transition is rejected because review or testing failed; other exits remain available. Policy travels with project exports.

### Upgrade and rollback (0.28.0)

Export v14 includes optional per-project workflow policy, outcome evidence and deploy PR citations. Imports retain support for v1–v13. Update strict archive consumers before upgrading; keep a backup before rollback because older releases cannot read v10 archives. Diagnostic flags are calculated from local records and are not completion evidence.

### Related tasks (0.29.0)

The Dependencies section has one Add button (pick Blocked by, Blocks or Related, then a task) and lists every link on its own line. Related is for tasks that share context without blocking each other. The link is symmetric, stays within one project and never affects Blocked badges or advisories. CLI: `dependency add KEY --relates-to KEY` and `dependency remove KEY --relates-to KEY`; `dependency list` and `show --json` include `related`. Export v15 carries related links; imports accept v1–v14.
Question creation, answer changes, revisions and deletion reconcile the configured owner decision label with open questions. Manual task label edits, label renames/deletion, policy changes and archive imports do not reconcile existing questions; the next question change does. A null ownerDecisionLabel disables this reconciliation.
`bb work-board list --stale-status` filters diagnostic flags before pagination. List and show JSON expose `staleStatusFlags`; list RPC returns flags separately from task records. These diagnostics use the last recorded thread statuses and PR snapshots, not a live remote check. An unavailable PR snapshot is reported as `pr_state_unavailable`; recorded active thread status may be out of date. Nonexcluded closed PRs produce `closed_unmerged_pr`. A done task clears `no_merge_or_outcome` with structured merge evidence or `bb work-board comment KEY --kind outcome --body '…'`. Existing done tasks with a non-system comment are grandfathered until they change status. Diagnostics never move tasks.
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

`bb work-board report KEY --kind ready|question|blocker [--need <text>] (--body <markdown> | --body-file <path>)` is how a child session tells its parent what the parent must act on. It must run inside a bb thread. A question or blocker requires `--need`, one or two sentences on what the recipient must decide or do; without it, with a blank one, or with one that asks nothing (starting with `nothing`, `none`, `no action` or `n/a` in any case, or a lone `-`), the command exits non-zero, delivers nothing, and points progress to `update KEY --progress`. The need leads the report on its own line as `Needed: …`. The report does not go to the card log; the log keeps evidence, owner decisions and system records. The caller's own `parentThreadId` is woken with `queue-if-active`, and the message starts with `KEY · KIND`. If the parent is busy and its last queued message is a Work Board notice, the report is appended to it instead of queued separately. When the caller is the card's session, the report (led by **READY**, **QUESTION** or **BLOCKER**) also replaces the card's Current state; a line starting with `Handoff:` in the previous Current state is kept above the report, and a report over 4 KB is cut there and ends with a pointer to the parent thread. A helper, meaning a thread whose parent is already attached to the card, only wakes that parent and leaves Current state alone. A thread without a parent, or with an archived parent, gets an error and nothing is saved. If waking fails, Current state stays replaced and the command exits 1 with a hint to tell the parent manually. Progress is not a report kind: `update KEY --progress` replaces the card's state note and wakes nobody.

A session that took its card by message is not attached by the title scan. Its first `report`, or its first `update --progress`, attaches it to the card when the thread has a parent, is not attached yet and is not a helper. Top-level threads such as a manager and helpers are never attached this way; other updates never attach.

### Children's state notes (0.41.0)

`bb work-board children [--thread <id>] [--all] [--json]` lists the open (non-archived) child threads of the invoking thread, or of `--thread`. For each child it shows the unarchived cards it is linked to, excluding Parent thread fallback links, with each card's status and Current state note (`progressNote`, `progressUpdatedAt`). Done and Canceled cards are hidden unless `--all` is given; each child reports how many it hid in `hiddenFinishedCards` (0.41.1). The text output shortens each note to one 200-character line; `--json` returns full notes. It reads one page of 200 children (`truncated: true` when there may be more) and wakes nobody.

### Held cards are not stale (0.41.2)

An in-progress card that has an unfinished blocked-by predecessor (one in any status except Done, including Canceled) is held by rule. It no longer gets the `no_active_thread` stale flag or the `no-live-session` advisory. An in-progress card with no live thread and no unfinished predecessor is still flagged.
