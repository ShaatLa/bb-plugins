import { gitSyncConfigSchema, prLinkSchema, prIdentity } from "../shared/git-sync";
import { DEFAULT_TASK_STATUSES } from "../shared/statuses.js";
import { z } from "zod";
import {
  attachmentSchema,
  commentSchema,
  folderSchema,
  idSchema,
  labelSchema,
  projectSchema,
  PROJECT_PREFIX_PATTERN,
  taskSchema,
  taskThreadSchema,
  questionSchema,
  templateSchema,
} from "../shared/contract";
import { MAX_ATTACHMENT_SIZE_BYTES } from "../shared/attachments";
import { scheduleRunSchema, scheduleSchema, scheduleSourceSchema } from "../shared/scheduled";

export const archiveProjectSchema = z
  .object({
    format: z.enum(["bb-work-board", "bb-agent-board", "bb-tasks-plus"]),
    version: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
      z.literal(6),
      z.literal(7),
      z.literal(8),
      z.literal(9),
      z.literal(10),
      z.literal(11),
      z.literal(12),
      z.literal(13),
      z.literal(14),
      z.literal(15),
    ]),
    project: projectSchema,
    gitSync: gitSyncConfigSchema.optional(),
    folders: z.array(folderSchema),
    labels: z.array(labelSchema),
    taskIds: z.array(idSchema),
    templates: z.array(templateSchema).default([]),
    // v13: portable schedule definitions, task provenance and retained run history (never live queue state).
    schedules: z.array(scheduleSchema).default([]),
    scheduleSources: z.array(scheduleSourceSchema).default([]),
    scheduleRuns: z.array(scheduleRunSchema).default([]),
  })
  .strict();

export const archiveTaskSchema = z
  .object({
    task: taskSchema,
    activityHistory: z.boolean().optional(),
    dependencies: z.array(idSchema).optional(),
    /** v15: related tasks stored on the pair's smaller task ID. */
    related: z.array(idSchema).optional(),
    pullRequests: z.array(prLinkSchema).optional(),
    comments: z.array(commentSchema),
    questions: z.array(questionSchema).default([]),
    attachments: z.array(
      attachmentSchema
        .extend({
          mime: z
            .string()
            .regex(
              /^(application|audio|font|image|message|model|multipart|text|video)\/[!#$&^_.+\-A-Za-z0-9]+$/,
            )
            .refine((value) => !/[\r\n]/.test(value)),
          fileName: z
            .string()
            .min(1)
            .refine((value) => !/[\x00-\x1f\x7f]/.test(value)),
          sizeBytes: z.number().int().min(0).max(MAX_ATTACHMENT_SIZE_BYTES),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict()
        .refine(
          (attachment) =>
            !attachment.isImage ||
            [
              "image/png",
              "image/jpeg",
              "image/gif",
              "image/webp",
              "image/avif",
            ].includes(attachment.mime),
          "Inline attachments must use a raster image MIME type",
        ),
    ),
    threads: z.array(taskThreadSchema),
    aliases: z.array(
      z
        .object({
          prefix: z.string().regex(PROJECT_PREFIX_PATTERN),
          number: z.number().int().positive(),
        })
        .strict(),
    ),
  })
  .strict();

export type ArchiveProject = z.infer<typeof archiveProjectSchema>;
export type ArchiveTask = z.infer<typeof archiveTaskSchema>;
export interface ProjectArchive {
  manifest: ArchiveProject;
  records: ArchiveTask[];
}

export function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function unique(ids: readonly string[], label: string) {
  if (new Set(ids).size !== ids.length)
    throw new Error(`Duplicate ${label} in archive`);
}

// Schedules must own their template task; sources and runs are provenance and may outlive their schedule.
function validateScheduled({ manifest, records }: ProjectArchive): void {
  const { schedules, scheduleSources: sources, scheduleRuns: runs } = manifest;
  if (manifest.version < 13) {
    if (schedules.length || sources.length || runs.length) throw new Error("Scheduled tasks require archive v13");
    return;
  }
  const projectId = manifest.project.id;
  const tasks = new Map(records.map(record => [record.task.id, record.task]));
  unique(schedules.map(schedule => schedule.id), "schedule ID");
  unique(schedules.map(schedule => schedule.templateTaskId), "schedule template task");
  unique(sources.map(source => source.taskId), "scheduled source task");
  unique(sources.flatMap(source => source.runId ? [source.runId] : []), "scheduled source run");
  unique(sources.flatMap(source => source.occurrenceKey === null ? [] : [`${source.scheduleId}\n${source.occurrenceKey}`]), "scheduled source occurrence");
  unique(runs.map(run => run.id), "schedule run ID");
  unique(runs.map(run => `${run.scheduleId}\n${run.occurrenceKey}`), "schedule run occurrence");
  const sourceByTask = new Map(sources.map(source => [source.taskId, source]));
  const runById = new Map(runs.map(run => [run.id, run]));
  for (const schedule of schedules) {
    const template = sourceByTask.get(schedule.templateTaskId);
    if (schedule.projectId !== projectId || !tasks.has(schedule.templateTaskId)) throw new Error(`Invalid schedule project or template task: ${schedule.id}`);
    if (template?.role !== "template" || template.scheduleId !== schedule.id) throw new Error(`Schedule template source does not match: ${schedule.id}`);
  }
  const scheduleIds = new Set(schedules.map(schedule => schedule.id));
  for (const source of sources) {
    if (!tasks.has(source.taskId)) throw new Error(`Scheduled source references an unknown task: ${source.taskId}`);
    if (source.role === "template") {
      const schedule = schedules.find(candidate => candidate.id === source.scheduleId);
      if (!scheduleIds.has(source.scheduleId) || schedule?.templateTaskId !== source.taskId || source.occurrenceKey !== null || source.runId !== null)
        throw new Error(`Invalid template source: ${source.taskId}`);
    } else if (source.occurrenceKey === null) throw new Error(`Scheduled result source needs an occurrence key: ${source.taskId}`);
    const run = source.runId ? runById.get(source.runId) : undefined;
    if (run && (run.scheduleId !== source.scheduleId || run.occurrenceKey !== source.occurrenceKey || (run.taskId !== null && run.taskId !== source.taskId)))
      throw new Error(`Scheduled source does not match its run: ${source.taskId}`);
  }
  for (const run of runs) {
    if (run.projectId !== projectId) throw new Error(`Schedule run belongs to another project: ${run.id}`);
    if (run.taskId === null) continue;
    const source = sourceByTask.get(run.taskId);
    if (!tasks.has(run.taskId) || source?.scheduleId !== run.scheduleId || source.role === "template")
      throw new Error(`Schedule run references an invalid task: ${run.id}`);
  }
}

export function validateArchive(archive: ProjectArchive): void {
  const { manifest, records } = archive;
  validateScheduled(archive);
  const projectId = manifest.project.id;
  const taskIds = new Set(manifest.taskIds);
  const incoming = new Map(manifest.taskIds.map(id => [id, 0]));
  const successors = new Map<string, string[]>();
  for (const record of records) {
    if (manifest.version >= 12 && !record.dependencies) throw new Error("Archive v12 requires dependencies");
    if (manifest.version < 12 && record.dependencies !== undefined) throw new Error("Task dependencies require archive v12");
    unique(record.dependencies ?? [], "task dependency");
    if (manifest.version >= 15 && !record.related) throw new Error("Archive v15 requires related tasks");
    if (manifest.version < 15 && record.related?.length) throw new Error("Related tasks require archive v15");
    unique(record.related ?? [], "related task");
    for (const other of record.related ?? [])
      if (other <= record.task.id || !taskIds.has(other)) throw new Error("Invalid related task in archive");
    for (const blocker of record.dependencies ?? []) {
      if (blocker === record.task.id || !taskIds.has(blocker)) throw new Error("Invalid task dependency in archive");
      incoming.set(record.task.id, (incoming.get(record.task.id) ?? 0) + 1);
      const group = successors.get(blocker) ?? [];
      group.push(record.task.id);
      successors.set(blocker, group);
    }
  }
  // Iterative topological validation avoids recursion limits on long dependency chains.
  const ready = [...incoming].filter(([, count]) => count === 0).map(([id]) => id);
  for (let i = 0; i < ready.length; i++) for (const successor of successors.get(ready[i]!) ?? []) {
    const count = incoming.get(successor)! - 1;
    incoming.set(successor, count);
    if (count === 0) ready.push(successor);
  }
  if (ready.length !== incoming.size) throw new Error("Dependency cycle in archive");
  if (manifest.version >= 8 && !manifest.gitSync) throw new Error("Archive v8 requires gitSync");
  if (manifest.version < 8 && (manifest.gitSync || records.some(record => record.pullRequests !== undefined))) throw new Error("Git/PR links require archive v8");
  for (const record of records) {
    if (manifest.version >= 8 && !record.pullRequests) throw new Error("Archive v8 requires pullRequests");
    unique((record.pullRequests ?? []).map(prIdentity), "PR link");
    if (record.pullRequests?.some(link => link.taskId !== record.task.id)) throw new Error("PR link belongs to another task");
  }
  for (const record of records) {
    if (manifest.version >= 7 && record.task.archivedAt === undefined)
      throw new Error("Archive v7 requires task.archivedAt");
    if (manifest.version < 7 && record.task.archivedAt != null)
      throw new Error("Task archival requires archive v7");
  }
  if (manifest.version >= 6 && !manifest.project.statuses)
    throw new Error("Archive v6 requires project statuses");
  if (manifest.version < 6 && manifest.project.statuses)
    throw new Error("Project statuses require archive v6");
  const statusIds = new Set(
    (manifest.project.statuses ?? DEFAULT_TASK_STATUSES).map(
      (status) => status.id,
    ),
  );
  if (records.some((record) => !statusIds.has(record.task.status)))
    throw new Error("Task has a status not defined by its project");
  if (
    !manifest.project.name.trim() ||
    manifest.labels.some((label) => !label.name.trim()) ||
    manifest.folders.some((folder) => !folder.name.trim())
  )
    throw new Error("Project, folder and label names must not be blank");
  unique(manifest.taskIds, "task ID");
  unique(
    manifest.labels.map((label) => label.id),
    "label ID",
  );
  unique(
    manifest.folders.map((folder) => folder.id),
    "folder ID",
  );
  unique(
    records.map((record) => record.task.id),
    "task record",
  );
  if (
    records.length !== manifest.taskIds.length ||
    records.some((r) => !manifest.taskIds.includes(r.task.id))
  ) {
    throw new Error("Task records do not match project.json");
  }
  if (manifest.labels.some((label) => label.projectId !== projectId))
    throw new Error("Label belongs to another project");
  unique(
    manifest.templates.map((template) => template.id),
    "template ID",
  );
  unique(
    manifest.templates.map((template) => template.name.toLowerCase()),
    "template name",
  );
  unique(
    manifest.templates.flatMap((template) =>
      template.labelId ? [template.labelId] : [],
    ),
    "template label",
  );
  if (
    manifest.templates.some(
      (template) =>
        template.projectId !== projectId ||
        (template.labelId &&
          !manifest.labels.some((label) => label.id === template.labelId)),
    )
  )
    throw new Error("Invalid template project or label");
  const folders = new Map(
    manifest.folders.map((folder) => [folder.id, folder]),
  );
  for (const folder of manifest.folders) {
    const visited = new Set<string>();
    let id: string | null = folder.id;
    while (id !== null) {
      if (visited.has(id) || !folders.has(id))
        throw new Error("Invalid folder hierarchy in archive");
      visited.add(id);
      id = folders.get(id)!.parentFolderId;
    }
  }
  if (manifest.project.folderId && !folders.has(manifest.project.folderId))
    throw new Error("Project folder is missing");
  for (const record of records) {
    const { task, comments, attachments, threads } = record;
    if (
      task.projectId !== projectId ||
      task.key !== `${manifest.project.prefix}-${task.number}`
    )
      throw new Error(`Invalid project or key for task ${task.id}`);
    if (!task.title.trim())
      throw new Error(`Task ${task.id} has a blank title`);
    unique(task.labelIds, "task label");
    if (
      comments.some((c) => c.taskId !== task.id) ||
      threads.some((t) => t.taskId !== task.id) ||
      record.questions.some((question) => question.taskId !== task.id)
    )
      throw new Error(`Invalid child owner for task ${task.id}`);
    const commentIds = new Set(comments.map((c) => c.id));
    for (const attachment of attachments) {
      const direct =
        attachment.taskId === task.id && attachment.commentId === null;
      const comment =
        attachment.taskId === null &&
        attachment.commentId !== null &&
        commentIds.has(attachment.commentId);
      if (!direct && !comment)
        throw new Error(`Invalid attachment owner: ${attachment.id}`);
    }
  }
  unique(
    records.flatMap((record) =>
      record.questions.map((question) => question.id),
    ),
    "question ID",
  );
  unique(
    records.flatMap((r) => r.comments.map((c) => c.id)),
    "comment ID",
  );
  unique(
    records.flatMap((r) => r.attachments.map((a) => a.id)),
    "attachment ID",
  );
  unique(
    records.flatMap((r) => r.threads.map((t) => t.id)),
    "thread link ID",
  );
}
