---
name: slots
description: "Request local resource leases for full test suites, race-detector or fuzz runs, database or service containers, headless-browser jobs, large builds, or local LLM inference."
---

Small or focused runs — a single package's unit tests, typecheck, lint, a quick
build — that finish in a minute or two on a few cores do not need a slot.
Request one for work that saturates many cores or lots of memory for several minutes.

Run heavy work through the foreground wrapper:

```sh
sh -c "$(bb slots wrapper)" slots-run --est 20m --job "..." -- <command>
```

Use `--pool local-model` for LLM inference. A holder may reuse its lease for
nested, sequential or concurrent runs without another gate check. Signal the
process group to cancel. `bb slots request --wait` timeout exits 75 and keeps
the request queued until canceled or the thread ends; rerun the same command
to keep waiting. `acquire` / `slots-run` timeout exits 75 and keeps its queue
position for one heartbeat interval (10 minutes by default); rerun within that
time.
For scripts, `bb slots acquire` returns a use ID; renew with `bb slots heartbeat
--use <id>` and finish with `bb slots done <id>`. Manual request, heartbeat and
release remain available.

The wrapper never calls done before its foreground command exits. Renewal loss
may let the use expire while the command still runs. To cancel, signal the
process group; signals to the wrapper PID alone are not forwarded. Grandchildren
that outlive the command are not covered. Process identity checks are approximate
and PID reuse is not excluded. If the renewal supervisor is stuck during cleanup,
an in-flight heartbeat may outlive it until that heartbeat returns.

On an expiry warning, run `bb slots heartbeat` if still working. Release promptly
with `bb slots release [lease-or-request]`; a granted request ID releases its lease; no ID also cancels queued requests.
Use `bb slots port` for dev servers. Transfer to a QA child with
`bb slots transfer --to <thread> [--lease <id>]`; child release returns the lease.

Manager commands: `prioritize <req> --priority high|urgent|normal`,
`revoke <lease> --reason "..."`, `grant <req>` (no force),
`capacity --pool heavy 4`. Inspect `status` and `log --since 2h --limit 100`.
Manager commands are unrestricted. V1 supports only the BB server host.

On start, a manager session runs `bb slots observer --self`.

Configuration: `bb slots config` shows effective values. Use
`bb slots config set <key> <value>` and `bb slots config unset <key>` (reset to
the current machine default); every operation supports `--json`. The `slots_config`
tool accepts `operation` (`show`, `set`, `unset`), plus `key` and `value` as needed.
Configuration is plugin-owned; `bb plugin config slots` no longer applies.
The optional load watch warns heuristically at checkout level when processes
use many cores without a heavy slot; small runs do not need a slot.

A heavy lease also covers the holder’s child threads; open browser-automation sessions in the family count as activity for idle notices. Transfer is the clean way to assign work.

Status views return the newest 15 non-gate audit events, ordered by time and sequence descending. Disk logs and the 50-event state ring are unchanged.
