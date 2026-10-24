# BB plugins

A collection of independently installable [BB](https://getbb.app/) plugins maintained by [ShaatLa](https://github.com/ShaatLa).

| Plugin | What it adds | Collection entry / plugin ID | Documentation |
| --- | --- | --- | --- |
| **Antigravity provider** | Google Gemini agents through your existing Antigravity CLI, with BB tools, live quotas and machine diagnostics. | `antigravity` | [README](plugins/provider-antigravity/README.md) |
| **Tasks Plus** | Tasks, epics, kanban, delegation to existing threads, owner actions, structured questions, evidence and Git-friendly project snapshots. | `tasks-plus` | [README](plugins/tasks-plus/README.md) |
| **Delivery Dashboard** | GitHub delivery, CI, pull-request and commit metrics across repositories, with date filters, charts and cached history. | `delivery-dashboard` | [README](plugins/delivery-dashboard/README.md) |

The collection index is [`.bb/plugins.json`](.bb/plugins.json). Each entry points to a separate package under [`plugins/`](plugins/); installing one does not install the others. Package names, plugin IDs and data directories remain unchanged when using this collection.

## Requirements

Use **BB 0.46.1 or newer**, with **Plugin SDK 0.6.49 or newer**. Exact compatibility ranges are declared in each plugin's `package.json`.

Additional requirements depend on the plugin:

- **Antigravity:** an installed, signed-in **`agy` 1.4.6 or newer on each execution machine**. Login and the CLI installation remain managed by Antigravity.
- **Tasks Plus:** disable BB's built-in `tasks` plugin before enabling this replacement. To retain its existing data, migrate **before the first Tasks Plus installation**, as described below.
- **Delivery Dashboard:** GitHub.com repositories. For authenticated access, use the signed-in GitHub CLI on the **BB server machine**, `GH_TOKEN` / `GITHUB_TOKEN`, or the plugin's secret token override. Private repositories require appropriate read access; commit and line statistics require authentication even for public repositories. Other public metrics can use anonymous access with lower rate limits.

## Install from GitHub

Install the plugins you need:

```sh
bb plugin install git:https://github.com/ShaatLa/bb-plugins.git@main --plugin antigravity
bb plugin install git:https://github.com/ShaatLa/bb-plugins.git@main --plugin delivery-dashboard
```

For **Tasks Plus**, first choose whether to [migrate existing built-in Tasks data](#migrate-built-in-tasks-data). If you want an empty tracker, skip migration and install directly:

```sh
bb plugin disable tasks
bb plugin install git:https://github.com/ShaatLa/bb-plugins.git@main --plugin tasks-plus
```

The `--plugin` values are collection entry names. You can also select a directory with `--subdirectory plugins/tasks-plus`, for example. The repository root itself is a collection, not a plugin package.

BB installs dependencies and builds Git installations. Open **Settings → Plugins** to configure each installed plugin. Inspect its active source and status with:

```sh
bb plugin list
bb plugin source tasks-plus --json
```

### Updates

An installation tracking `@main` receives branch changes when you apply an update:

```sh
bb plugin outdated
bb plugin update antigravity
bb plugin update tasks-plus
bb plugin update delivery-dashboard
```

Replace `@main` in an installation URL with a full commit SHA to pin an exact revision. Local-path installations use the checkout on disk; published Git updates do not update them. Rebuild and reload a local installation after updating its checkout.

If a plugin is already installed, check its source before changing installation methods. Keep its existing ID and data rather than installing a renamed copy. In particular, Antigravity remains provider `antigravity`, and built-in Tasks must stay disabled while Tasks Plus is enabled.

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

### Tasks Plus

A replacement for BB's built-in Tasks, retaining the **`bb tasks` CLI** and adding:

- Projects, tasks, epics, subtasks, statuses, priorities, labels, Markdown descriptions, attachments and comments.
- Lists and kanban in the main area and a thread's right panel, with shared project filters, task search and remembered project/view preferences.
- Dispatch to a new agent from a preset or to an existing thread. Busy threads receive queued context; attached cards offer **Go to thread**.
- **Owner actions** for manual work that an agent cannot perform. These cards have distinct styling and an executor filter; agent dispatch is blocked, and completion can notify the initiating thread.
- **Questions** with single/multiple choices, optional free-text answers, recommendations, revision history, a Needs answer filter and answer notifications to the working agent.
- Append-only structured **evidence** for review, QA, merge, deploy and exemptions, plus per-project Markdown description templates.
- Status inclusion/exclusion filters in the CLI, including `--exclude-status done,canceled`.
- Deterministic **export/import** for storing project snapshots in Git: versioned JSON, immutable ID-based task filenames and separate attachment blobs. The current format is **v5**; imports accept v1–v5.
- A write-time guard for common secret patterns in task text, comments and structured content.

Exports do not commit or push Git changes; scheduled synchronization is a separate automation. If an automation validates exports with a closed schema, update that validator before activating a plugin version that changes the archive format. Questions, recommendations and evidence are task data, not automatic approval or completion rules.

[Setup, CLI reference, archive behavior and migration →](plugins/tasks-plus/README.md)

### Delivery Dashboard

Open **Delivery dashboard** in BB's navigation sidebar. Repositories are discovered from BB projects' GitHub remotes; add more in plugin settings or disable automatic discovery.

- Deployment frequency, created/open PRs, PRs with no submitted reviews, CI pass rates/outcomes, default-branch commits and added/deleted lines.
- Deployment and CI charts with clickable interval statistics, rolling presets and custom inclusive UTC date ranges.
- Latest production deployment, with status and links to GitHub.
- Automatic refresh every five minutes by default, a manual Refresh action, persisted snapshots and cached histories for responsive range switching.
- Large CI histories split into smaller time windows; incomplete or unavailable data is identified rather than shown as a complete result.

CI pass rates exclude cancelled and skipped runs; outcome counts still show them. Exact metric definitions, authentication fallbacks, cache coverage and pagination limits are documented in the plugin README.

The Anvil production card also has a project-specific **Deploy production** action: after confirmation it requests `simple-life-app/anvil`'s `production.yaml` workflow on `main`. This requires existing GitHub Actions write access and is not a general-purpose deploy button for other repositories.

[Configuration, metric definitions and deployment behavior →](plugins/delivery-dashboard/README.md)

## Migrate built-in Tasks data

Do this **before installing Tasks Plus for the first time**. Both `tasks` and `tasks-plus` must be disabled, and the destination data directory must not already exist. An existing Tasks Plus installation should keep its current data; this migration is not an update command.

Clone this repository, then run the migration helper from its plugin directory:

```sh
git clone https://github.com/ShaatLa/bb-plugins.git
cd bb-plugins/plugins/tasks-plus
bb plugin disable tasks
python3 scripts/import_tasks.py
bb plugin install git:https://github.com/ShaatLa/bb-plugins.git@main --plugin tasks-plus
```

The helper copies the SQLite database through its backup API, preserves record IDs and attachment files, and rewrites attachment URLs in copied descriptions/comments for `tasks-plus`. The original built-in data remains in place. For another BB data location, pass `--data-dir /path/to/bb-data`.

Old built-in chat mentions and UI view preferences are not migrated. Old chat attachment links may stop opening while built-in Tasks is disabled. Switching back to built-in Tasks does not copy new Tasks Plus changes back automatically. See the [full migration guide](plugins/tasks-plus/README.md#переключение-со-встроенного-плагина).

## Local development

Each plugin owns its dependencies, tests and build; there is no root install or build command.

| Directory | Install development dependencies | Additional requirements/checks |
| --- | --- | --- |
| `plugins/provider-antigravity` | `npm ci --include=dev` | Node with `--experimental-strip-types` support for its native tests; signed-in `agy` for live checks. |
| `plugins/tasks-plus` | `bun install --frozen-lockfile` | `python3 -m unittest discover -s scripts -p 'test_*.py'` for the migration helper. |
| `plugins/delivery-dashboard` | `npm ci --include=dev` | GitHub access for live data checks. |

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

`bb plugin dev` provides a build/reload watcher for an already-installed local directory. Do not enable built-in Tasks alongside a local Tasks Plus installation.

## License and attribution

All three plugins retain MIT licenses and their upstream acknowledgements:

- **Antigravity provider:** inspired by [amrtawfik160/bb-plugin-antigravity](https://github.com/amrtawfik160/bb-plugin-antigravity); original [MIT license](plugins/provider-antigravity/LICENSE) and vendored BB component attribution are retained in the plugin directory.
- **Tasks Plus:** forked from BB Tasks and required shared UI sources at `desktop-v0.46.1`; [MIT license](plugins/tasks-plus/LICENSE), [upstream source details](plugins/tasks-plus/UPSTREAM.md).
- **Delivery Dashboard:** imported from the existing standalone dashboard repository and uses BB shared UI sources; [MIT license](plugins/delivery-dashboard/LICENSE), [upstream source details](plugins/delivery-dashboard/UPSTREAM.md).
