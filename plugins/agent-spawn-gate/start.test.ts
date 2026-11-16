import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createStart, registerStartCli } from "./start";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "spawn-start-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  await mkdir(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.test");
  const write = async (brief = "first") => {
    await writeFile(join(repo, "builder.py"), `import json, sys\nc = json.load(sys.stdin)\nprint(json.dumps({"version":1,"brief":${JSON.stringify(brief)},"spawn":{"parentThreadId":c["parentThreadId"],"providerId":"codex","parentNotifications":"stuck"}}))\n`);
    git("add", "."); git("commit", "-m", brief);
    return git("rev-parse", "HEAD");
  };
  const first = await write();
  const { bb, harness } = createFakePluginHost({ pluginId: "agent-spawn-gate", sdk: { projects: { get: async () => ({ gitRemoteUrl: repo }) }, threads: { get: async () => makeThreadResponse({ projectId: "proj_example" }) } } });
  cleanups.push(() => harness.lifecycle.dispose());
  const mint = vi.fn(async ({ brief }) => ({ prompt: `${brief}\nagent-admission v1 token=example` }));
  const spawn = vi.fn(async () => makeThreadResponse({ id: "thr_child" }));
  harness.sdk.stub("threads.spawn", spawn);
  // This fixture uses the real process/git runner with a plugin-owned temporary database location.
  const scoped = Object.create(bb);
  Object.defineProperty(scoped, "storage", { value: { database: () => ({ name: join(root, "data.db") }) } });
  const policy = { method: "script", script: "builder.py" };
  const start = createStart(scoped, mint, () => policy);
  registerStartCli(scoped, start);
  const request = { projectId: "proj_example", parentThreadId: "thr_parent", args: [] };
  return { root, repo, git, write, first, start, request, mint, spawn, policy, harness };
}
it("dry-runs fresh remote main without minting, then starts the exact brief with resolved spawn fields", async () => {
  const f = await fixture();
  expect(await f.start({ ...f.request, dryRun: true })).toMatchObject({ dryRun: true, sourceCommit: f.first, build: { brief: "first" } });
  expect(f.mint).not.toHaveBeenCalled(); expect(f.spawn).not.toHaveBeenCalled();
  const second = await f.write("second");
  const result = await f.start(f.request);
  expect(result).toMatchObject({ dryRun: false, threadId: "thr_child", sourceCommit: second });
  expect(f.mint).toHaveBeenCalledWith({ projectId: "proj_example", parentThreadId: "thr_parent", brief: "second" });
  expect(f.spawn).toHaveBeenCalledWith(expect.objectContaining({ prompt: "second\nagent-admission v1 token=example", providerId: "codex", parentNotifications: "stuck", environment: { type: "project-default" }, projectId: "proj_example", parentThreadId: "thr_parent" }));
  const cli = await f.harness.behavior.runCli(["start", "--project", "proj_example", "--parent-thread", "thr_parent", "--dry-run", "--", "--arbitrary-builder-flag"]);
  expect(cli.exitCode).toBe(0);
  expect(JSON.parse(cli.stdout!)).toMatchObject({ dryRun: true, sourceCommit: second });
});
it("fails closed on malformed JSON, changed parent, checkout escape, instruction mode or a failed fetch", async () => {
  const f = await fixture();
  await writeFile(join(f.repo, "builder.py"), 'print("not JSON")\n');
  f.git("add", "."); f.git("commit", "-m", "broken");
  await expect(f.start(f.request)).rejects.toThrow("Builder stdout");
  await writeFile(join(f.repo, "builder.py"), 'import json\nprint(json.dumps({"version":1,"brief":"task","spawn":{"parentThreadId":"thr_wrong"}}))\n');
  f.git("add", "."); f.git("commit", "-m", "wrong parent");
  await expect(f.start(f.request)).rejects.toThrow("Builder parent");
  f.policy.script = "../repo/builder.py";
  await expect(f.start(f.request)).rejects.toThrow("inside the checkout");
  f.policy.method = "instruction";
  await expect(f.start(f.request)).rejects.toThrow("requires Script mode");
  f.policy.method = "script"; f.policy.script = "builder.py";
  await rm(f.repo, { recursive: true });
  await expect(f.start(f.request)).rejects.toThrow("git exited");
  expect(f.mint).not.toHaveBeenCalled(); expect(f.spawn).not.toHaveBeenCalled();
});
