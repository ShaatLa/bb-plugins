---
name: spawn-gate
description: Follow Spawn Gate project workflows and mint one-use child-start admissions.
---

When Spawn Gate is enabled, every new agent or CLI session needs an admission
for its project, parent thread and exact task brief. Follow the project's
configured workflow. Human top-level bb windows are exempt. A rejected start
can leave an idle thread to archive.

## Script mode

Use `start` to run the configured builder at the remote default branch, validate
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

When the builder supplies its role's eligible providers, the admission and
dry-run show their weekly pace and usage sources. If start refuses an ahead-of-
pace provider, choose the suggested eligible alternative or give an explicit
reason through the builder's request interface. A reason only waives the pace
check. The role's provider list still applies.

## Instruction mode and existing mint integrations

Follow the configured instructions first. If Instruction mode has empty
instructions, ask for project-specific launch instructions before starting.
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

Settings keys are `enabled`, `method`, `script`, `remote`, `instruction` and `ttlMinutes`
(1–60, default 10). A new project defaults to disabled. Config defaults to the
current project if the flag is omitted. Report defaults to all projects and
seven inclusive UTC days ending at `--to` (today if omitted).
An empty `remote` uses the project's Git remote. An explicit `remote` must be
an HTTPS or SSH Git address, for example `git@git.example.test:owner/builders.git`.
The `script` path is relative to that repository.
Use `bb plugin rpc inspect spawn-gate` for RPC shapes and descriptions.
