import { createFakePluginHost, type FakePluginHarness } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createStore } from "../api";
import { createGitSyncStore } from "../git-sync/store";
import { prLinkSchema } from "../shared/git-sync";
import { createStructuredStore } from "../structured/store";
import { archiveTaskSchema } from "./contract";
import { captureProject, restoreProject } from "./storage";

const harnesses: FakePluginHarness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
});

function host() {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  harnesses.push(harness);
  const db = bb.storage.database();
  const prepare = db.prepare.bind(db);
  const counter = { statements: 0 };
  // Count executed get/all/run calls, the same unit as the audit baseline.
  Object.defineProperty(db, "prepare", {
    configurable: true,
    value(sql: string) {
      const statement = prepare(sql);
      for (const method of ["all", "get", "run"] as const) {
        const call = statement[method].bind(statement);
        Object.defineProperty(statement, method, {
          configurable: true,
          value(...args: unknown[]) {
            counter.statements++;
            return call(...args);
          },
        });
      }
      return statement;
    },
  });
  return { bb, store: createStore(bb), counter };
}

type Host = ReturnType<typeof host>;

async function populate(h: Host, tasks: number, perTask: { rich: boolean }, prefix = "CAP") {
  const { bb, store } = h;
  const db = bb.storage.database();
  const structured = createStructuredStore(bb, store);
  const project = store.tasks.createProject({ name: "Capture", prefix, color: "blue" });
  const labels = ["A", "B", "C"].map((name) => store.tasks.createLabel({ projectId: project.id, name, color: "green" }));
  for (let i = 0; i < tasks; i++) {
    const task = store.tasks.createTask({ projectId: project.id, title: `Task ${i}` });
    const comment = store.tasks.createComment({ taskId: task.id, kind: "user", authorName: "Fixture", body: `Comment ${i}` });
    if (!perTask.rich) continue;
    for (const label of labels.slice(0, 1 + (i % 3))) store.tasks.addTaskLabel(task.id, label.id);
    store.tasks.createComment({
      taskId: task.id,
      kind: "agent",
      authorName: "Reviewer",
      body: "Approved",
      evidence: { kind: "review", pr: i + 1, head: "a".repeat(40), verdict: "approve", thread: "thr_reviewer", recordedByThread: "thr_recorder", lens: "security" },
    });
    store.tasks.createAttachment({ taskId: task.id, fileName: `task-${i}.bin`, mime: "application/octet-stream", sizeBytes: 3, blobPath: `blobs/task-${i}`, isImage: false });
    store.tasks.createAttachment({ commentId: comment.id, fileName: `comment-${i}.txt`, mime: "text/plain", sizeBytes: 5, blobPath: `blobs/comment-${i}`, isImage: false });
    store.tasks.upsertTaskThread({ taskId: task.id, threadId: `thr_cap_${i}`, title: "Worker", presetName: "Preset", liveStatus: i % 2 ? "completed" : "working" });
    store.tasks.upsertTaskThread({ taskId: task.id, threadId: `thr_cap_b_${i}`, title: "Second", presetName: "Preset", liveStatus: "working" });
    db.prepare("INSERT INTO task_key_aliases (prefix, number, task_id) VALUES (?, ?, ?)").run(`OLD${prefix === "CAP" ? "" : prefix}`, 1000 + i, task.id);
    db.prepare("INSERT INTO task_key_aliases (prefix, number, task_id) VALUES (?, ?, ?)").run(`AAA${prefix === "CAP" ? "" : prefix}`, 2000 + i, task.id);
    if (i % 2 === 0) db.prepare("INSERT OR IGNORE INTO task_activity_history(task_id) VALUES (?)").run(task.id);
    const repository = "org/repo";
    createGitSyncStore(db).saveLink(
      prLinkSchema.parse({ taskId: task.id, repository, number: i + 1, url: `https://github.com/${repository}/pull/${i + 1}`, source: "manual", confirmed: true, createdAt: "2026-11-05T00:00:00.000Z", updatedAt: "2026-11-05T00:00:00.000Z" }),
    );
    await structured.handlers.createQuestion({ taskId: task.id, prompt: `Question ${i}?`, mode: "multiple", allowOther: true, options: [{ label: "One", recommended: true, recommendationReason: "Why" }, "Two"] });
    await structured.handlers.createQuestion({ taskId: task.id, prompt: `Second ${i}?`, mode: "single", options: ["Yes", "No"] });
  }
  return project;
}

// Pre-batching reference: the exact per-task reads the exporter used before, kept as the equivalence oracle.
function legacyRecords(h: Host, projectId: string) {
  const { bb, store } = h;
  const structured = createStructuredStore(bb, store);
  const db = bb.storage.database();
  return store.tasks
    .listTasks({ projectId })
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((task) => {
      const comments = store.tasks.listComments(task.id).sort((a, b) => a.id.localeCompare(b.id));
      return {
        activityHistory: Boolean(db.prepare<[string], { task_id: string }>("SELECT task_id FROM task_activity_history WHERE task_id=?").get(task.id)),
        pullRequests: createGitSyncStore(db).links(task.id),
        task: { ...task, labelIds: store.tasks.listTaskLabels(task.id).map((link) => link.labelId).sort() },
        comments,
        questions: structured.listQuestions(task.id),
        attachments: [
          ...store.tasks.listAttachmentsForTask(task.id),
          ...comments.flatMap((comment) => store.tasks.listAttachmentsForComment(comment.id)),
        ].sort((a, b) => a.id.localeCompare(b.id)),
        threads: store.tasks.listTaskThreads(task.id).sort((a, b) => a.id.localeCompare(b.id)),
        aliases: db.prepare<[string], { prefix: string; number: number }>("SELECT prefix, number FROM task_key_aliases WHERE task_id = ? ORDER BY prefix, number").all(task.id),
      };
    });
}

describe("captureProject batching", () => {
  it("returns the same records as per-task reads for a fully populated project", async () => {
    const h = host();
    const project = await populate(h, 12, { rich: true });
    // A second project must not leak into the first project's batches.
    await populate(h, 3, { rich: true }, "OTH");
    const capture = captureProject(h.bb, h.store, project.id);
    const expected = legacyRecords(h, project.id);
    expect(capture.records).toEqual(expected);
    const [first] = capture.records;
    expect(first!.comments.length).toBeGreaterThan(1);
    expect(first!.attachments).toHaveLength(2);
    expect(first!.attachments.some((a) => a.commentId)).toBe(true);
    expect(first!.questions).toHaveLength(2);
    expect(first!.aliases.map((a) => a.prefix)).toEqual(["AAA", "OLD"]);
    expect(first!.pullRequests).toHaveLength(1);
    expect(first!.threads).toHaveLength(2);
    expect(first!.comments.some((c) => c.evidence)).toBe(true);
    expect(capture.records.some((r) => r.activityHistory)).toBe(true);
    expect(capture.records.some((r) => !r.activityHistory)).toBe(true);
  });

  it("uses a constant number of SQL statements as tasks and comments grow", async () => {
    const counts: number[] = [];
    for (const n of [10, 100]) {
      const h = host();
      const project = await populate(h, n, { rich: false });
      h.counter.statements = 0;
      const capture = captureProject(h.bb, h.store, project.id);
      expect(capture.records).toHaveLength(n);
      counts.push(h.counter.statements);
    }
    expect(counts[1]).toBe(counts[0]);
    // Per-task reads cost 96 / 906 statements for these fixtures; batching measures 14.
    expect(counts[0]).toBeLessThanOrEqual(20);
  });

  it("keeps the statement count constant for populated questions, evidence, attachments and threads", async () => {
    const counts: number[] = [];
    for (const n of [5, 40]) {
      const h = host();
      const project = await populate(h, n, { rich: true });
      h.counter.statements = 0;
      captureProject(h.bb, h.store, project.id);
      counts.push(h.counter.statements);
    }
    expect(counts[1]).toBe(counts[0]);
    expect(counts[0]).toBeLessThanOrEqual(20);
  });

  it("round-trips captured records through restoreProject", async () => {
    const source = host();
    const project = await populate(source, 6, { rich: true });
    const capture = captureProject(source.bb, source.store, project.id);
    const target = host();
    const records = capture.records.map((record) =>
      archiveTaskSchema.parse({
        ...record,
        attachments: record.attachments.map(({ blobPath: _blobPath, ...metadata }) => ({ ...metadata, sha256: "0".repeat(64) })),
      }),
    );
    const blobs = new Map(
      capture.records.flatMap((record) => record.attachments).map((a) => [a.id, { path: a.blobPath, previousPath: null, previousHash: null }]),
    );
    restoreProject(target.bb, target.store, { manifest: capture.manifest, records }, blobs, false);
    const again = captureProject(target.bb, target.store, project.id);
    expect(again.manifest).toEqual(capture.manifest);
    expect(again.records).toEqual(capture.records);
  });
});
