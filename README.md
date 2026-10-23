# BB plugins

BB plugins maintained by [ShaatLa](https://github.com/ShaatLa).

| Plugin | Description | Source |
| --- | --- | --- |
| Antigravity provider | Use the installed agy with Google models, BB tools, live quotas and diagnostics. | [provider-antigravity](plugins/provider-antigravity/) |

## Install

Requires BB 0.46.1 or newer and an installed, signed-in agy 1.4.6 or newer.
For a private repository, Git must have access to this GitHub account.

```sh
bb plugin install git:https://github.com/ShaatLa/bb-plugins.git@main --plugin antigravity
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
