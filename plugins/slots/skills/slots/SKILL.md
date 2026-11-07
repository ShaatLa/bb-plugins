---
name: slots
description: "Coordinate heavy local jobs through Slots leases, launch gates and dev-server ports."
---

# Slots

This 0.1.0 package contains the pure engine only. The commands below describe the
planned adapter workflow; no CLI or agent tools are registered in this phase.

Request a `heavy` slot before full suites, race tests, containers or browser jobs.
Request `local-model` for local inference; that pool also uses the host gate.
Provide a job description and a realistic estimate. Await the grant notification
before starting. After the adapter lands, the command will be:

```sh
bb slots request --pool heavy --job "full test suite" --est 35m --wait
```

Before EVERY launch, run `bb slots gate` as a separate operation. Inspect its
result and launch only after it passes. Never chain the gate into the launch
command. Passing once does not cover subsequent launches under a long lease.

Heartbeat while holding a lease (`bb slots heartbeat`); respond to the expiry
warning with a heartbeat if still working. Release promptly with
`bb slots release [lease]`. An owner can transfer its lease to a verified child
with `bb slots transfer --to <thread>`; child release returns it to the owner.
Use `bb slots port` for an allocated dev-server port; it is released with the
last held lease. Manager priority, grant, revoke and capacity controls do not
replace the launch gate. All future operations support JSON output.
