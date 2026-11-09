---
name: local-models
description: Pick, query and dispatch tasks to local llama.cpp models.
---
Run `bb local-models status --json` for installed model ids, load state, context
size and known reasoning levels. For coding tasks, Muse Glimmer 30B and
Qwen3.6-35B-A3B are the most reliable: Muse followed specs most completely and did
git worktree work cleanly; Qwen3.6 is fastest on small edits but may ignore exact
paths. LFM2.5-24B-A2B is fast and fine with git but skips spec details. Flint may
wander outside the workspace on loosely specified tasks. Dense Qwen3.8-27B is many
times slower with no better results. The router keeps one model
loaded: switching costs about 10 seconds for LFM and minutes for dense models.
Run one thread at a time on this single GPU.

Dispatch with `bb thread spawn --provider local-models --model <id>
--permission-mode full --parent-self …`. Use full because BB automatically
denies approval requests in agent-sent turns; accept-edits shell calls fail.

Qwen reasoning: none, low, medium, xhigh (BB high maps to xhigh). LFM has no
reasoning knob. Muse uses reasoning_strength low/medium/high/xhigh; thinking
cannot be disabled. Unknown capabilities send no reasoning parameters.

`bb local-models ask "prompt" --model <id> --effort medium --max-tokens 1024
--timeout 20m [--system "text"] [--json]` is a one-shot request without tools.
`local_models_ask` offers the same task to agents (20-minute timeout), except
local-models threads, to avoid recursive GPU requests. `bb local-models unload
<id>` or `unload --all` releases models. Server-side commands require the router
to be reachable from the BB server machine.

“Local model turn failed: …” reasons:
- cannot reach: start the router and check baseUrl/network.
- dropped the connection: check router logs for a crash or restart.
- stopped streaming for: check GPU/router health; retry once healthy.
- sent nothing for: cold loading or prompt processing exceeded the budget;
  wait for load or increase LM_FIRST_BYTE_TIMEOUT_MS.
- answered 4xx/5xx: inspect the server error and model/template configuration.
- ended the stream before: interrupted response; check router logs and retry.

Shim timeout environment variables (milliseconds): LM_FIRST_BYTE_TIMEOUT_MS
(default 20m), LM_IDLE_TIMEOUT_MS (10m), LM_RETRY_DELAY_MS (5s).
LM_WAIT_ROW_MS (3s) controls the loading row; LM_MAX_STEPS (60) bounds tool
steps. Identical tool calls in a row stop after the fourth.
