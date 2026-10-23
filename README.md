# BB plugins

BB plugins maintained by [ShaatLa](https://github.com/ShaatLa).

| Plugin | Description | Source |
| --- | --- | --- |
| Tasks Plus | BB Tasks with existing-thread dispatch, remembered projects, kanban side panel and project defaults. | [tasks-plus](plugins/tasks-plus/) |
| Antigravity provider | Use the installed agy with Google models, BB tools, live quotas and diagnostics. | [provider-antigravity](plugins/provider-antigravity/) |

## Install

Requires BB 0.46.1 or newer. Antigravity additionally requires an installed, signed-in agy 1.4.6 or newer.
For a private repository, Git must have access to this GitHub account.

```sh
bb plugin install git:https://github.com/ShaatLa/bb-plugins.git@main --plugin antigravity

# Disable built-in Tasks before activating its replacement.
# To keep existing task data, follow the Tasks Plus migration guide first.
bb plugin disable tasks
bb plugin install git:https://github.com/ShaatLa/bb-plugins.git@main --plugin tasks-plus
```

Install each plugin independently. Standard BB plugin updates track the selected Git branch.
An existing local-path Antigravity installation must be migrated before installing this source; it is not a second provider.

## Development

```sh
cd plugins/provider-antigravity
npm ci
npm run typecheck
npm test
bb plugin build .
```

The collection manifest is `.bb/plugins.json`. Each plugin owns its dependencies and build.
Antigravity keeps its existing package name (`bb-plugin-antigravity`) and provider ID (`antigravity`) for compatibility.

## Attribution

Antigravity is based on [amrtawfik160/bb-plugin-antigravity](https://github.com/amrtawfik160/bb-plugin-antigravity).
Its original MIT license is preserved in [the plugin directory](plugins/provider-antigravity/LICENSE).
The vendored Button and Switch sources come from the official BB desktop-v0.46.1 component registry.

## Tasks Plus

Tasks Plus retains package name `bb-plugin-tasks-plus`, plugin ID `tasks-plus`, command `bb tasks`, and existing plugin data/settings. The built-in Tasks plugin must remain disabled while Tasks Plus is enabled. See [setup, data migration and behavior](plugins/tasks-plus/README.md).

```sh
cd plugins/tasks-plus
bun install --frozen-lockfile
npm run typecheck
npm test
python3 -m unittest discover -s scripts -p 'test_*.py'
bb plugin build .
```

Tasks Plus is based on the official BB Tasks and required shared UI sources from desktop-v0.46.1. Its original [MIT license](plugins/tasks-plus/LICENSE) and [upstream attribution](plugins/tasks-plus/UPSTREAM.md) are preserved.
