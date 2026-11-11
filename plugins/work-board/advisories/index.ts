import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TasksApiStore } from "../api";
import type { DependencyTask, TaskThread } from "../shared/contract";
import type { TaskActivity } from "../shared/task-activity";
import type { TaskAdvisory } from "../shared/task-advisories";
import { createGitSyncStore } from "../git-sync/store";
import { prLinkSchema, prSnapshotSchema } from "../shared/git-sync";

const deliverySnapshot = prSnapshotSchema.pick({ repository: true, number: true, url: true, state: true, mergeSha: true, mergedAt: true, observedAt: true });

export function taskAdvisories(bb: BbPluginApi, tasks: ReturnType<TasksApiStore["tasks"]["listTaskActivity"]>, blockers: Map<string, DependencyTask[]>, activities: Map<string, TaskActivity>, threads: Map<string, TaskThread[]>) {
  const now = Date.now(), db = bb.storage.database(), git = createGitSyncStore(db);
  const results = new Map<string, TaskAdvisory[]>();
  const merged = new Map<string, Extract<TaskAdvisory, { kind: "merged-predecessor" }>[]>();
  const predecessors = [...new Set([...blockers.values()].flatMap(rows => rows.map(row => row.id)))];
  const configs = new Map<string, ReturnType<typeof git.config>>();
  // Project only delivery evidence in bounded batches: never load PR file/check buffers or poll GitHub to render cards.
  for (let offset = 0; offset < predecessors.length; offset += 500) {
    const ids = predecessors.slice(offset, offset + 500);
    const rows = db.prepare<string[], { id: string; key: string; title: string; status: string; projectId: string; link: string; snapshot: string; error: string | null }>(`SELECT t.id, p.prefix || '-' || t.number AS key, t.title, t.status, t.project_id AS projectId, l.payload AS link,
      json_object('repository', json_extract(s.payload, '$.repository'), 'number', json_extract(s.payload, '$.number'),
        'url', json_extract(s.payload, '$.url'), 'state', json_extract(s.payload, '$.state'),
        'mergeSha', json_extract(s.payload, '$.mergeSha'), 'mergedAt', json_extract(s.payload, '$.mergedAt'),
        'observedAt', json_extract(s.payload, '$.observedAt')) AS snapshot, s.error
      FROM tasks t JOIN projects p ON p.id=t.project_id JOIN task_pr_links l ON l.task_id=t.id
      JOIN git_pr_snapshots s ON s.project_id=t.project_id AND s.identity=l.identity
      WHERE t.id IN (${ids.map(() => "?").join(",")}) AND t.status <> 'done' AND s.payload IS NOT NULL
        AND json_extract(l.payload, '$.role')='delivers' AND json_extract(l.payload, '$.confirmed')=1
        AND COALESCE(json_extract(l.payload, '$.excluded'), 0)=0 AND json_extract(s.payload, '$.state')='merged'
      ORDER BY t.id, l.identity`).all(...ids);
    for (const row of rows) {
      const link = prLinkSchema.parse(JSON.parse(row.link)), snapshot = deliverySnapshot.parse(JSON.parse(row.snapshot));
      let config = configs.get(row.projectId);
      if (!config) { config = git.config(row.projectId); configs.set(row.projectId, config); }
      const observed = Date.parse(snapshot.observedAt), validUntil = observed + config.pollMinutes * 60_000;
      // Suggestions, unrelated/design PRs and stale/error snapshots never establish delivery evidence.
      if (!config.enabled || !config.repositories.includes(link.repository) || link.excluded || !link.confirmed || link.role !== "delivers" || row.error || snapshot.state !== "merged" || !/^[a-f0-9]{40}$/i.test(snapshot.mergeSha ?? "") || !Number.isFinite(Date.parse(snapshot.mergedAt ?? "")) || observed > now || !(validUntil > now)) continue;
      const group = merged.get(row.id) ?? [];
      group.push({ kind: "merged-predecessor", predecessor: { id: row.id, key: row.key, title: row.title, status: row.status }, pr: { url: snapshot.url, repository: snapshot.repository, number: snapshot.number, mergeSha: snapshot.mergeSha!, mergedAt: new Date(snapshot.mergedAt!).toISOString() }, checkedAt: snapshot.observedAt, validUntil: new Date(validUntil).toISOString() });
      merged.set(row.id, group);
    }
  }
  for (const [id, task] of tasks) {
    const warnings: TaskAdvisory[] = (blockers.get(id) ?? []).flatMap(predecessor => merged.get(predecessor.id) ?? []);
    const activity = activities.get(id), checked = Date.parse(activity?.diagnostics?.checkedAt ?? "");
    if (task.executionTarget === "agent" && task.status === "in_progress" && activity?.diagnostics?.complete && activity.attachedCount === 0 && checked <= now && now - checked < 60_000) {
      const last = [...(threads.get(id) ?? [])].sort((a, b) => b.attachedAt.localeCompare(a.attachedAt) || b.id.localeCompare(a.id))[0];
      warnings.push({ kind: "no-live-session", checkedAt: activity.diagnostics.checkedAt, validUntil: new Date(checked + 60_000).toISOString(), lastActivityAt: task.lastActivityAt, lastAttachment: last ? { threadId: last.threadId, title: last.title, attachedAt: last.attachedAt, updatedAt: last.updatedAt } : null });
    }
    results.set(id, warnings);
  }
  return results;
}
