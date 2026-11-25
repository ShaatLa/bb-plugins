import type { BbPluginApi } from "@get-bb/plugin-sdk";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

/** Authors of a PR: the bb threads attached to a card whose environment's PR it is. Rows are only ever added, so they outlive the worktree. */
export function recordPrAuthors(db: Database, projectId: string, identity: string, threadIds: Iterable<string>): void {
  const insert = db.prepare<[string, string, string, string]>(
    "INSERT OR IGNORE INTO pr_author_threads(project_id, identity, thread_id, first_seen_at) VALUES (?, ?, ?, ?)");
  const at = new Date().toISOString();
  for (const threadId of new Set(threadIds)) insert.run(projectId, identity, threadId, at);
}

export function recordedPrAuthors(db: Database, projectId: string, identity: string): string[] {
  return db.prepare<[string, string], { thread_id: string }>(
    "SELECT thread_id FROM pr_author_threads WHERE project_id=? AND identity=? ORDER BY first_seen_at, thread_id",
  ).all(projectId, identity).map((row) => row.thread_id);
}
