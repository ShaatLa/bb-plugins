---
name: spawn-gate
description: Follow Spawn Gate project workflows and mint one-use child-start admissions.
---

When Spawn Gate is enabled, every new agent or CLI session needs an admission
for its project, parent thread and exact task brief. Follow the project's
configured workflow. Human top-level bb windows are exempt. A rejected start
can leave an idle thread to archive.

## Script mode

Use `start` to run the configured builder at the selected branch, validate
its output, mint the admission and start the child. Put Spawn Gate flags before
the first `--` and builder arguments after it. Pass each project and parent
selector once. Omitted selectors use the invoking CLI context.

```sh
bb agent-spawn-gate start --project proj_example --parent-thread thr_example --dry-run -- --card EXA-1
```

`--dry-run` runs the builder without minting or spawning. A later real start
fetches and runs the builder again. The builder must only assemble the brief and
spawn parameters. It must never mint or spawn. Absolute builder input paths
must be readable on the bb server. See START-CONTRACT.md for builder arguments
and output, and RPC `start` with `{projectId,parentThreadId,args,dryRun?}`.

For a one-off machine choice, pass `--machine host_example` before `--`.
This overrides the optional per-project `machine` setting. Check `hostId`
in the dry-run or start result. The project source or reused workspace and
the provider must be ready on that machine. The builder and its inputs stay
on the bb server. Pass `--requires-heavy-lease` for a child that will need a
heavy Slots lease.

When the builder supplies its role's eligible providers, the admission and
dry-run show their weekly pace and usage sources. For Work Board roles with
multiple eligible providers, Spawn Gate switches an over-pace choice to the
first eligible alternative with confirmed room. See `providerPace.fallback`
for the decision. If start refuses, use the diagnostic to check quota or give an
explicit reason through the builder's request interface when supported.

## Instruction mode and existing mint integrations

Read and follow the current launch instructions first:

```sh
bb agent-spawn-gate instructions --project proj_example
```

When Project Instructions is enabled, `script` and `instructionFile` resolve
from the project's verified process clone. Start and mint request a
fast-forward if Project Instructions `allowSync` is enabled. Reading
`instructions` is read-only. For a stale clone with `allowSync` enabled, run
`bb project-instructions source --project proj_example --sync` before reading.
Otherwise wait for the updater or ask the project owner to repair the clone.
Save the mint request as `request.json`, using a parent in the target project
and a nonempty task brief without any `agent-admission ` line.

```json
{"projectId":"proj_example","parentThreadId":"thr_example","brief":"Review the proposed change."}
```

```sh
bb plugin rpc call spawn-gate mint --input-file request.json --json
bb thread spawn --project proj_example --parent-thread thr_example --prompt-file prompt.txt
```

Save the returned `prompt` verbatim to `prompt.txt` before running the second
command. Use a prompt once, before `expiresAt`. Mint again if the brief, project,
or parent changes, or the admission expires or was used. A token binds those
inputs. Compliance with the workflow remains the caller's responsibility.

## Settings and reports

Read or change one project field at a time. Use the configured workflow when
launching. A settings write changes project-wide policy for future starts.

```sh
bb agent-spawn-gate config get method --project proj_example
bb agent-spawn-gate config set ttlMinutes 15 --project proj_example
bb agent-spawn-gate report --project proj_example --from 2025-01-01 --to 2025-01-07 --events
```

Settings keys are `enabled`, `method`, `script`, `remote`, `branch`, `machine`, `instruction`, `instructionFile` and `ttlMinutes`
(1–60, default 10). A new project defaults to disabled. Config defaults to the
current project if the flag is omitted. Report defaults to all projects and
seven inclusive UTC days ending at `--to` (today if omitted).
An empty `remote` uses the project's Git remote. An explicit `remote` must be
an HTTPS or SSH Git address, for example `git@git.example.test:owner/builders.git`.
The `script` path is relative to that repository. Set `branch` to a short Git
branch name such as `tools/builders`. An empty `branch` uses the remote default.
The start result reports `sourceBranch` and `sourceCommit`.
Use `bb plugin rpc inspect spawn-gate` for RPC shapes and descriptions.
