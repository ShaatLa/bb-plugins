# Spawn Gate

Persistent per-project launch workflows for new agent sessions. The core
`message.dispatch` hook enforces a one-use admission before any provider runs.
Install entry, package directory and plugin ID: **spawn-gate**. The CLI remains `bb agent-spawn-gate`.

## Upgrade from agent-spawn-gate

Pause new launches and disable `agent-spawn-gate` before installing
`spawn-gate`. On first load it copies the legacy database and project settings.
Check the enabled projects, the activity report and a builder dry run before
resuming launches. Keep the legacy installation disabled until the checks pass.
If a check fails, disable `spawn-gate` and re-enable `agent-spawn-gate` before
resuming launches. The migration leaves the legacy files and settings in place.

## Settings

Open **Settings → Installed plugins → Spawn Gate**. Select a project in
the dropdown. Every project offers the same settings:

- **Enable spawn gate:** require admission for new agent and CLI starts.
  Disabled by default for every project.
- **Launch method:** Script or Instruction.
- **Builder repository:** optional HTTPS or SSH Git remote, shown in Script mode.
  Leave it blank to use the project's Git remote. Use the BB server's existing
  Git authentication.
- **Builder branch:** optional Git branch name in the selected repository.
  Leave it blank to use that remote's default branch.
- **Execution machine:** optional machine ID or name for child sessions.
  Leave it blank to keep normal placement.
- **Launch script:** repository-relative path, shown in Script mode.
- **Launch instruction file:** clone-relative path in Instruction mode when
  Project Instructions is enabled.
- **Launch instructions:** typed text for Instruction mode in other projects.
- **Admission lifetime:** 1–60 minutes to use a newly minted token. It does not
  limit the session's duration.

Valid edits save automatically, in order, without disabling or remounting the
controls. Invalid fields remain editable until corrected. Errors are shown in
place. Settings persist in plugin KV storage independently per project.
New projects appear when the settings page loads, without reloading the plugin.
The UI uses bb's SettingsSection layout and official version-pinned controls;
there is no custom stylesheet.

The selected workflow and mint procedure are contributed to agents when their
provider sessions are next constructed. Existing sessions are not hot-rewritten.
Refusals also show how to use the selected workflow. In Script mode, start
executes the configured builder from the selected source. In Instruction mode,
read the current text with `bb agent-spawn-gate instructions` before minting.

## Shared project process source

When Project Instructions is enabled for the project, Spawn Gate resolves its
server-local process clone through `source.get`. In Script mode, set `script`
relative to that clone. In Instruction mode, set `instructionFile` relative to
the clone. For example:

```sh
bb agent-spawn-gate config set instructionFile docs/launch.md --project proj_example
bb agent-spawn-gate instructions --project proj_example
```

Spawn Gate uses the exact commit verified by Project Instructions. Start
(including dry-run) and mint request on-demand sync. With Project Instructions
`allowSync` enabled, it can fast-forward a clean clone that is behind origin.
Stop the clone's external updater before enabling `allowSync`. While it is off,
keep the existing updater running. The gate refuses stale, missing, wrong-branch,
dirty or unverifiable enabled clones. The `instructions` command reads only. To
refresh a stale Instruction source on demand when `allowSync` is enabled, run
`bb project-instructions source --project proj_example --sync` before reading it.
A disabled or unconfigured project continues using its existing `remote` and
`branch` or its typed `instruction`.

## Settings RPC

UI and CLI share the same schema-validated RPC and storage. Run
`bb plugin rpc inspect spawn-gate` for the RPC descriptions and schemas.
Use one field per call for agent settings changes. The whole-object RPCs below
remain available for existing clients. Settings changes apply to all future
starts in the selected project.

```sh
bb plugin rpc call spawn-gate settings.read --json
bb plugin rpc call spawn-gate settings.write --input-file settings.json --json
```

`settings.read` takes null and returns `{projects:[{id,name,values}]}`.
`settings.write` takes `{projectId,values}`, where values is a partial object
with `enabled`, `method` (`script|instruction`), `instruction`, `script`,
`remote`, `branch`, `machine`, and
`ttlMinutes`. It returns the saved project's complete values. Writes are
serialized to preserve simultaneous project updates.

Example settings.json (use an existing bb project ID):

```json
{"projectId":"proj_example","values":{"enabled":false,"method":"script","script":"tools/spawn.py"}}
```

For one project or field:

```sh
bb agent-spawn-gate config get --project proj_example
bb agent-spawn-gate config get enabled --project proj_example
bb agent-spawn-gate config set ttlMinutes 15 --project proj_example
bb agent-spawn-gate config set remote git@git.example.test:owner/builders.git --project proj_example
bb agent-spawn-gate config set branch tools/builders --project proj_example
bb agent-spawn-gate config set machine host_example --project proj_example
```

RPC `config.get` takes `{projectId,key?}`. RPC `config.set` takes
`{projectId,key,value}`. Calls with a key return just that field, e.g.
`{"ttlMinutes":15}`. A get without a key returns that project's settings.
The CLI accepts `true` or `false` for `enabled`, and an integer from 1 to 60
for `ttlMinutes`. If omitted, `--project` defaults to the CLI context.
Set `remote` to an empty string (`''` in the shell) to restore the project's Git remote.
Set `branch` to an empty string to restore the remote's default branch.
Set `machine` to an empty string to restore normal placement.

## Start command and RPC

```sh
bb agent-spawn-gate start --project <projectId> --parent-thread <threadId> -- <builder args...>
bb agent-spawn-gate start --project <projectId> --parent-thread <threadId> --dry-run -- <builder args...>
```

Project and parent default to the invoking CLI context. Pass each selector once.
Put Spawn Gate flags before the first `--` and builder arguments after it:

```sh
bb agent-spawn-gate start --project proj_example --parent-thread thr_example --dry-run -- --card EXA-1
```

A misplaced `--dry-run` among builder options is rejected. A later real start
fetches and runs the builder again. The plugin owns a clean checkout under its
data directory. It fetches the selected Git branch, runs the configured JSON
builder there, validates its output, mints the exact brief and starts the child
via bb SDK. No stale
checkout fallback; no automatic spawn retry. This command currently requires
Script mode. Instruction mode keeps the mint workflow below.

RPC `start` input: `{projectId,parentThreadId,args:string[],dryRun?,machine?,requiresHeavyLease?}`.
The CLI and RPC return the same JSON. Dry-run runs the builder without minting
or spawning. See [START-CONTRACT.md](START-CONTRACT.md) for builder stdin/stdout,
allowed spawn fields and result shapes. The [Work Board builder example](examples/work-board/README.md)
includes the manager's `spawn_gate_owner` tool for audited owner assignments.
Builders run on the bb server machine;
absolute path arguments must be accessible there. The plugin puts the server's
bb CLI on builder PATH and sets its absolute BB_CLI. Python builders use the
server PATH's python3; both resolved paths are recorded in plugin logs. Child environment paths
refer to the selected execution host. A non-personal host workspace without
hostId uses the parent session's host, then the project default source host.
Missing host routing fails before minting; dry-run shows the resolved hostId. Each subprocess has a 60-second timeout
and a combined 1 MiB stdout/stderr limit. Starts serialize per project.

The builder is trusted repository code: it must only build the brief and spawn
parameters. It must not mint or spawn children itself.

### Execution machine

Pass `--machine <id-or-name>` before `--` to select a machine for one
launch. It takes precedence over the project's `machine` setting. Opted-in
results include `hostId`, including in dry-run. Capacity and queuing are
handled by bb on that machine.

For project checkout and managed worktree launches, set up a project source
checkout on that machine. For reuse, select a ready environment in the same
project and on the selected machine. An explicit unmanaged path must exist on
that machine. Install the provider CLI and sign in there, or enable supported
pooled credentials. The builder must supply `spawn.providerId`.

Declare heavy work with `--requires-heavy-lease` or
`requiresHeavyLease: true` in the builder output. Spawn Gate refuses an
opted-in start when Slots cannot provide heavy leases on that machine.
The child acquires its own lease.

The builder still runs on the bb server, which must be able to read its input
files. The selected execution host is available to the builder as
`BB_SPAWN_HOST_ID`.

## Weekly provider pace

A role-aware Script builder supplies `providerPolicy` in its v1 output. The
policy lists the providers eligible for the requested role and, optionally, an
explicit reason supplied by the caller. Spawn Gate enforces the list, reads the
weekly windows from the providers' usage RPCs on the target host, and records
each provider's pace and source in the admitted brief and `start` result.
Antigravity uses the weekly pool for the candidate's model.

Pace is the share used divided by the share of the window elapsed at the
measurement. If the selected provider is at or above the threshold and an
eligible alternative is below 1.0 with quota remaining, start refuses before
minting. Choose the suggested provider or give a reason through the builder's
request interface. A reason only overrides the pace refusal. Unknown, stale,
expired or exhausted readings cannot establish room. The same check runs
during dry-run.

When Account Pooler routes Codex or Claude Code, Spawn Gate uses the lowest
measured weekly pace among available accounts with room, or the lowest known
pace among the remaining available accounts. It excludes unavailable accounts
and accounts whose quota for the requested model is exhausted. This describes
available pool capacity. Account Pooler chooses the session's actual account.

The default threshold is 1.25. Read or change the native setting:

```sh
bb plugin config spawn-gate
bb plugin config spawn-gate set paceThreshold 1.4
bb plugin config spawn-gate unset paceThreshold
```

See [START-CONTRACT.md](START-CONTRACT.md) for an example builder payload.
Builders without `providerPolicy` and the legacy `mint` RPC lack role
eligibility data and keep their existing behavior.

## Activity report

Open **Spawn Gate** in the bb sidebar to filter activity by project and period,
view refusal reasons, and edit the selected project’s launch settings.

```sh
bb agent-spawn-gate report --project proj_example --from 2025-01-01 --to 2025-01-07
```

RPC `report` takes `{projectId?,from?,to?,events?}`. Both return JSON. Dates are
inclusive UTC dates. The default window is seven days ending at `--to`
(today if omitted). Omit the
project to report all projects. Each row counts successful Script-mode
`start` calls, successful dry-runs, blocked admission dispatches and
refusals by operation and reason. A successful start means bb accepted the
spawn request. Legacy `mint` calls do not enter the start totals.
A rejected spawn can appear in both the start and dispatch counts.

The report includes `coverageStartedAt`. Counts start on first load of a
version with metrics. Counters persist across reloads and contain only dates,
project IDs, operations, reason codes and counts. Builder-defined refusals
appear as `builder:<reasonCode>`. See [START-CONTRACT.md](START-CONTRACT.md).

Pass `--events` or RPC `events: true` to also list individual refusals in the
same window, newest first. Events include timestamp, project, operation,
reason, parent thread, card, builder source commit and a structured stderr
diagnostic when available. Events and totals have no automatic expiry.
Earlier counts are preserved without reconstructing missing events.

## Mint RPC

After following the configured workflow, call:

```sh
bb plugin rpc call spawn-gate mint --input-file request.json --json
```

Input: `{projectId,parentThreadId,brief}`. The parent must belong to the project.
Provide a nonempty plain task brief, for example:

```json
{"projectId":"proj_example","parentThreadId":"thr_example","brief":"Review the proposed change."}
```

A brief containing an `agent-admission ` line is rejected. Remove the line before minting. Minting also works
while enforcement is disabled, allowing rollout checks before enabling it.

Output: `{token,expiresAt,prompt}`, with expiresAt in epoch milliseconds.
The returned prompt inserts `agent-admission v1 token=<64 hex characters>` as
its second line. Submit it verbatim:

```sh
bb thread spawn --project proj_example --parent-thread thr_example --prompt-file prompt.txt
```

Mint again if the project, parent or brief changes, or the admission expires
or was used. Admissions are cryptographically random, project/parent/brief scoped,
time-limited and single-use. SQLite stores token and brief hashes. Exact
prompt binding, expiry and token consumption are checked transactionally.
Consumed admissions and settings survive reloads. Each admitted session's
follow-up messages remain unrestricted.

## Policy and limits

For an enabled project, all new agent and CLI starts require admission,
including CLI starts without a parent. bb currently attributes agent shell
starts as user/no-sender, so CLI origin cannot receive the human exemption.
Human top-level starts from bb windows are exempt. Existing provider sessions
are grandfathered using their `thread/started` event.

The hook rejects dispatch before provider execution across providers. Thread
creation itself is unhooked: a rejected start can leave an idle row to archive.

Tokens prove admission for the exact brief, not execution of a trusted script.
An RPC-capable agent can mint directly. Strong script attestation needs a
protected credential or trusted caller identity from core. A caller able to
forge core UI-origin metadata can also impersonate an exempt window start.
The plugin must be installed and enabled; safe mode unloads third-party gates.

## Development

```sh
npm ci
npm run typecheck
npm test
bb plugin build .
bb plugin reload spawn-gate
```

Tests cover provider rejection, human exemptions, token binding/expiry/replay,
reload persistence, per-project workflows and settings, and autosave ordering
without replacing focused controls. See UPSTREAM.md for vendored UI provenance.
