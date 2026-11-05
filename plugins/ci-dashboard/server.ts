import { defaultDraftRules, draftRules, draftNameSchema, draftSettingLabels } from "./draft-deferrals";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { defineRpcContract, type BbPluginApi, type PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { minimumDate, rangeInputSchema, rangeSchema, resolveRange, type RangeInput, type DateRange } from "./date-range";
import { githubRequest, historicalRecordsSchema, loadMetrics, metricsSchema, repositorySchema, type GitHubRequest, type GitHubResponse, type HistoricalRecords, type Metrics } from "./metrics";
import { resolveGithubToken } from "./auth";
import { dispatchProduction, productionTargetFrom } from "./production";
import { githubRepository, repositoriesSettingSchema, splitRepositories, uniqueRepositories } from "./repositories";
import { cardDetailsInput, cardDetailsOutput, loadCardDetails } from "./card-details";
import { createGitHubCache } from "./github-cache";
import { capOpenSignals, cleanupCache, compress, decompress, deepDays, deepIdleMs, jobMaxBytes, purgeDeadResponses, shallowFloor, storageStats } from "./cache-cleanup";
import { ciQuerySchema, ciReportSchema, ciReport, ciSliceReport, type CiQuery } from "./agent-ci";
import { classifyJobs, detectMassCancel, runnerLosses, summarizeReruns, type MassCancel } from "./ci-classify";
import { createBackfill, createJobStore, createLogFetcher, jobMigrations, normalizeJob } from "./ci-jobs";
import type { ClassifiedJob, PoolQueueState, RerunSummary, Signal } from "./ci-jobs-types";
import { createIncidentTracker, detectStalls, fetchLiveJobs, poolQueueStates } from "./ci-live";
import { buildSignals, shouldPush, sortSignals, summarizeAnalysis } from "./ci-signals";
import { navigationBadgeOutputSchema, repositorySignalsSchema, signalsInputSchema, signalsOutputSchema, SIGNALS_CHANGED, type SignalsOutput } from "./ci-signals-contract";

const dashboardSchema = z.object({
  repositories: z.array(metricsSchema.extend({ projectName: z.string().nullable() })),
  authSource: z.enum(["plugin", "environment", "gh", "anonymous"]),
  discoveryError: z.string().nullable(),
});
export type DashboardData = z.infer<typeof dashboardSchema>;
export const rpcContract = defineRpcContract({
  metrics: { input: z.union([rangeInputSchema, z.object({ selection: rangeInputSchema, force: z.literal(true) }).strict()]), output: dashboardSchema },
  snapshot: { input: rangeInputSchema, output: dashboardSchema.nullable() },
  cardDetails: { input: cardDetailsInput, output: cardDetailsOutput },
  deployProduction: { input: z.null(), output: z.object({ url: z.url() }) },
  interval: {
    input: z.object({ repository: repositorySchema, since: z.iso.datetime(), until: z.iso.datetime() }).strict(),
    output: metricsSchema,
  },
  signals: { input: signalsInputSchema, output: signalsOutputSchema },
  navigationBadge: { input: z.null(), output: navigationBadgeOutputSchema },
});

export const ciRpcContract = defineRpcContract({ ci: { input: ciQuerySchema, output: ciReportSchema } });

const actorName = z.string().trim().min(1).max(60);
// Settings that feed cached GitHub data; the signals settings must not invalidate it.
const dashboardSettingKeys = ["importBbRepositories", "repository", "draftWorkflow", "draftJob", "draftStep", "token", "refreshSeconds"] as const;

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    importBbRepositories: {
      type: "boolean", label: "Include GitHub repositories from BB projects", default: true,
    },
    repository: {
      type: "string",
      label: "Additional GitHub repositories (owner/repo, one per line or comma-separated)",
      default: "",
      experimental_multiline: true,
      experimental_schema: repositoriesSettingSchema,
    },
    draftWorkflow: { type: "string", label: draftSettingLabels.draftWorkflow, default: defaultDraftRules.workflow, experimental_schema: draftNameSchema },
    draftJob: { type: "string", label: draftSettingLabels.draftJob, default: defaultDraftRules.job, experimental_schema: draftNameSchema },
    draftStep: { type: "string", label: draftSettingLabels.draftStep, default: defaultDraftRules.step, experimental_schema: draftNameSchema },
    productionRepository: { type: "string", label: "Production deploy: repository (owner/repo, blank hides the action)", default: "", experimental_schema: z.string().trim().max(200).refine((value) => !value || repositorySchema.safeParse(value).success, "Use owner/repo") },
    productionWorkflow: { type: "string", label: "Production deploy: workflow file name (required with a repository)", default: "", experimental_schema: z.string().trim().max(200).regex(/^[\w.-]*$/, "Use a workflow file name such as deploy.yaml") },
    productionRef: { type: "string", label: "Production deploy: branch or tag to deploy", default: "main", experimental_schema: z.string().trim().min(1).max(200) },
    token: { type: "string", label: "GitHub token override (blank uses system authorization)", secret: true },
    refreshSeconds: {
      type: "number",
      label: "Refresh interval in seconds (30–3600)",
      default: 300,
      experimental_schema: z.number().int().min(30).max(3600),
    },
    stallMinutes: { type: "number", label: "Runner pool stall threshold in minutes (3–120)", default: 10, experimental_schema: z.number().int().min(3).max(120) },
    jobBudgetPerHour: { type: "number", label: "GitHub requests per hour for job-history backfill (100–4000)", default: 1500, experimental_schema: z.number().int().min(100).max(4000) },
    jobHistoryDays: { type: "number", label: "Days of job history kept for signals (1–30)", default: 14, experimental_schema: z.number().int().min(1).max(30) },
    aggregatorJobs: { type: "string", label: "Aggregator job names that only fail because another job did (comma-separated)", default: "", experimental_schema: z.string().max(2000) },
    policyJobs: { type: "string", label: "Policy job names whose failures are never treated as flakes (comma-separated)", default: "", experimental_schema: z.string().max(2000) },
    actorOwnerSre: { type: "string", label: "Signals: display name for runner owner / SRE", default: "Runner owner / SRE", experimental_schema: actorName },
    actorPrAuthor: { type: "string", label: "Signals: display name for the PR author", default: "PR author", experimental_schema: actorName },
    actorLead: { type: "string", label: "Signals: display name for the lead", default: "Lead", experimental_schema: actorName },
    actorManager: { type: "string", label: "Signals: display name for the manager", default: "Manager", experimental_schema: actorName },
  });
  type Values = Awaited<ReturnType<typeof settings.get>>;
  let deploying = false;
  const controller = new AbortController();
  bb.onDispose(() => controller.abort());
  const database = bb.storage.database();
  bb.storage.migrate(database, [
    "CREATE TABLE dashboard_snapshots (selection TEXT PRIMARY KEY, configuration TEXT NOT NULL, data TEXT NOT NULL, refreshed_at INTEGER NOT NULL)",
    "ALTER TABLE dashboard_snapshots ADD COLUMN history TEXT",
    "CREATE TABLE repository_history (repository TEXT NOT NULL, configuration TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(repository, configuration))",
    "CREATE TABLE github_responses (cache_key TEXT PRIMARY KEY, data TEXT NOT NULL, checked_at INTEGER NOT NULL)",
    "ALTER TABLE github_responses ADD COLUMN last_used_at INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE repository_history ADD COLUMN last_used_at INTEGER NOT NULL DEFAULT 0",
    ...jobMigrations,
  ]);
  database.prepare("UPDATE github_responses SET last_used_at = checked_at WHERE last_used_at = 0").run();
  database.prepare("UPDATE repository_history SET last_used_at = ? WHERE last_used_at = 0").run(Date.now());
  try {
    const purged = purgeDeadResponses(database);
    if (purged) bb.log.info(`Purged ${purged} unreachable cached GitHub responses.`);
  } catch { bb.log.warn("Cache purge failed; a later cleanup will retry without interrupting metrics."); }
  const cachedRequest = createGitHubCache(database);
  const repositoryPending = new Map<string, Promise<Metrics>>();
  const historySchema = z.object({ metrics: metricsSchema, records: historicalRecordsSchema, coverage: rangeSchema, checkedAt: z.number(), authSource: dashboardSchema.shape.authSource.optional(), projectName: z.string().nullable().optional() });
  type RepositoryHistory = z.infer<typeof historySchema>;
  let lastStarted = 0;
  let repositoryList: { configuration: string; names: string[] } | null = null;
  let generation = 0;
  const pending = new Map<string, Promise<DashboardData>>();
  // Finished full collections, so a forced refresh right after one returns it instead of repeating ~150 requests.
  const recentFull = new Map<string, { at: number; result: DashboardData }>();
  // Per repository window verification times: old windows are revalidated hourly, not every cycle.
  const windowChecks = new Map<string, Map<string, number>>();
  let nextCleanup = 0;
  // When a range older than the 90-day preset was last requested; stored history deeper than that is trimmed after a week without one.
  // Persisted so a restart does not reset the clock; the first run grants a full grace period.
  let lastDeepAt = Date.now(), deepPersisted = 0, deepTouched = false;
  void bb.storage.kv.get<number>("deep-range-at").then((at) => {
    if (typeof at === "number") { deepPersisted = at; if (!deepTouched) lastDeepAt = at; } else { deepPersisted = lastDeepAt; return bb.storage.kv.set("deep-range-at", lastDeepAt); }
  }).catch(() => { /* Without the stored time the in-memory grace period applies. */ });
  function markDeep(range: DateRange) {
    if (Date.parse(range.since) >= Date.now() - (deepDays + 1) * 86_400_000) return;
    deepTouched = true; lastDeepAt = Date.now();
    if (lastDeepAt - deepPersisted >= 3_600_000) { deepPersisted = lastDeepAt; void bb.storage.kv.set("deep-range-at", lastDeepAt).catch(() => {}); }
  }
  function clean(compact = false) {
    if (compact) nextCleanup = Date.now() + 3_600_000;
    try {
      const result = cleanupCache(database, repositoryList?.names, compact && pending.size === 0 && repositoryPending.size === 0, Date.now() - lastDeepAt >= deepIdleMs ? shallowFloor() : undefined);
      if (result.removed) bb.log.info(`Cache cleanup removed ${result.removed} entries; ${result.bytes} payload bytes retained.`);
    } catch { bb.log.warn("Cache maintenance failed; a later cleanup will retry without interrupting metrics."); }
  }
  function currentTimings(result: DashboardData) {
    return result.repositories.every((repo) => !repo.ciInsights || (repo.ciInsights.timing.basis === "success" && repo.ciInsights.draftPolicy === "job-evidence-v1"));
  }
  function touchSnapshot(result: DashboardData, selection: string, config: string) {
    database.prepare("UPDATE dashboard_snapshots SET refreshed_at = ? WHERE selection = ? AND configuration = ?").run(Date.now(), selection, config);
    for (const repo of result.repositories) database.prepare("UPDATE repository_history SET last_used_at = ? WHERE repository = ? AND configuration = ?").run(Date.now(), repo.repository, config);
    return result;
  }
  clean(true);
  function selectionKey(input: RangeInput) {
    const selection = rangeInputSchema.parse(input) ?? { days: 7 };
    return JSON.stringify("days" in selection && selection.days === 1 ? ["calendar-day-v1", selection]
      : "days" in selection && selection.days === 3 ? ["half-day-buckets-v1", selection] : selection);
  }
  function configuration(values: Awaited<ReturnType<typeof settings.get>>) {
    const rules = draftRules(values);
    // Preserve existing caches on upgrade when the recognition rule has not changed.
    const custom = JSON.stringify(rules) === JSON.stringify(defaultDraftRules) ? [] : [rules];
    return createHash("sha256").update(JSON.stringify(["ci-exclude-cancelled-skipped-v1", "review:none", values.repository, values.importBbRepositories, values.token ?? "", ...custom])).digest("hex");
  }
  settings.onChange((next, prev) => {
    // Job rows and incident state never depend on settings; only the cached dashboard data does.
    if (dashboardSettingKeys.every((key) => next[key] === prev[key])) { bb.realtime.publish(SIGNALS_CHANGED, {}); return; }
    generation++;
    repositoryList = null;
    recentFull.clear();
    windowChecks.clear();
    database.prepare("DELETE FROM dashboard_snapshots").run();
    database.prepare("DELETE FROM repository_history").run();
    database.prepare("DELETE FROM github_responses").run();
    bb.realtime.publish("configuration-changed", {});
  });
  async function metrics(input: RangeInput, force = false): Promise<DashboardData> {
    const version = generation;
    const values = await settings.get();
    const config = configuration(values);
    const selection = selectionKey(input);
    const key = `${version}:${config}:${selection}`;
    const existing = pending.get(key);
    if (existing) return existing;
    const recent = force ? recentFull.get(key) : undefined;
    if (recent && Date.now() - recent.at < 60_000) return recent.result;
    const histories: Record<string, HistoricalRecords> = {};
    const request = collect(input, values, histories, force, version).then((result) => {
      if (!controller.signal.aborted && version === generation) {
        database.prepare("INSERT INTO dashboard_snapshots (selection, configuration, data, refreshed_at, history) VALUES (?, ?, ?, ?, ?) ON CONFLICT(selection) DO UPDATE SET configuration = excluded.configuration, data = excluded.data, refreshed_at = excluded.refreshed_at, history = excluded.history")
          .run(selection, config, JSON.stringify(result), Date.now(), compress(JSON.stringify(histories)));
        // A history is reported only by a repository that completed a full collection.
        if (result.repositories.length && Object.keys(histories).length === result.repositories.length) {
          for (const [stale, entry] of recentFull) if (Date.now() - entry.at >= 60_000) recentFull.delete(stale);
          recentFull.set(key, { at: Date.now(), result });
        }
        // shortcut: retain eight recent ranges; increase if revisiting more ranges becomes common.
        clean();
      }
      return result;
    });
    pending.set(key, request);
    try { return await request; }
    finally { pending.delete(key); }
  }
  async function discover(values: Values) {
    const repositories = splitRepositories(repositoriesSettingSchema.parse(values.repository));
    const projectNames = new Map<string, string>();
    let discoveryError: string | null = null;
    if (values.importBbRepositories) {
      try {
        const projects = await bb.sdk.projects.list({ includePersonal: true, signal: controller.signal });
        for (const project of projects) {
          const repo = githubRepository(project.gitRemoteUrl);
          if (repo) {
            repositories.push(repo);
            if (!projectNames.has(repo.toLowerCase())) projectNames.set(repo.toLowerCase(), project.name);
          }
        }
      } catch {
        controller.signal.throwIfAborted();
        discoveryError = "Unable to discover BB project repositories. Additional repositories are still shown; retry to update the project list.";
      }
    }
    return { names: uniqueRepositories(repositories), projectNames, discoveryError };
  }
  async function collect(input: RangeInput, values: Awaited<ReturnType<typeof settings.get>>, histories: Record<string, HistoricalRecords>, force: boolean, version: number): Promise<DashboardData> {
    const range = resolveRange(input);
    markDeep(range);
    const { names, projectNames, discoveryError } = await discover(values);
    const { token, source } = await resolveGithubToken(values.token, controller.signal);
    if (version === generation && !discoveryError) {
      repositoryList = { configuration: configuration(values), names };
      clean();
    }
    return {
      repositories: await Promise.all(names.map(async (repo) => ({
        ...await collectRepository(repo, input, range, values, token, force, version, projectNames.get(repo.toLowerCase()) ?? null, source, (records) => { histories[repo] = records; }),
        projectName: projectNames.get(repo.toLowerCase()) ?? null,
      }))),
      authSource: source,
      discoveryError,
    };
  }
  function readHistory(repository: string, config: string): RepositoryHistory | undefined {
    const row = database.prepare("SELECT data FROM repository_history WHERE repository = ? AND configuration = ?").get(repository, config) as { data: string | Uint8Array } | undefined;
    if (row) { try {
      const result = historySchema.parse(JSON.parse(decompress(row.data)));
      database.prepare("UPDATE repository_history SET last_used_at = ? WHERE repository = ? AND configuration = ?").run(Date.now(), repository, config);
      return result;
    } catch { /* Fall back to validated snapshots. */ } }
    const snapshots = database.prepare("SELECT data, history FROM dashboard_snapshots WHERE configuration = ? AND history IS NOT NULL ORDER BY refreshed_at DESC LIMIT 8").all(config) as { data: string; history: string | Uint8Array }[];
    let best: RepositoryHistory | undefined;
    for (const snapshot of snapshots) {
      try {
        const dashboard = dashboardSchema.parse(JSON.parse(snapshot.data));
        const metrics = dashboard.repositories.find((repo) => repo.repository === repository);
        const records = z.record(repositorySchema, historicalRecordsSchema).parse(JSON.parse(decompress(snapshot.history)))[repository];
        if (metrics && records && (!best || Date.parse(metrics.range.until) - Date.parse(metrics.range.since) > Date.parse(best.coverage.until) - Date.parse(best.coverage.since))) {
          best = { metrics, records, coverage: metrics.range, checkedAt: Date.parse(metrics.updatedAt), authSource: dashboard.authSource };
        }
      } catch { /* Ignore incomplete legacy history. */ }
    }
    if (best && !controller.signal.aborted) database.prepare("INSERT INTO repository_history (repository, configuration, data, last_used_at) VALUES (?, ?, ?, ?) ON CONFLICT(repository, configuration) DO NOTHING").run(repository, config, compress(JSON.stringify(best)), Date.now());
    return best;
  }
  async function collectRepository(repository: string, input: RangeInput, range: DateRange, values: Awaited<ReturnType<typeof settings.get>>, token: string | undefined, force: boolean, version: number, projectName: string | null, authSource: DashboardData["authSource"], onHistory: (records: HistoricalRecords) => void): Promise<Metrics> {
    const config = configuration(values);
    const key = JSON.stringify([version, config, repository]);
    const running = repositoryPending.get(key);
    if (running) await running;
    const source = readHistory(repository, config);
    const ttl = values.refreshSeconds * 1000;
    const canWrite = () => version === generation && !controller.signal.aborted;
    const request = cachedRequest(JSON.stringify([config, createHash("sha256").update(token ?? "").digest("hex")]), token, controller.signal, ttl, force, canWrite);
    const startedAt = lastStarted = Math.max(Date.now(), lastStarted + 1);
    const progress = (metrics: Metrics) => {
      if (canWrite()) bb.realtime.publish("metrics-progress", { selection: JSON.stringify(input ?? { days: 7 }), startedAt, metrics: { ...metrics, projectName } });
    };
    let asOf = range;
    if (source) { try { asOf = resolveRange(input, new Date(source.coverage.until)); } catch { /* A newer calendar selection requires fresh coverage. */ } }
    if (!force && source && Date.now() - Date.parse(source.metrics.updatedAt) >= 0 && Date.now() - Date.parse(source.metrics.updatedAt) < ttl && Date.parse(asOf.since) >= Date.parse(source.coverage.since) && Date.parse(asOf.until) <= Date.parse(source.coverage.until)
      && (Date.parse(range.until) <= Date.parse(source.coverage.until) || Date.now() - Date.parse(source.coverage.until) < ttl)) {
      // One repository history serves every contained view; PR creation counts remain range-specific.
      // Cached loads only ever add draft classifications to the stored runs; rewrite the row only when one was added.
      const classified = () => source.records.runs.reduce((count, run) => count + (run.draftDeferred === undefined ? 0 : 1), 0), before = classified();
      const metrics = await loadMetrics(repository, token, controller.signal, asOf, { metrics: source.metrics, records: source.records }, undefined, { request, draftRules: draftRules(values), onProgress: progress });
      if (canWrite() && classified() !== before) database.prepare("UPDATE repository_history SET data = ? WHERE repository = ? AND configuration = ?").run(compress(JSON.stringify(source)), repository, config);
      return metrics;
    }
    let start = Date.parse(range.since), finish = Date.parse(range.until);
    if (source && start <= Date.parse(source.coverage.until) && finish >= Date.parse(source.coverage.since)) {
      start = Math.min(start, Date.parse(source.coverage.since));
      finish = Math.max(finish, Date.parse(source.coverage.until));
      if (Date.parse(range.since) >= Date.now() - 90 * 86_400_000) start = Math.max(start, Date.now() - 90 * 86_400_000);
    }
    start = Math.max(start, Date.parse(minimumDate()));
    const coverage: DateRange = { since: new Date(Math.floor(start / 86_400_000) * 86_400_000).toISOString(), until: new Date(finish).toISOString(), label: "repository history", bucketMs: 86_400_000 };
    let records: HistoricalRecords | undefined;
    const checks = windowChecks.get(key) ?? new Map<string, number>();
    windowChecks.set(key, checks);
    const operation = loadMetrics(repository, token, controller.signal, range, undefined, (value) => { records = value; }, { request, draftRules: draftRules(values), historyRange: coverage, previous: source?.records, partitionCi: true, reuse: source ? { coverage: source.coverage, checked: checks } : undefined, onProgress: progress, onWarning: (message) => { if (canWrite()) bb.log.warn(`CI history for ${repository}: ${message}`); } }).then((metrics) => {
      if (records && canWrite()) {
        const result: RepositoryHistory = { metrics, records, coverage, checkedAt: Date.now(), projectName, authSource };
        database.prepare("INSERT INTO repository_history (repository, configuration, data, last_used_at) VALUES (?, ?, ?, ?) ON CONFLICT(repository, configuration) DO UPDATE SET data = excluded.data, last_used_at = excluded.last_used_at").run(repository, config, compress(JSON.stringify(result)), Date.now());
        // Range snapshots store only records covered by their own captions.
        onHistory({ ...records, deployments: records.deployments.filter((row) => Date.parse(row.created_at) >= Date.parse(range.since) && Date.parse(row.created_at) <= Date.parse(range.until)), runs: records.runs.filter((row) => Date.parse(row.created_at) >= Date.parse(range.since) && Date.parse(row.created_at) <= Date.parse(range.until)), commits: records.commits.filter((row) => Date.parse(row.committedDate) >= Date.parse(range.since) && Date.parse(row.committedDate) <= Date.parse(range.until)) });
      }
      return metrics;
    });
    repositoryPending.set(key, operation);
    try { return await operation; }
    finally { if (repositoryPending.get(key) === operation) repositoryPending.delete(key); }
  }
  bb.background.service("snapshot-refresh", {
    async start(signal) {
      const stop = () => controller.abort();
      signal.addEventListener("abort", stop, { once: true });
      try {
        while (!signal.aborted) {
          if (Date.now() >= nextCleanup && pending.size === 0 && repositoryPending.size === 0) clean(true);
          if (Date.now() >= nextRetain) await retain().catch(() => {});
          try { await metrics(null); }
          catch { if (!signal.aborted) bb.log.warn("Dashboard background refresh failed."); }
          const { refreshSeconds } = await settings.get();
          await delay(refreshSeconds * 1000, undefined, { signal });
        }
      } catch (error) {
        if (!signal.aborted) throw error;
      } finally { signal.removeEventListener("abort", stop); }
    },
  });
  // Job-level signals: live pool polling, budgeted job backfill, classification, incident tracking and push.
  type RepositorySignals = SignalsOutput["repositories"][number];
  type View = Omit<RepositorySignals, "signals">;
  type Incidents = { open: Signal[]; recent: Signal[] };
  type Runtime = {
    signal: AbortSignal; etags: Map<string, GitHubResponse>; liveKnown: boolean; pools: PoolQueueState[]; truncated: boolean; polledAt: string | null; stalls: Signal[];
    defaultBranch: string | null; historyReadAt: number;
    backfill?: { key: string; enqueued: string; run: ReturnType<typeof createBackfill>; status: { processed: number; remaining: number; pausedUntil: number | null; failed: number } };
    analysis?: { key: string; at: number; classified: ClassifiedJob[]; reruns: RerunSummary[]; massCancels: MassCancel[]; summary: ReturnType<typeof summarizeAnalysis> };
    incidents?: Incidents; persisted?: string; resultIds?: string; tracker: ReturnType<typeof createIncidentTracker>; view?: View; signature?: string;
  };
  const jobStore = createJobStore(database);
  const runtimes = new Map<string, Runtime>();
  const loggedErrors = new Set<string>();
  let nextPrune = 0;
  const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
  function logOnce(message: string) {
    if (loggedErrors.has(message)) return;
    if (loggedErrors.size >= 100) loggedErrors.clear();
    loggedErrors.add(message);
    bb.log.warn(message);
  }
  const actorNames = (values: Values) => ({ owner_sre: values.actorOwnerSre, pr_author: values.actorPrAuthor, lead: values.actorLead, manager: values.actorManager });
  const zeroSummary = (repository: string) => summarizeAnalysis({ classified: [], reruns: [], massCancels: [], losses: runnerLosses([]), repository });
  const emptyView = (repository: string, days: number, now: number): View => ({
    repository, updatedAt: null, error: null, live: { pools: [], truncated: false, polledAt: null },
    window: { since: new Date(now - days * 86_400_000).toISOString(), until: new Date(now).toISOString() },
    ...zeroSummary(repository), backfill: { remaining: 0, failed: 0, pausedUntil: null, coveredSince: null },
  });
  function runtimeFor(repo: string): Runtime {
    let rt = runtimes.get(repo);
    if (!rt) {
      const created: Runtime = { signal: controller.signal, etags: new Map(), liveKnown: false, pools: [], truncated: false, polledAt: null, stalls: [], defaultBranch: null, historyReadAt: 0,
        tracker: createIncidentTracker(() => created.incidents, (state) => { created.incidents = state; }) };
      runtimes.set(repo, rt = created);
    }
    return rt;
  }
  async function loadIncidents(repo: string, rt: Runtime) {
    rt.incidents ??= await bb.storage.kv.get<Incidents>(`incidents:${repo}`);
    return rt.incidents;
  }
  async function repositoryNames(values: Values) {
    return repositoryList?.configuration === configuration(values) ? repositoryList.names : (await discover(values)).names;
  }
  // Same numbers for the navigationBadge RPC and the SIGNALS_CHANGED payload, so the badge needs no extra RPC.
  async function badgeCounts(values: Values) {
    const open = (await Promise.all((await repositoryNames(values)).map(async (repo) => (await loadIncidents(repo, runtimeFor(repo)))?.open ?? []))).flat();
    return { count: open.filter((signal) => signal.severity !== "info").length, critical: open.filter((signal) => signal.severity === "critical").length };
  }
  async function signalsRepository(repo: string, values: Values, token: string | undefined, signal: AbortSignal) {
    const rt = runtimeFor(repo);
    rt.signal = signal;
    const now = Date.now(), nowIso = new Date(now).toISOString(), days = values.jobHistoryDays;
    const errors: string[] = [];
    const fail = (stage: string, error: unknown) => {
      signal.throwIfAborted();
      errors.push(`${stage}: ${describe(error)}`);
      logOnce(`CI signals for ${repo}: ${stage}: ${describe(error)}`);
    };
    await loadIncidents(repo, rt);
    if (!token) fail("authorization", "GitHub authorization is required for job-level signals");
    else {
      try { // 1. live pool state; the ETag map keeps unchanged pages free and is pruned to the paths seen in this poll.
        const used = new Map<string, GitHubResponse>();
        const request: GitHubRequest = async (path, init) => { const response = await githubRequest(path, token, rt.signal, init, rt.etags.get(path)); used.set(path, response); return response; };
        const live = await fetchLiveJobs(request, repo, (raw, { run, attempt }) => normalizeJob(raw, {
          repository: repo, runId: run.id, attempt, workflowName: run.name ?? "", event: run.event ?? "", headBranch: run.head_branch ?? null, headSha: run.head_sha ?? "",
          pullRequests: (run.pull_requests ?? []).map((pr: number | { number: number }) => typeof pr === "number" ? pr : pr.number),
        }));
        const starts = jobStore.listJobs({ repository: repo, since: new Date(now - 3 * 3_600_000).toISOString(), until: nowIso }).flatMap((job) => job.startedAt ? [{ pool: job.pool, startedAt: job.startedAt }] : []);
        rt.pools = poolQueueStates(live.jobs, starts, now);
        rt.stalls = detectStalls(rt.pools, { stallMinutes: values.stallMinutes }, now);
        Object.assign(rt, { etags: used, truncated: live.truncated, polledAt: nowIso, liveKnown: true });
      } catch (error) { fail("live poll", error); }
      try { // 2. backfill with plain requests: the 512-entry response cache would be evicted by job pages.
        const key = `${createHash("sha256").update(token).digest("hex")}:${values.jobBudgetPerHour}`;
        if (rt.backfill?.key !== key) rt.backfill = { key, enqueued: "", status: { processed: 0, remaining: 0, pausedUntil: null, failed: 0 }, run: createBackfill({
          store: jobStore, budgetPerHour: values.jobBudgetPerHour, request: (path, init) => githubRequest(path, token, rt.signal, init), fetchText: createLogFetcher(token, controller.signal) }) };
        const history = !rt.backfill.enqueued || now - rt.historyReadAt >= 300_000 ? readHistory(repo, configuration(values)) : undefined;
        if (history) {
          rt.historyReadAt = now;
          rt.defaultBranch = history.records.branch ?? history.metrics.ciInsights?.defaultBranch ?? null;
          const stamp = `${history.checkedAt}:${days}`;
          // Runs stored before 0.2.0 lack head_sha and PR numbers; every job response carries its own head_sha, so they are still backfilled.
          if (rt.backfill.enqueued !== stamp) {
            rt.backfill.enqueued = stamp;
            rt.backfill.run.enqueue(repo, history.records.runs.filter((run) => run.conclusion !== null && run.conclusion !== "skipped" && !run.draftDeferred && Date.parse(run.created_at) >= now - days * 86_400_000)
              .map((run) => ({ id: run.id, run_attempt: run.run_attempt ?? 1, status: "completed", conclusion: run.conclusion, name: run.name ?? null, event: run.event ?? "", head_branch: run.head_branch ?? null, head_sha: run.head_sha ?? "", pull_requests: run.pull_requests ?? [], created_at: run.created_at })));
          }
        }
        rt.backfill.status = await rt.backfill.run.step(signal);
      } catch (error) { fail("backfill", error); }
    }
    // 3. analysis, recomputed at most every five minutes even while the backfill stores rows (the live pool state above stays per minute).
    const names = (list: string) => list.split(",").map((name) => name.trim()).filter(Boolean);
    const aggregatorJobs = names(values.aggregatorJobs), policyJobs = names(values.policyJobs);
    const analysisKey = JSON.stringify([days, aggregatorJobs, policyJobs]);
    const recompute = !rt.analysis || rt.analysis.key !== analysisKey || now - rt.analysis.at >= 300_000;
    if (recompute) {
      try {
        const jobs = jobStore.listJobs({ repository: repo, since: new Date(now - days * 86_400_000).toISOString(), until: nowIso });
        const classified = classifyJobs(jobs, { aggregatorJobs, policyJobs }), reruns = summarizeReruns(jobs), massCancels = detectMassCancel(classified);
        rt.analysis = { key: analysisKey, at: now, classified, reruns, massCancels, summary: summarizeAnalysis({ classified, reruns, massCancels, losses: runnerLosses(classified), repository: repo }) };
      } catch (error) { fail("analysis", error); }
    }
    // 4. signals and push. Without a successful live poll the stall state is unknown, so incidents are left untouched instead of resolved.
    if (rt.analysis && rt.liveKnown) {
      try {
        const { opened } = rt.tracker.update(capOpenSignals(buildSignals({ classified: rt.analysis.classified, reruns: rt.analysis.reruns, massCancels: rt.analysis.massCancels, stalls: rt.stalls, defaultBranch: rt.defaultBranch, repository: repo, now })), now);
        const names = actorNames(values);
        for (const opening of opened) if (shouldPush(opening, rt.defaultBranch, now)) {
          try { await bb.sdk.plugins.callRpc({ pluginId: "push-notifications", method: "notifications.send", input: { title: opening.title, body: `${opening.what} · ${names[opening.actor]}` }, outputSchema: z.unknown(), signal }); }
          catch (error) { signal.throwIfAborted(); logOnce(`CI signals push for ${repo} failed: ${describe(error)}`); }
        }
        const text = JSON.stringify(rt.incidents);
        if (text !== rt.persisted) { await bb.storage.kv.set(`incidents:${repo}`, rt.incidents); rt.persisted = text; }
      } catch (error) { fail("signals", error); }
    }
    // 5. view for the RPC (kept in memory and kv) and a realtime nudge when something visible changed.
    const status = rt.backfill?.status;
    const oldest = (database.prepare("SELECT MIN(created_at) AS oldest FROM ci_jobs WHERE repository = ?").get(repo) as { oldest: string | null }).oldest;
    rt.view = { repository: repo, updatedAt: nowIso, error: errors.join("; ") || null, live: { pools: rt.pools, truncated: rt.truncated, polledAt: rt.polledAt },
      window: { since: new Date(now - days * 86_400_000).toISOString(), until: nowIso }, ...(rt.analysis?.summary ?? zeroSummary(repo)),
      backfill: { remaining: status?.remaining ?? 0, failed: status?.failed ?? 0, pausedUntil: status?.pausedUntil ? new Date(status.pausedUntil).toISOString() : null, coveredSince: oldest } };
    const openIds = JSON.stringify((rt.incidents?.open ?? []).map((item) => item.id).sort());
    const signature = JSON.stringify([openIds, rt.pools.map((pool) => [pool.pool, pool.queued, pool.inProgress])]);
    // The stored view is only a restart fallback: pool counts alone do not justify a write.
    if (recompute || openIds !== rt.resultIds) {
      try { await bb.storage.kv.set(`result:${repo}`, rt.view); rt.resultIds = openIds; } catch (error) { logOnce(`CI signals result for ${repo} not persisted: ${describe(error)}`); }
    }
    if (signature !== rt.signature) { rt.signature = signature; bb.realtime.publish(SIGNALS_CHANGED, await badgeCounts(values).catch(() => ({}))); }
  }
  // Hourly: drop data of repositories that are no longer configured, enforce the job-data ceiling and log disk use when it moved.
  let nextRetain = 0, loggedTotal = -Infinity;
  const mb = (bytes: number) => (bytes / 1_048_576).toFixed(1);
  async function retain() {
    const values = await settings.get();
    // Only a complete discovery may decide what is "no longer configured".
    if (repositoryList?.configuration !== configuration(values)) return;
    nextRetain = Date.now() + 3_600_000;
    const active = new Set(repositoryList.names.map((name) => name.toLowerCase()));
    try {
      jobStore.pruneRepositories([...active]);
      for (const prefix of ["result:", "incidents:"]) for (const key of await bb.storage.kv.list(prefix)) if (!active.has(key.slice(prefix.length).toLowerCase())) await bb.storage.kv.delete(key);
      for (const repo of runtimes.keys()) if (!active.has(repo.toLowerCase())) runtimes.delete(repo);
      const capped = jobStore.capBytes(jobMaxBytes);
      if (capped.removedDays) logOnce(`CI job data exceeded ${mb(jobMaxBytes)} MB; dropped its ${capped.removedDays} oldest day(s).`);
    } catch (error) { logOnce(`CI retention failed: ${describe(error)}`); }
    try {
      const stats = storageStats(database);
      if (Math.abs(stats.dbFile - loggedTotal) > 1_048_576) {
        loggedTotal = stats.dbFile;
        bb.log.info(`Storage: total ${mb(stats.dbFile)} MB (jobs ${mb(stats.jobs)}, history ${mb(stats.history)}, http cache ${mb(stats.httpCache)}, snapshots ${mb(stats.snapshots)}, free pages ${mb(stats.freePages)})`);
      }
    } catch { /* Statistics are informational. */ }
  }
  async function signalsPass(signal: AbortSignal) {
    const values = await settings.get();
    const names = await repositoryNames(values);
    if (!names.length) return;
    const { token } = await resolveGithubToken(values.token, signal);
    for (const repo of names) {
      try { await signalsRepository(repo, values, token, signal); }
      catch (error) { signal.throwIfAborted(); logOnce(`CI signals for ${repo} failed: ${describe(error)}`); }
    }
    if (Date.now() >= nextPrune) {
      nextPrune = Date.now() + 3_600_000;
      try { jobStore.prune(new Date(Date.now() - (values.jobHistoryDays + 1) * 86_400_000).toISOString()); } catch (error) { logOnce(`CI job store prune failed: ${describe(error)}`); }
    }
  }
  bb.background.service("ci-signals", {
    async start(signal) {
      try {
        while (!signal.aborted) {
          try { await signalsPass(signal); }
          catch (error) { if (signal.aborted) break; logOnce(`CI signals pass failed: ${describe(error)}`); }
          await delay(60_000, undefined, { signal });
        }
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    },
  });
  async function readView(repo: string, rt: Runtime, days: number): Promise<View> {
    if (!rt.view) {
      const stored = repositorySignalsSchema.omit({ signals: true }).safeParse(await bb.storage.kv.get(`result:${repo}`));
      rt.view = stored.success ? stored.data : emptyView(repo, days, Date.now());
    }
    return rt.view;
  }
  // Cuts the in-memory analysis to the dashboard range (no GitHub calls). Without an analysis (right after a restart) the stored view is returned as is.
  function rangedView(rt: Runtime, view: View, range: { since?: string; until?: string } | null): View & { coverage?: string | null } {
    if (!range?.since && !range?.until) return view;
    const coverage = view.backfill.coveredSince;
    if (!rt.analysis) return { ...view, coverage };
    const from = range.since ? Date.parse(range.since) : -Infinity, to = range.until ? Date.parse(range.until) : Infinity;
    const classified = rt.analysis.classified.filter(({ job }) => { const at = Date.parse(job.completedAt ?? job.createdAt); return at >= from && at <= to; });
    // RerunSummary has no timestamps: a rerun belongs to the range through its failed jobs.
    const runs = new Set(classified.map(({ job }) => job.runId));
    const reruns = rt.analysis.reruns.filter((run) => runs.has(run.runId));
    return { ...view, ...summarizeAnalysis({ classified, reruns, massCancels: detectMassCancel(classified), losses: runnerLosses(classified), repository: view.repository }), coverage };
  }
  const handlers: PluginRpcHandlers<typeof rpcContract> = {
    async signals(input) {
      const values = await settings.get();
      const names = await repositoryNames(values);
      const wanted = input?.repository ? names.filter((name) => name.toLowerCase() === input.repository!.toLowerCase()) : names;
      if (input?.repository && !wanted.length) throw new Error("Repository is not configured in CI Dashboard or could not be discovered.");
      return { actors: actorNames(values), repositories: await Promise.all(wanted.map(async (repo) => {
        const rt = runtimeFor(repo), incidents = await loadIncidents(repo, rt);
        return { ...rangedView(rt, await readView(repo, rt, values.jobHistoryDays), input), signals: sortSignals([...(incidents?.open ?? []), ...(incidents?.recent ?? [])]) };
      })) };
    },
    async navigationBadge() { return badgeCounts(await settings.get()); },
    async cardDetails(input) {
      const values = await settings.get();
      const { token } = await resolveGithubToken(values.token, controller.signal);
      return loadCardDetails(input, token, controller.signal, draftRules(values));
    },
    async deployProduction() {
      if (deploying) throw new Error("A production deployment request is already in progress.");
      deploying = true;
      try {
        const values = await settings.get();
        const { repository, importBbRepositories, token: override } = values;
        const target = productionTargetFrom(values);
        if (!target) throw new Error("Production deployment is not configured. Set the production repository and workflow in settings.");
        const wanted = target.repository.toLowerCase();
        let allowed = splitRepositories(repositoriesSettingSchema.parse(repository))
          .some((repo) => repo.toLowerCase() === wanted);
        if (!allowed && importBbRepositories) {
          const projects = await bb.sdk.projects.list({ includePersonal: true, signal: controller.signal });
          allowed = projects.some((project) => githubRepository(project.gitRemoteUrl)?.toLowerCase() === wanted);
        }
        if (!allowed) throw new Error("The production repository must be included in the configured dashboard repositories before deploying.");
        const { token } = await resolveGithubToken(override, controller.signal);
        return await dispatchProduction(target, token, controller.signal);
      } finally { deploying = false; }
    },
    async interval({ repository, since, until }) {
      const start = Date.parse(since), end = Date.parse(until);
      if (start < Date.parse(minimumDate()) || start > end || end > Date.now()) throw new Error("Invalid statistics interval.");
      const values = await settings.get();
      const { token } = await resolveGithubToken(values.token, controller.signal);
      const range: DateRange = { since, until, label: "selected interval", bucketMs: Math.max(1, end - start) };
      // Inside the stored coverage everything but the created-PR count is already local: one search instead of dozens of requests.
      const stored = readHistory(repository, configuration(values));
      const local = stored && Date.parse(stored.coverage.since) <= start && end <= Date.parse(stored.coverage.until) ? { metrics: stored.metrics, records: stored.records } : undefined;
      return loadMetrics(repository, token, controller.signal, range, local, undefined, { draftRules: draftRules(values) });
    },
    metrics: (input) => input && "selection" in input ? metrics(input.selection, input.force) : metrics(input),
    async snapshot(input) {
      resolveRange(input);
      const version = generation;
      const values = await settings.get();
      if (version !== generation) return null;
      const config = configuration(values);
      const row = database.prepare("SELECT data FROM dashboard_snapshots WHERE selection = ? AND configuration = ?")
        .get(selectionKey(input), config) as { data: string } | undefined;
      if (row) {
        const cached = dashboardSchema.parse(JSON.parse(row.data));
        if (currentTimings(cached)) return touchSnapshot(cached, selectionKey(input), config);
      }
      const candidates = database.prepare("SELECT selection, data, history FROM dashboard_snapshots WHERE configuration = ? AND history IS NOT NULL ORDER BY refreshed_at DESC LIMIT 8")
        .all(config) as { selection: string; data: string; history: string | Uint8Array }[];
      const common = database.prepare("SELECT data FROM repository_history WHERE configuration = ?").all(config) as { data: string | Uint8Array }[];
      const known = repositoryList?.configuration === config ? repositoryList.names : null;
      const shared = common.flatMap((row) => { try { return [historySchema.parse(JSON.parse(decompress(row.data)))]; } catch { return []; } }).filter((row) => !known || known.includes(row.metrics.repository));
      if (shared.length && (!known || known.every((name) => shared.some((row) => row.metrics.repository === name)))) candidates.unshift({ selection: "", data: JSON.stringify({ repositories: shared.map((row) => ({ ...row.metrics, range: row.coverage, projectName: row.projectName ?? null })), authSource: shared[0].authSource ?? "anonymous", discoveryError: null }), history: JSON.stringify(Object.fromEntries(shared.map((row) => [row.metrics.repository, row.records]))) });
      for (const candidate of candidates) {
        const source = dashboardSchema.parse(JSON.parse(candidate.data));
        const histories = z.record(repositorySchema, historicalRecordsSchema).parse(JSON.parse(decompress(candidate.history)));
        const ranges = source.repositories.map((repo) => {
          try { return resolveRange(input, new Date(repo.range.until)); } catch { return null; }
        });
        if (source.repositories.length === 0 || source.repositories.some((repo, index) => {
          const range = ranges[index];
          return !histories[repo.repository] || !range || Date.parse(range.since) < Date.parse(repo.range.since) || Date.parse(range.until) > Date.parse(repo.range.until);
        })) continue;
        const result: DashboardData = {
          ...source,
          repositories: await Promise.all(source.repositories.map(async (repo, index) => ({
            ...await loadMetrics(repo.repository, undefined, controller.signal, ranges[index]!, { metrics: repo, records: histories[repo.repository] }, undefined, { localOnly: true, draftRules: draftRules(values) }),
            projectName: repo.projectName,
          }))),
        };
        if (version !== generation || controller.signal.aborted) return null;
        const latest = database.prepare("SELECT data FROM dashboard_snapshots WHERE selection = ? AND configuration = ?")
          .get(selectionKey(input), config) as { data: string } | undefined;
        if (latest) {
          const cached = dashboardSchema.parse(JSON.parse(latest.data));
          if (currentTimings(cached)) return touchSnapshot(cached, selectionKey(input), config);
        }
        database.prepare("UPDATE dashboard_snapshots SET refreshed_at = ? WHERE selection = ?").run(Date.now(), candidate.selection);
        database.prepare("INSERT INTO dashboard_snapshots (selection, configuration, data, refreshed_at) VALUES (?, ?, ?, ?) ON CONFLICT(selection) DO UPDATE SET configuration = excluded.configuration, data = excluded.data, refreshed_at = excluded.refreshed_at, history = NULL")
          .run(selectionKey(input), config, JSON.stringify(result), Date.now());
        touchSnapshot(result, selectionKey(input), config);
        clean();
        return result;
      }
      return null;
    },
  };
  bb.rpc.register(rpcContract, handlers);
  async function readCi(input: CiQuery) {
    const signalsInput = input.repository ? { repository: input.repository } : null;
    if (input.view !== "summary") return ciSliceReport(await handlers.signals(signalsInput), input.view);
    resolveRange(input.selection);
    const snapshot = input.refresh ? null : await handlers.snapshot(input.selection);
    const data = snapshot ?? await metrics(input.selection, input.refresh);
    const { refreshSeconds } = await settings.get();
    // Signals must never break the run-level summary.
    let signals: SignalsOutput = { repositories: [], actors: actorNames({} as Values) };
    try { signals = await handlers.signals(signalsInput); } catch (error) { logOnce(`CI signals unavailable for summary: ${describe(error)}`); }
    return ciReport(data, input, refreshSeconds, snapshot !== null, signals);
  }
  bb.rpc.register(ciRpcContract, { ci: readCi }, {
    experimental_discoverable: true,
    experimental_description: "Read-only CI Dashboard summaries: pass rates, outcomes, workflow health, estimated elapsed timings and job-level signals (runner pool stalls, runner losses, reruns, flakes). Pass view=stall|losses|failures|reruns|signals for one job-level slice only. Cached by default; timestamps and staleness are explicit.",
  });
  bb.agents.registerTool({
    name: "ci_dashboard_metrics",
    description: "Read GitHub Actions CI data for CI Dashboard repositories: pass rate, outcomes, failures, branch/workflow health, estimated timings in milliseconds, and slow-run links by ID. Also job-level signals: runner pool stalls, runner losses and mass cancels, reruns that still fail, flaky and transient failures. Signals are deploy-agnostic: they come from run and job facts only, not from deployment tooling. view=summary (default) adds open signals and runner pool queues to the run-level report; view=signals|stall|losses|failures|reruns returns only that job-level slice with no run-level metrics. Job-level data comes from a local store filled by a budgeted backfill of job history, so check backfill.remaining and backfill.coveredSince before concluding something did not happen. Defaults to a local cached snapshot; inspect stale, pending, updatedAt and errors. Set refresh:true to collect fresh run-level data. Pass rates exclude cancelled/skipped; timing estimates use successful runs only. Never writes to GitHub: no deployments, reruns, cancellations or other writes are triggered.",
    parameters: ciQuerySchema,
    presentation: { label: { pending: "Reading CI Dashboard", completed: "Read CI Dashboard" } },
    async execute(input, { signal }) {
      signal.throwIfAborted();
      const result = await readCi(input);
      signal.throwIfAborted();
      return JSON.stringify(result);
    },
  });
}
