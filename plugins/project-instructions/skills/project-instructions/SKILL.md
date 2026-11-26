---
name: project-instructions
description: Explain or configure the Project Instructions plugin, that is the process root file and process skills a project's threads receive from one local git clone. Use when a thread lacks the project's root or skills, or to enable, disable or check a project.
---

# Project Instructions

The plugin injects one file, the project's process root, into every thread of a configured bb project, and offers the process skills of the same clone as native skills. Other projects receive neither.

Per project (one field at a time):

- `bb project-instructions config get [<key>] --project <id>`
- `bb project-instructions config set <key> <value> --project <id>`

Keys: `clonePath` (absolute path of a local git clone), `branch`, `rootFile` (relative to the clone), `skillsDir` (relative, default `.bb/skills`), `enabled` (default `false`).

`bb project-instructions check --project <id> [--json]` shows the source status (branch, root size against the 4,096-character cap), the skills selectable now and each skipped skill with its reason. Run it before `config set enabled true`.

The root is injected only when the clone is on `<branch>` (a detached clone at or behind `origin/<branch>` also counts) and the root file is at most 4,096 characters; otherwise the thread gets one line naming the reason and no skill of the project is offered. Nothing is ever cut. A skill that changed in the last 10 seconds waits for a later thread. A skill name present in two enabled projects is offered to neither.

The plugin never updates the clone; something else must keep it current.
