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

By default the project placement setting decides whether portable heavy work may
run on another configured machine. `--anywhere` permits placement, `--local`
keeps it here. `--spill` and `--spill auto` are aliases of `--anywhere`.
Use `--needs go,docker,chrome,playwright,node,bun` to require installed tools.
A remote run copies the worktree and returns output and exit code. Keep jobs local
when they write files read afterwards (evidence, screenshots, renders, coverage,
snapshots or dumps), depend on environment variables or ignored files, use ports,
local services or git submodules. Arguments with absolute paths outside the
worktree also force local placement. Use raw `acquire` for interactive holds.

`--est` must carry a unit (`45m`, `2h`); a bare number means minutes. Estimates
above `maxEstimateMinutes` (default 12 h) are refused; the lease of a longer job
stays alive through heartbeats, so give the realistic estimate.

Use `--pool local-model` for LLM inference. That pool checks only free memory,
not CPU load, and is granted on the next reading. After its last use is done the
lease stays with the thread for 90 s, so the next turn's acquire gets it back at
once; `bb slots release <id>` frees it earlier. Each inference device that
local-models registers (for example `M1`, the prefix of an `M1/...` model id)
has its own local-model slot. Without `--device` the first free registered
device is granted, then this Mac; `--device M1` pins that device and
`--device local` pins this Mac. The grant prints the device (`local-model M1`,
no name = this Mac): run your model there, or pin the device you need. A holder may reuse its lease for
nested, sequential or concurrent runs without another gate check. Signal the
process group to cancel. `bb slots request --wait` timeout exits 75 and keeps
the request queued until canceled or the thread ends; rerun the same command
to keep waiting. `acquire` / `slots-run` timeout exits 75 and keeps its queue
position for one heartbeat interval (10 minutes by default); rerun within that
time. If a queued use stops being renewed (its waiter ended), the request is
dropped and you get a "Queued request dropped" notice: queue again.
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
with `bb slots release <lease-or-request>` (example: `bb slots release lease-12`); a
granted request ID releases its lease. Without an ID, release works only when your
thread has exactly one lease or request; `--all` releases every lease and cancels
every request of your thread. Do not pass `--thread` inside a thread: any ID other
than your own is refused.
Use `bb slots port` for dev servers. Transfer to a QA child with
`bb slots transfer --to <thread> [--lease <id>]`; child release returns the lease.
A `local-model` transfer sends the child no message, and its return sends you
none: release the lease yourself after the child reports.

Manager commands: `prioritize <req> --priority high|urgent|normal`,
`revoke <lease> --reason "..."`, `grant <req>` (no force),
`capacity --pool heavy 4`. Only the manager or owner runs them; other agents must
not, and ask the manager instead. The tools do not check the caller in v1.
Anyone may inspect `status` and `log --since 2h --limit 100`. V1 supports only
the BB server host.

On start, a manager session runs `bb slots observer --self`.

Configuration: read and change one key at a time. `bb slots config get <key>`
returns that key only; `bb slots config set <key> <value>` and
`bb slots config unset <key>` (reset to the current machine default) return only
the changed key. `bb slots config` without a key lists every value. Every operation
supports `--json`. The `slots_config` tool accepts `operation` (`get`, `set`,
`unset`, or `show` to list all), plus `key` and `value`; with a key it returns
`{key, value, default, max?, set}`.
Configuration is plugin-owned; `bb plugin config slots` no longer applies.
The optional load watch warns heuristically at checkout level when processes
use many cores without a heavy slot; small runs do not need a slot.

A heavy lease also covers the holder’s child threads; open browser-automation sessions in the family count as activity for idle notices. Transfer is the clean way to assign work.

Status views return the newest 15 non-gate audit events, ordered by time and sequence descending. Disk logs and the 50-event state ring are unchanged.
