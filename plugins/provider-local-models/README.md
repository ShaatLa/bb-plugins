# Local models provider

A native provider for models served locally by an OpenAI-compatible server
such as the llama.cpp router (`llama serve`). Threads run a native agent loop
inside the provider shim, talking directly to the local server via
`/v1/chat/completions`; no Codex or other agent CLI is involved. The provider ID
is `local-models`.

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
| `baseUrl` | `http://127.0.0.1:9931/v1` | Local server endpoints, one per line (commas and spaces also work); first wins on duplicate ids. A server on another Mac can name its models `<machine>/owner/Model-GGUF:QUANT` (in that Mac's `models.user.ini`), and the model list shows them as `Model (QUANT) · <machine>`. |
| `defaultModel` | empty | Model for new threads; empty picks the first listed model. |
| `modelGuidance` | empty | Which model suits which work; added to every agent's instructions except local-models threads, from the next thread start. |
| `splash` | `false` | Supervise Splash on demand using Llama.app’s GGUF pool. |
| `splashBinary` | `/opt/homebrew/bin/splash` | Splash executable. |
| `splashPort` | `8010` | Loopback engine port. |
| `splashProxyPort` | `8011` | Loopback proxy port appended to the server list. |
| `splashIdleMinutes` | `10` | Stop Splash after this long without requests. |

```sh
bb plugin config local-models set defaultModel 'ggml-org/gpt-oss-20b-GGUF:MXFP4'
```

## Behavior

- Models come from the server's `/v1/models`. The context window is read from
  the llama.cpp router's `--ctx-size` and shown by `bb local-models status`.
- Local models have no quota, so the provider does not appear in Provider usage.
- The shim runs its own agent loop against the llama.cpp router: streaming
  chat completions, built-in file and shell tools, MCP tools, reasoning effort
  mapping via `reasoning.ts`, and permission handling for accept-edits mode.
- BB's own MCP tools are pre-approved in the shim.
- Threads saved by the earlier Codex-based version continue without their
  earlier context.
- Permission modes are `full` and `accept-edits`; gated tool calls request user
  approval inside the shim.
- A thread spawned by an agent must use `--permission-mode full`: BB denies
  approval requests in agent-sent turns, so accept-edits shell calls fail. Run
  at most one local-models thread per GPU; threads take no Slots use themselves,
  so the parent holds a `local-model` lease and transfers it to the child.
- With a second machine in `baseUrl` (model ids `<machine>/owner/Model-GGUF:QUANT`),
  the plugin registers each answering machine with Machine Slots every minute, so
  each has its own `local-model` slot. A model with a machine prefix leases that
  machine, a model only on this Mac leases `local`, and a model both serve runs on
  whichever machine Slots grants first.
- The plugin registers the agent tool `local_models_ask` for one-shot prompts
  to local models. It is available to threads using other providers; local-models
  threads do not get it to avoid recursive GPU requests. It queues behind other
  Machine Slots `local-model` work and fails after 20 minutes; failures carry
  the fix (for example, where to find model ids).
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
Run from a thread, it takes a Machine Slots `local-model` use first, like
`local_models_ask`.

```sh
bb local-models unload <model> | --all
```
Unload one model, or every loaded model with `--all` (including ones other
threads use). Pass one or the other, not both. Run from a thread, unload first
takes a Machine Slots `local-model` use, so it waits for running local-model
requests instead of cutting them off.

```sh
bb local-models splash-setup '<llama model id>'
bb local-models splash-status [--json]
```
Splash variants (`splash/<llama id>`, shown with “ · Splash”) appear when a supported
Llama.app model and its draft are present. Supported families: Qwen3.6-35B-A3B,
Qwen3.8-27B, Flint and Inkling-2-Mini. The setup command explicitly downloads each family’s DFlash2
draft into `~/models/incoai`, resumes partial files and verifies the weights’ size
and SHA-256. Transfers are announced in the plugin log before downloading; CLI
output is buffered by the SDK. Drafts are never downloaded automatically.

When enabled, the proxy reads `~/Library/Application Support/Llama/models.ini`.
Selecting a variant unloads Llama.app’s loaded models, starts Splash on the same
GGUF, and streams completions through the proxy. Cold starts return 503 for the
shim to retry (up to ten minutes for readiness). Switching models stops the
previous Splash process; idle shutdown and plugin disposal stop it too. Logs are
in `splash.log` in the plugin data directory. Splash runs in language-only mode.
The status command reports the model, pid, port and time left before idle shutdown.

### Models outside Llama.app

```sh
bb local-models splash-setup 'unsloth/Inkling-2-Mini-GGUF:UD-Q4_K_M'
bb local-models splash-models [--json]
bb local-models splash-delete '<model id>'
```
A supported family can also run on Splash without Llama.app. `splash-setup` with
an upstream `owner/Repo-GGUF:VARIANT` id pulls that single-file GGUF into
`~/models/splash/<owner>/<repo>/`, resuming a partial file and checking its size
and LFS SHA-256 before the file appears, then downloads the family's draft.
When the repository has a top-level vision projector (`mmproj-*.gguf`), it is
pulled beside the model the same way (BF16 first, then F32, F16, Q8_0) and Splash
starts with `--mmproj`, so the model accepts images; without one it serves text
only. Run `splash-setup` again to add a projector to a model pulled before.
Llama.app models stay text only on Splash.
Such a model is listed as `splash/<id>`, and Splash picks its context window.
`splash-models` and the settings section **Splash models outside Llama.app** list
every pulled model, including interrupted downloads, with sizes, drafts and paths.
`splash-delete` (or **Delete**) removes the GGUF and, when no other model of the
family uses it, the draft; the projector goes with the repository's last
variant; a running model is refused. The Splash CLI has no model
management of its own; the plugin starts Splash only on local files
(`--model-dir`, `--draft-model`, `--mmproj`).

## Usage journal

Every model request (thread steps, `local_models_ask`, `bb local-models ask`) appends one line of token counts to `bridge-data/usage.jsonl` in the plugin data dir: model, engine, prompt/cached/completion/reasoning tokens as llama reports them (prompt includes cached, completion includes reasoning), duration and time to first token. No prompt or reply text is stored. The file rotates at 8 MB to `usage.1.jsonl` (one old file kept). Other plugins read it through the `usage.list` RPC (`{after?, limit?}` → `{entries, nextCursor}`, oldest first; `nextCursor` is null once caught up). Thread entries carry `providerThreadId`, not the BB thread id. Writing is best effort and never fails a request.

## Limits

- Fork, rename, archive, manual compaction and native user questions are not
  supported.
- The router keeps one model loaded at a time; switching costs ~10 s for LFM
  models and minutes for dense models.
- Speed depends on the machine: a model must fit in unified memory with its
  context, or generation drops below 1 token/s.

## Splash control center

The **Splash** settings section shows requirements, process state, and every
Llama.app model's draft and context. The normal settings fields on the same page
manage servers, enablement, binary, ports and idle minutes.

Splash requires arm64, macOS 26.4+, and an Apple M3 or later. Detection shows
unified memory, Llama.app's installed version and first-server router health,
Homebrew, Splash's version, and available updates. Once Splash is installed, its
`libexec/engine/splash device-check` is authoritative. Unsupported machines keep
using Llama.app. “Get Llama.app” opens its [official site](https://llama.app/).
Homebrew's official bootstrap command is displayed for the user to run; the
plugin never runs it. Install/Update requires a dialog confirming the exact
`brew install incoai/tap/splash` or `brew upgrade incoai/tap/splash` command, streams
output in the section and logs it, then detects requirements again. No sudo or
telemetry is used.

With Splash enabled, a verified `splash/<id>` variant replaces its exact plain
Llama id in provider/shim/status lists. Unsupported, missing-GGUF and
unverified-draft models remain on Llama.app. Saved threads with a hidden plain
id keep routing to its original server. Existing drafts without a verification
receipt need an explicit **Download** action (or `splash-setup`): valid existing
weights are hashed against HF metadata without downloading them again. Cancel
keeps partial transfers for resume; Delete removes that family's draft and
partials and is refused while the family is running.

Context is merged per key from Llama.app's generated
`~/Library/Application Support/Llama/models.ini` and
`~/.config/llama/models.user.ini` (user values win). Edits atomically change only
`ctx-size`, preserving other lines and comments; **Default** removes the key.
The GGUF native window bounds edits; approximate model/KV memory warnings are
shown. Splash applies a window at its next start, with a restart action for the
running model. Llama.app applies it after restarting the app. Splash first
starts without a context flag to learn its reported limit, then restarts with
`--max-context` if the configured window fits; later starts reuse that limit.
An above-limit value from an externally edited INI never adds a context flag.

```sh
bb local-models context '<llama model id>' <tokens|default>
bb local-models doctor [--json]
bb local-models install-splash
```

The CLI uses the same download, context, detection and explicit install functions
as the settings RPCs. `install-splash` detects requirements again, upgrades an
outdated installation or installs a missing one, and logs the exact command before
execution. Updates are found with `brew outdated incoai/tap/splash`, so they appear
once Homebrew has refreshed the tap. SDK CLI output is buffered; live command
output is available in settings and the plugin log. Tests use temporary GGUF,
INI and draft fixtures, fake downloads, fake commands and a fake Splash HTTP
process; they never install or start real engines.

### Restricted-sandbox verification

The loopback HTTP tests are written but cannot execute in a sandbox that rejects
`listen(127.0.0.1)` with `EPERM`. The affected checks are:

- `bridge.test.ts`: public provider bridge conformance.
- `models.test.ts`: installed model listing; caps-file reasoning; multi-server
  merging; Splash preference/provider and stored-id routing over HTTP.
- `server.test.ts`: CLI/native-tool integration with the fake router.
- `shim.test.ts`: native tool loop and session persistence; caps/tool guards/context
  trimming/waiting; Splash labels/failed-props cache; hidden Llama-id resume/routing.
- `splash.test.ts`: streaming/switching/idle/disposal; startup cancellation/readiness
  failure; user context restart and above-native flag omission.

Config editing, GGUF native metadata, fake
transfers and cancellation, receipts and tamper rejection, shared controls,
requirements/install fakes, provider registration, URL/name helpers and routing
with an in-memory fetch transport can run without listeners. Real install,
real-engine and visual app verification are intentionally not performed.
