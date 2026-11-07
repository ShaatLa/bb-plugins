# Machine Slots

Advisory resource pools for heavy jobs on the BB server machine. Requires BB
0.49.0+ and SDK 0.6.132+. Slots coordinates agents; it never kills or inspects
processes, reads environment values, or guarantees exclusive machine access.
Manager commands are unrestricted in v1. Threads on other hosts are refused.

## Sidebar (0.2.0)

The read-only sidebar follows CI Dashboard's cards and disclosures: machine readiness,
threshold meters, pool usage, lease progress and expiry warnings, queue wait reasons,
and collapsed human-readable recent activity. Thread titles open their BB threads;
raw host IDs stay out of the page. Status refreshes on `slots.changed`, with a
10-second visible-page poll as fallback, a manual refresh button and last-good data
on errors. `StatusView.localHostName` is an optional display name resolved through
`bb.sdk.hosts.get`; unavailable names fall back to “This machine”. Request activity
shows estimates while the matching request or lease remains in the snapshot.

## Commands

Plain output summarizes gate readings, requests, pools and audit events in short
lines. Every command supports `--json`. Caller identity defaults to the CLI context's
BB_THREAD_ID; holder commands also accept `--thread <id>`.

```sh
bb slots request --pool heavy --job "full Vitest" --est 35m --priority normal --wait --timeout 30m
bb slots gate
bb slots heartbeat
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
withdraws the queued request on timeout/disconnect and exits 1. Default timeout
is 30m; maximum 60m (BB's CLI headers timeout is 65m). Tools return immediately;
grant messages wake idle threads. Tool names are `slots_request`, `slots_release`,
`slots_heartbeat`, `slots_gate`, `slots_status`, `slots_transfer`, `slots_port`,
`slots_prioritize`, `slots_revoke`, `slots_grant`, `slots_setCapacity`, `slots_log`.
The native tools are enabled alongside the bundled `slots` skill.

`gate` samples freshly and exits 1 when the reading fails; it prints readings
and thresholds. Always check it as a separate step before each launch. Never
chain gate and launch in one shell command. Two consecutive passing samples
spaced 15s apart are required for automatic grants; every grant resets the
streak. Manual grant bypasses queue order and streak, but checks a fresh sample
and capacity. There is no force option.

A thread has one request or lease per pool. Release without an ID releases all
its leases and cancels all its queued requests. A request ID cancels only that
request. Transfer verifies the target is the owner's child on the local host;
child release/archive/deletion returns the lease to the owner. Owner end frees
it. Revoke and expiry always free it. Port allocation requires a held lease,
probes IPv4 and IPv6 loopback, and releases when the last held lease is gone.
Binding after a successful probe can still race another application.

## Settings

Installed plugin settings expose typed controls with range validation. The SDK
has no host-scoped settings, so settings are global and engine `hosts` overrides
remain empty. Human units are converted at the boundary.

| Setting | Default | Range |
| --- | --- | --- |
| heavyCapacity / localModelCapacity | 4 / 1 | 0–10000 |
| memFreeMinPct | 20 | 0–100% |
| loadMax | 18 | 0.1–1000 |
| gateSamples | 2 | 1–100 |
| gateIntervalSeconds | 15 | 1–3600 seconds |
| leaseTtlMinutes | 30 | 2–10080 minutes |
| heartbeatIntervalMinutes | 10 | 1–10079 minutes, below TTL |
| observerThreadId | empty | optional thread ID, maximum 200 characters |
| portFrom / portTo | 41000 / 41099 | 1–65535, first <= last |
| grantMode | auto | auto / manual |

The engine's `validateSettings` checks cross-field combinations before use;
correct invalid heartbeat/TTL or port bounds before continuing operations.
`capacity` writes the matching capacity field via `experimental_set`; there is
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
