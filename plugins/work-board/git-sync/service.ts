import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { environmentPullRequests } from "./environment-prs";
import type { TasksApiStore } from "../api";
import type { tasksRpcContract } from "../shared/contract";
import { publishProjectsChanged } from "../api";
import {
  gitSyncConfigSchema,
  repositorySchema,
  parsePrUrl,
  prIdentity,
  prLinkSchema,
  type PrLink,
} from "../shared/git-sync";
import { createGitSyncStore } from "./store";
import {
  createGithubClient,
  githubToken,
  type GithubClient,
  GithubError,
} from "./github";

const services = new WeakMap<
  TasksApiStore,
  ReturnType<typeof createGitSyncService>
>();
export function gitSyncService(
  bb: BbPluginApi,
  store: TasksApiStore,
  clientOverride?: GithubClient,
) {
  let service = services.get(store);
  if (!service) {
    service = createGitSyncService(bb, store, clientOverride);
    services.set(store, service);
  }
  return service;
}
export function createGitSyncService(
  bb: BbPluginApi,
  store: TasksApiStore,
  clientOverride?: GithubClient,
) {
  const db = bb.storage.database();
  const data = createGitSyncStore(db);
  const controller = new AbortController();
  bb.onDispose(() => controller.abort());
  let tokenAt = 0;
  let tokenPromise: Promise<string | undefined> | undefined;
  const client =
    clientOverride ??
    createGithubClient({
      signal: controller.signal,
      token: () => {
        if (!tokenPromise || Date.now() - tokenAt > 15_000) {
          tokenAt = Date.now();
          tokenPromise = githubToken(controller.signal);
        }
        return tokenPromise;
      },
    });
  const pending = new Map<
    string,
    Promise<{ checked: number; errors: string[] }>
  >();
  const discovery = new Map<
    string,
    { at: number; promise: ReturnType<GithubClient["discover"]> }
  >();
  const requireTask = (taskId: string) => {
    const task = store.tasks.getTask(taskId);
    if (!task) throw new Error("Task not found");
    return task;
  };
  const requireProject = (projectId: string) => {
    const project = store.tasks.getProject(projectId);
    if (!project) throw new Error("Project not found");
    return project;
  };
  const publishProjectPrs = (projectId: string) => {
    for (const taskId of new Set(data.linksForProject(projectId).map(link => link.taskId)))
      bb.realtime.publish("prs:changed", { taskId, projectId });
  };
  const remember = (
    taskId: string,
    url: string,
    source: PrLink["source"],
    manual?: { role: PrLink["role"]; part: string | null },
  ) => {
    const task = requireTask(taskId);
    const address = parsePrUrl(url);
    if (!data.config(task.projectId).repositories.includes(address.repository))
      throw new Error(
        "Add this repository to the project's Git/PR sync settings first",
      );
    const old = data
      .links(taskId)
      .find((link) => prIdentity(link) === prIdentity(address));
    if (old && !manual) return old;
    const now = new Date().toISOString();
    const link = data.saveLink(
      prLinkSchema.parse({
        ...address,
        url: `https://github.com/${address.repository}/pull/${address.number}`,
        taskId,
        source,
        role: manual?.role ?? "related",
        part: manual?.part ?? null,
        confirmed: Boolean(manual),
        excluded: false,
        remoteId: old?.remoteId ?? null,
        createdAt: old?.createdAt ?? now,
        updatedAt: now,
      }),
    );
    publishProjectPrs(task.projectId);
    return link;
  };
  async function syncProject(
    projectId: string,
    force = false,
  ): Promise<{ checked: number; errors: string[] }> {
    if (pending.has(projectId)) return pending.get(projectId)!;
    const operation = (async () => {
      const project = requireProject(projectId);
      let config = data.config(projectId);
      let fingerprint = JSON.stringify(config);
      if (force)
        for (const repository of config.repositories)
          discovery.delete(`${repository}:${config.lookbackDays}`);
      const current = () =>
        !controller.signal.aborted &&
        Boolean(store.tasks.getProject(projectId)) &&
        JSON.stringify(data.config(projectId)) === fingerprint;
      data.attempted(projectId);
      const errors: string[] = [];
      const report = (repository: string, error: unknown) =>
        `${repository}: ${error instanceof GithubError ? error.message : "GitHub synchronization unavailable; retry later"}`;
      const tasks = store.tasks.listTasks({ projectId });
      if (config.titleDiscovery)
        for (const repository of config.repositories) {
          try {
            const key = `${repository}:${config.lookbackDays}`;
            let scan = discovery.get(key);
            if (!scan || Date.now() - scan.at > 30_000) {
              scan = {
                at: Date.now(),
                promise: client.discover(repository, config.lookbackDays),
              };
              discovery.set(key, scan);
            }
            const pulls = await scan.promise;
            if (!current())
              return {
                checked: 0,
                errors: ["Configuration changed; retry sync"],
              };
            const aliases = db
              .prepare<[string], { prefix: string }>(
                "SELECT DISTINCT a.prefix FROM task_key_aliases a JOIN tasks t ON t.id=a.task_id WHERE t.project_id=?",
              )
              .all(projectId)
              .map((row) => row.prefix);
            const prefixes = [...new Set([project.prefix, ...aliases])].map(
              (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
            );
            const pattern = new RegExp(
              `(?<![\\p{L}\\p{N}_])(?:${prefixes.join("|")})-[1-9][0-9]*(?![\\p{L}\\p{N}_])`,
              "giu",
            );
            for (const pr of pulls)
              for (const match of pr.title.matchAll(pattern)) {
                const task = store.tasks.getTaskByKey(match[0].toUpperCase());
                if (task?.projectId === projectId)
                  remember(task.id, pr.html_url, "title");
              }
          } catch (error) {
            discovery.delete(`${repository}:${config.lookbackDays}`);
            errors.push(report(repository, error));
          }
        }
      const environmentTasks = new Map<string, Set<string>>();
      if (config.repositories.length === 1) {
        const evidence = db.prepare<[string], { taskId: string; pr: number }>(
          `SELECT DISTINCT c.task_id AS taskId, json_extract(c.evidence, '$.pr') AS pr
           FROM comments c JOIN tasks t ON t.id=c.task_id
           WHERE t.project_id=? AND c.evidence IS NOT NULL AND json_extract(c.evidence, '$.pr') > 0`,
        ).all(projectId);
        for (const row of evidence) remember(row.taskId, `https://github.com/${config.repositories[0]}/pull/${row.pr}`, "evidence");
      }
      const threadCache = new Map<string, ReturnType<typeof bb.sdk.threads.get>>();
      for (const task of tasks) {
        if (!current()) break;
        for (const link of store.tasks.listTaskThreads(task.id)) {
          try {
            let lookup = threadCache.get(link.threadId);
            if (!lookup) {
              lookup = bb.sdk.threads.get({ threadId: link.threadId });
              threadCache.set(link.threadId, lookup);
            }
            const thread = await lookup;
            if (!thread.environmentId || !current()) continue;
            const members =
              environmentTasks.get(thread.environmentId) ?? new Set<string>();
            members.add(task.id);
            environmentTasks.set(thread.environmentId, members);
          } catch {
            /* A retired worker must not erase a persistent link. */
          }
        }
      }
      const lookups = await environmentPullRequests(bb, environmentTasks.keys());
      for (const [environmentId, members] of environmentTasks) {
        const result = lookups.get(environmentId)!;
        if (result.outcome !== "available" || !current()) continue;
        try {
          const parsed = parsePrUrl(result.pullRequest.url);
          if (config.repositories.includes(parsed.repository))
            for (const taskId of members)
              remember(taskId, result.pullRequest.url, "environment");
        } catch {
          /* Environment discovery is optional; direct PR links keep working. */
        }
      }
      let checked = 0;
      const refreshed = new Set<string>();
      // A changed head can change other tasks' overlaps; otherwise only refreshed PRs need an update.
      let filesChanged = false;
      const unique = new Map<string, PrLink>();
      for (const link of data.linksForProject(projectId))
          if (!link.excluded && config.repositories.includes(link.repository))
            unique.set(prIdentity(link), link);
      for (const link of unique.values()) {
        if (!current()) break;
        const previous = data.snapshot(projectId, link);
        if (!force && !previous.error && previous.snapshot) {
          const value = previous.snapshot;
          if (
            value.state === "merged" &&
            value.mergedAt &&
            Date.now() - Date.parse(value.mergedAt) >
              config.postMergeDays * 86400000
          )
            continue;
          if (
            value.state === "closed" &&
            Date.now() - Date.parse(value.updatedAt) >
              config.lookbackDays * 86400000 &&
            Date.now() - Date.parse(value.observedAt) < 3600000
          )
            continue;
        }
        try {
          const snapshot = await client.snapshot(
            link.repository,
            link.number,
            config,
            previous.snapshot,
          );
          if (!current()) break;
          if (
            !snapshot.coverage.length &&
            snapshot.mergeSha &&
            snapshot.mergeSha === previous.snapshot?.mergeSha
          )
            snapshot.coverage = previous.snapshot.coverage.filter((value) =>
              config.postMergeWorkflows.includes(value.workflow),
            );
          store.transaction(() => {
            data.saveSnapshot(projectId, link, snapshot);
            if (snapshot.repository !== link.repository) {
              config = data.setConfig(projectId, {
                ...config,
                repositories: [
                  ...new Set(
                    config.repositories.map((repository) =>
                      repository === link.repository
                        ? snapshot.repository
                        : repository,
                    ),
                  ),
                ],
              });
              fingerprint = JSON.stringify(config);
              data.attempted(projectId);
              publishProjectsChanged(bb, projectId);
            }
          });
          refreshed.add(prIdentity(link));
          refreshed.add(prIdentity(snapshot));
          if (snapshot.headSha !== previous.snapshot?.headSha) filesChanged = true;
          checked++;
        } catch (error) {
          if (!current()) break;
          const message = report(link.repository, error);
          refreshed.add(prIdentity(link));
          data.fail(projectId, link, message);
          errors.push(message);
        }
      }
      if (current()) {
        if (filesChanged) publishProjectPrs(projectId);
        else {
          const linked = new Set(data.linksForProject(projectId).filter((link) => !link.excluded && refreshed.has(prIdentity(link))).map((link) => link.taskId));
          for (const taskId of linked) bb.realtime.publish("prs:changed", { taskId, projectId });
        }
      }
      return { checked, errors: [...new Set(errors)] };
    })();
    pending.set(projectId, operation);
    try {
      return await operation;
    } finally {
      pending.delete(projectId);
    }
  }
  const handlers: Pick<
    PluginRpcHandlers<typeof tasksRpcContract>,
    | "prSummaries"
    | "getGitSyncConfig"
    | "setGitSyncConfig"
    | "listPrLinks"
    | "linkPr"
    | "unlinkPr"
    | "syncGit"
  > = {
    prSummaries({ taskIds }) {
      const summaries = data.summaries(taskIds);
      const overlaps = data.overlapsForTasks(summaries.map((summary) => summary.taskId));
      return { summaries: summaries.map((summary) => ({ ...summary, overlaps: overlaps.get(summary.taskId) ?? [] })) };
    },
    async getGitSyncConfig({ projectId }) {
      const project = requireProject(projectId);
      const fromRemote = (remote: string | null) => {
        const match = remote?.match(
          /^(?:https?:\/\/(?:[^/@]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i,
        );
        const parsed = repositorySchema.safeParse(match?.[1]);
        return parsed.success ? parsed.data : null;
      };
      let suggestedRepository: string | null = null;
      const available = new Set<string>();
      try {
        const projects = await bb.sdk.projects.list({ includePersonal: true });
        for (const entry of projects) {
          const repository = fromRemote(entry.gitRemoteUrl);
          if (repository) available.add(repository);
          if (entry.id === project.linkedBbProjectId)
            suggestedRepository = repository;
        }
      } catch {
        /* Manual configuration stays available if BB projects cannot be read. */
      }
      if (project.linkedBbProjectId && !suggestedRepository) {
        try {
          const linked = await bb.sdk.projects.get({
            projectId: project.linkedBbProjectId,
          });
          suggestedRepository = fromRemote(linked.gitRemoteUrl);
          if (suggestedRepository) available.add(suggestedRepository);
        } catch {
          /* Suggestions are optional. */
        }
      }
      return {
        config: data.config(projectId),
        suggestedRepository,
        availableRepositories: [...available].sort(),
      };
    },
    setGitSyncConfig({ projectId, config }) {
      requireProject(projectId);
      const saved = data.setConfig(
        projectId,
        gitSyncConfigSchema.parse(config),
      );
      discovery.clear();
      publishProjectsChanged(bb, projectId);
      publishProjectPrs(projectId);
      return { config: saved };
    },
    listPrLinks({ taskId }) {
      const task = requireTask(taskId);
      const config = data.config(task.projectId);
      return {
        overlaps: data.overlaps(taskId),
        links: data.links(taskId).map((link) => {
          const cached = data.snapshot(task.projectId, link);
          return {
            link,
            ...cached,
            stale:
              link.excluded ||
              !config.repositories.includes(link.repository) ||
              Boolean(cached.error) ||
              !cached.snapshot ||
              Date.now() - Date.parse(cached.snapshot.observedAt) >
                config.pollMinutes * 60_000,
          };
        }),
      };
    },
    linkPr({ taskId, url, role, part }) {
      return { link: remember(taskId, url, "manual", { role, part }) };
    },
    unlinkPr({ taskId, url }) {
      const task = requireTask(taskId);
      const address = parsePrUrl(url);
      const old = data
        .links(taskId)
        .find((link) => prIdentity(link) === prIdentity(address));
      const now = new Date().toISOString();
      data.saveLink(
        prLinkSchema.parse({
          ...address,
          url: `https://github.com/${address.repository}/pull/${address.number}`,
          taskId,
          source: "manual",
          role: "related",
          part: null,
          confirmed: false,
          remoteId: null,
          createdAt: now,
          ...old,
          excluded: true,
          updatedAt: now,
        }),
      );
      publishProjectPrs(task.projectId);
      return { excluded: true };
    },
    syncGit({ projectId }) {
      return syncProject(projectId, true);
    },
  };
  return {
    handlers,
    remember,
    syncProject,
    async runDue() {
      for (const project of store.tasks.listProjects())
        if (data.config(project.id).enabled && data.due(project.id))
          await syncProject(project.id);
    },
  };
}
