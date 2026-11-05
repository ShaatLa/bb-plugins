import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import { link, lstat, opendir, rename, unlink, rmdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { setImmediate } from "node:timers/promises";
import type { StorageStatus, StorageResult } from "../shared/storage";
import { blobIsActive } from "./active-blobs";

export const ORPHAN_GRACE_MS = 24 * 60 * 60_000;
const LAST_CLEANED_KEY = "storage:last-cleaned";
type File = { path: string; stats: Stats };
type Reference = { path: string; size: number };
const services = new WeakMap<BbPluginApi, ReturnType<typeof createStorageService>>();
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const identity = (file: File) => `${file.stats.dev}:${file.stats.ino}`;
const unchanged = (a: File, b: File) => identity(a) === identity(b) && a.stats.size === b.stats.size && a.stats.mtimeMs === b.stats.mtimeMs && a.stats.ctimeMs === b.stats.ctimeMs;

export function storageService(bb: BbPluginApi) {
  let service = services.get(bb);
  if (!service) { service = createStorageService(bb); services.set(bb, service); }
  return service;
}

function createStorageService(bb: BbPluginApi) {
  const db = bb.storage.database();
  const database = db.prepare<[], { name: string; file: string }>("PRAGMA database_list").all().find(row => row.name === "main")?.file;
  if (!database) throw new Error("Storage maintenance requires a file-backed database");
  const root = dirname(database), blobs = join(root, "blobs");
  const references = (): Reference[] => db.prepare<[], { blob_path: string; size_bytes: number }>("SELECT blob_path, size_bytes FROM attachments").all()
    .map(row => ({ path: resolve(root, row.blob_path), size: row.size_bytes }));
  let referenceRevision = "", liveReferences = new Set<string>();
  const isReferenced = (path: string) => {
    const revision = `${db.prepare<[], { count: number }>("SELECT total_changes() AS count").get()!.count}:${db.pragma("data_version", { simple: true })}`;
    // Rebuild on database changes, not once for every orphan/duplicate file.
    if (revision !== referenceRevision) { liveReferences = new Set(references().map(row => row.path)); referenceRevision = revision; }
    return liveReferences.has(path);
  };
  let stopped = false;
  bb.onDispose(() => { stopped = true; });
  function check() { if (stopped) throw new Error("Storage maintenance stopped"); }
  async function regular(path: string): Promise<File | null> {
    try {
      const stats = await lstat(path);
      return stats.isFile() && !stats.isSymbolicLink() ? { path, stats } : null;
    } catch (error) { if (absent(error)) return null; throw error; }
  }
  async function safeDirectory(path: string) {
    const stats = await lstat(path).catch(error => { if (absent(error)) return null; throw error; });
    return !!stats?.isDirectory() && !stats.isSymbolicLink();
  }
  // Only the plugin-owned two-level blob namespace is collected; never follow symlinks or export/release directories.
  async function* files(): AsyncGenerator<File> {
    if (!await safeDirectory(blobs)) return;
    const directories = await opendir(blobs);
    let visited = 0;
    for await (const directory of directories) {
      check();
      const path = join(blobs, directory.name);
      if (!directory.isDirectory() || !await safeDirectory(path)) continue;
      const entries = await opendir(path).catch(error => { if (absent(error)) return null; throw error; });
      if (!entries) continue;
      for await (const entry of entries) {
        check();
        if (!entry.isFile()) continue;
        const file = await regular(join(path, entry.name));
        if (file) yield file;
        if (++visited % 64 === 0) await setImmediate();
      }
    }
  }
  async function status(): Promise<StorageStatus> {
    const refs = new Set(references().map(row => row.path));
    const found = new Set<string>(), inodes = new Set<string>();
    let blobFiles = 0, blobLogicalBytes = 0, blobPhysicalBytes = 0, orphanFiles = 0, orphanBytes = 0;
    for await (const file of files()) {
      blobFiles++;
      blobLogicalBytes += file.stats.size;
      if (!inodes.has(identity(file))) { blobPhysicalBytes += file.stats.blocks * 512; inodes.add(identity(file)); }
      if (refs.has(file.path)) found.add(file.path);
      else if (!blobIsActive(file.path) && Date.now() - Math.max(file.stats.mtimeMs, file.stats.ctimeMs) >= ORPHAN_GRACE_MS) {
        orphanFiles++; orphanBytes += file.stats.size;
      }
    }
    const dbStat = await regular(database!);
    const walStat = await regular(`${database}-wal`);
    return {
      databaseBytes: dbStat?.stats.size ?? 0, walBytes: walStat?.stats.size ?? 0,
      freeDatabaseBytes: Number(db.pragma("freelist_count", { simple: true })) * Number(db.pragma("page_size", { simple: true })),
      blobFiles, blobLogicalBytes, blobPhysicalBytes, orphanFiles, orphanBytes,
      missingAttachments: [...refs].filter(path => path.startsWith(`${blobs}${sep}`) && !found.has(path)).length,
      lastCleanedAt: await bb.storage.kv.get<string>(LAST_CLEANED_KEY) ?? null,
    };
  }
  async function digest(file: File) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file.path)) { check(); hash.update(chunk); }
    const current = await regular(file.path);
    return current && unchanged(file, current) ? hash.digest("hex") : null;
  }
  let pending: { optimize: boolean; promise: Promise<StorageResult> } | undefined;
  async function run(optimize: boolean): Promise<StorageResult> {
    if (pending) {
      if (!optimize || pending.optimize) return pending.promise;
      await pending.promise;
      return run(true);
    }
    const promise = perform(optimize);
    const entry = { optimize, promise };
    pending = entry;
    try { return await promise; } finally { if (pending === entry) pending = undefined; }
  }
  async function perform(optimize: boolean): Promise<StorageResult> {
    check();
    const before = await status();
    const removedRows = db.transaction(() => {
      check();
      let count = 0;
      // These rows are transient caches, not task history, PR exclusions, or observed-work facts.
      for (const sql of [
        "DELETE FROM task_activity_claims WHERE NOT EXISTS (SELECT 1 FROM task_threads t WHERE t.task_id=task_activity_claims.task_id AND t.thread_id=task_activity_claims.thread_id)",
        "DELETE FROM task_activity_queue WHERE NOT EXISTS (SELECT 1 FROM task_threads t WHERE t.task_id=task_activity_queue.task_id AND t.thread_id=task_activity_queue.thread_id)",
        "DELETE FROM git_pr_snapshots WHERE NOT EXISTS (SELECT 1 FROM task_pr_links l JOIN tasks t ON t.id=l.task_id WHERE t.project_id=git_pr_snapshots.project_id AND l.identity=git_pr_snapshots.identity)",
      ]) count += db.prepare(sql).run().changes;
      return count;
    })();
    let removedFiles = 0, deduplicatedFiles = 0, warnings = 0;
    const warn = (error: unknown) => { warnings++; bb.log.warn(`Storage maintenance skipped a file: ${(error as Error).message}`); };
    const refs = new Set(references().map(row => row.path));
    const canonical = new Map<string, File>();
    const hashedInodes = new Set<string>();
    const sizeCounts = new Map<number, number>();
    if (optimize) for (const ref of references()) sizeCounts.set(ref.size, (sizeCounts.get(ref.size) ?? 0) + 1);
    for await (const file of files()) {
      check();
      if (blobIsActive(file.path)) continue;
      try {
        if (!refs.has(file.path)) {
          // Recheck ownership after awaits; the grace period also protects interrupted uploads/imports.
          if (Date.now() - Math.max(file.stats.mtimeMs, file.stats.ctimeMs) < ORPHAN_GRACE_MS) continue;
          if (!await safeDirectory(blobs) || !await safeDirectory(dirname(file.path))) continue;
          const current = await regular(file.path);
          if (current && unchanged(file, current) && !blobIsActive(file.path) && !isReferenced(file.path)) { await unlink(file.path); removedFiles++; }
          continue;
        }
        if (!optimize || file.stats.size === 0 || (sizeCounts.get(file.stats.size) ?? 0) < 2) continue;
        if (hashedInodes.has(identity(file))) continue;
        hashedInodes.add(identity(file));
        const hash = await digest(file);
        if (!hash) continue;
        const key = `${file.stats.size}:${file.stats.mode}:${hash}`;
        const source = canonical.get(key);
        if (!source) { canonical.set(key, file); continue; }
        if (identity(source) === identity(file)) continue;
        const sourceNow = await regular(source.path), targetNow = await regular(file.path);
        if (!sourceNow || !targetNow || !unchanged(source, sourceNow) || !unchanged(file, targetNow)) { canonical.delete(key); continue; }
        if (!await safeDirectory(blobs) || !await safeDirectory(dirname(source.path)) || !await safeDirectory(dirname(file.path))) continue;
        const temporary = join(dirname(file.path), `.dedupe-${randomUUID()}`);
        try {
          // Blobs are immutable after commit: hard links preserve every attachment ID, path, byte and MIME.
          await link(source.path, temporary);
          const linked = await regular(temporary), target = await regular(file.path);
          if (!linked || !target || linked.stats.size !== source.stats.size || linked.stats.mtimeMs !== source.stats.mtimeMs || identity(linked) !== identity(source)
            || !unchanged(file, target) || blobIsActive(file.path) || !isReferenced(file.path)) continue;
          await rename(temporary, file.path);
          deduplicatedFiles++;
          const updated = await regular(source.path);
          if (updated) canonical.set(key, updated);
        } finally { await unlink(temporary).catch(error => { if (!absent(error)) warn(error); }); }
      } catch (error) { if (!absent(error)) warn(error); }
    }
    // Delete empty attachment directories only after checking all their files independently.
    if (await safeDirectory(blobs)) for await (const entry of await opendir(blobs)) {
      check();
      if (entry.isDirectory()) await rmdir(join(blobs, entry.name)).catch(error => {
        if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) warn(error);
      });
    }
    check();
    if (optimize) {
      // Full rebuilding is explicit; daily maintenance only reclaims a bounded number of free pages.
      db.pragma("auto_vacuum = INCREMENTAL");
      db.exec("VACUUM");
      db.pragma("wal_checkpoint(TRUNCATE)");
    } else {
      if (Number(db.pragma("auto_vacuum", { simple: true })) === 2) db.pragma("incremental_vacuum(256)");
      db.pragma("wal_checkpoint(PASSIVE)");
    }
    await bb.storage.kv.set(LAST_CLEANED_KEY, new Date().toISOString());
    const after = await status();
    liveReferences.clear(); referenceRevision = "";
    return { before, after, removedFiles, removedRows, deduplicatedFiles, warnings };
  }
  return { status, run };
}
