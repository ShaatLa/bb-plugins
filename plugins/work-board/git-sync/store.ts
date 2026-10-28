import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { assertNoSecretsInValue } from "../shared/secret-guard";
import {
  gitSyncConfigSchema,
  prLinkSchema,
  prSnapshotSchema,
  prIdentity,
  type GitSyncConfig,
  type PrLink,
  type Overlap,
  type PrSnapshot,
} from "../shared/git-sync";

import { evaluateOverlaps } from "./overlap";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;
export function createGitSyncStore(db: Database) {
  const config = (projectId: string): GitSyncConfig => {
    const row = db
      .prepare<
        [string],
        { payload: string }
      >("SELECT payload FROM git_sync_projects WHERE project_id = ?")
      .get(projectId);
    return gitSyncConfigSchema.parse(row ? JSON.parse(row.payload) : {});
  };
  const links = (taskId?: string): PrLink[] =>
    db
      .prepare<string[], { payload: string }>(
        `SELECT payload FROM task_pr_links ${taskId ? "WHERE task_id = ?" : ""} ORDER BY task_id, identity`,
      )
      .all(...(taskId ? [taskId] : []))
      .map((row) => prLinkSchema.parse(JSON.parse(row.payload)));
  const saveLink = (value: PrLink) => {
    const link = prLinkSchema.parse(value);
    assertNoSecretsInValue(link, "PR link");
    db.prepare<[string, string, string]>(
      "INSERT INTO task_pr_links(task_id, identity, payload) VALUES (?, ?, ?) ON CONFLICT(task_id, identity) DO UPDATE SET payload=excluded.payload",
    ).run(link.taskId, prIdentity(link), JSON.stringify(link));
    return link;
  };
  // One project scan per call, not per task: board summaries arrive in batches of hundreds.
  function overlapsForTasks(taskIds: readonly string[]) {
    const result = new Map<string, Overlap[]>();
    const byProject = new Map<string, string[]>();
    for (const taskId of new Set(taskIds)) {
      const task = db.prepare<[string], { projectId: string }>("SELECT project_id AS projectId FROM tasks WHERE id=?").get(taskId);
      if (task) byProject.set(task.projectId, [...(byProject.get(task.projectId) ?? []), taskId]);
    }
    for (const [projectId, ids] of byProject) {
      const projectConfig = config(projectId);
      const rows = db.prepare<[string], { taskId: string; taskKey: string; link: string; snapshot: string }>(`SELECT t.id AS taskId, p.prefix || '-' || t.number AS taskKey, l.payload AS link, s.payload AS snapshot FROM task_pr_links l JOIN tasks t ON t.id=l.task_id JOIN projects p ON p.id=t.project_id JOIN git_pr_snapshots s ON s.project_id=t.project_id AND s.identity=l.identity WHERE t.project_id=? AND s.payload IS NOT NULL AND COALESCE(json_extract(l.payload, '$.excluded'), 0)=0 AND json_extract(s.payload, '$.state') IN ('open', 'draft') AND json_extract(s.payload, '$.files') IS NOT NULL`).all(projectId);
      const entries = rows.map(row => ({ ...row, link: prLinkSchema.parse(JSON.parse(row.link)), snapshot: prSnapshotSchema.parse(JSON.parse(row.snapshot)) })).filter(row => projectConfig.repositories.includes(row.link.repository));
      const withPrs = new Set(entries.map(entry => entry.taskId));
      for (const taskId of ids) result.set(taskId, withPrs.has(taskId) ? evaluateOverlaps(entries, taskId, projectConfig.overlapRules ?? []) : []);
    }
    return result;
  }
  return {
    overlaps(taskId: string) {
      return overlapsForTasks([taskId]).get(taskId) ?? [];
    },
    overlapsForTasks,
    summaries(taskIds: string[]) {
      if (!taskIds.length) return [];
      const rows = db.prepare<string[], {
        taskId: string; projectId: string; repository: string; state: string | null;
        ci: string | null; observedAt: string | null; error: string | null;
      }>(`SELECT l.task_id AS taskId, t.project_id AS projectId,
        json_extract(l.payload, '$.repository') AS repository,
        json_extract(s.payload, '$.state') AS state,
        json_extract(s.payload, '$.ci') AS ci,
        json_extract(s.payload, '$.observedAt') AS observedAt, s.error
        FROM task_pr_links l JOIN tasks t ON t.id=l.task_id
        LEFT JOIN git_pr_snapshots s ON s.project_id=t.project_id AND s.identity=l.identity
        WHERE l.task_id IN (${taskIds.map(() => "?").join(",")})
        AND COALESCE(json_extract(l.payload, '$.excluded'), 0)=0`).all(...taskIds);
      const configs = new Map<string, GitSyncConfig>();
      const summaries = new Map<string, { taskId: string; total: number; merged: number; failing: number; pending: number; stale: boolean }>();
      const now = Date.now();
      for (const row of rows) {
        let settings = configs.get(row.projectId);
        if (!settings) { settings = config(row.projectId); configs.set(row.projectId, settings); }
        const summary = summaries.get(row.taskId) ?? { taskId: row.taskId, total: 0, merged: 0, failing: 0, pending: 0, stale: false };
        summary.total++;
        if (row.state === "merged") summary.merged++;
        if (row.ci === "failing") summary.failing++;
        if (row.ci === "pending") summary.pending++;
        summary.stale ||= !row.observedAt || Boolean(row.error) || !settings.repositories.includes(row.repository)
          || now - Date.parse(row.observedAt) > settings.pollMinutes * 60_000;
        summaries.set(row.taskId, summary);
      }
      return [...new Set(taskIds)].flatMap((id) => summaries.has(id) ? [summaries.get(id)!] : []);
    },
    linksForProject(projectId: string): PrLink[] {
      return db.prepare<[string], { payload: string }>(
        "SELECT l.payload FROM task_pr_links l JOIN tasks t ON t.id=l.task_id WHERE t.project_id=? ORDER BY l.task_id, l.identity",
      ).all(projectId).map((row) => prLinkSchema.parse(JSON.parse(row.payload)));
    },
    config,
    links,
    saveLink,
    setConfig(projectId: string, value: GitSyncConfig) {
      const parsed = gitSyncConfigSchema.parse(value);
      assertNoSecretsInValue(parsed, "Git sync configuration");
      db.prepare<[string, string]>(
        "INSERT INTO git_sync_projects(project_id, payload) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET payload=excluded.payload, last_attempt_at=NULL",
      ).run(projectId, JSON.stringify(parsed));
      return parsed;
    },
    due(projectId: string) {
      const row = db
        .prepare<
          [string],
          { last_attempt_at: number | null }
        >("SELECT last_attempt_at FROM git_sync_projects WHERE project_id = ?")
        .get(projectId);
      return (
        !row?.last_attempt_at ||
        Date.now() - row.last_attempt_at >=
          config(projectId).pollMinutes * 60_000
      );
    },
    attempted(projectId: string) {
      db.prepare<[number, string]>(
        "UPDATE git_sync_projects SET last_attempt_at=? WHERE project_id=?",
      ).run(Date.now(), projectId);
    },
    snapshot(projectId: string, link: Pick<PrLink, "repository" | "number">) {
      const row = db
        .prepare<
          [string, string],
          { payload: string | null; error: string | null }
        >("SELECT payload, error FROM git_pr_snapshots WHERE project_id=? AND identity=?")
        .get(projectId, prIdentity(link));
      return {
        snapshot: row?.payload
          ? prSnapshotSchema.parse(JSON.parse(row.payload))
          : null,
        error: row?.error ?? null,
      };
    },
    saveSnapshot(
      projectId: string,
      link: Pick<PrLink, "repository" | "number">,
      snapshot: PrSnapshot,
    ) {
      const value = prSnapshotSchema.parse(snapshot);
      db.prepare<[string, string, string]>(
        "INSERT INTO git_pr_snapshots(project_id, identity, payload, error) VALUES (?, ?, ?, NULL) ON CONFLICT(project_id, identity) DO UPDATE SET payload=excluded.payload, error=NULL",
      ).run(projectId, prIdentity(link), JSON.stringify(value));
      // A repository rename is a durable identity update, not a new delivery link.
      const linked = db.prepare<[string, string], { payload: string }>(
        "SELECT l.payload FROM task_pr_links l JOIN tasks t ON t.id=l.task_id WHERE t.project_id=? AND l.identity=?",
      ).all(projectId, prIdentity(link));
      for (const row of linked) {
        const current = prLinkSchema.parse(JSON.parse(row.payload));
        const next = {
          ...current,
          repository: value.repository,
          number: value.number,
          url: value.url,
          remoteId: value.remoteId,
        };
        if (JSON.stringify(next) === JSON.stringify(current)) continue;
        const canonical = links(current.taskId).find(
          (item) => prIdentity(item) === prIdentity(next),
        );
        if (canonical && prIdentity(next) !== prIdentity(current)) {
          saveLink({
            ...next,
            ...canonical,
            excluded: next.excluded || canonical.excluded,
          });
        } else saveLink(next);
        if (prIdentity(next) !== prIdentity(current))
          db.prepare<[string, string]>(
            "DELETE FROM task_pr_links WHERE task_id=? AND identity=?",
          ).run(current.taskId, prIdentity(current));
      }
      if (prIdentity(link) !== prIdentity(value))
        db.prepare<[string, string, string]>(
          "INSERT INTO git_pr_snapshots(project_id, identity, payload, error) VALUES (?, ?, ?, NULL) ON CONFLICT(project_id, identity) DO UPDATE SET payload=excluded.payload, error=NULL",
        ).run(projectId, prIdentity(value), JSON.stringify(value));
    },
    fail(
      projectId: string,
      link: Pick<PrLink, "repository" | "number">,
      error: string,
    ) {
      db.prepare<[string, string, string]>(
        "INSERT INTO git_pr_snapshots(project_id, identity, payload, error) VALUES (?, ?, NULL, ?) ON CONFLICT(project_id, identity) DO UPDATE SET error=excluded.error",
      ).run(projectId, prIdentity(link), error);
    },
  };
}
