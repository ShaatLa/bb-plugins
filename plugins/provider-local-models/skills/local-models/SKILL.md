---
name: local-models
description: Pick, query and dispatch tasks to local llama.cpp models.
---
Run `bb local-models status --json` for installed model ids, load state, context
size and known reasoning levels. The router usually keeps one model loaded:
switching costs seconds for small MoE models and minutes for large dense ones.

Rules for dispatching a local-models thread:
- Run at most one local-models thread per GPU at a time. Threads do not take a
  Slots use on their own, so hold a `local-model` lease for the child:
  `bb slots request --pool local-model --job "draft notes" --est 30m --wait`,
  then spawn, then `bb slots transfer --to thr_example`.
- Spawn with `--permission-mode full`:
  `bb thread spawn --provider local-models --model <id> --permission-mode full --parent-self …`.
  BB denies approval requests in agent-sent turns, so in accept-edits every
  shell call and every write outside the workspace fails as "denied".

Qwen reasoning: none, low, medium, xhigh (BB high maps to xhigh). LFM has no
reasoning knob. Muse uses reasoning_strength low/medium/high/xhigh; thinking
cannot be disabled. Unknown capabilities send no reasoning parameters.

`bb local-models ask "prompt" --model <id> --effort medium --max-tokens 1024
--timeout 20m [--system "text"] [--json]` is a one-shot request without tools.
`local_models_ask` offers the same task to agents (20-minute timeout), except
local-models threads, to avoid recursive GPU requests. Both hold a Machine Slots
`local-model` use for the request (queueing behind other local-model work) when
the Slots plugin is installed; inside your own slots-run lease they reuse it.
`bb local-models unload <id>` releases one model; `unload --all` releases every
loaded model, including ones other threads use, so prefer the id. Pass one or
the other, not both. Run from a thread, unload waits for running local-model
work first. Server-side commands require the router to be reachable from the
BB server machine.

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
