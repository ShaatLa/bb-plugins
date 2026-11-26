---
name: ci-dashboard
description: Read GitHub Actions CI metrics, health signals and run timings for agents; configure or explain the CI Dashboard sidebar plugin.
---

# CI Dashboard

Open **CI Dashboard** in the navigation sidebar (pipeline icon), route `/plugins/ci-dashboard/dashboard`. It no longer appears on New thread.

Configure in Settings → Plugins → CI Dashboard:
- `repository`: additional GitHub `owner/repo` entries, comma-, whitespace-, or newline-separated. Existing single entries remain valid.
- `importBbRepositories`: enabled by default. Imports GitHub `gitRemoteUrl` values from all BB projects on each refresh, skipping non-GitHub hosts and missing remotes. SSH/SCP, HTTPS, and Git formats work. Entries are de-duplicated case-insensitively. Disable to use only the manual list.
- `token`: optional secret override. Blank uses `GH_TOKEN`, then `GITHUB_TOKEN`, then the active GitHub.com account from `gh auth token --hostname github.com` on the BB server machine. Never print credentials or pass them in chat. The token is not copied to settings or sent to the frontend. Without credentials, public-repo access is anonymous.
- `refreshSeconds`: integer 30–3600; default 300. Applies without reload.

## When the tools are offered

The agent tools `ci_dashboard_metrics` and `ci_dashboard_manage` are offered only in sessions of a BB project whose GitHub remote the dashboard shows: `importBbRepositories` is on, or `repository` lists that repository. Sessions in other projects get this skill but not the tools; there, read CI data with the `ci` RPC and change state with the `manage` RPC (both below). A changed remote or setting applies when the session is next started or resumed.

No custom CLI is needed: native ci_dashboard_metrics and the discoverable read-only ci RPC provide agent access. Use `bb plugin config ci-dashboard` for non-secret settings, and the settings UI for credentials. Build with `bb plugin build <plugin-path>` before install or release.

## References

- [references/dashboard.md](references/dashboard.md): Read when you explain or change the dashboard page, its cards, ranges, caching and storage, or draft deferrals.
- [references/diagnostics.md](references/diagnostics.md): Read when you interpret CI health problems and alerts, the shared Workflow and Event choice, or timing diagnostics.
- [references/observers.md](references/observers.md): Read when you handle observer event lines: event types, noise control, latency and deployment lines.
- [references/migration.md](references/migration.md): Read when you migrate from delivery-dashboard, verify the cutover or roll it back.

## Agent access

Use `view=lanes` for seven UTC days of successful full-attempt wall and per-lane p50/p90 timings and sample counts; optional `event` selects a pipeline. Data comes from the local job store.

Use the native **ci_dashboard_metrics** tool to read CI data. For example:

```json
{"repository":"acme/app","selection":{"days":7},"refresh":false}
```

Omit repository for all configured dashboard repositories; a `ref` drill-down requires `repository` when several are configured (for example `{"repository":"acme/app","ref":"job:123"}`). Selection defaults to seven days and accepts the same presets or inclusive UTC custom dates as the UI, limited to the past year. Cached local snapshots are returned immediately when available, even if stale; you must inspect source, updatedAt, ageSeconds, stale and pending before drawing conclusions. Set refresh to true for a forced GitHub collection in `view=summary`; other views ignore refresh and selection. A cold range also collects automatically and can take time. The report includes pass rate, CI history errors, conclusion counts, default-branch/PR health, workflow failure signals, elapsed timing statistics in milliseconds and slow-run IDs. Diagnostic IDs link to https://github.com/OWNER/REPO/actions/runs/ID or /actions/workflows/ID. Unavailable/partial data stays explicitly unavailable; it is never converted to a passing result. Cancelled/skipped are excluded from pass rates; timing statistics use successful runs only (timing.basis = success). Timing caveats are the same as in the UI.

Pass `view` for one job-level slice from the local store: `signals`, `stall`, `losses`, `failures`, `reruns`. `stall` returns the live pool queues plus `poolTimings` (per runner pool: `jobs` and p50/p90 `queueWaitMs` and `durationMs`) and `poolTimingsByEvent`; there is no separate `pools` view. Failure and rerun rows carry the run `event` (`pull_request`, `push`, `merge_group`). `failureCountsByEvent` splits `failureCounts` by event.

Index views are compact and hand out *refs* (breadcrumbs); pull exactly the detail you need by ref instead of reading dumps. Each response stays far below an agent's tool-output cap (index views about 8 KB at most: rows are cut by size and the cut is counted in `moreProblems` / `moreSignals` / `moreFailures` / `moreReruns`; inspections about 4 KB).

- `view=problems|signals`: problem rows carry `id, severity, title, what, since, handled, refs[2-4], url`; signal rows carry `id, kind, severity, title, what, since, actor, ref` (no url: the ref's inspection returns the link).
- `view=failures`: `{ref: "job:<id>", run: "run:<id>:<attempt>", name, class, event, at, queuePullRequest?, queueOnly?}` (no annotations, excerpts or urls). `view=reruns`: `{ref: "run:<id>", queue?: "queue:<id>:<attempts>", workflow, event, queuePullRequest?, attempts, outcomes, final, repeatedRunnerMs}`. `view=losses`: tallies, `massCancels` rows (`ref: "mass_cancel:<time>"`, run refs) and `recentLosses` (job refs).
- Drill down: call the same tool with `ref=<ref>` (optional `repository`; `view`, `selection`, `refresh` and `event` are then ignored). The result is `{ref, kind, summary, facts, related[], next?}` built from memory and the local store only (no GitHub requests), with ids, names, classes and labels but never log text, annotations, signature matches or env values. Exception: `job:`/`queue:` refs of a `real` failure carry `failureMessages` (test name → the first failure message of a failed test (its assertion or error lines up to the stack, at most 200 characters, with env assignments, tokens, credentials and home paths redacted)). `related` lists up to 12 refs, newest first, then `+N more`; `next` suggests actions such as `ci_dashboard_manage action=take id=...`. Walk index view → ref → related ref.
- Ref forms: `job:<jobId>`, `run:<runId>[:<attempt>]`, `queue:<runId>:<attempt>` (the observer's queue key; `confirmation` is confirmed, pending or rejected), `pool:<name>`, `pr:<number>`, `sha:<sha or 7+ hex chars>`, and problem or signal ids (`run:streak:<runId>`, `run:main:<runId>`, `runner_loss:<jobId>`, `flake:<jobId>`, `transient:<jobId>`, `timeout:<jobId>`, `rerun_failed:<runId>:<attempt>`, `pool_stall:<pool>`, `mass_cancel:<time>`). An unknown, malformed or ambiguous ref (for example a short sha matching two commits) returns an error that lists these forms. Only jobs that failed within the stored window (plus live jobs) are known by job ref.

The read-only `ci` RPC is discoverable via `bb plugin rpc inspect ci-dashboard ci`. It accepts the same JSON input and can be called by other plugins or agents with `bb plugin rpc call ci-dashboard ci --input-file query.json --json`. No custom CLI is required. This interface does not dispatch deployments or expose authorization tokens, settings, raw commit history or unused API payloads. Existing UI RPC methods remain private to discovery.

New native tools become available when BB next constructs the provider session; an existing agent can use the CLI/RPC immediately after reload.

`ci_dashboard_metrics` never writes to GitHub: it triggers no deployments, reruns, cancellations or other writes. All writes live in `ci_dashboard_manage`, which writes only plugin state and the `observerThreads` setting. Inspect `errors` too, next to the freshness fields above. Signals are deploy-agnostic: they come from run and job facts only, not from deployment tooling. A merge_group failure row with `queueOnly` passed on the PR and fails only in the merge queue. Job-level data comes from a local store filled by a budgeted backfill of job history, so you must check `backfill.remaining` and `backfill.coveredSince` before concluding something did not happen.

## Observer threads

CI events can be pushed to BB threads so an agent watching CI is told instead of polling. Each message is one short Markdown line starting with **CI Dashboard** (bold); refs, problem ids and shas are inline code, and the GitHub link is a short `[run N]`/`[job N]` link, with ids and a GitHub link, sent with `threads.send` in `queue-if-active` mode: a busy agent gets it after its current turn, an idle agent wakes up. Green runs never produce messages.

An observer receives events, and "Claim dropped" lines, only for the GitHub repository of its own BB project (the project's `gitRemoteUrl`); a thread in a project without a GitHub remote receives none, and its confirmation line says "no repositories".

How to set the observer: Settings → CI Dashboard → `observerThreads` (comma-separated `thr_…` ids; blank turns the feature off), or the agent tool **ci_dashboard_manage** (the one write tool; `ci_dashboard_metrics` is read-only):

```json
{"action":"subscribe"}
```

`subscribe` adds the calling thread (or `threadId`), `unsubscribe` removes it, `list` shows the current observers, and `replace` makes the thread the only observer and returns the removed thread ids in `removed` (empty if none). Removed threads receive no removal notice; the caller must inspect `removed`. Take-over flow for a new manager session: call `replace` with no `threadId`; the previous manager stops receiving events at once and the new thread gets a one-line confirmation (`[CI Dashboard] Subscribed to CI events for <repos>: <types>; quiet window <m> min`). You must call `subscribe` when you start watching CI and `unsubscribe` when you stop; use `replace` only when taking over all observer delivery. Threads assigned by subscribe or replace must exist and not be archived; unsubscribe can remove a stale id. Archived or deleted threads, and threads whose messages fail with 404, are removed from the list automatically. Other send failures are logged once per thread and not retried. A change to `observerThreads` (from the tool or the settings UI) takes effect immediately for new subscribers and from the next loop for events.

A newly subscribed thread gets one confirmation line and no history. Observer actions return the observer list and the enabled event types.

Event types, noise control and latency: [references/observers.md](references/observers.md).

## Claiming problems

When you or a worker start on a CI problem, you must claim it so the CI health status shows it without a human clicking Investigate. Problem ids: `ci_dashboard_metrics` with `view=problems` (smallest; also in `view=signals`) (`problems[].id`) or the ` · problem <id>` tail of an observer line (pass that id to `ci_dashboard_manage`).

Use the agent tool **ci_dashboard_manage** with a problem action (`id` is required):

```json
{"action":"take","id":"pool_stall:self-hosted"}
```

- `take`: investigating by `threadId` (default: this thread). When you delegate, pass the worker's `threadId` so the card links to the worker. The thread must exist and not be archived.
- `fix_pending` requires `ref` identifying the fix (`#12`, `FIX-1` or a URL, up to 80 characters); CI inspection refs such as `pr:12` are refused. Omit `threadId` to preserve the current worker; an explicit worker must exist and be active.
- `release`: back to open. `dismiss`: nobody needs to act.
- `repository` (owner/repo) is needed only when several repositories are configured. An unknown or closed id is an error. The result includes `previous` (the old handled state or null) and the new `handled` state, also visible in `ci_dashboard_metrics`.

You do not have to clean up: a claim closes itself when the signal resolves, is dropped when its investigating thread is archived or deleted (`fix_pending` outlives its thread), and expires after `claimTimeoutHours` (default 24, `0` = never). Observers get `[CI Dashboard] Claim dropped · <title> · problem <id> · <reason>` for each automatic drop, never for changes made through the tool.

The discoverable `manage` RPC takes the same input as the tool. Actions needing a thread require explicit `threadId` over RPC. Write `{ "action": "subscribe", "threadId": "thr_example" }` to `f.json`, then run:

```sh
bb plugin rpc call ci-dashboard manage --input-file f.json --json
```

### Manage input rules

You must pass only the fields accepted by the action; unused fields are refused before any state change. For example, `{"action":"take","id":"pool_stall:self-hosted","threadId":"thr_example"}` delegates a claim; `ref` belongs only to `fix_pending`.

| Action | Accepted fields besides action |
| --- | --- |
| take | id (required), repository, threadId |
| fix_pending | id and ref (required), repository, threadId |
| release, dismiss | id (required), repository |
| subscribe, unsubscribe, replace | threadId |
| list | none |

Problem actions require repository when several repositories are configured. The tool defaults threadId to its caller; fix_pending preserves the current worker when omitted. The discoverable manage RPC requires an explicit threadId for take and subscription changes. For example, `{"action":"subscribe","threadId":"thr_example"}` works over RPC.

Claim changes are allowed across threads, including a lead marking a delegated worker's fix pending. Every problem-action result includes `previous` and `handled` (null means open); callers must inspect `previous` to see replaced claims. For example, a lead can call `{"action":"fix_pending","id":"pool_stall:self-hosted","ref":"#12"}` and keep the worker. Observer replacement returns `removed`; callers must inspect it because removed threads receive no removal notice.

Investigate is read-only: agents must report evidence and a proposed fix, and must not rerun workflows, cancel runs or change CI configuration without the owner's request. For example, inspect `job:123` and report the cause before proposing a rerun. These instructions govern the investigating agent; CI Dashboard cannot enforce actions taken through external tools.
