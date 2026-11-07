# Slots plugin overview

Coordinates advisory pools (`heavy`, `local-model`) on the BB server host.
Agents request, gate before each launch, heartbeat on warnings, release promptly,
lease ports, or transfer work to a QA child. Remote threads are refused. No
process inspection, termination, environment reads or secrets are involved.
Manager operations are unrestricted in v1.

- `contract.ts`: pure DTOs, `RpcMethods`, `StatusView`, `SLOTS_CHANGED` (`slots.changed`).
- `core/`: deterministic scheduling, gate hysteresis, leases, transfers, ports.
- `server.ts`: serialized transitions, SDK settings, liveness, wake-up messages,
  realtime, RPC and tools, disposable sampler and tick service.
- `runtime.ts`: atomic JSON state, daily JSONL retention, metrics and port probes.
- `schemas.ts`: runtime validation for RPC and persisted state.
- `cli.ts`: `bb slots` commands, JSON output, bounded waiting and audit reads.
- `skills/slots/`: agent workflow. README documents all commands and settings.

Settings are global because this SDK has no host-scoped settings. Capacity is
persisted only in settings through `experimental_set`, never overridden in state.
State and daily audit files live beside the SDK plugin database. Notifications
use `threads.send` with plugin attribution and mode auto, waking idle agents.
Notify errors are logged once. Archive/deletion frees work; startup reconciles
missed lifecycle events. Active holders heartbeat each 15s tick. Gate readings
are audited to disk without flooding the 50-event sidebar tail.

The frontend consumes RPC `status` and refetches on `slots.changed`. This phase
does not modify `app.tsx` or UI files, install, release or deploy the plugin.
