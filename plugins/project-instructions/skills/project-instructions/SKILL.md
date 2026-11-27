---
name: project-instructions
description: Explain or configure the Project Instructions plugin, that is the process root file and process skills a project's threads receive from one local git clone. Use when a thread lacks the project's root or skills, or to enable, disable or check a project.
---

# Project Instructions

The plugin injects one file, the project's process root, into every thread of a configured bb project, and offers the process skills of the same clone as native skills. Other projects receive neither.

Open **Settings → Plugins → Project Instructions** to edit a project one field at a time. The **Project Instructions** sidebar page shows the current root, skills and last recorded sync. Refreshing the page reads local diagnostics and sync history.

CLI commands for individual fields:

- `bb project-instructions config get [<key>] --project <id>`
- `bb project-instructions config set <key> <value> --project <id>`

Keys: `clonePath` (absolute path of a local git clone), `branch`, `rootFile` (relative to the clone), `skillsDir` (relative, default `.bb/skills`), `enabled` (default `false`), `allowSync` (default `false`).

`bb project-instructions check --project <id> [--json]` shows the source status (branch, root size against the 4,096-character cap), the skills selectable now and each skipped skill with its reason. Run it before `config set enabled true`.

The root is injected only when the clone is on `<branch>` (a detached clone at or behind `origin/<branch>` also counts) and the root file is at most 4,096 characters; otherwise the thread gets one line naming the reason and no skill of the project is offered. Nothing is ever cut. A skill that changed in the last 10 seconds waits for a later thread. A skill name present in two enabled projects is offered to neither.

`bb project-instructions source --project <id> [--json]` (RPC `source.get`) shows the launch source other plugins read: clone, branch, HEAD, the origin tip read live with `git ls-remote`, and a state (`fresh` only when HEAD is exactly that tip; otherwise `not_configured`, `disabled`, `missing`, `wrong_branch`, `dirty`, `unreachable`, `stale` or `error`, with a reason). With `--sync` (RPC `sync: true`) and the project's `allowSync` true, a clean clone on its branch that is strictly behind is fetched and fast-forwarded first; set `allowSync` only after every other updater of the clone is stopped.
