import { classifyDraft, draftCandidate } from "./draft-deferrals";
import { z } from "zod";
import { ciInsightsSchema, ciRunSchema, summarizeCi } from "./ci-insights";
import { rangeSchema, resolveRange, type DateRange } from "./date-range";
import { commitActivitySchema, commitRowSchema, loadCommitActivity, summarizeCommitActivity } from "./commit-activity";

export const repositorySchema = z.string().max(200).regex(
  /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/,
  "Use a GitHub repository in owner/repo format",
);
const seriesSchema = z.array(z.object({ date: z.iso.datetime(), value: z.number().nonnegative().nullable() }));
const metricSchema = z.object({
  value: z.number().nonnegative().nullable(),
  detail: z.string(),
  error: z.string().nullable(),
  series: seriesSchema.nullable(),
  seriesError: z.string().nullable(),
});
const timestampSchema = z.iso.datetime({ offset: true });
export const secureUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password;
}, "Expected an HTTPS link without embedded credentials");
export const metricsSchema = z.object({
  repository: z.string(),
  updatedAt: z.string(),
  range: rangeSchema,
  pending: z.array(z.string()).optional(),
  deployments: metricSchema,
  pullRequests: metricSchema,
  pullRequestsCreated: metricSchema,
  commitActivity: commitActivitySchema,
  ci: metricSchema,
  ciInsights: ciInsightsSchema.nullable().optional(),
  ciOutcomes: z.record(z.string(), z.number().int().nonnegative()).nullable(),
  reviewQueue: z.object({
    total: z.number().int().nonnegative().nullable(),
    items: z.array(z.object({ number: z.number().int().positive(), title: z.string(), createdAt: timestampSchema, url: secureUrlSchema })).max(5),
    error: z.string().nullable(),
  }),
  production: z.object({
    deployment: z.object({ environment: z.string(), ref: z.string(), state: z.string(), createdAt: timestampSchema, updatedAt: timestampSchema, url: secureUrlSchema }).nullable(),
    error: z.string().nullable(),
  }),
});
export type Metrics = z.infer<typeof metricsSchema>;
export const metricsProgressSchema = z.object({
  selection: z.string(), startedAt: z.number(), metrics: metricsSchema.extend({ projectName: z.string().nullable() }),
});

const countSchema = z.object({ total_count: z.number().int().nonnegative() });
const searchSchema = countSchema.extend({ incomplete_results: z.boolean() });
const deploymentsSchema = z.array(z.object({ created_at: timestampSchema }));
const runSchema = ciRunSchema;
const runsSchema = z.object({ workflow_runs: z.array(runSchema) });
const productionRowsSchema = z.array(z.object({ id: z.number().int().positive(), environment: z.string(), production_environment: z.boolean(), ref: z.string(), created_at: timestampSchema }));
const statusesSchema = z.array(z.object({ state: z.string(), created_at: timestampSchema, log_url: z.string().nullable().optional() }));
const reviewSearchSchema = searchSchema.extend({ items: z.array(z.object({ number: z.number().int().positive(), title: z.string(), created_at: timestampSchema })).max(5) });

export const historicalRecordsSchema = z.object({
  deployments: deploymentsSchema,
  runs: z.array(runSchema),
  commits: z.array(commitRowSchema),
  branch: z.string().nullable(),
  head: z.string().nullable().optional(),
});
export type HistoricalRecords = z.infer<typeof historicalRecordsSchema>;

// Share the budget across repositories and interval/background refreshes.
let activeRequests = 0;
const waitingRequests: (() => void)[] = [];
async function limitedRequest<T>(operation: () => Promise<T>): Promise<T> {
  if (activeRequests >= 4) await new Promise<void>((resolve) => waitingRequests.push(resolve));
  else activeRequests++;
  try { return await operation(); }
  finally {
    const next = waitingRequests.shift();
    if (next) next();
    else activeRequests--;
  }
}

export type GitHubResponse = { body: unknown; hasNext: boolean; etag?: string };
export type GitHubRequest = (path: string, init?: Pick<RequestInit, "method" | "body">) => Promise<GitHubResponse>;
export async function githubRequest(path: string, token: string | undefined, signal: AbortSignal, init?: Pick<RequestInit, "method" | "body">, previous?: GitHubResponse): Promise<GitHubResponse> {
  return limitedRequest(async () => {
    signal.throwIfAborted();
    const response = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2026-03-10",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(previous?.etag ? { "If-None-Match": previous.etag } : {}),
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      redirect: "error",
    });
    if (response.status === 304 && previous?.etag) return { ...previous, ...(response.headers.has("link") ? { hasNext: /rel="next"/.test(response.headers.get("link")!) } : {}) };
    if (!response.ok) {
      const hint = response.status === 401 ? "Check the access token."
        : response.status === 404 ? "Check the repository and token permissions."
        : response.status === 403 || response.status === 429 ? "Check token permissions or the GitHub rate limit."
        : "Try again at the next refresh.";
      throw new Error(`GitHub returned ${response.status}. ${hint}`);
    }
    return { body: await response.json(), hasNext: /rel="next"/.test(response.headers.get("link") ?? ""), ...(response.headers.get("etag") ? { etag: response.headers.get("etag")! } : {}) };
  });
}

export type LoadOptions = {
  request?: GitHubRequest; historyRange?: DateRange; previous?: HistoricalRecords;
  localOnly?: boolean; partitionCi?: boolean; onProgress?: (metrics: Metrics) => void;
  onWarning?: (message: string) => void;
};
export async function loadMetrics(repository: string, token: string | undefined, signal: AbortSignal, range: DateRange = resolveRange(null), cached?: { metrics: Metrics; records: HistoricalRecords }, onHistory?: (records: HistoricalRecords) => void, options: LoadOptions = {}): Promise<Metrics> {
  repositorySchema.parse(repository);
  const now = new Date();
  const historyData: Partial<HistoricalRecords> = {};
  rangeSchema.parse(range);
  const cutoff = Date.parse(range.since);
  const end = Date.parse(range.until);
  const since = range.since;
  const historyRange = options.historyRange ?? range;
  const historyStart = Date.parse(historyRange.since), historyEnd = Date.parse(historyRange.until);
  const calendarDay = range.label === "today";
  const days = calendarDay ? 1 : Math.max(1, end - cutoff) / 86_400_000;
  const bucketCount = calendarDay ? 6 : Math.ceil(Math.max(1, end - cutoff) / range.bucketMs);
  const emptySeries = () => Array.from({ length: bucketCount }, (_, i) => ({
    date: new Date(calendarDay ? cutoff + (i + 1) * range.bucketMs : Math.min(end, cutoff + (i + 1) * range.bucketMs)).toISOString(), value: 0,
  }));
  const bucket = (timestamp: string) => {
    const time = Date.parse(timestamp);
    return time < cutoff || time > end ? -1 : Math.min(bucketCount - 1, Math.floor((time - cutoff) / range.bucketMs));
  };
  const request: GitHubRequest = options.request ?? ((path, init) => githubRequest(path, token, signal, init));
  const deploymentPages = new Map<number, ReturnType<typeof request>>();
  const deploymentFingerprints = new Set<string>();
  function deploymentPage(page: number) {
    if (!deploymentPages.has(page)) deploymentPages.set(page, request(`/repos/${repository}/deployments?per_page=100&page=${page}`).then((result) => {
      const fingerprint = JSON.stringify(result.body);
      if (deploymentFingerprints.has(fingerprint) || (result.hasNext && deploymentsSchema.parse(result.body).length === 0)) {
        throw new Error("GitHub returned a repeated or empty deployment page; retry on the next refresh.");
      }
      deploymentFingerprints.add(fingerprint);
      // A full cached final page can acquire a successor without changing its body.
      if (!result.hasNext && Array.isArray(result.body) && result.body.length === 100) return { ...result, hasNext: true };
      return result;
    }));
    return deploymentPages.get(page)!;
  }
  async function deployments() {
    let count = 0;
    const series = emptySeries();
    const selected: HistoricalRecords["deployments"] = [];
    for (let page = 1; ; page++) {
      const { body, hasNext } = cached ? { body: cached.records.deployments, hasNext: false } : await deploymentPage(page);
      const rows = deploymentsSchema.parse(body);
      for (const row of rows) {
        const index = bucket(row.created_at);
        if (index >= 0) { count++; series[index].value++; }
        if (Date.parse(row.created_at) >= historyStart && Date.parse(row.created_at) <= historyEnd) selected.push(row);
      }
      // GitHub lists deployments newest first; stop once the page crosses the window.
      if (!hasNext || rows.some((row) => Date.parse(row.created_at) < historyStart)) {
        historyData.deployments = selected;
        return {
          value: count / days,
          detail: `${count} deployment records · ${range.label} · all environments and outcomes`,
          error: null, series, seriesError: null,
        };
      }
    }
  }
  async function pullRequests(created = false) {
    if (cached && !created) return cached.metrics.pullRequests;
    if (cached && created && options.localOnly) return cached.metrics.range.since === since && cached.metrics.range.until === range.until
      ? cached.metrics.pullRequestsCreated : { value: null, detail: "Loading created PR count…", error: null, series: null, seriesError: null };
    const query = encodeURIComponent(`repo:${repository} is:pr ${created ? `created:${since}..${range.until}` : "is:open"}`);
    const { body } = await request(`/search/issues?q=${query}&per_page=1`);
    const result = searchSchema.parse(body);
    if (result.incomplete_results) throw new Error("GitHub returned an incomplete PR count; try again.");
    return { value: result.total_count, detail: created ? `Created · ${range.label} · all states, includes drafts` : "Open now · includes drafts", error: null, series: null, seriesError: null };
  }
  async function reviews() {
    if (cached) return cached.metrics.reviewQueue;
    const query = encodeURIComponent(`repo:${repository} is:pr is:open draft:false review:none`);
    const { body } = await request(`/search/issues?q=${query}&sort=created&order=asc&per_page=5`);
    const result = reviewSearchSchema.parse(body);
    if (result.incomplete_results) throw new Error("GitHub returned an incomplete review queue; try again.");
    return { total: result.total_count, error: null, items: result.items.map((item) => ({
      number: item.number, title: item.title, createdAt: item.created_at, url: `https://github.com/${repository}/pull/${item.number}`,
    })) };
  }
  async function production() {
    if (cached) return cached.metrics.production;
    for (let page = 1; ; page++) {
      const { body, hasNext } = await deploymentPage(page);
      const latest = productionRowsSchema.parse(body).find((row) => row.production_environment || row.environment.toLowerCase() === "production");
      if (latest) {
        const { body } = await request(`/repos/${repository}/deployments/${latest.id}/statuses?per_page=1`);
        const status = statusesSchema.parse(body)[0];
        const link = secureUrlSchema.safeParse(status?.log_url);
        return { error: null, deployment: {
          environment: latest.environment, ref: latest.ref, createdAt: latest.created_at,
          updatedAt: status?.created_at ?? latest.created_at, state: status?.state ?? "unknown",
          url: link.success ? link.data : `https://github.com/${repository}/deployments`,
        } };
      }
      if (!hasNext) return { deployment: null, error: null };
    }
  }
  async function ci() {
    const path = `/repos/${repository}/actions/runs?created=${encodeURIComponent(`${historyRange.since}..${historyRange.until}`)}`;
    const completedPath = `${path}&status=completed&per_page=100`;
    const first = cached ? null : await request(`${completedPath}&page=1`);
    const completed = cached ? cached.records.runs.length : countSchema.parse(first!.body).total_count;
    function summary(total: number, successful: number) {
      if (total < 0 || successful > total) throw new Error("GitHub run counts changed during refresh; try again.");
      return {
        value: total === 0 ? null : successful / total * 100,
        detail: total === 0 ? `No completed runs after excluding cancelled, skipped and deferred drafts · ${range.label}` : `${successful} of ${total} completed workflow runs · cancelled, skipped and deferred drafts excluded · ${range.label}`, error: null,
      };
    }
    async function incomplete(message: string) {
      const [success, cancelled, skipped] = await Promise.all([
        request(`${path}&status=success&per_page=1`), request(`${path}&status=cancelled&per_page=1`),
        request(`${path}&status=skipped&per_page=1`),
      ]);
      const successful = countSchema.parse(success.body).total_count;
      const total = completed - countSchema.parse(cancelled.body).total_count - countSchema.parse(skipped.body).total_count;
      return { metric: { ...summary(total, successful), series: null, seriesError: message }, outcomes: null };
    }
    async function history(start: number, finish: number, response?: Awaited<ReturnType<typeof request>>, parallel = true, retried = false): Promise<Map<number, z.infer<typeof runSchema>>> {
      const filteredPath = `/repos/${repository}/actions/runs?created=${encodeURIComponent(`${new Date(start).toISOString()}..${new Date(finish).toISOString()}`)}&status=completed&per_page=100`;
      const initial = response ?? await request(`${filteredPath}&page=1`);
      const total = countSchema.parse(initial.body).total_count;
      if (total > 1000) {
        // GitHub caps each filtered search at 1,000 and may truncate total_count at 2,500.
        const middle = Math.floor((start + finish) / 2000) * 1000;
        if (middle < start || middle + 1000 > finish) throw new Error("GitHub returned more than 1,000 runs in one second; complete CI history is unavailable.");
        // Parallelize the first split; deeper sequential splits bound work on inconsistent counts.
        const [rows, right] = parallel
          ? await Promise.all([history(start, middle, undefined, false), history(middle + 1000, finish, undefined, false)])
          : [await history(start, middle, undefined, false), await history(middle + 1000, finish, undefined, false)];
        for (const [id, row] of right) {
          if (rows.has(id)) throw new Error("GitHub returned overlapping CI search results.");
          rows.set(id, row);
        }
        return rows;
      }
      const rows = new Map<number, z.infer<typeof runSchema>>();
      const pages = [initial, ...await Promise.all(Array.from(
        { length: Math.max(0, Math.ceil(total / 100) - 1) },
        (_, index) => request(`${response ? completedPath : filteredPath}&page=${index + 2}`),
      ))];
      try {
        for (const page of pages) {
          if (countSchema.parse(page.body).total_count !== total) throw new Error("Run counts changed during pagination");
          for (const row of runsSchema.parse(page.body).workflow_runs) {
            const time = Date.parse(row.created_at);
            if (time < start || time > finish) throw new Error("GitHub returned a run outside the time window");
            rows.set(row.id, row);
          }
        }
        if (pages[pages.length - 1].hasNext || rows.size !== total) throw new Error("Incomplete run history");
        return rows;
      } catch (error) {
        if (!retried && error instanceof Error && ["Run counts changed during pagination", "Incomplete run history"].includes(error.message)) return history(start, finish, undefined, parallel, true);
        throw error;
      }
    }
    try {
      async function completeHistory() {
        if (!options.partitionCi || completed <= 1000 || historyEnd - historyStart <= 7 * 86_400_000) return history(historyStart, historyEnd, first!);
        const windows: [number, number][] = [];
        for (let start = historyStart; start <= historyEnd;) {
          const finish = Math.min(historyEnd, (Math.floor(start / (7 * 86_400_000)) + 1) * 7 * 86_400_000 - 1);
          windows.push([start, finish]);
          start = finish + 1;
        }
        // Read the active tail after closed windows so its pages cannot queue behind old history.
        const results = await Promise.all(windows.slice(0, -1).map(([start, finish]) => history(start, finish)));
        const tail = windows[windows.length - 1];
        results.push(await history(tail[0], tail[1]));
        const combined = new Map<number, z.infer<typeof runSchema>>();
        for (const result of results) for (const [id, row] of result) {
          if (combined.has(id)) throw new Error("GitHub returned overlapping CI search results.");
          combined.set(id, row);
        }
        if (completed <= 1000 && combined.size !== completed) throw new Error("GitHub run counts changed during refresh.");
        return combined;
      }
      const rows = cached
        ? new Map(cached.records.runs.filter((row) => bucket(row.created_at) >= 0).map((row) => [row.id, row]))
        : await completeHistory();
      const previous = new Map(options.previous?.runs.map((run) => [run.id, run]));
      let unchecked = 0;
      await Promise.all([...rows.values()].filter(draftCandidate).map(async (run) => {
        const old = previous.get(run.id);
        if (run.draftDeferred === undefined && old?.updated_at === run.updated_at && old?.run_attempt === run.run_attempt) run.draftDeferred = old?.draftDeferred;
        if (run.draftDeferred !== undefined) return;
        if (options.localOnly) { unchecked++; return; }
        try { run.draftDeferred = await classifyDraft(run, repository, request); }
        catch { signal.throwIfAborted(); unchecked++; }
      }));
      historyData.runs = [...rows.values()];
      const totals = emptySeries();
      const passed = Array<number>(bucketCount).fill(0);
      const outcomes: Record<string, number> = Object.create(null);
      for (const row of rows.values()) {
        const index = bucket(row.created_at);
        if (index < 0) continue;
        const state = row.draftDeferred ? "deferred_draft" : row.conclusion ?? "unknown";
        outcomes[state] = (outcomes[state] ?? 0) + 1;
        if (["cancelled", "skipped", "deferred_draft"].includes(state)) continue;
        totals[index].value++;
        if (state === "success") passed[index]++;
      }
      if (unchecked) options.onWarning?.(`${unchecked} draft-rejection candidates could not be verified; retained as failures.`);
      return { metric: { ...summary(Object.values(outcomes).reduce((sum, count) => sum + count, 0) - (outcomes.cancelled ?? 0) - (outcomes.skipped ?? 0) - (outcomes.deferred_draft ?? 0), outcomes.success ?? 0), series: totals.map((point, index) => ({
        date: point.date, value: point.value === 0 ? null : passed[index] / point.value * 100,
      })), seriesError: null, ...(unchecked ? { detail: `${summary(totals.reduce((sum, point) => sum + point.value, 0), outcomes.success ?? 0).detail} · ${unchecked} draft candidates unverified (counted as failures)` } : {}) }, outcomes };
    } catch (error) {
      signal.throwIfAborted();
      options.onWarning?.(error instanceof Error && error.name !== "ZodError" ? error.message : "Invalid GitHub CI response");
      // Large fallback counts can be truncated; never turn them into a precise pass rate.
      if (completed > 1000 || historyRange.since !== since || historyRange.until !== range.until) throw new Error("GitHub complete CI history could not be loaded. Retry on the next refresh.");
      return incomplete("Unable to load complete CI history and outcome breakdown. Retry on the next refresh.");
    }
  }
  function errorMessage(reason: unknown) {
    const message = reason instanceof Error ? reason.message : "";
    return message.startsWith("GitHub") || message.startsWith("More than")
      ? message : "Unable to load this data. Check connectivity and try again.";
  }
  function failedMetric(reason: unknown) {
    return { value: null, detail: "Unavailable", series: null, seriesError: null, error: errorMessage(reason) };
  }
  const empty = { value: null, detail: "Loading…", error: null, series: null, seriesError: null };
  const pending = ["deployments", "pullRequests", "ci", "reviewQueue", "production", "pullRequestsCreated", "commitActivity"];
  const result: Metrics = {
    repository, updatedAt: cached?.metrics.updatedAt ?? now.toISOString(), range,
    deployments: empty, pullRequests: empty, ci: empty, pullRequestsCreated: empty, ciOutcomes: null,
    commitActivity: { commits: null, additions: null, deletions: null, branch: null, error: null },
    reviewQueue: { total: null, items: [], error: null }, production: { deployment: null, error: null }, pending: [...pending],
  };
  async function settle(key: string, operation: Promise<Partial<Metrics>>, failure: (reason: unknown) => Partial<Metrics>) {
    try { Object.assign(result, await operation); }
    catch (reason) { Object.assign(result, failure(reason)); }
    pending.splice(pending.indexOf(key), 1);
    result.pending = [...pending];
    const runs = cached?.records.runs ?? historyData.runs;
    if ((key === "ci" || key === "commitActivity") && !pending.includes("ci") && result.ciOutcomes && runs) result.ciInsights = summarizeCi(runs.filter((row) => bucket(row.created_at) >= 0), cached?.records.branch ?? historyData.branch ?? null);
    options.onProgress?.({ ...result });
  }
  let commitsComplete = false;
  const commits = cached ? Promise.resolve(summarizeCommitActivity(cached.records.commits.filter((row) => {
    const time = Date.parse(row.committedDate);
    return time >= cutoff && time <= end;
  }), cached.records.branch)) : loadCommitActivity(repository, token, historyRange.since, historyRange.until, request, (rows, branch, head) => {
    historyData.commits = rows;
    historyData.branch = branch;
    historyData.head = head;
  }, options.previous).then(() => summarizeCommitActivity(historyData.commits!.filter((row) => Date.parse(row.committedDate) >= cutoff && Date.parse(row.committedDate) <= end), historyData.branch!));
  await Promise.all([
    settle("deployments", deployments().then((deployments) => ({ deployments })), (reason) => ({ deployments: failedMetric(reason) })),
    settle("pullRequests", pullRequests().then((pullRequests) => ({ pullRequests })), (reason) => ({ pullRequests: failedMetric(reason) })),
    settle("ci", ci().then(({ metric: ci, outcomes: ciOutcomes }) => ({ ci, ciOutcomes })), (reason) => ({ ci: failedMetric(reason), ciOutcomes: null })),
    settle("reviewQueue", reviews().then((reviewQueue) => ({ reviewQueue })), (reason) => ({ reviewQueue: { total: null, items: [], error: errorMessage(reason) } })),
    settle("production", production().then((production) => ({ production })), (reason) => ({ production: { deployment: null, error: errorMessage(reason) } })),
    settle("pullRequestsCreated", pullRequests(true).then((pullRequestsCreated) => ({ pullRequestsCreated })), (reason) => ({ pullRequestsCreated: failedMetric(reason) })),
    settle("commitActivity", commits.then((commitActivity) => { commitsComplete = true; return { commitActivity }; }), (reason) => ({ commitActivity: { commits: null, additions: null, deletions: null, branch: null, error: errorMessage(reason) } })),
  ]);
  if (options.localOnly && cached?.records.runs.some((run) => draftCandidate(run) && run.draftDeferred === undefined)) result.pending = [...(result.pending ?? []), "ci"];
  if (options.localOnly && result.pullRequestsCreated.value === null && !result.pullRequestsCreated.error) result.pending = [...(result.pending ?? []), "pullRequestsCreated"];
  if (!cached && result.deployments.error === null && result.ciOutcomes !== null && commitsComplete) onHistory?.(historicalRecordsSchema.parse(historyData));
  return result;
}
