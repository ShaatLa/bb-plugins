# CI Dashboard

See GitHub deployment frequency, current open pull requests, and GitHub Actions pass rate in a dedicated BB sidebar page.

GitHub repositories are imported automatically from BB projects. Add more owner/repo entries in settings, or disable import to use only your manual list. Each repository gets its own metrics. The dashboard refreshes every five minutes by default; adjust the interval or refresh immediately. System GitHub authorization is used automatically; a secret token override is optional. Credentials remain server-side.

Deploy frequency counts all deployment records over the selected date range, averaged per day. CI pass rate counts successful versus completed workflow runs excluding cancelled and skipped created over the selected date range. Cancelled and skipped runs remain visible in CI outcomes. Each metric includes its definition, and unavailable metrics show errors rather than misleading zeroes. See README.md for setup, permissions, and API limits.

Deployment-throughput and CI-pass-rate charts use actual GitHub data, grouped into four-hour intervals for today, 12-hour intervals for three days, hourly intervals for custom days, or daily/larger intervals according to the range, with UTC labels and hover details. Incomplete histories are clearly marked. Open the dashboard from the pipeline icon in the navigation sidebar.

Each repository also shows completed CI outcomes (including failures, cancellations, and skips), the five oldest unreviewed non-draft PRs with their age and links, and the newest production deployment with its status, environment, ref, times, and a log link. CI cards and charts use one complete dataset to keep the figures consistent.

Optional, configurable in settings and off by default: a **Deploy to production** action (`productionRepository`, `productionWorkflow`, `productionRef`) that dispatches one workflow after confirmation, a draft-deferral rule (`draftWorkflow`, `draftJob`, `draftStep`) that excludes verified draft-rejection failures from pass rates, and job-signal name lists (`aggregatorJobs`, `policyJobs`).

The activity block counts PRs created in the selected date range, commits in the default branch, and cumulative lines added/deleted across those commits. Commit statistics use existing GitHub authorization, and unavailable data is clearly marked.

Choose today from 00:00 UTC (1 day), 3 days, 1 week, 2 weeks, 1 month (30 days), 3 months (90 days), or custom inclusive UTC dates. Filters affect historical metrics for all repositories, while current open PRs, review queue, and latest production stay current. Changing ranges preserves previous results during background loading, and the selection survives sidebar navigation.

Click either chart’s bars for a popup with statistics for the exact UTC interval: deployments, created PRs, commits, added/deleted lines, CI pass rate, and outcomes. The dashboard stays visible while details load; keyboard activation, Escape, and retries are supported.

Use repository headings to open GitHub in BB’s configured browser while keeping the dashboard available.


Agents can read cached or freshly collected CI metrics with ci_dashboard_metrics: pass rates, outcomes, branch/workflow problem signals and elapsed timings, with explicit timestamps, staleness and missing-data errors. ci_dashboard_metrics and the ci RPC are read-only. ci_dashboard_manage and the manage RPC change plugin state only: claims, observers and PR subscriptions. Manage refuses unused action parameters and CI inspection refs as fix references (use #12, FIX-1 or a URL). Claim results include previous and handled; observer replacement returns removed thread ids for the caller to inspect. For example, {"action":"fix_pending","id":"pool_stall:self-hosted","ref":"#12"} preserves the worker when threadId is omitted.

The lead must subscribe right after opening the PR, at any PR state (including draft, before READY). PR lifecycle lines go only to PR subscribers, never observer threads: **PR CI green / PR CI red** (CI complete), **PR merged**, and **PR closed**. Completed CI or an already merged PR is delivered on the next pass after subscribing; no shell polling loop is needed. CI is reported once per current head SHA and verdict, only after every required context is terminal and no required check is still expected; when a check name ran several times on the head, only its latest run counts. A new push, or a later run that flips the verdict, produces one new line. With no required contexts, all contexts are used and the line says `checks`. SUCCESS, NEUTRAL and SKIPPED pass; other terminal results fail. Failed check names are labels only, capped at five plus `+N`.

```text
PR CI green · #12 · head <40-char sha> · 5 required checks passed · <PR url>
PR CI red · #12 · head <40-char sha> · 2 of 5 required checks failed: build, test · <PR url>
PR merged · #12 · merge commit <40-char sha> · <mergedAt ISO> · <PR url>
PR closed · #12 · not merged, subscription ended · <PR url>
```

Merge is reported once per PR, stops CI lines and keeps the subscription for successful deployment delivery. Close without merge removes the PR's subscriptions. Unsubscribe, successful deployment delivery, thread archive/deletion and 14-day expiry also end subscriptions. Lifecycle queries use repository-level GraphQL data and the shared backfill budget, at most one request per repository per 60 seconds, rotating batches of up to 25 PRs. No lifecycle request runs without subscriptions, authorization or a backfill runtime. Sent keys (`pr_ci:12:<sha>`, `pr_merged:12`) persist in `observer:<repo>` before delivery and use the existing history pruning. Rollups exceeding 100 contexts wait rather than report incomplete evidence.
