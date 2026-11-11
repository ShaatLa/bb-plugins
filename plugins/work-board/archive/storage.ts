import { createGitSyncStore } from "../git-sync/store";
import { prIdentity } from "../shared/git-sync";
import { DEFAULT_TASK_STATUSES } from "../shared/statuses.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TasksApiStore } from "../api";
import { readAttachmentContent } from "../attachments";
import { createHash } from "node:crypto";
import {
  assertNoSecrets,
  assertNoSecretsInValue,
} from "../shared/secret-guard.js";
import { createStructuredStore } from "../structured/store";
import { scheduleRunSchema, scheduleSchema, scheduleSourceSchema, type ScheduleRun } from "../shared/scheduled";
import {
  archiveProjectSchema,
  archiveTaskSchema,
  validateArchive,
  type ArchiveTask,
  type ProjectArchive,
} from "./contract";

// Imported history is never operational: server-local thread/queue/request IDs must not be resumed on another BB.
export const historicalRun = (run: ScheduleRun): ScheduleRun => ({ ...run, threadId: null, queueId: null, requestId: null, historical: true });
type SqlValue = string | number | null;
type Row = Record<string, SqlValue>;
export const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

const withoutVisibility = <T extends { ordinaryVisible?: boolean; scheduledRole?: string }>({ ordinaryVisible: _derived, scheduledRole: _role, ...task }: T) => task;

export function captureProject(
  bb: BbPluginApi,
  store: TasksApiStore,
  projectId: string,
) {
  return store.transaction(() => {
    const structured = createStructuredStore(bb, store);
    const project = store.tasks.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const folders = [];
    let folderId = project.folderId;
    while (folderId) {
      const folder = store.tasks.getFolder(folderId);
      if (!folder) throw new Error(`Folder not found: ${folderId}`);
      folders.unshift(folder);
      folderId = folder.parentFolderId;
    }
    const tasks = store.tasks
      .listTasks({ projectId })
      .sort((a, b) => a.id.localeCompare(b.id));
    // Constant statements: three batch reads cover every schedule table (sources/results may outlive schedules).
    const scheduleDb = bb.storage.database();
    const scheduleRows = scheduleDb.prepare<[string], { id: string; template_task_id: string; title: string; rule: string; created_at: string; updated_at: string }>(
      "SELECT s.id, s.template_task_id, t.title, s.rule, s.created_at, s.updated_at FROM task_schedules s JOIN tasks t ON t.id=s.template_task_id WHERE s.project_id=? ORDER BY s.id",
    ).all(projectId);
    const sourceRows = scheduleDb.prepare<[string], { task_id: string; schedule_id: string; schedule_title: string; role: string; scheduled_for: string | null; started_at: string | null; run_id: string | null; occurrence_key: string | null }>(
      "SELECT ss.* FROM task_scheduled_sources ss JOIN tasks t ON t.id=ss.task_id WHERE t.project_id=? ORDER BY ss.task_id",
    ).all(projectId);
    const runRows = scheduleDb.prepare<[string], { payload: string }>("SELECT payload FROM task_schedule_runs WHERE project_id=? ORDER BY id").all(projectId);
    const taskIdSet = new Set(tasks.map(task => task.id));
    const manifest = archiveProjectSchema.parse({
      format: "bb-work-board",
      version: 15,
      gitSync: createGitSyncStore(bb.storage.database()).config(projectId),
      project,
      folders,
      labels: store.tasks
        .listLabels(projectId)
        .sort((a, b) => a.id.localeCompare(b.id)),
      taskIds: tasks.map((task) => task.id),
      templates: structured.listTemplates(projectId),
      // Portable definitions only: paused, unassigned and never scheduled, so a restore cannot reactivate old targets.
      schedules: scheduleRows.map(row => scheduleSchema.parse({
        id: row.id, projectId, templateTaskId: row.template_task_id, title: row.title, rule: JSON.parse(row.rule),
        target: { kind: "unassigned" }, enabled: false, nextDueAt: null, createdAt: row.created_at, updatedAt: row.updated_at, overlapRunIds: [],
      })),
      scheduleSources: sourceRows.map(row => scheduleSourceSchema.parse({
        taskId: row.task_id, scheduleId: row.schedule_id, scheduleTitle: row.schedule_title, role: row.role,
        scheduledFor: row.scheduled_for, startedAt: row.started_at, runId: row.run_id, occurrenceKey: row.occurrence_key,
      })),
      scheduleRuns: runRows.map(row => {
        const run = historicalRun(scheduleRunSchema.parse(JSON.parse(row.payload)));
        // A run may outlive its result task; the dangling link is not portable.
        return { ...run, taskId: run.taskId && taskIdSet.has(run.taskId) ? run.taskId : null };
      }),
    });
    // Resource invariant: every related table is read once per project (constant statement count),
    // grouped in memory; statements must not scale with task or comment count.
    const db = bb.storage.database();
    const group = <T>(items: T[], owner: (item: T) => string) => {
      const byOwner = new Map<string, T[]>();
      for (const item of items) {
        const list = byOwner.get(owner(item)) ?? [];
        list.push(item);
        byOwner.set(owner(item), list);
      }
      return byOwner;
    };
    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    const commentsByTask = group(store.tasks.listCommentsForProject(projectId), (c) => c.taskId);
    const commentTask = new Map<string, string>();
    for (const [taskId, list] of commentsByTask)
      for (const comment of list) commentTask.set(comment.id, taskId);
    const attachmentsByTask = group(
      store.tasks.listAttachmentsForProject(projectId),
      (a) => (a.taskId ?? commentTask.get(a.commentId!))!,
    );
    const labelsByTask = group(store.tasks.listTaskLabelsForProject(projectId), (l) => l.taskId);
    const threadsByTask = group(store.tasks.listTaskThreadsForProject(projectId), (t) => t.taskId);
    const questionsByTask = structured.listQuestionsForProject(projectId);
    const linksByTask = group(createGitSyncStore(db).linksForProject(projectId), (l) => l.taskId);
    const dependenciesByTask = group(db.prepare<[string], { taskId: string; blockingTaskId: string }>(`
      SELECT d.task_id AS taskId, d.blocking_task_id AS blockingTaskId
      FROM task_dependencies d JOIN tasks t ON t.id=d.task_id
      WHERE t.project_id=? ORDER BY d.blocking_task_id
    `).all(projectId), row => row.taskId);
    const relatedByTask = group(db.prepare<[string], { taskId: string; relatedTaskId: string }>(`
      SELECT r.task_id AS taskId, r.related_task_id AS relatedTaskId
      FROM task_relations r JOIN tasks t ON t.id=r.task_id
      WHERE t.project_id=? ORDER BY r.related_task_id
    `).all(projectId), row => row.taskId);
    const aliasesByTask = group(
      db
        .prepare<[string], { task_id: string; prefix: string; number: number }>(
          "SELECT a.task_id, a.prefix, a.number FROM task_key_aliases a JOIN tasks t ON t.id = a.task_id WHERE t.project_id = ? ORDER BY a.prefix, a.number",
        )
        .all(projectId),
      (a) => a.task_id,
    );
    const historyTasks = new Set(
      db
        .prepare<[string], { task_id: string }>(
          "SELECT h.task_id FROM task_activity_history h JOIN tasks t ON t.id = h.task_id WHERE t.project_id = ?",
        )
        .all(projectId)
        .map((row) => row.task_id),
    );
    const records = tasks.map((task) => ({
      activityHistory: historyTasks.has(task.id),
      dependencies: (dependenciesByTask.get(task.id) ?? []).map(row => row.blockingTaskId),
      related: (relatedByTask.get(task.id) ?? []).map(row => row.relatedTaskId),
      pullRequests: linksByTask.get(task.id) ?? [],
      // ordinaryVisible is derived from scheduled sources, not task data.
      task: {
        ...withoutVisibility(task),
        labelIds: (labelsByTask.get(task.id) ?? []).map((link) => link.labelId).sort(),
      },
      comments: [...(commentsByTask.get(task.id) ?? [])].sort(byId),
      questions: questionsByTask.get(task.id) ?? [],
      attachments: [...(attachmentsByTask.get(task.id) ?? [])].sort(byId),
      threads: [...(threadsByTask.get(task.id) ?? [])].sort(byId),
      aliases: (aliasesByTask.get(task.id) ?? []).map(({ prefix, number }) => ({ prefix, number })),
    }));
    return { manifest, records };
  });
}

export async function archiveRecords(
  store: TasksApiStore,
  capture: ReturnType<typeof captureProject>,
  writeBlob: (id: string, bytes: Buffer) => Promise<void>,
): Promise<ArchiveTask[]> {
  const records: ArchiveTask[] = [];
  for (const record of capture.records) {
    const attachments = [];
    for (const stored of record.attachments) {
      const { attachment, content } = await readAttachmentContent(
        store.tasks,
        stored.id,
      );
      if (attachment.blobPath !== stored.blobPath)
        throw new Error(
          `Attachment changed during export: ${stored.id}; retry`,
        );
      if (content.length !== stored.sizeBytes)
        throw new Error(`Attachment size mismatch: ${stored.id}`);
      const { blobPath: _blobPath, ...metadata } = stored;
      attachments.push({ ...metadata, sha256: sha256(content) });
      await writeBlob(stored.id, content);
    }
    records.push(archiveTaskSchema.parse({ ...record, attachments }));
  }
  return records;
}

function dbRow(value: object): Row {
  return Object.fromEntries(
    Object.entries(value).map(([key, value]) => [
      key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      key === "statuses" || key === "workflowPolicy"
        ? JSON.stringify(value)
        : typeof value === "boolean"
          ? Number(value)
          : value,
    ]),
  );
}

export function restoreProject(
  bb: BbPluginApi,
  store: TasksApiStore,
  archive: ProjectArchive,
  blobs: Map<
    string,
    { path: string; previousPath: string | null; previousHash: string | null }
  >,
  overwrite: boolean,
): void {
  validateArchive(archive);
  for (const record of archive.records) {
    assertNoSecrets(record.task.title, "title");
    assertNoSecrets(record.task.description, "description");
    for (const comment of record.comments)
      assertNoSecrets(comment.body, "comment body");
    for (const comment of record.comments)
      if (comment.evidence)
        assertNoSecretsInValue(comment.evidence, "evidence");
    for (const question of record.questions)
      assertNoSecretsInValue(question, "question");
  }
  for (const template of archive.manifest.templates) {
    assertNoSecrets(template.name, "template name");
    assertNoSecrets(template.body, "template body");
  }
  if (archive.manifest.project.statuses)
    assertNoSecretsInValue(archive.manifest.project.statuses, "statuses");
  if (archive.manifest.gitSync) assertNoSecretsInValue(archive.manifest.gitSync, "Git sync configuration");
  for (const record of archive.records) for (const link of record.pullRequests ?? []) assertNoSecretsInValue(link, "PR link");
  for (const source of archive.manifest.scheduleSources) assertNoSecrets(source.scheduleTitle, "schedule title");
  for (const run of archive.manifest.scheduleRuns) assertNoSecretsInValue(run, "schedule run");
  const db = bb.storage.database();
  const { manifest, records } = archive;
  const projectId = manifest.project.id;
  store.transaction(() => {
    const localTaskIds = new Set(db.prepare<[string], { id: string }>("SELECT id FROM tasks WHERE project_id=?").all(projectId).map(row => row.id));
    const localDependencies = new Map<string, string[]>();
    for (const row of db.prepare<[string], { taskId: string; blockingTaskId: string }>(`
      SELECT d.task_id AS taskId, d.blocking_task_id AS blockingTaskId FROM task_dependencies d
      JOIN tasks t ON t.id=d.task_id WHERE t.project_id=? ORDER BY d.blocking_task_id
    `).all(projectId)) {
      const group = localDependencies.get(row.taskId) ?? [];
      group.push(row.blockingTaskId);
      localDependencies.set(row.taskId, group);
    }
    for (const record of records) if (record.dependencies && localTaskIds.has(record.task.id)) {
      const current = localDependencies.get(record.task.id) ?? [];
      if (!overwrite && JSON.stringify(current) !== JSON.stringify([...record.dependencies].sort()))
        throw new Error(`Import conflict: dependencies ${record.task.key}; use --overwrite`);
    }
    // Archives before v15 cannot carry relations, so they leave local relations untouched.
    const relatedOf = (record: (typeof records)[number]) => (manifest.version >= 15 ? record.related : undefined);
    for (const record of records) if (relatedOf(record) && localTaskIds.has(record.task.id) && !overwrite) {
      const current = db.prepare<[string], { id: string }>("SELECT related_task_id AS id FROM task_relations WHERE task_id=? ORDER BY related_task_id").all(record.task.id).map(row => row.id);
      if (JSON.stringify(current) !== JSON.stringify([...relatedOf(record)!].sort()))
        throw new Error(`Import conflict: related tasks ${record.task.key}; use --overwrite`);
    }
    const changes: Array<{ table: string; row: Row; keys: string[] }> = [];
    const plan = (
      table: string,
      row: Row,
      keys = ["id"],
      immutable: string[] = [],
    ) => {
      const current = db
        .prepare<
          SqlValue[],
          Row
        >(`SELECT * FROM ${table} WHERE ${keys.map((key) => `${key} = ?`).join(" AND ")}`)
        .get(...keys.map((key) => row[key]!));
      if (current) {
        if (immutable.some((key) => current[key] !== row[key]))
          throw new Error(`ID belongs to another owner: ${table} ${row.id}`);
        if (
          table === "comments" &&
          (current.evidence || row.evidence) &&
          Object.keys(row).some(
            (key) => key !== "notified_count" && current[key] !== row[key],
          )
        )
          throw new Error(
            "Evidence comments are append-only; add a newer record instead",
          );
        if (table === "projects" && current.statuses == null)
          current.statuses = JSON.stringify(DEFAULT_TASK_STATUSES);
        const differs = Object.keys(row).some(
          (key) => current[key] !== row[key],
        );
        if (!differs) return;
        if (
          !overwrite &&
          Object.keys(row).some(
            (key) =>
              !(table === "projects" && key === "next_task_number") &&
              current[key] !== row[key],
          )
        )
          throw new Error(
            `Import conflict: ${table} ${row.id ?? keys.map((key) => row[key]).join("/")}; use --overwrite to replace this record`,
          );
      }
      changes.push({ table, row, keys });
    };
    for (const folder of manifest.folders) plan("folders", dbRow(folder));
    const currentProject = store.tasks.getProject(projectId);
    const maxNumber = [
      ...store.tasks.listTasks({ projectId }),
      ...records.map((r) => r.task),
    ].reduce((max, task) => Math.max(max, task.number), 0);
    if (!Number.isSafeInteger(maxNumber + 1))
      throw new Error("Task number exceeds the supported range");
    const project = {
      ...manifest.project,
      statuses: manifest.project.statuses ?? DEFAULT_TASK_STATUSES,
      nextTaskNumber: Math.max(
        manifest.project.nextTaskNumber,
        currentProject?.nextTaskNumber ?? 1,
        maxNumber + 1,
      ),
    };
    plan("projects", dbRow(project), ["id"]);
    const labels = new Map(
      store.tasks.listLabels(projectId).map((label) => [label.id, label]),
    );
    if (manifest.gitSync) plan("git_sync_projects", { project_id: projectId, payload: JSON.stringify(manifest.gitSync) }, ["project_id"]);
    for (const record of records) for (const link of record.pullRequests ?? []) plan("task_pr_links", { task_id: record.task.id, identity: prIdentity(link), payload: JSON.stringify(link) }, ["task_id", "identity"]);
    for (const label of manifest.labels) {
      plan("labels", dbRow(label), ["id"], ["project_id"]);
      labels.set(label.id, label);
    }
    for (const template of manifest.templates)
      plan("description_templates", dbRow(template), ["id"], ["project_id"]);
    const merged = new Map(
      store.tasks.listTasks({ projectId }).map((task) => [task.id, task]),
    );
    for (const record of records) merged.set(record.task.id, record.task);
    const numbers = new Set<number>();
    for (const task of merged.values()) {
      if (!project.statuses.some((status) => status.id === task.status))
        throw new Error(
          "Imported workflow removes a status used by retained tasks",
        );
      if (numbers.has(task.number))
        throw new Error(`Duplicate task number: ${task.number}`);
      numbers.add(task.number);
      const parent = task.parentTaskId ? merged.get(task.parentTaskId) : null;
      const epic = task.epicId ? merged.get(task.epicId) : null;
      if (task.type === "epic" && (task.parentTaskId || task.epicId))
        throw new Error(`Epic cannot have a parent: ${task.id}`);
      if (
        task.parentTaskId &&
        (!parent ||
          parent.id === task.id ||
          parent.type === "epic" ||
          parent.parentTaskId !== null)
      )
        throw new Error(`Invalid sub-task parent: ${task.id}`);
      if (task.epicId && (!epic || epic.type !== "epic" || task.parentTaskId))
        throw new Error(`Invalid epic link: ${task.id}`);
    }
    for (const record of records) {
      const { key: _key, labelIds, ordinaryVisible: _derived, ...task } = record.task;
      if (labelIds.some((id) => !labels.has(id)))
        throw new Error(`Unknown task label: ${task.id}`);
      const current = store.tasks.getTask(task.id);
      const currentLabels = store.tasks
        .listTaskLabels(task.id)
        .map((link) => link.labelId)
        .sort();
      if (
        current &&
        !overwrite &&
        JSON.stringify(currentLabels) !== JSON.stringify([...labelIds].sort())
      )
        throw new Error(
          `Import conflict: task labels ${task.id}; use --overwrite`,
        );
      plan("tasks", dbRow({ ...task, archivedAt: task.archivedAt ?? null }), ["id"], ["project_id"]);
      for (const comment of record.comments)
        plan(
          "comments",
          dbRow({
            ...comment,
            evidence: comment.evidence
              ? JSON.stringify(comment.evidence)
              : null,
          }),
          ["id"],
          ["task_id"],
        );
      for (const question of record.questions)
        plan(
          "task_questions",
          {
            id: question.id,
            task_id: task.id,
            payload: JSON.stringify(question),
          },
          ["id"],
          ["task_id"],
        );
      for (const thread of record.threads)
        plan("task_threads", dbRow(thread), ["id"], ["task_id"]);
      for (const attachment of record.attachments) {
        const staged = blobs.get(attachment.id)!;
        const current = store.tasks.getAttachment(attachment.id);
        if ((current?.blobPath ?? null) !== staged.previousPath)
          throw new Error(
            `Attachment changed during import: ${attachment.id}; retry`,
          );
        if (current && staged.previousHash !== attachment.sha256 && !overwrite)
          throw new Error(
            `Import conflict: attachment content ${attachment.id}; use --overwrite`,
          );
        const { sha256: _sha256, ...metadata } = attachment;
        const blobPath =
          current && staged.previousHash === attachment.sha256
            ? current.blobPath
            : staged.path;
        plan(
          "attachments",
          dbRow({ ...metadata, blobPath }),
          ["id"],
          ["task_id", "comment_id"],
        );
      }
      for (const alias of record.aliases) {
        const existingTarget = store.tasks.getTaskByKey(
          `${alias.prefix}-${alias.number}`,
        );
        if (
          existingTarget &&
          existingTarget.id !== task.id &&
          !merged.has(existingTarget.id)
        )
          throw new Error(
            `Alias belongs to another project: ${alias.prefix}-${alias.number}`,
          );
        const target = [...merged.values()].find(
          (candidate) =>
            `${project.prefix}-${candidate.number}` ===
            `${alias.prefix}-${alias.number}`,
        );
        if (target && target.id !== task.id)
          throw new Error(
            `Alias conflicts with a live task key: ${alias.prefix}-${alias.number}`,
          );
        plan(
          "task_key_aliases",
          { prefix: alias.prefix, number: alias.number, task_id: task.id },
          ["prefix", "number"],
          ["task_id"],
        );
      }
    }
    // Schedules, sources and history go in after every task exists. All references are validated while planning,
    // before any write; schedules are forced paused/unassigned and runs forced historical.
    const rowOf = <T>(table: string, where: string, ...args: SqlValue[]) => db.prepare<SqlValue[], T>(`SELECT * FROM ${table} WHERE ${where}`).get(...args);
    for (const schedule of manifest.schedules) {
      const other = rowOf<{ id: string }>("task_schedules", "template_task_id=? AND id<>?", schedule.templateTaskId, schedule.id);
      if (other) throw new Error(`Import conflict: template task already belongs to schedule ${other.id}`);
      plan("task_schedules", {
        id: schedule.id, project_id: projectId, template_task_id: schedule.templateTaskId, rule: JSON.stringify(schedule.rule),
        target: JSON.stringify({ kind: "unassigned" }), enabled: 0, next_due_at: null, created_at: schedule.createdAt, updated_at: schedule.updatedAt,
      }, ["id"], ["project_id", "template_task_id"]);
    }
    for (const source of manifest.scheduleSources) {
      const referenced = source.runId && rowOf<{ project_id: string; schedule_id: string; occurrence_key: string; payload: string }>("task_schedule_runs", "id=?", source.runId);
      // An expired run may be absent, but an existing run must belong to this exact result.
      if (referenced && (referenced.project_id !== projectId || referenced.schedule_id !== source.scheduleId || referenced.occurrence_key !== source.occurrenceKey || scheduleRunSchema.parse(JSON.parse(referenced.payload)).taskId !== source.taskId))
        throw new Error(`Import conflict: referenced scheduled run ${source.runId} belongs to another result`);
      if (source.occurrenceKey !== null && rowOf("task_scheduled_sources", "schedule_id=? AND occurrence_key=? AND task_id<>?", source.scheduleId, source.occurrenceKey, source.taskId))
        throw new Error(`Import conflict: occurrence ${source.occurrenceKey} already belongs to another result task`);
      plan("task_scheduled_sources", {
        task_id: source.taskId, schedule_id: source.scheduleId, schedule_title: source.scheduleTitle, role: source.role,
        scheduled_for: source.scheduledFor, started_at: source.startedAt, run_id: source.runId, occurrence_key: source.occurrenceKey,
      }, ["task_id"]);
    }
    for (const run of manifest.scheduleRuns) {
      const current = rowOf<{ payload: string; project_id: string; schedule_id: string }>("task_schedule_runs", "id=?", run.id);
      if (current) {
        if (current.project_id !== projectId || current.schedule_id !== run.scheduleId) throw new Error(`ID belongs to another owner: task_schedule_runs ${run.id}`);
        const local = scheduleRunSchema.parse(JSON.parse(current.payload));
        // The same history re-imported on its own server must keep the local live IDs.
        if (JSON.stringify(historicalRun(local)) === JSON.stringify(run)) continue;
        if (!local.historical && ["starting", "queued", "running", "delivery_unknown", "cancel_pending"].includes(local.state))
          throw new Error(`Import cannot replace an active scheduled run: ${run.id}`);
      }
      if (rowOf("task_schedule_runs", "schedule_id=? AND occurrence_key=? AND id<>?", run.scheduleId, run.occurrenceKey, run.id))
        throw new Error(`Import conflict: occurrence ${run.occurrenceKey} already has another run`);
      plan("task_schedule_runs", {
        id: run.id, schedule_id: run.scheduleId, project_id: projectId, occurrence_key: run.occurrenceKey, state: run.state,
        resolved_at: run.resolvedAt, finished_at: run.finishedAt, thread_id: null, payload: JSON.stringify(historicalRun(run)),
      }, ["id"], ["project_id", "schedule_id"]);
    }
    db.pragma("defer_foreign_keys = ON");
    for (const { table, row, keys } of changes) {
      const columns = Object.keys(row);
      const updates = columns.filter((key) => !keys.includes(key));
      db.prepare<SqlValue[]>(
        `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) ON CONFLICT (${keys.join(", ")}) DO UPDATE SET ${updates.map((key) => `${key} = excluded.${key}`).join(", ")}`,
      ).run(...columns.map((key) => row[key]!));
    }
    for (const record of records)
      if (record.activityHistory)
        db.prepare<[string]>("INSERT OR IGNORE INTO task_activity_history(task_id) VALUES (?)").run(record.task.id);
    // validateArchive already checks the complete, project-local graph; never traverse it once per edge.
    for (const record of records) if (record.dependencies !== undefined)
      db.prepare<[string]>("DELETE FROM task_dependencies WHERE task_id=?").run(record.task.id);
    const insertDependency = db.prepare<[string, string]>("INSERT INTO task_dependencies(task_id, blocking_task_id) VALUES (?, ?)");
    for (const record of records) for (const blocker of record.dependencies ?? []) insertDependency.run(record.task.id, blocker);
    for (const record of records) if (relatedOf(record) !== undefined)
      db.prepare<[string]>("DELETE FROM task_relations WHERE task_id=?").run(record.task.id);
    const insertRelation = db.prepare<[string, string]>("INSERT INTO task_relations(task_id, related_task_id) VALUES (?, ?)");
    for (const record of records) for (const other of relatedOf(record) ?? []) insertRelation.run(record.task.id, other);
    if (manifest.gitSync) db.prepare<[string]>("DELETE FROM git_pr_snapshots WHERE project_id=?").run(projectId);
    for (const { task } of records) {
      const currentIds = store.tasks
        .listTaskLabels(task.id)
        .map((link) => link.labelId)
        .sort();
      if (
        JSON.stringify(currentIds) === JSON.stringify([...task.labelIds].sort())
      )
        continue;
      db.prepare<[string]>("DELETE FROM task_labels WHERE task_id = ?").run(
        task.id,
      );
      for (const labelId of task.labelIds)
        db.prepare<[string, string]>(
          "INSERT INTO task_labels (task_id, label_id) VALUES (?, ?)",
        ).run(task.id, labelId);
    }
  });
}
