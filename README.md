# BB plugins

A collection of independently installable [BB](https://getbb.app/) plugins maintained by [ShaatLa](https://github.com/ShaatLa).

| Plugin | What it adds | Collection entry / plugin ID | Documentation |
| --- | --- | --- | --- |
| **Antigravity provider** | Google Gemini agents through your existing Antigravity CLI, with BB tools, live quotas and machine diagnostics. | `antigravity` | [README](plugins/provider-antigravity/README.md) |
| **Agent Board** | Tasks, epics, kanban, delegation to existing threads, owner actions, structured questions, evidence and Git-friendly project snapshots. | `agent-board` | [README](plugins/agent-board/README.md) |
| **CI Dashboard** | GitHub Actions health, run timings, agent-readable CI metrics, and PR/deployment context with cached history. | `ci-dashboard` / `delivery-dashboard` | [README](plugins/ci-dashboard/README.md) |

The collection index is [`.bb/plugins.json`](.bb/plugins.json). Each entry points to a separate package under [`plugins/`](plugins/); installing one does not install the others. Each package has its own plugin ID and data directory. Agent Board 0.10.0 replaces the former Tasks Plus identity; existing users must complete its [migration](plugins/agent-board/README.md#переход-с-tasks-plus-на-agent-board-0100) before switching. CI Dashboard uses the `ci-dashboard` collection entry and retains the internal `delivery-dashboard` plugin ID to preserve settings, secrets, cached history and existing links. The old collection entry remains an update/install alias.

## Requirements

Use **BB 0.46.1 or newer**, with **Plugin SDK 0.6.49 or newer**. Exact compatibility ranges are declared in each plugin's `package.json`. The SDK comes with BB; it is not a separate user installation step.

Additional requirements depend on the plugin:

- **Antigravity:** an installed, signed-in **`agy` 1.4.6 or newer on each execution machine**. Login and the CLI installation remain managed by Antigravity.
- **Agent Board:** disable BB's built-in `tasks` plugin before enabling this replacement. To retain its existing data, migrate **before the first Agent Board installation**, as described below.
- **CI Dashboard:** GitHub.com repositories. For authenticated access, use the signed-in GitHub CLI on the **BB server machine**, `GH_TOKEN` / `GITHUB_TOKEN`, or the plugin's secret token override. Private repositories require appropriate read access; commit and line statistics require authentication even for public repositories. Other public metrics can use anonymous access with lower rate limits.

## Install from GitHub

Run these commands in BB's terminal, or a shell with `bb` on PATH. **Git must be available on the BB server machine**, with network access to GitHub and the npm registry. This public collection does not require a GitHub login to download; plugin-specific account requirements are listed above.

BB supplies its own npm/Node tooling for Git installations. You do **not** need to clone the repository, install npm/Bun yourself, or run the development commands below. Cloning is only needed for local development or the optional built-in Tasks migration helper.

Install the plugins you need:

```sh
bb plugin install git:https://github.com/ShaatLa/bb-plugins.git@main --plugin antigravity
bb plugin install git:https://github.com/ShaatLa/bb-plugins.git@main --plugin ci-dashboard
```

For **Agent Board**, first choose whether to [migrate existing built-in Tasks data](#migrate-built-in-tasks-data). If you want an empty tracker, skip migration and install directly:

```sh
bb plugin disable tasks
bb plugin install git:https://github.com/ShaatLa/bb-plugins.git@main --plugin agent-board
```

The `--plugin` values are collection entry names. You can also select a directory with `--subdirectory plugins/agent-board`, for example. The repository root itself is a collection, not a plugin package.

BB installs dependencies and builds Git installations. Open **Settings → Plugins** to configure each installed plugin. Inspect its active source and status with:

```sh
bb plugin list
bb plugin source agent-board --json
```

### Updates

An installation tracking `@main` receives branch changes when you apply an update:

```sh
bb plugin outdated
bb plugin update antigravity
bb plugin update agent-board
bb plugin update delivery-dashboard
```

Replace `@main` in an installation URL with a full commit SHA to pin an exact revision. Local-path installations use the checkout on disk; published Git updates do not update them. Rebuild and reload a local installation after updating its checkout.

If a plugin is already installed, check its source before changing installation methods. Keep its existing ID and data rather than installing a renamed copy. In particular, Antigravity remains provider `antigravity`, and built-in Tasks must stay disabled while Agent Board is enabled.

## Plugins

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

### Agent Board

Existing Tasks Plus users: follow the plugin’s [identity migration guide](plugins/agent-board/README.md#переход-с-tasks-plus-на-agent-board-0100). Disable `tasks-plus`, copy its database/blobs and restore settings; changing the install command alone does not migrate data. Update automations and agent roles from `bb tasks` to `bb agent-board` before removing the old command.

A replacement for BB's built-in Tasks, using the **`bb agent-board` CLI** and adding:

- Projects, tasks, epics, subtasks, statuses, priorities, labels, Markdown descriptions, attachments and comments.
- Lists and kanban in the main area and a thread's right panel, with shared project filters, task search and remembered project/view preferences.
- Dispatch to a new agent from a preset or to an existing thread. Busy threads receive queued context; attached cards offer **Go to thread**.
- **Owner actions** for manual work that an agent cannot perform. These cards have distinct styling and an executor filter; agent dispatch is blocked, and completion can notify the initiating thread.
- **Questions** with single/multiple choices, optional free-text answers, recommendations, revision history, a Needs answer filter and answer notifications to the working agent.
- Append-only structured **evidence** for review, QA, merge, deploy and exemptions, plus per-project Markdown description templates.
- Status inclusion/exclusion filters in the CLI, including `--exclude-status done,canceled`.
- Deterministic **export/import** for storing project snapshots in Git: versioned JSON, immutable ID-based task filenames and separate attachment blobs. The current format is **v8** with marker `bb-agent-board`; imports accept v1–v8 and the legacy marker.
- A write-time guard for common secret patterns in task text, comments and structured content.

Exports do not commit or push Git changes; scheduled synchronization is a separate automation. If an automation validates exports with a closed schema, update that validator before activating a plugin version that changes the archive format. Questions, recommendations and evidence are task data, not automatic approval or completion rules.

[Setup, CLI reference, archive behavior and migration →](plugins/agent-board/README.md)

### CI Dashboard

Open **CI Dashboard** in BB's navigation sidebar. Agents can use `ci_dashboard_metrics` for read-only CI summaries, timings and health signals; see the plugin documentation for cached/fresh query examples. Repositories are discovered from BB projects' GitHub remotes; add more in plugin settings or disable automatic discovery.

- Deployment frequency, created/open PRs, PRs with no submitted reviews, CI pass rates/outcomes, default-branch commits and added/deleted lines.
- Deployment and CI charts with clickable interval statistics, rolling presets and custom inclusive UTC date ranges.
- Latest production deployment, with status and links to GitHub.
- Automatic refresh every five minutes by default, a manual Refresh action, persisted snapshots and cached histories for responsive range switching.
- Large CI histories split into smaller time windows; incomplete or unavailable data is identified rather than shown as a complete result.

CI pass rates exclude cancelled and skipped runs; outcome counts still show them. Exact metric definitions, authentication fallbacks, cache coverage and pagination limits are documented in the plugin README.

The Anvil production card also has a project-specific **Deploy production** action: after confirmation it requests `simple-life-app/anvil`'s `production.yaml` workflow on `main`. This requires existing GitHub Actions write access and is not a general-purpose deploy button for other repositories.

[Configuration, metric definitions and deployment behavior →](plugins/ci-dashboard/README.md)

## Migrate built-in Tasks data

For built-in Tasks only, do this **before installing Agent Board for the first time**. Existing Tasks Plus users must use `--source-plugin tasks-plus` and the identity migration guide above. Both `tasks` and `agent-board` must be disabled, and the destination data directory must not already exist. An existing Agent Board installation should keep its current data; this migration is not an update command.

Clone this repository, then run the migration helper from its plugin directory:

```sh
git clone https://github.com/ShaatLa/bb-plugins.git
cd bb-plugins/plugins/agent-board
bb plugin disable tasks
python3 scripts/import_tasks.py
bb plugin install git:https://github.com/ShaatLa/bb-plugins.git@main --plugin agent-board
```

The helper copies the SQLite database through its backup API, preserves record IDs and attachment files, and rewrites attachment URLs in copied descriptions/comments for `agent-board`. The original built-in data remains in place. For another BB data location, pass `--data-dir /path/to/bb-data`.

Old built-in chat mentions and UI view preferences are not migrated. Old chat attachment links may stop opening while built-in Tasks is disabled. Switching back to built-in Tasks does not copy new Agent Board changes back automatically. See the [full migration guide](plugins/agent-board/README.md#переключение-со-встроенного-плагина).

## Local development

Each plugin owns its dependencies, tests and build; there is no root install or build command.

| Directory | Install development dependencies | Additional requirements/checks |
| --- | --- | --- |
| `plugins/provider-antigravity` | `npm ci --include=dev` | Node with `--experimental-strip-types` support for its native tests; signed-in `agy` for live checks. |
| `plugins/agent-board` | `bun install --frozen-lockfile` | `python3 -m unittest discover -s scripts -p 'test_*.py'` for the migration helper. |
| `plugins/ci-dashboard` | `npm ci --include=dev` | GitHub access for live data checks. |

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

`bb plugin dev` provides a build/reload watcher for an already-installed local directory. Do not enable built-in Tasks alongside a local Agent Board installation.

## License and attribution

All three plugins retain MIT licenses and their upstream acknowledgements:

- **Antigravity provider:** inspired by [amrtawfik160/bb-plugin-antigravity](https://github.com/amrtawfik160/bb-plugin-antigravity); original [MIT license](plugins/provider-antigravity/LICENSE) and vendored BB component attribution are retained in the plugin directory.
- **Agent Board:** forked from BB Tasks and required shared UI sources at `desktop-v0.46.1`; [MIT license](plugins/agent-board/LICENSE), [upstream source details](plugins/agent-board/UPSTREAM.md).
- **CI Dashboard:** imported from the existing standalone dashboard repository and uses BB shared UI sources; [MIT license](plugins/ci-dashboard/LICENSE), [upstream source details](plugins/ci-dashboard/UPSTREAM.md).
