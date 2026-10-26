import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, cp, copyFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore } from "./api";
import {
  registerAttachments,
  saveAttachmentFromBytes,
  readAttachmentContent,
} from "./attachments";
import { createStructuredStore } from "./structured/store";
import { createGitSyncStore } from "./git-sync/store";
import { gitSyncConfigSchema, prLinkSchema } from "./shared/git-sync";
import { captureProject, archiveRecords } from "./archive/storage";
import { archiveProjectSchema, jsonText } from "./archive/contract";

it.each(["tasks-plus", "agent-board"])("migrates %s database and blobs while preserving task IDs, answers and PR settings", async (sourcePlugin) => {
  const root = await mkdtemp(join(tmpdir(), "work-board-migration-"));
  const sourcePath = join(root, sourcePlugin);
  const targetPath = join(root, "work-board");
  const source = createFakePluginHost({
    pluginId: sourcePlugin,
    dataDir: sourcePath,
  });
  let target: ReturnType<typeof createFakePluginHost> | undefined;
  let sourceDisposed = false;
  try {
    const store = createStore(source.bb);
    registerAttachments(source.bb, store.tasks);
    const project = store.tasks.createProject({
      name: "Rename sample",
      prefix: "REN",
      color: "purple",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Preserve the owner's decision",
      executionTarget: "owner",
      requesterThreadId: "thr_requester",
    });
    const attachment = await saveAttachmentFromBytes(
      store.tasks,
      Buffer.from("Sample artifact\n"),
      { taskId: task.id, fileName: "sample.txt" },
    );
    const legacyUrl = `/api/v1/plugins/${sourcePlugin}/http/attachments/download?attachmentId=${attachment.id}`;
    store.tasks.updateTask(task.id, {
      description: `[Artifact](${legacyUrl})`,
    });
    store.tasks.createComment({
      taskId: task.id,
      kind: "user",
      authorName: "Owner",
      threadId: null,
      body: "Decision context",
    });
    const structured = createStructuredStore(source.bb, store);
    const { question } = await structured.handlers.createQuestion({
      taskId: task.id,
      prompt: "Which outcome?",
      mode: "single",
      allowOther: true,
      options: [
        {
          label: "Keep",
          recommended: true,
          recommendationReason: "Preserve all records",
        },
        "Replace",
      ],
    });
    const { question: answered } = await structured.handlers.answerQuestion({
      questionId: question.id,
      selectedOptionIds: [question.options[0]!.id],
      revision: question.revision,
      authorName: "Owner",
      answerText: null,
    });
    await structured.handlers.setTemplate({
      projectId: project.id,
      name: "task",
      body: "**Done when:** records are preserved.",
      labelId: null,
    });
    const git = createGitSyncStore(source.bb.storage.database());
    git.setConfig(
      project.id,
      gitSyncConfigSchema.parse({
        enabled: false,
        repositories: ["example/service"],
        pollMinutes: 10,
      }),
    );
    const now = new Date().toISOString();
    git.saveLink(
      prLinkSchema.parse({
        taskId: task.id,
        provider: "github",
        host: "github.com",
        repository: "example/service",
        number: 42,
        url: "https://github.com/example/service/pull/42",
        remoteId: null,
        role: "delivers",
        part: null,
        source: "manual",
        confirmed: true,
        excluded: false,
        createdAt: now,
        updatedAt: now,
      }),
    );
    const before = captureProject(source.bb, store, project.id);
    execFileSync("python3", [
      "-c",
      "from pathlib import Path; import sys; sys.path.insert(0, sys.argv[1]); from import_tasks import import_tasks; import_tasks(Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4])",
      resolve("scripts"),
      dirname(source.bb.storage.database().prepare<[], { file: string }>("PRAGMA database_list").all()[0]!.file),
      targetPath,
      sourcePlugin,
    ]);
    target = createFakePluginHost({
      pluginId: "work-board",
      dataDir: targetPath,
    });
    await source.harness.dispose();
    sourceDisposed = true;
    const targetDatabase = target.bb.storage.database();
    const targetDatabasePath = targetDatabase.prepare<[], { file: string }>("PRAGMA database_list").all()[0]!.file;
    targetDatabase.close();
    await copyFile(join(targetPath, "data.db"), targetDatabasePath);
    await cp(join(targetPath, "blobs"), join(dirname(targetDatabasePath), "blobs"), { recursive: true });
    const migrated = createStore(target.bb);
    registerAttachments(target.bb, migrated.tasks);
    expect(migrated.tasks.getTask(task.id)).toMatchObject({
      key: task.key,
      executionTarget: "owner",
      requesterThreadId: "thr_requester",
      description: legacyUrl
        .replace(sourcePlugin, "work-board")
        .replace(/^/, "[Artifact](")
        .concat(")"),
    });
    expect(
      createStructuredStore(target.bb, migrated).listQuestions(task.id)[0],
    ).toEqual(answered);
    expect(
      createGitSyncStore(target.bb.storage.database()).config(project.id),
    ).toEqual(before.manifest.gitSync);
    expect(
      (
        await readAttachmentContent(migrated.tasks, attachment.id)
      ).content.toString(),
    ).toBe("Sample artifact\n");
    const after = captureProject(target.bb, migrated, project.id);
    expect(after.manifest.format).toBe("bb-work-board");
    expect(after.records).toEqual(
      JSON.parse(
        JSON.stringify(before.records).replaceAll(
          `/plugins/${sourcePlugin}/`,
          "/plugins/work-board/",
        ),
      ),
    );
    expect(
      archiveProjectSchema.parse({ ...after.manifest, format: "bb-tasks-plus" })
        .format,
    ).toBe("bb-tasks-plus");
    const output = process.env.WORK_BOARD_RENAME_SAMPLE_DIR;
    if (output && sourcePlugin === "agent-board") {
      await mkdir(join(output, "tasks"), { recursive: true });
      await mkdir(join(output, "attachments"), { recursive: true });
      const records = await archiveRecords(
        migrated,
        after,
        (id, bytes) => writeFile(join(output, "attachments", id), bytes),
      );
      await writeFile(join(output, "project.json"), jsonText(after.manifest));
      for (const record of records)
        await writeFile(
          join(output, "tasks", `${record.task.id}.json`),
          jsonText(record),
        );
    }
  } finally {
    if (!sourceDisposed) await source.harness.dispose();
    await target?.harness.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
