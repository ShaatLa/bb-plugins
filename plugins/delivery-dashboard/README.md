# Delivery Dashboard for BB

Adds a responsive **Delivery dashboard** page in BB's sidebar with GitHub deployment frequency, open PR count, and CI pass rate for multiple repositories. Refreshes every five minutes by default, with an immediate Refresh icon button. The same reload icon spins while loading, keeping its size and respecting reduced-motion preferences. External links use compact icons.

Open **Delivery dashboard** using the package icon in BB’s navigation sidebar. The page route is `/plugins/delivery-dashboard/dashboard`; the old homepage section is removed.

## Setup

Install from the collection:

```sh
bb plugin install git:https://github.com/ShaatLa/bb-plugins.git@main --plugin delivery-dashboard
```

For local development:

```sh
npm ci --include=dev
npm run build
bb plugin install . --yes
```

GitHub repositories are discovered automatically from BB projects' `gitRemoteUrl` fields on each refresh. HTTPS, SSH, SCP-style (`git@github.com:owner/repo.git`), and Git URLs are supported. Other Git hosts and projects without a recorded remote are skipped. Each repository has summary cards, green history charts, CI outcome counts, a review queue, the latest production deployment, and a repository activity block for the selected range.

Open **Settings → Plugins → Delivery Dashboard** to adjust:

- **Additional GitHub repositories** (`repository`): comma-, whitespace-, or newline-separated `owner/repo` entries. Existing single-repository settings continue to work. Automatic and manual entries are de-duplicated case-insensitively.
- **Include GitHub repositories from BB projects** (`importBbRepositories`): enabled by default; disable to track only the manual list.
- **GitHub token override** (`token`): optional secret override. When blank, the backend checks `GH_TOKEN`, then `GITHUB_TOKEN`, then the active GitHub.com account from [`gh auth token`](https://cli.github.com/manual/gh_auth_token), matching BB's GitHub CLI authorization. The CLI must be installed and authenticated on the **BB server machine**. If no credential is available, public repositories use anonymous access with GitHub's lower rate limit. No token is returned to the browser, logged, or copied into plugin settings.
- **Refresh interval** (`refreshSeconds`): integer 30–3600, default 300. Changes apply without reload.

Private repositories require read access to Actions, Deployments, Pull requests, and Contents (for commit statistics). Existing system credentials keep their current permissions; the plugin does not request more scopes. A BB discovery failure is displayed while manual repositories remain available; use Refresh to retry discovery.

## Date range

Use **Date range** to select 1 day, 3 days, 1 week, 2 weeks, 1 month (30 days), or 3 months (90 days). The default is one week. The 1-day preset means today from 00:00 UTC through refresh time; other presets are rolling periods ending at refresh time. **Custom dates** exposes From/Through date pickers and an Apply dates button; both calendar dates are included in UTC, with today's endpoint capped at refresh time. Invalid, reversed, future dates and dates before the UTC calendar date one year ago are rejected (February 29 maps to February 28 in a non-leap year).

The filter applies to deployment frequency, created PRs, commits and changed lines, CI pass rate/outcomes, and both charts across all repositories. Open PRs, the review queue, and the latest production deployment show current state independently of the selected range. Each section uses the BB project name (or a readable repository name for manual entries), with a compact UTC date range and exact timestamps on hover. Switching ranges keeps the previous results and their captions visible until the replacement arrives; superseded responses are ignored. The selection survives sidebar navigation within the app window.

Click any bar in either chart (or focus it and press Enter/Space) to open **Interval statistics** for that repository. The popup shows compact UTC dates with exact interval endpoints on hover, deployment count, created PRs, default-branch commits and added/deleted lines, CI pass rate, and CI outcomes. It loads on demand without clearing the dashboard. Empty bars are also clickable. Future intervals are disabled. Bars may represent four hours for today, an hour for a custom day, a rolling day, or multiple days, depending on the selected range; the popup always uses the actual bar interval, excluding shared boundaries from the earlier bar. The popup stays within the dashboard pane intersected with the visible viewport, including when a native browser pane is open beside it or the split is resized; it also follows zoom, panning, and on-screen keyboard changes; narrow cards stack and long content scrolls vertically. Close with Close, Escape, or a backdrop click. Failed popup requests can be retried; unavailable metrics retain their own explanations.

## Metric definitions

| Metric | Definition |
| --- | --- |
| Deploy frequency | Number of GitHub deployment records created in the selected range divided by its duration in days. Includes all environments and outcomes, so deployment attempts are counted, not just successful production deploys. |
| PRs created | All PRs opened within the selected range, including drafts and PRs that are now closed or merged. Independent of the current open-PR count. |
| Commits | Unique commits in the default branch's reachable history, filtered by committed date within the same selected window. The default-branch name is displayed. |
| Lines added / deleted | Sum of GitHub's per-commit additions/deletions for that commit dataset, across all files (including documentation and generated files). Includes merge commits as reported by GitHub. These are cumulative changed lines, not net repository growth or a count of current source-code lines. |
| Open pull requests | GitHub Search's current open PR count, including drafts. Incomplete search results produce an error. |
| CI pass rate | Successful / completed GitHub Actions workflow runs excluding cancelled and skipped created in the selected range × 100. Includes every branch and workflow; neutral completed runs remain in the denominator. Cancelled and skipped runs are excluded from the pass rate and chart but remain visible in CI outcomes. No remaining completed runs displays “—”. |
| CI outcomes | Counts by conclusion from the same completed-run dataset as the chart and pass rate: passed, failed, cancelled, skipped, and any other reported conclusions such as timed out. “Failed” is the GitHub failure conclusion; timeouts are shown separately. |
| PRs awaiting review | Non-draft open PRs matching GitHub's `review:none` filter, meaning no review has been submitted yet. Shows the total and the five oldest, with links. Age is since PR creation, not time since a review request. |
| Latest production deployment | The newest deployment flagged `production_environment: true` or whose environment is named `production` (case-insensitive). Shows the latest status, environment/ref, creation age, status-update time, and an HTTPS log link, falling back to the repository's deployments page. No status is shown as “unknown”. |

[GitHub deployments API](https://docs.github.com/en/rest/deployments/deployments), [search API](https://docs.github.com/en/rest/search/search), and [workflow runs API](https://docs.github.com/en/rest/actions/workflow-runs) supply the data. For complete histories, CI pass rate, daily series, and outcomes are computed from one dataset, avoiding races with a separate success-count query. Duplicate run IDs are de-duplicated. If counts change during pagination, incomplete histories are hidden and retried on the next refresh; the summary falls back to GitHub count queries.

Opening the dashboard first reads a local server snapshot, then updates from GitHub in the background. The default weekly snapshot is also collected by a background service while the dashboard is closed, using the configured refresh interval. Snapshots survive BB/plugin restarts in plugin-owned SQLite; the eight most recently used ranges are retained. No credentials are stored in snapshot data. Changing settings invalidates snapshots, and refreshes started under older settings cannot replace them. Concurrent refreshes of the same range share one GitHub collection.

The display budget of 600 ms applies to an existing local snapshot. The first collection after installation, a settings change, or selection of an uncached range still requires GitHub; it shows an explicit loading state rather than invented values. Last checked shows the snapshot's actual collection time. Refresh requests fresh data without hiding current cards or charts. Frontend polling runs only while mounted and cleans up on unmount; sidebar remounts additionally reuse the current window's in-memory snapshot. No repository data is stored in browser storage. Requests abort on plugin unload and have a 20-second timeout per API request. Failed RPC refreshes preserve displayed values with a stale-data warning. Deployment pagination continues until the selected window is complete, without a 1,000-record cap. GitHub.com is the supported host.

Each repository also has deployment-throughput and CI-pass-rate bar charts with six four-hour buckets for today (00:00, 04:00, 08:00, 12:00, 16:00, 20:00 UTC), hourly buckets for custom single-day ranges, six 12-hour buckets for the rolling three-day preset, daily buckets up to two weeks, and larger whole-day buckets (at most 14) for longer ranges. Today’s future intervals show “—” and cannot be opened; the current interval ends at refresh time. Deployment frequency for today is the deployment count since midnight. The final bucket may be shorter; hover descriptions give its actual boundaries. Dates and hover descriptions use UTC. Zero deployment counts stay zero; days with no completed CI runs show “—”. CI history splits searches above GitHub’s 1,000-run limit into disjoint UTC intervals, then paginates each interval. Pass rate, charts and outcomes use the complete combined dataset, ignoring truncated large-search counts (including GitHub’s 2,500 cap). Failed or inconsistent pagination is unavailable; fallback count summaries are limited to searches of at most 1,000 runs. More than 1,000 runs created in the same second cannot be split further and are unavailable. Production discovery scans newest deployments until a production record is found or the list ends, independently of the selected metric window. Deployment-list requests shared by frequency and production discovery are reused within the refresh.

Commit and line statistics use the [GitHub GraphQL Commit API](https://docs.github.com/en/graphql/reference/commits), which requires authorization even for public repositories. With no system/override token, PR activity can still load and commit/line values show “—” with an explanation. The first page captures the default branch's head commit; remaining pages query that immutable head. All selected commits are read with de-duplication, cursor-cycle protection and completeness checks. Malformed, partial, or failed responses produce unavailable commit/line values instead of partial sums. An empty repository or a genuinely empty seven-day history gives zero.

## Development

```sh
npm test
npm run typecheck
npm run build
```

The backend defines validated settings and schema-checked RPC. The frontend uses BB's sidebar nav panel slot and theme tokens with vendored Button and Card components. Tests cover calculations, pagination, missing data, API errors, settings/RPC validation, system authorization precedence, repository import and de-duplication, secret handling, multiple repository rendering, outcome counts, review queues and ages, production status/link validation, interval refresh, stale values, timer cleanup, preset/custom date validation, UTC endpoints, backend query ranges, and out-of-order filter responses through BB's official testing APIs.

Review filtering follows [GitHub review search qualifiers](https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests#search-by-pull-request-review-status-and-reviewer); production status data follows the [deployment statuses API](https://docs.github.com/en/rest/deployments/statuses).

CI history first determines whether a search needs splitting, then fetches each leaf search’s remaining pages concurrently (at most nine more). A shared four-request budget covers all repositories, interval requests and background refreshes. Per-request deadlines start after queueing. Counts, unique run IDs, UTC boundaries and final pagination markers are checked before showing complete history.


The Anvil production card includes **Deploy production**. Confirming starts `simple-life-app/anvil`'s `production.yaml` workflow on `main`, preserving its verification, Development-delivery check, and GitHub approvals. The target is fixed; arbitrary repositories, refs, and workflow paths cannot be supplied. The backend checks that Anvil is still configured/imported and blocks overlapping dispatch requests. The existing GitHub authorization must have [Actions write permission](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event). Success means the workflow was requested, not that production has deployed; use View workflow to follow it. Requests are never retried automatically; after an unconfirmed request, check GitHub before trying again.

Repository headings link directly to their GitHub repository using BB’s standard URL opener (the right Browser pane when the built-in browser is selected). Normal link modifiers and copy-link behavior remain available. The dashboard uses a package icon in the sidebar and plugin branding.

The window retains eight range snapshots keyed by configuration and selection. Returning to a loaded range renders its cards immediately while metrics refresh in the background. Completed superseded requests still populate their own cache entry, without replacing the current view; settings changes invalidate pending cache writes. Persisted snapshots only seed ranges absent from memory, so polling cannot reapply older server data.

Complete deployment, CI and commit records are stored with their source snapshot in plugin-owned SQLite. An uncached preset or custom range contained in a stored history is computed locally, anchored to the source snapshot’s endpoint and last-checked time. The local snapshot returns immediately with the created-PR count marked pending; the regular metrics request fills that count separately. Current open PRs, reviews and production reuse the source snapshot. Ranges outside stored coverage require a first GitHub collection; existing aggregate-only snapshots need one refresh to acquire raw history.

Fresh range snapshots are reused until refreshSeconds expires; changing dates does not start another full collection while the cached data is fresh. The Refresh button explicitly forces collection, and expired data refreshes in the background.


Side cards use their content height. Expand **Latest failed runs** in CI health for up to five workflow runs with the failure conclusion, created in the displayed range, with workflow/title, creation time and GitHub run links. Expand **Recent production deployments** for the five latest deployments in the latest production deployment’s environment, with status, ref, SHA and creation time. Compare links use adjacent immutable deployment SHAs and are omitted for identical SHAs. A failed status lookup is shown as unavailable. These lists load only on expansion, share the four-request GitHub budget and 20-second timeout, and keep their response while that snapshot is displayed; closing/reopening does not fetch again. A changed range or refreshed snapshot resets the lists. Errors offer Retry details. Production history is independent of the selected historical range. Refresh uses an inline SVG reload icon so its shape does not depend on the host icon-name mapping.


Repository history is shared across date selections in SQLite, independently of the eight rendered range snapshots. Overlapping requests extend the stored coverage; routine refreshes retain at most the rolling 90-day span unless an explicitly requested custom range needs older data. Repository history refreshes are coalesced across selections. A fresh contained view reuses that history and only obtains its range-specific PR creation count. Snapshot derivation is fully local and never resolves GitHub authorization or waits for a PR API request; unavailable creation counts are marked pending, not zero. Historical dates remain anchored to the source endpoint and timestamp.

Refreshes publish ready repository cards on the metrics-progress channel before the full request settles. The page accepts only its selected range, rejects older request generations, and displays pending fields explicitly. A slow commit history or another repository does not delay ready CI, deployments, PRs or reviews. A failed refresh still preserves the available view.

A shared persistent response cache revalidates GET pages with ETag/If-None-Match, retaining the body and pagination on 304; unsupported endpoints fall back to normal GET. Metadata (PR counts, review queue and deployment statuses) has a separate refreshSeconds lifetime shared across date selections. Manual Refresh bypasses that lifetime and revalidates. Cache keys contain a token hash, never the token, and settings changes clear both histories and HTTP responses and reject old in-flight writes. Up to 512 HTTP pages are retained; cached payloads store only the fields used by metrics, excluding unused deployment payloads and unsafe log links.

Large CI collections use stable UTC week windows, running independent windows and the first split’s siblings concurrently. Deeper splits are sequential to prevent exponential speculative work when GitHub reports inconsistent counts. The active tail is read after closed windows so its pages do not queue behind historical work; a pagination count change retries only that window once before reporting incomplete data. All paths retain the shared four-request limit, per-request deadline, complete leaf count checks, duplicate-ID checks and disjoint boundaries. Old CI pages are revalidated too, so reruns that change an old conclusion are not silently frozen in cache. Unchanged pages need no response-body download.

Commit history always checks the current default-branch head and total count. An unchanged head reuses complete matching cached records. A fast-forward can merge new records only after encountering the prior head (proving ancestry) and matching the complete expected count. A rewritten branch, changed branch, missing ancestry or incomplete merged count falls back to reading the current immutable-head history. First loads, missing coverage, missing ETags and rewritten Git history can still require full downloads.


Automatic cache maintenance runs at startup, after completed snapshot writes and successful repository discovery, and hourly through the existing background service. Entries unused for seven days are removed. Historical records are limited to the past calendar year, from 00:00 UTC on the anniversary date through now. Older raw deployment, CI and commit records are pruned while newer records and their actual freshness timestamps survive. Snapshots with older aggregate windows and HTTP pages containing older history or querying older date ranges are removed whole, preserving pagination counts and ETag correctness. Current-state metadata such as old pull requests still open is retained. The boundary advances daily; cleanup runs at startup and at least hourly while idle. Last access is tracked separately from the data’s freshness timestamp, so using a cached entry never makes old metrics appear freshly collected. Existing repository histories receive an initial access timestamp on upgrade; existing HTTP pages inherit their previous check time. Valid local snapshot reads keep the corresponding repository history active.

Cache budgets retain at most eight range snapshots and 512 HTTP responses, with a combined 64 MiB budget for serialized cache payloads (SQLite/WAL overhead is additional). Byte eviction removes least-recently-used HTTP pages first, then range snapshots, then repository histories, retaining active history ahead of disposable responses. An entry larger than the whole budget may be evicted; subsequent requests collect it again normally, without treating missing history as zero. Successful, complete project discovery removes histories, snapshots and recognized HTTP pages belonging to repositories no longer configured. Discovery failures do not purge unknown repository membership.

SQLite compaction runs only at startup or the hourly idle maintenance pass, with no metrics/history request in flight: VACUUM is used when free pages occupy at least 8 MiB and 25% of the file; WAL is checkpointed and truncated. Normal request completion only evicts rows. Maintenance failures are logged and retried later without failing metric requests. Cache deletion never modifies repositories or GitHub data.


### CI diagnostics and elapsed timings

Needs attention evaluates the latest completed runs **within the selected period**, not live branch health outside that period. It flags the latest non-cancelled/non-skipped failed run per workflow on the actual default branch and three or more consecutive failures on any branch. Workflow identity and branch are kept separate; PR-triggered runs are separate from other triggers, so PR failures never become default-branch alerts. A later success clears the corresponding signal. Neutral/unknown results break a failure streak. Failure states include failure, timed_out, startup_failure, action_required and stale. Partial metadata and an unknown default branch are explicitly disclosed. Main/default-branch and PR success rates exclude cancelled and skipped runs, matching the headline rate. CI health also shows the three workflows with the most failures and links to their latest failed run.

CI run timings shows total estimated elapsed time, mean, median and nearest-rank P95, expandable timing statistics per workflow, and the five longest runs with GitHub links. Estimates use run_started_at through updated_at for the current completed run record. Missing or invalid intervals are omitted and measured/total coverage is displayed. Cancelled and skipped runs contribute when valid timestamps exist. Summed elapsed durations include overlapping workflows; they are not wall-clock delivery time, job compute time or billed runner minutes. Reruns or later record updates may inflate estimates; individual attempt history is not fetched.

Diagnostics use metadata already returned by workflow-list requests and derive locally from the same retained raw history on date changes. No per-run or per-job timing requests are added. Existing cached histories remain readable; a refresh acquires missing metadata, with versioned HTTP cache keys preventing legacy slim responses from being retained by a 304. Partial CI histories never produce diagnostics or timing totals.


Dashboard hierarchy: headline success/deployment/PR metrics first, then a full-width CI run timings card with larger timing values and side-by-side expandable workflow/run lists, followed by a unified CI health card. CI health contains Needs attention, branch success rates, outcome counts, a collapsed top-failing-workflow list and the lazy failed-run list; it replaces the standalone Needs attention card. Problems precede counts on narrow screens and sit beside counts on wide screens. CI and deployment history charts follow, then repository activity, then equal-width review and production cards. Secondary cards retain content height; all multi-column layouts stack on narrow screens. Interval dialogs keep the compact CI outcomes card without the dashboard-only diagnostics.


Loading states use theme-aware neutral skeletons shaped like KPI values, timing statistics, CI signals/outcomes, activity numbers, lists and charts. The initial dashboard also shows a structural skeleton; lazy details and interval dialogs follow the same pattern. Each pending field reveals independently. Available values stay visible even when marked pending, zeroes remain values, and failures/unavailable data retain explanatory messages rather than skeletons. Skeletons are decorative, with a named busy status for assistive technology, and disable pulsing when reduced motion is requested.
