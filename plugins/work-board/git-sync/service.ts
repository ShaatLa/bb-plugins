import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { environmentPullRequests } from "./environment-prs";
import type { TasksApiStore } from "../api";
import type { tasksRpcContract } from "../shared/contract";
import { publishProjectsChanged, publishTasksChanged } from "../api";
import { DEFAULT_TASK_STATUSES } from "../shared/statuses";
import { getWorkflowPolicy } from "../shared/workflow-policy";
import {
  gitSyncConfigSchema,
  repositorySchema,
  parsePrUrl,
  prIdentity,
  prLinkSchema,
  observationDue,
  observationStale,
  observationTtl,
  settledSpreadMs,
  type PrLink,
  type PrSnapshot,
  STALE_GIT_CONFIG,
} from "../shared/git-sync";
import { createGitSyncStore } from "./store";
import { prEventService, prEventSettings, queueDeparture, recordPrEvents } from "./events";
import { planDebtService } from "../plan-debt/service";
import { hasPlanDebtEvent } from "../plan-debt/store";
import {
  createGithubClient,
  githubToken,
  type GithubClient,
  GithubError,
  wholeSecond,
} from "./github";

const SYNC_DEADLINE_MS = 4 * 60_000;
// No new PR starts after this, so the pass ends on its own before the hard deadline cuts a fetch.
const SYNC_BUDGET_MS = SYNC_DEADLINE_MS - 60_000;
// A due PR that has waited this long goes first within its class (scheduled) or the whole pass (forced), oldest first.
const LEAD_MS = 15 * 60_000;
// One budget per run for the post-merge sweep, shared by every project, so the next run's PR refresh is never held.
const SWEEP_BUDGET_MS = 45_000;

/** `failures`: required PR snapshot requests that failed for a non-permission reason; `tolerated`: optional lookups and permission refusals. */
type SyncResult = { checked: number; errors: string[]; deferred: number; failures: number; tolerated: number; timedOut: boolean };

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
  const events = prEventService(bb, store.tasks);
  const controller = new AbortController();
  bb.onDispose(() => controller.abort());
  let tokenAt = 0;
  let tokenPromise: Promise<string | undefined> | undefined;
  const github = createGithubClient({
    signal: controller.signal,
    token: () => {
      if (!tokenPromise || Date.now() - tokenAt > 15_000) {
        tokenAt = Date.now();
        tokenPromise = githubToken(controller.signal);
      }
      return tokenPromise;
    },
  });
  const pending = new Map<string, Promise<SyncResult>>();
  const discovery = new Map<
    string,
    { at: number; promise: ReturnType<GithubClient["discover"]> }
  >();
  const deadlineWarnings = new Map<string, number>();
  // When a forced pass first left a PR unread, by project and PR, so repeated forced passes promote it in bounded time.
  const forcedWaiting = new Map<string, number>();
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
  const publishPrs = (projectId: string, tasks: Iterable<string>) => {
    const affected = new Set(tasks), ids = [...affected];
    // A predecessor PR refresh also invalidates advice on its dependents, without broad board refreshes.
    for (let offset = 0; offset < ids.length; offset += 500) {
      const batch = ids.slice(offset, offset + 500);
      for (const row of db.prepare<string[], { taskId: string }>(`SELECT DISTINCT task_id AS taskId FROM task_dependencies WHERE blocking_task_id IN (${batch.map(() => "?").join(",")})`).all(...batch)) affected.add(row.taskId);
    }
    for (const taskId of affected) bb.realtime.publish("prs:changed", { taskId, projectId });
  };
  const publishProjectPrs = (projectId: string) => publishPrs(projectId, data.linksForProject(projectId).map(link => link.taskId));
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
  ): Promise<SyncResult> {
    if (pending.has(projectId)) return pending.get(projectId)!;
    // A run that never settles (an SDK or network await that hangs) must not block every later sync.
    const run = new AbortController();
    const client = clientOverride ?? github.withSignal(run.signal);
    const startedAt = Date.now();
    let phase = "start";
    let fingerprint: string | undefined;
    let checked = 0, deferred = 0, failures = 0, tolerated = 0, filesChanged = false, published = false;
    const errors: string[] = [];
    // A changed head can change other tasks' overlaps; otherwise only refreshed PRs need an update.
    const refreshed = new Set<string>();
    let projectLinks: PrLink[] = [];
    const linksByPr = new Map<string, PrLink[]>();
    // Our own deadline abort does not block publishing committed work; dispose, deletion and config changes do.
    const live = () =>
      !controller.signal.aborted &&
      fingerprint !== undefined &&
      Boolean(store.tasks.getProject(projectId)) &&
      JSON.stringify(data.config(projectId)) === fingerprint;
    const current = () => live() && !run.signal.aborted;
    const finish = (extra: string[] = []): SyncResult => ({ checked, errors: [...new Set([...extra, ...errors])], deferred, failures, tolerated, timedOut: false });
    const flush = () => {
      if (published || !live()) return;
      published = true;
      if (filesChanged) publishPrs(projectId, projectLinks.map((link) => link.taskId));
      else {
        const linked = new Set([...refreshed].flatMap((identity) => (linksByPr.get(identity) ?? []).filter((link) => !link.excluded).map((link) => link.taskId)));
        if (linked.size) publishPrs(projectId, linked);
      }
    };
    const operation = (async () => {
      const project = requireProject(projectId);
      let config = data.config(projectId);
      fingerprint = JSON.stringify(config);
      if (force)
        for (const repository of config.repositories)
          discovery.delete(`${repository}:${config.lookbackDays}`);
      if (!current()) return finish();
      data.attempted(projectId);
      const report = (repository: string, error: unknown) =>
        `${repository}: ${error instanceof GithubError ? error.message : "GitHub synchronization unavailable; retry later"}`;
      // Pairs already linked need no remember() call: it would only re-read the card's links to return them.
      const known = data.linkKeys(projectId);
      const discovered = (taskId: string, url: string, source: PrLink["source"]) => {
        const key = `${taskId} ${prIdentity(parsePrUrl(url))}`;
        if (known.has(key)) return;
        remember(taskId, url, source);
        known.add(key);
      };
      const tasks = store.tasks.listTasks({ projectId });
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
      const referencedTaskIds = (text: string) => {
        const ids = new Set<string>();
        for (const match of text.matchAll(pattern)) {
          const task = store.tasks.getTaskByKey(match[0].toUpperCase());
          if (task?.projectId === projectId) ids.add(task.id);
        }
        return ids;
      };
      phase = "title discovery";
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
              const created = scan;
              scan.promise.then(() => {
                if (current()) discovery.set(key, created);
              }, () => {});
            }
            const pulls = await scan.promise;
            if (!current()) return finish(["Configuration changed; retry sync"]);
            for (const pr of pulls)
              for (const taskId of referencedTaskIds(pr.title))
                discovered(taskId, pr.html_url, "title");
          } catch (error) {
            if (!current()) return finish();
            discovery.delete(`${repository}:${config.lookbackDays}`);
            tolerated++;
            errors.push(report(repository, error));
          }
        }
      if (!current()) return finish();
      const environmentTasks = new Map<string, Set<string>>();
      if (config.repositories.length === 1) {
        const evidence = db.prepare<[string], { taskId: string; pr: number }>(
          `SELECT DISTINCT c.task_id AS taskId, json_extract(c.evidence, '$.pr') AS pr
           FROM comments c JOIN tasks t ON t.id=c.task_id
           WHERE t.project_id=? AND c.evidence IS NOT NULL AND json_extract(c.evidence, '$.pr') > 0`,
        ).all(projectId);
        for (const row of evidence) discovered(row.taskId, `https://github.com/${config.repositories[0]}/pull/${row.pr}`, "evidence");
      }
      phase = "worker thread lookup";
      // Resolve each attached thread once, in bounded batches, while retaining persistent links on failure.
      const links = store.tasks.listTaskThreadsForTasks(tasks.map((task) => task.id));
      const ids = [...new Set(links.map((link) => link.threadId))];
      const environments = new Map<string, string>();
      for (let offset = 0; offset < ids.length && current(); offset += 200) {
        const batch = ids.slice(offset, offset + 200);
        try {
          const threads = await bb.sdk.threads.list({ threadIds: batch, limit: batch.length, includeHidden: true, signal: AbortSignal.any([controller.signal, run.signal]) });
          if (!current()) break;
          for (const thread of threads)
            if (thread.environmentId) environments.set(thread.id, thread.environmentId);
        } catch {
          tolerated++;
          /* Unavailable workers must not erase persistent links. */
        }
      }
      for (const link of links) {
        const environmentId = environments.get(link.threadId);
        if (!environmentId) continue;
        const members = environmentTasks.get(environmentId) ?? new Set<string>();
        members.add(link.taskId);
        environmentTasks.set(environmentId, members);
      }
      if (!current()) return finish();
      phase = "environment PR read";
      const lookups = await environmentPullRequests(bb, environmentTasks.keys(), () => current());
      if (!current()) return finish();
      const references = new Map<string, Promise<string>>();
      for (const [environmentId, members] of environmentTasks) {
        const result = lookups.get(environmentId)!;
        if (result.outcome !== "available" || !current()) continue;
        try {
          const parsed = parsePrUrl(result.pullRequest.url);
          if (!config.repositories.includes(parsed.repository)) continue;
          const identity = prIdentity(parsed);
          let text = references.get(identity);
          if (!text) {
            text = client.referenceText(parsed.repository, parsed.number);
            references.set(identity, text);
          }
          const matching = referencedTaskIds(await text);
          if (!current()) return finish();
          // Shared workers are not evidence that a PR belongs to every attached task.
          for (const taskId of members)
            if (matching.has(taskId))
              discovered(taskId, result.pullRequest.url, "environment");
        } catch {
          tolerated++;
          /* Environment discovery is optional; direct PR links keep working. */
        }
      }
      phase = "PR snapshots";
      const unique = new Map<string, PrLink>();
      projectLinks = data.linksForProject(projectId);
      for (const link of projectLinks) {
        const identity = prIdentity(link);
        if (!linksByPr.has(identity)) linksByPr.set(identity, []);
        linksByPr.get(identity)!.push(link);
        if (!link.excluded && config.repositories.includes(link.repository)) unique.set(identity, link);
      }
      const attempts = data.attempts(projectId);
      // Merges whose SHA has not arrived keep being read only while the SHA can still produce a message: the `merged` notice of a merge
      // Work Board saw happen ("!"), or a configured deployment wait of a merge first seen inside its window.
      const eventsOn = config.enabled && prEventSettings(db, projectId).events === "on";
      const shaPending = new Map(eventsOn ? db.prepare<[string], { remoteId: string; marker: string; seenAt: string }>(
        "SELECT remote_id AS remoteId, merge_sha AS marker, merge_seen_at AS seenAt FROM pr_event_state WHERE project_id=? AND merge_sha IN ('?', '!') AND merge_seen_at IS NOT NULL",
      ).all(projectId).map((row) => [row.remoteId, row]) : []);
      const now = Date.now(), poll = config.pollMinutes * 60_000;
      // A PR that left eligibility (excluded, unlinked, repository removed) starts a fresh wait if it comes back.
      for (const key of forcedWaiting.keys())
        if (key.startsWith(`${projectId} `) && !unique.has(key.slice(projectId.length + 1))) forcedWaiting.delete(key);
      type Seen = { state: PrSnapshot["state"]; mergedAt: string | null; updatedAt: string; observedAt: string; coverage: { workflow: string; state: string }[] };
      const due: { link: PrLink; tier: number; order: number; seen: Seen | null }[] = [];
      // Skips and order come from lightweight rows; full payloads are parsed only for PRs actually fetched.
      for (const link of unique.values()) {
        const attempt = attempts.get(prIdentity(link));
        const delay = [300_000, 900_000, 3_600_000, 21_600_000][Math.min((attempt?.failureCount ?? 0) - 1, 3)];
        if (!force && attempt?.failureCount && attempt.lastAttemptAt && now - attempt.lastAttemptAt < delay) continue;
        const seen: Seen | null = attempt?.state && attempt.observedAt && !attempt.error
          ? { state: attempt.state, mergedAt: attempt.mergedAt, updatedAt: attempt.updatedAt ?? "", observedAt: attempt.observedAt, coverage: JSON.parse(attempt.coverage ?? "[]") }
          : null;
        // shortcut: the SHA is awaited for one day past the cutoff at the poll interval; a longer GitHub delay leaves the wait unarmed.
        const pendingSha = attempt?.remoteId ? shaPending.get(attempt.remoteId) : undefined;
        const cutoff = seen?.mergedAt ? Date.parse(seen.mergedAt) + config.postMergeDays * 86_400_000 : NaN;
        const outstanding = pendingSha?.marker === "!" || (pendingSha !== undefined && config.postMergeWorkflows.length > 0 && Date.parse(pendingSha.seenAt) <= cutoff);
        const awaitingSha = seen?.state === "merged" && !attempt?.mergeSha && outstanding && now <= cutoff + 86_400_000;
        const ttl = seen ? observationTtl(seen, config, now) ?? (awaitingSha ? poll : null) : null;
        // Only settled merges spread; old closed PRs keep their plain hourly due time.
        const advance = seen?.state === "merged" && ttl !== null && ttl > poll ? settledSpreadMs(prIdentity(link)) : 0;
        if (!force && seen && !observationDue(seen.observedAt, ttl === null ? null : ttl - advance, config, now)) continue;
        const cutoffIn = seen?.state === "merged" && seen.mergedAt ? Date.parse(seen.mergedAt) + config.postMergeDays * 86_400_000 - now : null;
        const lead = !seen || seen.state === "open" || seen.state === "draft" || (cutoffIn !== null && cutoffIn >= 0 && cutoffIn <= poll);
        const lastAttemptAt = attempt?.lastAttemptAt ?? 0;
        if (force) {
          // Everything is due, so a scheduled due time means nothing: order by last attempt, and count waiting from the
          // first forced pass that left the PR unread, so old history neither jumps open work at once nor starves.
          // Seeded here, not at the budget stop, so a pass cut by the hard deadline still starts the clock.
          const key = `${projectId} ${prIdentity(link)}`;
          if (!forcedWaiting.has(key)) forcedWaiting.set(key, now);
          const waitingSince = forcedWaiting.get(key)!;
          const overdue = now - waitingSince >= LEAD_MS;
          due.push({ link, tier: overdue ? 0 : lead ? 1 : 2, order: overdue ? waitingSince : lastAttemptAt, seen });
          continue;
        }
        // Open and draft PRs always go ahead of merged and closed ones; within each class, a PR due for LEAD_MS goes first, oldest first.
        const dueAt = ttl !== null && ttl > poll ? Date.parse(seen!.observedAt) + ttl - poll - advance : lastAttemptAt;
        // The class is the last known state, so a failed refresh of a merged PR does not move it into the open class.
        const overdue = now - dueAt >= LEAD_MS, active = !attempt?.state || attempt.state === "open" || attempt.state === "draft";
        due.push({ link, tier: active ? (overdue ? 0 : 1) : overdue ? 2 : lead ? 3 : 4, order: dueAt, seen });
      }
      due.sort((left, right) => left.tier - right.tier || left.order - right.order);
      for (let index = 0; index < due.length; index++) {
        if (!current()) break;
        if (Date.now() - startedAt >= SYNC_BUDGET_MS) {
          deferred = due.length - index;
          break;
        }
        const { link, seen } = due[index]!;
        const previous = data.snapshot(projectId, link);
        try {
          data.markAttempt(projectId, link);
          forcedWaiting.delete(`${projectId} ${prIdentity(link)}`);
          const snapshot = await client.snapshot(
            link.repository,
            link.number,
            config,
            previous.snapshot,
          );
          if (!current()) break;
          // The timeline is read only when a known queue entry is gone, so ordinary polls cost no extra request.
          const departure = config.enabled && prEventSettings(db, projectId).events === "on" ? queueDeparture(db, projectId, snapshot) : null;
          let removal: Awaited<ReturnType<NonNullable<GithubClient["queueRemovals"]>>>[number] | null | undefined;
          if (departure) {
            // Only a single removal between the last queued sighting and this observation names the departure. One that falls in either
            // observation's second may belong to another entry, and nothing else tells which, so the departed entry's id is used instead.
            try {
              const found = client.queueRemovals ? await client.queueRemovals(snapshot.repository, snapshot.number, departure.since, snapshot.observedAt) : [];
              const edge = (value: { createdAt: string }) => [departure.since, snapshot.observedAt].some((bound) => bound !== null && wholeSecond(value.createdAt) === wholeSecond(bound));
              removal = found.length === 1 && !edge(found[0]!) ? found[0]! : null;
            } catch {
              removal = null;
            }
            if (!current()) break;
          }
          if (
            !snapshot.coverage.length &&
            snapshot.mergeSha &&
            snapshot.mergeSha === previous.snapshot?.mergeSha
          )
            snapshot.coverage = previous.snapshot.coverage.filter((value) =>
              config.postMergeWorkflows.includes(value.workflow),
            );
          let delivers = false;
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
            delivers = recordPrEvents(db, store.tasks, { projectId, config, snapshot, ...(departure ? { removal } : {}) });
          });
          // Messages go out while the pass reads the next PRs; the drain chain runs one drain at a time.
          if (delivers) void events.drain();
          if (snapshot.state === "open" || snapshot.state === "draft") {
            const latestProject = store.tasks.getProject(projectId);
            if (latestProject && current()) {
              const policy = getWorkflowPolicy(latestProject);
              const statuses = latestProject.statuses ?? DEFAULT_TASK_STATUSES;
              const target = statuses.findIndex((status) => status.id === policy.reviewStatus);
              for (const attached of linksByPr.get(prIdentity(link)) ?? []) {
                if (!current()) break;
                if (prIdentity(attached) !== prIdentity(snapshot) || attached.excluded || !attached.confirmed || attached.role !== "delivers") continue;
                const task = store.tasks.getTask(attached.taskId);
                if (!task || task.projectId !== projectId || task.archivedAt || !policy.earlyStatuses.includes(task.status) ||
                    [policy.bugfixStatus, policy.doneStatus, "canceled"].includes(task.status) ||
                    target < 0 || statuses.findIndex((status) => status.id === task.status) >= target) continue;
                // A card whose plan is not approved stays put while the PR and its other cards are processed.
                if (store.tasks.planGate(task, policy.reviewStatus!)) continue;
                store.tasks.updateTask(task.id, { status: policy.reviewStatus! });
                publishTasksChanged(bb, task.id, projectId);
              }
            }
          }
          const { observedAt: _previousObservedAt, ...oldVisible } = previous.snapshot ?? { observedAt: undefined };
          const { observedAt: _observedAt, ...visible } = snapshot;
          // A stale-to-current refresh is visible even when the facts are identical. Freshness is judged at commit time,
          // and a terminal observation older than one poll renews merged-delivery advisory evidence, which is also visible.
          const committedAt = Date.now(), previousTtl = seen ? observationTtl(seen, config, committedAt) : null;
          // Evidence expires at exactly its TTL (advisories need validUntil > now), so renewal uses >=.
          const renewed = !seen || committedAt - Date.parse(seen.observedAt) >= (previousTtl ?? poll);
          if (previous.error || renewed || JSON.stringify(oldVisible) !== JSON.stringify(visible)) refreshed.add(prIdentity(link));
          if (snapshot.headSha !== previous.snapshot?.headSha || snapshot.baseSha !== previous.snapshot?.baseSha) filesChanged = true;
          checked++;
        } catch (error) {
          if (!current()) break;
          const message = report(link.repository, error);
          // Counted per PR before messages are deduplicated; a permission refusal is not a sync failure.
          if (error instanceof GithubError && [401, 403, 404].includes(error.status)) tolerated++;
          else failures++;
          if (previous.error !== message) refreshed.add(prIdentity(link));
          data.fail(projectId, link, message);
          errors.push(message);
        }
      }
      flush();
      void events.drain();
      return finish();
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<SyncResult>((resolve) => {
      timer = setTimeout(() => {
        run.abort();
        if (!deadlineWarnings.has(projectId) || Date.now() - deadlineWarnings.get(projectId)! >= 3_600_000) {
          deadlineWarnings.set(projectId, Date.now());
          bb.log.warn(`Git sync for project ${projectId} exceeded ${SYNC_DEADLINE_MS / 60_000} min during ${phase}; abandoned`);
        }
        // The cut operation may never resume, so its committed snapshots are published from here, once.
        flush();
        resolve({ checked, errors: [`Git synchronization timed out during ${phase}; retry later`], deferred, failures, tolerated, timedOut: true });
      }, SYNC_DEADLINE_MS);
    });
    const guarded = Promise.race([operation, deadline]).finally(() => clearTimeout(timer));
    pending.set(projectId, guarded);
    try {
      return await guarded;
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
    | "listPrEvents"
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
    setGitSyncConfig({ projectId, config, baseConfig }) {
      requireProject(projectId);
      const canonical = (value: unknown) => JSON.stringify(gitSyncConfigSchema.parse(value));
      const saved = db.transaction(() => {
        if (baseConfig && canonical(data.config(projectId)) !== canonical(baseConfig)) throw new Error(STALE_GIT_CONFIG);
        return data.setConfig(projectId, gitSyncConfigSchema.parse(config));
      })();
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
              observationStale(cached.snapshot.observedAt, observationTtl(cached.snapshot, config, Date.now()), Date.now()),
          };
        }),
      };
    },
    async linkPr({ taskId, url, role, part }) {
      const db = bb.storage.database(), trigger = `pr:${prIdentity(parsePrUrl(url))}`;
      const known = hasPlanDebtEvent(db, taskId, trigger);
      const link = remember(taskId, url, "manual", { role, part });
      if (known || !hasPlanDebtEvent(db, taskId, trigger)) return { link };
      await planDebtService(bb, store.tasks).drain();
      return { link, note: "Plan debt: this card works without an approved plan; a reminder for its executors was recorded." };
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
    listPrEvents({ taskId, limit }) {
      requireTask(taskId);
      return { events: events.list(taskId, limit) };
    },
    async syncGit({ projectId }) {
      const { checked, errors, deferred } = await syncProject(projectId, true);
      return { checked, errors: deferred ? [...errors, `${deferred} PRs deferred to the next pass`] : errors };
    },
  };
  const sweeping = new Map<string, Promise<void>>();
  let prunedAt = 0;
  /** One post-merge wait sweep per project at a time; the projects not already sweeping share one SWEEP_BUDGET_MS budget. */
  const sweep = (projectIds: string[]) => {
    const claimed = projectIds.filter((projectId) => !sweeping.has(projectId));
    if (claimed.length) {
      const budget = new AbortController();
      const timer = setTimeout(() => budget.abort(), SWEEP_BUDGET_MS);
      const running: Promise<void> = events.sweep(claimed, clientOverride ?? github.withSignal(budget.signal), budget.signal, Date.now() + SWEEP_BUDGET_MS)
        .then(({ advanced, remaining }) => {
          if (advanced || remaining) bb.log.info(`PR event sweep advanced ${advanced} deployment waits${remaining ? ` and stopped at its budget with ${remaining} left for the next run` : ""}`);
        })
        .catch((error: unknown) => bb.log.warn(`PR event sweep for ${claimed.join(", ")} failed: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => {
          clearTimeout(timer);
          for (const projectId of claimed) if (sweeping.get(projectId) === running) sweeping.delete(projectId);
        });
      for (const projectId of claimed) sweeping.set(projectId, running);
    }
    return Promise.all(new Set(projectIds.map((projectId) => sweeping.get(projectId)))).then(() => {});
  };
  const enabledProjects = () => store.tasks.listProjects().map((project) => project.id).filter((projectId) => data.config(projectId).enabled);
  return {
    handlers,
    remember,
    syncProject,
    sweep,
    events,
    /** Startup: deliver what a restart left behind and settle waits whose deadline passed while the plugin was down. */
    async startEvents() {
      await events.drain();
      await sweep(enabledProjects());
      await events.drain();
    },
    /** Deferral is load management and stays ok; a hard timeout or failed GitHub requests fail the scheduled run. */
    async runDue() {
      const problems: string[] = [];
      // PRs are refreshed first, so a slow post-merge sweep never delays open work.
      for (const projectId of enabledProjects()) {
        // An earlier project's refresh may have taken long enough for this one to be turned off.
        if (!data.config(projectId).enabled || !data.due(projectId)) continue;
        const outcome = await syncProject(projectId);
        if (outcome.deferred) bb.log.info(`Git sync for project ${projectId} checked ${outcome.checked} PRs and deferred ${outcome.deferred} to the next pass`);
        if (outcome.tolerated) bb.log.warn(`Git sync for project ${projectId} tolerated ${outcome.tolerated} optional lookup or permission failures`);
        if (outcome.timedOut) problems.push(`project ${projectId}: ${outcome.errors[0]} (${outcome.checked} PRs checked)`);
        else if (outcome.failures) problems.push(`project ${projectId}: ${outcome.failures} GitHub request failures (${outcome.checked} PRs checked)`);
      }
      // Waits keep their own due times, so forced syncs that push a project's due time back never hold them.
      await sweep(enabledProjects());
      // Pruning scans the links of every recorded PR, so it runs hourly, not on every pass.
      if (Date.now() - prunedAt >= 3_600_000) { prunedAt = Date.now(); events.prune(); }
      await events.drain();
      if (problems.length) throw new Error(`Git sync incomplete: ${problems.join("; ")}`);
    },
  };
}
