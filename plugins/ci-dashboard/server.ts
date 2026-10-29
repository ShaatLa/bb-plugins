import { defaultDraftRules, draftRules, draftNameSchema, draftSettingLabels } from "./draft-deferrals";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { defineRpcContract, type BbPluginApi, type PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { minimumDate, rangeInputSchema, rangeSchema, resolveRange, type RangeInput, type DateRange } from "./date-range";
import { historicalRecordsSchema, loadMetrics, metricsSchema, repositorySchema, type HistoricalRecords, type Metrics } from "./metrics";
import { resolveGithubToken } from "./auth";
import { dispatchProduction, productionTarget } from "./production";
import { githubRepository, repositoriesSettingSchema, splitRepositories, uniqueRepositories } from "./repositories";
import { cardDetailsInput, cardDetailsOutput, loadCardDetails } from "./card-details";
import { createGitHubCache } from "./github-cache";
import { cleanupCache } from "./cache-cleanup";
import { ciQuerySchema, ciReportSchema, ciReport, type CiQuery } from "./agent-ci";

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
});

export const ciRpcContract = defineRpcContract({ ci: { input: ciQuerySchema, output: ciReportSchema } });

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
    token: { type: "string", label: "GitHub token override (blank uses system authorization)", secret: true },
    refreshSeconds: {
      type: "number",
      label: "Refresh interval in seconds (30–3600)",
      default: 300,
      experimental_schema: z.number().int().min(30).max(3600),
    },
  });
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
  ]);
  database.prepare("UPDATE github_responses SET last_used_at = checked_at WHERE last_used_at = 0").run();
  database.prepare("UPDATE repository_history SET last_used_at = ? WHERE last_used_at = 0").run(Date.now());
  const cachedRequest = createGitHubCache(database);
  const repositoryPending = new Map<string, Promise<Metrics>>();
  const historySchema = z.object({ metrics: metricsSchema, records: historicalRecordsSchema, coverage: rangeSchema, checkedAt: z.number(), authSource: dashboardSchema.shape.authSource.optional(), projectName: z.string().nullable().optional() });
  type RepositoryHistory = z.infer<typeof historySchema>;
  let lastStarted = 0;
  let repositoryList: { configuration: string; names: string[] } | null = null;
  let generation = 0;
  const pending = new Map<string, Promise<DashboardData>>();
  let nextCleanup = 0;
  function clean(compact = false) {
    if (compact) nextCleanup = Date.now() + 3_600_000;
    try {
      const result = cleanupCache(database, repositoryList?.names, compact && pending.size === 0 && repositoryPending.size === 0);
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
  settings.onChange(() => {
    generation++;
    repositoryList = null;
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
    const histories: Record<string, HistoricalRecords> = {};
    const request = collect(input, values, histories, force, version).then((result) => {
      if (!controller.signal.aborted && version === generation) {
        database.prepare("INSERT INTO dashboard_snapshots (selection, configuration, data, refreshed_at, history) VALUES (?, ?, ?, ?, ?) ON CONFLICT(selection) DO UPDATE SET configuration = excluded.configuration, data = excluded.data, refreshed_at = excluded.refreshed_at, history = excluded.history")
          .run(selection, config, JSON.stringify(result), Date.now(), JSON.stringify(histories));
        // shortcut: retain eight recent ranges; increase if revisiting more ranges becomes common.
        clean();
      }
      return result;
    });
    pending.set(key, request);
    try { return await request; }
    finally { pending.delete(key); }
  }
  async function collect(input: RangeInput, values: Awaited<ReturnType<typeof settings.get>>, histories: Record<string, HistoricalRecords>, force: boolean, version: number): Promise<DashboardData> {
    const range = resolveRange(input);
    const { repository, token: override, importBbRepositories } = values;
    const repositories = splitRepositories(repositoriesSettingSchema.parse(repository));
    const projectNames = new Map<string, string>();
    let discoveryError: string | null = null;
    if (importBbRepositories) {
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
    const { token, source } = await resolveGithubToken(override, controller.signal);
    const names = uniqueRepositories(repositories);
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
    const row = database.prepare("SELECT data FROM repository_history WHERE repository = ? AND configuration = ?").get(repository, config) as { data: string } | undefined;
    if (row) { try {
      const result = historySchema.parse(JSON.parse(row.data));
      database.prepare("UPDATE repository_history SET last_used_at = ? WHERE repository = ? AND configuration = ?").run(Date.now(), repository, config);
      return result;
    } catch { /* Fall back to validated snapshots. */ } }
    const snapshots = database.prepare("SELECT data, history FROM dashboard_snapshots WHERE configuration = ? AND history IS NOT NULL ORDER BY refreshed_at DESC LIMIT 8").all(config) as { data: string; history: string }[];
    let best: RepositoryHistory | undefined;
    for (const snapshot of snapshots) {
      try {
        const dashboard = dashboardSchema.parse(JSON.parse(snapshot.data));
        const metrics = dashboard.repositories.find((repo) => repo.repository === repository);
        const records = z.record(repositorySchema, historicalRecordsSchema).parse(JSON.parse(snapshot.history))[repository];
        if (metrics && records && (!best || Date.parse(metrics.range.until) - Date.parse(metrics.range.since) > Date.parse(best.coverage.until) - Date.parse(best.coverage.since))) {
          best = { metrics, records, coverage: metrics.range, checkedAt: Date.parse(metrics.updatedAt), authSource: dashboard.authSource };
        }
      } catch { /* Ignore incomplete legacy history. */ }
    }
    if (best && !controller.signal.aborted) database.prepare("INSERT INTO repository_history (repository, configuration, data, last_used_at) VALUES (?, ?, ?, ?) ON CONFLICT(repository, configuration) DO NOTHING").run(repository, config, JSON.stringify(best), Date.now());
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
      const metrics = await loadMetrics(repository, token, controller.signal, asOf, { metrics: source.metrics, records: source.records }, undefined, { request, draftRules: draftRules(values), onProgress: progress });
      if (canWrite()) database.prepare("UPDATE repository_history SET data = ? WHERE repository = ? AND configuration = ?").run(JSON.stringify(source), repository, config);
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
    const operation = loadMetrics(repository, token, controller.signal, range, undefined, (value) => { records = value; }, { request, draftRules: draftRules(values), historyRange: coverage, previous: source?.records, partitionCi: true, onProgress: progress, onWarning: (message) => { if (canWrite()) bb.log.warn(`CI history for ${repository}: ${message}`); } }).then((metrics) => {
      if (records && canWrite()) {
        const result: RepositoryHistory = { metrics, records, coverage, checkedAt: Date.now(), projectName, authSource };
        database.prepare("INSERT INTO repository_history (repository, configuration, data, last_used_at) VALUES (?, ?, ?, ?) ON CONFLICT(repository, configuration) DO UPDATE SET data = excluded.data, last_used_at = excluded.last_used_at").run(repository, config, JSON.stringify(result), Date.now());
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
  const handlers: PluginRpcHandlers<typeof rpcContract> = {
    async cardDetails(input) {
      const values = await settings.get();
      const { token } = await resolveGithubToken(values.token, controller.signal);
      return loadCardDetails(input, token, controller.signal, draftRules(values));
    },
    async deployProduction() {
      if (deploying) throw new Error("A production deployment request is already in progress.");
      deploying = true;
      try {
        const { repository, importBbRepositories, token: override } = await settings.get();
        let allowed = splitRepositories(repositoriesSettingSchema.parse(repository))
          .some((repo) => repo.toLowerCase() === productionTarget.repository);
        if (!allowed && importBbRepositories) {
          const projects = await bb.sdk.projects.list({ includePersonal: true, signal: controller.signal });
          allowed = projects.some((project) => githubRepository(project.gitRemoteUrl)?.toLowerCase() === productionTarget.repository);
        }
        if (!allowed) throw new Error("Anvil must be included in the configured dashboard repositories before deploying.");
        const { token } = await resolveGithubToken(override, controller.signal);
        return await dispatchProduction(token, controller.signal);
      } finally { deploying = false; }
    },
    async interval({ repository, since, until }) {
      const start = Date.parse(since), end = Date.parse(until);
      if (start < Date.parse(minimumDate()) || start > end || end > Date.now()) throw new Error("Invalid statistics interval.");
      const values = await settings.get();
      const { token } = await resolveGithubToken(values.token, controller.signal);
      return loadMetrics(repository, token, controller.signal, {
        since, until, label: "selected interval", bucketMs: Math.max(1, end - start),
      }, undefined, undefined, { draftRules: draftRules(values) });
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
        .all(config) as { selection: string; data: string; history: string }[];
      const common = database.prepare("SELECT data FROM repository_history WHERE configuration = ?").all(config) as { data: string }[];
      const known = repositoryList?.configuration === config ? repositoryList.names : null;
      const shared = common.flatMap((row) => { try { return [historySchema.parse(JSON.parse(row.data))]; } catch { return []; } }).filter((row) => !known || known.includes(row.metrics.repository));
      if (shared.length && (!known || known.every((name) => shared.some((row) => row.metrics.repository === name)))) candidates.unshift({ selection: "", data: JSON.stringify({ repositories: shared.map((row) => ({ ...row.metrics, range: row.coverage, projectName: row.projectName ?? null })), authSource: shared[0].authSource ?? "anonymous", discoveryError: null }), history: JSON.stringify(Object.fromEntries(shared.map((row) => [row.metrics.repository, row.records]))) });
      for (const candidate of candidates) {
        const source = dashboardSchema.parse(JSON.parse(candidate.data));
        const histories = z.record(repositorySchema, historicalRecordsSchema).parse(JSON.parse(candidate.history));
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
    resolveRange(input.selection);
    const snapshot = input.refresh ? null : await handlers.snapshot(input.selection);
    const data = snapshot ?? await metrics(input.selection, input.refresh);
    const { refreshSeconds } = await settings.get();
    return ciReport(data, input, refreshSeconds, snapshot !== null);
  }
  bb.rpc.register(ciRpcContract, { ci: readCi }, {
    experimental_discoverable: true,
    experimental_description: "Read-only CI Dashboard summaries: pass rates, outcomes, workflow health and estimated elapsed timings. Cached by default; timestamps and staleness are explicit.",
  });
  bb.agents.registerTool({
    name: "ci_dashboard_metrics",
    description: "Read GitHub Actions CI data for CI Dashboard repositories: pass rate, outcomes, failures, branch/workflow health, estimated timings in milliseconds, and slow-run links by ID. Defaults to a local cached snapshot; inspect stale, pending, updatedAt and errors. Set refresh:true to collect fresh data. Pass rates exclude cancelled/skipped; timing estimates use successful runs only. No deployments or other writes are triggered.",
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
