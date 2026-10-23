## Run your installed Antigravity CLI

Choose Antigravity provider in BB's provider picker and use the agy installation and
login already present on the selected machine. Models and reasoning choices
come from the live CLI, filtered to Google Gemini models including Argon.
Claude and GPT models are excluded. BB provides thread instructions, skills, streaming,
resume, cancellation, and agent tools through its ACP MCP bridge.

## Quotas and updates

Provider usage shows Google quota buckets with short period labels and an Argon suffix and
reset times from agy's native `/usage` command. Every agent can inspect the same data with
`antigravity_limits` or `bb antigravity usage`. Native provider update controls
and `bb updates status` check Google releases and offer an explicit `agy update`.

## Settings

Choose a machine to inspect its real account, CLI version/path, Google models,
subscription quotas, and AI credits. Refresh uses free native CLI commands;
Check CLI updates explicitly requests release discovery. The credit-spending
switch edits agy's global `useG1Credits` setting on that machine, including
sessions outside BB. Merely opening settings never enables credit spending.
Model, reasoning, and permission mode remain per-thread BB controls.

## Requirements and limits

Requires BB 0.46.1, SDK 0.6.49, and an installed, signed-in agy 1.4.6 or newer. The plugin talks to the official
CLI directly; no external adapter is downloaded. Login stays managed by agy.

Full and Accept Edits modes are available. Accept Edits uses agy's terminal
sandbox and native permission policy; native approval-required actions are
soft-denied in headless mode. It does not enforce arbitrary role briefs or
restrict remote administration through external tools. Auto, forks, manual
compaction, native archive/rename, and plan mode are unavailable.
Steering interrupts the running CLI and resumes its conversation with the new
input. Applicable AGENTS.md files are loaded natively and explicitly requested
in each prompt.
Temporary MCP configurations are isolated per session and never replace user
configuration. Local installs update through rebuild and reload; published
plugin updates require a tracking Git or npm installation.
