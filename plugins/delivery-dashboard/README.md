# Delivery Dashboard for BB

Adds a responsive **Delivery dashboard** page in BB's sidebar with GitHub deployment frequency, open PR count, and CI pass rate for multiple repositories. Refreshes every five minutes by default, with an immediate Refresh button.

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

Use **Date range** to select 1 day, 3 days, 1 week, 2 weeks, 1 month (30 days), or 3 months (90 days). The default is one week. Presets are rolling periods ending at refresh time. **Custom dates** exposes From/Through date pickers and an Apply dates button; both calendar dates are included in UTC, with today's endpoint capped at refresh time. Invalid, reversed, pre-1970, and future dates are rejected.

The filter applies to deployment frequency, created PRs, commits and changed lines, CI pass rate/outcomes, and both charts across all repositories. Open PRs, the review queue, and the latest production deployment show current state independently of the selected range. Each section uses the BB project name (or a readable repository name for manual entries), with a compact UTC date range and exact timestamps on hover. Switching ranges keeps the previous results and their captions visible until the replacement arrives; superseded responses are ignored. The selection survives sidebar navigation within the app window.

Click any bar in either chart (or focus it and press Enter/Space) to open **Interval statistics** for that repository. The popup shows compact UTC dates with exact interval endpoints on hover, deployment count, created PRs, default-branch commits and added/deleted lines, CI pass rate, and CI outcomes. It loads on demand without clearing the dashboard. Empty bars are also clickable. Bars may represent an hour, a rolling day, or multiple days, depending on the selected range; the popup always uses the actual bar interval, excluding shared boundaries from the earlier bar. The popup stays within the dashboard pane intersected with the visible viewport, including when a native browser pane is open beside it or the split is resized; it also follows zoom, panning, and on-screen keyboard changes; narrow cards stack and long content scrolls vertically. Close with Close, Escape, or a backdrop click. Failed popup requests can be retried; unavailable metrics retain their own explanations.

## Metric definitions

| Metric | Definition |
| --- | --- |
| Deploy frequency | Number of GitHub deployment records created in the selected range divided by its duration in days. Includes all environments and outcomes, so deployment attempts are counted, not just successful production deploys. |
| PRs created | All PRs opened within the selected range, including drafts and PRs that are now closed or merged. Independent of the current open-PR count. |
| Commits | Unique commits in the default branch's reachable history, filtered by committed date within the same selected window. The default-branch name is displayed. |
| Lines added / deleted | Sum of GitHub's per-commit additions/deletions for that commit dataset, across all files (including documentation and generated files). Includes merge commits as reported by GitHub. These are cumulative changed lines, not net repository growth or a count of current source-code lines. |
| Open pull requests | GitHub Search's current open PR count, including drafts. Incomplete search results produce an error. |
| CI pass rate | Successful / completed GitHub Actions workflow runs created in the selected range × 100. Includes every branch and workflow; cancelled, skipped, and neutral completed runs remain in the denominator. No completed runs displays “—”. |
| CI outcomes | Counts by conclusion from the same completed-run dataset as the chart and pass rate: passed, failed, cancelled, skipped, and any other reported conclusions such as timed out. “Failed” is the GitHub failure conclusion; timeouts are shown separately. |
| PRs awaiting review | Non-draft open PRs matching GitHub's `review:none` filter, meaning no review has been submitted yet. Shows the total and the five oldest, with links. Age is since PR creation, not time since a review request. |
| Latest production deployment | The newest deployment flagged `production_environment: true` or whose environment is named `production` (case-insensitive). Shows the latest status, environment/ref, creation age, status-update time, and an HTTPS log link, falling back to the repository's deployments page. No status is shown as “unknown”. |

[GitHub deployments API](https://docs.github.com/en/rest/deployments/deployments), [search API](https://docs.github.com/en/rest/search/search), and [workflow runs API](https://docs.github.com/en/rest/actions/workflow-runs) supply the data. For complete histories, CI pass rate, daily series, and outcomes are computed from one dataset, avoiding races with a separate success-count query. Duplicate run IDs are de-duplicated. If counts change during pagination, incomplete histories are hidden and retried on the next refresh; the summary falls back to GitHub count queries.

Opening the dashboard first reads a local server snapshot, then updates from GitHub in the background. The default weekly snapshot is also collected by a background service while the dashboard is closed, using the configured refresh interval. Snapshots survive BB/plugin restarts in plugin-owned SQLite; the eight most recently used ranges are retained. No credentials are stored in snapshot data. Changing settings invalidates snapshots, and refreshes started under older settings cannot replace them. Concurrent refreshes of the same range share one GitHub collection.

The display budget of 600 ms applies to an existing local snapshot. The first collection after installation, a settings change, or selection of an uncached range still requires GitHub; it shows an explicit loading state rather than invented values. Last checked shows the snapshot's actual collection time. Refresh requests fresh data without hiding current cards or charts. Frontend polling runs only while mounted and cleans up on unmount; sidebar remounts additionally reuse the current window's in-memory snapshot. No repository data is stored in browser storage. Requests abort on plugin unload and have a 20-second timeout per API request. Failed RPC refreshes preserve displayed values with a stale-data warning. Deployment pagination continues until the selected window is complete, without a 1,000-record cap. GitHub.com is the supported host.

Each repository also has deployment-throughput and CI-pass-rate bar charts with hourly buckets for a one-day range, daily buckets up to two weeks, and larger whole-day buckets (at most 14) for longer ranges. The final bucket may be shorter; hover descriptions give its actual boundaries. Dates and hover descriptions use UTC. Zero deployment counts stay zero; days with no completed CI runs show “—”. CI history splits searches above GitHub’s 1,000-run limit into disjoint UTC intervals, then paginates each interval. Pass rate, charts and outcomes use the complete combined dataset, ignoring truncated large-search counts (including GitHub’s 2,500 cap). Failed or inconsistent pagination is unavailable; fallback count summaries are limited to searches of at most 1,000 runs. More than 1,000 runs created in the same second cannot be split further and are unavailable. Production discovery scans newest deployments until a production record is found or the list ends, independently of the selected metric window. Deployment-list requests shared by frequency and production discovery are reused within the refresh.

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

Persisted snapshots seed a newly opened range only when that window has no matching in-memory snapshot. Polling and sidebar remounts retain the current in-memory dataset during refresh instead of reapplying older server data. Snapshots from before the CI search-splitting revision are invalidated.
