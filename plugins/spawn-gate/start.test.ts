import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { registerGateCli } from "./cli";
import { createMetrics } from "./metrics";
import { builderEnvironment, createStart } from "./start";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "spawn-start-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, "bin", "bb");
  await mkdir(join(root, "bin"));
  await writeFile(cli, '#!/bin/sh\nprintf "test-bb"\n', { mode: 0o755 });
  vi.stubEnv("BB_CLI", cli);
  const repo = join(root, "repo");
  await mkdir(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.test");
  const write = async (brief = "first", environment?: Record<string, unknown>) => {
    const extra = environment ? `,"environment":json.loads(${JSON.stringify(JSON.stringify(environment))})` : "";
    await writeFile(join(repo, "builder.py"), `import json, sys\nc = json.load(sys.stdin)\nprint(json.dumps({"version":1,"brief":${JSON.stringify(brief)},"spawn":{"parentThreadId":c["parentThreadId"],"providerId":"codex","parentNotifications":"stuck"${extra}}}))\n`);
    git("add", "."); git("commit", "-m", brief);
    return git("rev-parse", "HEAD");
  };
  const first = await write();
  const { bb, harness } = createFakePluginHost({ pluginId: "spawn-gate", sdk: { projects: { get: async () => ({ gitRemoteUrl: repo }), list: async () => [{ id: "proj_example", name: "Example" }] }, threads: { get: async () => makeThreadResponse({ projectId: "proj_example" }) } } });
  cleanups.push(() => harness.lifecycle.dispose());
  const mint = vi.fn(async ({ brief }) => ({ token: "test-token", prompt: `${brief}\nagent-admission v1 token=example` }));
  const spawn = vi.fn(async (_request: Record<string, unknown>) => makeThreadResponse({ id: "thr_child" }));
  harness.sdk.stub("threads.spawn", spawn);
  // This fixture uses the real process/git runner with a plugin-owned temporary database location.
  const scoped = Object.create(bb);
  Object.defineProperty(scoped, "storage", { value: { database: () => ({ name: join(root, "data.db") }) } });
  const policy = { method: "script", script: "builder.py" };
  const revoke = vi.fn();
  const metrics = await createMetrics(bb, bb.storage.database());
  const start = createStart(scoped, mint, () => policy, revoke, metrics.record);
  registerGateCli(scoped, { start, report: metrics.report, configGet: vi.fn(), configSet: vi.fn() });
  const request = { projectId: "proj_example", parentThreadId: "thr_parent", args: [] };
  return { root, repo, git, write, first, start, request, mint, spawn, revoke, policy, harness, report: metrics.report };
}
it("dry-runs fresh remote main without minting, then starts the exact brief with resolved spawn fields", async () => {
  const f = await fixture();
  expect(await f.start({ ...f.request, dryRun: true })).toMatchObject({ dryRun: true, sourceCommit: f.first, build: { brief: "first" } });
  expect(f.mint).not.toHaveBeenCalled(); expect(f.spawn).not.toHaveBeenCalled();
  const second = await f.write("second");
  const result = await f.start(f.request);
  expect(result).toMatchObject({ dryRun: false, threadId: "thr_child", sourceCommit: second });
  expect(f.mint).toHaveBeenCalledWith({ projectId: "proj_example", parentThreadId: "thr_parent", brief: "second" });
  expect(f.spawn.mock.calls[0][0]).not.toHaveProperty("startedOnBehalfOf");
  expect(f.spawn).toHaveBeenCalledWith(expect.objectContaining({ prompt: "second\nagent-admission v1 token=example", providerId: "codex", parentNotifications: "stuck", environment: { type: "project-default" }, projectId: "proj_example", parentThreadId: "thr_parent" }));
  const cli = await f.harness.behavior.runCli(["start", "--project", "proj_example", "--parent-thread", "thr_parent", "--dry-run", "--", "--arbitrary-builder-flag"]);
  expect(cli.exitCode).toBe(0);
  expect(JSON.parse(cli.stdout!)).toMatchObject({ dryRun: true, sourceCommit: second });
  const report = await f.harness.behavior.runCli(["report", "--project", "proj_example"]);
  expect(report.exitCode).toBe(0);
  expect(JSON.parse(report.stdout!)).not.toHaveProperty("events");
  expect(JSON.parse(report.stdout!).projects).toMatchObject([
    { projectId: "proj_example", starts: 1, dryRuns: 2, blockedStarts: 0, refusals: [] },
  ]);
});
it("fails closed on malformed JSON, changed parent, checkout escape, instruction mode or a failed fetch", async () => {
  const f = await fixture();
  await writeFile(join(f.repo, "builder.py"), `import sys
print("not JSON")
print('{"reasonCode":"stdout_not_json"}', file=sys.stderr)
print("private diagnostic", file=sys.stderr)
`);
  f.git("add", "."); f.git("commit", "-m", "broken");
  const sourceCommit = f.git("rev-parse", "HEAD");
  await expect(f.start({ ...f.request, args: ["--card=EXA-1"] })).rejects.toThrow("Builder stdout");
  const report = await f.harness.behavior.runCli(["report", "--project", "proj_example", "--events"]);
  expect(report.exitCode).toBe(0);
  expect(JSON.parse(report.stdout!).events).toEqual([{
    timestamp: expect.any(String), projectId: "proj_example", operation: "start", reason: "invalid_builder_output",
    sourceCommit, parentThreadId: "thr_parent", card: "EXA-1", stderr: '{"reasonCode":"stdout_not_json"}',
  }]);
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

it("makes bare bb and absolute BB_CLI work in a builder with a restricted server PATH", async () => {
  const f = await fixture();
  vi.stubEnv("PATH", "/usr/bin:/bin");
  await writeFile(join(f.repo, "builder.py"), `import json, os, shutil, subprocess, sys
c = json.load(sys.stdin)
assert os.path.isabs(os.environ["BB_CLI"])
assert shutil.which("bb") == os.environ["BB_CLI"]
assert subprocess.check_output(["bb", "--version"], text=True) == "test-bb"
assert subprocess.check_output([os.environ["BB_CLI"], "--version"], text=True) == "test-bb"
print(json.dumps({"version":1,"brief":"runtime works","spawn":{"parentThreadId":c["parentThreadId"]}}))
`);
  f.git("add", "."); f.git("commit", "-m", "builder reads bb");
  expect(await f.start({ ...f.request, dryRun: true })).toMatchObject({ dryRun: true, build: { brief: "runtime works" } });
  expect(f.mint).not.toHaveBeenCalled(); expect(f.spawn).not.toHaveBeenCalled();
  const env = await builderEnvironment({ BB_CLI: "/missing/bb", BB_CLI_LAUNCHER: process.env.BB_CLI, PATH: "/usr/bin:/bin" });
  expect(env.BB_CLI).toBe(process.env.BB_CLI);
  await expect(builderEnvironment({ PATH: "/missing" })).rejects.toThrow("Cannot resolve bb");
});

it("revokes the minted admission when spawn fails without retrying the child", async () => {
  const f = await fixture();
  f.spawn.mockRejectedValueOnce(new Error("HTTP 400"));
  await expect(f.start(f.request)).rejects.toThrow("HTTP 400");
  expect(f.spawn).toHaveBeenCalledTimes(1);
  expect(f.revoke).toHaveBeenCalledExactlyOnceWith("test-token");
});

it.each([
  ["parent", "env_parent", undefined, "host_parent"],
  ["default source", null, undefined, "host_default"],
  ["explicit", "env_parent", "host_chosen", "host_chosen"],
] as const)("resolves new-worktree host from %s before dry-run and mint", async (_label, environmentId, hostId, expected) => {
  const f = await fixture();
  f.harness.sdk.stub("threads.get", async () => makeThreadResponse({ projectId: "proj_example", environmentId }));
  f.harness.sdk.stub("environments.get", async () => ({ hostId: "host_parent" }));
  f.harness.sdk.stub("projects.get", async () => ({ gitRemoteUrl: f.repo, sources: [{ isDefault: true, hostId: "host_default" }] }));
  const environment = { type: "host", ...(hostId ? { hostId } : {}), workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: "main" } } };
  await f.write("worktree", environment);
  expect(await f.start({ ...f.request, dryRun: true })).toMatchObject({ build: { spawn: { environment: { hostId: expected } } } });
  expect(f.mint).not.toHaveBeenCalled();
  await f.start(f.request);
  expect(f.spawn).toHaveBeenCalledWith(expect.objectContaining({ environment: { ...environment, hostId: expected } }));
});
it("rejects a new workspace with no resolvable host before minting", async () => {
  const f = await fixture();
  f.harness.sdk.stub("threads.get", async () => makeThreadResponse({ projectId: "proj_example", environmentId: null }));
  f.harness.sdk.stub("projects.get", async () => ({ gitRemoteUrl: f.repo, sources: [] }));
  await f.write("worktree", { type: "host", workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } });
  await expect(f.start(f.request)).rejects.toThrow("Cannot resolve execution host");
  expect(f.mint).not.toHaveBeenCalled(); expect(f.spawn).not.toHaveBeenCalled();
});

it("counts coded and uncoded builder exits without retaining free-form diagnostics", async () => {
  const f = await fixture();
  const fail = async (firstLine: string, lastLine: string) => {
    await writeFile(join(f.repo, "builder.py"), `import sys\nprint(${JSON.stringify(firstLine)}, file=sys.stderr)\nprint(${JSON.stringify(lastLine)}, file=sys.stderr)\nsys.exit(1)\n`);
    f.git("add", "."); f.git("commit", "-m", "Update builder exit");
  };
  await fail("private diagnostic", '{"reasonCode":"missing_required_sections"}');
  await expect(f.start(f.request)).rejects.toThrow("private diagnostic");
  await fail("private diagnostic", '{"reasonCode":"Not a code"}');
  await expect(f.start({ ...f.request, dryRun: true })).rejects.toThrow("private diagnostic");
  await fail('{"reasonCode":"unknown_role"}', "private diagnostic");
  await expect(f.start({ ...f.request, dryRun: true })).rejects.toThrow("private diagnostic");
  await fail('{"reasonCode":"unknown_role"}', '{"reasonCode":"legacy_reason"}');
  await expect(f.start({ ...f.request, dryRun: true })).rejects.toThrow("legacy_reason");
  const report = await f.report({ events: true });
  expect(report.projects[0]?.refusals).toEqual([
    { operation: "dry-run", reason: "builder:unknown_role", count: 2 },
    { operation: "dry-run", reason: "builder_error", count: 1 },
    { operation: "start", reason: "builder:missing_required_sections", count: 1 },
  ]);
  expect(report.events).toMatchObject([
    { operation: "dry-run", reason: "builder:unknown_role", stderr: '{"reasonCode":"unknown_role"}' },
    { operation: "dry-run", reason: "builder:unknown_role", stderr: '{"reasonCode":"unknown_role"}' },
    { operation: "dry-run", reason: "builder_error", stderr: null },
    { operation: "start", reason: "builder:missing_required_sections", stderr: null },
  ]);
  expect(f.mint).not.toHaveBeenCalled();
});
