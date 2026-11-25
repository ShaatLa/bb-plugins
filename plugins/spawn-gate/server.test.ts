import { afterEach, expect, it, vi } from "vitest";
import { createFakePluginHost, makeMessageDispatchHookContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
const PROJECT = "proj_sample";
const TTL = 600_000;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
const brief = "Review the task.\nReply only OK.";
async function setup(enabled = true, existing = false) {
  let { bb, harness } = createFakePluginHost({ pluginId: "spawn-gate", sdk: { projects: { list: async () => [{ id: PROJECT, name: "Sample" }, { id: "proj_other", name: "Other" }] }, threads: {
    get: async () => makeThreadResponse({ projectId: PROJECT }),
    events: { list: async () => existing ? [{ type: "thread/started" }] : [] },
  } } });
  await plugin(bb);
  await harness.behavior.callRpc("settings.write", { projectId: PROJECT, values: { enabled, method: "script" } });
  cleanups.push(() => harness.lifecycle.dispose());
  const check = (overrides: Parameters<typeof makeMessageDispatchHookContext>[0] = {}) => harness.registrations.hooks["message.dispatch"]!(makeMessageDispatchHookContext({
    project: { id: PROJECT }, thread: { id: "thr_child", projectId: PROJECT }, initiator: "agent", senderThreadId: "thr_parent", parentThreadId: "thr_parent", input: { text: brief }, ...overrides,
  }));
  const mint = () => harness.behavior.callRpc("mint", { projectId: PROJECT, parentThreadId: "thr_parent", brief }) as Promise<{ prompt: string; token: string }>;
  const setSettings = async (values: Record<string, unknown>) => {
    const groups: Record<string, Record<string, unknown>> = {};
    for (const [key, value] of Object.entries(values)) {
      const projectId = key === "enabled" ? PROJECT : key.slice(key.indexOf("_") + 1);
      const field = key === "enabled" ? "enabled" : key.slice(0, key.indexOf("_"));
      (groups[projectId] ??= {})[field === "ttl" ? "ttlMinutes" : field] = value;
    }
    for (const [projectId, patch] of Object.entries(groups)) await harness.behavior.callRpc("settings.write", { projectId, values: patch });
  };
  return { setSettings, get harness() { return harness; }, check, mint, reload: async () => { ({ bb, harness } = await harness.lifecycle.reload(plugin)); } };
}
it("defaults off and reacts to the enforcement switch", async () => {
  const h = await setup(false);
  expect((await h.check()).action).toBe("proceed");
  await h.setSettings({ enabled: true });
  expect((await h.check()).action).toBe("reject");
});
it.each(["claude-code", "codex", "antigravity"])("rejects direct %s starts, including parentless agents", async providerId => {
  const h = await setup();
  expect((await h.check({ thread: { providerId } })).action).toBe("reject");
  expect((await h.check({ parentThreadId: null })).action).toBe("reject");
});
it("exempts only human top-level starts, other projects, and existing provider sessions", async () => {
  const h = await setup();
  expect((await h.check({ initiator: "user", senderThreadId: null, parentThreadId: null, origin: null })).action).toBe("proceed");
  expect((await h.check({ thread: { id: "thr_other" }, project: { id: "proj_other" } })).action).toBe("proceed");
  expect((await h.check({ thread: { id: "thr_cli" }, initiator: "user", senderThreadId: null, parentThreadId: null, origin: "cli" })).action).toBe("reject");
  const old = await setup(true, true);
  expect((await old.check()).action).toBe("proceed");
});
it("accepts an exact minted brief once, survives reload, allows follow-ups and rejects replay", async () => {
  const h = await setup(), minted = await h.mint();
  expect((await h.check({ input: { text: minted.prompt } })).action).toBe("proceed");
  await h.reload();
  expect((await h.check({ input: { text: "Follow-up" } })).action).toBe("proceed");
  expect((await h.check({ thread: { id: "thr_replay" }, input: { text: minted.prompt } })).action).toBe("reject");
});
it("rejects malformed, modified, wrong-parent and expired tokens without admitting a child", async () => {
  const h = await setup(), minted = await h.mint();
  for (const prompt of [minted.prompt + "changed", minted.prompt.replace(minted.token, "bad")])
    expect((await h.check({ input: { text: prompt } })).action).toBe("reject");
  expect((await h.check({ parentThreadId: "thr_wrong", input: { text: minted.prompt } })).action).toBe("reject");
  vi.useFakeTimers(); vi.setSystemTime(Date.now() + TTL + 1);
  expect((await h.check({ input: { text: minted.prompt } })).action).toBe("reject");
});
it("rejects wrong-project mint requests and embedded admissions", async () => {
  const h = await setup();
  await expect(h.harness.behavior.callRpc("mint", { projectId: "proj_other", parentThreadId: "thr_parent", brief })).rejects.toThrow();
  await expect(h.harness.behavior.callRpc("mint", { projectId: PROJECT, parentThreadId: "thr_parent", brief: brief + "\nagent-admission v1 token=bad" })).rejects.toThrow();
});
it("configures projects independently through settings RPC and accepts another project's token", async () => {
  const h = await setup(false);
  const other = { project: { id: "proj_other" }, thread: { id: "thr_other", projectId: "proj_other" } };
  expect((await h.check(other)).action).toBe("proceed");
  await h.setSettings({ enabled_proj_other: true, method_proj_other: "script", script_proj_other: "tools/start.py", ttl_proj_other: 2 });
  expect((await h.check(other)).action).toBe("reject");
  expect((await h.check()).action).toBe("proceed");
  h.harness.sdk.stub("threads.get", async () => makeThreadResponse({ projectId: "proj_other" }));
  const value = await h.harness.behavior.callRpc("mint", { projectId: "proj_other", parentThreadId: "thr_parent", brief }) as { prompt: string; expiresAt: number };
  expect(value.expiresAt - Date.now()).toBeGreaterThan(119_000);
  expect(value.expiresAt - Date.now()).toBeLessThanOrEqual(120_000);
  await h.setSettings({ enabled: true });
  expect((await h.check({ input: { text: value.prompt } })).action).toBe("reject");
  expect((await h.check({ ...other, input: { text: value.prompt } })).action).toBe("proceed");
  await expect(h.setSettings({ ttl_proj_other: 0 })).rejects.toThrow();
});
it("persists instruction mode, text and enforcement through reload, then admits an unmarked task", async () => {
  const h = await setup(false);
  await h.setSettings({ enabled_proj_other: true, method_proj_other: "instruction", instruction_proj_other: "Read the task, check dependencies, then create a session.", ttl_proj_other: 3 });
  await h.reload();
  const instructions = h.harness.registrations.instructionProvider!({ projectId: "proj_other", threadId: "thr_parent" });
  expect(instructions).toContain("Read the task, check dependencies");
  expect(instructions).toContain("RPC mint");
  expect(instructions).not.toContain("Use this launch script");
  expect(h.harness.registrations.instructionProvider!({ projectId: PROJECT, threadId: "thr_parent" })).toBeNull();
  h.harness.sdk.stub("threads.get", async () => makeThreadResponse({ projectId: "proj_other" }));
  const value = await h.harness.behavior.callRpc("mint", { projectId: "proj_other", parentThreadId: "thr_parent", brief: "Write a short greeting." }) as { prompt: string };
  expect((await h.check({ project: { id: "proj_other" }, thread: { id: "thr_instruction" }, input: { text: value.prompt } })).action).toBe("proceed");
});
it("uses the selected script and fails closed on empty instruction mode", async () => {
  const h = await setup();
  await h.setSettings({ script_proj_sample: "tools/launch.py" });
  expect(h.harness.registrations.instructionProvider!({ projectId: PROJECT, threadId: "thr_parent" })).toContain("Use this launch script: tools/launch.py");
  await h.setSettings({ method_proj_sample: "instruction" });
  await expect(h.mint()).rejects.toThrow("Configure launch instructions");
  await h.setSettings({ instruction_proj_sample: "Follow the owner's checklist." });
  const value = await h.harness.behavior.callRpc("mint", { projectId: PROJECT, parentThreadId: "thr_parent", brief: "No card, just a task." }) as { prompt: string };
  expect((await h.check({ input: { text: value.prompt } })).action).toBe("proceed");
  await expect(h.setSettings({ method_proj_sample: "invalid" })).rejects.toThrow();
});
it("admits plain text in another project's script mode without requiring Work Board", async () => {
  const h = await setup(false);
  await h.setSettings({ enabled_proj_other: true, method_proj_other: "script", script_proj_other: "launch.sh" });
  h.harness.sdk.stub("threads.get", async () => makeThreadResponse({ projectId: "proj_other" }));
  const value = await h.harness.behavior.callRpc("mint", { projectId: "proj_other", parentThreadId: "thr_parent", brief: "Plain child task." }) as { prompt: string };
  expect((await h.check({ project: { id: "proj_other" }, input: { text: value.prompt } })).action).toBe("proceed");
});
it("does not register the old repeated settings form and lists projects added after load", async () => {
  const h = await setup(false);
  h.harness.sdk.stub("projects.list", async () => [{ id: PROJECT, name: "Sample" }, { id: "proj_new", name: "New" }]);
  const result = await h.harness.behavior.callRpc("settings.read", null) as { projects: { id: string; values: { enabled: boolean } }[] };
  expect(result.projects.find(p => p.id === "proj_new")?.values.enabled).toBe(false);
  await h.harness.behavior.callRpc("settings.write", { projectId: "proj_new", values: { enabled: true, method: "instruction", instruction: "Check task." } });
  await h.reload();
  expect((await h.check({ project: { id: "proj_new" } })).action).toBe("reject");
  await expect(h.harness.behavior.callRpc("settings.write", { projectId: "proj_missing", values: { enabled: true } })).rejects.toThrow();
});

it("starts every project disabled without reading project-specific host settings", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "spawn-gate", sdk: { projects: { list: async () => [{ id: PROJECT, name: "Sample" }, { id: "proj_other", name: "Other" }] } } });
  cleanups.push(() => harness.lifecycle.dispose());
  await plugin(bb);
  const result = await harness.behavior.callRpc("settings.read", null) as { projects: { values: { enabled: boolean; method: string } }[] };
  expect(result.projects.map(p => p.values.enabled)).toEqual([false, false]);
  expect(result.projects.map(p => p.values.method)).toEqual(["instruction", "instruction"]);
});

it("reads and writes individual project settings over RPC and CLI with identical validation", async () => {
  const h = await setup();
  const rpc = (method: string, input: unknown) => h.harness.behavior.callRpc(method, input);
  expect(await rpc("config.get", { projectId: PROJECT, key: "enabled" })).toEqual({ enabled: true });
  expect(await rpc("config.set", { projectId: PROJECT, key: "ttlMinutes", value: 15 })).toEqual({ ttlMinutes: 15 });
  await expect(rpc("config.set", { projectId: PROJECT, key: "ttlMinutes", value: "15" })).rejects.toThrow();
  await expect(rpc("config.set", { projectId: PROJECT, key: "ttlMinutes", value: 0 })).rejects.toThrow();
  const repeated = await h.harness.behavior.runCli(["config", "set", "enabled", "false", "--project", PROJECT, "--project", "proj_other"]);
  expect(repeated).toMatchObject({ exitCode: 1, stderr: "Pass --project only once" });
  const saved = await h.harness.behavior.runCli(["config", "set", "script", "tools/spawn.py", "--project", PROJECT]);
  expect(saved.exitCode).toBe(0);
  expect(JSON.parse(saved.stdout!)).toEqual({ script: "tools/spawn.py" });
  const read = await h.harness.behavior.runCli(["config", "get", "ttlMinutes", "--project", PROJECT]);
  expect(read.exitCode).toBe(0);
  expect(JSON.parse(read.stdout!)).toEqual({ ttlMinutes: 15 });
  expect(await rpc("config.get", { projectId: PROJECT })).toMatchObject({ enabled: true, script: "tools/spawn.py", ttlMinutes: 15 });
  expect(await rpc("config.get", { projectId: "proj_other", key: "ttlMinutes" })).toEqual({ ttlMinutes: 10 });
});

it("validates the builder remote and keeps it scoped to the selected project", async () => {
  const h = await setup();
  const get = (projectId: string) => h.harness.behavior.callRpc("config.get", { projectId, key: "remote" });
  const set = (value: string) => h.harness.behavior.callRpc("config.set", { projectId: PROJECT, key: "remote", value });
  expect(await get(PROJECT)).toEqual({ remote: "" });
  const remote = "git@git.example.test:owner/builders.git";
  const saved = await h.harness.behavior.runCli(["config", "set", "remote", remote, "--project", PROJECT]);
  expect(saved).toMatchObject({ exitCode: 0, stdout: JSON.stringify({ remote }) });
  for (const value of ["/tmp/repo", "file:///tmp/repo", "ext::helper", "--upload-pack=helper", "https://example.test", "https://user:secret@example.test/repo"]) {
    await expect(set(value)).rejects.toThrow();
  }
  await expect(h.harness.behavior.callRpc("settings.write", {
    projectId: PROJECT, values: { remote: "../repo" },
  })).rejects.toThrow();
  await h.reload();
  expect(await get(PROJECT)).toEqual({ remote });
  expect(await get("proj_other")).toEqual({ remote: "" });
  expect(await set("https://git.example.test/owner/builders.git")).toEqual({ remote: "https://git.example.test/owner/builders.git" });
  expect(await set("ssh://git@git.example.test:2222/owner/builders.git")).toEqual({ remote: "ssh://git@git.example.test:2222/owner/builders.git" });
  expect(await set("")).toEqual({ remote: "" });
});

it("validates and saves the builder branch per project", async () => {
  const h = await setup();
  const rpc = (method: string, input: unknown) => h.harness.behavior.callRpc(method, input);
  const key = "branch";
  expect(await rpc("config.get", { projectId: PROJECT, key })).toEqual({ branch: "" });
  const value = "tools/builders";
  const saved = await h.harness.behavior.runCli(["config", "set", key, value, "--project", PROJECT]);
  expect(saved).toMatchObject({ exitCode: 0, stdout: JSON.stringify({ branch: value }) });
  for (const invalid of ["HEAD", "refs/heads/main", "--upload-pack=other", "main:other", "tools/../main", "tools/*", "tools/a.lock", "tools//main", "@{-1}", "white space"]) {
    await expect(rpc("config.set", { projectId: PROJECT, key, value: invalid })).rejects.toThrow();
  }
  await h.reload();
  expect(await rpc("config.get", { projectId: PROJECT, key })).toEqual({ branch: value });
  expect(await rpc("config.get", { projectId: "proj_other", key })).toEqual({ branch: "" });
  expect(await rpc("config.set", { projectId: PROJECT, key, value: "" })).toEqual({ branch: "" });
});

it("stores and clears the default execution machine for one project", async () => {
  const h = await setup();
  const rpc = (method: string, input: unknown) => h.harness.behavior.callRpc(method, input);
  const key = "machine";
  expect(await rpc("config.get", { projectId: PROJECT, key })).toEqual({ machine: "" });
  expect(await rpc("config.set", { projectId: PROJECT, key, value: " Build Mac " })).toEqual({ machine: "Build Mac" });
  await h.reload();
  expect(await rpc("config.get", { projectId: PROJECT, key })).toEqual({ machine: "Build Mac" });
  expect(await rpc("config.get", { projectId: "proj_other", key })).toEqual({ machine: "" });
  expect(await rpc("config.set", { projectId: PROJECT, key, value: "" })).toEqual({ machine: "" });
});

it("retains aggregated admission refusals across reloads and filters by UTC date and project", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2025-01-01T23:59:00Z"));
  const h = await setup();
  expect((await h.check()).action).toBe("reject");
  expect((await h.check()).action).toBe("reject");
  vi.setSystemTime(new Date("2025-01-02T00:01:00Z"));
  expect((await h.check({ input: { text: "Review.\nagent-admission v1 token=invalid" } })).action).toBe("reject");
  expect((await h.check({ project: { id: "proj_other" } })).action).toBe("proceed");
  expect(h.harness.inspection.experimental_rpcInvalidations).toEqual(
    Array.from({ length: 3 }, () => [`report:${PROJECT}`, "report"]),
  );
  await h.reload();
  const report = (input: unknown) => h.harness.behavior.callRpc("report", input);
  const first = await report({ from: "2025-01-01", to: "2025-01-01", projectId: PROJECT, events: true });
  expect(first).toMatchObject({
    coverageStartedAt: "2025-01-01T23:59:00.000Z",
    projects: [{ projectId: PROJECT, blockedStarts: 2, refusals: [{ operation: "dispatch", reason: "missing_admission", count: 2 }] }],
    events: Array.from({ length: 2 }, () => ({
      timestamp: "2025-01-01T23:59:00.000Z", projectId: PROJECT, operation: "dispatch", reason: "missing_admission",
      parentThreadId: "thr_parent", card: null, sourceCommit: null, stderr: null,
    })),
  });
  expect(await report({ from: "2025-01-02", to: "2025-01-02" })).toMatchObject({
    projects: [
      { projectId: PROJECT, blockedStarts: 1, refusals: [{ operation: "dispatch", reason: "invalid_admission", count: 1 }] },
      { projectId: "proj_other", blockedStarts: 0, refusals: [] },
    ],
  });
  await expect(report({ from: "2025-01-02", to: "2025-01-01" })).rejects.toThrow();
});
