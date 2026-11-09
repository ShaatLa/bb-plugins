## Run local models

Choose Local models in BB's provider picker to run threads on models served by
a local OpenAI-compatible server such as llama.cpp's `llama serve`. The shim
runs its own agent loop against `/v1/chat/completions` with streaming, resume,
cancellation and BB agent tools.

## Usage and context

Provider usage shows one row `Available models: …` with no quota bar or
percent. Context size comes from the router's `--ctx-size` and is shown by
`bb local-models status`.

## Settings

Set the server URL and the default model for new threads. Your global Codex
config, MCP servers and Apps connectors are not used.

## Requirements and limits

Requires BB 0.46.1, SDK 0.6.49 and a running local server. Full and Accept Edits
modes are available. Fork, rename, archive, manual compaction and native user
questions are not supported.
