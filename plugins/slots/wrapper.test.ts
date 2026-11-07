import { afterEach, expect, it } from "vitest";
import { mkdtemp, writeFile, chmod, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
async function run(body: string, command: string, input = "") {
  const dir = await mkdtemp(join(tmpdir(), "slots-wrapper-")); dirs.push(dir);
  const bb = join(dir, "bb"), log = join(dir, "log");
  await writeFile(bb, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$LOG"\n${body}\n`); await chmod(bb, 0o755);
  const result = spawnSync("sh", ["./slots-run.sh", "--est", "1m", "--job", "test", "--", "sh", "-c", command], {
    cwd: import.meta.dirname, input, encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LOG: log, SLOTS_RUN_TEST_STEP: "0.01" }, timeout: 5000,
  });
  return { result, log: await readFile(log, "utf8") };
}
it("passes stdin and command status and cleans up once", async () => {
  const { result, log } = await run('case $2 in acquire) echo "use use-1 lease lease-2 renew 30" ;; esac', 'cat; exit 7', 'hello\n');
  expect(result.status).toBe(7); expect(result.stdout).toBe('hello\n'); expect(log.match(/slots done use-1/g)).toHaveLength(1);
});
it("does not run commands on timeout or malformed acquire output", async () => {
  const timeout = await run('exit 75', 'echo ran'); expect(timeout.result.status).toBe(75); expect(timeout.result.stdout).toBe('');
  const malformed = await run('echo "use use-x lease lease-1 renew 30"', 'echo ran'); expect(malformed.result.status).toBe(70); expect(malformed.log).not.toContain('slots done');
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
