import { workflowPolicySchema } from "../shared/workflow-policy";
import { isUtf8 } from "node:buffer";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  createFakePluginHost,
  type FakePluginHarness,
} from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createStore, registerTasksApi } from "../api";
import { registerTasksCli } from "../cli";
import {
  readAttachmentContent,
  registerAttachments,
  saveAttachmentFromBytes,
} from "../attachments";
import { exportProject, importProject, readProjectArchive } from ".";
import { jsonText } from "./contract";
import { createScheduledStore } from "../scheduled/store";
import { DEFAULT_TASK_STATUSES, type TaskStatusDefinition } from "../shared/statuses";
import { createStructuredStore } from "../structured/store";

const harnesses: FakePluginHarness[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.dispose()));
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function setup() {
  const faults = { write: false, promote: false };
  const io = { active: 0, peak: 0, blobs: 0, blobPeak: 0 };
  async function track(path: string) {
    const json = /\/tasks\/.*\.json$/.test(path);
    const blob = path.includes("/attachments/");
    if (json) io.peak = Math.max(io.peak, ++io.active);
    if (blob) io.blobPeak = Math.max(io.blobPeak, ++io.blobs);
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (json) io.active--;
    if (blob) io.blobs--;
  }
  const { bb, harness } = createFakePluginHost({
    pluginId: "work-board",
    sdk: {
      files: {
        read: async ({ path }: { path: string }) => {
          await track(path);
          const bytes = await readFile(path);
          const contentEncoding = isUtf8(bytes) ? "utf8" : "base64";
          return {
            path,
            content: bytes.toString(contentEncoding),
            contentEncoding,
            sizeBytes: bytes.length,
          };
        },
        write: async ({
          path,
          content,
          contentEncoding,
        }: {
          path: string;
          content: string;
          contentEncoding?: "base64" | "utf8";
        }) => {
          await track(path);
          if (
            faults.write &&
            path.includes("staging-") &&
            path.endsWith(".json")
          )
            throw new Error("Disk full");
          await mkdir(dirname(path), { recursive: true });
          await writeFile(
            path,
            Buffer.from(content, contentEncoding ?? "utf8"),
          );
          return { outcome: "written" };
        },
        mkdir: async ({ path }: { path: string }) => {
          await mkdir(path, { recursive: true });
          return { ok: true };
        },
        move: async ({
          sourcePath,
          destinationPath,
        }: {
          sourcePath: string;
          destinationPath: string;
        }) => {
          if (faults.promote && sourcePath.includes("staging-"))
            throw new Error("Rename failed");
          await rename(sourcePath, destinationPath);
          return { ok: true };
        },
        remove: async ({ path }: { path: string }) => {
          await rm(path, { recursive: true, force: true });
          return { ok: true };
        },
        listPaths: async ({ path }: { path: string }) => {
          const paths: Array<{
            name: string;
            path: string;
            kind: "file" | "directory";
          }> = [];
          const walk = async (directory: string) => {
            for (const entry of await readdir(directory, {
              withFileTypes: true,
            })) {
              const child = join(directory, entry.name);
              paths.push({
                name: entry.name,
                path: child,
                kind: entry.isDirectory() ? "directory" : "file",
              });
              if (entry.isDirectory()) await walk(child);
            }
          };
          try {
            await walk(path);
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !("code" in error) ||
              error.code !== "ENOENT"
            )
              throw error;
          }
          return { paths, truncated: false };
        },
      },
    },
  });
  harnesses.push(harness);
  const store = createStore(bb);
  registerAttachments(bb, store.tasks);
  registerTasksApi(bb, store);
  registerTasksCli(bb, store, { name: "Work Board", version: "test" });
  return { bb, harness, store, faults, io };
}

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "tasks-archive-"));
  directories.push(path);
  return path;
}

async function seed() {
  const source = setup();
  const folder = source.store.tasks.createFolder({ name: "Work" });
  const project = source.store.tasks.createProject({
    name: "Archive project",
    prefix: "ARC",
    color: "purple",
    folderId: folder.id,
    linkedBbProjectId: "proj_original",
  });
  const epic = source.store.tasks.createTask({
    projectId: project.id,
    title: "Epic",
    type: "epic",
  });
  const task = source.store.tasks.createTask({
    projectId: project.id,
    title: "Mutable title",
    description: "# Markdown\n\nDetails",
    epicId: epic.id,
    dueDate: "2026-12-01",
    priority: "high",
  });
  const child = source.store.tasks.createTask({
    projectId: project.id,
    title: "Sub-task",
    parentTaskId: task.id,
  });
  const label = source.store.tasks.createLabel({
    projectId: project.id,
    name: "Feature",
    color: "green",
  });
  source.store.tasks.addTaskLabel(task.id, label.id);
  const comment = source.store.tasks.createComment({
    taskId: task.id,
    kind: "agent",
    authorName: "Worker",
    threadId: "thr_saved_worker",
    body: "Finished this part",
  });
  source.store.tasks.upsertTaskThread({
    taskId: task.id,
    threadId: "thr_saved_worker",
    title: "Worker thread",
    presetName: "Worker preset",
    liveStatus: "completed",
  });
  source.bb.storage
    .database()
    .prepare(
      "INSERT INTO task_key_aliases (prefix, number, task_id) VALUES (?, ?, ?)",
    )
    .run("OLD", 42, task.id);
  const attachment = await saveAttachmentFromBytes(
    source.store.tasks,
    Buffer.from([0, 255, 42, 7]),
    {
      taskId: task.id,
      fileName: "mutable-name.bin",
      mime: "application/octet-stream",
    },
  );
  const commentAttachment = await saveAttachmentFromBytes(
    source.store.tasks,
    Buffer.from("Comment artifact"),
    { commentId: comment.id, fileName: "report.txt" },
  );
  return {
    ...source,
    project,
    folder,
    epic,
    task,
    child,
    comment,
    attachment,
    commentAttachment,
  };
}

async function fileTree(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (path: string) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const next = join(path, entry.name);
      if (entry.isDirectory()) await walk(next);
      else
        files[relative(root, next)] = (await readFile(next)).toString("base64");
    }
  };
  await walk(root);
  return files;
}

describe("project archives", () => {
  it("round-trips questions, stable choice IDs, answers, evidence and templates, preserving conflicts", async () => {
    const source = await seed();
    const structured = createStructuredStore(source.bb, source.store);
    await structured.handlers.setTemplate({
      projectId: source.project.id,
      name: "task",
      body: "**Goal:** complete",
      labelId: null,
    });
    const { question } = await structured.handlers.createQuestion({
      taskId: source.task.id,
      prompt: "Which platforms?",
      mode: "multiple",
      allowOther: true,
      options: [
        {
          label: "macOS",
          recommended: true,
          recommendationReason: "Primary platform",
        },
        "Linux",
      ],
    });
    let { question: answered } = await structured.handlers.answerQuestion({
      questionId: question.id,
      selectedOptionIds: question.options.map((option) => option.id),
      revision: question.revision,
      authorName: "Owner",
      answerText: "Windows later",
    });
    const { question: reopened } = await structured.handlers.updateQuestion({
      questionId: question.id,
      revision: answered.revision,
      prompt: "Which delivery platforms?",
      mode: "multiple",
      options: question.options,
      reopen: true,
      authorName: "Editor",
    });
    answered = (
      await structured.handlers.answerQuestion({
        questionId: question.id,
        revision: reopened.revision,
        selectedOptionIds: question.options.map((option) => option.id),
        answerText: "Windows later",
        authorName: "Owner",
      })
    ).question;
    const comment = source.store.tasks.createComment({
      taskId: source.task.id,
      kind: "agent",
      authorName: "Reviewer",
      body: "Approved",
      evidence: {
        kind: "review",
        pr: 12,
        head: "a".repeat(40),
        verdict: "approve",
        thread: "thr_reviewer",
        recordedByThread: "thr_recorder",
        lens: "security",
      },
    });
    const out = join(await directory(), "snapshot");
    await exportProject(source.bb, source.store, source.project.id, out);
    const target = setup();
    await importProject(target.bb, target.store, out, false);
    const restored = createStructuredStore(target.bb, target.store);
    expect(restored.listQuestions(source.task.id)).toEqual([answered]);
    expect(answered.history).toHaveLength(3);
    expect(answered.options[0]).toMatchObject({
      recommended: true,
      recommendationReason: "Primary platform",
    });
    expect(answered.history![0]!.options[0]).toMatchObject({
      recommended: true,
      recommendationReason: "Primary platform",
    });
    expect(answered.answerText).toBe("Windows later");
    expect(restored.listTemplates(source.project.id)).toEqual(
      structured.listTemplates(source.project.id),
    );
    expect(target.store.tasks.getComment(comment.id)).toEqual(comment);
    const again = join(await directory(), "again");
    await exportProject(target.bb, target.store, source.project.id, again);
    expect(await fileTree(again)).toEqual(await fileTree(out));
    await restored.handlers.answerQuestion({
      questionId: answered.id,
      selectedOptionIds: [],
      revision: answered.revision,
      authorName: "Other",
    });
    await expect(
      importProject(target.bb, target.store, out, false),
    ).rejects.toThrow("Import conflict");
    await importProject(target.bb, target.store, out, true);
    expect(restored.listQuestions(source.task.id)).toEqual([answered]);
    const path = join(out, "tasks", `${source.task.id}.json`);
    const record = JSON.parse(await readFile(path, "utf8"));
    record.questions[0].options[0].label = "Renamed option";
    await writeFile(path, jsonText(record));
    await importProject(target.bb, target.store, out, true);
    expect(restored.listQuestions(source.task.id)[0]).toMatchObject({
      selectedOptionIds: answered.selectedOptionIds,
      options: [
        { id: answered.options[0]!.id, label: "Renamed option" },
        answered.options[1],
      ],
    });
    record.comments.find(
      (entry: { id: string }) => entry.id === comment.id,
    ).body = "Edited prior verdict";
    await writeFile(path, jsonText(record));
    await expect(
      importProject(target.bb, target.store, out, true),
    ).rejects.toThrow("append-only");
    expect(target.store.tasks.getComment(comment.id)).toEqual(comment);
  });

  it("imports legacy v1 archives without the new fields", async () => {
    const source = await seed();
    const out = join(await directory(), "legacy");
    await exportProject(source.bb, source.store, source.project.id, out);
    const manifestPath = join(out, "project.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.version = 1;
    delete manifest.gitSync;
    delete manifest.project.statuses;
    delete manifest.templates;
    await writeFile(manifestPath, jsonText(manifest));
    for (const id of manifest.taskIds) {
      const path = join(out, "tasks", `${id}.json`);
      const record = JSON.parse(await readFile(path, "utf8"));
      delete record.questions;
      delete record.pullRequests;
      delete record.dependencies;
      await writeFile(path, jsonText(record));
    }
    const target = setup();
    await importProject(target.bb, target.store, out, false);
    expect(target.store.tasks.getTask(source.task.id)).toEqual(
      source.store.tasks.getTask(source.task.id),
    );
    const structured = createStructuredStore(target.bb, target.store);
    expect(structured.listQuestions(source.task.id)).toEqual([]);
    expect(structured.listTemplates(source.project.id)).toEqual([]);
  });
  it("imports v2 questions with defaults for custom answers and history", async () => {
    const source = await seed();
    const structured = createStructuredStore(source.bb, source.store);
    const { question } = await structured.handlers.createQuestion({
      taskId: source.task.id,
      prompt: "Legacy question",
      mode: "single",
      options: ["A", "B"],
    });
    const out = join(await directory(), "legacy-v2");
    await exportProject(source.bb, source.store, source.project.id, out);
    const path = join(out, "project.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.version = 2;
    delete manifest.gitSync;
    for (const id of manifest.taskIds) { const taskFile = join(out, "tasks", `${id}.json`); const row = JSON.parse(await readFile(taskFile, "utf8")); delete row.pullRequests; delete row.dependencies; await writeFile(taskFile, jsonText(row)); }
    delete manifest.project.statuses;
    await writeFile(path, jsonText(manifest));
    const taskPath = join(out, "tasks", `${source.task.id}.json`);
    const record = JSON.parse(await readFile(taskPath, "utf8"));
    for (const field of ["allowOther", "answerText", "history"])
      delete record.questions[0][field];
    await writeFile(taskPath, jsonText(record));
    const target = setup();
    await importProject(target.bb, target.store, out, false);
    expect(
      createStructuredStore(target.bb, target.store).listQuestions(
        source.task.id,
      ),
    ).toEqual([question]);
  });

  it("rejects foreign or invalid answers on import, even with overwrite", async () => {
    const source = await seed();
    const structured = createStructuredStore(source.bb, source.store);
    await structured.handlers.createQuestion({
      taskId: source.task.id,
      prompt: "Choose one",
      mode: "single",
      options: ["A", "B"],
    });
    const out = join(await directory(), "snapshot");
    await exportProject(source.bb, source.store, source.project.id, out);
    const path = join(out, "tasks", `${source.task.id}.json`);
    const original = await readFile(path, "utf8");
    const target = setup();
    for (const mutation of ["owner", "single", "unknown", "secret"]) {
      const record = JSON.parse(original);
      const question = record.questions[0];
      if (mutation === "owner") question.taskId = source.child.id;
      if (mutation === "single")
        question.selectedOptionIds = question.options.map(
          (option: { id: string }) => option.id,
        );
      if (mutation === "unknown")
        question.selectedOptionIds = [source.child.id];
      if (mutation === "secret") question.prompt = "ghp_" + "a".repeat(36);
      await writeFile(path, jsonText(record));
      await expect(
        importProject(target.bb, target.store, out, true),
      ).rejects.toThrow();
      expect(target.store.tasks.listProjects()).toEqual([]);
    }
  });

  it("round-trips complete records and blobs by ID, with deterministic and idempotent output", async () => {
    const source = await seed();
    const root = await directory();
    const out = join(root, "export");
    const result = await exportProject(
      source.bb,
      source.store,
      source.project.id,
      out,
    );
    expect(result).toMatchObject({ tasks: 3, attachments: 2 });
    const first = await fileTree(out);
    expect(Object.keys(first).sort()).toEqual(
      [
        "project.json",
        ...[source.epic, source.task, source.child].map(
          (t) => `tasks/${t.id}.json`,
        ),
        ...[source.attachment, source.commentAttachment].map(
          (a) => `attachments/${a.id}`,
        ),
      ].sort(),
    );
    await exportProject(source.bb, source.store, source.project.id, out);
    expect(await fileTree(out)).toEqual(first);
    const target = setup();
    await importProject(target.bb, target.store, out, false);
    expect(target.store.tasks.getTask(source.task.id)).toEqual(source.task);
    expect(target.store.tasks.getTask(source.child.id)).toEqual(source.child);
    expect(target.store.tasks.getProject(source.project.id)).toEqual(
      source.store.tasks.getProject(source.project.id),
    );
    expect(target.store.tasks.getTaskByKey("OLD-42")?.id).toBe(source.task.id);
    expect(target.store.tasks.listComments(source.task.id)).toEqual(
      source.store.tasks.listComments(source.task.id),
    );
    expect(target.store.tasks.listTaskThreads(source.task.id)).toEqual(
      source.store.tasks.listTaskThreads(source.task.id),
    );
    expect(
      (await readAttachmentContent(target.store.tasks, source.attachment.id))
        .content,
    ).toEqual(Buffer.from([0, 255, 42, 7]));
    const revision = target.bb.storage
      .database()
      .prepare("SELECT revision FROM task_list_revision")
      .get();
    await importProject(target.bb, target.store, out, false);
    expect(
      target.bb.storage
        .database()
        .prepare("SELECT revision FROM task_list_revision")
        .get(),
    ).toEqual(revision);
    const again = join(root, "restored-export");
    await exportProject(target.bb, target.store, source.project.id, again);
    expect(await fileTree(again)).toEqual(first);
    source.store.tasks.updateTask(source.task.id, { title: "Renamed task" });
    await exportProject(source.bb, source.store, source.project.id, out);
    expect(Object.keys(await fileTree(out)).sort()).toEqual(
      Object.keys(first).sort(),
    );
  });

  it("bounds concurrent task JSON reads and writes", async () => {
    const source = await seed();
    for (let i = 0; i < 9; i++) source.store.tasks.createTask({ projectId: source.project.id, title: `Task ${i}` });
    const out = join(await directory(), "snapshot");
    await exportProject(source.bb, source.store, source.project.id, out);
    await exportProject(source.bb, source.store, source.project.id, out);
    expect(source.io.peak).toBe(4);
    expect(source.io.blobPeak).toBe(1);
  });

  it("cleans replaced blobs after commit and preserves originals on rollback", async () => {
    const source = await seed();
    const out = join(await directory(), "snapshot");
    const database = source.bb.storage.database();
    const root = dirname(database.prepare<[], { file: string }>("PRAGMA database_list").all()[0]!.file);
    const id = source.attachment.id;
    const original = source.store.tasks.getAttachment(id)!.blobPath;
    await exportProject(source.bb, source.store, source.project.id, out);
    await writeFile(join(root, original), Buffer.from([1, 2, 3, 4]));
    await expect(importProject(source.bb, source.store, out, false)).rejects.toThrow("Import conflict");
    expect(await readFile(join(root, original))).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(source.store.tasks.getAttachment(id)!.blobPath).toBe(original);
    await importProject(source.bb, source.store, out, true);
    const first = source.store.tasks.getAttachment(id)!.blobPath;
    expect(first).not.toBe(original);
    await expect(readFile(join(root, original))).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(join(root, first), Buffer.from([5, 6, 7, 8]));
    await importProject(source.bb, source.store, out, true);
    const second = source.store.tasks.getAttachment(id)!.blobPath;
    expect(second).not.toBe(first);
    await expect(readFile(join(root, first))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, second))).toEqual(Buffer.from([0, 255, 42, 7]));
    database.prepare(`INSERT INTO attachments
      SELECT 'shared-blob-test', task_id, comment_id, file_name, mime, size_bytes, blob_path, is_image, created_at
      FROM attachments WHERE id = ?`).run(id);
    await writeFile(join(root, second), Buffer.from([9, 9, 9, 9]));
    await importProject(source.bb, source.store, out, true);
    expect(await readFile(join(root, second))).toEqual(Buffer.from([9, 9, 9, 9]));
  });

  it("rejects conflicting changes atomically and allows explicit overwrite without deleting omitted records", async () => {
    const source = await seed();
    const out = join(await directory(), "snapshot");
    await exportProject(source.bb, source.store, source.project.id, out);
    source.store.tasks.updateTask(source.task.id, {
      title: "Local newer title",
    });
    const localComment = source.store.tasks.createComment({
      taskId: source.task.id,
      kind: "user",
      authorName: "Local",
      body: "Keep this discussion",
    });
    const extra = source.store.tasks.createTask({
      projectId: source.project.id,
      title: "Not in snapshot",
    });
    await expect(
      importProject(source.bb, source.store, out, false),
    ).rejects.toThrow("Import conflict");
    expect(source.store.tasks.getTask(source.task.id)?.title).toBe(
      "Local newer title",
    );
    await importProject(source.bb, source.store, out, true);
    expect(source.store.tasks.getTask(source.task.id)?.title).toBe(
      source.task.title,
    );
    expect(source.store.tasks.getTask(extra.id)).toEqual(extra);
    expect(source.store.tasks.getComment(localComment.id)).toEqual(
      localComment,
    );
    expect(
      source.store.tasks.getProject(source.project.id)!.nextTaskNumber,
    ).toBeGreaterThan(extra.number);
  });

  it("imports new tasks and comments into an existing project without requiring overwrite", async () => {
    const source = await seed();
    const out = join(await directory(), "snapshot");
    await exportProject(source.bb, source.store, source.project.id, out);
    const target = setup();
    await importProject(target.bb, target.store, out, false);
    const added = source.store.tasks.createTask({
      projectId: source.project.id,
      title: "Added later",
      epicId: source.epic.id,
    });
    const comment = source.store.tasks.createComment({
      taskId: source.task.id,
      kind: "user",
      authorName: "User",
      body: "New comment",
    });
    await exportProject(source.bb, source.store, source.project.id, out);
    await importProject(target.bb, target.store, out, false);
    expect(target.store.tasks.getTask(added.id)).toEqual(added);
    expect(target.store.tasks.getComment(comment.id)).toEqual(comment);
    expect(
      target.store.tasks.getProject(source.project.id)!.nextTaskNumber,
    ).toBeGreaterThan(added.number);
  });

  it("rolls back an import when a project prefix belongs to another project", async () => {
    const source = await seed();
    const out = join(await directory(), "snapshot");
    await exportProject(source.bb, source.store, source.project.id, out);
    const target = setup();
    const existing = target.store.tasks.createProject({
      name: "Already here",
      prefix: "ARC",
      color: "blue",
    });
    await expect(
      importProject(target.bb, target.store, out, true),
    ).rejects.toThrow("UNIQUE constraint");
    expect(target.store.tasks.listProjects()).toEqual([existing]);
    expect(target.store.tasks.listTasks()).toEqual([]);
  });

  it.each(["write", "promote"] as const)(
    "keeps the previous export intact when %s fails",
    async (fault) => {
      const source = await seed();
      const out = join(await directory(), "snapshot");
      await exportProject(source.bb, source.store, source.project.id, out);
      const before = await fileTree(out);
      source.store.tasks.updateTask(source.task.id, { title: "New title" });
      source.faults[fault] = true;
      await expect(
        exportProject(source.bb, source.store, source.project.id, out),
      ).rejects.toThrow(fault === "write" ? "Disk full" : "Rename failed");
      expect(await fileTree(out)).toEqual(before);
    },
  );

  it("accepts a pre-created empty output directory", async () => {
    const source = await seed();
    const out = join(await directory(), "empty");
    await mkdir(out);
    await exportProject(source.bb, source.store, source.project.id, out);
    expect(
      (await readProjectArchive(source.bb, undefined, out)).records,
    ).toHaveLength(3);
  });

  it("refuses to replace directories with unmanaged files", async () => {
    const source = await seed();
    const out = join(await directory(), "snapshot");
    await exportProject(source.bb, source.store, source.project.id, out);
    await writeFile(join(out, "README.md"), "My file");
    await expect(
      exportProject(source.bb, source.store, source.project.id, out),
    ).rejects.toThrow("Unmanaged file");
    expect(await readFile(join(out, "README.md"), "utf8")).toBe("My file");
  });

  it("rejects damaged blobs, invalid IDs and invalid links without importing any records", async () => {
    const source = await seed();
    const out = join(await directory(), "snapshot");
    await exportProject(source.bb, source.store, source.project.id, out);
    const target = setup();
    const blob = join(out, "attachments", source.attachment.id);
    const bytes = await readFile(blob);
    await writeFile(blob, "Damaged");
    await expect(
      importProject(target.bb, target.store, out, false),
    ).rejects.toThrow("integrity");
    expect(target.store.tasks.listProjects()).toEqual([]);
    await writeFile(blob, bytes);
    const manifestPath = join(out, "project.json");
    const originalManifest = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(originalManifest);
    manifest.taskIds = ["../../outside"];
    await writeFile(manifestPath, jsonText(manifest));
    await expect(
      importProject(target.bb, target.store, out, false),
    ).rejects.toThrow();
    expect(target.store.tasks.listProjects()).toEqual([]);
    await writeFile(manifestPath, originalManifest);
    const taskPath = join(out, "tasks", `${source.task.id}.json`);
    const record = JSON.parse(await readFile(taskPath, "utf8"));
    record.task.epicId = source.child.id;
    await writeFile(taskPath, jsonText(record));
    await expect(
      importProject(target.bb, target.store, out, false),
    ).rejects.toThrow("epic link");
    expect(target.store.tasks.listProjects()).toEqual([]);
    record.task.epicId = source.epic.id;
    record.attachments[0].mime = "text/html";
    record.attachments[0].isImage = true;
    await writeFile(taskPath, jsonText(record));
    await expect(
      importProject(target.bb, target.store, out, false),
    ).rejects.toThrow("Inline attachments");
    expect(target.store.tasks.listProjects()).toEqual([]);
  });

  it("rejects secrets in imported text even with overwrite enabled", async () => {
    const source = await seed();
    const out = join(await directory(), "snapshot");
    await exportProject(source.bb, source.store, source.project.id, out);
    const target = setup();
    const taskPath = join(out, "tasks", `${source.task.id}.json`);
    const original = await readFile(taskPath, "utf8");
    const secret = "sk-proj-" + "a".repeat(80);
    for (const field of ["title", "description", "comment body"]) {
      const record = JSON.parse(original);
      if (field === "comment body") record.comments[0].body = secret;
      else record.task[field] = secret;
      await writeFile(taskPath, jsonText(record));
      await expect(
        importProject(target.bb, target.store, out, true),
      ).rejects.toThrow(`Cannot save ${field}`);
      expect(target.store.tasks.listProjects()).toEqual([]);
    }
  });

  it("keeps attachment IDs and links when restoring a missing local blob", async () => {
    const source = await seed();
    const out = join(await directory(), "snapshot");
    await exportProject(source.bb, source.store, source.project.id, out);
    const old = source.store.tasks.getAttachment(source.attachment.id)!;
    const database = source.bb.storage
      .database()
      .prepare<[], { file: string }>("PRAGMA database_list")
      .all()[0]!;
    await rm(join(dirname(database.file), old.blobPath));
    await importProject(source.bb, source.store, out, true);
    expect(source.store.tasks.getAttachment(old.id)).toMatchObject({
      id: old.id,
      fileName: old.fileName,
      taskId: old.taskId,
    });
    expect(
      (await readAttachmentContent(source.store.tasks, old.id)).content,
    ).toEqual(Buffer.from([0, 255, 42, 7]));
  });

  it("merges new tasks through CLI and routes every archive file operation to the requested machine", async () => {
    const source = await seed();
    const out = join(await directory(), "snapshot");
    // The low-level export host is the same value resolved by the CLI's --machine path.
    await exportProject(
      source.bb,
      source.store,
      source.project.id,
      out,
      "host_export",
    );
    const target = setup();
    const result = await target.harness.runCli([
      "import",
      "--from",
      out,
      "--json",
    ]);
    expect(result, result.stderr).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      projectId: source.project.id,
      tasks: 3,
    });
    expect(
      source.harness.sdk.calls
        .filter((call) => call.path.startsWith("files."))
        .every(
          (call) =>
            (call.args[0] as { hostId: string }).hostId === "host_export",
        ),
    ).toBe(true);
    const exportResult = await target.harness.runCli([
      "export",
      "--project",
      source.project.id,
      "--out",
      join(dirname(out), "cli-export"),
      "--json",
    ]);
    expect(exportResult, exportResult.stderr).toMatchObject({ exitCode: 0 });
    expect(JSON.parse(exportResult.stdout)).toMatchObject({
      tasks: 3,
      attachments: 2,
    });
  });
});

it("round-trips owner execution and requester by ID in the latest format and defaults old archives to agent", async () => {
  const source = await seed();
  source.store.tasks.updateTask(source.task.id, {
    executionTarget: "owner",
    requesterThreadId: "thr_archive_requester",
  });
  const out = join(await directory(), "owner-v5");
  await exportProject(source.bb, source.store, source.project.id, out);
  const manifestPath = join(out, "project.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  expect(manifest.version).toBe(14);
  const target = setup();
  await importProject(target.bb, target.store, out, false);
  expect(target.store.tasks.getTask(source.task.id)).toEqual(
    source.store.tasks.getTask(source.task.id),
  );
  expect(target.harness.sdk.callsTo("threads.send")).toHaveLength(0);
  manifest.version = 4;
  delete manifest.gitSync;
  delete manifest.project.statuses;
  await writeFile(manifestPath, jsonText(manifest));
  for (const id of manifest.taskIds) {
    const path = join(out, "tasks", `${id}.json`);
    const record = JSON.parse(await readFile(path, "utf8"));
    delete record.pullRequests;
      delete record.dependencies;
    delete record.task.executionTarget;
    delete record.task.requesterThreadId;
    await writeFile(path, jsonText(record));
  }
  const legacy = setup();
  await importProject(legacy.bb, legacy.store, out, false);
  expect(legacy.store.tasks.getTask(source.task.id)).toMatchObject({
    executionTarget: "agent",
    requesterThreadId: null,
  });
});


it("round-trips configurable project statuses, their order and custom task stages in v10", async () => {
  const source = await seed();
  const statuses: TaskStatusDefinition[] = DEFAULT_TASK_STATUSES.map((status) => ({ ...status }));
  statuses[2]!.name = "Development";
  statuses.splice(4, 0, { id: "in_testing", name: "In testing", icon: "testing", color: "steelblue" });
  const workflowPolicy = workflowPolicySchema.parse({ bugfixStatus: "repair" });
  source.store.tasks.updateProject(source.project.id, { statuses, workflowPolicy, autoArchiveAfterDays: "14", staleIdleMinutes: "120" });
  source.store.tasks.updateTask(source.task.id, { status: "in_testing" });
  source.bb.storage.database().prepare("INSERT OR IGNORE INTO task_activity_history(task_id) VALUES (?)").run(source.task.id);
  const out = join(await directory(), "statuses-v6");
  await exportProject(source.bb, source.store, source.project.id, out);
  const manifest = JSON.parse(await readFile(join(out, "project.json"), "utf8"));
  expect(manifest.version).toBe(14);
  expect(manifest.project.statuses).toEqual(statuses);
  expect(manifest.project).toMatchObject({ autoArchiveAfterDays: "14", staleIdleMinutes: "120" });
  const target = setup();
  await importProject(target.bb, target.store, out, false);
  expect(target.store.tasks.getProject(source.project.id)?.statuses).toEqual(statuses);
  expect(target.store.tasks.getProject(source.project.id)?.workflowPolicy).toEqual(workflowPolicy);
  expect(target.store.tasks.getProject(source.project.id)).toMatchObject({ autoArchiveAfterDays: "14", staleIdleMinutes: "120" });
  expect(target.store.tasks.getTask(source.task.id)?.status).toBe("in_testing");
  expect(target.bb.storage.database().prepare("SELECT task_id FROM task_activity_history WHERE task_id=?").get(source.task.id)).toBeDefined();
  const again = join(await directory(), "again");
  await exportProject(target.bb, target.store, source.project.id, again);
  expect(await readFile(join(again, "project.json"), "utf8")).toBe(await readFile(join(out, "project.json"), "utf8"));
  for (const id of manifest.taskIds) expect(await readFile(join(again, "tasks", `${id}.json`), "utf8")).toBe(await readFile(join(out, "tasks", `${id}.json`), "utf8"));
  // Earlier exporters could already write status metadata under v8.
  manifest.version = 8;
  for (const id of manifest.taskIds) { const taskFile = join(out, "tasks", `${id}.json`); const row = JSON.parse(await readFile(taskFile, "utf8")); delete row.dependencies; await writeFile(taskFile, jsonText(row)); }
  delete manifest.project.autoArchiveAfterDays;
  delete manifest.project.staleIdleMinutes;
  await writeFile(join(out, "project.json"), jsonText(manifest));
  const legacy = setup();
  await importProject(legacy.bb, legacy.store, out, false);
  expect(legacy.store.tasks.getProject(source.project.id)?.statuses).toEqual(statuses);
  expect(legacy.store.tasks.getProject(source.project.id)).toMatchObject({ autoArchiveAfterDays: "off", staleIdleMinutes: "45" });
  await importProject(target.bb, target.store, out, false);
  expect(target.store.tasks.getProject(source.project.id)).toMatchObject({ autoArchiveAfterDays: "14", staleIdleMinutes: "120" });
  delete manifest.project.statuses[4].icon;
  delete manifest.project.statuses[4].color;
  await writeFile(join(out, "project.json"), jsonText(manifest));
  const plainLegacy = setup();
  await importProject(plainLegacy.bb, plainLegacy.store, out, false);
  expect(plainLegacy.store.tasks.getProject(source.project.id)?.statuses).toEqual(manifest.project.statuses);
  const prior = target.store.tasks.getProject(source.project.id);
  manifest.project.statuses = DEFAULT_TASK_STATUSES;
  await writeFile(join(out, "project.json"), jsonText(manifest));
  await expect(importProject(target.bb, target.store, out, true)).rejects.toThrow(/status not defined/);
  expect(target.store.tasks.getProject(source.project.id)).toEqual(prior);
  if (process.env.TASKS_PLUS_SAMPLE_DIR) await exportProject(source.bb, source.store, source.project.id, process.env.TASKS_PLUS_SAMPLE_DIR);
});

it.each(["tasks-plus", "agent-board"])("imports %s archives and upgrades attachment URLs without losing blobs", async (sourcePlugin) => {
  const source = await seed();
  const out = join(await directory(), "legacy");
  const oldUrl = `/api/v1/plugins/${sourcePlugin}/http/attachments/download?attachmentId=${source.attachment.id}`;
  source.store.tasks.updateTask(source.task.id, { description: `[Artifact](${oldUrl})` });
  await exportProject(source.bb, source.store, source.project.id, out);
  const path = join(out, "project.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.format = `bb-${sourcePlugin}`;
  await writeFile(path, jsonText(manifest));
  const target = setup();
  await importProject(target.bb, target.store, out, false);
  expect(target.store.tasks.getTask(source.task.id)?.description).toBe(`[Artifact](${oldUrl.replace(sourcePlugin, "work-board")})`);
  expect((await readAttachmentContent(target.store.tasks, source.attachment.id)).content).toEqual(Buffer.from([0, 255, 42, 7]));
});

// Fixture: paused/active schedules with queued, completed, one-time and expired-history results.
async function seedScheduled() {
  const source = await seed();
  const scheduled = createScheduledStore(source.bb, source.store);
  const now = new Date("2026-11-01T08:00:00Z");
  const rule = { kind: "daily" as const, time: "09:00", timezone: "UTC" };
  const recurring = scheduled.create({ projectId: source.project.id, title: "Daily check", rule, target: { kind: "thread", threadId: "thr_server_local" } }, now);
  const done = scheduled.reserve(recurring.id, "slot:done", "2026-11-01T09:00:00.000Z", now).run;
  const doneTask = scheduled.createRunTask(done.id);
  scheduled.markStarted(done.id, { threadId: "thr_server_local", requestId: "req_done", title: "Worker", presetName: "Existing thread" }, now);
  source.store.tasks.updateTask(doneTask.id, { status: "done" });
  scheduled.updateRun(done.id, { state: "completed", finishedAt: now.toISOString(), queueId: "q_done" }, now);
  const queued = scheduled.reserve(recurring.id, "slot:queued", "2026-11-02T09:00:00.000Z", now).run;
  const queuedTask = scheduled.createRunTask(queued.id);
  scheduled.updateRun(queued.id, { state: "queued", threadId: "thr_server_local", queueId: "q_live", requestId: "req_live" }, now);
  const once = scheduled.create({ projectId: source.project.id, title: "Once", rule: { kind: "once", at: "2026-12-01T09:00:00+00:00", timezone: "UTC" }, target: { kind: "preset", presetId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" } }, now);
  const onceRun = scheduled.reserve(once.id, "once", "2026-12-01T09:00:00.000Z", now).run;
  const onceTask = scheduled.createRunTask(onceRun.id);
  scheduled.markStarted(onceRun.id, { threadId: "thr_once", requestId: "req_once", title: "Once", presetName: "Preset" }, now);
  scheduled.updateRun(onceRun.id, { state: "failed", reason: "Agent failed" }, now);
  // Expired history and a deleted schedule must still leave the result task and its provenance.
  const gone = scheduled.create({ projectId: source.project.id, title: "Deleted schedule", rule, target: { kind: "thread", threadId: "thr_gone" } }, now);
  const old = scheduled.reserve(gone.id, "slot:gone", "2026-10-01T09:00:00.000Z", now).run;
  const goneTask = scheduled.createRunTask(old.id);
  scheduled.markStarted(old.id, { threadId: "thr_gone", requestId: "req_gone", title: "Gone", presetName: "Existing thread" }, now);
  scheduled.updateRun(old.id, { state: "completed", finishedAt: "2026-10-01T09:05:00.000Z" }, now);
  const expired = scheduled.reserve(gone.id, "slot:expired", "2026-10-02T09:00:00.000Z", now).run;
  const expiredTask = scheduled.createRunTask(expired.id);
  scheduled.markStarted(expired.id, { threadId: "thr_gone", requestId: "req_expired", title: "Gone", presetName: "Existing thread" }, now);
  scheduled.updateRun(expired.id, { state: "completed", finishedAt: "2026-10-02T09:05:00.000Z" }, now);
  scheduled.cleanup(new Date("2026-11-02T00:00:00Z"));
  expect(() => scheduled.run(expired.id)).toThrow();
  // Unresolved incidents are never age-deleted, so this run outlives its deleted schedule.
  const goneRun = scheduled.reserve(gone.id, "slot:incident", "2026-11-01T09:00:00.000Z", now).run;
  scheduled.updateRun(goneRun.id, { state: "failed", reason: "Target unavailable" }, now);
  scheduled.remove(gone.id);
  return { ...source, scheduled, recurring, once, gone, done, queued, onceRun, goneRun, expired, doneTask, queuedTask, onceTask, goneTask, expiredTask };
}

describe("archive v13 scheduled tasks", () => {
  it("round-trips definitions, provenance and run history as paused, unassigned, historical records", async () => {
    const f = await seedScheduled();
    const out = join(await directory(), "scheduled-v13");
    await exportProject(f.bb, f.store, f.project.id, out);
    const manifest = JSON.parse(await readFile(join(out, "project.json"), "utf8"));
    expect(manifest.version).toBe(14);
    expect(manifest.schedules).toHaveLength(2);
    expect(JSON.stringify(manifest)).not.toMatch(/thr_server_local|thr_gone|q_live|req_live|01ARZ3NDEKTSV4RRFFQ69G5FAV/);
    const target = setup();
    await importProject(target.bb, target.store, out, false);
    const scheduled = createScheduledStore(target.bb, target.store);
    const imported = scheduled.get(f.recurring.id);
    expect(imported).toMatchObject({ enabled: false, nextDueAt: null, target: { kind: "unassigned" }, rule: f.recurring.rule, title: "Daily check" });
    expect(scheduled.get(f.once.id)).toMatchObject({ enabled: false, nextDueAt: null, target: { kind: "unassigned" }, rule: f.once.rule });
    // Queued work is retained as history only: no live IDs, never returned to the runtime.
    expect(scheduled.pending()).toEqual([]);
    expect(scheduled.run(f.queued.id)).toMatchObject({ state: "queued", historical: true, threadId: null, queueId: null, requestId: null, occurrenceKey: "slot:queued", taskId: f.queuedTask.id });
    expect(scheduled.run(f.done.id)).toMatchObject({ state: "completed", historical: true, threadId: null, queueId: null });
    expect(scheduled.run(f.onceRun.id)).toMatchObject({ state: "failed", reason: "Agent failed", historical: true });
    expect(scheduled.source(f.doneTask.id)).toEqual(f.scheduled.source(f.doneTask.id));
    expect(scheduled.source(f.queuedTask.id)).toMatchObject({ role: "recurring_run", startedAt: null, runId: f.queued.id, occurrenceKey: "slot:queued" });
    expect(scheduled.source(f.onceTask.id)).toMatchObject({ role: "one_time_run", runId: f.onceRun.id });
    // Results of a deleted schedule and of expired history keep their independent provenance.
    expect(scheduled.run(f.goneRun.id)).toMatchObject({ scheduleId: f.gone.id, state: "failed", reason: "Target unavailable" });
    expect(() => scheduled.get(f.gone.id)).toThrow();
    expect(() => scheduled.run(f.expired.id)).toThrow();
    for (const task of [f.goneTask, f.expiredTask]) expect(scheduled.source(task.id)).toEqual(f.scheduled.source(task.id));
    expect(scheduled.source(f.expiredTask.id)).toMatchObject({ scheduleId: f.gone.id, scheduleTitle: "Deleted schedule", runId: f.expired.id, occurrenceKey: "slot:expired", role: "recurring_run" });
    // Old occurrence keys still prevent a duplicate send after resume.
    expect(scheduled.reserve(f.recurring.id, "slot:queued", "2026-11-02T09:00:00.000Z")).toMatchObject({ created: false, run: { id: f.queued.id } });
    expect(() => scheduled.reserve(f.gone.id, "slot:expired", "2026-10-02T09:00:00.000Z")).toThrow("already ran");
    // Hidden templates and pre-start instances stay out of the ordinary list; direct and result lookups keep them.
    const ordinary = target.store.tasks.listTasks({ projectId: f.project.id, ordinaryOnly: true }).map(task => task.id);
    expect(ordinary).not.toContain(f.recurring.templateTaskId);
    expect(ordinary).not.toContain(f.queuedTask.id);
    expect(ordinary).toContain(f.onceTask.id);
    expect(target.store.tasks.getTask(f.recurring.templateTaskId)).toBeDefined();
    expect(scheduled.results({ projectId: f.project.id, limit: 100 }).results.map(result => result.task.id).sort())
      .toEqual([f.doneTask.id, f.queuedTask.id, f.onceTask.id, f.goneTask.id, f.expiredTask.id].sort());
    const again = join(await directory(), "again");
    await exportProject(target.bb, target.store, f.project.id, again);
    expect(await readFile(join(again, "project.json"), "utf8")).toBe(await readFile(join(out, "project.json"), "utf8"));
    // Re-importing on its own server keeps live queue IDs; a second import changes nothing.
    await importProject(f.bb, f.store, out, true);
    expect(f.scheduled.run(f.queued.id)).toMatchObject({ queueId: "q_live", historical: false });
    expect(f.scheduled.get(f.recurring.id)).toMatchObject({ enabled: false, target: { kind: "unassigned" } });
  });

  it("imports v1-v12 archives without schedules and refuses scheduled data below v13", async () => {
    const f = await seedScheduled();
    const out = join(await directory(), "old");
    await exportProject(f.bb, f.store, f.project.id, out);
    const path = join(out, "project.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.version = 12;
    await writeFile(path, jsonText(manifest));
    await expect(importProject(setup().bb, setup().store, out, false)).rejects.toThrow(/require archive v13/);
    delete manifest.schedules;
    delete manifest.scheduleSources;
    delete manifest.scheduleRuns;
    await writeFile(path, jsonText(manifest));
    const target = setup();
    await importProject(target.bb, target.store, out, false);
    const scheduled = createScheduledStore(target.bb, target.store);
    expect(scheduled.list({}).schedules).toEqual([]);
    expect(scheduled.runs({}).runs).toEqual([]);
    expect(target.store.tasks.getTask(f.queuedTask.id)).toBeDefined();
  });

  it.each([
    ["a template that belongs to another schedule", (m: any) => { m.scheduleSources.find((s: any) => s.role === "template").scheduleId = "00000000-0000-4000-8000-000000000001"; }],
    ["a schedule without its template source", (m: any) => { m.scheduleSources = m.scheduleSources.filter((s: any) => s.role !== "template"); }],
    ["a source for an unknown task", (m: any) => { m.scheduleSources[0].taskId = "task_missing"; }],
    ["a run from another project", (m: any) => { m.scheduleRuns[0].projectId = "other_project"; }],
    ["a run linked to an unrelated task", (m: any) => { m.scheduleRuns[0].taskId = m.taskIds.find((id: string) => !m.scheduleSources.some((s: any) => s.taskId === id)); }],
    ["a source that disagrees with its retained run", (m: any) => { m.scheduleSources.find((s: any) => s.runId).occurrenceKey = "slot:other"; }],
    ["duplicate occurrence keys", (m: any) => { m.scheduleRuns[1].occurrenceKey = m.scheduleRuns[0].occurrenceKey; m.scheduleRuns[1].scheduleId = m.scheduleRuns[0].scheduleId; }],
  ])("rejects %s before changing existing project data", async (_name, tamper) => {
    const f = await seedScheduled();
    const out = join(await directory(), "invalid");
    await exportProject(f.bb, f.store, f.project.id, out);
    const target = setup();
    await importProject(target.bb, target.store, out, false);
    target.store.tasks.updateTask(f.task.id, { title: "Local edit" });
    const before = target.store.tasks.listTasks({ projectId: f.project.id });
    const path = join(out, "project.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    tamper(manifest);
    await writeFile(path, jsonText(manifest));
    await expect(importProject(target.bb, target.store, out, true)).rejects.toThrow();
    expect(target.store.tasks.listTasks({ projectId: f.project.id })).toEqual(before);
  });

  it("rejects orphan provenance pointing at another project's local run without writes", async () => {
    const f = await seedScheduled();
    const target = await seedScheduled();
    target.bb.storage.database().prepare("DELETE FROM task_key_aliases").run();
    target.bb.storage.database().prepare("UPDATE projects SET prefix = ? WHERE id = ?").run("OTHER", target.project.id);
    const out = join(await directory(), "foreign-run");
    await exportProject(f.bb, f.store, f.project.id, out);
    const path = join(out, "project.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.scheduleSources.find((s: any) => s.taskId === f.expiredTask.id).runId = target.queued.id;
    await writeFile(path, jsonText(manifest));
    const before = target.scheduled.run(target.queued.id);
    await expect(importProject(target.bb, target.store, out, false)).rejects.toThrow(/referenced scheduled run/);
    expect(target.store.tasks.getProject(f.project.id)).toBeUndefined();
    expect(target.scheduled.run(target.queued.id)).toEqual(before);
  });

  it("does not update a different run when a source is corrupted", async () => {
    const f = await seedScheduled();
    const db = f.bb.storage.database();
    db.prepare("UPDATE task_scheduled_sources SET run_id=? WHERE task_id=?").run(f.queued.id, f.doneTask.id);
    const before = f.scheduled.run(f.queued.id);
    f.store.tasks.updateTask(f.doneTask.id, { status: "todo" });
    expect(f.scheduled.run(f.queued.id)).toEqual(before);
  });

  it("refuses to replace a live local run or an occurrence owned by another run", async () => {
    const f = await seedScheduled();
    const out = join(await directory(), "conflict");
    await exportProject(f.bb, f.store, f.project.id, out);
    const path = join(out, "project.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.scheduleRuns.find((run: any) => run.id === f.queued.id).reason = "Edited elsewhere";
    await writeFile(path, jsonText(manifest));
    await expect(importProject(f.bb, f.store, out, true)).rejects.toThrow(/active scheduled run/);
    expect(f.scheduled.run(f.queued.id)).toMatchObject({ queueId: "q_live", reason: null });
  });
});
