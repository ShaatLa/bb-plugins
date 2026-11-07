# Slots plugin overview

Phase 1 supplies a deterministic, JSON-serializable engine and a shared contract.
It registers no runtime surfaces. No process inspection, environment access,
process termination, live metrics collection or network probes are implemented.

- `contract.ts`: settings/defaults; queue, lease, gate, port and audit DTOs; all
  operation request/response types; reducer inputs/effects/results.
- `core/index.ts`: pure reducer, settings validation and snapshot/log/port queries.
- `core/index.test.ts`: fake-clock and fake-metrics lifecycle/scheduling tests.
- `server.ts`: inert backend factory, awaiting the phase-2 adapter.
- `app.tsx`: empty frontend registration, awaiting the phase-3 sidebar.
- `components/ui`, `lib`: vendored UI foundations following CI Dashboard.

The server owns SDK registration and boundary validation, explicit host resolution,
serialized reducer transactions, state persistence, append-only JSONL audit,
notification delivery, real metrics sampling, child relationship verification,
thread liveness checks, active-turn heartbeats and real TCP port probing. Persist
state before delivering effects. It owns waiting/timeouts and historical log reads.
The sidebar consumes snapshots and operations from `contract.ts`. No live UI or
three-thread demo is part of this phase. Release, deployment and integration review
remain with the parent thread.
