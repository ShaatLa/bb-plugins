# Local models provider

A native provider for models served locally by an OpenAI-compatible server
such as the llama.cpp router (`llama serve`). Threads run a native agent loop
inside the provider shim, talking directly to the local server via
`/v1/chat/completions`. The provider ID is `local-models`.

Requires BB 0.46.1 / Plugin SDK 0.6.49 or newer and a local server with
`/v1/models` and `/v1/chat/completions`.

```sh
npm ci --include=dev
npm run typecheck
npm test
bb plugin build .
bb plugin install .
bb provider models local-models
```

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:9931/v1` | Local server endpoint. |
| `defaultModel` | empty | Model for new threads; empty picks the first listed model. |

```sh
bb plugin config local-models set defaultModel 'ggml-org/gpt-oss-20b-GGUF:MXFP4'
```

## Behavior

- Models come from the server's `/v1/models`. The context window is read from
  the llama.cpp router's `--ctx-size` and shown by `bb local-models status`.
- Provider usage shows a single row `Available models: …` with no bar or percent.
- The shim runs its own agent loop against the llama.cpp router: streaming
  chat completions, built-in file and shell tools, MCP tools, reasoning effort
  mapping via `reasoning.ts`, and permission handling for accept-edits mode.
- BB's own MCP tools are pre-approved in the shim.
- Permission modes are `full` and `accept-edits`; gated tool calls request user
  approval inside the shim.
- The plugin registers the agent tool `local_models_ask` for one-shot prompts
  to local models. It is available to threads using other providers; local-models
  threads do not get it to avoid recursive GPU requests.
- The bundled `local-models` skill provides guidance for model choice,
  reasoning levels, and troubleshooting.

## Commands

```sh
bb local-models status [--json]
```
Shows router reachability and model ids, display names, load state, context size
and known reasoning levels.

```sh
bb local-models ask "<prompt>" [--model <id>] [--system <text>] [--max-tokens <n>] [--effort <none|low|medium|high|xhigh>] [--timeout <duration>] [--json]
```
One-shot chat completion without tools. Use `--json` for machine-readable output.

```sh
bb local-models unload <model> | --all
```
Unload a specific model or all models.

## Limits

- Fork, rename, archive, manual compaction and native user questions are not
  supported.
- The router keeps one model loaded at a time; switching costs ~10 s for LFM
  models and minutes for dense models.
- Speed depends on the machine: a model must fit in unified memory with its
  context, or generation drops below 1 token/s.
