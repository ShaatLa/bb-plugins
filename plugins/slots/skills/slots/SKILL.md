---
name: slots
description: "Request local resource leases for full test suites, race-detector or fuzz runs, database or service containers, headless-browser jobs, large builds, or local LLM inference."
---

Small or focused runs — a single package's unit tests, typecheck, lint, a quick
build — that finish in a minute or two on a few cores do not need a slot.
Request one for work that saturates many cores or lots of memory for several minutes.

Request before heavy work such as full test suites, race-detector or fuzz runs,
database or service containers, headless-browser jobs, large builds, or local LLM
inference: `bb slots request --pool heavy --job "..." --est 35m`.
Use `--pool local-model` for LLM inference. Add `--wait --timeout 30m` in a
background shell run, or wait idle for the grant message. Tools `slots_request`
and peers return immediately; notifications wake idle threads. One request or
lease per thread/pool. All commands support `--json`.

Before EACH launch, run `bb slots gate` as a separate tool/shell step and inspect
the result. Launch only if it passes. NEVER run `bb slots gate && launch` or put
the gate and launch in the same command. A lease alone is not a passing gate.

On an expiry warning, run `bb slots heartbeat` if still working. Release promptly
with `bb slots release [lease-or-request]`; no ID also cancels queued requests.
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
