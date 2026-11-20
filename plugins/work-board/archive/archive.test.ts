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
import { createPlanStore } from "../plans/store";
import { createPlanNoteStore } from "../plans/notes";

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
  source.store.tasks.updateProject(project.id, { planning: "optional" });
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
    const { question } = await structured.handlers.createQuestion({ kind: "decision", askedByThread: null,
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
    const { question } = await structured.handlers.createQuestion({ kind: "decision", askedByThread: null,
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
    ).toEqual([{ ...question, allowOther: false }]);
  });

  it("rejects foreign or invalid answers on import, even with overwrite", async () => {
    const source = await seed();
    const structured = createStructuredStore(source.bb, source.store);
    await structured.handlers.createQuestion({ kind: "decision", askedByThread: null,
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

it("exports v17 typed questions and imports v16 owner tasks as plain tasks", async () => {
  const source = await seed();
  const structured = createStructuredStore(source.bb, source.store);
  await structured.handlers.createQuestion({ kind: "check", askedByThread: "thr_asker", taskId: source.task.id, prompt: "Validate?", mode: "single", options: [] });
  const out = join(await directory(), "v17");
  await exportProject(source.bb, source.store, source.project.id, out);
  const manifestPath = join(out, "project.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  expect(manifest.version).toBe(20);
  const path = join(out, "tasks", `${source.task.id}.json`);
  const record = JSON.parse(await readFile(path, "utf8"));
  expect(record.task).not.toHaveProperty("executionTarget");
  expect(record.task).not.toHaveProperty("requesterThreadId");
  expect(record.questions[0]).toMatchObject({ kind: "check", askedByThread: "thr_asker" });
  expect(record.questions[0]).not.toHaveProperty("verdict");
  const target = setup();
  await importProject(target.bb, target.store, out, false);
  expect(createStructuredStore(target.bb, target.store).listQuestions(source.task.id)).toEqual(structured.listQuestions(source.task.id));
  manifest.version = 16;
  await writeFile(manifestPath, jsonText(manifest));
  record.task.executionTarget = "owner";
  record.task.requesterThreadId = "thr_legacy";
  delete record.questions[0].kind;
  delete record.questions[0].askedByThread;
  await writeFile(path, jsonText(record));
  const legacy = setup();
  await importProject(legacy.bb, legacy.store, out, false);
  expect(legacy.store.tasks.getTask(source.task.id)).toEqual(source.store.tasks.getTask(source.task.id));
  expect(createStructuredStore(legacy.bb, legacy.store).listQuestions(source.task.id)[0]).toMatchObject({ kind: "decision", askedByThread: null });
  expect(legacy.harness.sdk.callsTo("threads.send")).toHaveLength(0);
});


it("exports plans (v18+) with every version, refuses a differing local plan without --overwrite and ignores plans in older archives", async () => {
  const source = await seed();
  const author = { kind: "agent" as const, threadId: "thr_example", name: "agent (thr_example)" };
  const sourcePlans = createPlanStore(source.bb.storage.database(), source.store.tasks);
  const write = (plans: typeof sourcePlans, taskId: string, input: object) => plans.save({ taskId, summary: "Edit", author, ...input } as Parameters<typeof plans.save>[0]);
  write(sourcePlans, source.task.id, { op: "replace", baseVersion: 0, body: "# Plan\n\n## Steps\n- one\n" });
  write(sourcePlans, source.task.id, { op: "section", baseVersion: 1, section: "Steps", body: "## Steps\n- one\n- two\n" });
  sourcePlans.submit(source.task.id, author, "thr_reviewer");
  const out = join(await directory(), "plans-v18");
  await exportProject(source.bb, source.store, source.project.id, out);
  const manifestPath = join(out, "project.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  expect(manifest.version).toBe(20);
  const recordPath = join(out, "tasks", `${source.task.id}.json`);
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  expect(record.plan).toMatchObject({ format: "markdown", version: 2, state: "in_review", body: "# Plan\n\n## Steps\n- one\n- two\n", reviewer: { kind: "thread", threadId: "thr_reviewer" }, reviewVersion: 2 });
  expect(record.planReviews).toMatchObject([{ version: 2, reviewer: { kind: "thread", threadId: "thr_reviewer" }, outcome: "pending" }]);
  expect(record.plan.versions.map((version: { version: number; op: string }) => [version.version, version.op])).toEqual([[1, "create"], [2, "section"]]);
  expect(record.plan.versions[0].body).toBe("# Plan\n\n## Steps\n- one\n");

  const target = setup();
  await importProject(target.bb, target.store, out, false);
  const targetPlans = createPlanStore(target.bb.storage.database(), target.store.tasks);
  expect(targetPlans.capture(source.task.id)).toEqual(sourcePlans.capture(source.task.id));
  expect(targetPlans.captureReviews(source.task.id)).toEqual(sourcePlans.captureReviews(source.task.id));
  // The restored task logs (system comments) travel with it, and a second export is byte-identical.
  const again = join(await directory(), "plans-again");
  await exportProject(target.bb, target.store, source.project.id, again);
  expect(await readFile(join(again, "tasks", `${source.task.id}.json`), "utf8")).toBe(await readFile(recordPath, "utf8"));
  await importProject(target.bb, target.store, out, false);

  write(targetPlans, source.task.id, { op: "replace", baseVersion: 2, body: "# Local edit\n" });
  await expect(importProject(target.bb, target.store, out, false)).rejects.toThrow(/Import conflict: plan .* use --overwrite/);
  expect(targetPlans.head(source.task.id)?.version).toBe(3);
  await importProject(target.bb, target.store, out, true);
  expect(targetPlans.capture(source.task.id)).toEqual(sourcePlans.capture(source.task.id));
  expect(targetPlans.listVersions(source.task.id).versions).toHaveLength(2);

  // v17 archives have no plan key: they import and leave the local plan alone.
  manifest.version = 17;
  await writeFile(manifestPath, jsonText(manifest));
  delete record.plan;
  delete record.planReviews;
  await writeFile(recordPath, jsonText(record));
  write(targetPlans, source.task.id, { op: "replace", baseVersion: 2, body: "# Newer local\n" });
  await importProject(target.bb, target.store, out, true);
  expect(targetPlans.get(source.task.id)?.requested.body).toBe("# Newer local\n");
  const fresh = setup();
  await importProject(fresh.bb, fresh.store, out, false);
  expect(createPlanStore(fresh.bb.storage.database(), fresh.store.tasks).head(source.task.id)).toBeNull();

  // v18 requires the key, older versions refuse real plan data, and a plan must be internally consistent.
  manifest.version = 18;
  await writeFile(manifestPath, jsonText(manifest));
  await expect(importProject(setup().bb, setup().store, out, false)).rejects.toThrow(/Archive v18 requires plan/);
  const inconsistent = { ...sourcePlans.capture(source.task.id)!, version: 5 };
  await writeFile(recordPath, jsonText({ ...record, plan: inconsistent }));
  await expect(importProject(setup().bb, setup().store, out, false)).rejects.toThrow(/does not match its latest version/);
  manifest.version = 17;
  await writeFile(manifestPath, jsonText(manifest));
  await writeFile(recordPath, jsonText({ ...record, plan: sourcePlans.capture(source.task.id) }));
  await expect(importProject(setup().bb, setup().store, out, false)).rejects.toThrow(/require archive v18/);
});


it("exports v19 plan notes with their replies, refuses differing local notes without --overwrite and ignores notes in older archives", async () => {
  const source = await seed();
  const author = { kind: "agent" as const, threadId: "thr_example", name: "agent (thr_example)" };
  const person = { kind: "person" as const, threadId: null, name: "Owner" };
  const planStoreOf = (host: Awaited<ReturnType<typeof seed>>) => createPlanStore(host.bb.storage.database(), host.store.tasks);
  const notesOf = (host: Awaited<ReturnType<typeof seed>>) => createPlanNoteStore(host.bb.storage.database(), host.store.tasks, planStoreOf(host).head);
  const sourcePlans = planStoreOf(source);
  const sourceNotes = notesOf(source);
  sourcePlans.save({ taskId: source.task.id, op: "replace", baseVersion: 0, body: "# Plan\n\n## Steps\n- one\n", summary: "First", author });
  sourceNotes.create({ taskId: source.task.id, kind: "comment", exact: "one", prefix: "Steps - ", suffix: "", headingPath: "Steps", body: "Say more.", authorName: "Owner" });
  sourceNotes.create({ taskId: source.task.id, kind: "general", body: "Add a rollback.", authorName: "Owner" });
  sourceNotes.sendFeedback(source.task.id, person);
  sourceNotes.reply({ taskId: source.task.id, number: 1, body: "Added detail.", addressed: true, author });
  const out = join(await directory(), "notes-v19");
  await exportProject(source.bb, source.store, source.project.id, out);
  const recordPath = join(out, "tasks", `${source.task.id}.json`);
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  expect(record.planNotes.map((note: { number: number; state: string; taskId?: string }) => [note.number, note.state, note.taskId])).toEqual([[1, "addressed", undefined], [2, "sent", undefined]]);
  expect(record.planNotes[0]).toMatchObject({ kind: "comment", exact: "one", headingPath: "Steps", reply: "Added detail.", replyBy: author.name, addressedInVersion: 1, sentInVersion: 1 });

  const target = setup();
  await importProject(target.bb, target.store, out, false);
  const targetNotes = notesOf(target as never);
  expect(targetNotes.capture(source.task.id)).toEqual(sourceNotes.capture(source.task.id));
  const again = join(await directory(), "notes-again");
  await exportProject(target.bb, target.store, source.project.id, again);
  expect(await readFile(join(again, "tasks", `${source.task.id}.json`), "utf8")).toBe(await readFile(recordPath, "utf8"));
  await importProject(target.bb, target.store, out, false);

  targetNotes.create({ taskId: source.task.id, kind: "general", body: "Local note.", authorName: "Owner" });
  await expect(importProject(target.bb, target.store, out, false)).rejects.toThrow(/Import conflict: plan notes .* use --overwrite/);
  await importProject(target.bb, target.store, out, true);
  expect(targetNotes.capture(source.task.id)).toEqual(sourceNotes.capture(source.task.id));

  // v18 archives have no notes key: they import and leave local notes alone; v19 requires the key; older versions refuse notes.
  const manifestPath = join(out, "project.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.version = 18;
  await writeFile(manifestPath, jsonText(manifest));
  const { planNotes, ...withoutNotes } = record;
  await writeFile(recordPath, jsonText(withoutNotes));
  targetNotes.create({ taskId: source.task.id, kind: "general", body: "Newer local.", authorName: "Owner" });
  await importProject(target.bb, target.store, out, true);
  expect(targetNotes.list(source.task.id)).toHaveLength(3);
  manifest.version = 19;
  await writeFile(manifestPath, jsonText(manifest));
  await expect(importProject(setup().bb, setup().store, out, false)).rejects.toThrow(/Archive v19 requires planNotes/);
  manifest.version = 18;
  await writeFile(manifestPath, jsonText(manifest));
  await writeFile(recordPath, jsonText({ ...withoutNotes, planNotes }));
  await expect(importProject(setup().bb, setup().store, out, false)).rejects.toThrow(/Plan notes require archive v19/);
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
  expect(manifest.version).toBe(20);
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
    expect(manifest.version).toBe(20);
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

it("round-trips v16 current state and imports v15 without it", async () => {
  const source = await seed();
  source.store.tasks.updateTask(source.task.id, { progressNote: "Ready for review", authorName: "thr_responsible" });
  const out = join(await directory(), "progress-v16");
  await exportProject(source.bb, source.store, source.project.id, out);
  const manifestPath = join(out, "project.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  expect(manifest.version).toBe(20);
  const target = setup();
  await importProject(target.bb, target.store, out, false);
  expect(target.store.tasks.getTask(source.task.id)).toEqual(source.store.tasks.getTask(source.task.id));
  manifest.version = 15;
  await writeFile(manifestPath, jsonText(manifest));
  for (const id of manifest.taskIds) {
    const path = join(out, "tasks", `${id}.json`);
    const record = JSON.parse(await readFile(path, "utf8"));
    delete record.task.progressNote;
    delete record.task.progressUpdatedAt;
    delete record.task.progressUpdatedBy;
    await writeFile(path, jsonText(record));
  }
  const legacy = setup();
  await importProject(legacy.bb, legacy.store, out, false);
  expect(legacy.store.tasks.getTask(source.task.id)).toMatchObject({ progressNote: null, progressUpdatedAt: null, progressUpdatedBy: null });
});

describe("archive v20: reviewers, review history and planning", () => {
  const authorA = { kind: "agent" as const, threadId: "thr_example", name: "agent (thr_example)" };
  const reviewerA = { kind: "agent" as const, threadId: "thr_reviewer_a", name: "agent (thr_reviewer_a)" };
  const owner = { kind: "person" as const, threadId: null, name: "Owner" };

  /** A task whose plan went through two reviewers on the same version, with a reviewer note that was sent. */
  async function reviewed() {
    const source = await seed();
    const db = source.bb.storage.database();
    const plans = createPlanStore(db, source.store.tasks);
    const notes = createPlanNoteStore(db, source.store.tasks, plans.head);
    plans.save({ taskId: source.task.id, op: "replace", baseVersion: 0, body: "# Plan\n\n## Steps\n- one\n", summary: "Plan", author: authorA });
    plans.submit(source.task.id, authorA, "thr_reviewer_a");
    notes.createByReviewer({ taskId: source.task.id, by: reviewerA, version: 1, body: "Say more.", quote: "one" });
    plans.submit(source.task.id, authorA, "thr_reviewer_b");
    return { ...source, db, plans, notes };
  }
  /** Rewrites an exported v20 snapshot as a v19 one: no planning, reviewers, review history or note authors; legacy notes are resolved. */
  async function toV19(out: string) {
  const manifestPath = join(out, "project.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.version = 19;
  delete manifest.project.planning;
  await writeFile(manifestPath, jsonText(manifest));
  for (const id of manifest.taskIds) {
    const path = join(out, "tasks", `${id}.json`);
    const record = JSON.parse(await readFile(path, "utf8"));
    delete record.planReviews;
    if (record.plan) {
      delete record.plan.reviewer;
      delete record.plan.reviewVersion;
      record.plan.state = "in_review";
    }
    for (const note of record.planNotes ?? []) {
      delete note.authorKind;
      delete note.authorThread;
      // An old owner's draft would block the owner's approval; the legacy note here is already resolved.
      note.state = "resolved";
      note.sentInVersion = 1;
      note.sentAt = note.createdAt;
    }
    await writeFile(path, jsonText(record));
  }
  }

  const exported = async (source: Awaited<ReturnType<typeof seed>>, name: string) => {
    const out = join(await directory(), name);
    await exportProject(source.bb, source.store, source.project.id, out);
    return out;
  };

  it("round-trips an off project with its setting, plans, notes with their authors, and both reviewers' attempts", async () => {
    const source = await reviewed();
    source.store.tasks.updateProject(source.project.id, { planning: "off" });
    const out = await exported(source, "v20-off");
    const record = JSON.parse(await readFile(join(out, "tasks", `${source.task.id}.json`), "utf8"));
    expect(JSON.parse(await readFile(join(out, "project.json"), "utf8")).project.planning).toBe("off");
    expect(record.plan.reviewer).toEqual({ kind: "thread", threadId: "thr_reviewer_b" });
    expect(record.planNotes[0]).toMatchObject({ authorKind: "thread", authorThread: "thr_reviewer_a" });
    expect(record.planReviews.map((review: { reviewer: { threadId: string }; outcome: string }) => [review.reviewer.threadId, review.outcome])).toEqual([["thr_reviewer_a", "reassigned"], ["thr_reviewer_b", "pending"]]);
    const target = setup();
    await importProject(target.bb, target.store, out, false);
    expect(target.store.tasks.getProject(source.project.id)!.planning).toBe("off");
    const targetPlans = createPlanStore(target.bb.storage.database(), target.store.tasks);
    expect(targetPlans.capture(source.task.id)).toEqual(source.plans.capture(source.task.id));
    expect(targetPlans.captureReviews(source.task.id)).toEqual(source.plans.captureReviews(source.task.id));
    expect(createPlanNoteStore(target.bb.storage.database(), target.store.tasks, targetPlans.head).capture(source.task.id)).toEqual(source.notes.capture(source.task.id));
    // A second export of the imported project is byte-identical.
    const again = join(await directory(), "v20-again");
    await exportProject(target.bb, target.store, source.project.id, again);
    expect(await readFile(join(again, "tasks", `${source.task.id}.json`), "utf8")).toBe(await readFile(join(out, "tasks", `${source.task.id}.json`), "utf8"));
  });

  it("never changes the planning of an existing project, or when and from what it changed, with or without --overwrite", async () => {
    const source = await reviewed();
    source.store.tasks.updateProject(source.project.id, { planning: "off" });
    const out = await exported(source, "v20-keep");
    // The snapshot carries the change record, and a fresh import takes it.
    const snapshot = JSON.parse(await readFile(join(out, "project.json"), "utf8")).project;
    expect(snapshot).toMatchObject({ planning: "off", planningPrevious: "optional", planningChangedAt: expect.any(String) });
    const target = setup();
    await importProject(target.bb, target.store, out, false);
    expect(target.store.tasks.getProject(source.project.id)).toMatchObject({ planning: "off", planningPrevious: "optional", planningChangedAt: snapshot.planningChangedAt });
    target.store.tasks.updateProject(source.project.id, { planning: "required" });
    const local = target.store.tasks.getProject(source.project.id)!;
    expect(local.planningPrevious).toBe("off");
    await importProject(target.bb, target.store, out, false);
    expect(target.store.tasks.getProject(source.project.id)).toMatchObject({ planning: "required", planningPrevious: "off", planningChangedAt: local.planningChangedAt });
    await importProject(target.bb, target.store, out, true);
    expect(target.store.tasks.getProject(source.project.id)).toMatchObject({ planning: "required", planningPrevious: "off", planningChangedAt: local.planningChangedAt });
  });

  it("refuses, before writing anything, a v19 overwrite that would rewind a plan below its local review history, and a v20 round trip still works", async () => {
    const source = await reviewed();
    const out = await exported(source, "v19-rewind");
    await toV19(out);
    // Locally the plan moved on to v2 and was submitted again.
    source.plans.save({ taskId: source.task.id, op: "replace", baseVersion: 1, body: "# Plan\n\n## Steps\n- one\n- two\n", summary: "Second", author: authorA });
    source.plans.submit(source.task.id, authorA, "thr_reviewer_b");
    const history = source.plans.captureReviews(source.task.id);
    expect(history.map((review) => review.version)).toEqual([1, 1, 2]);
    await expect(importProject(source.bb, source.store, out, true)).rejects.toThrow(/would be rewound to v1.*review history refers to v2/);
    expect(source.plans.head(source.task.id)?.version).toBe(2);
    expect(source.plans.captureReviews(source.task.id)).toEqual(history);
    const again = await exported(source, "v20-after-refusal");
    const target = setup();
    await importProject(target.bb, target.store, again, false);
    expect(createPlanStore(target.bb.storage.database(), target.store.tasks).captureReviews(source.task.id)).toEqual(history);
  });

  it("reads a v19 snapshot as the owner's, infers optional for a fresh project with a plan, and keeps local review history", async () => {
    const source = await reviewed();
    const out = await exported(source, "v19-legacy");
    await toV19(out);
    // A fresh project comes up optional because the snapshot has a plan; the plan is reviewable by the owner at once.
    const fresh = setup();
    await importProject(fresh.bb, fresh.store, out, false);
    expect(fresh.store.tasks.getProject(source.project.id)!.planning).toBe("optional");
    const head = (await fresh.harness.callRpc("getTaskPlan", { taskId: source.task.id })) as { plan: { state: string; reviewer: unknown } };
    expect(head.plan).toMatchObject({ state: "in_review", reviewer: { kind: "owner", threadId: null } });
    expect(await fresh.harness.callRpc("approvePlan", { taskId: source.task.id, author: owner })).toMatchObject({ ok: true, plan: { state: "approved" } });
    expect(createPlanStore(fresh.bb.storage.database(), fresh.store.tasks).captureReviews(source.task.id)).toEqual([]);

    // Over a task with local review history, the v19 snapshot leaves that history alone, even with --overwrite.
    const local = source;
    const history = local.plans.captureReviews(local.task.id);
    expect(history).toHaveLength(2);
    local.store.tasks.updateProject(local.project.id, { planning: "optional" });
    await importProject(local.bb, local.store, out, true);
    expect(local.plans.captureReviews(local.task.id)).toEqual(history);
    expect(local.store.tasks.getProject(local.project.id)!.planning).toBe("optional");
    // The imported note is the owner's note of a legacy export.
    const imported = createPlanNoteStore(local.bb.storage.database(), local.store.tasks, local.plans.head).capture(local.task.id);
    expect(imported.every((note) => note.authorKind === "person" && note.authorThread === null)).toBe(true);
  });
});

it("lets the migration turn planning on only for projects that already have a plan, as optional", async () => {
  const source = setup();
  const db = source.bb.storage.database();
  const withPlan = source.store.tasks.createProject({ name: "With plan", prefix: "WTH", color: "blue" });
  const without = source.store.tasks.createProject({ name: "Without", prefix: "WTO", color: "red" });
  const task = source.store.tasks.createTask({ projectId: withPlan.id, title: "Planned" });
  source.store.tasks.createTask({ projectId: without.id, title: "Plain" });
  const now = new Date().toISOString();
  db.prepare("INSERT INTO task_plans (task_id, format, version, body, state, updated_at, author_kind, author_thread, author_name) VALUES (?, 'markdown', 1, '# Plan', 'in_review', ?, 'agent', NULL, 'agent')").run(task.id, now);
  // Roll the 0.59.0 migration back, then apply it again to the data of an older install.
  db.exec(`
    DROP TABLE task_plan_reviews;
    ALTER TABLE task_plans DROP COLUMN reviewer_kind;
    ALTER TABLE task_plans DROP COLUMN reviewer_thread;
    ALTER TABLE task_plans DROP COLUMN review_version;
    ALTER TABLE task_plan_notes DROP COLUMN author_kind;
    ALTER TABLE task_plan_notes DROP COLUMN author_thread;
    ALTER TABLE projects DROP COLUMN planning_changed_at;
    ALTER TABLE projects DROP COLUMN planning_previous;
    ALTER TABLE projects DROP COLUMN planning;
    DELETE FROM schema_version WHERE version = (SELECT MAX(version) FROM schema_version);
  `);
  const { initializeTasksSchema } = await import("../db/schema");
  initializeTasksSchema(db);
  const planning = (id: string) => (db.prepare("SELECT planning FROM projects WHERE id = ?").get(id) as { planning: string | null }).planning;
  expect(planning(withPlan.id)).toBe("optional");
  expect(planning(without.id)).toBeNull();
  expect(source.store.tasks.getProject(without.id)!.planning).toBe("off");
  expect(source.store.tasks.getProject(withPlan.id)!.planning).toBe("optional");
  // The existing in-review plan has the owner as its reviewer and can be approved at once.
  expect(createPlanStore(db, source.store.tasks).head(task.id)).toMatchObject({ state: "in_review", reviewer: { kind: "owner", threadId: null }, reviewVersion: null });
});
