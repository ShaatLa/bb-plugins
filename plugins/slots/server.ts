import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { DEFAULT_SETTINGS, SLOTS_CHANGED, type Settings, type State, type Input, type Result, type RpcMethods, type HostSettings } from "./contract.js";
import { apply, initialState, portCandidates, statusSnapshot, validateSettings } from "./core/index.js";
import { DiskStore, metrics, probePort } from "./runtime.js";
import { inputs, parseObserverEvents, observerEventsSchema, rpcContract, stateSchema } from "./schemas.js";
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
  const handle = bb.settings.define({
    heavyCapacity: { type: "number", label: "Heavy capacity (0–10000)", default: 4, experimental_schema: z.number().int().min(0).max(10000) },
    localModelCapacity: { type: "number", label: "Local model capacity (0–10000)", default: 1, experimental_schema: z.number().int().min(0).max(10000) },
    memFreeMinPct: { type: "number", label: "Minimum memory free % (0–100)", default: 20, experimental_schema: z.number().min(0).max(100) },
    loadMax: { type: "number", label: "Maximum 1-minute load (0.1–1000)", default: 18, experimental_schema: z.number().min(0.1).max(1000) },
    gateSamples: { type: "number", label: "Consecutive gate samples (1–100)", default: 2, experimental_schema: z.number().int().min(1).max(100) },
    gateIntervalSeconds: { type: "number", label: "Gate interval in seconds (1–3600)", default: 15, experimental_schema: z.number().int().min(1).max(3600) },
    leaseTtlMinutes: { type: "number", label: "Lease TTL in minutes (2–10080)", default: 30, experimental_schema: z.number().int().min(2).max(10080) },
    heartbeatIntervalMinutes: { type: "number", label: "Heartbeat interval in minutes (1–10079; below TTL)", default: 10, experimental_schema: z.number().int().min(1).max(10079) },
    observerThreadId: { type: "string", label: "Observer thread ID (optional)", default: "", experimental_schema: z.string().max(200) },
    observerEvents: { type: "string", label: "Observer events (comma-separated; empty disables)", default: DEFAULT_SETTINGS.observerEvents.join(","), experimental_schema: observerEventsSchema },
    observerQueueWaitMinutes: { type: "number", label: "Observer queue wait in minutes", default: 20, experimental_schema: z.number().int().min(1).max(10080) },
    observerGateHoldMinutes: { type: "number", label: "Observer gate hold in minutes", default: 15, experimental_schema: z.number().int().min(1).max(10080) },
    portFrom: { type: "number", label: "First dev-server port (1–65535)", default: 41000, experimental_schema: z.number().int().min(1).max(65535) },
    portTo: { type: "number", label: "Last dev-server port (1–65535; at least first port)", default: 41099, experimental_schema: z.number().int().min(1).max(65535) },
    grantMode: { type: "select", label: "Grant mode", options: ["auto", "manual"], default: "auto" },
  });
  const getSettings = async (): Promise<Settings> => {
    const values = await handle.get();
    const settings: Settings = {
      capacities: { heavy: values.heavyCapacity, "local-model": values.localModelCapacity },
      memFreeMinPct: values.memFreeMinPct, loadMax: values.loadMax, gateSamples: values.gateSamples,
      gateIntervalMs: values.gateIntervalSeconds * 1000, leaseTtlMs: values.leaseTtlMinutes * 60000,
      heartbeatIntervalMs: values.heartbeatIntervalMinutes * 60000, observerThreadId: values.observerThreadId.trim() || null,
      observerEvents: parseObserverEvents(values.observerEvents), observerQueueWaitMs: values.observerQueueWaitMinutes * 60000,
      observerGateHoldMs: values.observerGateHoldMinutes * 60000,
      portRange: { from: values.portFrom, to: values.portTo }, grantMode: values.grantMode as Settings["grantMode"], hosts: {},
    };
    const error = validateSettings(settings);
    if (error) throw new Error(error);
    return settings;
  };
  let settings = await getSettings();
  const store = runtime.store ?? new DiskStore(dirname(bb.storage.database().name));
  let state: State = initialState();
  let localHostId = "";
  let initialized = false;
  let disposed = false;
  const titles = new Map<string, { until: number; value: Promise<string> }>();
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(() => { if (disposed) throw new Error("Slots unloaded"); return fn(); });
    queue = next.catch(() => {}); return next;
  }
  async function transition(input: Input, manualSample = false) {
    if (input.type === "threadEnded") titles.delete(input.threadId);
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
      if (settings.observerThreadId === threadId) await changeObserver(null, settings.observerEvents.join(","), true);
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
    const ids = new Set([...(settings.observerThreadId ? [settings.observerThreadId] : []), ...state.requests.map(r => r.threadId), ...state.leases.map(l => l.ownerThreadId), ...state.leases.map(l => l.holderThreadId)]);
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
  async function changeObserver(threadId: string | null, events: string, previousEnded = false) {
    const previousThreadId = settings.observerThreadId;
    const previousEvents = settings.observerEvents;
    const nextEvents = parseObserverEvents(events);
    const target = threadId ? await localThread(threadId) : null;
    if (previousThreadId === threadId && previousEvents.join(",") === nextEvents.join(",")) return;
    await handle.experimental_set({ observerThreadId: threadId ?? "", observerEvents: nextEvents.join(",") });
    settings = await getSettings();
    await transition({ type: "observer", hostId: localHostId, previousThreadId, previousEvents, previousEnded, title: target?.title ?? threadId });
  }
  const invoke: Invoke = async (method, raw) => {
    const result = await serial<Result<unknown>>(async () => {
    await initialize(); settings = await getSettings();
    const parsed = inputs[method].safeParse(raw);
    if (!parsed.success) return invalid(parsed.error.message);
    // Every surface uses the same validated dispatcher; caller host comes from the thread.
    const p = parsed.data as Record<string, any>;
    try {
      if (p.threadId) await localThread(p.threadId);
      if (p.hostId && p.hostId !== localHostId) return invalid(`Slots v1 only supports the BB server host (${localHostId})`);
      if (method === "observer") {
        const target = p.clear ? null : p.self ? p.threadId : p.toThreadId ?? settings.observerThreadId;
        if (p.clear || p.self || p.toThreadId || p.events !== undefined) await changeObserver(target, p.events ?? settings.observerEvents.join(","));
        const thread = settings.observerThreadId ? await checkThread(settings.observerThreadId) : null;
        return { ok: true, data: { threadId: settings.observerThreadId, title: thread?.title ?? null, events: settings.observerEvents } };
      }
      if (method === "status") {
        const snapshot = statusSnapshot(state, { now: runtime.now(), settings }, localHostId);
        const hostSettings: Record<string, HostSettings> = { [localHostId]: settings };
        return { ok: true, data: { ...snapshot, hostSettings, localHostId } };
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
        await handle.experimental_set(p.pool === "heavy" ? { heavyCapacity: p.capacity } : { localModelCapacity: p.capacity });
      }
      return transition({ ...p, type: method } as Input);
    } catch (error) { return invalid(String(error)); }
    });
    if (method !== "status" || !result.ok) return result;
    const snapshot = result.data as Omit<import("./contract.js").StatusView, "titles">;
    const ids = new Set([...snapshot.pools.flatMap(p => [...p.queue.map(r => r.threadId), ...p.leases.flatMap(l => [l.holderThreadId, l.ownerThreadId])]),
      ...snapshot.ports.map(p => p.threadId), ...snapshot.audit.flatMap(e => e.threadId ? [e.threadId] : [])]);
    const resolved = await Promise.all([...ids].map(async id => {
      let entry = titles.get(id);
      if (!entry || entry.until <= runtime.now()) {
        entry = { until: runtime.now() + 60000, value: lookup(id).then(thread => thread?.title ?? id).catch(() => id) };
        titles.delete(id);
        titles.set(id, entry);
        if (titles.size > 256) titles.delete(titles.keys().next().value!);
      }
      return [id, await entry.value] as const;
    }));
    return { ok: true, data: { ...snapshot, titles: Object.fromEntries(resolved) } };
  };
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
    await initialize();
    if (settings.observerThreadId === thread.id) await changeObserver(null, settings.observerEvents.join(","), true);
    await transition({ type: "threadEnded", threadId: thread.id, reason: event === "thread.archived" ? "archived" : "deleted" });
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
  bb.onDispose(async () => { disposed = true; titles.clear(); await queue; });
  return { invoke };
}
