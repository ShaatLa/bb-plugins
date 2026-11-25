# Work Board builder

This Script-mode builder takes a task key and role. It assembles a brief from
the Work Board task and plan. The caller supplies no brief text.

Put the configuration on the BB server at
`$HOME/.bb/spawn-gate/work-board/<projectId>.json`. Keep it outside Git.
Replace the example identifiers and select provider/model pairs available in
your project. Each role uses the first eligible pair in its list. For local
builder tests, set `BB_SPAWN_GATE_WORK_BOARD_CONFIG` to a private fixture path.

```json
{
  "managerThreadId": "thr_manager",
  "owners": { "example": "thr_owner" },
  "roles": {
    "impl": [
      { "providerId": "codex", "model": "codex-model" },
      { "providerId": "claude-code", "model": "claude-model" }
    ],
    "review": [
      { "providerId": "claude-code", "model": "claude-model" },
      { "providerId": "codex", "model": "codex-model" }
    ],
    "check": [{ "providerId": "codex", "model": "codex-model" }],
    "plan-review": [
      { "providerId": "claude-code", "model": "claude-model" },
      { "providerId": "codex", "model": "codex-model" }
    ]
  }
}
```

Set `method` to `script` and `script` to
`plugins/spawn-gate/examples/work-board/build.py`. Leave `branch` blank when
using the remote default branch. Keep `enabled` false to try this workflow
without enforcing it on other launch paths.

```sh
bb agent-spawn-gate start --project proj_example --parent-thread thr_example --dry-run -- --card EXA-1 --role impl
```

The task must be open, its blockers must be Done, and its Work Board project
must be linked to the launch project. Add one line to the description such as
`Scope: plugins/example/`. For a plugin owner mapped to exactly one directory,
an omitted scope uses that directory. Only the mapped owner or manager can
launch for that scope.

- `impl` starts implementation in a worktree from the approved plan.
- `review` reviews code in a worktree. The implementation agent must post
  `Review range: <full BASE SHA>..<full HEAD SHA>` as its own comment. The
  reviewer uses a different provider. The latest matching agent comment wins.
- `check` runs the checks or captures in the approved plan.
- `plan-review` starts a reviewer on a different provider from the caller.
  Save the draft, launch the reviewer, and submit the plan to its thread ID.

Spawn Gate counts successful starts, dry-runs and builder refusals with
enforcement disabled. In this mode, project instructions must tell agents how
to use the card builder. Direct launches remain outside these metrics.
