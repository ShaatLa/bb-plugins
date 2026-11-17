# Sweep

Sweep refreshes a dedicated server-local checkout and runs a repository script on a per-project interval (default ten minutes). Checks stay in the repository. It sends nonzero results to the project manager and one heartbeat per hour on quiet runs. Python scripts run with python3; other scripts must be executable. Git, Python and BB CLI access must be available on the BB server machine. Checkout location is `<plugin-data>/checkouts/<projectId>`; it is disposable and cleaned before every run.

Set **BB CLI absolute path** to the installed `bb` executable if the server PATH does not include it. Sweep adds its directory to the script PATH and sets BB_CLI. Set **Script PATH** to the normal login PATH when tools such as gh are absent from the server environment. HOME and GitHub authentication variables are inherited without modification.

Settings → Plugins → Sweep provides a project picker and separate controls for manager, interval, repository, branch, script and arguments. Save project settings applies only to the selected project. Advanced check options hold the timeout and snapshot protocol; Execution environment holds the shared BB executable and one search directory per line. Existing CLI configuration remains compatible. Every project defaults disabled. The underlying configuration map can still be managed through CLI/RPC; example:

```json
{"proj_example":{"enabled":true,"remote":"https://github.com/example/repo.git","branch":"main","script":"checks/sweep.py","args":["--root","{manager}"],"manager":"thr_example","intervalMinutes":10,"timeoutSeconds":300,"snapshots":false}}
```

`{manager}` in arguments is resolved on each run. The manager must be a live, unarchived thread in the configured project. Other plugins should resolve it through RPC `manager` with `{projectId}`, returning `{manager: string|null}`. CLI: `bb sweep manager --project <id> --json`.

`bb sweep status --project <id> --json` shows configuration (including manager), lastRun, exitCode, delivered, deliveredAt, nextRun, error, alertError and pending message. Times are Unix milliseconds. tickId identifies the latest scheduled tick; deliveredTickId and deliveredTo identify the accepted message and recipient. A manager can be in another project when explicitly configured. A missing nextRun means the first enabled tick is due on the next minute boundary. Schedules run only while BB and Sweep are loaded; missed intervals coalesce into one tick.

`bb sweep run --project <id> [--dry-run]` refreshes and runs manually without telling, acknowledging or changing status. Scripts must obey the read-only snapshot protocol themselves; Sweep cannot prevent arbitrary repository code from changing external state.

RPC `configure` takes `{projectId,config}` and updates the same setting. RPC `status`, `manager`, `run` take `{projectId}`. Use `bb plugin rpc call sweep configure --input-file config.json --json`.

## Script acknowledgement protocol

Without `snapshots`, stdout and stderr plus exit code are sufficient: 0 quiet, 1 ACTION, 2 or higher failure. A crash, refresh error or timeout becomes exit 2 and is delivered to the manager. Unreachable/unset/archived managers leave durable pending deliveries and trigger the push-notifications plugin. Push failures appear as alertError in status.

With `snapshots:true`, Sweep adds `--committed-state <path> --candidate-snapshot <path>`. The committed file may not exist initially. The script reads it, prints **every item requiring acknowledgement**, and writes a complete replacement candidate file. It never writes committed state. Both paths are also available as BB_SWEEP_COMMITTED_STATE and BB_SWEEP_CANDIDATE_SNAPSHOT. Candidates on exit 0 or 1 are accepted; failure candidates are ignored. Every candidate is delivered with full output even on exit 0. Scripts should omit the candidate when nothing needs acknowledgement.

Sweep stores candidate bytes and the full message in one SQLite row before telling. It retries the pending message before running the next check and promotes the candidate in one database update only after successful tell. A crash between tell and acknowledgement may duplicate delivery; it cannot acknowledge an undelivered message. Changing manager redirects pending messages as well as new results. Manual runs never stage or acknowledge candidates.

## Integration follow-ups

Anvil: move its script path through configuration, add the protocol flags, migrate existing owner-answer state explicitly, and document Sweep as scheduler. Keep its automation until two good plugin ticks are observed; the Anvil manager owns disabling it.

Work Board schedules should resolve their target through Sweep manager RPC. Slots should resolve its observer through the same RPC. CI Dashboard should resolve its manager through it. Each integration needs explicit handling for missing Sweep or an unset manager. This release changes none of these plugins.

Install: `bb plugin install git:https://github.com/ShaatLa/bb-plugins.git@main --plugin sweep`.

Migration: RPC `seed-state` accepts `{projectId,snapshot}` where snapshot is the original committed JSON file contents as a string. Disable the project first. It refuses to overwrite committed state or a pending message, and refuses while a sweep is running. Committed bytes are stored in plugin SQLite; the script receives a fresh temporary read-only file on each run.
