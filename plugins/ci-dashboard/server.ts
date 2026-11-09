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
import { ciOutputSchema, ciQuerySchema, ciReportSchema, ciReport, ciSliceReport, type CiQuery } from "./agent-ci";
import { inspect, relatedRefs, type InspectInput } from "./ci-inspect";
import { classifyJobs, detectMassCancel, laneTimings, queueOnlyJobs, runnerLosses, summarizeReruns, timingSamples, type MassCancel, type TimingSample } from "./ci-classify";
import { createArtifactFetcher, createBackfill, createJobStore, createLogFetcher, jobMigrations, normalizeJob, type FlakeConfig } from "./ci-jobs";
import { flakeSettings, flakeSignaturesSchema } from "./flake-signatures";
import type { ClassifiedJob, JobRecord, PoolQueueState, RerunSummary, Signal } from "./ci-jobs-types";
import { createIncidentTracker, detectStalls, fetchLiveJobs, finishedRuns, poolQueueStates } from "./ci-live";
import { buildSignals, shouldPush, sortSignals, summarizeAnalysis } from "./ci-signals";
import { handledSchema, investigateInputSchema, investigateOutputSchema, navigationBadgeOutputSchema, problemActionInputSchema, problemActionOutputSchema, repositorySignalsSchema, signalsInputSchema, signalsOutputSchema, SIGNALS_CHANGED, type Handled, type SignalsOutput } from "./ci-signals-contract";
import { buildProblems, problemContext, seedPrompt, withoutBenignAlerts } from "./ci-problems";
import { alertStreak, type CiInsights } from "./ci-insights";
import { acceptEvents, attachPrHeads, confirmRemovals, deployRunOutcome, defaultRedEvents, deploymentEvents, dispatch, emptyGlobal, emptyRepoState, enabledEvents, globalStateSchema, isThreadId, massCancelEvent, observerThreadsSchema, OBSERVER_TYPE_LABELS, OBSERVER_TYPES, parseObserverThreads, queueRemovalEvents, REJECTED, repoStateSchema, runnerLossEvents, stallEvent, subscriptionNotice, fit, PREFIX, syncGlobal, type ObserverEvent, type ObserverGlobal, type Rendered } from "./ci-observer";

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
  problemAction: { input: problemActionInputSchema, output: problemActionOutputSchema },
  investigate: { input: investigateInputSchema, output: investigateOutputSchema },
});

export const ciRpcContract = defineRpcContract({ ci: { input: ciQuerySchema, output: ciOutputSchema } });

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
    refusalSteps: { type: "string", label: "By-design refusal steps: a failure on these steps is an intentional gate refusal (comma-separated)", default: "", experimental_schema: z.string().max(2000) },
    policyJobs: { type: "string", label: "Policy job names whose failures are never treated as flakes (comma-separated)", default: "", experimental_schema: z.string().max(2000) },
    flakeSignatures: { type: "string", label: "Known flake signatures, one per line: <regex> => <label> (case-insensitive regex; the label, e.g. FLAKE-1, is shown as evidence; # starts a comment; blank = off)", default: "", experimental_multiline: true, experimental_schema: flakeSignaturesSchema },
    flakeArtifacts: { type: "string", label: "Run artifact names scanned for flake signatures (comma-separated globs with *, e.g. test-results-*; blank = never download artifacts)", default: "", experimental_schema: z.string().max(500) },
    investigateNotes: { type: "string", label: "Team notes appended to every Investigate prompt (rerun limits, incident links; free text)", default: "", experimental_multiline: true, experimental_schema: z.string().max(4000) },
    observerThreads: { type: "string", label: "Observer threads: BB thread ids that receive CI event messages (comma-separated, thr_…; blank = off). Agents can also subscribe themselves with the ci_dashboard_manage tool", default: "", experimental_schema: observerThreadsSchema },
    observeQueueRemoval: { type: "boolean", label: "Observer events: PR removed from the merge queue", default: true },
    observeRunnerLoss: { type: "boolean", label: "Observer events: runner lost on a merge queue or default-branch push run", default: true },
    observeDefaultRed: { type: "boolean", label: "Observer events: workflow red on the default branch", default: true },
    observePoolStall: { type: "boolean", label: "Observer events: runner pool stall", default: true },
    observeMassCancel: { type: "boolean", label: "Observer events: many jobs lost or cancelled within 2 minutes", default: true },
    observeDeployments: { type: "boolean", label: "Observer events: deployment finished (success, failure or error)", default: true },
    claimTimeoutHours: { type: "number", label: "Problem claims (investigating, fix pending) are released after this many hours without the problem resolving (0 = never, 0–720)", default: 24, experimental_schema: z.number().int().min(0).max(720) },
    observerQuietMinutes: { type: "number", label: "Observer quiet window in minutes: at most one message per event key in it (0–1440)", default: 30, experimental_schema: z.number().int().min(0).max(1440) },
    observerBatchMinutes: { type: "number", label: "Observer digest interval in minutes (0 = send each event immediately; N = one digest every N minutes, 0–1440)", default: 0, experimental_schema: z.number().int().min(0).max(1440) },
    runnerLossLimit: { type: "number", label: "Runner losses allowed per head commit, shown as N/limit in observer messages (0 = not shown, 0–1000)", default: 0, experimental_schema: z.number().int().min(0).max(1000) },
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
    return result.repositories.every((repo) => !repo.ciInsights || (repo.trends?.workflows?.every((workflow) => workflow.events) && repo.ciInsights.workflows.every((workflow) => workflow.events) && repo.ciInsights.timing.basis === "success" && repo.ciInsights.draftPolicy === "job-evidence-v1"));
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
    // A changed observer list takes effect now (confirmation to new subscribers) instead of at the next loop; the loop reads fresh settings anyway.
    if (next.observerThreads !== prev.observerThreads) void repositoryNames(next).then((names) => syncObservers(next, names)).catch((error) => logOnce(`CI observer sync failed: ${describe(error)}`));
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
  // Lower-cased repository -> id of the BB project linked to it; refreshed by every successful discovery.
  let projectIds = new Map<string, string>();
  async function discover(values: Values) {
    const repositories = splitRepositories(repositoriesSettingSchema.parse(values.repository));
    const projectNames = new Map<string, string>(), linked = new Map<string, string>();
    let discoveryError: string | null = null;
    if (values.importBbRepositories) {
      try {
        const projects = await bb.sdk.projects.list({ includePersonal: true, signal: controller.signal });
        for (const project of projects) {
          const repo = githubRepository(project.gitRemoteUrl);
          if (repo) {
            repositories.push(repo);
            if (!projectNames.has(repo.toLowerCase())) { projectNames.set(repo.toLowerCase(), project.name); linked.set(repo.toLowerCase(), project.id); }
          }
        }
      } catch {
        controller.signal.throwIfAborted();
        discoveryError = "Unable to discover BB project repositories. Additional repositories are still shown; retry to update the project list.";
      }
    }
    // A failed discovery keeps the last known links instead of disabling "New session".
    if (!discoveryError) projectIds = linked;
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
    let lastPublished = 0, lastPending = "";
    const progress = (metrics: Metrics) => {
      // Pending changes always go out; ticks that only advance listing progress are limited to one per 2 s.
      const pendingKey = (metrics.pending ?? []).join();
      if (metrics.loading && pendingKey === lastPending && Date.now() - lastPublished < 2000) return;
      lastPending = pendingKey;
      lastPublished = Date.now();
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
  type View = Omit<RepositorySignals, "signals" | "problems" | "projectId">;
  type Incidents = { open: Signal[]; recent: Signal[] };
  type Runtime = {
    /** Last GitHub ask per pending queue removal key, so a PR is rechecked at a slow pace instead of every loop. */
    removalChecked?: Map<string, number>;
    signal: AbortSignal; etags: Map<string, GitHubResponse>; liveKnown: boolean; pools: PoolQueueState[]; liveJobs?: JobRecord[]; truncated: boolean; polledAt: string | null; stalls: Signal[];
    defaultBranch: string | null; historyReadAt: number; alerts?: CiInsights["alerts"]; handled?: Record<string, Handled>;
    /** Runs of the previous live poll, and those that left it since (fast path: fetched ahead of the history refresh). Run ids of each alert's failure streak, for observer verdicts. */
    liveRunIds?: Set<number>; finished: Set<number>; alertStreaks: Map<number, number[]>;
    backfill?: { key: string; enqueued: string; run: ReturnType<typeof createBackfill>; status: { processed: number; remaining: number; pausedUntil: number | null; failed: number } };
    analysis?: { key: string; at: number; classified: ClassifiedJob[]; reruns: RerunSummary[]; massCancels: MassCancel[]; queueOnly: Set<number>; samples: TimingSample[]; laneTimings: ReturnType<typeof laneTimings>; summary: ReturnType<typeof summarizeAnalysis> };
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
      const created: Runtime = { signal: controller.signal, etags: new Map(), liveKnown: false, pools: [], truncated: false, polledAt: null, stalls: [], defaultBranch: null, historyReadAt: 0, finished: new Set(), alertStreaks: new Map(),
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
  async function loadHandled(repo: string, rt: Runtime) {
    if (!rt.handled) {
      const stored = z.record(z.string(), handledSchema).safeParse(await bb.storage.kv.get(`handled:${repo}`));
      rt.handled ??= stored.success ? stored.data : {};
    }
    return rt.handled;
  }
  async function saveHandled(repo: string, rt: Runtime) {
    // shortcut: keep the 200 most recent entries; pruning of closed problems keeps this far below the cap in practice.
    rt.handled = Object.fromEntries(Object.entries(rt.handled ?? {}).sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at)).slice(0, 200));
    await bb.storage.kv.set(`handled:${repo}`, rt.handled);
  }
  const problemsOf = async (repo: string, rt: Runtime) => buildProblems(repo, (await loadIncidents(repo, rt))?.open ?? [], withoutBenignAlerts(rt.alerts ?? [], rt.analysis?.classified ?? []), await loadHandled(repo, rt));
  async function configuredRepository(repository: string, values: Values) {
    const found = (await repositoryNames(values)).find((name) => name.toLowerCase() === repository.toLowerCase());
    if (!found) throw new Error("Repository is not configured in CI Dashboard or could not be discovered.");
    return found;
  }
  // Same numbers for the navigationBadge RPC and the SIGNALS_CHANGED payload, so the badge needs no extra RPC. Handled problems do not count.
  async function badgeCounts(values: Values) {
    const open = (await Promise.all((await repositoryNames(values)).map(async (repo) => (await problemsOf(repo, runtimeFor(repo))).filter((problem) => !problem.handled)))).flat();
    return { count: open.length, critical: open.filter((problem) => problem.severity === "critical").length };
  }
  // --- observer threads ---
  // Subscriptions and per-type start times are shared by all repositories; sent keys and the digest queue are per repository.
  let observerGlobal: ObserverGlobal | undefined;
  let observerChain: Promise<unknown> = Promise.resolve();
  const serialObserver = <T>(job: () => Promise<T>) => { const run = observerChain.then(job, job); observerChain = run.catch(() => {}); return run; };
  const threadGone = /\b404\b|not found|archived|deleted/i;
  async function removeObserver(threadId: string, why: string) {
    const values = await settings.get(), ids = parseObserverThreads(values.observerThreads);
    if (!ids.includes(threadId)) return;
    await settings.experimental_set({ observerThreads: ids.filter((id) => id !== threadId).join(", ") });
    logOnce(`CI observer: ${threadId} removed from observer threads (${why})`);
  }
  async function notify(threadId: string, text: string) {
    try { await bb.sdk.threads.send({ threadId, mode: "queue-if-active", originPluginId: bb.pluginId, input: [{ type: "text", text, mentions: [] }] }); }
    catch (error) {
      // Logged once per thread; the event is not retried (it is already marked sent), and a thread that no longer exists is dropped.
      logOnce(`CI observer: message to ${threadId} failed: ${describe(error)}`);
      if (threadGone.test(describe(error))) await removeObserver(threadId, "thread no longer available").catch((e) => logOnce(`CI observer: could not drop ${threadId}: ${describe(e)}`));
    }
  }
  /** One line to the observer threads when a claim is dropped by the plugin (never when an agent or a person releases it, or when the problem resolves). */
  async function echoClaimDropped(values: Values, title: string, id: string, reason: string) {
    const text = `${PREFIX} ${fit(`Claim dropped · ${title}`, undefined, ` · problem \`${id}\` · ${reason}`)}`;
    for (const threadId of parseObserverThreads(values.observerThreads)) await notify(threadId, text);
  }
  /** Brings subscriptions and event-type start times in line with the settings; new subscribers get the one-line confirmation and no history. */
  function syncObservers(values: Values, repositories: string[]) {
    return serialObserver(async () => {
      if (!observerGlobal) { const stored = globalStateSchema.safeParse(await bb.storage.kv.get("observers")); observerGlobal = stored.success ? stored.data as ObserverGlobal : emptyGlobal(); }
      const before = JSON.stringify(observerGlobal), enabled = enabledEvents(values);
      const added = syncGlobal(observerGlobal, parseObserverThreads(values.observerThreads), enabled, Date.now());
      if (JSON.stringify(observerGlobal) !== before) await bb.storage.kv.set("observers", observerGlobal);
      for (const id of added) await notify(id, subscriptionNotice(repositories, enabled, values.observerQuietMinutes, values.observerBatchMinutes));
      return observerGlobal;
    });
  }
  async function observe(repo: string, rt: Runtime, values: Values, token: string | undefined, opened: Signal[], now: number, signal: AbortSignal) {
    const global = observerGlobal;
    if (!global || !Object.keys(global.threads).length) return;
    const enabled = enabledEvents(values), days = values.jobHistoryDays;
    const config = { enabled, quietMs: values.observerQuietMinutes * 60_000, batchMs: values.observerBatchMinutes * 60_000, historyMs: (days + 1) * 86_400_000, now };
    const stored = repoStateSchema.safeParse(await bb.storage.kv.get(`observer:${repo}`));
    const state = stored.success ? stored.data : emptyRepoState(), before = JSON.stringify(state);
    const events: ObserverEvent[] = [];
    if (rt.analysis) {
      const { classified, massCancels } = rt.analysis;
      // Queue removals are built even with removals off: they decide whether a merge queue runner loss stands alone.
      if (enabled.queue || enabled.loss) events.push(...queueRemovalEvents(repo, classified, values.runnerLossLimit, token && rt.backfill ? now : undefined, { has: (key) => state.sent[key] !== undefined }));
      if (enabled.red) events.push(...defaultRedEvents(repo, classified, withoutBenignAlerts(rt.alerts ?? [], classified), rt.alertStreaks));
      for (const opening of opened) {
        const event = opening.kind === "pool_stall" && enabled.stall ? stallEvent(opening, rt.pools, now) : opening.kind === "mass_cancel" && enabled.mass ? massCancelEvent(opening, massCancels) : null;
        if (event) events.push(event);
      }
    }
    if (enabled.deploy && token && rt.backfill) {
      const backfill = rt.backfill.run, scope = configuration(values);
      // Conditional requests (ETag) through the shared response cache with no freshness window; every request is charged to the backfill budget.
      const cached = cachedRequest(JSON.stringify([scope, createHash("sha256").update(token).digest("hex")]), token, signal, 0, false, () => !signal.aborted);
      try { events.push(...await deploymentEvents({ request: (path, init) => backfill.spend(signal, () => cached(path, init)), repository: repo, state, since: now - days * 86_400_000, now, runOutcome: deployRunOutcome(rt.analysis?.classified ?? []) })); }
      catch (error) { signal.throwIfAborted(); if (!/Budget exhausted/.test(describe(error))) logOnce(`CI observer deployments for ${repo}: ${describe(error)}`); }
    }
    // Only group runs whose PR really left the queue are removals; a group cancelled because the one ahead left is not.
    const confirmed = await confirmRemovals(events, state, async (number) => {
      if (!token || !rt.backfill) throw new Error("No token for the merge queue timeline");
      const [owner, name] = repo.split("/");
      const { body } = await rt.backfill.run.spend(signal, () => githubRequest("/graphql", token, signal, { method: "POST", body: JSON.stringify({ query: REMOVED_FROM_QUEUE, variables: { owner, name, number } }) }));
      const parsed = removedFromQueueSchema.parse(body);
      // GitHub also records a RemovedFromMergeQueueEvent when the PR merges: that is not a removal.
      // Without the removed commit only the time window could match, and a merged PR's last removal may be the merge itself.
      const pr = parsed.data.repository?.pullRequest;
      return (pr?.timelineItems.nodes ?? []).filter((node) => !/merged/i.test(node.reason ?? "") && (node.beforeCommit?.oid || pr?.state !== "MERGED"))
        .map((node) => ({ at: Date.parse(node.createdAt), sha: node.beforeCommit?.oid ?? null }));
    }, now, rt.removalChecked ??= new Map());
    if (enabled.loss && rt.analysis) confirmed.push(...runnerLossEvents(repo, rt.analysis.classified, rt.defaultBranch, values.runnerLossLimit));
    const accepted = acceptEvents(state, global, confirmed, config);
    // Lines about a problem that is open name its id, so an agent can claim it with ci_dashboard_manage.
    const openProblems = new Set((await problemsOf(repo, rt)).map((problem) => problem.id));
    const artifacts = flakeSettings(values.flakeSignatures, values.flakeArtifacts).artifacts, rendered: Rendered[] = [];
    for (const event of accepted) {
      const tests = event.tests && rt.backfill ? await rt.backfill.run.failedTests(repo, event.tests.run, event.tests.jobs, artifacts, signal) : null;
      rendered.push({ key: event.key, type: event.type, at: event.at, text: event.render(tests, event.problem && openProblems.has(event.problem) ? event.problem : undefined) });
    }
    const messages = dispatch(state, rendered, global, config);
    // State first: a crash while sending loses a message instead of repeating it.
    if (JSON.stringify(state) !== before) await bb.storage.kv.set(`observer:${repo}`, state);
    for (const message of messages) await notify(message.threadId, message.text);
  }
  const REMOVED_FROM_QUEUE = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){state timelineItems(itemTypes:[REMOVED_FROM_MERGE_QUEUE_EVENT],last:20){nodes{... on RemovedFromMergeQueueEvent{createdAt reason beforeCommit{oid}}}}}}}";
  const removedFromQueueSchema = z.object({ data: z.object({ repository: z.object({ pullRequest: z.object({ state: z.string().optional(), timelineItems: z.object({ nodes: z.array(z.object({ createdAt: z.string(), reason: z.string().nullable().optional(), beforeCommit: z.object({ oid: z.string() }).nullable().optional() })) }) }).nullable() }).nullable() }) });
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
    const names = (list: string) => list.split(",").map((name) => name.trim()).filter(Boolean);
    const aggregatorJobs = names(values.aggregatorJobs), policyJobs = names(values.policyJobs), refusalSteps = names(values.refusalSteps);
    const flake = flakeSettings(values.flakeSignatures, values.flakeArtifacts);
    const flakeConfig: FlakeConfig | undefined = flake.rules.length ? { repository: repo, ...flake, classify: { aggregatorJobs, policyJobs, refusalSteps }, since: new Date(now - days * 86_400_000).toISOString() } : undefined;
    // New failed jobs or re-scanned signatures change the classification: do not wait for the five-minute recompute.
    let dirty = false;
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
        rt.pools = poolQueueStates(live.jobs, starts, now); rt.liveJobs = live.jobs;
        for (const id of finishedRuns(rt.liveRunIds, live, rt.truncated)) rt.finished.add(id);
        // shortcut: at most 200 runs wait for their fetch; a burst beyond that falls back to the periodic history refresh.
        while (rt.finished.size > 200) rt.finished.delete(rt.finished.values().next().value!);
        rt.liveRunIds = new Set(live.runIds);
        rt.stalls = detectStalls(rt.pools, { stallMinutes: values.stallMinutes }, now);
        Object.assign(rt, { etags: used, truncated: live.truncated, polledAt: nowIso, liveKnown: true });
      } catch (error) { fail("live poll", error); }
      try { // 2. backfill with plain requests: the 512-entry response cache would be evicted by job pages.
        const key = `${createHash("sha256").update(token).digest("hex")}:${values.jobBudgetPerHour}`;
        if (rt.backfill?.key !== key) rt.backfill = { key, enqueued: "", status: { processed: 0, remaining: 0, pausedUntil: null, failed: 0 }, run: createBackfill({
          store: jobStore, budgetPerHour: values.jobBudgetPerHour, request: (path, init) => githubRequest(path, token, rt.signal, init), fetchText: createLogFetcher(token, controller.signal), fetchArtifact: createArtifactFetcher(token, controller.signal) }) };
        const history = !rt.backfill.enqueued || now - rt.historyReadAt >= 300_000 ? readHistory(repo, configuration(values)) : undefined;
        if (history) {
          rt.historyReadAt = now;
          rt.defaultBranch = history.records.branch ?? history.metrics.ciInsights?.defaultBranch ?? null;
          if (history.metrics.ciInsights) {
            rt.alerts = history.metrics.ciInsights.alerts;
            rt.alertStreaks = new Map(rt.alerts.map((alert) => [alert.runId, alertStreak(history.records.runs, alert).map((run) => run.id)]));
          }
          const stamp = `${history.checkedAt}:${days}`;
          // Runs stored before 0.2.0 lack head_sha and PR numbers; every job response carries its own head_sha, so they are still backfilled.
          if (rt.backfill.enqueued !== stamp) {
            rt.backfill.enqueued = stamp;
            rt.backfill.run.enqueue(repo, history.records.runs.filter((run) => run.conclusion !== null && run.conclusion !== "skipped" && !run.draftDeferred && Date.parse(run.created_at) >= now - days * 86_400_000)
              .map((run) => ({ id: run.id, run_attempt: run.run_attempt ?? 1, status: "completed", conclusion: run.conclusion, name: run.name ?? null, event: run.event ?? "", head_branch: run.head_branch ?? null, head_sha: run.head_sha ?? "", pull_requests: run.pull_requests ?? [], created_at: run.created_at })));
          }
        }
        // Fast path: runs that just left the live poll are fetched (1 request each) and queued ahead of the backlog, so their jobs are stored by the step below.
        await rt.backfill.run.resolveFinished(repo, rt.finished, signal);
        const stepped = await rt.backfill.run.step(signal, flakeConfig);
        rt.backfill.status = stepped;
        dirty = stepped.storedFailures > 0 || stepped.signaturesUpdated > 0;
      } catch (error) { fail("backfill", error); }
    }
    // 3. analysis, recomputed at most every five minutes even while the backfill stores rows (the live pool state above stays per minute) unless the backfill stored failures.
    const analysisKey = JSON.stringify([days, aggregatorJobs, policyJobs, refusalSteps, flake.hash]);
    let recompute = !rt.analysis || rt.analysis.key !== analysisKey || now - rt.analysis.at >= 300_000 || dirty;
    const analyze = () => {
      try {
        const jobs = jobStore.listJobs({ repository: repo, since: new Date(now - days * 86_400_000).toISOString(), until: nowIso });
        const classified = classifyJobs(jobs, { aggregatorJobs, policyJobs, refusalSteps, flakeRules: flake.rules, flakeHash: flake.hash }), reruns = summarizeReruns(jobs), massCancels = detectMassCancel(classified);
        attachPrHeads(jobs, classified);
        for (const group of massCancels) for (const c of group.jobs) c.job.massLoss = true;
        const queueOnly = queueOnlyJobs(jobs, classified), samples = timingSamples(jobs);
        rt.analysis = { key: analysisKey, at: now, classified, reruns, massCancels, queueOnly, samples, laneTimings: laneTimings(jobs, now), summary: summarizeAnalysis({ classified, reruns, massCancels, losses: runnerLosses(classified), repository: repo, queueOnly, samples }) };
      } catch (error) { fail("analysis", error); }
    };
    if (recompute) analyze();
    // 3b. Merge queue failures built on a failed group ahead are marked on the stored jobs; marking changes the classification, so it is redone.
    if (token && rt.analysis && rt.backfill) {
      try { if (await rt.backfill.run.resolveInherited(repo, rt.analysis.classified, signal, flake.artifacts)) { analyze(); recompute = true; } }
      catch (error) { fail("inherited failures", error); }
    }
    // 4. signals and push. Without a successful live poll the stall state is unknown, so incidents are left untouched instead of resolved.
    let opened: Signal[] = [];
    if (rt.analysis && rt.liveKnown) {
      try {
        ({ opened } = rt.tracker.update(capOpenSignals(buildSignals({ classified: rt.analysis.classified, reruns: rt.analysis.reruns, massCancels: rt.analysis.massCancels, stalls: rt.stalls, defaultBranch: rt.defaultBranch, repository: repo, now })), now));
        const names = actorNames(values);
        for (const opening of opened) if (shouldPush(opening, rt.defaultBranch, now)) {
          try { await bb.sdk.plugins.callRpc({ pluginId: "push-notifications", method: "notifications.send", input: { title: opening.title, body: `${opening.what} · ${names[opening.actor]}` }, outputSchema: z.unknown(), signal }); }
          catch (error) { signal.throwIfAborted(); logOnce(`CI signals push for ${repo} failed: ${describe(error)}`); }
        }
        const text = JSON.stringify(rt.incidents);
        if (text !== rt.persisted) { await bb.storage.kv.set(`incidents:${repo}`, rt.incidents); rt.persisted = text; }
      } catch (error) { fail("signals", error); }
    }
    // 4b. observer threads: classified events pushed to agents that watch CI.
    try { await observe(repo, rt, values, token, opened, now, signal); }
    catch (error) { signal.throwIfAborted(); logOnce(`CI observer for ${repo} failed: ${describe(error)}`); }
    // Handled entries of problems that closed are dropped, but only once the source of that kind of problem is known.
    try {
      const handled = await loadHandled(repo, rt), open = new Set((await problemsOf(repo, rt)).map((problem) => problem.id)), jobKnown = !!rt.analysis && rt.liveKnown;
      const stale = Object.keys(handled).filter((id) => !open.has(id) && (id.startsWith("run:") ? rt.alerts !== undefined : jobKnown));
      if (stale.length) { for (const id of stale) delete handled[id]; await saveHandled(repo, rt); }
      // A claim that outlives claimTimeoutHours with its problem still open is dropped (the claimant stalled or forgot to release).
      const limit = values.claimTimeoutHours * 3_600_000, titles = new Map((await problemsOf(repo, rt)).map((problem) => [problem.id, problem.title]));
      const expired = limit > 0 ? Object.entries(handled).filter(([id, entry]) => entry.state !== "dismissed" && titles.has(id) && now - Date.parse(entry.at) > limit).map(([id]) => id) : [];
      if (expired.length) {
        for (const id of expired) delete handled[id];
        await saveHandled(repo, rt);
        for (const id of expired) await echoClaimDropped(values, titles.get(id)!, id, `no resolution within ${values.claimTimeoutHours} h`);
      }
    } catch (error) { logOnce(`CI signals handled state for ${repo} not pruned: ${describe(error)}`); }
    // 5. view for the RPC (kept in memory and kv) and a realtime nudge when something visible changed.
    const status = rt.backfill?.status;
    const oldest = (database.prepare("SELECT MIN(created_at) AS oldest FROM ci_jobs WHERE repository = ?").get(repo) as { oldest: string | null }).oldest;
    rt.view = { repository: repo, updatedAt: nowIso, error: errors.join("; ") || null, live: { pools: rt.pools, truncated: rt.truncated, polledAt: rt.polledAt },
      window: { since: new Date(now - days * 86_400_000).toISOString(), until: nowIso }, ...(rt.analysis?.summary ?? zeroSummary(repo)),
      backfill: { remaining: status?.remaining ?? 0, failed: status?.failed ?? 0, pausedUntil: status?.pausedUntil ? new Date(status.pausedUntil).toISOString() : null, coveredSince: oldest } };
    const openIds = JSON.stringify((rt.incidents?.open ?? []).map((item) => item.id).sort());
    const problemState = JSON.stringify((await problemsOf(repo, rt)).map((problem) => [problem.id, problem.handled?.state]));
    const signature = JSON.stringify([openIds, problemState, rt.pools.map((pool) => [pool.pool, pool.queued, pool.inProgress])]);
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
      for (const prefix of ["result:", "incidents:", "handled:", "observer:"]) for (const key of await bb.storage.kv.list(prefix)) if (!active.has(key.slice(prefix.length).toLowerCase())) await bb.storage.kv.delete(key);
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
    await syncObservers(values, names).catch((error) => { signal.throwIfAborted(); logOnce(`CI observer sync failed: ${describe(error)}`); });
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
      const stored = repositorySignalsSchema.omit({ signals: true, problems: true, projectId: true }).safeParse(await bb.storage.kv.get(`result:${repo}`));
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
    const samples = rt.analysis.samples.filter((sample) => { const at = Date.parse(sample.completedAt); return at >= from && at <= to; });
    return { ...view, ...summarizeAnalysis({ classified, reruns, massCancels: detectMassCancel(classified), losses: runnerLosses(classified), repository: view.repository, queueOnly: rt.analysis.queueOnly, samples }), coverage };
  }
  const handlers: PluginRpcHandlers<typeof rpcContract> = {
    async signals(input) {
      const values = await settings.get();
      const names = await repositoryNames(values);
      const wanted = input?.repository ? names.filter((name) => name.toLowerCase() === input.repository!.toLowerCase()) : names;
      if (input?.repository && !wanted.length) throw new Error("Repository is not configured in CI Dashboard or could not be discovered.");
      return { actors: actorNames(values), repositories: await Promise.all(wanted.map(async (repo) => {
        const rt = runtimeFor(repo), incidents = await loadIncidents(repo, rt);
        return { ...rangedView(rt, await readView(repo, rt, values.jobHistoryDays), input), signals: sortSignals([...(incidents?.open ?? []), ...(incidents?.recent ?? [])]),
          problems: await problemsOf(repo, rt), projectId: projectIds.get(repo.toLowerCase()) ?? null };
      })) };
    },
    async navigationBadge() { return badgeCounts(await settings.get()); },
    async problemAction({ repository, id, action }) {
      const values = await settings.get();
      const repo = await configuredRepository(repository, values), rt = runtimeFor(repo), handled = await loadHandled(repo, rt);
      if (action === "dismiss") {
        if (!(await problemsOf(repo, rt)).some((problem) => problem.id === id)) throw new Error("This problem is no longer open.");
        handled[id] = { state: "dismissed", by: "user", at: new Date().toISOString() };
      } else delete handled[id];
      await saveHandled(repo, rt);
      bb.realtime.publish(SIGNALS_CHANGED, await badgeCounts(values));
      return { handled: rt.handled![id] ?? null };
    },
    async investigate({ repository, id, threadId }) {
      const values = await settings.get();
      const repo = await configuredRepository(repository, values), rt = runtimeFor(repo);
      const problem = (await problemsOf(repo, rt)).find((item) => item.id === id);
      if (!problem) throw new Error("This problem is no longer open.");
      // Built from what is already in memory: investigating makes no GitHub requests.
      const backfill = rt.backfill?.status, stored = readHistory(repo, configuration(values));
      const prompt = seedPrompt(repo, problem, problemContext(problem, {
        repository: repo, classified: rt.analysis?.classified ?? [], reruns: rt.analysis?.reruns ?? [], massCancels: rt.analysis?.massCancels ?? [], pools: rt.pools, alerts: rt.alerts ?? [],
        defaultBranch: rt.defaultBranch, backfill: backfill && { remaining: backfill.remaining, failed: backfill.failed, pausedUntil: backfill.pausedUntil ? new Date(backfill.pausedUntil).toISOString() : null },
        coverage: rt.view?.backfill.coveredSince ?? null, analysisAt: rt.analysis?.at ?? null, polledAt: rt.polledAt, now: Date.now(),
        runs: stored?.records.runs, deployments: stored?.records.deployments, liveJobs: rt.liveJobs, windowDays: values.jobHistoryDays, notes: values.investigateNotes, actors: actorNames(values),
        refs: relatedRefs(problem, { classified: rt.analysis?.classified ?? [], massCancels: rt.analysis?.massCancels ?? [], pools: rt.pools, alerts: rt.alerts ?? [], runs: stored?.records.runs }, 8),
      }));
      let target = threadId;
      if (target) await bb.sdk.threads.send({ threadId: target, mode: "queue-if-active", input: [{ type: "text", text: prompt, mentions: [] }] });
      else {
        const projectId = projectIds.get(repo.toLowerCase());
        if (!projectId) throw new Error(`No BB project is linked to ${repo}. Link the repository to a BB project, or send the problem to an existing session.`);
        // Provider and model are omitted so BB uses the project's defaults.
        target = (await bb.sdk.threads.spawn({ projectId, environment: { type: "project-default" }, title: `Investigate: ${problem.title}`.slice(0, 120), prompt })).id;
      }
      (await loadHandled(repo, rt))[id] = { state: "investigating", threadId: target, by: "user", at: new Date().toISOString() };
      await saveHandled(repo, rt);
      bb.realtime.publish(SIGNALS_CHANGED, await badgeCounts(values));
      return { threadId: target };
    },
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
  /** ref=...: one small inspection from memory and the local store (no GitHub requests). */
  async function inspectRef(ref: string, repository: string | undefined) {
    const values = await settings.get(), names = await repositoryNames(values);
    if (!repository && names.length !== 1) throw new Error(names.length ? `Several repositories are configured; pass repository (${names.join(", ")}).` : "No repository is configured in CI Dashboard.");
    const repo = repository ? await configuredRepository(repository, values) : names[0]!, rt = runtimeFor(repo);
    const row = (await handlers.signals({ repository: repo })).repositories[0]!, stored = readHistory(repo, configuration(values));
    const observer = repoStateSchema.safeParse(await bb.storage.kv.get(`observer:${repo}`)), artifacts = flakeSettings(values.flakeSignatures, values.flakeArtifacts).artifacts;
    const backfill = rt.backfill?.status;
    return inspect(ref, {
      repository: repo, classified: rt.analysis?.classified ?? [], reruns: rt.analysis?.reruns ?? [], massCancels: rt.analysis?.massCancels ?? [], pools: rt.pools, alerts: rt.alerts ?? [],
      defaultBranch: rt.defaultBranch, backfill: backfill && { remaining: backfill.remaining, failed: backfill.failed, pausedUntil: backfill.pausedUntil ? new Date(backfill.pausedUntil).toISOString() : null },
      coverage: rt.view?.backfill.coveredSince ?? null, analysisAt: rt.analysis?.at ?? null, polledAt: rt.polledAt, now: Date.now(),
      runs: stored?.records.runs, deployments: stored?.records.deployments, liveJobs: rt.liveJobs, windowDays: values.jobHistoryDays, actors: actorNames(values),
      problems: row.problems, signals: row.signals, poolTimings: row.poolTimings,
      queueStatus: (key) => !observer.success ? "pending" : observer.data.sent[REJECTED + key] !== undefined ? "rejected" : observer.data.sent[key] !== undefined ? "confirmed" : "pending",
      cachedTests: (run) => rt.backfill?.run.cachedFailedTests(repo, run, artifacts) ?? null,
    } satisfies InspectInput);
  }
  async function readCi(input: CiQuery) {
    if (input.ref) return inspectRef(input.ref, input.repository);
    const signalsInput = input.repository ? { repository: input.repository } : null;
    // Lane timings are for agents only: read from the analysis on request instead of riding in every stored and UI view.
    if (input.view === "lanes") { const signals = await handlers.signals(signalsInput); return ciSliceReport({ ...signals, repositories: signals.repositories.map((row) => ({ ...row, laneTimings: runtimeFor(row.repository).analysis?.laneTimings })) }, "lanes", input.event); }
    if (input.view !== "summary") return ciSliceReport(await handlers.signals(signalsInput), input.view, input.event);
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
    experimental_description: "Read-only CI Dashboard summaries: pass rates, outcomes, workflow health, estimated elapsed timings and job-level signals (runner pool stalls, runner losses, reruns, flakes). Pass view=stall|losses|failures|reruns|signals for one job-level slice only, or ref=<job:ID|run:ID|queue:RUN:ATTEMPT|pool:NAME|pr:N|sha:SHA|problem id> for one drill-down. Cached by default; timestamps and staleness are explicit.",
  });
  bb.agents.registerTool({
    name: "ci_dashboard_metrics",
    description: "Read GitHub Actions CI data for CI Dashboard repositories: pass rate, outcomes, failures, branch/workflow health, estimated timings in milliseconds, and slow-run links by ID. Also job-level signals: runner pool stalls, runner losses and mass cancels, reruns that still fail, flaky and transient failures. Failure and rerun rows carry the run event (pull_request, push, merge_group); merge_group failure rows add queuePullRequest and queueOnly (passes on the PR, fails only in the merge queue), and failureCountsByEvent splits the failure counts. view=lanes gives seven UTC days of full-attempt wall and lane p50/p90 with sample counts; event selects a pipeline. view=stall gives the live runner pool queues plus per runner pool job counts and p50/p90 queue wait and duration in ms, overall (poolTimings) and by event (poolTimingsByEvent). Signals are deploy-agnostic: they come from run and job facts only, not from deployment tooling. view=summary (default) adds open signals and runner pool queues to the run-level report; view=problems returns only the open CI health problems with ids and handled state (smallest; use it before ci_dashboard_manage); view=signals|stall|losses|failures|reruns returns only that job-level slice with no run-level metrics. Index views are compact and give every row a ref (job:ID, run:ID:ATTEMPT, queue:RUN:ATTEMPT, pool:NAME, pr:N, sha:SHA, or a problem/signal id); to see more about one row call this tool again with ref=<that ref> (view, selection and refresh are then ignored): the answer is a few lines of summary, facts and related refs from the local store, with no log text, so walk index view -> ref -> related ref instead of asking for big dumps. Job-level data comes from a local store filled by a budgeted backfill of job history, so check backfill.remaining and backfill.coveredSince before concluding something did not happen. Defaults to a local cached snapshot; inspect stale, pending, updatedAt and errors. Set refresh:true to collect fresh run-level data. Pass rates exclude cancelled/skipped; timing estimates use successful runs only. Never writes to GitHub: no deployments, reruns, cancellations or other writes are triggered.",
    parameters: ciQuerySchema,
    presentation: { label: { pending: "Reading CI Dashboard", completed: "Read CI Dashboard" } },
    async execute(input, { signal }) {
      signal.throwIfAborted();
      const result = await readCi(input);
      signal.throwIfAborted();
      return JSON.stringify(result);
    },
  });
  // Observer threads can be changed by the agents themselves: a new manager session subscribes (or takes over) and unsubscribes when it stops watching.
  for (const event of ["thread.archived", "thread.deleted"] as const) bb.events.on(event, async ({ thread }) => {
    const why = event === "thread.archived" ? "thread archived" : "thread deleted";
    try { await removeObserver(thread.id, why); }
    catch (error) { logOnce(`CI observer: could not drop ${thread.id}: ${describe(error)}`); }
    try { await releaseClaimsOf(thread.id, why); }
    catch (error) { logOnce(`CI claims: could not release claims of ${thread.id}: ${describe(error)}`); }
  });
  /** Problems claimed by agents (see ci_dashboard_manage). A thread that is archived or deleted stops investigating; fix_pending claims outlive their thread. */
  async function releaseClaimsOf(threadId: string, why: string) {
    const values = await settings.get();
    for (const repo of await repositoryNames(values)) {
      const rt = runtimeFor(repo), handled = await loadHandled(repo, rt);
      const ids = Object.keys(handled).filter((id) => handled[id]!.state === "investigating" && handled[id]!.threadId === threadId);
      if (!ids.length) continue;
      const titles = new Map((await problemsOf(repo, rt)).map((problem) => [problem.id, problem.title]));
      for (const id of ids) delete handled[id];
      await saveHandled(repo, rt);
      for (const id of ids) if (titles.has(id)) await echoClaimDropped(values, titles.get(id)!, id, why);
      bb.realtime.publish(SIGNALS_CHANGED, await badgeCounts(values));
    }
  }
  const PROBLEM_ACTIONS = ["take", "fix_pending", "release", "dismiss"] as const, OBSERVER_ACTIONS = ["subscribe", "unsubscribe", "replace", "list"] as const;
  const manageInput = z.object({
    action: z.enum([...PROBLEM_ACTIONS, ...OBSERVER_ACTIONS]).describe("Problem actions (id required): take: you (or the worker in threadId) are working on the problem; fix_pending: a fix PR/card exists (ref required); release: back to open; dismiss: nobody needs to act. Observer actions: subscribe: add the thread to the observers; unsubscribe: remove it; replace: make it the only observer; list: show the current observers"),
    id: z.string().min(1).max(300).optional().describe("Problem actions only (required): problem id from ci_dashboard_metrics view=problems or view=signals (problems[].id), from an observer line (`problem <id>`) or from a ref"),
    repository: repositorySchema.optional().describe("Problem actions: owner/repo; needed only when several repositories are configured"),
    threadId: z.string().optional().describe("BB thread id (thr_...). take: whoever works on the problem (defaults to the calling thread; pass the worker's id when you delegate); fix_pending: keeps or sets the worker; observer actions: the thread to change (defaults to the calling thread)"),
    ref: z.string().trim().min(1).max(80).optional().describe('fix_pending only (required): the fix, as a PR number like "#12", a tracker key like "FIX-1" or a URL. Not a ci_dashboard_metrics ref'),
  });
  async function manageProblem({ action, id, repository, threadId, ref }: z.infer<typeof manageInput> & { action: typeof PROBLEM_ACTIONS[number] }, ctx: { threadId: string; signal: AbortSignal }) {
    if (!id) throw new Error(`action=${action} needs id: a problem id from ci_dashboard_metrics view=problems.`);
    const values = await settings.get(), names = await repositoryNames(values);
    if (!repository && names.length !== 1) throw new Error(names.length ? `Several repositories are configured; pass repository (${names.join(", ")}).` : "No repository is configured in CI Dashboard.");
    const repo = repository ? await configuredRepository(repository, values) : names[0]!, rt = runtimeFor(repo), handled = await loadHandled(repo, rt);
    if (!(await problemsOf(repo, rt)).some((problem) => problem.id === id)) throw new Error(`Problem ${id} is not open (unknown id, or it already resolved).`);
    const at = new Date().toISOString();
    if (action === "release") delete handled[id];
    else if (action === "dismiss") handled[id] = { state: "dismissed", by: "agent", at };
    else if (action === "take") {
      const target = threadId ?? ctx.threadId;
      if (!isThreadId(target)) throw new Error(`"${target.slice(0, 40)}" is not a BB thread id.`);
      const thread = await bb.sdk.threads.get({ threadId: target }).catch(() => null);
      if (!thread || thread.archivedAt) throw new Error(`Thread ${target} does not exist or is archived, so it cannot work on a problem.`);
      handled[id] = { state: "investigating", threadId: target, by: "agent", at };
    } else {
      if (!ref) throw new Error("fix_pending needs ref: a PR number like #12, a tracker key like FIX-1 or a URL.");
      if (threadId && !isThreadId(threadId)) throw new Error(`"${threadId.slice(0, 40)}" is not a BB thread id.`);
      const keep = threadId ?? handled[id]?.threadId;
      handled[id] = { state: "fix_pending", ref, ...(keep ? { threadId: keep } : {}), by: "agent", at };
    }
    await saveHandled(repo, rt);
    bb.realtime.publish(SIGNALS_CHANGED, await badgeCounts(values));
    return { repository: repo, id, handled: rt.handled![id] ?? null };
  }
  async function manageObservers({ action, threadId }: z.infer<typeof manageInput> & { action: typeof OBSERVER_ACTIONS[number] }, ctx: { threadId: string }) {
    const target = threadId ?? ctx.threadId, current = parseObserverThreads((await settings.get()).observerThreads);
    let next = current;
    if (action === "unsubscribe") next = current.filter((id) => id !== target);
    else if (action !== "list") {
      if (!isThreadId(target)) throw new Error(`"${target.slice(0, 40)}" is not a BB thread id.`);
      const thread = await bb.sdk.threads.get({ threadId: target }).catch(() => null);
      if (!thread || thread.archivedAt) throw new Error(`Thread ${target} does not exist or is archived, so it cannot observe CI.`);
      next = action === "replace" ? [target] : [...new Set([...current, target])];
    }
    if (next.join() !== current.join()) await settings.experimental_set({ observerThreads: next.join(", ") });
    const values = await settings.get(), enabled = enabledEvents(values);
    // The subscription confirmation goes out now, not at the next loop.
    await syncObservers(values, await repositoryNames(values));
    return { observerThreads: parseObserverThreads(values.observerThreads), events: OBSERVER_TYPES.filter((type) => enabled[type]).map((type) => OBSERVER_TYPE_LABELS[type]),
      quietMinutes: values.observerQuietMinutes, batchMinutes: values.observerBatchMinutes };
  }
  // All writes live here; ci_dashboard_metrics stays read-only.
  bb.agents.registerTool({
    name: "ci_dashboard_manage",
    description: 'Change CI Dashboard state (the read tool is ci_dashboard_metrics). Problem actions claim CI problems so the CI health status shows who deals with them: action=take when you or a worker start on a problem (id required; pass the worker\'s threadId when you delegate, it defaults to this thread), action=fix_pending with ref (PR number, tracker key or URL) once a fix PR/card exists, action=release to hand it back, action=dismiss when nobody needs to act. The claim closes itself when the problem resolves, is dropped when its investigating thread is archived or deleted, and expires after the claimTimeoutHours setting (default 24 h; observers get one "Claim dropped" line). Problem ids come from ci_dashboard_metrics view=problems or view=signals, from "problem <id>" in observer lines, or from a ref. Returns the problem\'s new handled state. Observer actions choose which BB threads receive CI event messages (merge queue removals, runner losses, default-branch red, pool stalls, mass cancels, deployments), pushed as short classified lines that wake an idle agent so nobody has to poll: action=subscribe when you start watching CI (threadId defaults to this thread), action=replace to take over as the only observer, action=unsubscribe when you stop, action=list to read the current observers. A newly subscribed thread gets one confirmation line and no history; archived or deleted threads are removed automatically. Returns the observer list and the enabled event types. Writes only plugin state and the observerThreads setting; nothing is written to GitHub.',
    parameters: manageInput,
    presentation: { label: { pending: "Updating CI Dashboard", completed: "Updated CI Dashboard" } },
    async execute(input, ctx) {
      ctx.signal.throwIfAborted();
      const result = (PROBLEM_ACTIONS as readonly string[]).includes(input.action) ? await manageProblem(input as never, ctx) : await manageObservers(input as never, ctx);
      return JSON.stringify(result);
    },
  });
}
