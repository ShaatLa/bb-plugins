# Sweep

Sweep refreshes a dedicated server-local checkout and runs a repository script on a per-project interval (default ten minutes). Checks stay in the repository. It sends nonzero results to the project manager and one heartbeat per hour on quiet runs. Python scripts run with python3; other scripts must be executable. Git, Python and BB CLI access must be available on the BB server machine. Checkout location is `<plugin-data>/checkouts/<projectId>`; it is disposable and cleaned before every run.

Set **BB CLI absolute path** to the installed `bb` executable if the server PATH does not include it. Sweep adds its directory to the script PATH and sets BB_CLI. Set **Script PATH** to the normal login PATH when tools such as gh are absent from the server environment. HOME and GitHub authentication variables are inherited without modification.

Set the Git remote URL in the bb project's settings. Sweep reads it each time it refreshes the checkout. Settings → Plugins → Sweep lets you pick a project and set its manager, interval, branch, script and arguments. Valid edits are saved automatically for the selected project. Advanced check options hold the timeout and snapshot protocol. Execution environment holds the shared BB executable and one search directory per line. Every project defaults to disabled.

```json
{"proj_example":{"enabled":true,"branch":"main","script":"checks/sweep.py","args":["--root","{manager}"],"manager":"thr_example","intervalMinutes":10,"timeoutSeconds":300,"snapshots":false}}
```

`{manager}` in arguments is resolved on each run. The configured manager can be a live thread in another project. Other plugins should resolve it through RPC `manager` with `{projectId}`, returning `{manager: string|null}`. CLI: `bb sweep manager --project <id> --json`.

`bb sweep status --project <id> --json` shows configuration, the last run, the delivery receipt and any pending report. Times are Unix milliseconds. `tickId` identifies the latest scheduled tick. `deliveredTickId` and `deliveredTo` identify the accepted report and its destination: the manager's thread ID, `agent-hub`, or `answers`. For notice deliveries, `deliveredNoticeId` identifies the card and `fallbackReason` records why the manager route failed. `managerError` records the last attempted manager delivery's error, and `alertError` shows push failures. A missing `nextRun` means the first enabled tick is due on the next minute boundary. Schedules run only while BB and Sweep are loaded. Missed intervals coalesce into one tick.

`bb sweep run --project <id> [--dry-run]` refreshes and runs manually without telling, acknowledging or changing status. Scripts must obey the read-only snapshot protocol themselves; Sweep cannot prevent arbitrary repository code from changing external state.

RPC `configure` takes `{projectId,config}` and updates the same setting. Sweep ignores the legacy `remote` field in saved configurations and in `configure` requests. RPC `status`, `manager`, `run` take `{projectId}`. Use `bb plugin rpc call sweep configure --input-file config.json --json`.

For single-field access, use `bb sweep config get [<key>] --project <id>` and `bb sweep config set <key> <value> --project <id>`. Pass string values as shell arguments and arrays as JSON, for example `bb sweep config set args '["--brief"]' --project proj_example`. The equivalent RPCs are `config.get {projectId,key?}` and `config.set {projectId,key,value}`. With a key, they return that field only. To configure a new project this way, set `branch` and `script` before enabling it. The native global fields `bbCli` and `runtimePath` can be managed through `bb plugin config sweep`.

## Script acknowledgement protocol

Without `snapshots`, stdout and stderr plus exit code are sufficient: 0 quiet, 1 ACTION, 2 or higher failure. A crash, refresh error or timeout becomes exit 2. When the manager is unavailable or the manager send fails, Sweep tries to send the full report as an informational card in the owner's Answers inbox via `answers.notice`. Answers is optional. If the plugin or RPC is unavailable, or the call fails, Sweep keeps the report pending for retry and sends a push alert.

Reports use BB Markdown. Lines starting with `ANSWER`, `ACTION`, `WAIT` or `STATE` are grouped into sections with Work Board links where a task key is available. Other output and failure diagnostics appear as plain text in a code block. If formatting exceeds the Answers size limit, Sweep sends the original full report. `pending` and `delivered` in status retain the original script report and tick ID.

With `snapshots:true`, Sweep adds `--committed-state <path> --candidate-snapshot <path>`. The committed file may not exist initially. The script reads it, prints **every item requiring acknowledgement**, and writes a complete replacement candidate file. It never writes committed state. Both paths are also available as BB_SWEEP_COMMITTED_STATE and BB_SWEEP_CANDIDATE_SNAPSHOT. Candidates on exit 0 or 1 are accepted. Sweep delivers any candidate that changes committed state with full output even on exit 0. Failure candidates are ignored. Scripts should omit the candidate when nothing needs acknowledgement.

Sweep stores candidate bytes and the full report in one SQLite row before delivery. It retries the pending report before running the next check and promotes the candidate only after the manager accepts the message or the notice plugin confirms durable delivery. Sweep prefers enabled Agent Hub and uses enabled Answers on installations with the legacy plugin. Notice retries use the same tick ID. If no notice plugin is enabled or the selected RPC fails, Sweep keeps the report pending and attempts a push alert. A crash between manager delivery and acknowledgement may duplicate that message. Changing manager redirects pending messages as well as new results. Manual runs never stage or acknowledge candidates.

For new reports, Sweep compares the exit code and substantive output with the last confirmed report. Standard summary counts, structured item order and `idle` or `failed` age counters on action lines do not affect the comparison. Sweep delivers a changed report immediately and sends unchanged reports as reminders at most once an hour. Snapshot candidates that change committed state always require delivery. Consecutive checkout refresh failures double the check interval up to an hour, or the configured interval if it is longer. A successful refresh resets the delay. Pending delivery retries keep the configured interval.

## Stats

Open **Sweep** from the bb navigation rail. Use the controls above the statistics to pick a project or change its notification session. Selecting a session saves the project's manager field immediately. The statistics cover checks, deliveries, new items and failures for the last 24 hours, 7 days or 30 days. The dashboard updates after scheduled runs and when Sweep project settings change.

`bb sweep stats --project <id> --days <1-30>` (default one day) and the `stats {projectId,days?}` RPC report scheduled ticks, executed checks, confirmed deliveries by channel, new distinct items by kind, repeated item sightings, suppressed reports, queued reminders and failures by stage. The `answers` counter includes notices delivered to either plugin. New items are fingerprints first seen within the requested window. Sweep keeps counters and fingerprints locally for a rolling 30 days. Manual runs do not enter these totals.

## Integration follow-ups

Work Board schedules should resolve their target through Sweep manager RPC. Slots should resolve its observer through the same RPC. CI Dashboard should resolve its manager through it. Each integration needs explicit handling for missing Sweep or an unset manager. This release changes none of these plugins.

Install: `bb plugin install git:https://github.com/ShaatLa/bb-plugins.git@main --plugin sweep`.

Migration: RPC `seed-state` accepts `{projectId,snapshot}` where snapshot is the original committed JSON file contents as a string. Disable the project first. It refuses to overwrite committed state or a pending message, and refuses while a sweep is running. Committed bytes are stored in plugin SQLite; the script receives a fresh temporary read-only file on each run.
