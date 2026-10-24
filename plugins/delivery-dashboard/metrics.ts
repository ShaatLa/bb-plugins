import { z } from "zod";
import { rangeSchema, resolveRange, type DateRange } from "./date-range";
import { commitActivitySchema, loadCommitActivity } from "./commit-activity";

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
const secureUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password;
}, "Expected an HTTPS link without embedded credentials");
export const metricsSchema = z.object({
  repository: z.string(),
  updatedAt: z.string(),
  range: rangeSchema,
  deployments: metricSchema,
  pullRequests: metricSchema,
  pullRequestsCreated: metricSchema,
  commitActivity: commitActivitySchema,
  ci: metricSchema,
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

const countSchema = z.object({ total_count: z.number().int().nonnegative() });
const searchSchema = countSchema.extend({ incomplete_results: z.boolean() });
const deploymentsSchema = z.array(z.object({ created_at: timestampSchema }));
const runSchema = z.object({ id: z.number().int().positive(), created_at: timestampSchema, conclusion: z.string().nullable() });
const runsSchema = z.object({ workflow_runs: z.array(runSchema) });
const productionRowsSchema = z.array(z.object({ id: z.number().int().positive(), environment: z.string(), production_environment: z.boolean(), ref: z.string(), created_at: timestampSchema }));
const statusesSchema = z.array(z.object({ state: z.string(), created_at: timestampSchema, log_url: z.string().nullable().optional() }));
const reviewSearchSchema = searchSchema.extend({ items: z.array(z.object({ number: z.number().int().positive(), title: z.string(), created_at: timestampSchema })).max(5) });

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

export async function loadMetrics(repository: string, token: string | undefined, signal: AbortSignal, range: DateRange = resolveRange(null)): Promise<Metrics> {
  repositorySchema.parse(repository);
  const now = new Date();
  rangeSchema.parse(range);
  const cutoff = Date.parse(range.since);
  const end = Date.parse(range.until);
  const since = range.since;
  const days = Math.max(1, end - cutoff) / 86_400_000;
  const bucketCount = Math.ceil(Math.max(1, end - cutoff) / range.bucketMs);
  const emptySeries = () => Array.from({ length: bucketCount }, (_, i) => ({
    date: new Date(Math.min(end, cutoff + (i + 1) * range.bucketMs)).toISOString(), value: 0,
  }));
  const bucket = (timestamp: string) => {
    const time = Date.parse(timestamp);
    return time < cutoff || time > end ? -1 : Math.min(bucketCount - 1, Math.floor((time - cutoff) / range.bucketMs));
  };
  async function request(path: string, init?: Pick<RequestInit, "method" | "body">): Promise<{ body: unknown; hasNext: boolean }> {
    return limitedRequest(async () => {
      signal.throwIfAborted();
      const response = await fetch(`https://api.github.com${path}`, {
        ...init,
        headers: {
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2026-03-10",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        redirect: "error",
      });
      if (!response.ok) {
        const hint = response.status === 401 ? "Check the access token."
          : response.status === 404 ? "Check the repository and token permissions."
          : response.status === 403 || response.status === 429 ? "Check token permissions or the GitHub rate limit."
          : "Try again at the next refresh.";
        throw new Error(`GitHub returned ${response.status}. ${hint}`);
      }
      return { body: await response.json(), hasNext: /rel="next"/.test(response.headers.get("link") ?? "") };
    });
  }
  const deploymentPages = new Map<number, ReturnType<typeof request>>();
  const deploymentFingerprints = new Set<string>();
  function deploymentPage(page: number) {
    if (!deploymentPages.has(page)) deploymentPages.set(page, request(`/repos/${repository}/deployments?per_page=100&page=${page}`).then((result) => {
      const fingerprint = JSON.stringify(result.body);
      if (deploymentFingerprints.has(fingerprint) || (result.hasNext && deploymentsSchema.parse(result.body).length === 0)) {
        throw new Error("GitHub returned a repeated or empty deployment page; retry on the next refresh.");
      }
      deploymentFingerprints.add(fingerprint);
      return result;
    }));
    return deploymentPages.get(page)!;
  }
  async function deployments() {
    let count = 0;
    const series = emptySeries();
    for (let page = 1; ; page++) {
      const { body, hasNext } = await deploymentPage(page);
      const rows = deploymentsSchema.parse(body);
      for (const row of rows) {
        const index = bucket(row.created_at);
        if (index >= 0) { count++; series[index].value++; }
      }
      // GitHub lists deployments newest first; stop once the page crosses the window.
      if (!hasNext || rows.some((row) => Date.parse(row.created_at) < cutoff)) return {
        value: count / days,
        detail: `${count} deployment records · ${range.label} · all environments and outcomes`,
        error: null, series, seriesError: null,
      };
    }
  }
  async function pullRequests(created = false) {
    const query = encodeURIComponent(`repo:${repository} is:pr ${created ? `created:${since}..${range.until}` : "is:open"}`);
    const { body } = await request(`/search/issues?q=${query}&per_page=1`);
    const result = searchSchema.parse(body);
    if (result.incomplete_results) throw new Error("GitHub returned an incomplete PR count; try again.");
    return { value: result.total_count, detail: created ? `Created · ${range.label} · all states, includes drafts` : "Open now · includes drafts", error: null, series: null, seriesError: null };
  }
  async function reviews() {
    const query = encodeURIComponent(`repo:${repository} is:pr is:open draft:false review:none`);
    const { body } = await request(`/search/issues?q=${query}&sort=created&order=asc&per_page=5`);
    const result = reviewSearchSchema.parse(body);
    if (result.incomplete_results) throw new Error("GitHub returned an incomplete review queue; try again.");
    return { total: result.total_count, error: null, items: result.items.map((item) => ({
      number: item.number, title: item.title, createdAt: item.created_at, url: `https://github.com/${repository}/pull/${item.number}`,
    })) };
  }
  async function production() {
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
    const path = `/repos/${repository}/actions/runs?created=${encodeURIComponent(`${since}..${range.until}`)}`;
    const completedPath = `${path}&status=completed&per_page=100`;
    const first = await request(`${completedPath}&page=1`);
    const completed = countSchema.parse(first.body).total_count;
    function summary(total: number, successful: number) {
      if (successful > total) throw new Error("GitHub run counts changed during refresh; try again.");
      return {
        value: total === 0 ? null : successful / total * 100,
        detail: total === 0 ? `No completed workflow runs · ${range.label}` : `${successful} of ${total} completed workflow runs · ${range.label}`, error: null,
      };
    }
    async function incomplete(message: string) {
      const { body } = await request(`${path}&status=success&per_page=1`);
      const successful = countSchema.parse(body).total_count;
      return { metric: { ...summary(completed, successful), series: null, seriesError: message }, outcomes: null };
    }
    async function history(start: number, finish: number, response?: Awaited<ReturnType<typeof request>>): Promise<Map<number, z.infer<typeof runSchema>>> {
      const filteredPath = `/repos/${repository}/actions/runs?created=${encodeURIComponent(`${new Date(start).toISOString()}..${new Date(finish).toISOString()}`)}&status=completed&per_page=100`;
      const initial = response ?? await request(`${filteredPath}&page=1`);
      const total = countSchema.parse(initial.body).total_count;
      if (total > 1000) {
        // GitHub caps each filtered search at 1,000 and may truncate total_count at 2,500.
        const middle = Math.floor((start + finish) / 2000) * 1000;
        if (middle < start || middle + 1000 > finish) throw new Error("GitHub returned more than 1,000 runs in one second; complete CI history is unavailable.");
        const rows = await history(start, middle);
        for (const [id, row] of await history(middle + 1000, finish)) {
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
    }
    try {
      const rows = await history(cutoff, end, first);
      const totals = emptySeries();
      const passed = Array<number>(bucketCount).fill(0);
      const outcomes: Record<string, number> = Object.create(null);
      for (const row of rows.values()) {
        const index = bucket(row.created_at);
        if (index < 0) throw new Error("GitHub returned a run outside the time window");
        totals[index].value++;
        if (row.conclusion === "success") passed[index]++;
        const state = row.conclusion ?? "unknown";
        outcomes[state] = (outcomes[state] ?? 0) + 1;
      }
      return { metric: { ...summary(rows.size, outcomes.success ?? 0), series: totals.map((point, index) => ({
        date: point.date, value: point.value === 0 ? null : passed[index] / point.value * 100,
      })), seriesError: null }, outcomes };
    } catch {
      signal.throwIfAborted();
      // Large fallback counts can be truncated; never turn them into a precise pass rate.
      if (completed > 1000) throw new Error("GitHub complete CI history could not be loaded. Retry on the next refresh.");
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
  const [deployResult, prResult, ciResult, reviewResult, productionResult, createdPrResult, commitResult] = await Promise.allSettled([
    deployments(), pullRequests(), ci(), reviews(), production(), pullRequests(true),
    loadCommitActivity(repository, token, since, range.until, request),
  ]);
  return {
    repository, updatedAt: now.toISOString(), range,
    deployments: deployResult.status === "fulfilled" ? deployResult.value : failedMetric(deployResult.reason),
    pullRequestsCreated: createdPrResult.status === "fulfilled" ? createdPrResult.value : failedMetric(createdPrResult.reason),
    commitActivity: commitResult.status === "fulfilled" ? commitResult.value : { commits: null, additions: null, deletions: null, branch: null, error: errorMessage(commitResult.reason) },
    pullRequests: prResult.status === "fulfilled" ? prResult.value : failedMetric(prResult.reason),
    ci: ciResult.status === "fulfilled" ? ciResult.value.metric : failedMetric(ciResult.reason),
    ciOutcomes: ciResult.status === "fulfilled" ? ciResult.value.outcomes : null,
    reviewQueue: reviewResult.status === "fulfilled" ? reviewResult.value : { total: null, items: [], error: errorMessage(reviewResult.reason) },
    production: productionResult.status === "fulfilled" ? productionResult.value : { deployment: null, error: errorMessage(productionResult.reason) },
  };
}
