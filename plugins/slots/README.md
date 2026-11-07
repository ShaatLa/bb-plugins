# Machine Slots

Advisory resource pools for heavy jobs on the BB server machine. Requires BB
0.49.0+ and SDK 0.6.132+. Slots coordinates agents; it never kills or inspects
processes, reads environment values, or guarantees exclusive machine access.
Manager commands are unrestricted in v1. Threads on other hosts are refused.

## Sidebar (0.3.1)

Version 0.3.1 removes legacy settings migration; missing `config.json` means all defaults.

Version 0.3.0 adds a grouped settings editor with bounded numeric controls,
machine-default resets, live readings and an observer thread picker with event switches.

Version 0.2.5 keeps dashboard values compact, leaving default and maximum
explanations in the settings labels. Clamp warnings remain visible.

Version 0.2.4 derives load and heavy-capacity defaults and limits from the machine
and warns when saved limits need clamping.

Version 0.2.3 makes the skill and examples project-neutral and documents machine tuning.

Version 0.2.2 uses BB’s built-in `ArrowReloadHorizontal` refresh icon (fallback
`RotateCcw`), retaining the busy indicator and reduced-motion support.

Version 0.2.1 corrects singular/plural slot and check counts, labels zero-capacity
pools as unconfigured, and adds refresh busy feedback.

The read-only sidebar follows CI Dashboard's cards and disclosures: machine readiness,
threshold meters, pool usage, lease progress and expiry warnings, queue wait reasons,
and collapsed human-readable recent activity. Thread titles open their BB threads;
raw host IDs stay out of the page. Status refreshes on `slots.changed`, with a
10-second visible-page poll as fallback, a manual refresh button and last-good data
on errors. `StatusView.localHostName` is an optional display name resolved through
`bb.sdk.hosts.get`; unavailable names fall back to “This machine”. Request activity
shows estimates while the matching request or lease remains in the snapshot.

Version 0.2.0 also adds a configurable observer event filter, one-shot queue-wait
and gate-hold alerts, and `bb slots observer` for manager session handover.

## Commands

Plain output summarizes gate readings, requests, pools and audit events in short
lines. Every command supports `--json`. Caller identity defaults to the CLI context's
BB_THREAD_ID; holder commands also accept `--thread <id>`.

```sh
sh -c "$(bb slots wrapper)" slots-run --est 35m --job "full test suite" -- <command> [args...]
bb slots acquire --pool heavy --job "full test suite" --est 35m
bb slots heartbeat --use <use-id>
bb slots done <use-id>
bb slots request --pool heavy --job "full test suite" --est 35m --wait --timeout 30m
bb slots gate
bb slots heartbeat
bb slots config [show | set <key> <value> | unset <key>] [--json]
bb slots observer [--self | --thread <id> | --clear] [--events warn,expire,revoke,queue-wait,gate-hold] [--json]
bb slots release [lease-or-request]
bb slots status
bb slots transfer --to <child-thread> [--lease <id>]
bb slots port
bb slots prioritize <request> --priority high
bb slots revoke <lease> --reason "job canceled"
bb slots grant <request>
bb slots capacity --pool heavy 4
bb slots log --since 2h --limit 100 --json
```

Request returns immediately unless `--wait` is present. Waiting polls every 3s,
keeps the queued request on timeout (exit 75); disconnect withdraws it. Retry to keep its position. Default timeout
is 30m; maximum 60m (BB's CLI headers timeout is 65m). Tools return immediately;
grant messages wake idle threads. Tool names are `slots_request`, `slots_release`,
`slots_heartbeat`, `slots_gate`, `slots_status`, `slots_transfer`, `slots_port`,
`slots_config`, `slots_observer`, `slots_prioritize`, `slots_revoke`, `slots_grant`, `slots_setCapacity`, `slots_log`.
The native tools are enabled alongside the bundled `slots` skill.

`gate` samples freshly and exits 1 when the reading fails; it prints readings
and thresholds. A holder can launch additional wrapper commands without another gate check; the lease was gated when granted. Two consecutive passing samples
spaced 15s apart are required for automatic grants; every grant resets the
streak. Manual grant bypasses queue order and streak, but checks a fresh sample
and capacity. There is no force option.

The wrapper runs the command in the foreground and calls done only after it exits.
Signal the process group to cancel; signals to the wrapper PID alone are not
forwarded. If renewal stops, the use can expire while the command still runs;
grandchildren that outlive it are not covered. PID and start-time checks are
approximate and do not exclude PID reuse. A stuck renewal supervisor can leave
an in-flight heartbeat running until it returns. The wrapper supports macOS and
Linux. Acquire timeout exits 75 and keeps the queue position for one use TTL;
retry within that grace period. Each use must be renewed independently.

A thread has one request or lease per pool. Release without an ID releases all
its leases and cancels all its queued requests. A request ID cancels only that
request. Transfer verifies the target is the owner's child on the local host;
child release/archive/deletion returns the lease to the owner. Owner end frees
it. Revoke and expiry always free it. Port allocation requires a held lease,
probes IPv4 and IPv6 loopback, and releases when the last held lease is gone.
Binding after a successful probe can still race another application.

## Settings

The custom Machine Slots settings section groups Slots, Machine check (with
collapsed Advanced checks), Leases, Manager / observer, Grant mode and Dev-server
ports. Changes apply immediately; server validation errors appear inline. Reset
to default unsets the key so machine defaults follow the next start. The observer
picker lists active sessions across projects; the server rejects sessions on other
hosts. Clear disables the observer without changing event preferences.

Only the grouped editor is shown: Machine Slots no longer defines host-rendered
settings descriptors. Configuration lives in atomic `config.json` beside `state.json`,
with only explicitly set keys. Defaults and maxima continue to follow the machine.
`bb plugin config slots` no longer applies; use `bb slots config` or `slots_config`.

The frontend RPCs `settingsRead` and `settingsWrite` return values, defaults,
maxima and explicitly set keys. Writes accept a partial `values` object and/or
an `unset` key list. Per-field schemas, machine maxima, cross-field combinations
and observer targets are validated before persistence. Changes publish
`slots.changed` and apply immediately. `config` powers the CLI and agent tool
with show/set/unset operations; the two frontend RPCs are not agent tools.

### Upgrading from 0.2.x

Settings saved in bb’s plugin settings are not carried over. After upgrading,
re-run `bb slots observer --thread <id>` (or `bb slots observer --self` from the
manager) and `bb slots config set <key> <value>` for each setting you had changed.
An absent `config.json` means empty configuration and all machine/default values.
Existing `config.json` overrides from 0.3.0 are preserved.

Configuration uses typed server validation. Settings apply to the BB server machine;
engine `hosts` overrides remain empty. Human units are converted at the boundary.
The load limit defaults to the available CPU core count and cannot exceed it.
Heavy capacity defaults to `max(1, min(floor(cores / 4), floor(totalMemGiB / 16)))`
and is capped at the CPU core count; 0 still disables the pool. For 18 cores and
64 GiB this gives load 18 and four heavy slots. Users may lower either value.
Unset settings follow the current machine on each plugin start. Saved values
(including an explicit 18) stay saved; values above a smaller machine’s maximum
are clamped at use time with warnings in status, without rewriting the saved value.
Unset a setting to resume following the machine. Memory free (20%), timing, TTLs, ports and local-model capacity (1)
remain policy choices rather than machine-derived limits.

| Setting | Default | Range |
| --- | --- | --- |
| heavyCapacity | CPU/memory formula above | 0–CPU cores |
| localModelCapacity | 1 | 0–10000 |
| memFreeMinPct | 20 | 0–100% |
| loadMax | CPU cores | >0, at most CPU cores |
| gateSamples | 2 | 1–100 |
| gateIntervalSeconds | 15 | 1–3600 seconds |
| leaseTtlMinutes | 30 | 2–10080 minutes |
| heartbeatIntervalMinutes | 10 | 1–10079 minutes, below TTL |
| observerThreadId | empty | optional thread ID, maximum 200 characters |
| observerEvents | warn,expire,revoke,queue-wait,gate-hold | comma-separated allowed events; also grant,release,transfer,capacity; empty disables copies |
| observerQueueWaitMinutes / observerGateHoldMinutes | 20 / 15 | 1–10080 minutes |
| portFrom / portTo | 41000 / 41099 | 1–65535, first <= last |
| grantMode | auto | auto / manual |

The engine's `validateSettings` checks cross-field combinations before use;
correct invalid heartbeat/TTL or port bounds before continuing operations.
`capacity` writes the matching capacity field in `config.json`; there is
no capacity override in state. Lowering capacity preserves live leases. Settings changes
reset gate streaks. TTL is `max(leaseTtlMs, estimate + 15m)`, renewed by heartbeat,
gate, port, duplicate request, active events and each tick for active holders.
Idle holders receive one wake-up warning at expiry minus heartbeat interval.
Archive/deletion cancels queued work and releases leases. Startup rechecks owners,
holders and queued requesters before scheduling. Stopped idle threads rely on
explicit release or expiry; the SDK exposes no distinct thread-stopped event.

Memory uses macOS `memory_pressure` (fixed argv, 2s timeout) or Linux MemAvailable /
MemTotal. A probe failure closes the gate and logs an error. Only the local host
is sampled: every gateIntervalMs with queued work, otherwise every 60s; ticks run
every 15s. Observer notifications are optional and never fatal on send failure.

`observer` shows the current observer ID, title and filter. `--self`, `--thread`
and `--clear` persist the selection in plugin settings; `--events` can accompany
any of them or change only the filter. Unknown names are rejected; whitespace is
ignored. The `slots_observer` tool accepts `self`, `toThreadId`, `clear`, and
`events` (comma-separated); self uses the calling thread. Targets must be live
threads on the local host. Handover notifies the new and previous observer and
is audited. Startup rechecks the observer; archive/deletion clears it automatically.

The default observer filter copies warnings, expiry and revocation. Grant,
release (including thread end), transfer/return and capacity copies are opt-in.
Messages already addressed to the observer are never copied again. Queue-wait
alerts include requester, job, estimate, elapsed wait, pool position and blockers.
Gate-hold alerts require queued work and continuous failing samples; a passing
sample re-arms them. Both alerts are audited and their one-shot flags persist
across restart, with defaults for state saved by 0.1.0.

## Persistence and frontend contract

State is JSON at `state.json` beside the SDK plugin database, saved by temporary
file + rename under a single transition queue. Audit effects append to daily
`YYYY-MM-DD.jsonl` files retained for 14 days. Gate readings remain in JSONL but
never displace the 50 non-gate events retained for the sidebar. Historical logs
stream those files, defaulting to 100 events, maximum 1000; `--since` accepts a
duration (`2h`) or ISO timestamp. Persisted state is validated before restore.
Malformed state fails startup instead of silently discarding leases.

`contract.ts` exports `RpcMethods`, `StatusView`, and `SLOTS_CHANGED` =
`slots.changed`. Each successful transition publishes that realtime channel;
the sidebar should refetch `status`. It returns titles, effective host settings,
localHostId and the engine snapshot. Title lookups run in parallel outside the
transition queue and share a bounded 60-second cache invalidated on thread end. Runtime input schemas and `rpcContract`
live in `schemas.ts`; `core/index.ts` remains deterministic and performs no I/O.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Server tests use the SDK fake host, a fake clock and metrics, and temporary
storage. No plugin installation, live three-thread demo or deployment is part
of this phase. The sidebar is covered by SDK frontend harness tests.
