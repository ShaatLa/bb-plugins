---
name: agent-spawn-gate
description: Follow Agent Spawn Gate project workflows and mint one-use child-start admissions.
---

Settings → Installed plugins → Agent Spawn Gate selects a Script or Instruction
workflow independently for each bb project. Follow the configured workflow
before creating child sessions. Live project instructions specify the steps.

In Script mode use `bb agent-spawn-gate start --project <projectId>
--parent-thread <threadId> -- <builder args...>`. It runs the configured JSON
builder from a freshly fetched remote-default-branch checkout, mints and
starts the session. `--dry-run` before `--` builds without minting or spawning.
RPC `start` takes `{projectId,parentThreadId,args,dryRun?}`. Builder contract:
START-CONTRACT.md in the plugin package. Absolute builder input paths must be
readable on the bb server machine. The caller's branch is never used.

In Instruction mode, or for existing integrations, call plugin `agent-spawn-gate`, RPC `mint`, with
`{projectId,parentThreadId,brief}`. CLI: `bb plugin rpc call agent-spawn-gate mint
--input-file request.json --json`. The brief may be plain task text.
Output is `{token,expiresAt,prompt}`. Write prompt verbatim to a file and use
`bb thread spawn --project <projectId> --parent-thread <parentThreadId>
--prompt-file <prompt.txt>`. Never edit or reuse admissions. Lifetime defaults
to ten minutes.

Settings uses one project dropdown. Valid changes automatically persist only
the selected project's values. Every project defaults off and offers the same
script/instruction selection. CLI shares the UI's RPC/store:
`bb plugin rpc call agent-spawn-gate settings.read --json` returns projects and
saved values. `settings.write` with `{projectId,values:{enabled:false}}` disables
only that project. Other fields: method, instruction, script, ttlMinutes.

Enforced projects require admission for all new agent and CLI starts. Human
top-level bb windows remain exempt. Rejections may leave idle rows; archive
probe rows. Tokens do not prove script execution or instruction compliance.
