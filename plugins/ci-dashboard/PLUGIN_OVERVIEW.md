# CI Dashboard

See GitHub deployment frequency, current open pull requests, and GitHub Actions pass rate in a dedicated BB sidebar page.

GitHub repositories are imported automatically from BB projects. Add more owner/repo entries in settings, or disable import to use only your manual list. Each repository gets its own metrics. The dashboard refreshes every five minutes by default; adjust the interval or refresh immediately. System GitHub authorization is used automatically; a secret token override is optional. Credentials remain server-side.

Deploy frequency counts all deployment records over the selected date range, averaged per day. CI pass rate counts successful versus completed workflow runs excluding cancelled and skipped created over the selected date range. Cancelled and skipped runs remain visible in CI outcomes. Each metric includes its definition, and unavailable metrics show errors rather than misleading zeroes. See README.md for setup, permissions, and API limits.

Deployment-throughput and CI-pass-rate charts use actual GitHub data, grouped into four-hour intervals for today, 12-hour intervals for three days, hourly intervals for custom days, or daily/larger intervals according to the range, with UTC labels and hover details. Incomplete histories are clearly marked. Open the dashboard from the package icon in the navigation sidebar.

Each repository also shows completed CI outcomes (including failures, cancellations, and skips), the five oldest unreviewed non-draft PRs with their age and links, and the newest production deployment with its status, environment, ref, times, and a log link. CI cards and charts use one complete dataset to keep the figures consistent.

The activity block counts PRs created in the selected date range, commits in the default branch, and cumulative lines added/deleted across those commits. Commit statistics use existing GitHub authorization, and unavailable data is clearly marked.

Choose today from 00:00 UTC (1 day), 3 days, 1 week, 2 weeks, 1 month (30 days), 3 months (90 days), or custom inclusive UTC dates. Filters affect historical metrics for all repositories, while current open PRs, review queue, and latest production stay current. Changing ranges preserves previous results during background loading, and the selection survives sidebar navigation.

Click either chart’s bars for a popup with statistics for the exact UTC interval: deployments, created PRs, commits, added/deleted lines, CI pass rate, and outcomes. The dashboard stays visible while details load; keyboard activation, Escape, and retries are supported.

Use repository headings to open GitHub in BB’s configured browser while keeping the dashboard available.


Agents can read cached or freshly collected CI metrics with ci_dashboard_metrics: pass rates, outcomes, branch/workflow problem signals and elapsed timings, with explicit timestamps, staleness and missing-data errors. CI access is read-only.
