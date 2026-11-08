import type { BbPluginApi, PluginSettingDescriptor } from "@get-bb/plugin-sdk";
import * as os from "node:os";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { DEFAULT_SETTINGS, SLOTS_CHANGED, type Effect, type Settings, type State, type Input, type Result, type RpcMethods, type HostSettings, SETTING_KEYS, type SettingKey, type SettingValues, type SettingsFormView } from "./contract.js";
import { apply, initialState, portCandidates, statusSnapshot, validateSettings } from "./core/index.js";
import { DiskStore, metrics, probePort } from "./runtime.js";
import { inputs, parseObserverEvents, observerEventsSchema, rpcContract, stateSchema } from "./schemas.js";
import { createWatcher } from "./watcher.js";
import { registerCli } from "./cli.js";

export interface Runtime {
  now: () => number;
  cores: () => number;
  totalMemory: () => number;
  metrics: typeof metrics;
  probePort: typeof probePort;
  store?: DiskStore;
  watchCollector?: Parameters<typeof createWatcher>[0]["collector"];
  realpath?: Parameters<typeof createWatcher>[0]["realpath"];
}
export type Invoke = (method: keyof RpcMethods, params: unknown) => Promise<Result<unknown>>;

export default function plugin(bb: BbPluginApi) { return register(bb); }
export async function register(bb: BbPluginApi, overrides: Partial<Runtime> = {}) {
  const runtime = { now: Date.now, metrics, probePort,
    cores: () => os.availableParallelism?.() ?? os.cpus().length,
    totalMemory: os.totalmem, ...overrides };
  const cores = Math.max(1, runtime.cores());
  const heavyDefault = Math.max(1, Math.min(Math.floor(cores / 4), Math.floor(runtime.totalMemory() / (16 * 1024 ** 3))));
  let settingsWarnings: string[] = [];
  const descriptors = {
    watchPolicy: { type: "select", label: "Load watch", options: ["off", "warn"], default: "warn" },
    watchCores: { type: "number", label: "Watch cores", default: Math.min(3, Math.max(1, cores - 1)), experimental_schema: z.number().min(1).max(cores) },
    watchWindowSeconds: { type: "number", label: "Watch window seconds", default: 120, experimental_schema: z.number().int().min(60).max(900) },
    idleLeaseMinutes: { type: "number", label: "Idle lease minutes", default: 30, experimental_schema: z.number().int().min(10).max(240) },
    heavyCapacity: { type: "number", label: "Heavy jobs", description: `Default ${heavyDefault} · max ${cores} (CPU cores). Zero disables the pool.`, default: heavyDefault, experimental_schema: z.number().int().min(0).max(cores, `Heavy capacity cannot exceed ${cores} CPU cores`) },
    localModelCapacity: { type: "number", label: "Local model", description: `Default 1 · max 10000. Zero disables the pool.`, default: 1, experimental_schema: z.number().int().min(0).max(10000) },
    memFreeMinPct: { type: "number", label: "Memory free minimum", description: `Minimum percentage of free memory required to start work.`, default: 20, experimental_schema: z.number().min(0).max(100) },
    loadMax: { type: "number", label: "Load limit", description: `Default and max ${cores} (CPU cores). Lower this to reserve machine capacity.`, default: cores, experimental_schema: z.number().positive().max(cores, `Load limit cannot exceed ${cores} CPU cores`) },
    gateSamples: { type: "number", label: "Checks in a row", description: `Consecutive passing readings required before automatic grants.`, default: 2, experimental_schema: z.number().int().min(1).max(100) },
    gateIntervalSeconds: { type: "number", label: "Seconds between checks", description: `Time between machine readings while work is waiting.`, default: 15, experimental_schema: z.number().int().min(1).max(3600) },
    leaseTtlMinutes: { type: "number", label: "Lease time", description: `Base lease time in minutes; estimates may extend it.`, default: 30, experimental_schema: z.number().int().min(2).max(10080) },
    heartbeatIntervalMinutes: { type: "number", label: "Heartbeat interval", description: `Minutes before expiry to warn an idle holder; must be below lease time.`, default: 10, experimental_schema: z.number().int().min(1).max(10079) },
    observerThreadId: { type: "string", label: "Observer", description: `Session receiving manager notifications; leave empty for none.`, default: "", experimental_schema: z.string().max(200) },
    observerEvents: { type: "string", label: "Observer events", description: `Comma-separated event names; empty disables notifications.`, default: DEFAULT_SETTINGS.observerEvents.join(","), experimental_schema: observerEventsSchema },
    observerQueueWaitMinutes: { type: "number", label: "Request wait threshold", description: `Minutes before alerting the manager about queued work.`, default: 20, experimental_schema: z.number().int().min(1).max(10080) },
    observerGateHoldMinutes: { type: "number", label: "Machine busy threshold", description: `Minutes before alerting the manager about a failing machine check.`, default: 15, experimental_schema: z.number().int().min(1).max(10080) },
    portFrom: { type: "number", label: "Ports from", description: `First port available for development servers.`, default: 41000, experimental_schema: z.number().int().min(1).max(65535) },
    portTo: { type: "number", label: "Ports to", description: `Last port available; must be at least the first port.`, default: 41099, experimental_schema: z.number().int().min(1).max(65535) },
    grantMode: { type: "select", label: "Grant mode", description: `Automatic grants follow queue order and passing checks; manual grants wait for the manager.`, options: ["auto", "manual"], experimental_optionLabels: { auto: "Automatic", manual: "Manual (manager grants)" }, default: "auto" },
  } satisfies Record<string, PluginSettingDescriptor>;
  const defaults = Object.fromEntries(SETTING_KEYS.map(key => [key, descriptors[key].default])) as SettingValues;
  const store = runtime.store ?? new DiskStore(dirname(bb.storage.database().name));
  const rawConfig = await store.loadConfig();
  const configSchema = z.object({ version: z.literal(1), values: z.partialRecord(z.enum(SETTING_KEYS), z.union([z.number(), z.string()])) }).strict();
  let explicit = rawConfig === undefined ? {} : configSchema.parse(rawConfig).values;
  const readValues = () => ({ ...defaults, ...explicit }) as Awaited<ReturnType<typeof effectiveValues>>;
  function effectiveValues() { return Object.fromEntries(SETTING_KEYS.map(key => [key, descriptors[key].default])) as {
    watchPolicy: "off" | "warn"; watchCores: number; watchWindowSeconds: number; idleLeaseMinutes: number;
    heavyCapacity: number; localModelCapacity: number; memFreeMinPct: number; loadMax: number; gateSamples: number;
    gateIntervalSeconds: number; leaseTtlMinutes: number; heartbeatIntervalMinutes: number; observerThreadId: string;
    observerEvents: string; observerQueueWaitMinutes: number; observerGateHoldMinutes: number; portFrom: number; portTo: number; grantMode: string;
  }; }
  function validateField(key: SettingKey, value: unknown, stored = false) {
    const descriptor = descriptors[key];
    if ("experimental_schema" in descriptor) descriptor.experimental_schema.parse(stored && (key === "heavyCapacity" || key === "loadMax" || key === "watchCores") && typeof value === "number" ? Math.min(value, cores) : value);
    else if (typeof value !== "string" || !descriptor.options.includes(value)) throw new Error("Invalid grant mode");
    return value as number | string;
  }
  for (const key of SETTING_KEYS) if (explicit[key] !== undefined) validateField(key, explicit[key], true);
  async function persistConfig(patch: Partial<SettingValues>, unset: SettingKey[] = []) {
    const next = { ...explicit };
    for (const key of SETTING_KEYS) if (patch[key] !== undefined) next[key] = validateField(key, patch[key]);
    for (const key of unset) delete next[key];
    resolveSettings({ ...readValues(), ...next, ...Object.fromEntries(unset.map(key => [key, defaults[key]])) } as ReturnType<typeof readValues>);
    await store.saveConfig(next);
    explicit = next;
    settings = await getSettings();
    if (initialized) await transition({ type: "restored" });
  }
  function formView(): SettingsFormView {
    return { values: { ...readValues(), heavyCapacity: settings.capacities.heavy, loadMax: settings.loadMax, watchCores: settings.watchCores }, defaults,
      maxima: { watchCores: cores, watchWindowSeconds: 900, idleLeaseMinutes: 240, heavyCapacity: cores, loadMax: cores, localModelCapacity: 10000, memFreeMinPct: 100, gateSamples: 100, gateIntervalSeconds: 3600, leaseTtlMinutes: 10080, heartbeatIntervalMinutes: 10079, observerQueueWaitMinutes: 10080, observerGateHoldMinutes: 10080, portFrom: 65535, portTo: 65535 }, setKeys: Object.keys(explicit) as SettingKey[], cores, heavyDefault };
  }
  const getSettings = async (): Promise<Settings> => {
    const current = readValues();
    const settings = resolveSettings(current);
    settingsWarnings = [
      ...(current.loadMax > cores ? [`Saved load limit ${current.loadMax} exceeds ${cores} CPU cores; using ${cores}.`] : []),
      ...(current.watchCores > cores ? [`Saved watch threshold ${current.watchCores} exceeds ${cores} CPU cores; using ${cores}.`] : []),
      ...(current.heavyCapacity > cores ? [`Saved heavy capacity ${current.heavyCapacity} exceeds ${cores} CPU cores; using ${cores}.`] : []),
    ];
    return settings;
  };
  function resolveSettings(values: ReturnType<typeof readValues>): Settings {
    const settings: Settings = {
      watchPolicy: values.watchPolicy, watchCores: Math.min(values.watchCores, cores), watchWindowSeconds: values.watchWindowSeconds, idleLeaseMinutes: values.idleLeaseMinutes,
      capacities: { heavy: Math.min(values.heavyCapacity, cores), "local-model": values.localModelCapacity },
      memFreeMinPct: values.memFreeMinPct, loadMax: Math.min(values.loadMax, cores), gateSamples: values.gateSamples,
      gateIntervalMs: values.gateIntervalSeconds * 1000, leaseTtlMs: values.leaseTtlMinutes * 60000,
      heartbeatIntervalMs: values.heartbeatIntervalMinutes * 60000, observerThreadId: values.observerThreadId.trim() || null,
      observerEvents: parseObserverEvents(values.observerEvents), observerQueueWaitMs: values.observerQueueWaitMinutes * 60000,
      observerGateHoldMs: values.observerGateHoldMinutes * 60000,
      portRange: { from: values.portFrom, to: values.portTo }, grantMode: values.grantMode as Settings["grantMode"], hosts: {},
    };
    const error = validateSettings(settings);
    if (error) throw new Error(error);
    return settings;
  }
  let settings = await getSettings();
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
  async function sendNotification(effect: Extract<Effect, { type: "notify" }>) {
    try {
      await bb.sdk.threads.send({ threadId: effect.threadId, mode: "auto", originPluginId: bb.pluginId,
        input: [{ type: "text", text: `[Slots] ${effect.text}`, mentions: [] }] });
    } catch (error) { bb.log.warn(`Slots notify ${effect.threadId} failed: ${String(error)}`); }
  }
  async function transition(input: Input, manualSample = false, verified = new Set<string>(), pending: Extract<Effect, { type: "notify" }>[] = []) {
    if (input.type === "threadEnded") titles.delete(input.threadId);
    const change = apply(state, input, { now: runtime.now(), settings: manualSample ? { ...settings, grantMode: "manual" } : settings });
    if (!change.result.ok) return change.result;
    await store.save(change.state);
    state = change.state;
    for (const effect of change.effects) {
      if (effect.type === "audit") await store.audit(effect.event);
      else {
        if (effect.watch) {
          if (verified.has(effect.watch.holderThreadId ? `${effect.watch.subject.key}\0${effect.watch.holderThreadId}` : effect.watch.subject.key) && settings.watchPolicy !== "off") pending.push(effect);
        } else await sendNotification(effect);
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
    await persistConfig({ ...(previousThreadId !== threadId ? { observerThreadId: threadId ?? "" } : {}),
      ...(previousEvents.join(",") !== nextEvents.join(",") ? { observerEvents: nextEvents.join(",") } : {}) });
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
      if (method === "settingsRead") return { ok: true, data: formView() };
      if (method === "settingsWrite" || method === "config") {
        let patch: Partial<SettingValues> = p.values ?? {};
        let unset: SettingKey[] = p.unset ?? [];
        if (method === "config") {
          if (p.operation === "show") return { ok: true, data: formView() };
          if (!p.key || (p.operation === "set" && p.value === undefined)) throw new Error("Config set needs key and value; unset needs a key");
          if (p.operation === "unset") unset = [p.key];
          else patch = { [p.key]: typeof defaults[p.key as SettingKey] === "number" && typeof p.value === "string" ? Number(p.value) : p.value };
        }
        const candidate = { ...readValues(), ...patch, ...Object.fromEntries(unset.map(key => [key, defaults[key]])) } as ReturnType<typeof readValues>;
        if (("observerThreadId" in patch || unset.includes("observerThreadId")) && candidate.observerThreadId.trim()) await localThread(candidate.observerThreadId.trim());
        const previousThreadId = settings.observerThreadId, previousEvents = settings.observerEvents;
        await persistConfig(patch, unset);
        if (previousThreadId !== settings.observerThreadId || previousEvents.join(",") !== settings.observerEvents.join(",")) {
          const target = settings.observerThreadId ? await lookup(settings.observerThreadId) : null;
          await transition({ type: "observer", hostId: localHostId, previousThreadId, previousEvents, title: target?.title ?? settings.observerThreadId });
        }
        return { ok: true, data: formView() };
      }
      if (method === "observer") {
        const target = p.clear ? null : p.self ? p.threadId : p.toThreadId ?? settings.observerThreadId;
        if (p.clear || p.self || p.toThreadId || p.events !== undefined) await changeObserver(target, p.events ?? settings.observerEvents.join(","));
        const thread = settings.observerThreadId ? await checkThread(settings.observerThreadId) : null;
        return { ok: true, data: { threadId: settings.observerThreadId, title: thread?.title ?? null, events: settings.observerEvents } };
      }
      if (method === "status") {
        const snapshot = statusSnapshot(state, { now: runtime.now(), settings }, localHostId);
        const hostSettings: Record<string, HostSettings> = { [localHostId]: settings };
        return { ok: true, data: { ...snapshot, hostSettings, localHostId, settingsWarnings, watcher: watcher.diagnostics() } };
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
        if (p.pool === "heavy" && p.capacity > cores) return invalid(`Heavy capacity cannot exceed ${cores} CPU cores`);
        await persistConfig(p.pool === "heavy" ? { heavyCapacity: p.capacity } : { localModelCapacity: p.capacity });
        settings = await getSettings();
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
    const localHostName = await bb.sdk.hosts.get({ hostId: localHostId }).then(host => host.name).catch(() => null);
    return { ok: true, data: { ...snapshot, localHostName, titles: Object.fromEntries(resolved) } };
  };
  const handlers = Object.fromEntries(Object.keys(inputs).map(method => [method, (p: unknown) => invoke(method as keyof RpcMethods, p)]));
  bb.rpc.register(rpcContract, handlers as unknown as Parameters<typeof bb.rpc.register<typeof rpcContract>>[1]);
  const agentMethods = (Object.keys(inputs) as (keyof RpcMethods)[]).filter(method => !["settingsRead", "settingsWrite"].includes(method));
  for (const method of agentMethods) {
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
  bb.agents.configure(() => ({ tools: agentMethods.map(m => `slots_${m}`), skills: ["slots"] }));
  for (const event of ["thread.archived", "thread.deleted"] as const) bb.events.on(event, ({ thread }) => serial(async () => {
    await initialize();
    if (settings.observerThreadId === thread.id) await changeObserver(null, settings.observerEvents.join(","), true);
    await transition({ type: "threadEnded", threadId: thread.id, reason: event === "thread.archived" ? "archived" : "deleted" });
  }));
  bb.events.on("thread.active", ({ thread }) => serial(async () => {
    await initialize();
    if (state.leases.some(l => l.holderThreadId === thread.id)) await transition({ type: "heartbeat", threadId: thread.id });
  }));
  const watcher = createWatcher({ sdk: bb.sdk, hostId: () => localHostId, enabled: () => initialized && settings.watchPolicy !== "off" && !disposed,
    now: runtime.now, collector: runtime.watchCollector, realpath: runtime.realpath, warn: error => bb.log.warn(`Slots watcher: ${String(error)}`),
    preview: usage => serial(async () => apply(state, usage, { now: runtime.now(), settings }).effects),
    commit: async (usage, verified, signal) => {
      const pending: Extract<Effect, { type: "notify" }>[] = [];
      await serial(async () => transition(usage, false, verified, pending));
      for (const effect of pending) {
        if (signal.aborted || disposed || settings.watchPolicy === "off") break;
        await sendNotification(effect);
      }
    },
  });
  for (const event of ["thread.created", "thread.archived", "thread.unarchived", "thread.deleted"] as const) bb.events.on(event, () => { watcher.invalidate(); });
  bb.background.service("watcher", { async start(signal) {
    if (settings.watchPolicy !== "off") await serial(initialize).catch(error => bb.log.warn(`Slots watcher initialization: ${String(error)}`));
    await watcher.start(signal);
  } });
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
  bb.onDispose(async () => { disposed = true; watcher.dispose(); titles.clear(); await queue; });
  return { invoke };
}
