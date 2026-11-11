# Machine Slots plugin overview

Coordinates advisory pools (`heavy`, `local-model`) on the BB server host.
Agents request, gate before each launch, heartbeat on warnings, release promptly,
lease ports, or transfer work to a QA child. Remote threads are refused. The optional load watch reads only own-user process pid, start time, CPU time and cwd, never environment or command lines; it samples every 30s and uses a checkout-level heuristic (local host only, short-lived processes may be missed, containers are not covered). Cost is ~0.03% of one core in-process and ~0.6% including `ps`/`lsof` children on a busy 18-core machine; diagnostics appear in `bb slots status --json`.
Manager operations are unrestricted in v1.

- `contract.ts`: pure DTOs, `RpcMethods`, `StatusView`, `SLOTS_CHANGED` (`slots.changed`).
- `core/`: deterministic scheduling, gate hysteresis, leases, transfers, ports.
- `server.ts`: serialized transitions, SDK settings, liveness, wake-up messages,
  realtime, RPC and tools, disposable sampler and tick service.
- `runtime.ts`: atomic JSON state, daily JSONL retention, metrics and port probes.
- `schemas.ts`: runtime validation for RPC and persisted state.
- `cli.ts`: `bb slots` commands, JSON output, bounded waiting and audit reads.
- `skills/slots/`: agent workflow. README documents all commands and settings.

Settings include load watch policy, core threshold, sampling window and idle lease notice; observer events include unleased load and idle heavy lease. Wrapper command: `sh -c "$(bb slots wrapper)" slots-run --est 20m --job "..." -- <command>`. A holder can reuse its lease for nested/sequential/concurrent runs without re-gating; signal the process group to cancel. `request --wait` and `acquire` timeouts keep queue position; rerun the same command. Small runs do not need a slot.

Settings are typed number/string/select controls in human units, converted to the
engine format with cross-field validation. They are global because this SDK has
no host-scoped settings. Capacity is
persisted only in settings through `experimental_set`, never overridden in state.
State and daily audit files live beside the SDK plugin database. Notifications
use `threads.send` with plugin attribution and mode auto, waking idle agents.
Notify errors are logged once. Archive/deletion frees work; startup reconciles
missed lifecycle events. Active holders heartbeat each 15s tick. Gate readings
are audited to disk without flooding the 50-event sidebar tail.

The frontend consumes RPC `status` and refetches on `slots.changed`. Snapshots
leave the transition queue before parallel, cached title resolution (60s TTL,
invalidated on thread end). CLI plain output is concise; JSON envelopes are unchanged. This phase
does not modify `app.tsx` or UI files, install, release or deploy the plugin.
