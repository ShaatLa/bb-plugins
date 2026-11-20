import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { receiptPolling } from "../steer";
import { scanTuning } from "./archived-worktrees";
import { formatNotification } from "./notification";
import { reportContents } from "./reports";
import { checksTuning } from "./service";
import { binDir, BB_PROJECT, cleanTempDirs, MANAGER, setup, tempDir, type Fixture } from "./fixtures";

// A filesystem call that never settles, for the one path a test names.
const stall = vi.hoisted(() => ({ path: null as string | null, calls: 0, release: () => {} }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, realpath: Object.assign((path: string, ...rest: unknown[]) => (path === stall.path ? new Promise<string>((resolve) => { stall.calls++; stall.release = () => resolve(path); }) : (actual.realpath as (...args: unknown[]) => Promise<string>)(path, ...rest)), actual.realpath) };
});

const fixtures: Fixture[] = [];
const make = async (script = "", code = 0) => {
  const f = await setup(); fixtures.push(f); f.standard(); f.output(script, code); f.enable(); f.worktrees.enable(); return f;
};
beforeEach(() => { receiptPolling.tries = 1; receiptPolling.delayMs = 0; checksTuning.lateSearchMs = 0; });
afterEach(async () => { vi.unstubAllEnvs(); scanTuning.measurementMs = 30_000; scanTuning.deadlineMs = 60_000; stall.path = null; stall.calls = 0; stall.release(); await Promise.all(fixtures.splice(0).map((f) => f.dispose())); cleanTempDirs(); });

/** A definite rejection keeps the staged report pending, so its raw body can be read. */
const hold = (f: Fixture) => { f.threads.sendMode = "throw"; f.threads.sendError = Object.assign(new Error("forbidden"), { status: 403 }); };
const release = (f: Fixture) => { f.threads.sendMode = "queue"; f.threads.sendError = undefined; };
const body = (f: Fixture) => f.delivery()?.pending_body as string;
const accepted = (f: Fixture) => f.attempts().filter((a) => ["queued", "appended", "inline"].includes(a.outcome as string)).length;
const reported = (f: Fixture): string[] => f.state().reportedWorktrees ?? [];
const pending = (f: Fixture): string[] => f.state().pendingWorktrees ?? [];
const counts = (f: Fixture) => { const { reportedWorktrees, pendingWorktrees } = f.service.status(f.tracker.id); return { reportedWorktrees, pendingWorktrees }; };
const worktreeLines = (text: string) => text.split("\n").filter((line) => line.startsWith("ACTION archived-worktree "));
const summary = (threads: number, cards: number, actions: number) => `sweep: ${threads} threads, ${cards} cards checked, ${actions} actions`;

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
    stall.release(); stall.path = null;
    await vi.waitFor(async () => { f.output("ACTION idle-thread EXA-3", 1); await f.tick(); expect(f.worktrees.scan.calls).toBe(2); });
    expect(reported(f)).toEqual([path]);
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
