import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TasksApiStore } from "../api";
import { readAttachmentContent } from "../attachments";
import { createHash } from "node:crypto";
import {
  assertNoSecrets,
  assertNoSecretsInValue,
} from "../shared/secret-guard.js";
import { createStructuredStore } from "../structured/store";
import {
  archiveProjectSchema,
  archiveTaskSchema,
  validateArchive,
  type ArchiveTask,
  type ProjectArchive,
} from "./contract";

type SqlValue = string | number | null;
type Row = Record<string, SqlValue>;
export const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

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
    const manifest = archiveProjectSchema.parse({
      format: "bb-tasks-plus",
      version: 5,
      project,
      folders,
      labels: store.tasks
        .listLabels(projectId)
        .sort((a, b) => a.id.localeCompare(b.id)),
      taskIds: tasks.map((task) => task.id),
      templates: structured.listTemplates(projectId),
    });
    const records = tasks.map((task) => {
      const comments = store.tasks
        .listComments(task.id)
        .sort((a, b) => a.id.localeCompare(b.id));
      const attachments = [
        ...store.tasks.listAttachmentsForTask(task.id),
        ...comments.flatMap((comment) =>
          store.tasks.listAttachmentsForComment(comment.id),
        ),
      ].sort((a, b) => a.id.localeCompare(b.id));
      const aliases = bb.storage
        .database()
        .prepare<
          [string],
          { prefix: string; number: number }
        >("SELECT prefix, number FROM task_key_aliases WHERE task_id = ? ORDER BY prefix, number")
        .all(task.id);
      return {
        task: {
          ...task,
          labelIds: store.tasks
            .listTaskLabels(task.id)
            .map((link) => link.labelId)
            .sort(),
        },
        comments,
        questions: structured.listQuestions(task.id),
        attachments,
        threads: store.tasks
          .listTaskThreads(task.id)
          .sort((a, b) => a.id.localeCompare(b.id)),
        aliases,
      };
    });
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
      typeof value === "boolean" ? Number(value) : value,
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
  const db = bb.storage.database();
  const { manifest, records } = archive;
  const projectId = manifest.project.id;
  store.transaction(() => {
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
      const { key: _key, labelIds, ...task } = record.task;
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
      plan("tasks", dbRow(task), ["id"], ["project_id"]);
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
    db.pragma("defer_foreign_keys = ON");
    for (const { table, row, keys } of changes) {
      const columns = Object.keys(row);
      const updates = columns.filter((key) => !keys.includes(key));
      db.prepare<SqlValue[]>(
        `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) ON CONFLICT (${keys.join(", ")}) DO UPDATE SET ${updates.map((key) => `${key} = excluded.${key}`).join(", ")}`,
      ).run(...columns.map((key) => row[key]!));
    }
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
