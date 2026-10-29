# Local models provider

A native provider for models served locally by an OpenAI-compatible server
such as the llama.cpp router (`llama serve`). Turns run through the installed
`codex` CLI (`codex exec --json`), pointed at the local server. The provider ID
is `local-models`; it does not edit the built-in Codex provider's settings or
the user's `~/.codex/config.toml`.

Requires BB 0.46.1 / Plugin SDK 0.6.49 or newer, an installed `codex` CLI
(tested with 0.164.0) and a local server with `/v1/models` and `/v1/responses`.

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
| `codexCommand` | empty | Absolute `codex` path; empty searches PATH, Homebrew and `~/.local/bin`. |
| `defaultModel` | empty | Model for new threads; empty picks the first listed model. |

```sh
bb plugin config local-models set defaultModel 'ggml-org/gpt-oss-20b-GGUF:MXFP4'
```

## Behavior

- Models come from the server's `/v1/models`. The context window is read from
  the llama.cpp router's `--ctx-size` and shown under the composer from Codex's
  token counts.
- Provider usage lists each model's short name with `∞` instead of a quota bar.
- A small proxy in the ACP shim adapts Codex requests for local chat templates:
  developer messages move into `instructions` (strict templates such as Qwen
  and Gemma reject a system message after the first turn), and MCP tool
  namespaces are flattened and restored in streamed replies so BB agent tools
  work. Other namespaced Codex tools are dropped.
- Local threads run Codex with `--ignore-user-config` and `features.apps=false`:
  your global Codex MCP servers, ChatGPT Apps connectors and config are not
  loaded, which keeps the prompt near 13k tokens instead of 100k+.
- BB's own MCP tools are pre-approved, because headless `codex exec` cannot ask.
- Full maps to `danger-full-access`; Accept Edits maps to `workspace-write`.
  Approval policy is always `never`.

## Limits

- The namespace restore relies on Codex's internal `function_call`
  `namespace` + `name` shape; a Codex update may break BB tool calls while
  plain turns keep working.
- Fork, rename, archive, manual compaction and native user questions are not
  supported.
- Speed depends on the machine: a model must fit in unified memory with its
  context, or generation drops below 1 token/s.
