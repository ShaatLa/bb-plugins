# Slots

Slots 0.1.0 is the pure core and package scaffold for an advisory resource manager
for heavy local jobs. It never kills processes. This phase registers no UI, RPC,
CLI, timers, metrics probes or storage; those adapters are subsequent work.
Requires BB 0.49.0+ and Plugin SDK 0.6.132+ (the SDK shipped by BB 0.49.0).

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build
```

The package uses npm/package-lock and Vitest. `server.ts` and `app.tsx` are inert
entry points. `components/ui` and `lib/utils.ts` contain the repository's vendored
Button, Card, motion tokens and `cn` helper for the future sidebar.

## Contract and pure engine

`contract.ts` exports `Settings`, `HostSettings`, `DEFAULT_SETTINGS`, `State`,
`SlotRequest`/`QueueEntry`, `Lease`, `GateState`, `PortLease`, `AuditEvent`,
`StatusSnapshot`, `RpcMethods`, `RpcRequest`, `RpcResponse`, `Input`, `Context`,
`Effect`, `Result` and `Transition`. RPC method types cover request, release,
heartbeat, gate, status, transfer, port, prioritize, revoke, grant, setCapacity,
and log. The server must validate boundary data and translate its SDK schema
contract into these JSON types; the contract file imports no SDK.

`core/index.ts` exports `initialState`, `apply`, `settingsFor`, `validateSettings`,
`capacityFor`, `gateOpen`, `portCandidates`, `statusSnapshot` and `logSince`.

```ts
const ctx = { now: 0, settings: DEFAULT_SETTINGS };
const transition = apply(initialState(), {
  type: "request", hostId: "host-1", pool: "heavy", threadId: "thread-1",
  job: "full test suite", estMs: 35 * 60_000,
}, ctx);
// Persist transition.state, then execute transition.effects in order.
```

The reducer does no I/O and never reads a clock. Inputs and prior state are not
mutated. Errors are `{ok:false,error:{code,message,readings?}}`, with unchanged
state and no effects. Persist state verbatim. Execute `notify` effects using
thread messages and append `audit` effects to JSONL; state retains just 50 events.
`logSince` queries only that retained tail; the server must query its full JSONL
for historical `log --since` results. `since` is inclusive; timestamps, estimates
and durations are milliseconds. `seq` and IDs increase deterministically.

## Scheduling and lifecycle

- Hosts are explicit at the engine boundary. `heavy` defaults to capacity 4 and
  `local-model` to 1. Settings apply globally unless a complete `hosts[hostId]`
  override exists. `setCapacity` persists a manager override in state; it takes
  precedence over settings until changed again. Zero capacity pauses a pool.
- Queues sort urgent, high, normal, then timestamp and insertion order for ties.
  Requests are idempotent per host/pool for both owner and holder of a lease.
  Prioritization keeps the original timestamp. Capacity reductions preserve leases.
- Both pools use the same per-host gate: memory free >=20%, load1 <18, two passing
  samples at least 15 seconds apart. Fast samples are audited but do not count;
  failures reset the streak. Every grant resets it. Only `gateSample` and `tick`
  auto-grant, at most once per host per open gate. Manual mode never auto-grants.
  Manager `grant` bypasses priority and streak, requires a passing latest sample,
  and respects capacity. A host with no sample cannot be manually granted.
- `gateSample.at` must be nonnegative, no later than `ctx.now`, and no earlier
  than the preceding sample; invalid readings fail transactionally. `gate` is
  a read of the latest sample plus a holder heartbeat. The server must collect
  a fresh sample before answering a launch gate check. `passed` means the latest
  reading passes; `open` also requires the consecutive sample streak.
- Default TTL is 30 minutes, heartbeat interval 10 minutes. Effective TTL is
  `max(leaseTtlMs, estMs + 15 minutes)` on grant, transfer and every heartbeat.
  One warning wakes the holder at expiry minus heartbeat interval; heartbeat
  clears it. `tick` expires at the exact deadline, notifying holder and observer.
  Heartbeat, gate, portLease and duplicate request refresh all leases held by the
  caller, including leases on other hosts.
- A transfer requires exactly one owned lease (or an explicit leaseId), a different
  target, and `isChild` verified by the server against the current holder's child.
  The target cannot already own/hold/queue for that host/pool. The owner remains
  reserved. Child release/archive/deletion returns the lease to the owner; owner
  release/archive/deletion frees it, notifying the transferee. Expiry and revoke
  always free. Transfer/return refreshes TTL and drops any now-orphaned port.
- `release` releases leases; it does not cancel queued requests. `threadEnded`
  releases/returns leases and cancels queues. The phase-1 lifecycle input covers
  archive/deletion; the server decides how to map other liveness observations.
- `portCandidates(state, hostId, settings)` returns ascending unleased ports.
  The server probes real TCP availability then submits `portLease`. A port is
  idempotent per host/thread and requires a held lease on that host. Port range
  defaults to 41000–41099. The port stays until the last held lease is gone;
  transfer does not move a port to a different thread.
- `restored` resets gate streaks, preserving leases and latest readings. The
  server rechecks thread liveness before resuming scheduling.

Read [PLUGIN_OVERVIEW.md](PLUGIN_OVERVIEW.md) for adapter responsibilities and
[the agent skill](skills/slots/SKILL.md) for the intended heavy-job workflow.
