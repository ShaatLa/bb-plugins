Spawn Gate start contract v1 (implementation contract)

Command:
  bb agent-spawn-gate start [--project <projectId>] [--parent-thread <threadId>] [--dry-run] -- <builder args...>
Project and parent default to the invoking bb CLI context. Both are required after resolution. Pass each selector once. Put --dry-run before the first --, e.g. `bb agent-spawn-gate start --project proj_example --parent-thread thr_example --dry-run -- --card EXA-1`. The CLI rejects --dry-run in builder options. Other arguments after the first -- are passed to the builder verbatim as argv, without a shell.

RPC:
  plugin: spawn-gate
  method: start
  input: {projectId:string, parentThreadId:string, args:string[], dryRun?:boolean}
The same start implementation serves CLI and RPC. The plugin validates the parent belongs to projectId before running the builder. This first start implementation requires the project's Script mode; existing Instruction mode and mint remain supported through their current contract.

Builder execution:

- Start and mint call Project Instructions `source.get` with `sync: true` and
  a 60-second deadline. Project Instructions can fast-forward a clean, behind
  clone only if its project setting `allowSync` is enabled. The `instructions`
  command calls the read-only RPC path. A start dry-run may update the shared
  clone when sync is enabled. It still creates no admission or child thread.
- With a fresh shared source, Spawn Gate fetches the reported commit from the
  local clone into its private checkout. The configured `script` resolves inside
  that pinned checkout. The separate Spawn Gate remote and branch apply to
  projects without an enabled shared source.
- On every start, fetch `branch` from the configured builder `remote` at depth 1. A blank `remote` uses the project's Git remote. A blank `branch` uses the selected remote's default branch. Run the repository-relative `script` in a clean plugin-owned checkout at that commit. Fetch, authentication and checkout failures abort. `sourceBranch` and `sourceCommit` identify the fetched builder branch and commit.
- The configured script is repository-relative, must stay within that checkout, and runs with cwd at the checkout root. .py scripts use python3; other scripts must be executable with an appropriate shebang.
- stdin: one JSON object {version:1,projectId,parentThreadId}. The plugin resolves the server-installed bb CLI, adds its directory to builder PATH, sets BB_CLI to its absolute path, and resolves/logs the actual python3 executable for .py builders. It also sets BB_PROJECT_ID and BB_THREAD_ID to these resolved IDs for builder bb read commands. No caller cwd is required.
- Servers supporting ordered provider fallback set `BB_SPAWN_GATE_ORDERED_FALLBACK=1`. Builders intended to run against older servers should emit the new policy fields only when this variable is set.
- stdout: exactly one JSON object, UTF-8. The combined stdout/stderr limit is 1 MiB. All logs go to stderr. Exit nonzero, invalid JSON, unsupported version, unknown fields or invalid spawn values abort before mint/spawn.
- On nonzero exit, write a JSON object with exactly one field on the first stderr line, e.g. `{"reasonCode":"missing_required_sections"}`. Codes match `^[a-z][a-z0-9_]{0,39}$`. Use a fixed code per refusal reason and write human-readable details on following lines. For compatibility, Spawn Gate checks the last nonempty line if the first has no valid code. The report counts valid codes as `builder:<reasonCode>` and uncoded failures as `builder_error`. The caller still receives the failure diagnostic.
- For the refusal journal, the first stderr line may use the same bounded JSON format, even when the builder exits zero. The journal stores only that structured diagnostic. It saves a card reference only when builder arguments contain a valid task key in `--card EXA-1` or `--card=EXA-1`. It discards raw stderr, arguments, stdout and briefs.
- No mint or bb thread spawn inside the builder.

The [Work Board builder example](examples/work-board/README.md) documents the
native `spawn_gate_owner` tool. It updates the example's server-local owner
assignments outside the builder's stdin/stdout contract.

Builder stdout (strict object; omit optional fields, do not emit null):
{
  "version": 1,
  "brief": "Complete child task, verbatim; any repository-specific first line is ordinary text",
  "spawn": {
    "title": "Task title",
    "providerId": "codex",
    "model": "<catalog model ID>",
    "reasoningLevel": "high",
    "parentThreadId": "thr_example",
    "parentNotifications": "auto",
    "environment": {"type":"host","workspace":{"type":"managed-worktree","baseBranch":{"kind":"named","name":"main"}}}
  }
}

Required: version=1, nonempty plain brief without an `agent-admission ` line, spawn object, spawn.parentThreadId (must equal the request's resolved parent). Optional spawn fields: title, providerId, model, reasoningLevel, serviceTier, permissionMode (accept-edits|auto|full), parentNotifications (auto|stuck|off), environment. No arbitrary argv/flags/projectId/prompt/input/origin/token fields.

Optional builder output field for role-aware provider admission:

```json
{
  "providerPolicy": {
    "eligible": [
      {"providerId":"codex"},
      {"providerId":"claude-code"},
      {"providerId":"antigravity","model":"gemini-4-argon"}
    ],
    "reason":"This task must use the same provider as the preceding review."
  }
}
```

- Include each provider eligible for this role and tier once, up to 16 entries.
  Use the repository's role policy to build this list. Never derive it from a
  caller-supplied allowlist. Set `spawn.providerId` to one of the entries.
- Use the optional candidate `model` for alternatives with model-specific
  windows. The selected provider is measured using `spawn.model`. For
  Antigravity the default is the shared Gemini pool, and an Argon model uses
  the separate Argon pool.
- Set `reason` only when the caller gave an explicit reason. Omit it otherwise.
  An empty or whitespace-only reason does not waive a refusal. Neither a
  reason nor any pace result can open a provider excluded by the role.
- When installed, Tokenomos `limits.get` v1 supplies fresh applicable pace,
  forecast and room for the launch host. Unknown pace cannot trigger a
  refusal, and unknown room cannot establish an alternate. Missing or stale
  observations use the checks below. Provider rows retain the concrete
  `source`, name its category in `sourceKind`, and may include
  `forecastPercent` and `forecast`.
- Spawn Gate reads `provider-usage.v1.listResources` and `getResource` from
  each eligible provider's usage plugin for the target host. It compares the
  highest pace among applicable weekly windows, observed within the last hour
  with a current reset. Before 4% of a weekly window has elapsed at the
  observation time, the reported pace is null and a fresh reading has room
  only when more than 96% of the quota remains. After that point, room means
  pace below 1.0 with quota remaining. All applicable windows must have room.
- For Codex and Claude Code routed through Account Pooler, Spawn Gate reads
  `account-pool`'s `status.get` instead. It scores each ready account using
  its applicable weekly windows and excludes accounts with a blocked or
  exhausted applicable window. It reports the lowest pace with confirmed room,
  falling back to the lowest known pace among available accounts. Provider
  pace describes pool capacity. Account Pooler selects the session account.
- The native `paceThreshold` setting defaults to 1.25 and accepts a ratio of
  at least 1.0. Without opt-in the selected provider reaching it causes a
  refusal when an eligible alternative has room.
- Set `orderedFallback: true` to use the first alternative with room in
  `eligible` order when the selected provider reaches the threshold. This
  applies to lists with at least two providers. If no candidate has room,
  refuse. The replacement uses its own optional `model` and `reasoningLevel`
  and the provider's default service tier. A nonblank `reason` keeps the
  originally selected provider. Pace refusals are tracked as `over_pace`.
- Set `pinned: true` for an explicit provider pin. The spawn must match the
  eligible entry's provider and model. The gate keeps that provider and
  requires a nonblank `reason` when its known pace reaches the threshold,
  including for single-provider lists. Successful pinned overrides expose
  `providerPace.override` and include the reason in the admission brief and
  `report --events` under `overrides`.
- A successful result includes `providerPace: {threshold,overridden,providers}`
  when the builder supplied the policy. Provider rows identify the source,
  window, percentage used, elapsed share and pace. Missing values are null.
  The admitted brief and the dry-run's brief include a Provider pace section.
  On a switch, that section names both providers and the pace threshold.
  `providerPace.fallback` carries the same decision as structured data.
  `report --events` exposes successful switches in the `fallbacks` list.
- Builders omitting `providerPolicy` retain v1 behavior. The legacy mint
  payload has no provider choice or eligible set.

Environment is the bb SDK environment object, not a list of CLI flags:
- Omit: {type:"project-default"} is used.
- Reuse: {type:"reuse",environmentId:"env_..."}.
- New worktree: {type:"host",hostId?:"host_...",workspace:{type:"managed-worktree",baseBranch:{kind:"named",name:"main"}}}; baseBranch may instead be {kind:"default"}.
- Personal: {type:"host",hostId?:"host_...",workspace:{type:"personal"}}.
- Existing path: {type:"host",hostId?:"host_...",workspace:{type:"unmanaged",path:"/absolute/path"}}.
For non-personal host workspaces, an omitted hostId is resolved from the parent session’s environment, then the project’s default source host. If neither exists, start fails before minting. Explicit hostId is preserved. Dry-run returns the resolved hostId. Personal workspaces keep core’s existing default behavior.

An explicit `--machine <id-or-name>` or RPC `machine` overrides the project's
`machine` setting. With a selected machine, project-default uses its project
checkout (or a personal workspace for the personal project). A requested
worktree retains its base branch and needs a Git source on that machine.
Reuse must refer to a ready environment in the same project on that machine.
An explicit `hostId` must agree with the selected machine. The builder must
set `spawn.providerId` so Spawn Gate can check provider readiness there.

The builder still runs on the bb server with the existing JSON v1 input and
environment, plus `BB_SPAWN_HOST_ID` when a machine was selected. Declare a
heavy Slots requirement by passing `--requires-heavy-lease`, setting RPC
`requiresHeavyLease: true`, or emitting optional top-level
`requiresHeavyLease: true` in builder output. Spawn Gate checks host support
before minting. The child requests its own lease.
Paths describe the selected execution host, not the builder checkout. The builder checkout is never used as the child workspace implicitly.

Plugin sequence: validate builder JSON -> mint exact brief for resolved project/parent -> spawn via bb SDK with returned prompt and whitelisted spawn fields. The plugin owns tokens, attribution, project binding and spawn invocation. It does not retry spawn automatically, to avoid duplicate children.

start result (CLI always prints this same JSON):
- Normal: {dryRun:false,threadId:string,projectId:string,parentThreadId:string,sourceBranch:string,sourceCommit:string}.
- --dry-run: {dryRun:true,projectId:string,parentThreadId:string,sourceBranch:string,sourceCommit:string,build:<validated builder stdout>}. Refreshes checkout and runs the builder without minting or creating a thread. A later launch fetches and runs the builder again.
- Both results include `hostId` when the request or project setting selected an execution machine.
Existing mint input/output remains unchanged: {projectId,parentThreadId,brief} -> {token,expiresAt,prompt}.
Enforcement is not changed by installation or start. Enable each project explicitly after its builder integration is ready.
