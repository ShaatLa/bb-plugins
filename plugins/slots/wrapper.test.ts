import { afterEach, expect, it } from "vitest";
import { mkdtemp, writeFile, chmod, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

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
