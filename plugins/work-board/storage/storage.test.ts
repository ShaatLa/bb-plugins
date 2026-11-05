import { link, lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it, vi } from "vitest";
import { createStore, registerTasksApi } from "../api";
import { deleteAttachmentById, readAttachmentContent, registerAttachments, saveAttachmentFromBytes } from "../attachments";
import { registerTasksCli } from "../cli";
import plugin from "../server";
import { storageService, ORPHAN_GRACE_MS } from ".";
import { protectBlob } from "./active-blobs";

vi.mock("node:fs/promises", async original => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, link: vi.fn(fs.link) };
});
const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { vi.useRealTimers(); vi.mocked(link).mockClear(); await Promise.all(hosts.splice(0).map(h => h.harness.dispose())); });
function setup() {
  const host = createFakePluginHost({ pluginId: "work-board" });
  hosts.push(host);
  const store = createStore(host.bb), db = host.bb.storage.database();
  registerAttachments(host.bb, store.tasks);
  const project = store.tasks.createProject({ name: "Storage", prefix: "STO", color: "blue" });
  const task = store.tasks.createTask({ projectId: project.id, title: "Keep history", status: "done" });
  const file = db.prepare<[], { file: string }>("PRAGMA database_list").all()[0]!.file;
  return { ...host, store, db, task, project, root: dirname(file), service: storageService(host.bb) };
}
async function orphan(root: string, name: string, contents = "old orphan") {
  const path = join(root, "blobs", name, "file.bin");
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, contents);
  return path;
}

it("cleans old unreachable rows/files, preserving archived data, exclusions, active/recent files and symlinks", async () => {
  const h = setup();
  const attachment = await saveAttachmentFromBytes(h.store.tasks, Buffer.from("visible"), { taskId: h.task.id, fileName: "keep.bin" });
  h.store.tasks.setTaskArchived(h.task.id, true);
  const comment = h.store.tasks.createComment({ taskId: h.task.id, kind: "agent", authorName: "Worker", threadId: "thr_worker", body: "Outcome history" });
  h.store.tasks.upsertTaskThread({ taskId: h.task.id, threadId: "thr_linked", presetName: "Attached", title: "Keep", liveStatus: "idle" });
  for (const thread of ["thr_linked", "thr_orphan"]) {
    h.db.prepare("INSERT INTO task_activity_claims VALUES (?, ?, ?)").run(thread, h.task.id, "turn");
    h.db.prepare("INSERT INTO task_activity_queue VALUES (?, ?, ?)").run(thread, `queue-${thread}`, h.task.id);
  }
  h.db.prepare("INSERT INTO git_pr_snapshots VALUES (?, ?, ?, NULL)").run(h.project.id, "unlinked", "{}");
  h.db.prepare("INSERT INTO git_pr_snapshots VALUES (?, ?, ?, NULL)").run(h.project.id, "excluded", "{}");
  h.db.prepare("INSERT INTO task_pr_links VALUES (?, ?, ?)").run(h.task.id, "excluded", JSON.stringify({ excluded: true }));
  const old = await orphan(h.root, "old"), active = await orphan(h.root, "active");
  const release = protectBlob(active);
  const foreign = join(h.root, "external.txt"); await writeFile(foreign, "outside namespace");
  await symlink(h.root, join(h.root, "blobs", "symlink"));
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + ORPHAN_GRACE_MS + 60_000);
  const recent = await orphan(h.root, "recent");
  // Filesystem timestamps use the real clock; this second file is explicitly treated as active as an in-flight upload.
  const releaseRecent = protectBlob(recent);
  const before = await h.service.status();
  expect(before.orphanFiles).toBe(1);
  const result = await h.service.run(false);
  expect(result.removedFiles).toBe(1); expect(result.removedRows).toBe(3);
  await expect(lstat(old)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(active, "utf8")).toBe("old orphan");
  expect(await readFile(foreign, "utf8")).toBe("outside namespace");
  expect((await readAttachmentContent(h.store.tasks, attachment.id)).content.toString()).toBe("visible");
  expect(h.store.tasks.getComment(comment.id)?.body).toBe("Outcome history");
  expect(h.db.prepare("SELECT identity FROM git_pr_snapshots").all()).toEqual([{ identity: "excluded" }]);
  expect(h.db.prepare("SELECT task_id FROM task_activity_history").all()).toHaveLength(1);
  release(); releaseRecent();
});

it("keeps fresh crash leftovers until the grace period and shares concurrent maintenance", async () => {
  const h = setup(); const path = await orphan(h.root, "fresh");
  const [a, b] = await Promise.all([h.service.run(false), h.service.run(false)]);
  expect(a).toBe(b); expect(a.removedFiles).toBe(0);
  expect(await readFile(path, "utf8")).toBe("old orphan");
});

it("shares identical immutable bytes, keeps paths/URLs and independent replacement/deletion, and compacts SQLite", async () => {
  const h = setup();
  const bytes = Buffer.alloc(128 * 1024, 97);
  const a = await saveAttachmentFromBytes(h.store.tasks, bytes, { taskId: h.task.id, fileName: "a.bin" });
  const b = await saveAttachmentFromBytes(h.store.tasks, bytes, { taskId: h.task.id, fileName: "b.bin" });
  const different = await saveAttachmentFromBytes(h.store.tasks, Buffer.alloc(bytes.length, 98), { taskId: h.task.id, fileName: "different.bin" });
  const before = await h.service.status();
  const result = await h.service.run(true);
  expect(result.deduplicatedFiles).toBe(1); expect(result.warnings).toBe(0);
  expect(result.after.blobPhysicalBytes).toBeLessThan(before.blobPhysicalBytes);
  expect((await lstat(join(h.root, a.blobPath))).ino).toBe((await lstat(join(h.root, b.blobPath))).ino);
  expect((await readAttachmentContent(h.store.tasks, different.id)).content[0]).toBe(98);
  expect(h.db.pragma("auto_vacuum", { simple: true })).toBe(2);
  expect(h.db.pragma("integrity_check", { simple: true })).toBe("ok");
  expect(h.store.tasks.getAttachment(a.id)?.blobPath).toBe(a.blobPath);
  expect((await h.service.run(true)).deduplicatedFiles).toBe(0);
  // Imports replace a path atomically rather than modifying a shared inode in place.
  const replacement = join(dirname(b.blobPath), "import-new");
  await writeFile(join(h.root, replacement), "new bytes"); h.store.tasks.updateAttachment(b.id, { blobPath: replacement });
  expect((await readAttachmentContent(h.store.tasks, a.id)).content).toEqual(bytes);
  await deleteAttachmentById(h.bb, h.store.tasks, a.id);
  expect((await readAttachmentContent(h.store.tasks, b.id)).content.toString()).toBe("new bytes");
});

it("keeps both originals when hard links are unavailable", async () => {
  const h = setup();
  const options = { taskId: h.task.id, fileName: "one.bin" };
  const a = await saveAttachmentFromBytes(h.store.tasks, Buffer.from("same"), options);
  const b = await saveAttachmentFromBytes(h.store.tasks, Buffer.from("same"), options);
  vi.mocked(link).mockRejectedValueOnce(Object.assign(new Error("links unsupported"), { code: "ENOTSUP" }));
  const result = await h.service.run(true);
  expect(result.warnings).toBe(1); expect(result.deduplicatedFiles).toBe(0);
  for (const item of [a, b]) expect((await readAttachmentContent(h.store.tasks, item.id)).content.toString()).toBe("same");
});

it("registers a daily cleanup and exposes storage status and actions through CLI/RPC", async () => {
  const h = setup(); registerTasksApi(h.bb, h.store); registerTasksCli(h.bb, h.store, { name: "Work Board", version: "test" });
  const result = await h.harness.runCli(["storage", "optimize", "--json"]);
  expect(result.exitCode).toBe(0); expect(JSON.parse(result.stdout).after).toHaveProperty("databaseBytes");
  const other = createFakePluginHost({ pluginId: "work-board" }); hosts.push(other); await plugin(other.bb);
  await other.harness.behavior.runSchedule("storage-maintenance");
  expect(await other.harness.callRpc("getStorageStatus", null)).toMatchObject({ orphanFiles: 0, missingAttachments: 0, lastCleanedAt: expect.any(String) });
});
