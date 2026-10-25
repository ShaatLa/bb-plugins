import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { TasksApiStore } from "../api";
import type { tasksRpcContract } from "../shared/contract";
import { publishTasksChanged, publishProjectsChanged } from "../api";
import {
  gitSyncConfigSchema,
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
    publishTasksChanged(bb, task.id, task.projectId);
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
      for (const task of tasks) {
        if (!current()) break;
        if (config.repositories.length === 1)
          for (const comment of store.tasks.listComments(task.id)) {
            const evidence = comment.evidence;
            if (evidence && "pr" in evidence && evidence.pr)
              remember(
                task.id,
                `https://github.com/${config.repositories[0]}/pull/${evidence.pr}`,
                "evidence",
              );
          }
        for (const link of store.tasks.listTaskThreads(task.id)) {
          try {
            const thread = await bb.sdk.threads.get({
              threadId: link.threadId,
            });
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
      for (const [environmentId, members] of environmentTasks) {
        if (!current()) break;
        try {
          const result = await bb.sdk.environments.pullRequest({
            environmentId,
          });
          if (result.outcome !== "available" || !current()) continue;
          const parsed = parsePrUrl(result.pullRequest.url);
          if (config.repositories.includes(parsed.repository))
            for (const taskId of members)
              remember(taskId, result.pullRequest.url, "environment");
        } catch {
          /* Environment discovery is optional; direct PR links keep working. */
        }
      }
      let checked = 0;
      const unique = new Map<string, PrLink>();
      for (const task of tasks)
        for (const link of data.links(task.id))
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
          checked++;
        } catch (error) {
          if (!current()) break;
          const message = report(link.repository, error);
          data.fail(projectId, link, message);
          errors.push(message);
        }
      }
      if (current())
        for (const task of tasks)
          publishTasksChanged(bb, task.id, task.projectId);
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
      const ids = new Set(taskIds);
      const all = data
        .links()
        .filter((link) => ids.has(link.taskId) && !link.excluded);
      return {
        summaries: taskIds.flatMap((taskId) => {
          const task = store.tasks.getTask(taskId);
          if (!task) return [];
          const links = all.filter((link) => link.taskId === taskId);
          if (!links.length) return [];
          const values = links.map((link) => ({
            link,
            ...data.snapshot(task.projectId, link),
          }));
          const config = data.config(task.projectId);
          return [
            {
              taskId,
              total: links.length,
              merged: values.filter(
                (value) => value.snapshot?.state === "merged",
              ).length,
              failing: values.filter(
                (value) => value.snapshot?.ci === "failing",
              ).length,
              pending: values.filter(
                (value) => value.snapshot?.ci === "pending",
              ).length,
              stale: values.some(
                (value) =>
                  !value.snapshot ||
                  Boolean(value.error) ||
                  !config.repositories.includes(value.link.repository) ||
                  Date.now() - Date.parse(value.snapshot.observedAt) >
                    config.pollMinutes * 60_000,
              ),
            },
          ];
        }),
      };
    },
    async getGitSyncConfig({ projectId }) {
      const project = requireProject(projectId);
      let suggestedRepository: string | null = null;
      if (project.linkedBbProjectId) {
        try {
          const linked = await bb.sdk.projects.get({
            projectId: project.linkedBbProjectId,
          });
          const remote = linked.gitRemoteUrl;
          const match = remote?.match(
            /(?:github\.com[:/])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/,
          );
          if (match) suggestedRepository = match[1]!.toLowerCase();
        } catch {
          /* Suggestions are optional. */
        }
      }
      return { config: data.config(projectId), suggestedRepository };
    },
    setGitSyncConfig({ projectId, config }) {
      requireProject(projectId);
      const saved = data.setConfig(
        projectId,
        gitSyncConfigSchema.parse(config),
      );
      discovery.clear();
      publishProjectsChanged(bb, projectId);
      return { config: saved };
    },
    listPrLinks({ taskId }) {
      const task = requireTask(taskId);
      const config = data.config(task.projectId);
      return {
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
      publishTasksChanged(bb, task.id, task.projectId);
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
