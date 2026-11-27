import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CheckoutRefreshError, command, execute, refreshCheckout, type ScriptRun } from "./runner";
import { binDir, cleanTempDirs, createRepo, executable, tempDir } from "./fixtures";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 }); // real git and shell processes: a loaded machine needs more than the default

afterEach(() => { vi.unstubAllEnvs(); cleanTempDirs(); });
const signal = () => new AbortController().signal;
const realGit = execFileSync("which", ["git"]).toString().trim();

const base = (repo: { url: string }, overrides: Partial<ScriptRun> = {}): ScriptRun => ({
  remote: repo.url, branch: "main", script: "checks/run.sh", args: [], timeoutSeconds: 20, snapshots: false, bbProjectId: "proj_example", manager: "thr_example",
  committed: null, bbCli: "", runtimePath: "", killGraceMs: 200, ...overrides,
});
const run = (dir: string, repo: { url: string }, overrides: Partial<ScriptRun> = {}) => execute(dir, "tracker_example", base(repo, overrides), signal());
const checkout = (dir: string) => join(dir, "checks", "checkouts", "tracker_example");

describe("checkout", () => {
  it("sets origin to the URL, fetches depth 1 and leaves a detached checkout", async () => {
    const repo = createRepo(); repo.commit({ "checks/run.sh": executable("echo ok") });
    const dir = tempDir();
    await expect(run(dir, repo)).resolves.toMatchObject({ code: 0, output: "ok\n" });
    const root = checkout(dir);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root }).toString().trim();
    expect(git("remote", "get-url", "origin")).toBe(repo.url);
    expect(git("rev-parse", "--is-shallow-repository")).toBe("true");
    expect(() => execFileSync("git", ["symbolic-ref", "-q", "HEAD"], { cwd: root, stdio: "pipe" })).toThrow();
    // A later tick takes the new URL and the new tip.
    const second = createRepo(); second.commit({ "checks/run.sh": executable("echo second") });
    await expect(run(dir, second)).resolves.toMatchObject({ output: "second\n" });
    expect(git("remote", "get-url", "origin")).toBe(second.url);
  });

  it("runs git with prompts and hooks disabled", async () => {
    const repo = createRepo(); repo.commit({ "checks/run.sh": executable("echo ok") });
    const dir = tempDir();
    const log = join(tempDir(), "git.log");
    const shim = binDir({ git: `echo "prompt=$GIT_TERMINAL_PROMPT args=$*" >> "$SHIM_LOG"\nexec ${realGit} "$@"` });
    vi.stubEnv("PATH", `${shim}:${process.env.PATH}`); vi.stubEnv("SHIM_LOG", log);
    await run(dir, repo);
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(5);
    for (const line of lines) expect(line).toMatch(/prompt=0 args=-c core\.hooksPath=\/dev\/null /);
    // A hook planted in the private checkout never runs.
    const mark = join(tempDir(), "hook-ran");
    const hook = join(checkout(dir), ".git", "hooks", "post-checkout");
    writeFileSync(hook, `#!/bin/sh\ntouch ${mark}\n`, { mode: 0o755 });
    repo.commit({ "marker.txt": "new" });
    await run(dir, repo);
    expect(existsSync(mark)).toBe(false);
  });

  it("kills a timed-out fetch and its helpers, removes only the lock it created, and keeps a lock that existed", async () => {
    const root = tempDir(); const lock = join(root, "shallow.lock");
    const hang = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);';
    const timeOut = (script: string) => expect(command(process.execPath, ["-e", script], root, signal(), { timeoutMs: 500, shallowLock: lock, killGraceMs: 200 })).rejects.toThrow(/timed out/);
    await timeOut(`require('node:fs').writeFileSync('shallow.lock', 'new'); ${hang}`);
    expect(existsSync(lock)).toBe(false);
    writeFileSync(lock, "existing");
    await timeOut(hang);
    expect(readFileSync(lock, "utf8")).toBe("existing");
  });

  it("removes a lock the cancelled fetch created, after the exit, and keeps one that existed", async () => {
    const root = tempDir(); const lock = join(root, "shallow.lock");
    const hang = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);';
    const cancel = async (before: string) => {
      const started = join(root, "started"); rmSync(started, { force: true });
      const controller = new AbortController();
      const running = command(process.execPath, ["-e", `${before} process.on("SIGTERM", () => {}); require('node:fs').writeFileSync('started', ''); setInterval(() => {}, 1000);`], root, controller.signal, { timeoutMs: 30_000, shallowLock: lock, killGraceMs: 200 });
      await vi.waitFor(() => expect(existsSync(started)).toBe(true), { timeout: 20_000, interval: 20 });
      controller.abort(new Error("shutdown"));
      await expect(running).rejects.toThrow(/shutdown/);
    };
    await cancel("require('node:fs').writeFileSync('shallow.lock', 'new');");
    expect(existsSync(lock)).toBe(false);
    writeFileSync(lock, "existing");
    await cancel("");
    expect(readFileSync(lock, "utf8")).toBe("existing");
  });

  it("refuses a script path that escapes the checkout", async () => {
    const repo = createRepo(); repo.commit({ "checks/run.sh": executable("echo ok") });
    execFileSync("ln", ["-s", "/bin/sh", join(repo.dir, "checks", "link.sh")]); repo.commit({});
    await expect(run(tempDir(), repo, { script: "checks/link.sh" })).rejects.toThrow(/inside the checkout/);
  });

  it("reports a failed refresh as a CheckoutRefreshError without running the script", async () => {
    const repo = createRepo(); const mark = join(tempDir(), "ran");
    repo.commit({ "checks/run.sh": executable(`touch ${mark}`) });
    await expect(run(tempDir(), { url: "file:///nonexistent/example" })).rejects.toBeInstanceOf(CheckoutRefreshError);
    await expect(run(tempDir(), repo, { branch: "missing-branch" })).rejects.toBeInstanceOf(CheckoutRefreshError);
    expect(existsSync(mark)).toBe(false);
  });

  it("drops a tracked-file edit and ignored files left by the previous run", async () => {
    const repo = createRepo();
    repo.commit({ "data.txt": "original\n", ".gitignore": "cache.tmp\n", "checks/run.sh": executable("cat data.txt; ls cache.tmp stray.txt 2>/dev/null; echo changed > data.txt; echo x > cache.tmp; echo x > stray.txt") });
    const dir = tempDir();
    expect((await run(dir, repo)).output).toBe("original\n");
    expect((await run(dir, repo)).output).toBe("original\n");
  });

  it("aborts a refresh on shutdown", async () => {
    const controller = new AbortController(); controller.abort(new Error("shutdown"));
    await expect(refreshCheckout(tempDir(), "file:///nonexistent/example", "main", controller.signal)).rejects.toThrow(/shutdown|aborted/);
  });
});

describe("execution", () => {
  const printEnv = executable('echo "BB_CLI=$BB_CLI"; echo "bb=$(bb)"; echo "gh=$(gh)"; echo "PROJECT=$BB_PROJECT_ID THREAD=$BB_THREAD_ID"; echo "ARGS=$*"; echo "COMMITTED=${BB_CHECKS_COMMITTED_STATE:+set}"; echo "CANDIDATE=${BB_CHECKS_CANDIDATE_SNAPSHOT:+set}"; echo "SAME=$([ "$BB_CHECKS_COMMITTED_STATE" = "$BB_SWEEP_COMMITTED_STATE" ] && [ "$BB_CHECKS_CANDIDATE_SNAPSHOT" = "$BB_SWEEP_CANDIDATE_SNAPSHOT" ] && echo yes)"');

  it("exports both snapshot variables with snapshots off, under the neutral and the older names, and no snapshot arguments", async () => {
    const repo = createRepo(); repo.commit({ "checks/run.sh": printEnv });
    const output = (await run(tempDir(), repo, { args: ["--root", "{manager}", "{manager}"] })).output;
    expect(output).toContain("COMMITTED=set"); expect(output).toContain("CANDIDATE=set"); expect(output).toContain("SAME=yes");
    expect(output).toContain("ARGS=--root thr_example thr_example");
    expect(output).toContain("PROJECT=proj_example THREAD=thr_example");
  });

  it("launches the fixture bb and gh from the server PATH, an inherited BB_CLI and the settings", async () => {
    const serverBin = binDir({ bb: "echo bb-server", gh: "echo gh-server" });
    const inheritedBin = binDir({ bb: "echo bb-inherited" });
    const overrideBin = binDir({ bb: "echo bb-override" });
    const runtimeBin = binDir({ gh: "echo gh-runtime" });
    const repo = createRepo(); repo.commit({ "checks/run.sh": printEnv });
    vi.stubEnv("PATH", `${serverBin}:${process.env.PATH}`); vi.stubEnv("BB_CLI", join(inheritedBin, "bb"));
    // Empty settings: the inherited BB_CLI's directory goes in front, so bare bb and BB_CLI are one binary.
    let output = (await run(tempDir(), repo)).output;
    expect(output).toContain(`BB_CLI=${join(inheritedBin, "bb")}`); expect(output).toContain("bb=bb-inherited"); expect(output).toContain("gh=gh-server");
    // A configured bb that differs from both wins and is exported.
    output = (await run(tempDir(), repo, { bbCli: join(overrideBin, "bb") })).output;
    expect(output).toContain(`BB_CLI=${join(overrideBin, "bb")}`); expect(output).toContain("bb=bb-override"); expect(output).toContain("gh=gh-server");
    // A configured runtime path replaces the server PATH; the bb directory still leads.
    output = (await run(tempDir(), repo, { bbCli: join(overrideBin, "bb"), runtimePath: runtimeBin })).output;
    expect(output).toContain("bb=bb-override"); expect(output).toContain("gh=gh-runtime");
    // Without BB_CLI anywhere the PATH has no bb directory in front.
    vi.stubEnv("BB_CLI", "");
    output = (await run(tempDir(), repo)).output;
    expect(output).toContain("bb=bb-server");
  });

  it("rejects a relative checksBbCli", async () => {
    const repo = createRepo(); repo.commit({ "checks/run.sh": printEnv });
    await expect(run(tempDir(), repo, { bbCli: "bin/bb" })).rejects.toThrow(/absolute path/);
  });

  it("runs .py scripts through python3 and other scripts directly", async () => {
    const repo = createRepo(); repo.commit({ "checks/run.py": "import sys\nprint('py', sys.argv[1:])\n", "checks/run.sh": executable("echo sh") });
    expect((await run(tempDir(), repo, { script: "checks/run.py", args: ["a"] })).output).toBe("py ['a']\n");
    expect((await run(tempDir(), repo)).output).toBe("sh\n");
  });

  it("caps output at 1 MB and turns a timeout into a rejection", async () => {
    const repo = createRepo();
    repo.commit({ "checks/run.sh": executable("head -c 1500000 /dev/zero | tr '\\0' a") });
    await expect(run(tempDir(), repo)).rejects.toThrow(/exceeds 1 MB/);
    repo.commit({ "checks/run.sh": executable("sleep 30") });
    await expect(run(tempDir(), repo, { timeoutSeconds: 1 })).rejects.toThrow(/timed out/);
  });

  it("ends the whole process group on a timeout", async () => {
    const repo = createRepo(); repo.commit({ "checks/run.sh": executable('sleep 300 &\necho $! > "$PWD/child.pid"\nwait') });
    const dir = tempDir();
    const pidFile = join(checkout(dir), "child.pid");
    const realSetTimeout = setTimeout;
    let pid = NaN, running: ReturnType<typeof run> | undefined, done = false;
    const sleep = (ms: number) => new Promise<void>((resolve) => realSetTimeout(resolve, ms)); // on the real timer; the fake one is for the command's timeout
    // The timeout is a fake timer: it cannot fire before the script has started its helper, however slow the machine is.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let early: unknown;
      running = run(dir, repo, { timeoutSeconds: 5 });
      running.then(() => { done = true; }, (error) => { done = true; early = error; });
      const started = () => { try { return Number(readFileSync(pidFile, "utf8").trim()); } catch { return NaN; } };
      const deadline = Date.now() + 60_000; // the real clock: Date is not faked
      while (!(started() > 0)) {
        if (early) throw early; // the run failed before the helper started: report that, not a missing file
        if (Date.now() > deadline) throw new Error("The script did not write child.pid within 60 s.");
        await sleep(20);
      }
      pid = started();
      vi.advanceTimersByTime(5000);
      await expect(running).rejects.toThrow(/timed out/);
    } finally {
      // A run the test did not finish must end here, or its script outlives the test: let the command's own timeout fire and kill the group.
      try {
        const end = Date.now() + 30_000;
        while (running && !done && Date.now() < end) { vi.advanceTimersByTime(5000); await sleep(20); }
        if (running && !done) throw new Error("Cleanup: the run did not settle within 30 s.");
        await running?.catch(() => undefined); // settled already: returns at once
      } finally { vi.useRealTimers(); }
    }
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(/ESRCH|kill/), { timeout: 30_000, interval: 20 });
  });

  it("cancels a running script on shutdown", async () => {
    const repo = createRepo(); repo.commit({ "checks/run.sh": executable('echo x > "$PWD/started"; sleep 30') });
    const controller = new AbortController();
    const dir = tempDir();
    const running = execute(dir, "tracker_example", base(repo), controller.signal);
    await vi.waitFor(() => expect(existsSync(join(checkout(dir), "started"))).toBe(true), { timeout: 20_000, interval: 20 });
    controller.abort(new Error("shutdown"));
    await expect(running).rejects.toThrow(/shutdown/);
  });

  it("reads the candidate only with snapshots on: complete JSON passes, invalid JSON is a failure, and an exit of 2 ignores it", async () => {
    const repo = createRepo();
    const script = (body: string) => repo.commit({ "checks/run.sh": executable(body) });
    script('echo "ARGS=$*"; echo \'{"a":1}\' > "$BB_CHECKS_CANDIDATE_SNAPSHOT"');
    const off = await run(tempDir(), repo);
    expect(off.snapshot).toBeNull(); expect(off.output).toBe("ARGS=\n");
    const on = await run(tempDir(), repo, { snapshots: true });
    expect(on.snapshot?.toString()).toBe('{"a":1}\n'); expect(on.output).toMatch(/ARGS=--committed-state \S+ --candidate-snapshot \S+/);
    script('echo \'{"a"\' > "$BB_SWEEP_CANDIDATE_SNAPSHOT"; exit 1');
    await expect(run(tempDir(), repo, { snapshots: true })).rejects.toThrow(/complete JSON/);
    script('echo \'{"a"\' > "$BB_SWEEP_CANDIDATE_SNAPSHOT"; exit 2');
    expect((await run(tempDir(), repo, { snapshots: true })).snapshot).toBeNull();
    // Malformed UTF-8 inside a string must not pass as JSON after a lenient decode.
    script('printf \'{"a":"\\377"}\' > "$BB_SWEEP_CANDIDATE_SNAPSHOT"');
    await expect(run(tempDir(), repo, { snapshots: true })).rejects.toThrow(/valid UTF-8/);
    // No candidate at all is fine.
    script("echo none");
    expect((await run(tempDir(), repo, { snapshots: true })).snapshot).toBeNull();
  });

  it("hands the script a read-only committed copy, or none, and removes the temporary files", async () => {
    const repo = createRepo();
    repo.commit({ "checks/run.sh": executable('if [ -e "$BB_SWEEP_COMMITTED_STATE" ]; then cat "$BB_SWEEP_COMMITTED_STATE"; ls -l "$BB_SWEEP_COMMITTED_STATE" | cut -c1-10; echo "$BB_SWEEP_COMMITTED_STATE" > "$PWD/path.txt"; else echo absent; fi') });
    const dir = tempDir();
    expect((await run(dir, repo, { snapshots: true })).output).toBe("absent\n");
    const withState = await run(dir, repo, { snapshots: true, committed: Buffer.from('{"state":1}') });
    expect(withState.output).toBe('{"state":1}-r--------\n');
    expect(existsSync(readFileSync(join(checkout(dir), "path.txt"), "utf8").trim())).toBe(false);
  });
});

describe("command receipt input", () => {
  const fixture = join(import.meta.dirname, "fixtures/receipt-validator.mjs");
  const runFixture = (mode: string, input: string, timeoutMs = 5000) =>
    command(process.execPath, [fixture, mode], process.cwd(), signal(), { input, separateStdout: true, timeoutMs });
  it("captures stdout separately with stderr first and enforces their combined limit", async () => {
    const input = JSON.stringify({ receipt: "example" });
    expect(await runFixture("accept", input)).toEqual({
      code: 0, output: "validator diagnostic\n\n  verified example  \n", stdout: "\n  verified example  \n",
    });
    await expect(runFixture("overflow", input)).rejects.toThrow(/exceeds/);
  });
  it("handles closed and stalled stdin", async () => {
    const pending = "x".repeat(4_000_000);
    await expect(runFixture("exit-early", pending)).rejects.toThrow();
    await expect(runFixture("never-read", pending, 250)).rejects.toThrow(/timed out/);
  });
});
