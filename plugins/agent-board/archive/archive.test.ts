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
import { DEFAULT_TASK_STATUSES } from "../shared/statuses";
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
  const { bb, harness } = createFakePluginHost({
    pluginId: "agent-board",
    sdk: {
      files: {
        read: async ({ path }: { path: string }) => {
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
  registerTasksCli(bb, store, { name: "Agent Board", version: "test" });
  return { bb, harness, store, faults };
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
    for (const id of manifest.taskIds) { const taskFile = join(out, "tasks", `${id}.json`); const row = JSON.parse(await readFile(taskFile, "utf8")); delete row.pullRequests; await writeFile(taskFile, jsonText(row)); }
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
  expect(manifest.version).toBe(8);
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


it("round-trips configurable project statuses, their order and custom task stages in v6", async () => {
  const source = await seed();
  const statuses = DEFAULT_TASK_STATUSES.map((status) => ({ ...status }));
  statuses[2]!.name = "Development";
  statuses.splice(4, 0, { id: "in_testing", name: "In testing" });
  source.store.tasks.updateProject(source.project.id, { statuses });
  source.store.tasks.updateTask(source.task.id, { status: "in_testing" });
  const out = join(await directory(), "statuses-v6");
  await exportProject(source.bb, source.store, source.project.id, out);
  const manifest = JSON.parse(await readFile(join(out, "project.json"), "utf8"));
  expect(manifest.version).toBe(8);
  expect(manifest.project.statuses).toEqual(statuses);
  const target = setup();
  await importProject(target.bb, target.store, out, false);
  expect(target.store.tasks.getProject(source.project.id)?.statuses).toEqual(statuses);
  expect(target.store.tasks.getTask(source.task.id)?.status).toBe("in_testing");
  const again = join(await directory(), "again");
  await exportProject(target.bb, target.store, source.project.id, again);
  expect(await readFile(join(again, "project.json"), "utf8")).toBe(await readFile(join(out, "project.json"), "utf8"));
  for (const id of manifest.taskIds) expect(await readFile(join(again, "tasks", `${id}.json`), "utf8")).toBe(await readFile(join(out, "tasks", `${id}.json`), "utf8"));
  const prior = target.store.tasks.getProject(source.project.id);
  manifest.project.statuses = DEFAULT_TASK_STATUSES;
  await writeFile(join(out, "project.json"), jsonText(manifest));
  await expect(importProject(target.bb, target.store, out, true)).rejects.toThrow(/status not defined/);
  expect(target.store.tasks.getProject(source.project.id)).toEqual(prior);
  if (process.env.TASKS_PLUS_SAMPLE_DIR) await exportProject(source.bb, source.store, source.project.id, process.env.TASKS_PLUS_SAMPLE_DIR);
});

it("imports legacy-branded archives and upgrades attachment URLs without losing blobs", async () => {
  const source = await seed();
  const out = join(await directory(), "legacy");
  const oldUrl = `/api/v1/plugins/tasks-plus/http/attachments/download?attachmentId=${source.attachment.id}`;
  source.store.tasks.updateTask(source.task.id, { description: `[Artifact](${oldUrl})` });
  await exportProject(source.bb, source.store, source.project.id, out);
  const path = join(out, "project.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.format = "bb-tasks-plus";
  await writeFile(path, jsonText(manifest));
  const target = setup();
  await importProject(target.bb, target.store, out, false);
  expect(target.store.tasks.getTask(source.task.id)?.description).toBe(`[Artifact](${oldUrl.replace("tasks-plus", "agent-board")})`);
  expect((await readAttachmentContent(target.store.tasks, source.attachment.id)).content).toEqual(Buffer.from([0, 255, 42, 7]));
});
