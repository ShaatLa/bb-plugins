# Migration from delivery-dashboard (0.6.0)

Read when you migrate from delivery-dashboard, verify the cutover or roll it back.

Disable delivery-dashboard, then install ci-dashboard. On first start it imports the old database, KV (including observer deduplication), and declared settings. Keep the old installation disabled until the import is verified and signed off. Secrets are not copied; set the token again if needed. An enabled old installation or initialized target state blocks migration; reload ci-dashboard after resolving the reported reason. The private staged backup is retained in the new plugin data directory.

While migration is done and delivery-dashboard is still registered (enabled or disabled), ci-dashboard stays in verification mode. It polls GitHub, stores history and rebuildable caches, and serves read views, but sends no observer messages or push notifications and refuses claims, subscriptions, Investigate and other user mutations. Observer deduplication, subscriptions, incidents and handled state remain unchanged, including inactive-repository KV. Problems show migrated incidents plus fresh run analysis; incident tracking resumes at GO so pending pushes are not consumed. The metrics overview reports `cutover: "verifying"`; entering and leaving the mode each produces one log line. Native setting writes (`bb plugin config ci-dashboard set`, the Settings page) are not refused: the host saves them before the plugin sees them, and the plugin only suppresses their observer side effects. Do not change settings during verification; a rollback would not carry them back.

After sign-off, remove the old installation with `bb plugin remove delivery-dashboard`. Its removal ends verification on the next signal-loop tick; pending events use the existing deduplication and are delivered once.

To roll back during verification, disable ci-dashboard and enable delivery-dashboard. Nothing is lost: the old namespace has not diverged, except for rebuildable caches and history that the old plugin re-fetches. After GO, new claims, subscriptions and delivery state are not copied back.
