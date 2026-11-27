# Project Instructions

Gives every thread of one configured bb project the root file of that project's process, and the project's process skills, from a single local git clone. Nothing is copied into the project's worktrees, so a worktree created long ago sees the same process as one created now.

Instructions form a directed graph: the plugin injects only the **root** file. The agent reaches the rest through the links between markdown files, and the injected header tells it which directory the relative links resolve from, so the graph also works from a worktree that has no copy of the linked files.

## Configuration

In bb, open **Settings → Plugins → Project Instructions** and choose a project. Text fields save individually when you leave the field or press Enter. The right side of the field shows the save result and offers a retry on failure. Switches apply immediately. Concurrent writes to the same field are last-write-wins. **Check source** runs the same diagnostics as the CLI.

Open **Project Instructions** in the sidebar to see the configured projects, root file and preview, selectable and skipped skills, and the last sync result. Sync history records requests made with sync allowed and preserves the last successful fast-forward. **Refresh** reads diagnostics and recorded results without contacting the remote.

The CLI also edits one field at a time:

```sh
bb project-instructions config set clonePath /abs/path/to/clone --project proj_example
bb project-instructions config set branch main --project proj_example
bb project-instructions config set rootFile .bb/AGENTS.md --project proj_example
bb project-instructions config set skillsDir .bb/skills --project proj_example   # the default
bb project-instructions check --project proj_example
bb project-instructions config set enabled true --project proj_example
bb project-instructions config get [<key>] --project proj_example
```

| Key | Meaning |
| --- | --- |
| `clonePath` | Absolute path of a local git clone. |
| `branch` | The branch the process lives on. |
| `rootFile` | The root file, relative to the clone, no `..`. |
| `skillsDir` | Directory of the process skills, relative to the clone. Default `.bb/skills`. |
| `enabled` | Default `false`: configure and `check` first, enable afterwards. |
| `allowSync` | Default `false`. Lets `source.get` with `sync: true` fast-forward the clone. Set it only after every other updater of the clone is stopped: the plugin must be its only writer. |

The same operations are RPC methods `config.get {projectId, key?}`, `config.set {projectId, key, value}` and `check {projectId}`. `check` prints the source status, the skills selectable now and every skipped skill with its reason (invalid, clash, changed within the grace period); `--json` returns the same data.

## The root

On every thread configuration (start and each turn) an enabled project gets one line, `Project process root, read from <path> on branch <b>. Relative links in it resolve from <dir>.`, then the root file unchanged. Other projects get nothing.

The root is read from the working tree and injected only if:

- the clone's branch identity is right: an attached HEAD must be exactly `refs/heads/<branch>`; a detached HEAD must be at or behind `origin/<branch>` (so a clone that an automation checks out detached a few minutes ago still passes); another branch fails even when its commit is an ancestor;
- the file exists and has at most **4,096 characters**.

Otherwise none of the root is injected. The thread gets a single line, for example `The project process root was not injected: <path> is 5,120 characters, over the 4,096 limit.`, the same reason is logged and shown by `check`, and nothing is ever cut. The limit is this plugin's own; bb itself cuts a plugin's dynamic instructions only at 32,768 characters.

## Skills

bb registers a plugin's skills from fixed directories inside the plugin and a plugin selects them by name. This plugin therefore keeps a second skill directory, `linked-skills/`, which it fills at run time with one symlink per process skill (`linked-skills/<name>` to `<clone>/<skillsDir>/<name>`), and selects those names only for threads of the configured, enabled project, and only while the source status above is good. bb then offers them natively on every provider, with no copy in the worktree. A worktree's own `.bb/skills/<name>` or a user skill with the same name still overrides the plugin's.

A skill is selected only if it passes the checks bb itself applies (frontmatter `name` equal to its directory name, a non-empty `description` of at most 1,024 characters, no symlinks or special files inside), is linked, and neither it nor its link changed in the last 10 seconds. A skill that fails any of these is skipped alone; the others are still selected.

**Scope limit.** A plugin's skills are selected by name only, so one name can serve one project. A skill name present in the skills of two enabled projects is linked and selected for neither, and `check` reports it in both. `config set enabled true` is refused while the project's skills clash with another enabled project's.

**Residual limitation.** The plugin cannot read the list of skills bb made when it started resolving a thread, so the 10-second rule is a timing rule, not a proof. It fails only if one resolution takes more than 10 seconds between bb's listing and the plugin's selection while a skill changes in that window, or if the system clock jumps by more than that. Then bb discards this plugin's skill selection for that one thread until its provider session is next built; the root is unaffected.

## Freshness

The plugin reads the clone on every thread configuration, so whatever updates the clone (a fetch and checkout on a schedule, say) reaches the next thread with no copy. A caller may also request a fast-forward when sync is allowed.

## Source for other plugins

`source.get {projectId}` (RPC) and `bb project-instructions source --project <id> [--json]` return the project's resolved process source, so another plugin (a launcher, say) can take its launch material from the same clone instead of a copy:

```json
{ "projectId": "proj_example", "configured": true, "enabled": true, "clonePath": "/abs/clone", "branch": "main",
  "head": "<sha>", "originHead": "<sha>", "state": "fresh", "reason": null, "fetchedAt": 1795680000000 }
```

The first failing check sets `state`:

| State | Meaning |
|---|---|
| `not_configured` | `clonePath` or `branch` is not set. |
| `disabled` | Configured, `enabled` is false. Answered from memory, before any filesystem or git call. |
| `missing` | The clone does not exist or is not a git work tree. |
| `wrong_branch` | The branch identity rule above fails. |
| `dirty` | Tracked files are changed (untracked files are ignored). |
| `unreachable` | `git ls-remote origin refs/heads/<branch>` failed, timed out (10 s) or found no such branch. |
| `stale` | HEAD is not the origin tip just read: behind, ahead, diverged, or the tip is not fetched yet. |
| `fresh` | HEAD is exactly the origin tip just read. |
| `error` | Anything unexpected; `reason` has its first line. |

This is stricter than root injection: `fresh` needs the live origin tip, so between a push to the branch and the clone's next checkout the state is `stale`. `reason` is null only for `fresh`; `originHead` is set only when `ls-remote` succeeded; `fetchedAt` (mtime of `FETCH_HEAD`) is diagnostic only. The root file plays no part. Nothing here fetches or writes to the clone. Each call that probes logs `source.get <id>: probed, state <state>`, and every `config set` logs the change.

### Sync on demand

`source.get {projectId, sync: true}` (CLI `source --sync`) brings the clone up to the live origin tip first, when the project has `allowSync` true. It moves only a clean clone on its branch that is strictly behind: it fetches the branch, checks that origin did not move in between, re-checks HEAD, branch and cleanliness, then moves with `checkout --detach <tip>` or `merge --ff-only <tip>`, keeping the clone's form. A dirty clone, another branch, diverged history, a moved origin or any git failure leaves the clone where it is, and the answer is `stale` with the reason (`sync skipped: ...`, `sync aborted: ...`, `sync failed: ...`). `synced: {from, to}` is set when the call moved the clone, else null.

Bounds: one sync at a time per clone, at most one fetch per 10 s per clone, and one 50 s deadline per call that includes waiting for another sync. Every git process runs in its own process group; on timeout the whole group (git and any ssh, credential or remote helper it started) is killed, and a helper that keeps git's pipes open gets at most 1 s before they are dropped. Each step's timeout leaves room for that cleanup, so a call ends within its 50 s, cleanup included; a caller should allow at least 60 s. Every sync attempt logs one line with the old and new commit, or why it was skipped or failed.

Single writer: git's locks cover single operations, not the check-and-move sequence, so another process moving the same clone could race a sync. Stop any other updater before setting `allowSync` true.

## Limits

- The root and the skills are read on the machine where the bb server runs. Skills reach remote hosts as content, but the paths in the header and the notice only resolve on the server's machine.
- A running provider session keeps the instructions and skills it was built with; a change applies to the next thread or the next session start.
- Every thread, of any project, also gets the plugin's own short `project-instructions` skill.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Tests use a fake plugin host and temporary git repositories; they need `git` and no network.
