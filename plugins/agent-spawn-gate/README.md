# Agent Spawn Gate 0.5.0

Persistent per-project launch workflows for new agent sessions. The core
`message.dispatch` hook enforces a one-use admission before any provider runs.
Install entry, package directory and plugin ID: **agent-spawn-gate**.

## Settings

Open **Settings → Installed plugins → Agent Spawn Gate**. Select a project in
the dropdown. Every project offers the same settings:

- **Enable spawn gate:** require admission for new agent and CLI starts.
  Disabled by default for every project.
- **Launch method:** Script or Instruction.
- **Launch script:** repository-relative path, shown in Script mode.
- **Launch instructions:** steps agents must follow, shown in Instruction mode.
  Nonempty instructions are required to mint admissions in this mode.
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
Refusals also show the selected workflow. The plugin does not execute scripts
or verify that the agent followed the configured steps.

## Settings RPC

UI and CLI share the same schema-validated RPC and storage. The plugin does
not register native `bb plugin config` fields.

```sh
bb plugin rpc call agent-spawn-gate settings.read --json
bb plugin rpc call agent-spawn-gate settings.write --input-file settings.json --json
```

`settings.read` takes null and returns `{projects:[{id,name,values}]}`.
`settings.write` takes `{projectId,values}`, where values is a partial object
with `enabled`, `method` (`script|instruction`), `instruction`, `script`, and
`ttlMinutes`. It returns the saved project's complete values. Writes are
serialized to preserve simultaneous project updates.

Example settings.json (use an existing bb project ID):

```json
{"projectId":"proj_example","values":{"enabled":false,"method":"script","script":"tools/spawn.py"}}
```

## Mint RPC

After following the configured workflow, call:

```sh
bb plugin rpc call agent-spawn-gate mint --input-file request.json --json
```

Input: `{projectId,parentThreadId,brief}`. The parent must belong to the project;
the brief is nonempty plain task text, with no required card, role or marker.
A brief containing an `agent-admission ` line is rejected. Minting also works
while enforcement is disabled, allowing rollout checks before enabling it.

Output: `{token,expiresAt,prompt}`, with expiresAt in epoch milliseconds.
The returned prompt inserts `agent-admission v1 token=<64 hex characters>` as
its second line. Submit it verbatim:

```sh
bb thread spawn --project <projectId> --parent-thread <parentThreadId> --prompt-file <prompt.txt>
```

Admissions are cryptographically random, project/parent/brief scoped,
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
bb plugin reload agent-spawn-gate
```

Tests cover provider rejection, human exemptions, token binding/expiry/replay,
reload persistence, per-project workflows and settings, and autosave ordering
without replacing focused controls. See UPSTREAM.md for vendored UI provenance.
