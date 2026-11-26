# Project settings and notices

Read this file when you change project workflows or statuses, set up status pushes, manager attention or repository checks, or handle secrets.

## Secret guard

Task/epic titles, descriptions and comment bodies are checked at write time for common GitHub, AWS, Slack, Google, Anthropic, OpenAI, JWT and private-key formats. Remove detected credentials and retry; never repeat the value in an error report. There is no bypass flag, including for imports with `--overwrite`. Attachments and existing records are not scanned; retain the Git-side secret check.

Project status pushes apply to agent and plugin automation changes. Owner changes in the UI or CLI outside an agent thread never send a status push, including Done.

Exclude workflow statuses with `bb work-board list --project ABC --exclude-status done --json`. Repeat `--exclude-status` or comma-separate, e.g. `--exclude-status done,canceled`. It combines with other filters: excluded statuses are removed from the `--status` selection, or from all statuses when no `--status` is supplied. Excluding every selected status returns an empty result. Filtering happens before pagination; keep the same effective filters for `--cursor`. This CLI option uses the existing RPC `statuses` inclusion filter; no archive change.

## Project workflows (0.6.0)

Settings → Task statuses lets owners select a status icon from 20 existing glyphs, or Default to remove the override. The optional `icon` field uses IDs validated by `shared/statuses.ts`; preserve it when replacing a workflow. The color picker offers 10 palette values, without a Default swatch. The optional `color` field still accepts all 11 values in `shared/colors.ts` so existing Teal selections remain readable; omitting the field uses the theme color. Preserve both fields when replacing workflows. Icons and colors are project-specific presentation and do not change completion semantics.

Discover status IDs with `bb work-board project show PREFIX --json` (`project.statuses`, ordered `{id,name,icon?,color?}` array). Use IDs with `create/update --status`, `list --status` and `--exclude-status`; names are editable labels. `project update PREFIX --statuses-file PATH [--machine HOST]` replaces the complete array from the invoking machine. `project update PREFIX --status-notifications off|all|done` controls status change pushes. Keep all six system IDs. Custom IDs use `[a-z][a-z0-9_]{0,63}` and are open stages; only `done` completes and `canceled` cancels. Removing a status in use is rejected. Moving an epic/task between projects requires all its current status IDs in the destination. Archive v6 persists the workflow; v1–v5 import as the original workflow. API list filters also accept `excludeStatuses`; inclusion and exclusion are combined.


## Manager attention: stale-status notices

Work Board can send the manager a batched stale-status notice. It is On or Off per project (`bb work-board config get attentionMode --project KEY` reads `live` or `off`), changed by the owner in the project settings; by convention agents never change it or the manager setting, and every change is recorded. If you receive a `Stale status` notice, check each listed card: move it, ask the owner on the task, or comment the reason. An occurrence clears by itself when the flag is gone. Read the manager with `config get manager`. The manager comes only from Work Board (no fallback recipient); an unusable manager (none chosen, deleted, archived, stopping, a side chat, unverifiable) blocks turning notices on and pauses delivery while they are on. While notices are on, repository check reports leave out the script's `ACTION stale-status` lines.

## Repository checks (0.64.0)

Checks fetch from the linked BB project's Git remote by default. To fetch the script from another repository, set `bb work-board config set checks.remote git@example.com:owner/process.git --project EXA`. Use an HTTPS URL without userinfo, an SSH URL with an optional username, or `user@host:path`. Omit passwords, queries and fragments. Clear the override with `bb work-board config set checks.remote null --project EXA`.

A tracker can run its repository check script and deliver the findings to its manager. It is off for every project and `checks.enabled` is the owner's (a convention like the planning mode: the platform cannot authenticate the owner, so the guard is the settings UI plus the audit log): `config set checks.enabled` is refused and you never change it by any other route. Every other field is yours to read and set one at a time (`bb work-board config get checks.branch --project KEY`, `config set checks.args '["--root","{manager}"]' --project KEY`). `bb work-board checks status --project KEY [--json]` shows the last and next run, exit, failure stage, the pending report, the receipt and destination, and errors; `checks stats --project KEY --days 7` shows the counters. `checks run --project KEY --dry-run` runs the script once without staging, delivering or counting, but the script itself may send messages: do not run it against a project another tracker owns or while the owner has not asked for a check. A delivered report is a `Needs attention` / `Check failed` message from the plugin; treat its items like any other manager notice. An `unknown` delivery (status `blocked: delivery unknown, Retry needed`) is resolved only by the owner's Retry in the project settings. On each scheduled run the runner also reports archived threads' leftover git worktrees under the thread storage root as `ACTION archived-worktree thr_…` lines (size, clean or dirty; read-only, never cleaned up by the runner) once per path; `checks status` shows how many paths are reported and pending, and a manual `checks run` never scans. On each scheduled run the runner also reports archived threads' leftover git worktrees under the thread storage root as `ACTION archived-worktree thr_…` lines (size, clean or dirty; read-only, never cleaned up by the runner) once per path; `checks status` shows how many paths are reported and pending, and a manual `checks run` never scans.


Notice fallback (0.72.0): when the manager definitely cannot take a repository-checks report, Work Board delivers it to Agent Hub as a notice (manager's chat or Questions; Agent Hub pushes the owner). `checks status` then shows `to agent-hub (notice)` and the fallback reason; while a notice's outcome is uncertain the report is not sent to the manager, and **Retry** in the settings resolves an `unknown` one.
## Status push notifications

Settings → select a project → Activity and notifications → Notify me of status changes applies only to that project: Off (default), All status changes, or Done only. Uses the enabled BB Push notifications channels. Only agent and plugin automation status updates notify; owner UI/CLI changes are suppressed. All paths use the same store observer; no-op saves and rolled-back changes do not notify. Rapid changes to the same card are coalesced before delivery. Delivery failures are logged, never roll back work, and are not retried automatically.


