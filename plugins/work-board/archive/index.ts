import { rewriteLegacyAttachmentLinks } from "../shared/attachments";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  publishCommentsChanged,
  publishProjectsChanged,
  publishTasksChanged,
  type TasksApiStore,
} from "../api";
import { publishThreadsChanged } from "../delegate";
import { readAttachmentContent } from "../attachments";
import { errorMessage } from "../shared/errors";
import {
  archiveProjectSchema,
  archiveTaskSchema,
  jsonText,
  validateArchive,
  type ProjectArchive,
} from "./contract";
import {
  archiveRecords,
  captureProject,
  restoreProject,
  sha256,
} from "./storage";

const exportsInProgress = new Set<string>();
const missing = (error: unknown) =>
  /\bENOENT\b|does not exist|not found/i.test(errorMessage(error));

function clientFiles(bb: BbPluginApi, hostId: string | undefined) {
  const host = hostId ? { hostId } : {};
  return {
    async read(path: string, rootPath: string) {
      const file = await bb.sdk.files.read({ ...host, path, rootPath });
      return Buffer.from(
        file.content,
        file.contentEncoding === "base64" ? "base64" : "utf8",
      );
    },
    async write(path: string, bytes: Buffer) {
      const result = await bb.sdk.files.write({
        ...host,
        path,
        content: bytes.toString("base64"),
        contentEncoding: "base64",
        createParents: true,
      });
      if (result.outcome !== "written")
        throw new Error(`File write conflict: ${path}`);
    },
    async move(sourcePath: string, destinationPath: string) {
      await bb.sdk.files.move({ ...host, sourcePath, destinationPath });
    },
    async remove(path: string) {
      await bb.sdk.files.remove({ ...host, path, recursive: true });
    },
    async list(path: string) {
      return bb.sdk.files.listPaths({
        ...host,
        path,
        includeHidden: true,
        includeDirectories: true,
        includeFiles: true,
        excludeNames: [],
        limit: 10000,
      });
    },
    async mkdir(path: string) {
      await bb.sdk.files.mkdir({ ...host, path, recursive: true });
    },
  };
}

function parseArchiveJson(text: string): unknown {
  return JSON.parse(rewriteLegacyAttachmentLinks(JSON.stringify(JSON.parse(text))));
}

export async function readProjectArchive(
  bb: BbPluginApi,
  hostId: string | undefined,
  root: string,
): Promise<ProjectArchive> {
  const files = clientFiles(bb, hostId);
  const manifest = archiveProjectSchema.parse(
    parseArchiveJson(
      (await files.read(join(root, "project.json"), root)).toString("utf8"),
    ),
  );
  const records = [];
  for (const id of manifest.taskIds) {
    const record = archiveTaskSchema.parse(
      parseArchiveJson(
        (await files.read(join(root, "tasks", `${id}.json`), root)).toString(
          "utf8",
        ),
      ),
    );
    if (record.task.id !== id)
      throw new Error(`Task ID does not match its filename: ${id}`);
    records.push(record);
  }
  const archive = { manifest, records };
  validateArchive(archive);
  return archive;
}

export async function exportProject(
  bb: BbPluginApi,
  store: TasksApiStore,
  projectId: string,
  out: string,
  hostId?: string,
) {
  const key = `${hostId ?? "server"}:${out}`;
  if (exportsInProgress.has(key))
    throw new Error("An export to this directory is already running");
  exportsInProgress.add(key);
  const files = clientFiles(bb, hostId);
  const suffix = randomUUID();
  const staged = `${out}.staging-${suffix}`;
  const backup = `${out}.previous-${suffix}`;
  let movedPrevious = false;
  let promoted = false;
  try {
    let previous: ProjectArchive | null = null;
    try {
      previous = await readProjectArchive(bb, hostId, out);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    if (previous && previous.manifest.project.id !== projectId) {
      throw new Error("Export directory belongs to another project");
    }
    // A snapshot owns its directory; refuse to replace unrelated files or a Git repository.
    const allowed = new Set(
      previous
        ? [
            "project.json",
            "tasks",
            "attachments",
            ...previous.manifest.taskIds.map((id) => `tasks/${id}.json`),
            ...previous.records.flatMap((r) =>
              r.attachments.map((a) => `attachments/${a.id}`),
            ),
          ]
        : [],
    );
    const checkDirectory = async () => {
      let entries;
      try {
        entries = await files.list(out);
      } catch (error) {
        if (missing(error)) return;
        throw error;
      }
      if (entries.truncated)
        throw new Error(
          "Export directory listing was truncated; refusing to replace it",
        );
      for (const entry of entries.paths) {
        const path = relative(out, resolve(out, entry.path))
          .split(sep)
          .join("/");
        if (!allowed.has(path))
          throw new Error(`Unmanaged file in export directory: ${path}`);
      }
    };
    await checkDirectory();
    const capture = captureProject(bb, store, projectId);
    await files.mkdir(staged);
    const records = await archiveRecords(store, capture, (id, bytes) =>
      files.write(join(staged, "attachments", id), bytes),
    );
    const archive = { manifest: capture.manifest, records };
    validateArchive(archive);
    for (const record of records)
      await files.write(
        join(staged, "tasks", `${record.task.id}.json`),
        Buffer.from(jsonText(record)),
      );
    await files.write(
      join(staged, "project.json"),
      Buffer.from(jsonText(archive.manifest)),
    );
    // The SDK lists missing directories as empty, so ensure even the first target exists.
    await files.mkdir(out);
    await checkDirectory();
    await files.move(out, backup);
    movedPrevious = true;
    await files.move(staged, out);
    promoted = true;
    if (movedPrevious) {
      try {
        await files.remove(backup);
      } catch (error) {
        bb.log.warn(
          `Export succeeded; previous copy remains at ${backup}: ${errorMessage(error)}`,
        );
      }
    }
    return {
      projectId,
      out,
      tasks: records.length,
      attachments: records.reduce((n, r) => n + r.attachments.length, 0),
    };
  } catch (error) {
    if (movedPrevious && !promoted) {
      try {
        await files.move(backup, out);
      } catch (restoreError) {
        throw new Error(
          `Export failed: ${errorMessage(error)}. Previous export is safe at ${backup}; restoring its path failed: ${errorMessage(restoreError)}`,
        );
      }
    }
    throw error;
  } finally {
    exportsInProgress.delete(key);
    if (!promoted) {
      try {
        await files.remove(staged);
      } catch (error) {
        if (!missing(error))
          bb.log.warn(
            `Temporary export remains at ${staged}: ${errorMessage(error)}`,
          );
      }
    }
  }
}

export async function importProject(
  bb: BbPluginApi,
  store: TasksApiStore,
  from: string,
  overwrite: boolean,
  hostId?: string,
) {
  const archive = await readProjectArchive(bb, hostId, from);
  const files = clientFiles(bb, hostId);
  const database = bb.storage
    .database()
    .prepare<[], { name: string; file: string }>("PRAGMA database_list")
    .all()
    .find((entry) => entry.name === "main");
  if (!database?.file)
    throw new Error("Project import requires file-backed plugin storage");
  const root = dirname(database.file);
  const token = randomUUID();
  const staged: string[] = [];
  const blobs = new Map<
    string,
    { path: string; previousPath: string | null; previousHash: string | null }
  >();
  let committed = false;
  try {
    for (const record of archive.records) {
      for (const attachment of record.attachments) {
        const bytes = await files.read(
          join(from, "attachments", attachment.id),
          from,
        );
        if (
          bytes.length !== attachment.sizeBytes ||
          sha256(bytes) !== attachment.sha256
        )
          throw new Error(
            `Attachment integrity check failed: ${attachment.id}`,
          );
        const current = store.tasks.getAttachment(attachment.id);
        let previousHash: string | null = null;
        if (current) {
          try {
            previousHash = sha256(
              (await readAttachmentContent(store.tasks, current.id)).content,
            );
          } catch (error) {
            if (!missing(error)) throw error;
          }
        }
        const path = join("blobs", attachment.id, `import-${token}`);
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), bytes, { flag: "wx" });
        staged.push(path);
        blobs.set(attachment.id, {
          path,
          previousPath: current?.blobPath ?? null,
          previousHash,
        });
      }
    }
    restoreProject(bb, store, archive, blobs, overwrite);
    committed = true;
    publishProjectsChanged(bb, archive.manifest.project.id);
    for (const { task } of archive.records) {
      publishTasksChanged(bb, task.id, task.projectId);
      publishCommentsChanged(bb, task.id);
      publishThreadsChanged(bb, task.id);
    }
    return {
      projectId: archive.manifest.project.id,
      tasks: archive.records.length,
      attachments: blobs.size,
    };
  } finally {
    // Keep newly referenced blobs; failed imports never alter the previous blob files.
    for (const path of staged) {
      const id = path.split(sep)[1]!;
      if (committed && store.tasks.getAttachment(id)?.blobPath === path)
        continue;
      try {
        await rm(join(root, path), { force: true });
      } catch (error) {
        bb.log.warn(
          `Could not remove unused import blob ${path}: ${errorMessage(error)}`,
        );
      }
    }
  }
}
