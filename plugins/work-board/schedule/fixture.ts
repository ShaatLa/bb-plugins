import { vi } from "vitest";
import { setup } from "../attention/fixtures";
import { registerTasksCli } from "../cli";
import { sweepScheduledStarts } from "./service";

export const MINUTE = 60_000;
export const fixtures: { dispose: () => unknown }[] = [];

type StartInput = { projectId: string; parentThreadId: string; args: string[]; dryRun: boolean };
export const rpcError = (code: string, message: string) => Object.assign(new Error(message), { code });

export function fixture() {
  const f = setup();
  fixtures.push(f);
  f.threads.sendMode = "inline";
  const { db, bb, store, threads } = f;
  const world = {
    installed: true, method: "script" as "script" | "instruction", enabled: true,
    listFail: false, configFail: false,
    starts: [] as StartInput[],
    /** Replaces Spawn Gate's start answer; throws to simulate a failure. */
    start: undefined as ((input: StartInput) => Promise<unknown>) | undefined,
    spawned: [] as ({ prompt: string; parentThreadId?: string } & Record<string, unknown>)[],
    /** The model catalog `providers.models` answers with; `fail` throws instead. */
    catalog: {
      fail: undefined as Error | undefined, calls: [] as Record<string, unknown>[],
      available: true, modelLoadError: null as { code: string; detail: string | null; providerId: string } | null, ceiling: "full" as "accept-edits" | "auto" | "full",
      permissionModes: ["accept-edits", "auto", "full"], reasoningDiscovery: "known" as "known" | "unknown",
    },
    spawnFail: undefined as Error | undefined,
    /** The spawn happens, then its response is lost: the caller sees an error. */
    spawnLoseResponse: false,
    children: [] as { id: string; parentThreadId: string; createdAt: number }[],
  };
  f.harness.sdk.stub("plugins.list", async () => {
    if (world.listFail) throw new Error("plugin list unavailable");
    return { plugins: world.installed ? [{ id: "spawn-gate", enabled: true }] : [] };
  });
  f.harness.sdk.stub("plugins.callRpc", async (args: { pluginId: string; method: string; input: never; outputSchema: { parse: (value: unknown) => unknown } }) => {
    if (args.pluginId !== "spawn-gate") throw new Error(`unexpected plugin ${args.pluginId}`);
    if (args.method === "config.get") {
      if (world.configFail) throw rpcError("handler_error", "config unavailable");
      return args.outputSchema.parse({ enabled: world.enabled, method: world.method });
    }
    const input = args.input as StartInput;
    world.starts.push(input);
    if (world.start) return args.outputSchema.parse(await world.start(input));
    return args.outputSchema.parse(input.dryRun ? { dryRun: true } : { dryRun: false, threadId: "thr_launched" });
  });
  f.harness.sdk.stub("providers.models", async (args: Record<string, unknown>) => {
    world.catalog.calls.push(args);
    if (world.catalog.fail) throw world.catalog.fail;
    const { available, modelLoadError, ceiling, permissionModes, reasoningDiscovery } = world.catalog;
    return {
      modelLoadError, permissionCeiling: ceiling, selectedOnlyModels: [],
      providers: [{ id: "codex", available, capabilities: { permissionModes } }],
      models: [{ model: "gpt-5", reasoningDiscovery, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }], supportedServiceTiers: [{ id: "fast" }] }],
    };
  });
  f.harness.sdk.stub("threads.spawn", async (args: { prompt: string; parentThreadId?: string }) => {
    if (world.spawnFail) throw world.spawnFail;
    world.spawned.push({ ...args, prompt: args.prompt });
    if (world.spawnLoseResponse) throw new Error("socket closed");
    return { id: `thr_spawned_${world.spawned.length}` };
  });
  f.harness.sdk.stub("threads.list", async (args: { parentThreadId?: string }) => world.children.filter((child) => child.parentThreadId === args.parentThreadId).map((child) => ({ id: child.id, createdAt: child.createdAt, parentThreadId: child.parentThreadId })));
  f.harness.sdk.stub("system.config", async () => ({ primaryHostId: "host_example" }));

  registerTasksCli(bb, store, { name: "Work Board", version: "test" });
  const task = f.card("Example", "todo");
  const preset = store.tasks.createPreset({ name: "Night worker", providerId: "claude-code", modelId: "claude-sonnet-5", reasoningLevel: "high", serviceTier: null, permissionMode: "full", environmentKind: "project-default", baseBranch: null, machineId: null, instructions: "", builtin: false });
  const gate = { kind: "gate" as const, args: ["--card", "{key}", "--role", "impl"] };
  const viaPreset = { kind: "preset" as const, presetId: preset.id };
  const viaAgent = { kind: "agent" as const, providerId: "codex", model: "gpt-5", reasoningLevel: "high" };
  const schedule = (at = "+10m", launch: Record<string, unknown> = gate, actor = "thr_setter", taskId = task.id) => f.call("scheduleStart", { taskId, at, launch, actor });
  const row = (taskId = task.id) => db.prepare<[string], any>("SELECT * FROM scheduled_starts WHERE task_id=? ORDER BY created_at DESC, rowid DESC").get(taskId);
  const rows = () => db.prepare<[], any>("SELECT * FROM scheduled_starts ORDER BY created_at, rowid").all();
  const events = (taskId = task.id) => db.prepare<[string], { event: string; actor: string; detail: string }>("SELECT event,actor,detail FROM scheduled_start_log WHERE task_id=? ORDER BY id").all(taskId).map((entry) => entry.event);
  const comments = (pattern = "%tart%") => db.prepare<[string, string], { body: string }>("SELECT body FROM comments WHERE task_id=? AND kind='system' AND body LIKE ? ORDER BY rowid").all(task.id, pattern).map((entry) => entry.body);
  const notices = () => db.prepare<[], { state: string; recipient: string | null; kind: string }>("SELECT state,recipient,kind FROM scheduled_start_notices ORDER BY created_at").all();
  const to = (threadId: string) => threads.requests.filter((request) => request.threadId === threadId && request.text.includes("scheduled start")).map((request) => request.text);
  const sweep = () => sweepScheduledStarts(bb, store);
  /** Moves a stored start into the past (or to `at`) so the next sweep finds it due, as the clock would. */
  const due = (at = "2000-01-01T00:00:00.000Z", taskId = task.id) => db.prepare("UPDATE scheduled_starts SET start_at=? WHERE task_id=? AND state='scheduled'").run(at, taskId);
  /** Runs `bb work-board <args>` as thread `thr_setter` unless `env` says otherwise. */
  const run = (args: string[], env: Record<string, string> = {}) => { Object.assign(process.env, { BB_THREAD_ID: "thr_setter", ...env }); return f.harness.runCli(args); };
  return { ...f, run, task, preset, gate, viaPreset, viaAgent, world, schedule, row, rows, events, comments, notices, to, sweep, due };
}

