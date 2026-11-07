import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { DEFAULT_SETTINGS, SLOTS_CHANGED, type Settings, type State, type Input, type Result, type RpcMethods, type HostSettings } from "./contract.js";
import { apply, initialState, portCandidates, statusSnapshot, validateSettings } from "./core/index.js";
import { DiskStore, metrics, probePort } from "./runtime.js";
import { inputs, rpcContract, stateSchema } from "./schemas.js";
import { registerCli } from "./cli.js";

export interface Runtime {
  now: () => number;
  metrics: typeof metrics;
  probePort: typeof probePort;
  store?: DiskStore;
}
export type Invoke = (method: keyof RpcMethods, params: unknown) => Promise<Result<unknown>>;

export default function plugin(bb: BbPluginApi) { return register(bb); }
export async function register(bb: BbPluginApi, overrides: Partial<Runtime> = {}) {
  const runtime = { now: Date.now, metrics, probePort, ...overrides };
  const settingsSchema = z.string().superRefine((text, ctx) => {
    try { const error = validateSettings({ ...JSON.parse(text), hosts: {} }); if (error) ctx.addIssue({ code: "custom", message: error }); }
    catch { ctx.addIssue({ code: "custom", message: "Expected JSON settings" }); }
  });
  const handle = bb.settings.define({
    configuration: { type: "string", label: "Pool and gate settings (JSON; durations in milliseconds)", experimental_multiline: true,
      default: JSON.stringify(DEFAULT_SETTINGS, null, 2), experimental_schema: settingsSchema },
  });
  const getSettings = async (): Promise<Settings> => ({ ...JSON.parse((await handle.get()).configuration), hosts: {} });
  let settings = await getSettings();
  const store = runtime.store ?? new DiskStore(dirname(bb.storage.database().name));
  let state: State = initialState();
  let localHostId = "";
  let initialized = false;
  let disposed = false;
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(() => { if (disposed) throw new Error("Slots unloaded"); return fn(); });
    queue = next.catch(() => {}); return next;
  }
  async function transition(input: Input, manualSample = false) {
    const change = apply(state, input, { now: runtime.now(), settings: manualSample ? { ...settings, grantMode: "manual" } : settings });
    if (!change.result.ok) return change.result;
    await store.save(change.state);
    state = change.state;
    for (const effect of change.effects) {
      if (effect.type === "audit") await store.audit(effect.event);
      else {
        try {
          await bb.sdk.threads.send({ threadId: effect.threadId, mode: "auto", originPluginId: bb.pluginId,
            input: [{ type: "text", text: `[Slots] ${effect.text}`, mentions: [] }] });
        } catch (error) { bb.log.warn(`Slots notify ${effect.threadId} failed: ${String(error)}`); }
      }
    }
    bb.realtime.publish(SLOTS_CHANGED, { at: runtime.now() });
    return change.result;
  }
  async function lookup(threadId: string) {
    try { return await bb.sdk.threads.get({ threadId }); }
    catch (error) {
      const e = error as { status?: number; statusCode?: number; code?: string };
      if (e.status === 404 || e.statusCode === 404 || e.code === "not_found" || e.code === "not-found") return null;
      throw error;
    }
  }
  async function checkThread(threadId: string) {
    const thread = await lookup(threadId);
    if (!thread || thread.deletedAt || thread.archivedAt) {
      await transition({ type: "threadEnded", threadId, reason: thread?.archivedAt ? "archived" : "deleted" });
      return null;
    }
    return thread;
  }
  async function initialize() {
    if (initialized) return;
    const config = await bb.sdk.system.config();
    if (!config.primaryHostId) throw new Error("Cannot resolve BB server host");
    localHostId = config.primaryHostId;
    const saved = await store.load();
    state = saved === undefined ? initialState() : stateSchema.parse(saved);
    await transition({ type: "restored" });
    const ids = new Set([...state.requests.map(r => r.threadId), ...state.leases.map(l => l.ownerThreadId), ...state.leases.map(l => l.holderThreadId)]);
    // Owners first: a dead child must never return a lease to a dead owner.
    for (const id of ids) await checkThread(id);
    initialized = true;
  }
  async function sample(manual = false) {
    let readings;
    try { readings = await runtime.metrics(); }
    catch (error) {
      bb.log.warn(`Slots metrics failed: ${String(error)}`);
      readings = { memFreePct: 0, load1: settings.loadMax };
    }
    return transition({ type: "gateSample", hostId: localHostId, ...readings, at: runtime.now() }, manual);
  }
  const invalid = (message: string): Result<never> => ({ ok: false, error: { code: "invalid-input", message } });
  async function localThread(threadId: string) {
    const thread = await checkThread(threadId);
    if (!thread) throw new Error("Thread is missing, archived or deleted");
    const hostId = (thread.environmentId ? (await bb.sdk.environments.get({ environmentId: thread.environmentId })).hostId : null);
    if (hostId !== localHostId) throw new Error(`Slots v1 only supports the BB server host (${localHostId}); thread ${threadId} is on ${hostId ?? "an unknown host"}`);
    return thread;
  }
  const invoke: Invoke = (method, raw) => serial(async () => {
    await initialize(); settings = await getSettings();
    const parsed = inputs[method].safeParse(raw);
    if (!parsed.success) return invalid(parsed.error.message);
    // Every surface uses the same validated dispatcher; caller host comes from the thread.
    const p = parsed.data as Record<string, any>;
    try {
      if (p.threadId) await localThread(p.threadId);
      if (p.hostId && p.hostId !== localHostId) return invalid(`Slots v1 only supports the BB server host (${localHostId})`);
      if (method === "status") {
        const snapshot = statusSnapshot(state, { now: runtime.now(), settings }, localHostId);
        const ids = new Set([...state.requests.map(r => r.threadId), ...state.leases.flatMap(l => [l.holderThreadId, l.ownerThreadId]), ...state.ports.map(p => p.threadId), ...snapshot.audit.flatMap(e => e.threadId ? [e.threadId] : [])]);
        const titles: Record<string, string> = {};
        for (const id of ids) titles[id] = (await lookup(id))?.title ?? id;
        const hostSettings: Record<string, HostSettings> = { [localHostId]: settings };
        return { ok: true, data: { ...snapshot, titles, hostSettings, localHostId } };
      }
      if (method === "log") return { ok: true, data: { events: await store.logs(p.since ?? 0, p.limit ?? 100, runtime.now(), p.hostId) } };
      if (method === "gate" || method === "grant") await sample(method === "grant");
      if (method === "transfer") {
        const target = await localThread(p.toThreadId);
        return transition({ ...p, type: "transfer", isChild: target.parentThreadId === p.threadId } as Input);
      }
      if (method === "port") {
        if (!state.leases.some(l => l.holderThreadId === p.threadId && l.hostId === localHostId)) return invalid("Port requires a held lease");
        const existing = state.ports.find(port => port.hostId === localHostId && port.threadId === p.threadId);
        if (existing) return transition({ type: "portLease", hostId: localHostId, threadId: p.threadId, port: existing.port });
        for (const port of portCandidates(state, localHostId, settings)) {
          if (await runtime.probePort(port)) return transition({ type: "portLease", hostId: localHostId, threadId: p.threadId, port });
        }
        return invalid("No free ports in the configured range");
      }
      if (method === "setCapacity") {
        settings = { ...settings, capacities: { ...settings.capacities, [p.pool]: p.capacity } };
        await handle.experimental_set({ configuration: JSON.stringify(settings, null, 2) });
      }
      return transition({ ...p, type: method } as Input);
    } catch (error) { return invalid(String(error)); }
  });
  const handlers = Object.fromEntries(Object.keys(inputs).map(method => [method, (p: unknown) => invoke(method as keyof RpcMethods, p)]));
  bb.rpc.register(rpcContract, handlers as unknown as Parameters<typeof bb.rpc.register<typeof rpcContract>>[1]);
  for (const method of Object.keys(inputs) as (keyof RpcMethods)[]) {
    bb.agents.registerTool({ name: `slots_${method}`, description: `Slots ${method}. Returns immediately. Manager operations are unrestricted.`,
      parameters: z.object(Object.fromEntries(Object.entries(inputs[method].shape).filter(([key]) => key !== "threadId"))),
      async execute(params, ctx) {
        const p = params as Record<string, unknown>;
        const threadId = ctx.threadId;
        const needsThread = "threadId" in inputs[method].shape;
        const config = await bb.sdk.system.config();
        const result = await invoke(method, { ...p, ...(needsThread ? { threadId } : {}), ...("hostId" in inputs[method].shape && !p.hostId && !["status", "log"].includes(method) ? { hostId: config.primaryHostId } : {}) });
        return JSON.stringify(result);
      },
    });
  }
  registerCli(bb, invoke);
  bb.agents.configure(() => ({ tools: Object.keys(inputs).map(m => `slots_${m}`), skills: ["slots"] }));
  handle.onChange(() => { void serial(async () => {
    settings = await getSettings();
    if (initialized) await transition({ type: "restored" });
  }).catch(error => bb.log.error(String(error))); });
  for (const event of ["thread.archived", "thread.deleted"] as const) bb.events.on(event, ({ thread }) => serial(async () => {
    await initialize(); await transition({ type: "threadEnded", threadId: thread.id, reason: event === "thread.archived" ? "archived" : "deleted" });
  }));
  bb.events.on("thread.active", ({ thread }) => serial(async () => {
    await initialize();
    if (state.leases.some(l => l.holderThreadId === thread.id)) await transition({ type: "heartbeat", threadId: thread.id });
  }));
  bb.background.service("sampler", { async start(signal) {
    let lastSample = -Infinity;
    let lastTick = -Infinity;
    while (!signal.aborted) {
      await serial(async () => {
        await initialize(); settings = await getSettings();
        const now = runtime.now();
        if (now - lastTick >= 15000) {
          for (const id of new Set(state.leases.map(l => l.holderThreadId))) {
            const thread = await lookup(id);
            if (thread?.status === "active") await transition({ type: "heartbeat", threadId: id });
          }
          await transition({ type: "tick" }); lastTick = now;
          await store.prune(now);
        }
        if (now - lastSample >= (state.requests.length ? settings.gateIntervalMs : 60000)) { await sample(); lastSample = now; }
      });
      const untilSample = lastSample + (state.requests.length ? settings.gateIntervalMs : 60000);
      await sleep(Math.max(1, Math.min(lastTick + 15000, untilSample) - runtime.now()), undefined, { signal }).catch(error => { if (!signal.aborted) throw error; });
    }
  } });
  bb.onDispose(async () => { disposed = true; await queue; });
  return { invoke };
}
