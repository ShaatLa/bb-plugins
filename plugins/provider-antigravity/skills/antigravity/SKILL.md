---
name: antigravity
description: Run Antigravity threads in BB and inspect actual subscription quotas, provider health, and CLI updates.
---
Use `antigravity_limits` with the current machine ID from your instructions to
read remaining percentages and reset times. The tool is available on every
provider, including Antigravity. Never infer quota from available model names.

`bb antigravity usage --host <id> --refresh` reads the same provider data.
`bb settings usage --json` and Provider usage include Antigravity automatically.
`bb antigravity status` and `bb provider models antigravity` inspect registration
and the model catalog. Only Google Gemini models, including Argon, are offered;
Claude and GPT models cannot be selected. Start threads with provider `antigravity`.

Configure `agyCommand` in the plugin's settings.
`bb antigravity diagnostics --host <id> [--check-updates]` reads the same
account, version, Google model catalog, quota, credit and native settings data
shown on the Settings page. Reads do not send model prompts. The Settings
credit-spending switch edits agy's machine-wide `useG1Credits`; it applies
outside BB too. Never enable credit spending without the user's instruction.
Unknown balances and account details remain unknown.
Executables are resolved on the execution machine. The installed `agy` owns
login; this plugin never reads or copies credentials. Quota collection invokes
`agy --disable-slash-commands=false --output-format stream-json -p /usage`;
this is a local slash command, not a model prompt.

`bb updates status` checks CLI releases; BB's provider update controls run
`agy update` only when requested. The plugin never updates agy automatically.
The plugin ships its own ACP facade over agy 1.4.6+ stream-json. No external
adapter is downloaded. Each session has a separate persistent state file.

Use Accept Edits for agy's native `--mode accept-edits --sandbox` policy; Full
passes `--dangerously-skip-permissions`. Auto is unavailable. Native actions
requiring approval are soft-denied in headless mode, without a BB approval
dialog. When a denied turn has no final response, the adapter resumes the same
conversation once to request a permitted alternative or an explicit blocker
report, with no permission change and an instruction against retries or bypasses.
A repeated denial produces a visible notice, not another recovery turn.
The native sandbox and machine-wide permission rules do not enforce
arbitrary role briefs or prevent administration through external tools.

Steering cancels the CLI and resumes the native conversation with the new
input. A CLI ignoring SIGINT is killed after two seconds. Completed side
effects are not rolled back. AGENTS.md is supported natively; prompts also
explicitly request applicable root and nested rules. GEMINI.md is not needed.
Forking, native archive/rename, and manual compaction remain unavailable.
BB passes tools through a separate MCP configuration for each ACP session.
Runtime MCP files are private and removed when the adapter exits normally.
