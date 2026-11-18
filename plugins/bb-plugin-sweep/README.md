# Sweep

Sweep refreshes a dedicated server-local checkout and runs a repository script on a per-project interval (default ten minutes). Checks stay in the repository. It sends nonzero results to the project manager and one heartbeat per hour on quiet runs. Python scripts run with python3; other scripts must be executable. Git, Python and BB CLI access must be available on the BB server machine. Checkout location is `<plugin-data>/checkouts/<projectId>`; it is disposable and cleaned before every run.

Set **BB CLI absolute path** to the installed `bb` executable if the server PATH does not include it. Sweep adds its directory to the script PATH and sets BB_CLI. Set **Script PATH** to the normal login PATH when tools such as gh are absent from the server environment. HOME and GitHub authentication variables are inherited without modification.

Settings → Plugins → Sweep provides a project picker and separate controls for manager, interval, repository, branch, script and arguments. Valid edits are saved automatically only for the selected project, using the same SettingsSection, SettingsWithControl, Select and Switch components as bb. Advanced check options hold the timeout and snapshot protocol; Execution environment holds the shared BB executable and one search directory per line. Existing CLI configuration remains compatible. Every project defaults disabled. The underlying configuration map can still be managed through CLI/RPC; example:

```json
{"proj_example":{"enabled":true,"remote":"https://github.com/example/repo.git","branch":"main","script":"checks/sweep.py","args":["--root","{manager}"],"manager":"thr_example","intervalMinutes":10,"timeoutSeconds":300,"snapshots":false}}
```

`{manager}` in arguments is resolved on each run. The configured manager can be a live thread in another project. Other plugins should resolve it through RPC `manager` with `{projectId}`, returning `{manager: string|null}`. CLI: `bb sweep manager --project <id> --json`.

`bb sweep status --project <id> --json` shows configuration, the last run, the delivery receipt and any pending report. Times are Unix milliseconds. `tickId` identifies the latest scheduled tick. `deliveredTickId` and `deliveredTo` identify the accepted report and its destination, either the manager's thread ID or `answers`. For Answers deliveries, `deliveredNoticeId` identifies the card and `fallbackReason` records why the manager route failed. `managerError` records the last attempted manager delivery's error, and `alertError` shows push failures. A missing `nextRun` means the first enabled tick is due on the next minute boundary. Schedules run only while BB and Sweep are loaded. Missed intervals coalesce into one tick.

`bb sweep run --project <id> [--dry-run]` refreshes and runs manually without telling, acknowledging or changing status. Scripts must obey the read-only snapshot protocol themselves; Sweep cannot prevent arbitrary repository code from changing external state.

RPC `configure` takes `{projectId,config}` and updates the same setting. RPC `status`, `manager`, `run` take `{projectId}`. Use `bb plugin rpc call sweep configure --input-file config.json --json`.

## Script acknowledgement protocol

Without `snapshots`, stdout and stderr plus exit code are sufficient: 0 quiet, 1 ACTION, 2 or higher failure. A crash, refresh error or timeout becomes exit 2. When the manager is unavailable or the manager send fails, Sweep tries to send the full report as an informational card in the owner's Answers inbox via `answers.notice`. Answers is optional. If the plugin or RPC is unavailable, or the call fails, Sweep keeps the report pending for retry and sends a push alert.

Reports use BB Markdown. Lines starting with `ANSWER`, `ACTION`, `WAIT` or `STATE` are grouped into sections with Work Board links where a task key is available. Other output and failure diagnostics appear as plain text in a code block. If formatting exceeds the Answers size limit, Sweep sends the original full report. `pending` and `delivered` in status retain the original script report and tick ID.

With `snapshots:true`, Sweep adds `--committed-state <path> --candidate-snapshot <path>`. The committed file may not exist initially. The script reads it, prints **every item requiring acknowledgement**, and writes a complete replacement candidate file. It never writes committed state. Both paths are also available as BB_SWEEP_COMMITTED_STATE and BB_SWEEP_CANDIDATE_SNAPSHOT. Candidates on exit 0 or 1 are accepted; failure candidates are ignored. Every candidate is delivered with full output even on exit 0. Scripts should omit the candidate when nothing needs acknowledgement.

Sweep stores candidate bytes and the full report in one SQLite row before delivery. It retries the pending report before running the next check and promotes the candidate only after the manager accepts the message or Answers confirms the notice is durable. Answers deduplicates retries by tick ID. A crash between manager delivery and acknowledgement may duplicate that message. Changing manager redirects pending messages as well as new results. Manual runs never stage or acknowledge candidates.

## Integration follow-ups

Work Board schedules should resolve their target through Sweep manager RPC. Slots should resolve its observer through the same RPC. CI Dashboard should resolve its manager through it. Each integration needs explicit handling for missing Sweep or an unset manager. This release changes none of these plugins.

Install: `bb plugin install git:https://github.com/ShaatLa/bb-plugins.git@main --plugin sweep`.

Migration: RPC `seed-state` accepts `{projectId,snapshot}` where snapshot is the original committed JSON file contents as a string. Disable the project first. It refuses to overwrite committed state or a pending message, and refuses while a sweep is running. Committed bytes are stored in plugin SQLite; the script receives a fresh temporary read-only file on each run.
