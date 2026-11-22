import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { command } from "./runner";
import { archivedWorktreeKind } from "./reports";

export type ScanProject = NonNullable<Awaited<ReturnType<BbPluginApi["sdk"]["projects"]["get"]>>>;
type Candidate = { path: string; threadId: string };
const PAGE_SIZE = 100;
const THREAD_BATCH = 200;
const COMMAND_TIMEOUT_MS = 15_000;
/** Git's diagnostic for a plain directory outside any repository; a broken gitfile prints `not a git repository: <path>` instead. */
const PLAIN_DIRECTORY = /^fatal: not a git repository \(or any of the parent directories\): \.git$/;
/** Whether the last completed pass of a project saw an archived candidate: it only decides how much of the inventory the next pass pages. */
const sawArchived = new WeakMap<BbPluginApi, Map<string, boolean>>();
/** Tests shorten these; production uses a 30 s measurement budget and a 60 s deadline for the whole scan. */
export const scanTuning = { measurementMs: 30_000, deadlineMs: 60_000 };

async function existingPath(path: string): Promise<string | null> {
  try { return await realpath(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

/** Read-only Git: no fsmonitor daemon, no hooks, no optional index lock. */
async function git(path: string, args: string[], signal: AbortSignal) {
  const result = await command("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], path, signal, { timeoutMs: COMMAND_TIMEOUT_MS, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" } });
  if (result.code) throw new Error(result.output.trim() || `git ${args[0]} failed`);
  return result.output;
}

/** Stops waiting for `promise` when the signal fires: a filesystem call on an unavailable mount ignores the signal and never settles. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Finds worktrees an archived thread left under the thread storage root, measures the ones not reported yet and describes them
 * as `ACTION archived-worktree` lines. Nothing is modified. Returns null when this tick cannot scan (no host, no storage, no readable repository).
 */
/** The bb projects with a scan still in flight: an abandoned scan may be stuck in a filesystem call, and another one would only add to it. */
const inFlight = new WeakMap<BbPluginApi, Set<string>>();

/** How many scans of this plugin instance have not settled yet; tests wait for zero before tearing down. */
export const scansRunning = (bb: BbPluginApi) => inFlight.get(bb)?.size ?? 0;

export function scanArchivedWorktrees(bb: BbPluginApi, project: ScanProject, reported: string[], afterPath: string | undefined, knownFailures: string[], signal: AbortSignal) {
  const running = inFlight.get(bb) ?? inFlight.set(bb, new Set()).get(bb)!;
  if (running.has(project.id)) {
    bb.log.warn("previous archived-worktree scan still running");
    return Promise.resolve(null);
  }
  running.add(project.id);
  const scanning = scan(bb, project, reported, afterPath, knownFailures, signal);
  const done = () => { running.delete(project.id); };
  scanning.then(done, done);
  return untilAborted(scanning, signal);
}

/** Pages the host inventory until a short page; with a filter, a host that ignores it still yields the same rows for the caller's own checks. */
async function pageInventory(bb: BbPluginApi, hostId: string, signal: AbortSignal, filter?: { projectId: string; status: "ready" }) {
  const rows: Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["list"]>> = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await bb.sdk.environments.list({ hostId, ...filter, limit: PAGE_SIZE, offset, signal });
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

async function scan(bb: BbPluginApi, project: ScanProject, reported: string[], afterPath: string | undefined, knownFailures: string[], signal: AbortSignal) {
  const { primaryHostId } = await bb.sdk.system.config({ signal });
  if (!primaryHostId) return null;
  const host = await bb.sdk.hosts.get({ hostId: primaryHostId, signal });
  if (!host.threadStorageRootPath) return null;
  const storage = await existingPath(host.threadStorageRootPath);
  if (!storage) return null;

  const sources = new Set((project.sources ?? []).filter((source) => source.hostId === primaryHostId).map((source) => source.path));
  const roots = new Set(sources);
  // A pass that expects archived candidates pages the whole inventory once, for roots and managed paths together. Otherwise only this
  // project's ready environments are paged, and the whole inventory only if a candidate turns up.
  const expectArchived = reported.length > 0 || !!sawArchived.get(bb)?.get(project.id);
  let rows = await pageInventory(bb, primaryHostId, signal, expectArchived ? undefined : { projectId: project.id, status: "ready" });
  for (const environment of rows) {
    if (environment.path && environment.projectId === project.id && environment.status === "ready" && environment.isGitRepo) roots.add(environment.path);
  }

  const repositories = new Set<string>();
  const candidates = new Map<string, Candidate>();
  let complete = true;
  const failures = new Set<string>();
  /** A root that could not be read: warned once per transition; `blocks` keeps the scan incomplete so reported paths are not cleared. */
  const fail = (kind: "plain" | "error" | "missing", root: string, detail: string, blocks: boolean) => {
    const key = `${kind}:${root}`;
    failures.add(key);
    if (blocks) complete = false;
    if (!knownFailures.includes(key)) bb.log.warn(`Archived worktree registry could not be read for ${root}: ${detail}`);
  };
  for (const root of roots) {
    try {
      const checkout = await existingPath(root);
      if (!checkout) { if (sources.has(root)) fail("missing", root, "configured source is missing", true); continue; }
      let common: string;
      try { common = (await git(checkout, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal)).replace(/\r?\n$/, ""); }
      catch (error) {
        signal.throwIfAborted();
        // Only the discovery of a plain directory that is not a repository any more is skipped; a source stays a hard failure.
        if (!sources.has(root) && PLAIN_DIRECTORY.test(String((error as Error).message))) { fail("plain", root, "not a git repository", false); continue; }
        throw error;
      }
      if (repositories.has(common)) continue;
      const records = (await git(checkout, ["worktree", "list", "--porcelain", "-z"], signal)).split("\0\0");
      // The first record is the primary checkout (or bare repository).
      for (const entry of records.slice(1)) {
        const [pathField, ...fields] = entry.split("\0");
        if (!pathField.startsWith("worktree ") || fields.some((field) => /^prunable(?: |$)/.test(field))) continue;
        const path = await existingPath(pathField.slice("worktree ".length));
        if (!path) continue;
        const part = relative(storage, path);
        const [threadId, child] = part.split(sep);
        if (child && !isAbsolute(part) && /^thr_[a-z0-9]+$/.test(threadId)) candidates.set(path, { path, threadId });
      }
      repositories.add(common);
    } catch (error) {
      signal.throwIfAborted();
      fail("error", root, String(error), true);
    }
  }
  const failed = [...failures].sort();
  for (const key of knownFailures) if (!failures.has(key)) bb.log.info(`Archived worktree root recovered: ${key.slice(key.indexOf(":") + 1)}`);

  // Nothing could be read: a diagnostic-only result keeps the history and the cursor and lets the failure keys follow the pass.
  if (!repositories.size) return failed.length || knownFailures.length ? { complete: false, present: [], newPaths: [], lastMeasuredPath: afterPath, lines: [], failures: failed } : null;
  const ids = [...new Set([...candidates.values()].map((item) => item.threadId))];
  const archived = new Set<string>();
  for (let offset = 0; offset < ids.length; offset += THREAD_BATCH) {
    const threads = await bb.sdk.threads.list({ projectId: project.id, archived: true, includeHidden: true, threadIds: ids.slice(offset, offset + THREAD_BATCH), limit: THREAD_BATCH, signal });
    for (const thread of threads) if (thread.archivedAt != null && thread.deletedAt == null) archived.add(thread.id);
  }

  let present = [...candidates.values()].filter(({ threadId }) => archived.has(threadId));
  (sawArchived.get(bb) ?? sawArchived.set(bb, new Map()).get(bb)!).set(project.id, present.length > 0);
  if (present.length) {
    // Any archived candidate, reported or not, is checked against every managed path of the host, whatever its project.
    if (!expectArchived) rows = await pageInventory(bb, primaryHostId, signal);
    const managed = new Set<string>();
    for (const environment of rows) {
      if (!environment.managed || !environment.path) continue;
      const path = await existingPath(environment.path);
      if (path) managed.add(path);
    }
    present = present.filter(({ path }) => !managed.has(path));
  }
  const reportedPaths = new Set(reported);
  const unreported = present.filter(({ path }) => !reportedPaths.has(path)).sort((a, b) => (a.path < b.path ? -1 : 1));
  const start = afterPath ? Math.max(0, unreported.findIndex(({ path }) => path > afterPath)) : 0;
  const newPaths: string[] = [];
  const lines = new Map<string, string[]>();
  const measurementSignal = AbortSignal.any([signal, AbortSignal.timeout(scanTuning.measurementMs)]);
  let lastMeasuredPath: string | undefined;
  // Resume after the last attempt so expensive paths cannot starve later worktrees.
  for (const { path, threadId } of [...unreported.slice(start), ...unreported.slice(0, start)]) {
    if (measurementSignal.aborted) break;
    lastMeasuredPath = path;
    try {
      const status = await git(path, ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=none"], measurementSignal);
      const size = await command("du", ["-sk", path], path, measurementSignal, { timeoutMs: COMMAND_TIMEOUT_MS });
      const kib = /^(\d+)\s/.exec(size.output)?.[1];
      if (size.code || !kib) throw new Error("Cannot measure worktree size");
      const items = lines.get(threadId) ?? [];
      items.push(`${JSON.stringify(path)} (${kib} KiB, ${status ? "dirty" : "clean"})`);
      lines.set(threadId, items);
      newPaths.push(path);
    } catch (error) {
      signal.throwIfAborted();
      bb.log.warn(`Archived worktree inspection failed for ${threadId}: ${String(error)}`);
    }
  }
  return { complete, present: present.map(({ path }) => path), newPaths, lastMeasuredPath, failures: failed,
    lines: [...lines].map(([threadId, items]) => `${archivedWorktreeKind} ${threadId}: ${items.join(", ")}`) };
}
