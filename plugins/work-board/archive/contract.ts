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
    ]),
    project: projectSchema,
    gitSync: gitSyncConfigSchema.optional(),
    folders: z.array(folderSchema),
    labels: z.array(labelSchema),
    taskIds: z.array(idSchema),
    templates: z.array(templateSchema).default([]),
  })
  .strict();

export const archiveTaskSchema = z
  .object({
    task: taskSchema,
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

export function validateArchive({ manifest, records }: ProjectArchive): void {
  const projectId = manifest.project.id;
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
