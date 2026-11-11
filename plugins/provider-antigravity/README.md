# Antigravity provider

A native provider for the existing `agy` installation and login on each BB
machine. Built using the public BB Plugin SDK and ACP provider bridge; inspired
by https://github.com/amrtawfik160/bb-plugin-antigravity. The provider ID is
`antigravity`; it does not edit the built-in ACP provider's settings.

Requires BB 0.46.1 / Plugin SDK 0.6.49 or newer and an installed, signed-in `agy`.
Requires agy 1.4.12 or newer. Set `agyCommand` in the plugin's native settings if it
is outside PATH and `~/.local/bin`. The plugin does not install, replace, or
copy agy or its credentials.

```sh
npm ci
npm run typecheck
npm test
bb plugin build .
bb plugin install .
bb provider models antigravity
bb antigravity usage --refresh
```

The plugin's Settings page combines the native executable setting with a
machine selector and live diagnostics: signed-in account, installed/latest CLI
version, executable path, Google models and reasoning levels, subscription
quotas and resets, and AI credits. Refresh does not send a model prompt;
release discovery runs only when Check CLI updates is requested. CLI updates
still use BB's native provider update controls. Diagnostics are cached per machine
for one minute in the plugin app session, including across settings navigation.
Expired data stay visible while a spinner indicates a background refresh;
Refresh and Check CLI updates always request a new read. In-flight reads are
shared across remounts, and confirmed credit-policy changes update the cache.
Settings controls use the BB desktop-v0.46.1 registry Button and Switch source;
the native machine select shares the compact Button sizing and theme tokens.

The Use AI credits switch reads and edits `useG1Credits` in the selected
machine's native agy settings. It applies outside BB too and is never enabled
by plugin installation or a diagnostics read. Saving preserves unrelated JSON
keys, uses a private atomic replacement, and rejects stale revisions, malformed
files, or symlinks. Revisions detect edits seen before saving; agy itself does
not participate in a shared file lock. Model, reasoning, and permission choices
remain in BB's thread controls. The same diagnostics are available through
`bb antigravity diagnostics --host <id> [--check-updates]`.

Antigravity appears in the provider picker and provider settings. Only Google
Gemini models, including Argon, are offered; Claude and GPT entries are excluded.
Live models and supported reasoning efforts come from agy. BB owns thread instructions,
skills, context, timeline, streaming, resume, cancellation, and its agent tools.
Tools reach agy through the standard ACP MCP proxy. Each session adds a private
temporary workspace containing its MCP configuration, so sessions do not
rewrite or share the user's global or project MCP files. This uses agy's
native `--add-dir` support. Session directories are removed on normal exit;
OS termination with SIGKILL can leave temporary files until machine cleanup.

Provider usage discovers the plugin through `provider-usage.v1.listResources`
and `provider-usage.v1.getResource`. It shows Google quota buckets from `/usage`
with compact labels (`5h`, `7d`, `7d · Argon`) and reset
times. Claude/GPT quotas are excluded. The active login email replaces the
provider name in the card when agy reports it. agy 1.4.6 exposes this only in
its login log: collection uses a private temporary log and deletes it after
reading the email, including on failure. Raw logs are never returned to BB.
Unknown plan, account identity, or cost stays unknown. Collection is
machine-local, has a timeout, caches successful observations for 60 seconds,
and supports explicit refresh. Failed collections are never presented as zero
usage. All agents can call `antigravity_limits` with their current machine ID;
they also receive a short instruction describing that tool.

`bb updates status` and BB's native provider update controls compare the
installed CLI with Google's GitHub release. Update execution is an explicit
host-managed `agy update` command with post-update version verification.
Offline checks do not invent an update. Plugin updates use the ordinary BB
plugin manager after this fork is published and installed from a tracking Git
or npm source. A local-path installation tracks local builds and reloads;
it cannot receive published plugin updates.

The plugin ships a small ACP facade over the official agy stream-json interface.
It does not download an external adapter or another agy. Provider session IDs
are bound to native conversation IDs from the CLI's init/result events, so
concurrent conversations cannot be confused by database-directory polling.
Each session has its own private, atomically written state file. Resume loads
that binding and invokes agy with its native --conversation option.
Both CLI discovery and execution run on the selected BB host.

Permission modes are Full and Accept Edits. Full passes agy's explicit
`--dangerously-skip-permissions`; Accept Edits instead passes `--mode accept-edits
--sandbox` without that bypass. Auto is unavailable. The terminal sandbox must
be supported by the execution host; agy's machine-wide permission rules still
apply. In headless mode, native actions requiring approval are soft-denied,
not shown as BB approval dialogs. If a denied turn ends without a final response,
the adapter resumes the same conversation once to ask for a permitted alternative
or an explicit blocker report. It never changes permissions; the recovery prompt
forbids repeating or bypassing the denied action. A repeated denial ends with a
visible blocker notice. This recovery can use one additional model turn.
This is not an ACL for role briefs or remote
administration; restrict credentials, network access, and external tools
separately before using a dev environment.

Accept Edits sessions also receive a private `bb_review` stdio MCP server with
three tools: `memory` (`search`, `get`, `catalog`), `git` (read-only inspection),
and `read_file` (UTF-8, 256 KiB per call, byte offset pagination). Use these tools
first for review work. Native shell approvals remain unchanged. Git supports
`rev-parse`, `log`, `show`, `diff`, `status`, `ls-tree`, `cat-file`, `merge-base`,
and `branch --show-current`; only safe refs and listed display flags are accepted.
It rejects arbitrary options, shell text, config overrides and output files,
and disables optional index writes, external diff/textconv, fsmonitor and lazy fetch.
Command output is bounded to 256 KiB with a 15-second timeout.

Read roots are the session worktree and BB's `BB_THREAD_STORAGE`. When BB's
`thread get --self --json` confirms a parent, its sibling thread-storage directory
is also granted read access. Missing metadata grants no parent access; paths
in model prompts never expand the roots. Symlinks are resolved before containment
checks; only regular files are read. Parent storage is never added as an agy
workspace (which would also grant native writes).

The adapter uses agy's session-only `--settings` to allow exactly
`mcp(bb_review/memory)`, `mcp(bb_review/git)` and `mcp(bb_review/read_file)`.
Existing native allow/ask/deny rules are preserved; explicit asks and denials
still take precedence. Full mode is unchanged. No machine-wide settings are
written. MCP was chosen over command-prefix allow rules because read-looking
git commands also accept write/output options and can invoke external helpers.
See Google's [permission matching](https://antigravity.google/docs/permissions?tab=cli)
and [settings reference](https://antigravity.google/docs/settings?tab=cli), plus
`agy --help`. The official 1.4.6 binary has no `--settings` option; this
plugin now requires the verified 1.4.12 CLI for session-only permission rules.

To verify after the owner releases and reloads the plugin, start a new Accept
Edits child thread. Ask it to use `bb_review` to read `rev-parse HEAD`, `diff HEAD`,
search and get a known BB memory, and read an artifact placed in its parent's
thread storage. Compare the head with the parent's `git rev-parse HEAD`.
Ask the MCP tools for `checkout`, `diff --output=...`, and an unrelated absolute
file path: each must return an error without changing files. A native action
outside these tools should retain its existing approval behavior. No new user
settings are required; explicit native MCP ask/deny rules can still block these
tools. Automated checks: `npm run typecheck`, `npm test`, `bb plugin build .`.

Messages sent as a steer interrupt the current CLI process and resume its
native conversation with the new input. The adapter terminates tracked descendant processes, including PTY children.
A CLI ignoring SIGINT is killed after two seconds. Already completed side effects
are not rolled back; remote jobs or processes already reparented outside the
tracked ancestry can outlive cancellation. An interruption
before the CLI supplies a conversation ID cannot preserve native history.

agy discovers `AGENTS.md` natively; `GEMINI.md` is not required. Each prompt also
explicitly asks the agent to read applicable root and nested `AGENTS.md` files
in full. BB's role instructions, skills, and memory index continue through the
standard ACP bridge. BB sends them only in a new session's first prompt, so the shim keeps
that block with the session and adds a pointer to a saved copy to every
prompt; after context compression or a resumed session the agent rereads it. Prompts travel directly over stdin as stream-json, so
large instruction sets do not depend on reading a temporary prompt file.

Fork, native user questions, native archive and rename, manual compaction,
and plan mode are not advertised. BB tools such as user-input forms remain
available through MCP.

Sources: [BB provider API](https://github.com/get-bb/bb/blob/main/docs/provider-plugin-api.md),
[Antigravity CLI](https://github.com/google-antigravity/antigravity-cli),
[MCP configuration](https://antigravity.google/docs/mcp).
