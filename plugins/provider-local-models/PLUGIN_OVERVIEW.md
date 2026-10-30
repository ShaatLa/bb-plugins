## Run local models

Choose Local models in BB's provider picker to run threads on models served by
a local OpenAI-compatible server such as llama.cpp's `llama serve`. Turns go
through the installed `codex` CLI with BB instructions, streaming, resume,
cancellation and BB agent tools.

## Usage and context

Provider usage shows each local model with `∞`. The composer shows the
context window filled by the current thread.

## Settings

Set the server URL, the `codex` path and the default model for new threads.
Your global Codex config, MCP servers and Apps connectors are not loaded for
local threads.

## Requirements and limits

Requires BB 0.46.1, SDK 0.6.49, an installed `codex` CLI and a running local
server. Full and Accept Edits modes are available.
