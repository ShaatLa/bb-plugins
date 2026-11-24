# BB plugins

A collection of independently installable [BB](https://getbb.app/) plugins maintained by [ShaatLa](https://github.com/ShaatLa).

| Plugin | What it adds | Collection entry / plugin ID | Documentation |
| --- | --- | --- | --- |
| **Spawn Gate** | Project-specific one-use admissions for agent and CLI starts; enforcement off by default. | `spawn-gate` | [README](plugins/spawn-gate/README.md) |
| **Agent Hub** | A messenger-style inbox for your questions and the agents' answers, questions agents ask you, quote replies, reply pools and saved messages. | `agent-hub` | [README](plugins/agent-hub/README.md) |
| **Antigravity provider** | Google Gemini agents through your existing Antigravity CLI, with BB tools, live quotas and machine diagnostics. | `antigravity` | [README](plugins/provider-antigravity/README.md) |
| **CI Dashboard** | GitHub Actions health, run timings, agent-readable CI metrics, and PR/deployment context with cached history. | `ci-dashboard` / `delivery-dashboard` | [README](plugins/ci-dashboard/README.md) |
| **Idle Compact** | Compacts a Claude Code thread idle for 50 minutes with 100k+ tokens of context while its prompt cache is still warm, so waking it does not rewrite the whole context. | `idle-compact` | [README](plugins/idle-compact/README.md) |
| **Local models provider** | Local llama.cpp (OpenAI-compatible) models with a built-in agent loop, BB tools, a context indicator, optional Splash engine and unlimited usage. | `local-models` | [README](plugins/provider-local-models/README.md) |
| **Machine Slots** | Advisory per-host pools, gate checks, transferable leases and dev-server ports. | `slots` | [README](plugins/slots/README.md) |
| **Tokenomos** | Token usage and API-equivalent cost across Claude Code, Codex, local-model and Antigravity threads: four ranges, project filter, token mix, hourly heatmap, compaction and local-model savings estimates, top threads, and a watchlist of large live contexts. | `tokenomos` | [README](plugins/tokenomos/README.md) |
| **Work Board** | Tasks, epics, kanban, delegation to existing threads, owner actions, structured questions, evidence and Git-friendly project snapshots. | `work-board` | [README](plugins/work-board/README.md) |

The collection index is [`.bb/plugins.json`](.bb/plugins.json). Each entry points to a separate package under [`plugins/`](plugins/); installing one does not install the others. Each package has its own plugin ID and data directory. Work Board 0.11.0 replaces the former Agent Board and Tasks Plus identities; existing users must complete its [migration](plugins/work-board/README.md#migrating-from-agent-board--tasks-plus-to-work-board-0110) before switching. CI Dashboard uses the `ci-dashboard` collection entry and retains the internal `delivery-dashboard` plugin ID to preserve settings, secrets, cached history and existing links. The old collection entry remains an update/install alias.

## Requirements

Use **BB 0.46.1 or newer**, with **Plugin SDK 0.6.49 or newer**. Exact compatibility ranges are declared in each plugin's `package.json`. The SDK comes with BB; it is not a separate user installation step.

Additional requirements depend on the plugin:

- **Antigravity:** an installed, signed-in **`agy` 1.4.6 or newer on each execution machine**. Login and the CLI installation remain managed by Antigravity.
- **Local models:** a running local OpenAI-compatible server (for example llama.cpp's `llama serve`) on each execution machine. No Codex or other agent CLI is needed. The optional Splash engine needs Homebrew, arm64, macOS 26.4+ and Apple M3 or later.
- **Work Board:** disable BB's built-in `tasks` plugin before enabling this replacement. To retain its existing data, migrate **before the first Work Board installation**, as described below.
- **CI Dashboard:** GitHub.com repositories. For authenticated access, use the signed-in GitHub CLI on the **BB server machine**, `GH_TOKEN` / `GITHUB_TOKEN`, or the plugin's secret token override. Private repositories require appropriate read access; commit and line statistics require authentication even for public repositories. Other public metrics can use anonymous access with lower rate limits.

## Install from GitHub

Run these commands in BB's terminal, or a shell with `bb` on PATH. **Git must be available on the BB server machine**, with network access to GitHub and the npm registry. This public collection does not require a GitHub login to download; plugin-specific account requirements are listed above.

BB supplies its own npm/Node tooling for Git installations. You do **not** need to clone the repository, install npm/Bun yourself, or run the development commands below. Cloning is only needed for local development or the optional built-in Tasks migration helper.

Install the plugins you need:

```sh
bb plugin install git:https://github.com/ShaatLa/bb-plugins.git@0.x --plugin agent-hub --tag-prefix agent-hub/
bb plugin install git:https://github.com/ShaatLa/bb-plugins.git@0.x --plugin antigravity --tag-prefix antigravity/
bb plugin install git:https://github.com/ShaatLa/bb-plugins.git@0.x --plugin ci-dashboard --tag-prefix ci-dashboard/
bb plugin install git:https://github.com/ShaatLa/bb-plugins.git@0.x --plugin idle-compact --tag-prefix idle-compact/
bb plugin install git:https://github.com/ShaatLa/bb-plugins.git@0.x --plugin local-models --tag-prefix local-models/
bb plugin install git:https://github.com/ShaatLa/bb-plugins.git@0.x --plugin tokenomos --tag-prefix tokenomos/
```

For **Work Board**, first choose whether to [migrate existing built-in Tasks data](#migrate-built-in-tasks-data). If you want an empty tracker, skip migration and install directly:

```sh
bb plugin disable tasks
bb plugin install git:https://github.com/ShaatLa/bb-plugins.git@0.x --plugin work-board --tag-prefix work-board/
```

The `--plugin` values are collection entry names. You can also select a directory with `--subdirectory plugins/work-board`, for example. The repository root itself is a collection, not a plugin package.

BB installs dependencies and builds Git installations. Open **Settings → Plugins** to configure each installed plugin. Inspect its active source and status with:

```sh
bb plugin list
bb plugin source work-board --json
```

### Updates

Each plugin is released as a version tag `<entry>/vX.Y.Z` (for example `work-board/v0.59.4`), created automatically when its `package.json` version changes on `main`. The install commands above track every `0.x` release of one plugin; BB checks the tags and applies the newest compatible release when you update:

```sh
bb plugin outdated
bb plugin update antigravity
bb plugin update work-board
bb plugin update --all
```

`bb plugin outdated` offers a 1.0 or later release outside the `0.x` range separately; take it with `bb plugin update <id> --range '^1.0.0'`. Use a narrower range such as `^0.59.0` to receive patches only, or a tag such as `@work-board/v0.59.4` to pin one release. Installing `@main` instead tracks every commit on the branch, including unreleased work. Local-path installations use the checkout on disk; published Git updates do not update them. Rebuild and reload a local installation after updating its checkout.

If a plugin is already installed, check its source before changing installation methods. Keep its existing ID and data rather than installing a renamed copy. In particular, Antigravity remains provider `antigravity`, and built-in Tasks must stay disabled while Work Board is enabled.

## Plugins

### Agent Hub

Open **Agent Hub** in BB's navigation sidebar; its badge counts unread answers and open questions for you. The plugin pairs each message you send in a thread with the final answer of that turn, so answers do not get lost among agent output.

- **Inbox**: conversations on the left, grouped by project (drag to reorder) with a resizable column, running-thread indicators and BB's thread context menu; the selected thread's history on the right opens at the first unread message.
- A composer like BB's: voice input, attachments, scheduled sends, drafts, steering an active turn, and BB's queue card for queued messages (edit, reschedule, reorder, send now, delete). Project, branch and context usage sit under the composer.
- **Awaiting answer**, **Asked of you**, **Saved** and **History** views with search, a project filter and **Mark all read** with undo.
- Quote replies: select text in an answer to reply with a quote, or collect quotes from one thread in a **Reply pool** and send them together. BB's chat gains **Save to Agent Hub**, **Add to reply pool** and **Comment** (send a quoted comment on the selected text).
- Agent tools: `agent_hub_defer` and `agent_hub_list`/`agent_hub_resolve` link a delayed answer to its question; `agent_hub_ask` asks you a question, optionally with choices and a recommendation.
- An optional provider usage summary under the conversation list, and notifications for questions asked of you (needs the Push Notifications plugin) with quiet hours.

```sh
bb agent-hub list --view waiting
bb agent-hub digest --since 24h
```

[Interface, limits and settings →](plugins/agent-hub/README.md)

### Antigravity provider

Select **Antigravity provider** in BB's provider picker. The plugin uses the `agy` executable and login on the selected machine; it does not install another CLI or copy credentials.

- Google Gemini model discovery, including Argon, and supported reasoning choices from the live CLI.
- Streaming, conversation resume, cancellation and BB agent tools through an ACP/MCP bridge.
- Per-machine account, executable/version, quota/reset and AI-credit diagnostics in settings.
- Native CLI update checks and explicit `agy update` through BB's provider update controls.
- Full and Accept Edits permission modes; see the plugin README for headless approval behavior and unsupported session controls.

If `agy` is outside PATH and `~/.local/bin`, configure `agyCommand` in the plugin's settings. The optional credit-spending switch changes Antigravity's machine-wide setting, including sessions outside BB; simply installing the plugin or reading diagnostics does not enable it.

```sh
bb provider models antigravity
bb antigravity usage --refresh
bb antigravity diagnostics --host <machine-id>
```

[Setup, permissions and limitations →](plugins/provider-antigravity/README.md)

### CI Dashboard

Open **CI Dashboard** in BB's navigation sidebar. Agents can use `ci_dashboard_metrics` for read-only CI summaries, timings and health signals; see the plugin documentation for cached/fresh query examples. Repositories are discovered from BB projects' GitHub remotes; add more in plugin settings or disable automatic discovery.

- Deployment frequency, created/open PRs, PRs with no submitted reviews, CI pass rates/outcomes, default-branch commits and added/deleted lines.
- Deployment and CI charts with clickable interval statistics, rolling presets and custom inclusive UTC date ranges.
- Latest production deployment, with status and links to GitHub.
- Automatic refresh every five minutes by default, a manual Refresh action, persisted snapshots and cached histories for responsive range switching.
- Large CI histories split into smaller time windows; incomplete or unavailable data is identified rather than shown as a complete result.

CI pass rates exclude cancelled and skipped runs; outcome counts still show them. Exact metric definitions, authentication fallbacks, cache coverage and pagination limits are documented in the plugin README.

An optional **Deploy to production** action appears on the production card when Settings → Plugins → CI Dashboard names a production repository and workflow file (blank by default). After confirmation it dispatches that workflow on the configured ref; this needs GitHub Actions write access for that repository. Job-level CI signals (runner pool stalls, runner losses, reruns, flaky jobs, network/tool failures) appear in the CI health card and through `ci_dashboard_metrics` views.

[Configuration, metric definitions and deployment behavior →](plugins/ci-dashboard/README.md)

### Local models provider

Select **Local models** in BB's provider picker. Models come from the local servers' `/v1/models`; the plugin runs its own agent loop against `/v1/chat/completions`, without Codex or another agent CLI.

- Streaming, resume, cancellation, file and shell tools, MCP and BB agent tools; strict chat templates keep their user/assistant alternation.
- Context window indicator under the composer. Local models have no quota, so the provider is not listed in Provider usage.
- `local_models_ask` agent tool and `bb local-models ask` for one-shot prompts from other threads; they queue behind Machine Slots `local-model` work.
- Optional Splash engine: a settings section checks requirements, installs or updates Splash with Homebrew after confirmation, and adds `splash/<id>` model variants; models outside Llama.app can be pulled, listed and deleted for Splash.
- A token-only usage journal that Tokenomos reads; no prompt or reply text is stored.
- Settings for server URLs, default model and Splash.

```sh
bb provider models local-models
bb plugin config local-models set defaultModel '<model-id>'
```

[Setup, behavior and limitations →](plugins/provider-local-models/README.md)

### Work Board

Existing Agent Board and Tasks Plus users: follow the plugin’s [identity migration guide](plugins/work-board/README.md#migrating-from-agent-board--tasks-plus-to-work-board-0110). Disable the installed predecessor (`agent-board` or `tasks-plus`), copy its database/blobs and restore settings; changing the install command alone does not migrate data. Update automations and agent roles from `bb agent-board` / `bb tasks` to `bb work-board` before removing the old command.

A replacement for BB's built-in Tasks, using the **`bb work-board` CLI** and adding:

- Projects, tasks, epics, subtasks, statuses, priorities, labels, Markdown descriptions, attachments and comments.
- Lists and kanban in the main area and a thread's right panel, with shared project filters, task search and remembered project/view preferences.
- Dispatch to a new agent from a preset or to an existing thread. Busy threads receive queued context; attached cards offer **Go to thread**.
- **Owner actions** for manual work that an agent cannot perform. These cards have distinct styling and an executor filter; agent dispatch is blocked, and completion can notify the initiating thread.
- **Questions** with single/multiple choices, optional free-text answers, recommendations, revision history, a Needs answer filter and answer notifications to the working agent.
- Append-only structured **evidence** for review, QA, merge, deploy and exemptions, plus per-project Markdown description templates.
- Status inclusion/exclusion filters in the CLI, including `--exclude-status done,canceled`.
- Deterministic **export/import** for storing project snapshots in Git: versioned JSON, immutable ID-based task filenames and separate attachment blobs. The current format is **v8** with marker `bb-work-board`; imports accept v1–v8 and both legacy markers (`bb-agent-board`, `bb-tasks-plus`).
- A write-time guard for common secret patterns in task text, comments and structured content.

Exports do not commit or push Git changes; scheduled synchronization is a separate automation. If an automation validates exports with a closed schema, update that validator before activating a plugin version that changes the archive format. Questions, recommendations and evidence are task data, not automatic approval or completion rules.

[Setup, CLI reference, archive behavior and migration →](plugins/work-board/README.md)

## Migrate built-in Tasks data

For built-in Tasks only, do this **before installing Work Board for the first time**. Existing Agent Board or Tasks Plus users must use `--source-plugin agent-board` or `--source-plugin tasks-plus` and the identity migration guide above. Both `tasks` and `work-board` must be disabled, and the destination data directory must not already exist. An existing Work Board installation should keep its current data; this migration is not an update command.

Clone this repository, then run the migration helper from its plugin directory:

```sh
git clone https://github.com/ShaatLa/bb-plugins.git
cd bb-plugins/plugins/work-board
bb plugin disable tasks
python3 scripts/import_tasks.py
bb plugin install git:https://github.com/ShaatLa/bb-plugins.git@0.x --plugin work-board --tag-prefix work-board/
```

The helper copies the SQLite database through its backup API, preserves record IDs and attachment files, and rewrites attachment URLs in copied descriptions/comments for `work-board`. The original built-in data remains in place. For another BB data location, pass `--data-dir /path/to/bb-data`.

Old built-in chat mentions and UI view preferences are not migrated. Old chat attachment links may stop opening while built-in Tasks is disabled. Switching back to built-in Tasks does not copy new Work Board changes back automatically. See the [full migration guide](plugins/work-board/README.md#switching-from-the-built-in-plugin).

## Local development

Each plugin owns its dependencies, tests and build; there is no root install or build command.

| Directory | Install development dependencies | Additional requirements/checks |
| --- | --- | --- |
| `plugins/agent-hub` | `npm ci` | None; tests use an in-memory SQLite database. |
| `plugins/provider-antigravity` | `npm ci --include=dev` | Node with `--experimental-strip-types` support for its native tests; signed-in `agy` for live checks. |
| `plugins/ci-dashboard` | `npm ci --include=dev` | GitHub access for live data checks. |
| `plugins/idle-compact` | `npm ci` | None; `python3 scripts/measure.py` reads local Claude transcripts. |
| `plugins/provider-local-models` | `npm ci --include=dev` | Node with `--experimental-strip-types` support; a running local model server for live checks. |
| `plugins/work-board` | `bun install --frozen-lockfile` | `python3 -m unittest discover -s scripts -p 'test_*.py'` for the migration helper. |

From the chosen plugin directory, after installing its dependencies:

```sh
npm run typecheck
npm test
bb plugin build .
bb plugin install .
```

For subsequent local changes:

```sh
bb plugin build .
bb plugin reload <plugin-id>
```

To run a released version on your own machine and keep its settings, install it from its tag:

```sh
scripts/install-release.sh work-board          # newest work-board/v* tag
scripts/install-release.sh work-board 0.59.4   # one release
```

It builds the tag into `releases/<entry>-<version>` next to the checkout (override with `BB_PLUGIN_RELEASES`) and installs that path; bb moves an existing local-path install of the same plugin and keeps its settings, and refuses to replace a Git or npm install. Keep that directory while the version is installed.

`bb plugin dev` provides a build/reload watcher for an already-installed local directory. Do not enable built-in Tasks alongside a local Work Board installation.

## License and attribution

All plugins retain MIT licenses and their upstream acknowledgements:

- **Antigravity provider:** inspired by [amrtawfik160/bb-plugin-antigravity](https://github.com/amrtawfik160/bb-plugin-antigravity); original [MIT license](plugins/provider-antigravity/LICENSE) and vendored BB component attribution are retained in the plugin directory.
- **Local models provider:** built on the Antigravity provider's ACP bridge and usage source; [MIT license](plugins/provider-local-models/LICENSE).
- **Work Board:** forked from BB Tasks and required shared UI sources at `desktop-v0.46.1`; [MIT license](plugins/work-board/LICENSE), [upstream source details](plugins/work-board/UPSTREAM.md).
- **CI Dashboard:** imported from the existing standalone dashboard repository and uses BB shared UI sources; [MIT license](plugins/ci-dashboard/LICENSE), [upstream source details](plugins/ci-dashboard/UPSTREAM.md).
