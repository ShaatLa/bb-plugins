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
Set the native `preferHost` setting to a configured host ID to try it first for portable heavy runs.
Use `--local` only when the command needs something available only on this Mac, such as local state, a running service, or a path outside the worktree; run test suites, type checks, and builds without it so they can move to another machine.
Use `--needs go,docker,chrome,playwright,node,bun` to require installed tools.
A remote run copies the worktree and returns output and exit code, and the files
the command created or changed come back into your worktree (ignored directories
included), so reports, screenshots, coverage and build output need no `--local`.
A file you edited here during the run is kept and reported (`kept your local
version of: ...`), and a file the command deleted goes to the Trash here only if
you did not change it. Results over 1 GiB (`SLOTS_RUN_RETURN_MAX`) stay on the
other machine and the run says where. The other machine keeps only the uploaded
files plus `node_modules/` between runs, so build caches elsewhere are rebuilt.
Keep jobs local when they depend on environment variables or on ignored files
they read (ignored files and directories are outputs only, never uploaded, so the
command must create its output directories), use ports, local services or git
submodules. Arguments with absolute paths outside the worktree
also force local placement. Use raw `acquire` for interactive holds.

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

On start, a manager session runs `bb slots observer --self`. The manager (observer) session alone gets the admin tools (`slots_setCapacity`, `slots_grant`, `slots_revoke`, `slots_prioritize`, `slots_observer`, `slots_config`); after becoming observer, start a new turn, and if they are still missing, restart the session. The `bb slots` CLI works meanwhile.

Configuration: read and change one key at a time. `bb slots config get <key>`
returns that key only; `bb slots config set <key> <value>` and
`bb slots config unset <key>` (reset to the current machine default) return only
the changed key. `bb slots config` without a key lists every value. Every operation
supports `--json`. Other sessions read settings with `slots_configGet` (optional `key`) or `bb slots config get`. The manager's `slots_config` tool accepts `operation` (`get`, `set`,
`unset`, or `show` to list all), plus `key` and `value`; with a key it returns
`{key, value, default, max?, set}`.
Configuration is plugin-owned; `bb plugin config slots` no longer applies.
The optional load watch warns heuristically at checkout level when processes
use many cores without a heavy slot; small runs do not need a slot.

A heavy lease also covers the holder’s child threads; open browser-automation sessions in the family count as activity for idle notices. Transfer is the clean way to assign work.

Status views return the newest 15 non-gate audit events, ordered by time and sequence descending. Disk logs and the 50-event state ring are unchanged.


### Local models and heavy capacity

Configure `deviceHosts` as `device=host_id` entries to link registered model devices to machines. Unmapped devices do not affect heavy capacity. Set `heavyCapacityWithModel` for this Mac and `remoteHostsWithModel` (`host_id=capacity`) for other machines; unset entries follow their ordinary heavy capacity. `bb slots capacity --host <host> --with-model 2` changes one machine's with-model capacity.

A queued model blocks new heavy grants on candidate machines while their device slot is free and existing heavy work drains. Once the model starts, heavy work is capped at the with-model capacity. After `modelHoldMinutes` (default 60) from grant, heavy capacity returns to its ordinary value even if the model is still running. Existing leases are never revoked.

### Owner away: extra heavy capacity

Every sampler tick (15 s) Slots probes each machine through its host entry: input idle time (`HIDIdleTime`), whether the display is asleep, and media assertions (`pmset -g assertions`). A machine is away after `awayMinutes` (default 10) without keyboard or mouse input, or with its display asleep, and with no media playing: any `coreaudiod` audio context, a "Playing audio" assertion, or any display-sleep assertion except a headless render's "Capturing". A failed or unparsable probe counts as present.

While away, heavy capacity rises to `heavyCapacityAway` on this Mac and `remoteHostsAway` (`host_id=capacity`) on other machines, and the load limit to `loadMaxAway` / `remoteLoadMaxAway`. Only the tick's scheduling pass grants above the ordinary capacity: one slot per machine per tick, on a probe at most 5 s old. A local-model mode wins over away. When the owner returns no new extra slots are granted; running leases continue. Unset values add nothing.

Other machines are checked on their probe readings (memory free, load below `remoteLoadMax`, default their core count); without a reading from the last minute (no host entry there, offline, or a failed probe) the machine works as before presence probing: no check and no extra slots, so placement never stops. The panel and `bb slots status` show each machine's mode, e.g. `Away 23 min: +2 heavy` or `Present: media playing (audio)`.
