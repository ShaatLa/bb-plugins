import { afterEach, expect, it, vi } from "vitest";

import { mkdtemp, writeFile, chmod, readFile, readdir, rm, mkdir, stat, utimes, symlink, realpath } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

// A remote-run test uploads the whole worktree; on a loaded machine that exceeds the 5 s default.
vi.setConfig({ testTimeout: 30000 });

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
async function run(body: string, command: string, input = "", args: string[] = []) {
  const dir = await mkdtemp(join(tmpdir(), "slots-wrapper-")); dirs.push(dir);
  const bb = join(dir, "bb"), log = join(dir, "log");
  await writeFile(bb, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$LOG"\n${body}\n`); await chmod(bb, 0o755);
  const result = spawnSync("sh", ["./slots-run.sh", ...args, "--est", "1m", "--job", "test", "--", "sh", "-c", command], {
    cwd: import.meta.dirname, input, encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LOG: log, SLOTS_RUN_TEST_STEP: "0.01" }, timeout: 30000,
  });
  return { result, log: await readFile(log, "utf8") };
}
it("passes stdin and command status and cleans up once", async () => {
  const { result, log } = await run('case $2 in acquire) echo "use use-1 lease lease-2 renew 30" ;; esac', 'cat; exit 7', 'hello\n');
  expect(result.status).toBe(7); expect(result.stdout).toBe('hello\n'); expect(log.match(/slots done use-1/g)).toHaveLength(1);
});
it("pins this Mac for a local-model use because the command runs here", async () => {
  const acquire = 'case $2 in acquire) echo "use use-1 lease lease-2 renew 30" ;; esac';
  expect((await run(acquire, 'true', '', ['--pool', 'local-model'])).log).toContain('slots acquire --pool local-model --job test --est 1m --device local');
  expect((await run(acquire, 'true')).log).not.toContain('--device');
});
it("does not run commands on timeout or malformed acquire output", async () => {
  const timeout = await run('exit 75', 'echo ran'); expect(timeout.result.status).toBe(75); expect(timeout.result.stdout).toBe('');
  const malformed = await run('echo "use use-x lease lease-1 renew 30"', 'echo ran'); expect(malformed.result.status).toBe(70); expect(malformed.log).not.toContain('slots done');
  const unasked = await run('case $2 in acquire) echo "use use-1 lease lease-2 renew 30 host host_example" ;; esac', 'echo ran', '', ['--local']); expect(unasked.result.status).toBe(70); expect(unasked.result.stdout).toBe('');
});
it("passes placement and tool requirements to acquire", async () => {
  const bb = 'case $2 in acquire) echo "use use-1 lease lease-2 renew 30" ;; esac';
  expect((await run(bb, 'true')).log).toContain('--place project');
  expect((await run(bb, 'true', '', ['--anywhere', '--needs', 'go,docker'])).log).toContain('--place auto --needs go,docker');
  expect((await run(bb, 'true', '', ['--spill', 'auto'])).log).toContain('--place auto');
  expect((await run(bb, 'true', '', ['--local'])).log).toContain('--place local');
});
it("bounds a hung done and ignores its failure", async () => {
  const hung = await run('case $2 in acquire) echo "use use-1 lease lease-2 renew 30" ;; done) exec sleep 20 ;; esac', 'exit 9');
  expect(hung.result.status).toBe(9); expect(hung.log).toContain('slots done use-1');
  const failed = await run('case $2 in acquire) echo "use use-1 lease lease-2 renew 30" ;; done) exit 1 ;; esac', 'exit 4');
  expect(failed.result.status).toBe(4);
});
it("renews during a command and stops on a forbidden heartbeat", async () => {
  const r = await run('case $2 in acquire) echo "use use-1 lease lease-2 renew 1" ;; heartbeat) exit 2 ;; esac', 'sleep 0.15');
  expect(r.result.status).toBe(0); expect(r.log.match(/slots heartbeat/g)).toHaveLength(1); expect(r.log.match(/slots done/g)).toHaveLength(1);
});
it("retries failed heartbeats and kills a hung heartbeat before done", async () => {
  const r = await run('case $2 in acquire) echo "use use-1 lease lease-2 renew 1" ;; heartbeat) exit 1 ;; esac', 'sleep 0.15');
  expect((r.log.match(/slots heartbeat/g) ?? []).length).toBeGreaterThan(1);
  const hung = await run('case $2 in acquire) echo "use use-1 lease lease-2 renew 1" ;; heartbeat) exec sleep 20 ;; esac', 'sleep 0.06');
  expect(hung.result.status).toBe(0); expect(hung.log).toContain('slots done use-1');
});

it.each([[false, "SIGTERM"], [true, "SIGTERM"], [false, "SIGINT"], [true, "SIGINT"]] as const)("keeps renewing until a signaled command exits (group=%s, signal=%s)", async (group, signal) => {
  const dir = await mkdtemp(join(tmpdir(), "slots-signal-")); dirs.push(dir);
  const bb = join(dir, "bb"), log = join(dir, "log"), ready = join(dir, "ready");
  await writeFile(bb, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$LOG"\ncase $2 in acquire) echo "use use-1 lease lease-2 renew 1" ;; esac\n`); await chmod(bb, 0o755);
  const child = spawn("sh", ["./slots-run.sh", "--est", "1m", "--job", "test", "--", "sh", "-c", 'trap "" TERM INT; : > "$READY"; sleep 0.4; exit 7'], {
    cwd: import.meta.dirname, detached: true, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LOG: log, READY: ready, SLOTS_RUN_TEST_STEP: "0.02" }, stdio: "ignore",
  });
  for (let i = 0; i < 1000; i++) { try { await readFile(ready); break; } catch { await sleep(10); } }
  process.kill(group ? -child.pid! : child.pid!, signal);
  await sleep(100);
  const during = await readFile(log, "utf8"); expect(during).toContain("slots heartbeat"); expect(during).not.toContain("slots done");
  const code = await new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
  expect(code).toBe(7); expect((await readFile(log, "utf8")).match(/slots done/g)).toHaveLength(1);
});
it("preserves a signal exit status", async () => {
  const r = await run('case $2 in acquire) echo "use use-1 lease lease-2 renew 30" ;; esac', 'kill -TERM $$');
  expect(r.result.status).toBe(143); expect(r.log).toContain('slots done use-1');
});
it("falls back to pid liveness when ps is unavailable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "slots-no-ps-")); dirs.push(dir);
  const log = join(dir, "log");
  await writeFile(join(dir, "bb"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$LOG"\ncase $2 in acquire) echo "use use-1 lease lease-2 renew 1" ;; esac\n');
  await chmod(join(dir, "bb"), 0o755); await writeFile(join(dir, "ps"), '#!/bin/sh\nexit 1\n'); await chmod(join(dir, "ps"), 0o755);
  const result = spawnSync("sh", ["./slots-run.sh", "--est", "1m", "--job", "test", "--", "sleep", "0.1"], { cwd: import.meta.dirname, encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LOG: log, SLOTS_RUN_TEST_STEP: "0.01" }, timeout: 5000 });
  expect(result.status).toBe(0); expect(await readFile(log, "utf8")).toContain("slots heartbeat");
});
it("stops renewing after the wrapper is killed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "slots-killed-")); dirs.push(dir);
  const bb = join(dir, "bb"), log = join(dir, "log");
  await writeFile(bb, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$LOG"\ncase $2 in acquire) echo "use use-1 lease lease-2 renew 1" ;; esac\n'); await chmod(bb, 0o755);
  const child = spawn("sh", ["./slots-run.sh", "--est", "1m", "--job", "test", "--", "sleep", "0.6"], { cwd: import.meta.dirname, detached: true, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LOG: log, SLOTS_RUN_TEST_STEP: "0.02" }, stdio: "ignore" });
  for (let i = 0; i < 100; i++) { try { if ((await readFile(log, "utf8")).includes("heartbeat")) break; } catch {} await sleep(10); }
  const exited = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGKILL"); await exited;
  await sleep(150); const before = await readFile(log, "utf8"); await sleep(150);
  expect(await readFile(log, "utf8")).toBe(before); expect(before).not.toContain("slots done");
  try { process.kill(-child.pid!, "SIGKILL"); } catch {}
});
it("kills a heartbeat that ignores TERM after the polling deadline", async () => {
  const r = await run('case $2 in acquire) echo "use use-1 lease lease-2 renew 1" ;; heartbeat) trap "" TERM; echo "heartbeat-pid $$" >> "$LOG"; exec sleep 20 ;; esac', 'sleep 0.5');
  expect(r.result.status).toBe(0);
  const pids = [...r.log.matchAll(/heartbeat-pid (\d+)/g)].map(match => Number(match[1]));
  expect(pids.length).toBeGreaterThan(0);
  for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
});
it.each([true, false])("cleans up around heartbeat %s", async hung => {
  const action = hung ? 'exec sleep 20' : 'exit 0';
  const r = await run(`case $2 in acquire) echo "use use-1 lease lease-2 renew 1" ;; heartbeat) echo "helper $$" >> "$LOG"; ${action} ;; esac`, 'while ! grep -q helper "$LOG"; do sleep 0.01; done');
  expect(r.result.status).toBe(0); expect(r.log.match(/slots done/g)).toHaveLength(1);
  for (const match of r.log.matchAll(/helper (\d+)/g)) expect(() => process.kill(Number(match[1]), 0)).toThrow();
});


it("creates and removes its run directory inside TMPDIR", async () => {
  const dir = await mkdtemp(join(tmpdir(), "slots-tmp-")); dirs.push(dir);
  const bb = join(dir, "bb"), marker = join(dir, "marker");
  await writeFile(bb, '#!/bin/sh\ncase $2 in acquire) echo "use use-1 lease lease-2 renew 30" ;; esac\n');
  await chmod(bb, 0o755);
  const result = spawnSync("sh", ["./slots-run.sh", "--est", "1m", "--job", "test", "--", "sh", "-c", 'find "$TMPDIR" -maxdepth 1 -type d -name "slots-run.*" > "$MARKER"'], {
    cwd: import.meta.dirname, encoding: "utf8", env: { ...process.env, TMPDIR: dir, PATH: `${dir}:${process.env.PATH}`, MARKER: marker, SLOTS_RUN_TEST_STEP: "0.01" }, timeout: 5000,
  });
  expect(result.status).toBe(0);
  const runDir = (await readFile(marker, "utf8")).trim();
  expect(runDir.startsWith(`${dir}/slots-run.`)).toBe(true);
  expect((await readdir(dir)).filter(name => name.startsWith("slots-run."))).toEqual([]);
});

it("runs a spilled lease on the other machine against the current worktree and passes its exit code back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "slots-spill-")); dirs.push(dir);
  const repo = join(dir, "repo"), home = join(dir, "home"), log = join(dir, "log"), bb = join(dir, "bin", "bb");
  const git = (...args: string[]) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  spawnSync("mkdir", ["-p", join(repo, "pkg"), join(dir, "bin"), home]);
  spawnSync("git", ["init", "-q", repo]);
  await writeFile(join(repo, ".gitignore"), "secret.env\n"); await writeFile(join(repo, "secret.env"), "x");
  await writeFile(join(repo, "pkg", "a.txt"), "tracked"); await writeFile(join(repo, "gone.txt"), "old");
  git("add", "."); git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init");
  await rm(join(repo, "gone.txt")); await writeFile(join(repo, "pkg", "new.txt"), "untracked");
  // Fake bb: file write stores the upload; terminal run executes the runner locally with a separate HOME.
  await writeFile(bb, `#!/bin/sh
printf '%s\\n' "$*" >> "$LOG"
case "$1 $2" in
  "slots acquire") echo "use use-1 lease lease-2 renew 30 host host_example" ;;
  "file write") for a; do p=$a; done; cat > "$p" ;;
  "terminal run") shift 2; while [ "$1" != -- ]; do [ "$1" = --id ] && id=$2; shift; done; shift
    HOME="$FAKE_HOME" "$@"; rc=$?; echo "Terminal $id exited with code $rc."; exit "$rc" ;;
esac
`); await chmod(bb, 0o755);
  const run = (command: string) => spawnSync("sh", [join(import.meta.dirname, "slots-run.sh"), "--spill", "--est", "1m", "--job", "t", "--", "sh", "-c", command], {
    cwd: join(repo, "pkg"), encoding: "utf8", timeout: 10000,
    env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, LOG: log, FAKE_HOME: home, SLOTS_RUN_UPLOAD_DIR: dir, SLOTS_RUN_TEST_STEP: "0.01" } });
  const first = run('pwd; ls -a ..; cat a.txt new.txt; [ -t 0 ] || echo no-tty; exit 7');
  expect(first.status).toBe(7);
  expect(first.stdout).toContain("tracked"); expect(first.stdout).toContain("untracked"); expect(first.stdout).toContain("no-tty");
  expect(first.stdout).toMatch(/\.bb-slots\/work\/[0-9a-f]{16}\/pkg/);
  expect(first.stdout).not.toContain("gone.txt"); expect(first.stdout).not.toContain("secret.env");
  expect(first.stdout).not.toContain("exited with code");
  expect((await readFile(log, "utf8")).match(/slots acquire .*--place auto/)).toBeTruthy();
  expect((await readdir(dir)).filter(f => f.endsWith(".b64"))).toEqual([]); // the upload is removed
  // An unchanged worktree is not unpacked again; a changed one is, and drops a deleted file.
  const [mirror] = await readdir(join(home, ".bb-slots", "work")).then(names => names.filter(n => !n.includes(".")));
  await writeFile(join(home, ".bb-slots", "work", mirror, "pkg", "a.txt"), "edited in mirror");
  expect(run("cat a.txt").stdout).toContain("edited in mirror");
  await rm(join(repo, "pkg", "new.txt"));
  const third = run("ls; cat a.txt");
  expect(third.status).toBe(0); expect(third.stdout).toContain("tracked"); expect(third.stdout).not.toContain("new.txt");
  // A command exit of 69 is not proof of setup failure.
  expect(run("exit 69").status).toBe(69);
  // The nonce marker immediately before the terminal trailer proves setup failed.
  await writeFile(bb, `#!/bin/sh
case "$1 $2" in
  "slots acquire") case "$*" in *"--place local"*) echo "use use-3 lease lease-4 renew 30" ;; *) echo "use use-1 lease lease-2 renew 30 host host_example" ;; esac ;;
  "file write") cat >/dev/null ;;
  "terminal run") shift 2; while [ "$1" != -- ]; do [ "$1" = --id ] && id=$2; shift; done; shift
    shift 8; echo "slots-run setup-failed $1"; echo "Terminal $id exited with code 69."; exit 69 ;;
esac
`);
  const setupFailed = run("echo retried");
  expect(setupFailed.status).toBe(0); expect(setupFailed.stdout).toContain("retried");
  expect(setupFailed.stderr).toContain("retrying locally");
  // A failed copy proves that the command did not start and is retried here.

  await writeFile(bb, `#!/bin/sh\ncase "$1 $2" in "slots acquire") case "$*" in *"--place local"*) echo "use use-3 lease lease-4 renew 30" ;; *) echo "use use-1 lease lease-2 renew 30 host host_example" ;; esac ;; "file write") cat >/dev/null; echo "Error: HTTP 404: Host not found" >&2; exit 1 ;; esac\n`);
  const offline = run("true");
  expect(offline.status).toBe(0); expect(offline.stderr).toContain("could not copy the worktree to host_example");
}, 30000);

it("queues locally outside a git worktree and never starts a remote copy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "slots-no-git-")); dirs.push(dir);
  const log = join(dir, "log"), bb = join(dir, "bb");
  await writeFile(bb, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$LOG"\ncase $2 in acquire) exit 75 ;; esac\nexit 1\n');
  await chmod(bb, 0o755);
  const result = spawnSync("sh", [join(import.meta.dirname, "slots-run.sh"), "--anywhere", "--est", "1m", "--job", "test", "--", "true"], {
    cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LOG: log }, timeout: 5000,
  });
  expect(result.status).toBe(75);
  const calls = await readFile(log, "utf8");
  expect(calls).toContain("--place local");
  expect(calls).not.toMatch(/file write|terminal run/);
});

it.each([
  ['glued failure', 'printf "spinTerminal $id exited with code 1.\\n"; exit 1', '', 1, 'spin'],
  ['glued success', 'printf "spinTerminal $id exited with code 0.\\n"; exit 0', '', 0, 'spin'],
  ['success without status line', 'printf "done-no-newline"; exit 0', 'show) exit 1 ;;', 0, 'done-no-newline'],
  ['glued timeout', 'printf "spinTerminal $id is still running\\n"; exit 124', '', 124, 'spin'],
  ['known exit', 'exit 1', 'show) echo \'{"status":"exited","exitCode":3}\' ;; output) echo "scrollTerminal $3 exited with code 3." ;;', 3, 'scroll'],
  ['closed exit', 'exit 1', 'show) echo \'{"status":"closed","exitCode":3}\' ;; output) echo scroll ;;', 3, 'scroll'],
  ['missing scrollback', 'exit 1', 'show) echo \'{"status":"exited","exitCode":3}\' ;; output) exit 1 ;;', 3, 'no longer available'],
  ['running', 'exit 1', 'show) echo \'{"status":"running"}\' ;; wait) printf "spinTerminal $3 exited with code 3.\\n"; exit 3 ;;', 3, 'spin'],
  ['running then success', 'exit 1', 'show) echo \'{"status":"running"}\' ;; wait) printf "waited-ok"; exit 0 ;;', 0, 'waited-ok'],
  ['running, wait without status, then known exit', 'exit 1', 'show) if [ -e "$LOG.w" ]; then echo \'{"status":"exited","exitCode":4}\'; else echo \'{"status":"running"}\'; fi ;; wait) touch "$LOG.w"; printf "partial"; exit 1 ;; output) echo scroll ;;', 4, 'scroll'],
  ['wait keeps failing', 'exit 1', 'show) echo \'{"status":"running"}\' ;; wait) exit 1 ;;', 69, 'lost its machine'],
  ['not found', 'exit 1', 'show) echo \'{"error":"not found"}\' ;;', 69, 'lost its machine'],
  ['no code', 'exit 1', 'show) echo \'{"status":"closed"}\' ;;', 69, 'lost its machine'],
  ['show fails', 'exit 1', 'show) exit 1 ;;', 69, 'lost its machine'],
])('handles remote terminal %s', async (_label, action, extra, expected, output) => {
  const bb = `case "$1 $2" in
    "slots acquire") echo "use use-1 lease lease-2 renew 30 host host_example" ;;
    "file write") cat >/dev/null ;;
    "terminal run") shift 2; while [ "$1" != -- ]; do [ "$1" = --id ] && id=$2; shift; done; ${action} ;;
    "terminal "*) case $2 in ${extra} esac ;;
  esac`;
  const { result, log } = await run(bb, 'echo replay', '', ['--anywhere']);
  expect(result.status).toBe(expected);
  expect(result.stdout + result.stderr).toContain(output);
  expect(result.stdout).not.toContain('Terminal term_');
  expect(log.match(/terminal run /g)).toHaveLength(1);
  expect(log).not.toContain('--place local');
});

// --- Files written by a remote run come back (the fake bb runs the real runner on this machine with a separate HOME) ---
const FAKE_BB = `#!/bin/sh
printf '%s\\n' "$*" >> "$LOG"
for a; do last=$a; done
case "$1 $2" in
  "slots acquire")
    case " $* " in
      *" --place local "*) echo "use use-1 lease lease-2 renew 30" ;;
      *) echo "use use-1 lease lease-2 renew 30 host host_example" ;;
    esac ;;
  "file write") cat > "$last" ;;
  "file read") [ -z "$READ_FAIL" ] || case $last in *.ret.[0-9]*) exit 1 ;; esac; cat "$last" ;;
  "file remove") rm -f "$last" ;;
  "terminal run") shift 2; while [ "$1" != -- ]; do [ "$1" = --id ] && id=$2; shift; done; shift
    if [ -n "$FORGE" ]; then
      r=\${8%.b64}.ret; n=$9; [ "$FORGE_META" != nonce ] || n=wrong
      if [ "$FORGE_META" != none ]; then
        [ "$FORGE" = - ] || cp "$FORGE" "$r.1"
        d=0; [ -z "$FORGE_DEL" ] || { cp "$FORGE_DEL" "$r.del"; d=1; }
        printf 'nonce=%s\\nstatus=%s\\ncount=%s\\nbytes=%s\\nparts=1\\ndel=%s\\n' "$n" "\${FORGE_STATUS:-packed}" 100 "\${FORGE_BYTES:-1000000}" "$d" > "$r.meta"
      fi
      exit 0
    fi
    if [ -n "$FAKE_HIDE_UNTRACKED" ]; then
      export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=status.showUntrackedFiles GIT_CONFIG_VALUE_0=no
    fi
    HOME="$FAKE_HOME" "$@"; rc=$?; echo "Terminal $id exited with code $rc."; exit "$rc" ;;
esac
`;
async function world(setup: Record<string, string> = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "slots-return-"))); dirs.push(dir);
  const repo = join(dir, "repo"), home = join(dir, "home"), bin = join(dir, "bin");
  await mkdir(join(repo, "pkg"), { recursive: true }); await mkdir(join(repo, "out"), { recursive: true }); await mkdir(home); await mkdir(bin);
  const git = (...args: string[]) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("init", "-q");
  await writeFile(join(repo, ".gitignore"), "out/\n"); await writeFile(join(repo, "pkg", "a.txt"), "tracked"); await writeFile(join(repo, "edit.txt"), "orig");
  git("add", ".gitignore", "pkg", "edit.txt"); git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init");
  await writeFile(join(repo, "out", "report.txt"), "old-ignored");
  for (const [name, text] of Object.entries(setup)) { await mkdir(join(repo, name, ".."), { recursive: true }); await writeFile(join(repo, name), text); }
  await writeFile(join(bin, "bb"), FAKE_BB); await chmod(join(bin, "bb"), 0o755);
  await writeFile(join(bin, "trash"), `#!/bin/sh\nmkdir -p "${dir}/trash"; for a; do echo "$a" >> "${dir}/trashed"; mv "$a" "${dir}/trash/$(echo "$a" | tr / _)"; done\n`); await chmod(join(bin, "trash"), 0o755);
  const log = join(dir, "log");
  const env = (extra: Record<string, string> = {}) => ({ ...process.env, PATH: `${bin}:${process.env.PATH}`, LOG: log, FAKE_HOME: home, REPO: repo, SLOTS_RUN_UPLOAD_DIR: dir,
    SLOTS_RUN_TRASH: join(bin, "trash"), SLOTS_RUN_TEST_STEP: "0.01", ...extra });
  const args = (command: string, options: string[] = []) => [join(import.meta.dirname, "slots-run.sh"), "--anywhere", ...options, "--est", "1m", "--job", "t", "--", "sh", "-c", command];
  const sh = (command: string, extra: Record<string, string> = {}) => spawnSync("sh", args(command), { cwd: repo, encoding: "utf8", timeout: 60000, env: env(extra) });
  const start = (command: string, extra: Record<string, string> = {}) => spawn("sh", args(command), { cwd: repo, detached: true, env: env(extra), stdio: "ignore" });
  const key = createHash("sha1").update(repo).digest("hex").slice(0, 16);
  return { dir, repo, home, key, args, env, mirror: join(home, ".bb-slots", "work", key), sh, start, log: () => readFile(log, "utf8"), read: (f: string) => readFile(join(repo, f), "utf8"), bin };
}
const exists = (p: string) => stat(p).then(() => true, () => false);
const waitFor = async (p: string, tries = 1000) => { for (let i = 0; i < tries; i++) { if (await exists(p)) return; await sleep(10); } throw new Error("timeout waiting for " + p); };
const exited = (c: ReturnType<typeof spawn>) => new Promise<number | null>(resolve => { if (c.exitCode !== null) resolve(c.exitCode); else c.once("exit", resolve); });

it("runs with a clean detached Git snapshot and its parent, returning files without Git metadata", async () => {
  const w = await world();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: w.repo, encoding: "utf8" });
  git("remote", "add", "origin", "https://example.test/owner/repo");
  await writeFile(join(w.repo, "edit.txt"), "parent version\n");
  git("add", "edit.txt");
  git("-c", "user.email=test@example.test", "-c", "user.name=Example", "commit", "-qm", "second commit");
  git("rm", "edit.txt");
  git("-c", "user.email=test@example.test", "-c", "user.name=Example", "commit", "-qm", "third commit");
  const commits = git("rev-parse", "HEAD", "HEAD^");
  const script = 'git rev-parse HEAD HEAD^ && git status --porcelain && git show HEAD^:edit.txt && git rev-list --count HEAD && test -z "$(git remote)" && : > .git/remote-only && mkdir -p out && echo report > out/new.txt';
  const result = spawnSync("sh", w.args(script, ["--git"]), { cwd: w.repo, env: w.env(), encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe(commits + "parent version\n2\n");
  expect(result.stderr).toContain("running on host_example");
  expect(await w.read("out/new.txt")).toBe("report\n");
  expect(await exists(join(w.repo, ".git", "remote-only"))).toBe(false);
  expect(await exists(join(w.mirror + "-git", ".git"))).toBe(false);
  const plain = w.sh('test ! -e .git && ! git rev-parse HEAD >/dev/null 2>&1');
  expect(plain.status, plain.stderr).toBe(0);
});

it("preserves staged and unstaged changes from a linked worktree with a split index", async () => {
  const w = await world();
  const worktree = join(w.dir, "linked");
  execFileSync("git", ["worktree", "add", "-q", "--detach", worktree], { cwd: w.repo });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: worktree, encoding: "utf8" });
  await writeFile(join(worktree, "edit.txt"), Buffer.from([0, 1, 2]));
  git("add", "edit.txt");
  git("update-index", "--split-index");
  await writeFile(join(worktree, "edit.txt"), Buffer.from([3, 0, 4]));
  await rm(join(worktree, "pkg", "a.txt"));
  await writeFile(join(worktree, "-untracked"), "untracked");
  const expected = git("rev-parse", "HEAD") + git("status", "--porcelain") + git("diff", "--cached", "--binary");
  const script = "git rev-parse HEAD && git status --porcelain && git diff --cached --binary";
  const result = spawnSync("sh", w.args(script, ["--git"]), { cwd: worktree, env: w.env(), encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain("running on host_example");
  expect(result.stdout).toBe(expected);
});

it("retries locally when a Git snapshot cannot be made", async () => {
  const w = await world();
  const unborn = join(w.dir, "unborn");
  execFileSync("git", ["init", "-q", unborn]);
  const result = spawnSync("sh", w.args("printf '%s' \"$PWD\"", ["--git"]), { cwd: unborn, env: w.env(), encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe(unborn);
  expect(result.stderr).toContain("retrying locally");
  expect(await w.log()).not.toContain("terminal run");
});

it("retries locally before running the command when the mirror status differs", async () => {
  const w = await world({ "untracked.txt": "untracked" });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: w.repo, encoding: "utf8" });
  git("config", "status.showUntrackedFiles", "normal");
  const result = spawnSync("sh", w.args("printf '%s' \"$PWD\"", ["--git"]), {
    cwd: w.repo, env: w.env({ FAKE_HIDE_UNTRACKED: "1" }), encoding: "utf8",
  });
  expect(result.status, result.stderr + result.stdout).toBe(0);
  expect(result.stdout).toContain("Git HEAD, parents or status differ from the local snapshot");
  expect(result.stdout.endsWith(w.repo)).toBe(true);
  expect(result.stderr).toContain("retrying locally");
});

it.each([0, 3, 124, 130])("brings back new, changed and ignored files after the command exits %i", async code => {
  const w = await world();
  const r = w.sh(`mkdir -p out/sub; echo new > newfile.txt; echo changed > edit.txt; echo fresh > out/report.txt; echo cov > out/sub/cov.txt; printf nonl; exit ${code}`);
  expect(r.status).toBe(code); expect(r.stdout.trim()).toBe("nonl");
  expect(await w.read("newfile.txt")).toBe("new\n"); expect(await w.read("edit.txt")).toBe("changed\n");
  expect(await w.read("out/report.txt")).toBe("fresh\n"); expect(await w.read("out/sub/cov.txt")).toBe("cov\n");
  expect(r.stderr).toContain("brought back 4 files from host_example");
  expect(await exists(join(w.dir, "repo", "pkg", "a.txt"))).toBe(true);
  expect((await readdir(w.dir)).filter(f => f.includes(".ret"))).toEqual([]); // the remote result files are removed after the read
}, 30000);

it("returns a same-size rewrite with a restored mtime and a regenerated identical ignored output", async () => {
  const w = await world();
  const cmd = 'cp -p edit.txt "$FAKE_HOME/ref"; printf ORIG > edit.txt; touch -r "$FAKE_HOME/ref" edit.txt; mkdir -p out; echo R > out/report.txt; touch -t 202001010000 out/report.txt';
  expect(w.sh(cmd).status).toBe(0);
  expect(await w.read("edit.txt")).toBe("ORIG"); expect(await w.read("out/report.txt")).toBe("R\n");
  await rm(join(w.repo, "out", "report.txt"));
  const again = w.sh(cmd); expect(again.status).toBe(0);
  expect(await w.read("out/report.txt")).toBe("R\n"); expect(again.stderr).toContain("brought back");
}, 30000);

it("keeps what changed here during the run and reports it", async () => {
  const w = await world();
  const r = w.sh('mkdir -p out; echo remote > pkg/a.txt; echo remote > edit.txt; echo remote > out/report.txt; echo remote > newfile.txt; echo remote > fresh.txt;' +
    ' echo mine > "$REPO/edit.txt"; rm "$REPO/pkg/a.txt"; rm "$REPO/out/report.txt"; mkdir "$REPO/out/report.txt"; echo mine > "$REPO/newfile.txt"; exit 5');
  expect(r.status).toBe(5);
  expect(await w.read("edit.txt")).toBe("mine\n"); expect(await w.read("newfile.txt")).toBe("mine\n");
  expect(await exists(join(w.repo, "pkg", "a.txt"))).toBe(false); expect((await stat(join(w.repo, "out", "report.txt"))).isDirectory()).toBe(true);
  expect(await w.read("fresh.txt")).toBe("remote\n");
  expect(r.stderr).toContain("kept your local version of:");
  for (const f of ["edit.txt", "pkg/a.txt", "out/report.txt", "newfile.txt"]) expect(r.stderr).toContain(f);
}, 30000);

it("moves a file removed on the other machine to the Trash only if it is unchanged here", async () => {
  const w = await world({ "gone.txt": "g" });
  const r = w.sh('rm pkg/a.txt edit.txt; echo mine > "$REPO/edit.txt"');
  expect(r.status).toBe(0);
  expect(await exists(join(w.repo, "pkg", "a.txt"))).toBe(false); expect((await readFile(join(w.dir, "trashed"), "utf8")).replace(/\.slots-run-[0-9a-f]+\//, "")).toBe(`${join(w.repo, "pkg", "a.txt")}\n`);
  expect(await readdir(join(w.repo, "pkg"))).toEqual([]);
  expect(await w.read("edit.txt")).toBe("mine\n"); expect(r.stderr).toContain("moved to Trash: pkg/a.txt"); expect(r.stderr).toContain("kept your local version of: edit.txt");
}, 30000);

it("keeps a file edited here after the deletion check instead of trashing it", async () => {
  const w = await world();
  const r = w.sh("rm pkg/a.txt", { SLOTS_RUN_TEST_AT_delmove: 'echo mine > "$FILE"' });
  expect(await w.read("pkg/a.txt")).toBe("mine\n"); expect(r.stderr).toContain("kept your local version of: pkg/a.txt"); expect(r.stderr).not.toContain("moved to Trash");
  expect(await exists(join(w.dir, "trashed"))).toBe(false); expect(await readdir(join(w.repo, "pkg"))).toEqual(["a.txt"]);
}, 30000);

it("restores a file when the Trash call fails, and keeps it beside a file created meanwhile", async () => {
  const w = await world();
  const failed = w.sh("rm pkg/a.txt", { SLOTS_RUN_TRASH: "/usr/bin/false" });
  expect(await w.read("pkg/a.txt")).toBe("tracked"); expect(failed.stderr).toContain("not applied: pkg/a.txt"); expect(await readdir(join(w.repo, "pkg"))).toEqual(["a.txt"]);
  const raced = w.sh("rm pkg/a.txt", { SLOTS_RUN_TRASH: "/usr/bin/false", SLOTS_RUN_TEST_AT_delmove: 'echo mine > "$FILE"', SLOTS_RUN_TEST_AT_delplace: 'echo created > "$FILE"' });
  expect(await w.read("pkg/a.txt")).toBe("created\n"); expect(raced.stderr).toContain("(yours is .slots-run-");
  const kept = (await readdir(join(w.repo, "pkg"))).filter(f => f.startsWith(".slots-run-")); expect(kept).toHaveLength(1);
  expect(await readFile(join(w.repo, "pkg", kept[0], "a.txt"), "utf8")).toBe("mine\n");
}, 30000);

it("puts back or reports a file moved for deletion when its hash step throws", async () => {
  const w = await world();
  const back = w.sh("rm pkg/a.txt", { SLOTS_RUN_TEST_THROW: "delhash" });
  expect(await w.read("pkg/a.txt")).toBe("tracked"); expect(back.stderr).toContain("not applied: pkg/a.txt"); expect(await readdir(join(w.repo, "pkg"))).toEqual(["a.txt"]);
  const taken = w.sh("rm pkg/a.txt", { SLOTS_RUN_TEST_THROW: "delhash", SLOTS_RUN_TEST_AT_delplace: 'echo created > "$FILE"' });
  expect(await w.read("pkg/a.txt")).toBe("created\n"); expect(taken.stderr).toContain("(yours is .slots-run-");
  const kept = (await readdir(join(w.repo, "pkg"))).filter(f => f.startsWith(".slots-run-")); expect(kept).toHaveLength(1);
  expect(await readFile(join(w.repo, "pkg", kept[0], "a.txt"), "utf8")).toBe("tracked");
  expect(await exists(join(w.dir, "trashed"))).toBe(false);
}, 30000);

it("reports a new output that could not be written as not applied and says where it stays", async () => {
  const w = await world();
  const r = w.sh("echo remote > newfile.txt", { SLOTS_RUN_TEST_THROW: "write" });
  expect(await exists(join(w.repo, "newfile.txt"))).toBe(false); expect(r.stderr).not.toContain("kept your local version");
  expect(r.stderr).toContain("not applied: newfile.txt (the new content stays on host_example in ~/.bb-slots/work/");
  expect(await readFile(join(w.mirror, "newfile.txt"), "utf8")).toBe("remote\n"); expect(await leftovers(w)).toEqual([]);
}, 30000);

it("keeps an existing ignored file over SLOTS_RUN_BASELINE_MAX and writes a missing one", async () => {
  const w = await world();
  const r = w.sh("mkdir -p out; echo remote > out/report.txt; echo remote > out/new.txt", { SLOTS_RUN_BASELINE_MAX: "1" });
  expect(await w.read("out/report.txt")).toBe("old-ignored"); expect(await w.read("out/new.txt")).toBe("remote\n");
  expect(r.stderr).toContain("kept your local version of: out/report.txt");
}, 30000);

it("joins a multi-part result", async () => {
  const w = await world();
  const r = w.sh("mkdir -p out; head -c 35000000 /dev/urandom > out/big.bin; echo x > small.txt");
  expect(r.status).toBe(0); expect((await stat(join(w.repo, "out", "big.bin"))).size).toBe(35000000);
  expect(await w.log()).toMatch(/file read .*\.ret\.[3]\n/);
}, 60000);

it("warns and keeps the exit code for a skipped, failed, missing or foreign result and a failed read", async () => {
  const w = await world();
  const skipped = w.sh("echo remote-content-over-ten > newfile.txt; exit 3", { SLOTS_RUN_RETURN_MAX: "10" });
  expect(skipped.status).toBe(3); expect(skipped.stderr).toContain("SLOTS_RUN_RETURN_MAX"); expect(await exists(join(w.repo, "newfile.txt"))).toBe(false);
  for (const [meta, status, text] of [["", "failed", "packing failed"], ["none", "packed", "may not have come back"], ["nonce", "packed", "may not have come back"]]) {
    const r = w.sh("exit 4", { FORGE: "-", FORGE_META: meta, FORGE_STATUS: status });
    expect(r.status).toBe(0); expect(r.stderr).toContain(text);
  }
  const unread = w.sh("echo x > newfile.txt; exit 6", { READ_FAIL: "1" });
  expect(unread.status).toBe(6); expect(unread.stderr).toContain("could not read the files"); expect(await exists(join(w.repo, "newfile.txt"))).toBe(false);
}, 30000);

// A minimal tar writer for hostile archives.
function tarOf(entries: { name: string; type?: string; data?: string; link?: string; pax?: Record<string, string> }[]) {
  const hdr = (name: string, type: string, size: number, link = "") => {
    const b = Buffer.alloc(512); b.write(name, 0, 100); b.write("0000644\0", 100); b.write("0000000\0", 108); b.write("0000000\0", 116);
    b.write(size.toString(8).padStart(11, "0") + "\0", 124); b.write("00000000000\0", 136); b.write("        ", 148); b.write(type, 156); b.write(link, 157, 100);
    b.write("ustar\0", 257); b.write("00", 263); let s = 0; for (const x of b) s += x; b.write(s.toString(8).padStart(6, "0") + "\0 ", 148); return b;
  };
  const pad = (d: Buffer) => Buffer.concat([d, Buffer.alloc((512 - (d.length % 512)) % 512)]);
  const chunks: Buffer[] = [];
  for (const e of entries) {
    if (e.pax) {
      const recs = Object.entries(e.pax).map(([k, v]) => { const body = ` ${k}=${v}\n`; let n = body.length; while (String(n).length + body.length !== n) n = String(n).length + body.length; return `${n}${body}`; }).join("");
      chunks.push(hdr("PaxHeader", "x", Buffer.byteLength(recs)), pad(Buffer.from(recs)));
    }
    const data = Buffer.from(e.data ?? "");
    chunks.push(hdr(e.name, e.type ?? "0", e.type === "2" || e.type === "1" ? 0 : data.length, e.link), pad(data));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks)).toString("base64");
}
it.each<[string, unknown[], string?]>([
  ["a parent path", [{ name: "../x", data: "evil" }]],
  ["an absolute path", [{ name: "/tmp/slots-evil-x", data: "evil" }]],
  ["a duplicate path", [{ name: "ok.txt", data: "1" }, { name: "ok.txt", data: "2" }]],
  ["an entry below a symlink", [{ name: "s", type: "2", link: "/tmp" }, { name: "s/x", data: "evil" }]],
  ["a pax path override with ..", [{ name: "ok.txt", data: "evil", pax: { path: "../x" } }]],
  ["a hard link", [{ name: "h", type: "1", link: "edit.txt" }]],
  ["a device entry", [{ name: "d", type: "3" }]],
  ["a deleted path outside the worktree", [{ name: "ok.txt", data: "1" }], "../x\0"],
  ["a deleted path that was never uploaded (an unchanged ignored file)", [{ name: "ok.txt", data: "1" }], "out/report.txt\0"],
  ["a deleted path that was never uploaded (a missing file)", [{ name: "ok.txt", data: "1" }], "nothing.txt\0"],
])("rejects an archive with %s before writing anything and keeps the remote files", async (_label, entries, del) => {
  const w = await world(); const forged = join(w.dir, "forged.b64"), delFile = join(w.dir, "del.b64");
  await writeFile(forged, tarOf(entries as never)); await writeFile(delFile, Buffer.from(del ?? "").toString("base64"));
  const r = w.sh("exit 2", { FORGE: forged, ...(del ? { FORGE_DEL: delFile } : {}) });
  expect(r.status).toBe(0); expect(r.stderr).toContain("rejected the files from"); expect(r.stderr).toContain("nothing was written");
  expect(await exists(join(w.dir, "x"))).toBe(false); expect(await exists(join(w.repo, "ok.txt"))).toBe(false); expect(await exists(join("/tmp", "slots-evil-x"))).toBe(false);
  expect(await w.read("edit.txt")).toBe("orig"); expect((await readdir(w.dir)).filter(f => f.includes(".ret.")).length).toBe(del ? 3 : 2);
  expect(await exists(join(w.repo, "out", "report.txt"))).toBe(true);
}, 30000);

it("applies names with spaces and newlines", async () => {
  const w = await world();
  const forged = join(w.dir, "forged.b64");
  await writeFile(forged, tarOf([{ name: "a b.txt", data: "sp" }, { name: "n\nl.txt", data: "nl" }]));
  w.sh("exit 0", { FORGE: forged });
  expect(await w.read("a b.txt")).toBe("sp"); expect(await w.read("n\nl.txt")).toBe("nl");
}, 30000);

it("returns a worktree file named .slots-deleted next to a deletion", async () => {
  const w = await world();
  const r = w.sh('echo mine > .slots-deleted; rm edit.txt');
  expect(r.status).toBe(0); expect(r.stderr).not.toContain("rejected");
  expect(await w.read(".slots-deleted")).toBe("mine\n"); expect(await exists(join(w.repo, "edit.txt"))).toBe(false);
}, 30000);

const leftovers = async (w: { repo: string }) => (await readdir(w.repo)).filter(f => f.startsWith(".slots-run-"));
it.each([
  ["the no-hard-link fallback", { SLOTS_RUN_TEST_NOLINK: "1", SLOTS_RUN_TEST_AT_place: 'echo created > "$REPO/edit.txt"' }, "orig"],
  ["a rollback after a local edit", { SLOTS_RUN_TEST_AT_tmp: 'echo mine > "$REPO/edit.txt"', SLOTS_RUN_TEST_AT_place: 'echo created > "$REPO/edit.txt"' }, "mine\n"],
])("never replaces a file created at the destination during %s", async (_label, extra, original) => {
  const w = await world(); const forged = join(w.dir, "forged.b64");
  await writeFile(forged, tarOf([{ name: "edit.txt", data: "remote" }]));
  const r = w.sh("exit 0", { FORGE: forged, ...extra });
  expect(await w.read("edit.txt")).toBe("created\n"); expect(r.stderr).toContain("your changed copy was left beside the original of: edit.txt (yours is .slots-run-");
  const kept = await leftovers(w); expect(kept).toHaveLength(1); expect(await readFile(join(w.repo, kept[0]), "utf8")).toBe(original);
}, 30000);

it("restores a locally edited file by a no-replace link and the fallback copy", async () => {
  for (const nolink of [false, true]) {
    const w = await world(); const forged = join(w.dir, "forged.b64");
    await writeFile(forged, tarOf([{ name: "edit.txt", data: "remote" }]));
    const r = w.sh("exit 0", { FORGE: forged, SLOTS_RUN_TEST_AT_tmp: 'echo mine > "$REPO/edit.txt"', ...(nolink ? { SLOTS_RUN_TEST_NOLINK: "1" } : {}) });
    expect(await w.read("edit.txt")).toBe("mine\n"); expect(r.stderr).toContain("kept your local version of: edit.txt"); expect(await leftovers(w)).toEqual([]);
  }
}, 60000);

it.each(["hash", "unlink"])("reports the moved-aside original when its %s step fails", async step => {
  const w = await world(); const forged = join(w.dir, "forged.b64");
  await writeFile(forged, tarOf([{ name: "edit.txt", data: "remote" }]));
  const r = w.sh("exit 0", { FORGE: forged, SLOTS_RUN_TEST_THROW: step });
  expect(await w.read("edit.txt")).toBe("remote"); expect(r.stderr).toContain("your changed copy was left beside the original of: edit.txt (yours is .slots-run-");
  const kept = await leftovers(w); expect(kept).toHaveLength(1); expect(await readFile(join(w.repo, kept[0]), "utf8")).toBe("orig");
}, 30000);

it.each([[false, "directory restored"], [true, "empty directory created meanwhile"]])("rolls back a directory that replaced the file without replacing anything (%s)", async (race, _label) => {
  const w = await world(); const forged = join(w.dir, "forged.b64");
  await writeFile(forged, tarOf([{ name: "edit.txt", data: "remote" }]));
  const r = w.sh("exit 0", { FORGE: forged, SLOTS_RUN_TEST_AT_tmp: 'rm "$REPO/edit.txt"; mkdir "$REPO/edit.txt"; echo x > "$REPO/edit.txt/f"', ...(race ? { SLOTS_RUN_TEST_AT_place: 'mkdir "$REPO/edit.txt"' } : {}) });
  const kept = await leftovers(w);
  if (race) {
    expect(await readdir(join(w.repo, "edit.txt"))).toEqual([]); expect(r.stderr).toContain("your changed copy was left beside the original of: edit.txt");
    expect(kept).toHaveLength(1); expect(await readFile(join(w.repo, kept[0], "f"), "utf8")).toBe("x\n");
  } else {
    expect(await readFile(join(w.repo, "edit.txt", "f"), "utf8")).toBe("x\n"); expect(kept).toEqual([]); expect(r.stderr).not.toContain("left beside");
  }
}, 30000);

it("keeps the moved-aside original when something wrote to it after it was checked", async () => {
  const w = await world(); const forged = join(w.dir, "forged.b64");
  await writeFile(forged, tarOf([{ name: "edit.txt", data: "remote" }]));
  const r = w.sh("exit 0", { FORGE: forged, SLOTS_RUN_TEST_AT_placed: 'echo late >> "$ASIDE"' });
  expect(await w.read("edit.txt")).toBe("remote"); expect(r.stderr).toContain("your changed copy was left beside the original of: edit.txt");
  const kept = await leftovers(w); expect(kept).toHaveLength(1); expect(await readFile(join(w.repo, kept[0]), "utf8")).toBe("orig" + "late\n");
}, 30000);

it("keeps a file edited here while a large returned file is being written", async () => {
  const w = await world(); const forged = join(w.dir, "forged.b64"), size = 300_000_000;
  await writeFile(forged, tarOf([{ name: "edit.txt", data: "\0".repeat(size) }]));
  const c = spawn("sh", w.args("exit 0"), { cwd: w.repo, env: w.env({ FORGE: forged, FORGE_BYTES: String(size) }), stdio: ["ignore", "ignore", "pipe"] });
  let err = ""; c.stderr.on("data", d => { err += d; });
  for (let i = 0; i < 20000; i++) { if ((await readdir(w.repo)).some(f => f.startsWith(".slots-run-"))) break; await sleep(1); }
  await writeFile(join(w.repo, "edit.txt"), "mine");
  await exited(c);
  expect(await w.read("edit.txt")).toBe("mine"); expect(err).toContain("kept your local version of: edit.txt");
  expect((await readdir(w.repo)).filter(f => f.startsWith(".slots-run-"))).toEqual([]);
}, 60000);

it("does not follow a symlinked directory in the worktree", async () => {
  const w = await world(); const outside = join(w.dir, "outside"); await mkdir(outside); await symlink(outside, join(w.repo, "out", "link"));
  const forged = join(w.dir, "forged.b64"); await writeFile(forged, tarOf([{ name: "out/link/x", data: "evil" }]));
  const r = w.sh("exit 0", { FORGE: forged });
  expect(await exists(join(outside, "x"))).toBe(false); expect(r.stderr).toContain("not applied: out/link/x");
}, 30000);

it("runs two runs from one worktree one after the other and releases the lock when the runner dies", async () => {
  const w = await world(); const mark = join(w.dir, "marks");
  const a = w.start(`echo a-start >> "${mark}"; sleep 1; echo a-end >> "${mark}"`);
  await waitFor(mark);
  const b = w.start(`echo b-start >> "${mark}"`);
  await Promise.all([exited(a), exited(b)]);
  expect((await readFile(mark, "utf8")).trim().split("\n")).toEqual(["a-start", "a-end", "b-start"]);
  // A runner killed with SIGKILL and a daemon left by its command do not hold the lock.
  const c = w.start(`echo $PPID > "${w.dir}/runner"; echo $$ > "${w.dir}/cmd"; (sleep 30 & echo $! > "${w.dir}/daemon"); sleep 30`);
  await waitFor(join(w.dir, "daemon"));
  process.kill(Number((await readFile(join(w.dir, "runner"), "utf8")).trim()), "SIGKILL");
  await exited(c);
  const t0 = Date.now(); const d = w.sh("echo ok"); expect(d.status).toBe(0); expect(d.stdout).toBe("ok\n"); expect(Date.now() - t0).toBeLessThan(10000);
  for (const f of ["cmd", "daemon"]) { try { process.kill(Number((await readFile(join(w.dir, f), "utf8")).trim()), "SIGKILL"); } catch {} }
}, 60000);

it("waits for a legacy directory lock, never removes it, and the sweep keeps lock files", async () => {
  const w = await world(); const base = join(w.home, ".bb-slots", "work");
  await mkdir(base, { recursive: true }); await mkdir(`${w.mirror}.lock`);
  await writeFile(`${w.mirror}.flock`, ""); await utimes(`${w.mirror}.flock`, 1, 1);
  await mkdir(join(base, "otherkey")); await utimes(join(base, "otherkey"), 1, 1);
  const a = w.start(`echo ran > "${w.dir}/ran"`);
  await sleep(1500); expect(await exists(join(w.dir, "ran"))).toBe(false); expect(await exists(`${w.mirror}.lock`)).toBe(true);
  await rm(`${w.mirror}.lock`, { recursive: true }); await exited(a);
  expect(await exists(join(w.dir, "ran"))).toBe(true); expect(await exists(`${w.mirror}.lock`)).toBe(false);
  expect(await exists(`${w.mirror}.flock`)).toBe(true); expect(await exists(join(base, "otherkey"))).toBe(false);
}, 30000);

it("forwards an interrupt to the command's process group and returns nothing", async () => {
  const w = await world(); const ready = join(w.dir, "ready"), got = join(w.dir, "got");
  const c = w.start(`trap 'echo term > "${got}"; exit 0' TERM; echo x > partial.txt; : > "${ready}"; while :; do sleep 0.05; done`);
  await waitFor(ready); process.kill(-c.pid!, "SIGTERM");
  expect(await exited(c)).toBe(130);
  await waitFor(got);
  for (let i = 0; i < 500 && !(await readdir(w.dir)).some(f => f.endsWith(".ret.meta")); i++) await sleep(10); // the runner outlives the wrapper
  expect((await readdir(w.dir)).some(f => f.endsWith(".ret.meta"))).toBe(true); expect(await exists(join(w.repo, "partial.txt"))).toBe(false);
  const next = w.sh("echo free"); expect(next.stdout).toBe("free\n"); // the lock is released
}, 60000);
