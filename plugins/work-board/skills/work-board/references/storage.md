# Snapshots, archive and storage

Read this file when you export or import a project snapshot, archive or search archived tasks, or clean plugin storage.

## Project snapshots in Git

Export with `bb work-board export --project ABC --out .bb/tasks/<project-id>` and restore with `bb work-board import --from .bb/tasks/<project-id>`.
All task and attachment filenames use immutable IDs. The directory contains versioned `project.json`, `tasks/<id>.json`, and binary `attachments/<id>` files.
Export includes project/folder/label metadata, task and epic fields, Markdown descriptions, comments, thread links, key aliases, and attachments owned by tasks or comments.

Use a dedicated output directory: export replaces its previous snapshot and refuses unrelated files. Import validates the snapshot and attachment hashes and commits database changes atomically.
New records merge by ID; conflicting existing values require explicit `--overwrite`. Missing records never imply deletion. Imported task label assignments are replaced only after conflict checks.
Pull and import repository changes before exporting BB changes. Neither command commits or pushes Git changes, runs agents, nor restores full BB chats, external PR contents, global presets or account settings.
Paths target the invoking thread's machine, otherwise the server; `--machine <id-or-name>` selects another enrolled host. Add `--json` for a bounded machine-readable result.

## Task archive (0.8.0)

Working list queries exclude archived tasks by default. Find archived work with `bb work-board list --project PREFIX --archived --json`; use `--include-archived` for both scopes (mutually exclusive with --archived). Search/status/type filters and pagination apply normally. `bb work-board show KEY` reads either scope by immutable key/ID.

`bb work-board archive KEY` archives a Done/Canceled task and its completed children; an unfinished family is refused without partial changes. `bb work-board archive-completed --project PREFIX` archives eligible completed families in that project. These commands never change the workflow status and never delete records. `bb work-board restore KEY` restores the task and its children; restore an archived parent before restoring one of its sub-tasks/members. Questions, evidence, attachments and history remain available. Dispatch/worker-link changes on archived cards are refused until restoration. Do not archive real work unless the owner authorized it. There is no automatic archival of the card itself on Done, but closing a card with `update --status` archives the sessions Work Board created for it (the `archiveThreadsOnClose` setting); the command's own output lists what happened to each linked thread and what to do next, so read it. Export v7 includes both scopes and required archivedAt (null or canonical millisecond UTC ISO); old archives import as unarchived.


## Archive queries and retention (0.8.1)

Use `show KEY --json` for an exact task key/ID, including archived cards. `list --archived --search TEXT` matches key, title and description. `--latest N` (1–500) returns the newest matching page; continue with the returned `nextCursor` and identical filters. `--sort newest --limit N` is equivalent. `--on YYYY-MM-DD` filters a specific UTC calendar day; `--from YYYY-MM-DD --to YYYY-MM-DD` filters an inclusive range (either bound may be omitted). Do not combine --on with --from/--to. `--date-field archived|created|updated` chooses the timestamp for both date filtering and newest order; default is archived with --archived, otherwise created. Updated means task-record update, including archival/restoration, not last comment. Combine with project, status/exclude-status, type, label, priority and search normally. All filters apply before pagination. RPC fields: dateField, dateFrom, dateTo, sort:"newest", limit, cursor.

Each project has autoArchiveAfterDays, off by default; available values off, 3, 7, 14, 30. Use `bb work-board project update ABC --auto-archive 14` or `--auto-archive off`. Idle warnings are also per-project: `--stale-idle off|30|45|60|120` (default 45). Both are visible in `project show --json`, configurable under the single project selector in Settings, and portable in archive v11. Prior global values are migrated once for existing projects; reload after the first upgrade removes the temporary legacy controls. Its hourly sweep archives only Done/Canceled families without activity throughout the interval, unanswered questions or working agents. Task edits, comments, attachments and question changes postpone archival. Restored cards start a fresh inactivity interval. Manual commands are unchanged; no automatic archive on the Done transition itself. Export v11 includes both scopes, archivedAt and project archive/idle settings, excluding shared UI preferences. Do not enable automatic retention or archive live cards without owner authorization.


## Storage maintenance (0.22.2)

Use `bb work-board storage status --json` for plugin-owned disk usage, unreachable blobs older than 24h, and missing attachment files. `storage clean --json` performs the same safe cleanup as the daily sweep. `storage optimize --json` additionally shares identical immutable blobs and compacts SQLite; it may take time. Settings → Storage offers the same actions and reports before/after counts. Scope is all projects in this plugin, not the invoking machine or an export directory.

Cleanup preserves accessible/archived tasks, comments/evidence, attachments, questions, dependencies, PR links and rediscovery exclusions. It deletes only unreferenced managed blobs after a 24h grace period and unreachable transient activity/PR cache rows. Active uploads/imports are protected, symlinks skipped, missing metadata retained for recovery. Hard-linked blob paths are immutable: imports/replacements must write a fresh unique path, never modify a committed path in place. Filesystems without hard-link support retain the original files. SQLite uses bounded incremental vacuum after initial optimization (fresh databases support it immediately). External exports, release directories, BB logs and backups belong to their owners and are not pruned.

`bb work-board list --json` and `show KEY --json` include `advisories`: `merged-predecessor` (an unresolved predecessor with fresh confirmed delivery merge evidence) and `no-live-session` (Agent task in_progress, complete activity data, zero live attached sessions, and no unfinished blocked-by predecessor; a card held behind one is waiting by rule and gets neither this advisory nor the `no_active_thread` stale flag; a card with an open owner question does not get that stale flag either). Inspect the supplied PR, merge SHA, checkedAt/validUntil, retained last attachment and task activity. Expired or incomplete evidence is unknown. Check criteria or remaining work before marking a predecessor Done; consider reassignment/queueing for a sessionless task. Advice never changes status/dependencies or notifies anyone; only Done satisfies dependencies.

