import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  const write = async (brief = "first", environment?: Record<string, unknown>, providerPolicy?: Record<string, unknown>, requiresHeavyLease?: boolean) => {
    const extra = environment ? `,"environment":json.loads(${JSON.stringify(JSON.stringify(environment))})` : "";
    const eligibility = providerPolicy ? `,"providerPolicy":json.loads(${JSON.stringify(JSON.stringify(providerPolicy))})` : "";
    const heavy = requiresHeavyLease ? ',"requiresHeavyLease":True' : "";
    await writeFile(join(repo, "builder.py"), `import json, sys\nc = json.load(sys.stdin)\nprint(json.dumps({"version":1,"brief":${JSON.stringify(brief)},"spawn":{"parentThreadId":c["parentThreadId"],"providerId":"codex","parentNotifications":"stuck"${extra}}${eligibility}${heavy}}))\n`);
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
  const policy = { method: "script", script: "builder.py", remote: "", branch: "", machine: "" };
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
  expect(result).toMatchObject({ dryRun: false, threadId: "thr_child", sourceBranch: "main", sourceCommit: second });
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
it("refuses a misplaced dry-run flag or repeated target selectors before launch", async () => {
  const f = await fixture();
  const scope = ["--project", "proj_example", "--parent-thread", "thr_parent"];
  for (const [args, message] of [
    [["--", "--dry-run"], "Put --dry-run before the first --"],
    [["--project", "proj_other"], "Pass --project only once"],
    [["--parent-thread", "thr_other"], "Pass --parent-thread only once"],
  ] as const) {
    const result = await f.harness.behavior.runCli(["start", ...scope, ...args]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(message);
  }
  expect(f.mint).not.toHaveBeenCalled();
  expect(f.spawn).not.toHaveBeenCalled();
});

async function machineFixture() {
  const f = await fixture();
  const host = { id: "host_example", name: "Build Mac", status: "connected", lifecycle: { phase: "active" } };
  const path = "/workspace/example";
  const project = {
    id: "proj_example", kind: "standard", gitRemoteUrl: f.repo, sources: [{ hostId: host.id, path, isDefault: false }],
  };
  const provider = { providerId: "codex", status: "ready" };
  f.harness.sdk.stub("hosts.list", async () => [host]);
  f.harness.sdk.stub("projects.get", async () => project);
  f.harness.sdk.stub("system.providerStates", async ({ hostId }) => {
    expect(hostId).toBe(host.id);
    return { providers: [provider] };
  });
  const files = vi.fn(async () => ({ entries: [] }));
  f.harness.sdk.stub("files.list", files);
  return { ...f, host, project, provider, path, files };
}

it("opts into an execution machine and overrides a project default for one launch", async () => {
  const f = await machineFixture();
  f.policy.machine = "Unknown project default";
  const selector = ["--project", f.request.projectId, "--parent-thread", f.request.parentThreadId];
  const repeated = await f.harness.behavior.runCli(["start", ...selector, "--machine", f.host.name, "--machine", f.host.id]);
  expect(repeated).toMatchObject({ exitCode: 1, stderr: "Pass --machine only once" });
  // The builder runs in the server checkout with the chosen host as a hint.
  await writeFile(join(f.repo, "builder.py"), `import json, os, sys
c = json.load(sys.stdin)
print(json.dumps({"version":1,"brief":os.environ["BB_SPAWN_HOST_ID"],"spawn":{"parentThreadId":c["parentThreadId"],"providerId":"codex"}}))
`);
  f.git("add", "builder.py"); f.git("commit", "-m", "Read builder host hint");
  const dry = await f.harness.behavior.runCli(["start", ...selector, "--machine", f.host.name, "--dry-run"]);
  expect(dry.exitCode).toBe(0);
  const environment = { type: "host", hostId: f.host.id, workspace: { type: "unmanaged", path: f.path } };
  expect(JSON.parse(dry.stdout!)).toMatchObject({
    hostId: f.host.id, dryRun: true, build: { brief: f.host.id, spawn: { environment } },
  });
  expect(f.mint).not.toHaveBeenCalled();
  f.policy.machine = f.host.id;
  expect(await f.start(f.request)).toMatchObject({ hostId: f.host.id, dryRun: false, threadId: "thr_child" });
  expect(f.files).toHaveBeenCalledWith(expect.objectContaining({ hostId: f.host.id, path: f.path }));
  expect(f.spawn).toHaveBeenCalledWith(expect.objectContaining({ environment }));
});

it("refuses unavailable remote launch prerequisites before mint", async () => {
  const f = await machineFixture();
  const request = { ...f.request, machine: f.host.id };
  f.host.status = "disconnected";
  await expect(f.start(request)).rejects.toThrow("Reconnect it");
  f.host.status = "connected";
  const sources = f.project.sources.splice(0);
  await expect(f.start(request)).rejects.toThrow("Add a project source");
  f.project.sources.push(...sources);
  f.files.mockRejectedValueOnce(new Error("Missing directory"));
  await expect(f.start(request)).rejects.toThrow("Workspace directory is unavailable");
  f.provider.status = "unauthenticated";
  await expect(f.start(request)).rejects.toThrow("Install or sign in to the provider");
  f.provider.status = "ready";

  const baseBranch = { kind: "named", name: "main" };
  await f.write("Worktree", { type: "host", workspace: { type: "managed-worktree", baseBranch } });
  f.harness.sdk.stub("projects.branches", async () => ({ checkout: { kind: "unknown" } }));
  await expect(f.start(request)).rejects.toThrow("needs a Git checkout");
  f.harness.sdk.stub("projects.branches", async () => ({ checkout: { kind: "branch", headSha: f.first } }));
  expect(await f.start({ ...request, dryRun: true })).toMatchObject({
    build: { spawn: { environment: { type: "host", hostId: f.host.id, workspace: { type: "managed-worktree", baseBranch } } } },
  });
  await f.write("Reuse", { type: "reuse", environmentId: "env_example" });
  f.harness.sdk.stub("environments.get", async () => ({
    hostId: "host_other", projectId: "proj_example", status: "ready", path: f.path,
  }));
  await expect(f.start(request)).rejects.toThrow("Use a ready environment in this project");
  expect(f.mint).not.toHaveBeenCalled();
  expect(f.spawn).not.toHaveBeenCalled();
});

it("refuses declared heavy work on a host without Slots support and reads new host support", async () => {
  const f = await machineFixture();
  const request = { ...f.request, machine: f.host.id };
  f.harness.sdk.stub("plugins.callRpc", async () => ({ ok: true, data: { localHostId: "host_server" } }));
  await expect(f.start({ ...request, requiresHeavyLease: true })).rejects.toThrow("Heavy Slots leases are unavailable");
  await f.write("Heavy", undefined, undefined, true);
  await expect(f.start(request)).rejects.toThrow("Heavy Slots leases are unavailable");
  expect(f.mint).not.toHaveBeenCalled();
  expect(f.spawn).not.toHaveBeenCalled();
  f.harness.sdk.stub("plugins.callRpc", async () => ({
    ok: true, data: { localHostId: "host_server", leaseHosts: { [f.host.id]: { pools: ["heavy"] } } },
  }));
  expect(await f.start({ ...request, dryRun: true })).toMatchObject({ hostId: f.host.id, build: { requiresHeavyLease: true } });
});

it("runs the Work Board builder and counts successes and fixed refusals through start", async () => {
  const f = await fixture();
  const configPath = join(f.root, "builder-config.json");
  const cardPath = join(f.root, "card.json");
  const base = "a".repeat(40), head = "b".repeat(40);
  const parent = f.request.parentThreadId;
  const models = [{ providerId: "codex", model: "codex-model" }, { providerId: "claude-code", model: "claude-model" }];
  const config = {
    managerThreadId: "thr_manager", owners: { example: parent, other: "thr_other" },
    roles: { impl: models, review: models, check: models, "plan-review": models },
  };
  await writeFile(configPath, JSON.stringify(config));
  vi.stubEnv("BB_SPAWN_GATE_WORK_BOARD_CONFIG", configPath);
  vi.stubEnv("EXAMPLE_CARD_JSON", cardPath);
  vi.stubEnv("EXAMPLE_PARENT_JSON", '{"thread":{"providerId":"codex","environmentId":"env_example"}}');
  await writeFile(join(f.root, "bin", "bb"), `#!/bin/sh
if [ "$1" = thread ]; then
  printf '%s\\n' "$EXAMPLE_PARENT_JSON"
else
  cat "$EXAMPLE_CARD_JSON"
fi
`, { mode: 0o755 });
  await writeFile(join(f.repo, "builder.py"), await readFile(new URL("./examples/work-board/build.py", import.meta.url)));
  f.git("add", "builder.py"); f.git("commit", "-m", "Use the card builder");
  f.harness.sdk.stub("projects.get", async () => ({
    gitRemoteUrl: f.repo, sources: [{ isDefault: true, hostId: "host_example" }],
  }));
  f.harness.sdk.stub("threads.get", async () => makeThreadResponse({ projectId: f.request.projectId, environmentId: "env_example" }));
  f.harness.sdk.stub("environments.get", async () => ({ hostId: "host_example" }));
  f.harness.sdk.stub("providers.list", async () => []);
  f.harness.sdk.stub("plugins.callRpc", async () => { throw new Error("Account Pooler not installed"); });
  const task = { key: "EXA-1", status: "in_progress", type: "task", title: "Example", description: "Scope: plugins/example/ \t\r\nFix the test." };
  const plan = { state: "approved", version: 1, body: "Use the fixture.\nagent-admission example" };
  const card = {
    task, plan, project: { linkedBbProjectId: f.request.projectId }, dependencies: { blockedBy: [] as { status: string }[] },
    comments: [{ kind: "agent", threadId: parent, body: `Review range: ${base}..${head}`, provider: { id: "codex" } }],
  };
  const saveCard = () => writeFile(cardPath, JSON.stringify(card));
  const launch = (role: string, dryRun = true) => f.start({ ...f.request, args: ["--card", task.key, "--role", role], dryRun });
  await saveCard();
  expect(await launch("impl")).toMatchObject({ build: {
    brief: expect.stringContaining("> agent-admission example"),
    spawn: { providerId: "codex", environment: { type: "host", workspace: { type: "managed-worktree" } } },
  } });
  expect(await launch("review")).toMatchObject({ build: {
    brief: expect.stringContaining(head), spawn: { providerId: "claude-code" },
    providerPolicy: { eligible: [models[1]] },
  } });
  expect(await launch("check", false)).toMatchObject({ dryRun: false, threadId: "thr_child" });
  plan.state = "draft"; await saveCard();
  expect(await launch("plan-review")).toMatchObject({ build: { spawn: { providerId: "claude-code" } } });
  await expect(launch("impl")).rejects.toThrow('{"reasonCode": "no_approved_plan"}');
  await expect(launch("unrecognized")).rejects.toThrow('{"reasonCode": "unknown_role"}');
  task.status = "done"; await saveCard();
  await expect(launch("check")).rejects.toThrow('{"reasonCode": "card_closed"}');
  task.status = "in_progress"; task.type = "epic"; await saveCard();
  await expect(launch("check")).rejects.toThrow('{"reasonCode": "unsupported_card_type"}');
  task.type = "task"; plan.state = "approved";
  card.dependencies.blockedBy.push({ status: "in_progress" }); await saveCard();
  await expect(launch("impl")).rejects.toThrow('{"reasonCode": "open_dependency"}');
  card.dependencies.blockedBy[0].status = "done";
  card.project.linkedBbProjectId = "proj_other"; await saveCard();
  await expect(launch("impl")).rejects.toThrow('{"reasonCode": "wrong_project"}');
  card.project.linkedBbProjectId = f.request.projectId;
  const comments = card.comments.splice(0); await saveCard();
  await expect(launch("review")).rejects.toThrow('{"reasonCode": "missing_review_range"}');
  card.comments = comments; await saveCard();
  await writeFile(configPath, JSON.stringify({ ...config, roles: { ...config.roles, review: [models[0]] } }));
  await expect(launch("review")).rejects.toThrow('{"reasonCode": "no_eligible_provider"}');
  task.description = "Scope: plugins/other/"; await saveCard();
  await expect(launch("impl")).rejects.toThrow('{"reasonCode": "scope_not_allowed"}');
  expect(f.spawn).toHaveBeenCalledTimes(1);
  const report = await f.report({ events: true });
  expect(report.projects[0]).toMatchObject({ starts: 1, dryRuns: 3, blockedStarts: 0 });
  expect(report.events?.map(event => event.reason).sort()).toEqual([
    "builder:card_closed", "builder:missing_review_range", "builder:no_approved_plan", "builder:no_eligible_provider",
    "builder:open_dependency", "builder:scope_not_allowed", "builder:unknown_role", "builder:unsupported_card_type",
    "builder:wrong_project",
  ]);

  task.description = "Scope: plugins/example/"; await saveCard();
  const reused = { type: "reuse", environmentId: "env_example" };
  await writeFile(configPath, JSON.stringify({ ...config, environment: "reuse-parent" }));
  for (const role of ["impl", "review", "check", "plan-review"]) {
    expect(await launch(role)).toMatchObject({ build: {
      brief: expect.stringContaining(`When done or blocked, notify @thread:${parent} with \`bb thread tell ${parent} '<result or blocker>'\`.`),
      spawn: { environment: reused, parentNotifications: "stuck" },
    } });
  }
  expect(f.mint).toHaveBeenCalledTimes(1);
  expect(f.spawn).toHaveBeenCalledTimes(1);
  expect(await launch("review", false)).toMatchObject({ dryRun: false, threadId: "thr_child" });
  expect(f.spawn).toHaveBeenLastCalledWith(expect.objectContaining({ environment: reused }));
  vi.stubEnv("EXAMPLE_PARENT_JSON", '{"thread":{"providerId":"codex","environmentId":null}}');
  await expect(launch("review")).rejects.toThrow('{"reasonCode": "missing_parent_environment"}');
  await writeFile(configPath, JSON.stringify({ ...config, environment: "other" }));
  await expect(launch("review")).rejects.toThrow('{"reasonCode": "invalid_config"}');
}, 15_000);

it("fetches an orphan builder branch and refuses a tag with the same name as a missing branch", async () => {
  const f = await fixture();
  const branch = "tools/builders";
  f.git("switch", "--orphan", branch);
  const sourceCommit = await f.write("from builder branch");
  f.git("switch", "main");
  f.git("tag", branch);

  f.policy.branch = branch;
  const request = { ...f.request, dryRun: true };
  expect(await f.start(request)).toMatchObject({ sourceBranch: branch, sourceCommit, build: { brief: "from builder branch" } });
  f.git("branch", "-D", branch);
  await expect(f.start(f.request)).rejects.toThrow(`couldn't find remote ref refs/heads/${branch}`);
  f.policy.branch = "";
  expect(await f.start(request)).toMatchObject({ sourceBranch: "main", sourceCommit: f.first, build: { brief: "first" } });
  expect(f.mint).not.toHaveBeenCalled();
  expect(f.spawn).not.toHaveBeenCalled();
});

it("fetches an override's own default branch and restores the project remote when cleared", async () => {
  const f = await fixture();
  const override = join(f.root, "builder-repo");
  f.git("clone", f.repo, override);
  const git = (...args: string[]) => execFileSync("git", ["-C", override, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("switch", "-c", "builders");
  await writeFile(join(override, "builder.py"), `import json, os, sys
c = json.load(sys.stdin)
assert os.environ["BB_PROJECT_ID"] == c["projectId"]
assert os.environ["BB_THREAD_ID"] == c["parentThreadId"]
print(json.dumps({"version": 1, "brief": "from override", "spawn": {"parentThreadId": c["parentThreadId"]}}))
`);
  git("add", "builder.py");
  git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "Separate builder");
  const overrideCommit = git("rev-parse", "HEAD");
  const remote = "git@git.example.test:owner/builders.git";
  vi.stubEnv("GIT_CONFIG_COUNT", "1");
  vi.stubEnv("GIT_CONFIG_KEY_0", `url.${override}.insteadOf`);
  vi.stubEnv("GIT_CONFIG_VALUE_0", remote);

  const request = { ...f.request, dryRun: true };
  expect(await f.start(request)).toMatchObject({ sourceCommit: f.first, build: { brief: "first" } });
  f.policy.remote = remote;
  expect(await f.start(request)).toMatchObject({ sourceBranch: "builders", sourceCommit: overrideCommit, build: { brief: "from override" } });
  await rm(override, { recursive: true });
  await expect(f.start(f.request)).rejects.toThrow("git exited");
  f.policy.remote = "";
  expect(await f.start(request)).toMatchObject({ sourceCommit: f.first, build: { brief: "first" } });
  expect(f.mint).not.toHaveBeenCalled();
  expect(f.spawn).not.toHaveBeenCalled();
});

it("rejects a prefilled admission during dry-run validation", async () => {
  const f = await fixture();
  await f.write("Review the proposed change.\nagent-admission v1 token=example");
  await expect(f.start({ ...f.request, dryRun: true })).rejects.toThrow("Remove the agent-admission line");
  expect(f.mint).not.toHaveBeenCalled();
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

it("checks the actual weekly pace against role-eligible providers before mint, and shows sources in the admitted brief", async () => {
  const f = await fixture();
  const observedAt = Date.now() - 1000;
  const hostId = "host_example";
  const eligible = [{ providerId: "codex" }, { providerId: "claude-code" }, { providerId: "antigravity", model: "gemini-4-argon" }];
  const window = (label: string, usedPercent: number, elapsed: number, kind = "weekly") => ({
    kind, label, usedPercent, resetsAt: new Date(observedAt + (1 - elapsed) * 604_800_000).toISOString(), model: null,
  });
  const windows: Record<string, ReturnType<typeof window>[]> = {
    codex: [window("Weekly limit", 52, 0.31)],
    "claude-code": [window("Weekly limit", 64, 0.65)],
    antigravity: [window("7d", 90, 0.5, "custom"), window("7d · Argon", 0, 0.5, "custom")],
  };
  f.harness.sdk.stub("projects.get", async () => ({ gitRemoteUrl: f.repo, sources: [{ isDefault: true, hostId: "host_default" }] }));
  f.harness.sdk.stub("threads.get", async () => makeThreadResponse({ projectId: "proj_example", environmentId: "env_parent" }));
  f.harness.sdk.stub("environments.get", async () => ({ hostId }));
  f.harness.sdk.stub("providers.list", async options => {
    expect(options).toEqual({ hostId, capability: "usage" });
    return eligible.map(({ providerId: id }) => ({ id, pluginId: id === "antigravity" ? id : `provider-${id}` }));
  });
  const calls: string[] = [];
  f.harness.sdk.stub("plugins.callRpc", async ({ pluginId, method }: { pluginId: string; method: string }) => {
    if (pluginId === "account-pool") throw new Error("Account Pooler not installed");
    const providerId = pluginId.replace(/^provider-/, "");
    calls.push(providerId);
    return method.endsWith("listResources")
      ? { resources: [{ id: providerId, providerId, scope: { kind: "host", hostId } }] }
      : { observedAt, usage: windows[providerId] ? { status: "ok", windows: windows[providerId] } : { status: "error" } };
  });

  await f.write("Review the change.", undefined, { eligible });
  await expect(f.start(f.request)).rejects.toThrow("Use antigravity or give an explicit reason");
  expect(f.mint).not.toHaveBeenCalled();
  expect(f.spawn).not.toHaveBeenCalled();
  expect((await f.report({ events: true })).events?.[0].reason).toBe("over_pace");

  await f.write("Review the change.", undefined, { eligible: eligible.slice(0, 2), reason: "  " });
  calls.length = 0;
  await expect(f.start({ ...f.request, dryRun: true })).rejects.toThrow("Use claude-code or give an explicit reason");
  expect(calls).not.toContain("antigravity");

  await f.write("Review the change.", undefined, { eligible: eligible.slice(1), reason: "Use an existing session setup" });
  await expect(f.start(f.request)).rejects.toThrow("A pace reason cannot override role restrictions");
  expect(f.mint).not.toHaveBeenCalled();

  await f.write("Review the change.", undefined, { eligible, reason: "Use an existing session setup" });
  const result = await f.start(f.request);
  expect(result.providerPace).toMatchObject({ threshold: 1.25, overridden: true, providers: [
    { providerId: "codex", source: "provider-codex", pace: expect.closeTo(52 / 31) },
    { providerId: "claude-code", source: "provider-claude-code", pace: expect.closeTo(64 / 65) },
    { providerId: "antigravity", source: "antigravity", window: "7d · Argon", pace: 0 },
  ] });
  expect(f.mint).toHaveBeenCalledWith(expect.objectContaining({
    brief: expect.stringContaining("antigravity: 0.00 (antigravity · 7d · Argon)"),
  }));
  expect(f.spawn).toHaveBeenCalledTimes(1);

  delete windows.antigravity;
  windows["claude-code"] = [window("Weekly limit", 100, 0.99)];
  await f.write("Review the change.", undefined, { eligible });
  const preview = await f.start({ ...f.request, dryRun: true });
  expect(preview.providerPace).toMatchObject({ overridden: false, providers: [ {}, {}, { pace: null } ] });
  expect(f.spawn).toHaveBeenCalledTimes(1);
});

it("uses the weekly quota of available pooled accounts even without local provider usage", async () => {
  const f = await fixture();
  const hostId = "host_example";
  const observedAt = Date.now() - 1000;
  const window = (utilization: number, elapsed: number) => ({
    windowMinutes: 10_080, utilization, observedAt, status: null,
    resetAt: observedAt + Math.round((1 - elapsed) * 604_800_000),
  });
  const account = (provider: string, status: string, utilization: number, elapsed: number) => ({
    provider, status, enabled: true, limitWindows: [window(utilization, elapsed)],
    familyWeekly: {} as Record<string, ReturnType<typeof window>>,
  });
  const claude = account("claude", "ready", 0.03, 0.1);
  const pool = {
    accepting: true, routing: { claude: true, codex: true }, parent: null,
    accounts: [
      account("codex", "exhausted", 0, 0.1),
      account("codex", "ready", 0.52, 0.31),
      account("claude", "ready", 0.95, 0.7),
      claude,
    ],
  };
  f.harness.sdk.stub("projects.get", async () => ({ gitRemoteUrl: f.repo, sources: [{ isDefault: true, hostId }] }));
  f.harness.sdk.stub("threads.get", async () => makeThreadResponse({ projectId: "proj_example", environmentId: "env_parent" }));
  f.harness.sdk.stub("environments.get", async () => ({ hostId }));
  f.harness.sdk.stub("providers.list", async () => [
    { id: "codex", pluginId: "provider-codex" }, { id: "claude-code", pluginId: "provider-claude-code" },
  ]);
  f.harness.sdk.stub("plugins.callRpc", async ({ pluginId, method }: { pluginId: string; method: string }) => {
    if (pluginId === "account-pool" && method === "status.get") return pool;
    throw new Error("Local usage unavailable");
  });
  await f.write("Review the change.", undefined, {
    eligible: [{ providerId: "codex" }, { providerId: "claude-code", model: "claude-sonnet-example" }],
  });
  const dryRun = { ...f.request, dryRun: true };
  await expect(f.start(dryRun)).rejects.toThrow("Use claude-code or give an explicit reason");

  claude.status = "held";
  expect((await f.start(dryRun)).providerPace?.providers).toMatchObject([
    { providerId: "codex", source: "account-pool", usedPercent: 52 },
    { providerId: "claude-code", source: "account-pool", usedPercent: 95 },
  ]);

  claude.status = "ready";
  claude.familyWeekly.sonnet = window(1, 0.5);
  expect((await f.start(dryRun)).providerPace?.providers[1]).toMatchObject({
    source: "account-pool", usedPercent: 95,
  });

  pool.routing.claude = false;
  expect((await f.start(dryRun)).providerPace?.providers[1]).toMatchObject({
    source: "provider-claude-code", pace: null,
  });
  expect(f.mint).not.toHaveBeenCalled();
  expect(f.spawn).not.toHaveBeenCalled();
});
