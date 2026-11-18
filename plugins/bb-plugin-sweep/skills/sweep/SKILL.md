---
name: sweep
description: Inspect Sweep status, resolve the project manager, or run repository checks manually.
---
Use `bb sweep status --project <id> --json` for last run, exit code, deliveries, pending delivery, next run and errors. `bb sweep manager --project <id> --json` resolves the canonical manager. Plugins call Sweep RPC `manager` with `{projectId}`.
Set the Git remote URL in the bb project settings. Manage Sweep options in Settings → Plugins → Sweep or with `bb sweep config get [<key>] --project <id>` and `bb sweep config set <key> <value> --project <id>`. The keys are enabled, branch, script, args, manager, intervalMinutes (10), timeoutSeconds (300) and snapshots (false). `{manager}` in args resolves dynamically.
`bb sweep run --project <id> --dry-run` runs manually without delivery or acknowledgement. See README for the candidate snapshot protocol before enabling snapshots. Never disable a repository's prior automation until its manager confirms successful Sweep ticks.
