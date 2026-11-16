import { afterEach, expect, it, vi } from "vitest";
import { createFakePluginHost, makeMessageDispatchHookContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
const PROJECT = "proj_sample";
const TTL = 600_000;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
const brief = "Review the task.\nReply only OK.";
async function setup(enabled = true, existing = false) {
  let { bb, harness } = createFakePluginHost({ pluginId: "agent-spawn-gate", sdk: { projects: { list: async () => [{ id: PROJECT, name: "Sample" }, { id: "proj_other", name: "Other" }] }, threads: {
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
  const { bb, harness } = createFakePluginHost({ pluginId: "agent-spawn-gate", sdk: { projects: { list: async () => [{ id: PROJECT, name: "Sample" }, { id: "proj_other", name: "Other" }] } } });
  cleanups.push(() => harness.lifecycle.dispose());
  await plugin(bb);
  const result = await harness.behavior.callRpc("settings.read", null) as { projects: { values: { enabled: boolean; method: string } }[] };
  expect(result.projects.map(p => p.values.enabled)).toEqual([false, false]);
  expect(result.projects.map(p => p.values.method)).toEqual(["instruction", "instruction"]);
});
