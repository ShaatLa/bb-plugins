Spawn Gate start contract v1 (implementation contract)

Command:
  bb agent-spawn-gate start [--project <projectId>] [--parent-thread <threadId>] [--dry-run] -- <builder args...>
Project and parent default to the invoking bb CLI context; explicit flags win. Both are required after resolution. Arguments after -- are passed to the configured builder verbatim as argv, never through a shell. No spawn flags are accepted after -- by the plugin: those are builder-specific arguments only.

RPC:
  plugin: agent-spawn-gate
  method: start
  input: {projectId:string, parentThreadId:string, args:string[], dryRun?:boolean}
The same start implementation serves CLI and RPC. The plugin validates the parent belongs to projectId before running the builder. This first start implementation requires the project's Script mode; existing Instruction mode and mint remain supported through their current contract.

Builder execution:
- Fetch the project's configured Git remote on EVERY start. Resolve its remote default branch. Use a clean plugin-owned checkout at that fetched commit; never use the caller's worktree or local branch. Fetch/authentication/checkout failure aborts, with no stale checkout fallback.
- The configured script is repository-relative, must stay within that checkout, and runs with cwd at the checkout root. .py scripts use python3; other scripts must be executable with an appropriate shebang.
- stdin: one JSON object {version:1,projectId,parentThreadId}. The plugin resolves the server-installed bb CLI, adds its directory to builder PATH, sets BB_CLI to its absolute path, and resolves/logs the actual python3 executable for .py builders. It also sets BB_PROJECT_ID and BB_THREAD_ID to these resolved IDs for builder bb read commands. No caller cwd is required.
- stdout: exactly one JSON object, UTF-8, maximum 1 MiB. All logs go to stderr. Exit nonzero, invalid JSON, unsupported version, unknown fields or invalid spawn values abort before mint/spawn.
- On nonzero exit, the last nonempty stderr line may be a JSON object with exactly one field, e.g. `{"reasonCode":"missing_required_sections"}`. Codes match `^[a-z][a-z0-9_]{0,39}$`. Use a fixed code per refusal reason and keep any variable details in preceding stderr lines. The report counts valid codes as `builder:<reasonCode>`, otherwise as `builder_error`. The caller still receives the failure diagnostic.
- No mint or bb thread spawn inside the builder.

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

Required: version=1, nonempty brief, spawn object, spawn.parentThreadId (must equal the request's resolved parent). Optional spawn fields: title, providerId, model, reasoningLevel, serviceTier, permissionMode (accept-edits|auto|full), parentNotifications (auto|stuck|off), environment. No arbitrary argv/flags/projectId/prompt/input/origin/token fields.

Environment is the bb SDK environment object, not a list of CLI flags:
- Omit: {type:"project-default"} is used.
- Reuse: {type:"reuse",environmentId:"env_..."}.
- New worktree: {type:"host",hostId?:"host_...",workspace:{type:"managed-worktree",baseBranch:{kind:"named",name:"main"}}}; baseBranch may instead be {kind:"default"}.
- Personal: {type:"host",hostId?:"host_...",workspace:{type:"personal"}}.
- Existing path: {type:"host",hostId?:"host_...",workspace:{type:"unmanaged",path:"/absolute/path"}}.
For non-personal host workspaces, an omitted hostId is resolved from the parent session’s environment, then the project’s default source host. If neither exists, start fails before minting. Explicit hostId is preserved. Dry-run returns the resolved hostId. Personal workspaces keep core’s existing default behavior.
Paths describe the selected execution host, not the builder checkout. The builder checkout is never used as the child workspace implicitly.

Plugin sequence: validate builder JSON -> mint exact brief for resolved project/parent -> spawn via bb SDK with returned prompt and whitelisted spawn fields. The plugin owns tokens, attribution, project binding and spawn invocation. It does not retry spawn automatically, to avoid duplicate children.

start result (CLI always prints this same JSON):
- Normal: {dryRun:false,threadId:string,projectId:string,parentThreadId:string,sourceCommit:string}.
- --dry-run: {dryRun:true,projectId:string,parentThreadId:string,sourceCommit:string,build:<validated builder stdout>}. Refreshes checkout and runs builder, but does NOT mint or create a thread.
Existing mint input/output remains unchanged: {projectId,parentThreadId,brief} -> {token,expiresAt,prompt}.
Enforcement is not changed by installation or start. Enable each project explicitly after its builder integration is ready.
