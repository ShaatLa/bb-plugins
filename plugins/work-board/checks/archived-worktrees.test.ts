import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestMode } from "../attention/modes";
import { receiptPolling } from "../steer";
import { scanTuning, scansRunning } from "./archived-worktrees";
import { formatNotification } from "./notification";
import { reportContents } from "./reports";
import { checksTuning } from "./service";
import { binDir, BB_PROJECT, cleanTempDirs, MANAGER, setup, tempDir, type Fixture } from "./fixtures";

// A filesystem call that never settles, for the one path a test names.
const stall = vi.hoisted(() => ({ path: null as string | null, calls: 0, pending: [] as (() => void)[], release() { this.pending.splice(0).forEach((resolve) => resolve()); } }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, realpath: Object.assign((path: string, ...rest: unknown[]) => (path === stall.path ? new Promise<string>((resolve) => { stall.calls++; stall.pending.push(() => resolve(path)); }) : (actual.realpath as (...args: unknown[]) => Promise<string>)(path, ...rest)), actual.realpath) };
});

const fixtures: Fixture[] = [];
const make = async (script = "", code = 0) => {
  const f = await setup(); fixtures.push(f); f.standard(); f.output(script, code); await f.enable(); f.worktrees.enable(); return f;
};
beforeEach(() => { receiptPolling.tries = 1; receiptPolling.delayMs = 0; checksTuning.lateSearchMs = 0; });
afterEach(async () => {
  vi.unstubAllEnvs(); scanTuning.measurementMs = 30_000; scanTuning.deadlineMs = 60_000; stall.path = null; stall.calls = 0;
  // Settle a stalled scan before the fixtures go, so a failed test reports its assertion instead of tearing down under a running scan.
  stall.release();
  await Promise.all(fixtures.map((f) => vi.waitFor(() => expect(scansRunning(f.bb)).toBe(0), { timeout: 5000 })));
  await Promise.all(fixtures.splice(0).map((f) => f.dispose())); cleanTempDirs();
});

/** A definite rejection keeps the staged report pending, so its raw body can be read. */
const hold = (f: Fixture) => { f.threads.sendMode = "throw"; f.threads.sendError = Object.assign(new Error("forbidden"), { status: 403 }); };
const release = (f: Fixture) => { f.threads.sendMode = "queue"; f.threads.sendError = undefined; };
const body = (f: Fixture) => f.delivery()?.pending_body as string;
const accepted = (f: Fixture) => f.attempts().filter((a) => ["queued", "appended", "inline"].includes(a.outcome as string)).length;
const reported = (f: Fixture): string[] => f.state().reportedWorktrees ?? [];
const pending = (f: Fixture): string[] => f.state().pendingWorktrees ?? [];
const counts = (f: Fixture) => { const { reportedWorktrees, pendingWorktrees } = f.service.status(f.tracker.id); return { reportedWorktrees, pendingWorktrees }; };
const worktreeLines = (text: string) => text.split("\n").filter((line) => line.startsWith("ACTION archived-worktree "));
const summary = (threads: number, cards: number, actions: number) => `checks: ${threads} threads, ${cards} cards checked, ${actions} actions`;

/** A `git` in front of PATH that logs its environment and arguments; `a-slow` trees answer `status` only after 5 s. */
function loggedGit(f: Fixture) {
  const log = join(f.io, "git.log");
  const real = execFileSync("which", ["git"]).toString().trim();
  const bin = binDir({ git: `echo "$GIT_OPTIONAL_LOCKS $*" >> "${log}"\ncase "$*" in *" status "*) case "$(pwd -P)" in */a-slow) sleep 5;; esac;; esac\nexec "${real}" "$@"` });
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  return () => { try { return readFileSync(log, "utf8"); } catch { return ""; } };
}

/** Every file's size, mtime and bytes under the roots: a scan must leave all of it as it was. */
function snapshot(...roots: string[]) {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { out[path] = "dir"; walk(path); continue; }
      const info = statSync(path);
      out[path] = `${info.size}:${info.mtimeMs}:${readFileSync(path).toString("base64")}`;
    }
  };
  for (const root of roots) walk(root);
  return out;
}

describe("scan", () => {
  it("reports an archived thread's worktree with its size and state, and leaves a dirty tree untouched", async () => {
    const f = await make();
    hold(f);
    const clean = f.worktrees.add("thr_example", "clean");
    const dirty = f.worktrees.add("thr_other", "dirty");
    writeFileSync(join(dirty, "notes.txt"), "draft");
    const before = snapshot(dirty, join(f.worktrees.source, ".git"));
    await f.tick();
    const lines = worktreeLines(body(f));
    expect(lines).toHaveLength(2);
    expect(lines.find((line) => line.includes(clean))).toMatch(/^ACTION archived-worktree thr_example: ".*" \(\d+ KiB, clean\)$/);
    expect(lines.find((line) => line.includes(dirty))).toMatch(/^ACTION archived-worktree thr_other: ".*" \(\d+ KiB, dirty\)$/);
    expect(f.delivery()).toMatchObject({ pending_exit: 1 });
    expect(snapshot(dirty, join(f.worktrees.source, ".git"))).toEqual(before);
  });

  it("skips managed environments, active and deleted threads, missing trees, paths outside storage and the primary checkout", async () => {
    const f = await make();
    const w = f.worktrees;
    const wanted = w.add("thr_example");
    const managed = w.add("thr_managed");
    w.scan.environments.push({ path: managed, managed: true, projectId: "proj_other", status: "ready", isGitRepo: true });
    w.add("thr_active", "tree", { archived: false });
    w.add("thr_deleted", "tree", { deleted: true });
    // Registered, but only an ordinary directory is left at the path (prunable). The storage root is a repository, so Git could
    // still measure that directory: only the prunable check keeps it out.
    execFileSync("git", ["init", "-q"], { cwd: w.scan.storage });
    const gone = w.add("thr_gone");
    rmSync(gone, { recursive: true });
    mkdirSync(gone);
    w.add("thr_example", "outside", { under: tempDir("checks-elsewhere-") });
    const primary = w.makeRepo(join(w.scan.storage, "thr_primary", "repo"));
    w.scan.sources.push({ hostId: "host_example", path: primary });
    w.scan.threads.set("thr_primary", { archivedAt: 1, deletedAt: null });
    await f.tick();
    expect(reported(f)).toEqual([wanted]);
    expect(f.service.status(f.tracker.id)).toMatchObject({ reportedWorktrees: 1, pendingWorktrees: 0 });
  });

  it("scans a repository once however many roots lead to it, and groups the paths of one thread in one line", async () => {
    const f = await make();
    const git = loggedGit(f);
    hold(f);
    const one = f.worktrees.add("thr_example", "one");
    const two = f.worktrees.add("thr_example", "two");
    f.worktrees.scan.environments.push({ path: one, managed: false, projectId: BB_PROJECT, status: "ready", isGitRepo: true });
    await f.tick();
    expect(git().match(/ --git-common-dir$/gm)).toHaveLength(2); // the source and the ready environment are both read
    expect(git().match(/ worktree list /g)).toHaveLength(1);
    expect(git()).toMatch(/^0 -c core\.fsmonitor=false -c core\.hooksPath=\/dev\/null status --porcelain=v1 -z --untracked-files=normal --ignore-submodules=none$/m);
    const lines = worktreeLines(body(f));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(one);
    expect(lines[0]).toContain(two);
    expect(pending(f)).toEqual([one, two]);
  });
});

describe("dedup and delivery", () => {
  it("moves a path from pending to reported only on durable acceptance, with the same bytes on the retry", async () => {
    const f = await make();
    hold(f);
    const path = f.worktrees.add("thr_example");
    await f.tick();
    expect(pending(f)).toEqual([path]);
    expect(reported(f)).toEqual([]);
    expect(counts(f)).toEqual({ reportedWorktrees: 0, pendingWorktrees: 1 });
    const bytes = body(f);
    release(f);
    await f.tick();
    expect(f.sent()).toContain(formatNotification(1, bytes));
    expect(f.delivery()?.report_id ?? null).toBeNull();
    expect(reported(f)).toEqual([path]);
    expect(pending(f)).toEqual([]);
    expect(counts(f)).toEqual({ reportedWorktrees: 1, pendingWorktrees: 0 });
    await f.tick(); // reported once, never again
    expect(accepted(f)).toBe(1);
    expect(f.delivery()?.report_id ?? null).toBeNull();
  });

  it("keeps a path pending through an unknown delivery and promotes it after the owner's retry", async () => {
    const f = await make();
    f.threads.sendMode = "throw"; f.threads.sendError = undefined;
    const path = f.worktrees.add("thr_example");
    await f.tick();
    await f.tick();
    expect(f.service.status(f.tracker.id)).toMatchObject({ awaitingRetry: true, pendingWorktrees: 1, reportedWorktrees: 0 });
    const bytes = body(f);
    f.service.retry(f.tracker.id);
    release(f);
    await f.tick();
    expect(f.sent()).toContain(formatNotification(1, bytes));
    expect(counts(f)).toEqual({ reportedWorktrees: 1, pendingWorktrees: 0 });
    expect(reported(f)).toEqual([path]);
  });

  it("leaves the counts as they were when the commit of an acceptance fails, and moves the path after the recovery", async () => {
    const f = await make();
    f.threads.threads.set(MANAGER, { archived: true });
    const path = f.worktrees.add("thr_example");
    await f.tick();
    expect(counts(f)).toEqual({ reportedWorktrees: 0, pendingWorktrees: 1 });
    f.threads.threads.set(MANAGER, {});
    f.db.exec("CREATE TRIGGER fail_promote BEFORE UPDATE ON checks_delivery BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    await expect(f.tick()).rejects.toThrow(/disk full/);
    expect(counts(f)).toEqual({ reportedWorktrees: 0, pendingWorktrees: 1 });
    expect(pending(f)).toEqual([path]);
    f.db.exec("DROP TRIGGER fail_promote");
    await f.tick();
    expect(counts(f)).toEqual({ reportedWorktrees: 1, pendingWorktrees: 0 });
  });

  it("stages the report and its pending paths together: a failed staging leaves neither", async () => {
    const f = await make();
    const path = f.worktrees.add("thr_example");
    f.db.exec("CREATE TRIGGER fail_stage BEFORE INSERT ON checks_delivery BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    await expect(f.tick()).rejects.toThrow(/disk full/);
    expect(f.delivery()).toBeUndefined();
    expect(f.state().pendingWorktrees).toBeUndefined();
    expect(f.state().reportedWorktrees).toBeUndefined();
    f.db.exec("DROP TRIGGER fail_stage");
    hold(f);
    await f.tick();
    expect(pending(f)).toEqual([path]);
  });
});

describe("presence", () => {
  it("drops a reported path only after a complete scan sees it gone, and reports it again when it comes back", async () => {
    const f = await make();
    const path = f.worktrees.add("thr_example");
    await f.tick();
    expect(reported(f)).toEqual([path]);
    f.worktrees.remove(path);
    await f.tick();
    expect(reported(f)).toEqual([]);
    f.worktrees.add("thr_example");
    await f.tick();
    expect(accepted(f)).toBe(2);
    expect(reported(f)).toEqual([path]);
  });

  it.each([
    ["a source root is missing", () => join(tempDir("checks-none-"), "absent")],
    ["a registry cannot be read", () => tempDir("checks-notgit-")],
  ])("keeps the history while the scan is incomplete: %s", async (_name, extra) => {
    const f = await make();
    const path = f.worktrees.add("thr_example");
    await f.tick();
    f.worktrees.remove(path);
    const broken = { hostId: "host_example", path: extra() };
    f.worktrees.scan.sources.push(broken);
    await f.tick();
    expect(reported(f)).toEqual([path]);
    f.worktrees.scan.sources.pop();
    await f.tick();
    expect(reported(f)).toEqual([]);
  });

  it("resumes after the last attempted path when the measurement budget ran out on an expensive one", async () => {
    const f = await make();
    loggedGit(f);
    scanTuning.measurementMs = 500;
    const slow = f.worktrees.add("thr_aaaa", "a-slow");
    const fast = f.worktrees.add("thr_bbbb", "b-fast");
    await f.tick();
    expect(f.state().lastMeasuredWorktree).toBe(slow);
    expect(f.delivery()).toBeUndefined();
    await f.tick();
    expect(f.sent()).toContain("b-fast");
    expect(f.sent()).not.toContain("a-slow");
    expect(reported(f)).toEqual([fast]);
  });
});

describe("tick", () => {
  it("turns an exit 0 with a new worktree into a delivered exit 1", async () => {
    const f = await make();
    hold(f);
    f.worktrees.add("thr_example");
    await f.tick();
    expect(f.delivery()).toMatchObject({ pending_exit: 1 });
    expect(f.state()).toMatchObject({ exitCode: 1 });
    expect(f.attempts()).toHaveLength(1);
  });

  it("leaves worktree lines out of the comparison, the fingerprint and the noteworthy items", () => {
    const line = 'ACTION archived-worktree thr_example: "/p/a" (4 KiB, clean)';
    const plain = reportContents(1, "ACTION idle-thread EXA-1");
    const withTree = reportContents(1, `ACTION idle-thread EXA-1\n${line}`);
    expect(withTree.fingerprint).toBe(plain.fingerprint);
    expect(withTree.changes).toEqual(plain.changes);
    expect(withTree.items.size).toBe(2);
    expect(reportContents(1, line).changes.noteworthy).toEqual([]);
  });

  it("delivers an unchanged exit-2 failure together with a new path, keeping the script's own diagnostic", async () => {
    const f = await make("boom", 2);
    await f.tick();
    expect(accepted(f)).toBe(1);
    await f.tick();
    expect(accepted(f)).toBe(1); // the same failure is not sent again
    const path = f.worktrees.add("thr_example");
    await f.tick();
    expect(accepted(f)).toBe(2);
    expect(f.sent()).toContain("**Archived worktrees**");
    expect(f.state()).toMatchObject({ exitCode: 2, error: "boom\n", reportedWorktrees: [path] });
    await f.tick();
    expect(accepted(f)).toBe(2);
  });

  it("appends the Waiting-clear line to the combined body", async () => {
    const f = await make("WAIT EXA-5: blocker EXA-6");
    await f.tick();
    f.output("", 0);
    f.threads.threads.set(MANAGER, { archived: true }); // the second report cannot be delivered, so it stays staged
    f.worktrees.add("thr_example");
    await f.tick();
    expect(body(f)).toMatch(/^ACTION archived-worktree thr_example: /m);
    expect(body(f)).toMatch(/\nSTATE Waiting list is clear\.\n$/);
  });

  it("skips the scan when the project lookup failed and keeps the refresh diagnostic", async () => {
    const f = await make();
    f.worktrees.add("thr_example");
    f.control.projectFail = true;
    await f.tick();
    expect(f.worktrees.scan.calls).toBe(0);
    expect(f.state().error).toContain("Could not read the bb project repository settings");
    expect(f.sent()).not.toContain("archived");
  });

  it("scans after a failed refresh when the project was read, without mixing the lines into the error", async () => {
    const f = await make();
    hold(f);
    f.worktrees.add("thr_example");
    f.control.remote = "file:///nonexistent/example";
    await f.tick();
    expect(f.worktrees.scan.calls).toBe(1);
    expect(f.state().error).toMatch(/^ERROR Error: Checkout refresh failed/);
    expect(f.state().error).not.toContain("archived-worktree");
    expect(f.delivery()).toMatchObject({ pending_exit: 2 });
    expect(body(f)).toMatch(/^ERROR /);
    expect(body(f)).toMatch(/\nACTION archived-worktree thr_example: /);
  });

  it("treats an exit-2 failure with empty output and a new worktree as one failure: delivered once, not again", async () => {
    const f = await make("", 2);
    await f.tick();
    expect(accepted(f)).toBe(1);
    f.worktrees.add("thr_example");
    await f.tick();
    expect(accepted(f)).toBe(2);
    await f.tick();
    expect(accepted(f)).toBe(2);
    expect(reportContents(2, "").fingerprint).toBe(reportContents(2, 'ACTION archived-worktree thr_example: "/p/a" (4 KiB, clean)').fingerprint);
  });

  it("stops waiting for a scan that stalls on the filesystem and delivers the script's result", async () => {
    const f = await make("ACTION idle-thread EXA-1", 1);
    const path = f.worktrees.add("thr_example");
    scanTuning.deadlineMs = 300;
    stall.path = f.worktrees.scan.storage;
    await f.tick();
    expect(accepted(f)).toBe(1);
    expect(f.sent()).toContain("idle thread");
    expect(f.sent()).not.toContain("archived worktree");
    expect(reported(f)).toEqual([]);
    expect(stall.calls).toBe(1);
    // The stalled lookup is still in flight: the next tick skips the scan, warns once and delivers its own script result.
    const warn = vi.spyOn(f.bb.log, "warn");
    f.output("ACTION idle-thread EXA-2", 1);
    await f.tick();
    expect(stall.calls).toBe(1);
    expect(f.worktrees.scan.calls).toBe(1);
    expect(warn.mock.calls.filter(([message]) => String(message).includes("previous archived-worktree scan still running"))).toHaveLength(1);
    expect(accepted(f)).toBe(2);
    expect(f.sent()).toContain("EXA-2");
    // Once the stalled call settles, the next tick scans again.
    scanTuning.deadlineMs = 60_000; stall.release(); stall.path = null;
    await vi.waitFor(() => expect(scansRunning(f.bb)).toBe(0));
    f.output("ACTION idle-thread EXA-3", 1);
    await f.tick();
    expect(f.worktrees.scan.calls).toBe(2);
    expect(reported(f)).toEqual([path]);
  });

  it("keeps a switch-off unconsumed while a timed-out scan is still outstanding, and resends the unchanged stale line once it settles", async () => {
    const stale = "ACTION stale-status EXA-1: in progress with no active thread";
    const f = await make(stale, 1);
    const trackerId = f.tracker.id;
    await f.tick();
    requestMode(f.db, { trackerId, mode: "live" });
    const back = requestMode(f.db, { trackerId, mode: "off" }).effective;
    const consumed = () => (f.db.prepare("SELECT consumed_generation AS g FROM checks_stale_rollback WHERE tracker_id=?").get(trackerId) as { g: number } | undefined)?.g;
    const staleSent = () => f.sent().split("`stale status`").length - 1;
    expect(staleSent()).toBe(1);
    scanTuning.deadlineMs = 300;
    stall.path = f.worktrees.scan.storage;
    f.output("", 0); // nothing stale: a judgement that counted as complete would consume the return
    await f.tick(); // the scan times out
    await f.tick(); // the stalled scan is still outstanding
    expect(stall.calls).toBe(1);
    expect(consumed()).not.toBe(back.generation);
    scanTuning.deadlineMs = 60_000; stall.release(); stall.path = null;
    await vi.waitFor(() => expect(scansRunning(f.bb)).toBe(0));
    f.output(stale, 1); // the same line as the last delivered report
    await f.tick();
    expect(staleSent()).toBe(2);
    expect(consumed()).toBe(back.generation);
  });

  it("drains an already staged report without scanning, and never scans on a manual run", async () => {
    const f = await make();
    hold(f);
    const path = f.worktrees.add("thr_example");
    await f.tick();
    f.service.setEnabled(f.tracker.id, false);
    f.worktrees.add("thr_other");
    release(f);
    const calls = f.worktrees.scan.calls;
    await f.tick();
    expect(f.worktrees.scan.calls).toBe(calls);
    expect(accepted(f)).toBe(1);
    expect(reported(f)).toEqual([path]);
    expect(f.delivery()?.report_id ?? null).toBeNull();
    await f.tick(); // nothing is due any more
    await f.service.manualRun(f.tracker.id);
    expect(f.worktrees.scan.calls).toBe(calls);
  });
});

describe("notification", () => {
  const trees = 'ACTION archived-worktree thr_example: "/p/a" (4 KiB, clean), "/p/b" (8 KiB, dirty)';

  it("keeps worktree lines in Actions on exit 0 and 1 and counts one per thread line", () => {
    for (const status of [0, 1]) {
      const text = formatNotification(status, [summary(2, 5, 1), "ACTION idle-thread EXA-1", trees].join("\n"));
      expect(text).toContain("2 to review · 2 threads · 5 cards checked");
      expect(text).toContain("**Actions**\n\n- `idle thread` · [EXA-1]");
      expect(text).toContain("- `archived worktree` · @thread:thr_example");
      expect(text).not.toContain("**Archived worktrees**");
    }
  });

  it("puts worktree lines in their own block before the diagnostics on exit 2 and out of the diagnostics", () => {
    const text = formatNotification(2, `boom\n${trees}\n`);
    expect(text).toContain("**Archived worktrees**\n\n- @thread:thr_example");
    expect(text.indexOf("**Archived worktrees**")).toBeLessThan(text.indexOf("```text"));
    expect(text).toContain("```text\nboom\n```");
    expect(text.split("```text")[1]).not.toContain("archived-worktree");
  });
});

describe("status and state", () => {
  it("clears the paths and the cursor on reset, and reads legacy state as zero", async () => {
    const f = await make();
    f.worktrees.add("thr_example");
    await f.tick();
    expect(f.state()).toMatchObject({ reportedWorktrees: [expect.any(String)], lastMeasuredWorktree: expect.any(String) });
    expect((await f.harness.runCli(["checks", "status", "--project", "CHK"])).stdout).toMatch(/Archived worktrees\s+1 reported, 0 pending/);
    expect(JSON.parse((await f.harness.runCli(["checks", "status", "--project", "CHK", "--json"])).stdout!)).toMatchObject({ reportedWorktrees: 1, pendingWorktrees: 0 });
    f.service.setEnabled(f.tracker.id, false);
    f.db.prepare("UPDATE checks_state SET value = json_remove(value, '$.reportedWorktrees', '$.pendingWorktrees', '$.lastMeasuredWorktree')").run();
    expect(counts(f)).toEqual({ reportedWorktrees: 0, pendingWorktrees: 0 });
    expect((await f.harness.runCli(["checks", "status", "--project", "CHK"])).stdout).toMatch(/Archived worktrees\s+0 reported, 0 pending/);
    f.db.prepare("UPDATE checks_state SET value = json_set(value, '$.reportedWorktrees', json_array('/p/a'), '$.lastMeasuredWorktree', '/p/a')").run();
    f.service.reset(f.tracker.id);
    expect(f.state()).toEqual({});
    expect(counts(f)).toEqual({ reportedWorktrees: 0, pendingWorktrees: 0 });
  });
});

describe("unreadable roots and the inventory", () => {
  const host = "host_example";
  const readyEnv = (path: string, extra: Record<string, unknown> = {}) => ({ path, managed: false, projectId: BB_PROJECT, status: "ready", isGitRepo: true, ...extra });
  const failures = (f: Fixture): string[] => f.state().worktreeRootFailures ?? [];
  const plainDirectory = () => tempDir("checks-notgit-");
  const brokenGitfile = () => { const dir = tempDir("checks-gitfile-"); writeFileSync(join(dir, ".git"), "gitdir: /nonexistent/example\n"); return dir; };
  /** The first tick reports the worktree; the tree is then removed so only a complete scan can clear it. */
  const reportedThenGone = async (f: Fixture) => { const path = f.worktrees.add("thr_example"); await f.tick(); f.worktrees.remove(path); return path; };

  it("skips a plain non-repository environment root: history clears, one warning across ticks, one note on recovery", async () => {
    const f = await make();
    const warn = vi.spyOn(f.bb.log, "warn"), info = vi.spyOn(f.bb.log, "info");
    const path = await reportedThenGone(f);
    const root = plainDirectory();
    f.worktrees.scan.environments.push(readyEnv(root));
    await f.tick();
    expect(reported(f)).toEqual([]);
    expect(failures(f)).toEqual([`plain:${root}`]);
    f.worktrees.add("thr_example");
    await f.tick(); await f.tick();
    expect(reported(f)).toEqual([path]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(f.service.status(f.tracker.id)).toMatchObject({ worktreeRootFailures: 1 });
    f.worktrees.scan.environments.pop();
    await f.tick();
    expect(failures(f)).toEqual([]);
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("keeps the history for a broken gitfile", async () => {
    const f = await make();
    const warn = vi.spyOn(f.bb.log, "warn");
    const path = await reportedThenGone(f);
    const root = brokenGitfile();
    f.worktrees.scan.environments.push(readyEnv(root));
    await f.tick(); await f.tick();
    expect(reported(f)).toEqual([path]);
    expect(failures(f)).toEqual([`error:${root}`]);
    expect(warn).toHaveBeenCalledTimes(1);
    f.worktrees.scan.environments.pop();
    await f.tick();
    expect(reported(f)).toEqual([]);
  });

  it("keeps the history when the listing of a second repository fails after its discovery succeeded", async () => {
    const f = await make();
    const warn = vi.spyOn(f.bb.log, "warn");
    const path = await reportedThenGone(f);
    const second = f.worktrees.makeRepo(join(tempDir("checks-second-"), "repo"));
    f.worktrees.scan.environments.push(readyEnv(second));
    // The plain-directory message from the listing stage is not the exception: only the discovery stage qualifies.
    const real = execFileSync("which", ["git"]).toString().trim();
    vi.stubEnv("PATH", `${binDir({ git: `case "$*" in *"worktree list"*) case "$(pwd -P)" in "${second}") echo "fatal: not a git repository (or any of the parent directories): .git" >&2; exit 128;; esac;; esac\nexec "${real}" "$@"` })}:${process.env.PATH}`);
    await f.tick(); await f.tick();
    expect(reported(f)).toEqual([path]);
    expect(failures(f)).toEqual([`error:${second}`]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not skip a repository whose metadata is damaged: a surviving .git entry keeps the history", async () => {
    const f = await make();
    const path = await reportedThenGone(f);
    const damaged = f.worktrees.makeRepo(join(tempDir("checks-damaged-"), "repo"));
    rmSync(join(damaged, ".git", "HEAD"));
    f.worktrees.scan.environments.push(readyEnv(damaged));
    await f.tick();
    expect(reported(f)).toEqual([path]);
    expect(failures(f)).toEqual([`error:${damaged}`]);
  });

  it("does not skip a damaged bare repository whose linked worktree is alive", async () => {
    const f = await make();
    const path = await reportedThenGone(f);
    const bare = realpathSync(tempDir("checks-bare-"));
    execFileSync("git", ["init", "-q", "--bare", "-b", "main"], { cwd: bare });
    execFileSync("git", ["--git-dir", bare, "worktree", "add", "-q", "--orphan", join(tempDir("checks-linked-"), "tree")], { cwd: bare });
    rmSync(join(bare, "HEAD"));
    f.worktrees.scan.environments.push(readyEnv(bare));
    await f.tick();
    expect(reported(f)).toEqual([path]);
    expect(failures(f)).toEqual([`error:${bare}`]);
  });

  it("does not announce a recovery for a root that only changed its kind of failure", async () => {
    const f = await make();
    const warn = vi.spyOn(f.bb.log, "warn"), info = vi.spyOn(f.bb.log, "info");
    f.worktrees.add("thr_example");
    const root = join(tempDir("checks-changing-"), "source");
    f.worktrees.scan.sources.push({ hostId: host, path: root });
    await f.tick();
    expect(failures(f)).toEqual([`missing:${root}`]);
    mkdirSync(root);
    writeFileSync(join(root, ".git"), "gitdir: /nonexistent/example\n");
    await f.tick();
    expect(failures(f)).toEqual([`error:${root}`]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(info).not.toHaveBeenCalled();
  });

  it("announces a root transition once even when the scan fails after it", async () => {
    const f = await make();
    const warn = vi.spyOn(f.bb.log, "warn");
    const unreadable = () => warn.mock.calls.filter(([message]) => String(message).includes("could not be read")).length;
    f.worktrees.add("thr_example");
    const threads = f.worktrees.scan.threads;
    const list = async ({ threadIds, archived }: { threadIds: string[]; archived?: boolean }) => threadIds.flatMap((id) => {
      const row = threads.get(id);
      return row && (!archived || row.archivedAt != null) ? [{ id, ...row }] : [];
    });
    f.worktrees.scan.environments.push(readyEnv(brokenGitfile()));
    f.harness.sdk.stub("threads.list", async () => { throw new Error("threads unavailable"); });
    await f.tick();
    expect(unreadable()).toBe(0);
    expect(failures(f)).toEqual([]);
    f.harness.sdk.stub("threads.list", list);
    await f.tick(); await f.tick();
    expect(unreadable()).toBe(1);
    expect(failures(f)).toHaveLength(1);
  });

  it("forgets the full-inventory hint when the last repository root disappears", async () => {
    const f = await make();
    const w = f.worktrees;
    const path = w.add("thr_example");
    for (let i = 0; i < 250; i++) w.scan.environments.push({ path: join(w.scan.storage, `thr_other${i}`, "tree"), managed: true, projectId: "proj_other", status: "ready", isGitRepo: false });
    w.scan.environments.push({ path, managed: true, projectId: "proj_other", status: "ready", isGitRepo: false });
    const source = w.source;
    const calls = async () => { const before = w.scan.listCalls; await f.tick(); return w.scan.listCalls - before; };
    await calls(); // a managed archived tree: nothing reported, the hint is set
    w.scan.sources = [];
    const seen = [await calls(), await calls()];
    w.scan.sources = [{ hostId: host, path: source }];
    expect(seen).toEqual([3, 1]);
  });

  it("keeps the history and the cursor while no root can be read, then recovers", async () => {
    const f = await make();
    const warn = vi.spyOn(f.bb.log, "warn"), info = vi.spyOn(f.bb.log, "info");
    const path = f.worktrees.add("thr_example");
    await f.tick();
    const cursor = f.state().lastMeasuredWorktree;
    expect(cursor).toBe(path);
    const source = f.worktrees.source;
    const root = plainDirectory();
    f.worktrees.scan.sources = [{ hostId: host, path: root }];
    for (let tick = 0; tick < 2; tick++) {
      await f.tick();
      expect(f.service.status(f.tracker.id)).toMatchObject({ worktreeRootFailures: 1, reportedWorktrees: 1 });
      expect(f.state().lastMeasuredWorktree).toBe(cursor);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    f.worktrees.scan.sources = [{ hostId: host, path: source }];
    await f.tick();
    expect(f.service.status(f.tracker.id)).toMatchObject({ worktreeRootFailures: 0, reportedWorktrees: 1 });
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("clears obsolete keys when the failing root leaves the inventory, warns again when it returns, and keeps a missing source counted", async () => {
    const f = await make();
    const warn = vi.spyOn(f.bb.log, "warn");
    const path = f.worktrees.add("thr_example");
    await f.tick();
    const source = f.worktrees.source;
    f.worktrees.scan.sources = [];
    const broken = readyEnv(brokenGitfile());
    f.worktrees.scan.environments.push(broken);
    await f.tick();
    expect(failures(f)).toHaveLength(1);
    f.worktrees.scan.environments.pop();
    await f.tick(); // zero roots, zero failures
    expect(failures(f)).toEqual([]);
    f.worktrees.scan.environments.push(broken);
    await f.tick();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(reported(f)).toEqual([path]);
    expect(f.state().lastMeasuredWorktree).toBe(path);
    const absent = join(tempDir("checks-none-"), "absent");
    f.worktrees.scan.environments.pop();
    f.worktrees.scan.sources = [{ hostId: host, path: source }, { hostId: host, path: absent }];
    await f.tick(); await f.tick();
    expect(failures(f)).toEqual([`missing:${absent}`]);
    expect(warn).toHaveBeenCalledTimes(3);
    f.worktrees.remove(path);
    await f.tick();
    expect(reported(f)).toEqual([path]);
    f.worktrees.scan.sources.pop();
    await f.tick();
    expect(reported(f)).toEqual([]);
    expect(failures(f)).toEqual([]);
  });

  it("clears a reported path another project's managed environment holds, and reports it again once released", async () => {
    const f = await make();
    const path = f.worktrees.add("thr_example");
    await f.tick();
    expect(reported(f)).toEqual([path]);
    const holder = { path, managed: true, projectId: "proj_other", status: "ready", isGitRepo: false };
    f.worktrees.scan.environments.push(holder);
    await f.tick();
    expect(reported(f)).toEqual([]);
    f.worktrees.scan.environments.pop();
    await f.tick();
    expect(reported(f)).toEqual([path]);
    expect(accepted(f)).toBe(2);
  });

  it("protects a tree whose managed environment is stored under an alias, even beyond the first inventory page", async () => {
    const f = await make();
    const path = f.worktrees.add("thr_example");
    const alias = join(tempDir("checks-alias-"), "alias");
    symlinkSync(path, alias);
    for (let i = 0; i < 250; i++) f.worktrees.scan.environments.push({ path: join(f.worktrees.scan.storage, `thr_other${i}`, "tree"), managed: true, projectId: "proj_other", status: "ready", isGitRepo: false });
    f.worktrees.scan.environments.push({ path: alias, managed: true, projectId: "proj_other", status: "destroyed", isGitRepo: false });
    await f.tick();
    expect(reported(f)).toEqual([]);
    expect(accepted(f)).toBe(0);
  });

  it("pages the whole inventory only when an archived candidate exists or is expected", async () => {
    const f = await make();
    const w = f.worktrees;
    for (let i = 0; i < 250; i++) w.scan.environments.push({ path: join(w.scan.storage, `thr_other${i}`, "tree"), managed: true, projectId: "proj_other", status: "ready", isGitRepo: false });
    const calls = async () => { const before = w.scan.listCalls; await f.tick(); return w.scan.listCalls - before; };
    const seen = [await calls()]; // nothing archived: only this project's ready environments
    const path = w.add("thr_example");
    seen.push(await calls()); // a new candidate: the filtered pass, then one whole pass
    seen.push(await calls()); // reported: one whole pass
    w.remove(path);
    seen.push(await calls()); // still expected, and the clearing tick
    seen.push(await calls()); // nothing archived any more
    expect(seen).toEqual([1, 4, 3, 3, 1]);
    expect(reported(f)).toEqual([]);
  });

  it("finds a repository reachable only through a ready environment root on a host that ignores the filters", async () => {
    const f = await make();
    const w = f.worktrees;
    const other = w.makeRepo(join(tempDir("checks-second-"), "repo"));
    const tree = join(w.scan.storage, "thr_second", "tree");
    mkdirSync(join(w.scan.storage, "thr_second"), { recursive: true });
    execFileSync("git", ["worktree", "add", "-q", "--detach", tree], { cwd: other });
    w.scan.threads.set("thr_second", { archivedAt: 1, deletedAt: null });
    w.scan.environments.push(readyEnv(other), { path: join(w.scan.storage, "thr_x", "tree"), managed: true, projectId: "proj_other", status: "destroyed", isGitRepo: true });
    f.harness.sdk.stub("environments.list", async ({ limit, offset }: { limit: number; offset: number }) => w.scan.environments.slice(offset, offset + limit));
    await f.tick();
    expect(reported(f)).toEqual([realpathSync(tree)]);
  });

  it("reads state without the field as zero and drops it on reset", async () => {
    const f = await make();
    f.worktrees.scan.sources = [{ hostId: host, path: plainDirectory() }];
    await f.tick();
    expect(failures(f)).toHaveLength(1);
    expect(JSON.parse((await f.harness.runCli(["checks", "status", "--project", "CHK", "--json"])).stdout!)).toMatchObject({ worktreeRootFailures: 1 });
    expect((await f.harness.runCli(["checks", "status", "--project", "CHK"])).stdout).toMatch(/Archived worktrees\s+0 reported, 0 pending, 1 unreadable roots/);
    f.service.setEnabled(f.tracker.id, false);
    f.db.prepare("UPDATE checks_state SET value = json_remove(value, '$.worktreeRootFailures')").run();
    expect(f.service.status(f.tracker.id)).toMatchObject({ worktreeRootFailures: 0 });
    f.db.prepare("UPDATE checks_state SET value = json_set(value, '$.worktreeRootFailures', json_array('error:/p/a'))").run();
    f.service.reset(f.tracker.id);
    expect(f.state()).toEqual({});
  });
});
