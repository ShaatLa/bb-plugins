import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { rangeInputSchema, resolveRange, type RangeInput } from "./date-range";
import { historicalRecordsSchema, loadMetrics, metricsSchema, repositorySchema, type HistoricalRecords } from "./metrics";
import { resolveGithubToken } from "./auth";
import { dispatchProduction, productionTarget } from "./production";
import { githubRepository, repositoriesSettingSchema, splitRepositories, uniqueRepositories } from "./repositories";

const dashboardSchema = z.object({
  repositories: z.array(metricsSchema.extend({ projectName: z.string().nullable() })),
  authSource: z.enum(["plugin", "environment", "gh", "anonymous"]),
  discoveryError: z.string().nullable(),
});
export type DashboardData = z.infer<typeof dashboardSchema>;
export const rpcContract = defineRpcContract({
  metrics: { input: rangeInputSchema, output: dashboardSchema },
  snapshot: { input: rangeInputSchema, output: dashboardSchema.nullable() },
  deployProduction: { input: z.null(), output: z.object({ url: z.url() }) },
  interval: {
    input: z.object({ repository: repositorySchema, since: z.iso.datetime(), until: z.iso.datetime() }).strict(),
    output: metricsSchema,
  },
});

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    repository: {
      type: "string",
      label: "Additional GitHub repositories (owner/repo, one per line or comma-separated)",
      default: "",
      experimental_multiline: true,
      experimental_schema: repositoriesSettingSchema,
    },
    importBbRepositories: {
      type: "boolean", label: "Include GitHub repositories from BB projects", default: true,
    },
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
  ]);
  let generation = 0;
  const pending = new Map<string, Promise<DashboardData>>();
  function selectionKey(input: RangeInput) {
    return JSON.stringify(rangeInputSchema.parse(input) ?? { days: 7 });
  }
  function configuration(values: Awaited<ReturnType<typeof settings.get>>) {
    return createHash("sha256").update(JSON.stringify(["ci-exclude-cancelled-skipped-v1", "review:none", values.repository, values.importBbRepositories, values.token ?? ""])).digest("hex");
  }
  settings.onChange(() => {
    generation++;
    database.prepare("DELETE FROM dashboard_snapshots").run();
    bb.realtime.publish("configuration-changed", {});
  });
  async function metrics(input: RangeInput): Promise<DashboardData> {
    const version = generation;
    const values = await settings.get();
    const config = configuration(values);
    const selection = selectionKey(input);
    const key = `${version}:${config}:${selection}`;
    const existing = pending.get(key);
    if (existing) return existing;
    const histories: Record<string, HistoricalRecords> = {};
    const request = collect(input, values, histories).then((result) => {
      if (!controller.signal.aborted && version === generation) {
        database.prepare("INSERT INTO dashboard_snapshots (selection, configuration, data, refreshed_at, history) VALUES (?, ?, ?, ?, ?) ON CONFLICT(selection) DO UPDATE SET configuration = excluded.configuration, data = excluded.data, refreshed_at = excluded.refreshed_at, history = excluded.history")
          .run(selection, config, JSON.stringify(result), Date.now(), JSON.stringify(histories));
        // shortcut: retain eight recent ranges; increase if revisiting more ranges becomes common.
        database.prepare("DELETE FROM dashboard_snapshots WHERE selection NOT IN (SELECT selection FROM dashboard_snapshots ORDER BY refreshed_at DESC LIMIT 8)").run();
      }
      return result;
    });
    pending.set(key, request);
    try { return await request; }
    finally { pending.delete(key); }
  }
  async function collect(input: RangeInput, values: Awaited<ReturnType<typeof settings.get>>, histories: Record<string, HistoricalRecords>): Promise<DashboardData> {
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
    return {
      repositories: await Promise.all(uniqueRepositories(repositories).map(async (repo) => ({
        ...await loadMetrics(repo, token, controller.signal, range, undefined, (records) => { histories[repo] = records; }),
        projectName: projectNames.get(repo.toLowerCase()) ?? null,
      }))),
      authSource: source,
      discoveryError,
    };
  }
  bb.background.service("snapshot-refresh", {
    async start(signal) {
      const stop = () => controller.abort();
      signal.addEventListener("abort", stop, { once: true });
      try {
        while (!signal.aborted) {
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
  bb.rpc.register(rpcContract, {
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
      if (start < 0 || start > end || end > Date.now()) throw new Error("Invalid statistics interval.");
      const { token: override } = await settings.get();
      const { token } = await resolveGithubToken(override, controller.signal);
      return loadMetrics(repository, token, controller.signal, {
        since, until, label: "selected interval", bucketMs: Math.max(1, end - start),
      });
    },
    metrics,
    async snapshot(input) {
      resolveRange(input);
      const version = generation;
      const values = await settings.get();
      if (version !== generation) return null;
      const config = configuration(values);
      const row = database.prepare("SELECT data FROM dashboard_snapshots WHERE selection = ? AND configuration = ?")
        .get(selectionKey(input), config) as { data: string } | undefined;
      if (row) return dashboardSchema.parse(JSON.parse(row.data));
      const candidates = database.prepare("SELECT selection, data, history FROM dashboard_snapshots WHERE configuration = ? AND history IS NOT NULL ORDER BY refreshed_at DESC LIMIT 8")
        .all(config) as { selection: string; data: string; history: string }[];
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
        const { token: override } = values;
        const { token } = await resolveGithubToken(override, controller.signal);
        const result: DashboardData = {
          ...source,
          repositories: await Promise.all(source.repositories.map(async (repo, index) => ({
            ...await loadMetrics(repo.repository, token, controller.signal, ranges[index]!, { metrics: repo, records: histories[repo.repository] }),
            projectName: repo.projectName,
          }))),
        };
        if (version !== generation || controller.signal.aborted) return null;
        const latest = database.prepare("SELECT data FROM dashboard_snapshots WHERE selection = ? AND configuration = ?")
          .get(selectionKey(input), config) as { data: string } | undefined;
        if (latest) return dashboardSchema.parse(JSON.parse(latest.data));
        database.prepare("UPDATE dashboard_snapshots SET refreshed_at = ? WHERE selection = ?").run(Date.now(), candidate.selection);
        database.prepare("INSERT INTO dashboard_snapshots (selection, configuration, data, refreshed_at) VALUES (?, ?, ?, ?) ON CONFLICT(selection) DO UPDATE SET configuration = excluded.configuration, data = excluded.data, refreshed_at = excluded.refreshed_at, history = NULL")
          .run(selectionKey(input), config, JSON.stringify(result), Date.now());
        database.prepare("DELETE FROM dashboard_snapshots WHERE selection NOT IN (SELECT selection FROM dashboard_snapshots ORDER BY refreshed_at DESC LIMIT 8)").run();
        return result;
      }
      return null;
    },
  });
}
