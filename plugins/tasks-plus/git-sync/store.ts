import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { assertNoSecretsInValue } from "../shared/secret-guard";
import {
  gitSyncConfigSchema,
  prLinkSchema,
  prSnapshotSchema,
  prIdentity,
  type GitSyncConfig,
  type PrLink,
  type PrSnapshot,
} from "../shared/git-sync";

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
  return {
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
      for (const current of links().filter(
        (item) =>
          prIdentity(item) === prIdentity(link) &&
          Boolean(
            db
              .prepare<
                [string, string],
                { found: number }
              >("SELECT 1 AS found FROM tasks WHERE id=? AND project_id=?")
              .get(item.taskId, projectId),
          ),
      )) {
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
