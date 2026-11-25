import type { BbPluginApi, PluginSettingDescriptor } from "@get-bb/plugin-sdk";
import * as os from "node:os";
import { sendOrAppend } from "./queued-notice";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { DEFAULT_SETTINGS, LOCAL_MODEL_MAX, POOLS, SLOTS_CHANGED, type Effect, type Settings, type State, type Input, type Result, type RpcMethods, type HostSettings, SETTING_KEYS, type SettingKey, type SettingValues, type SettingsFormView, type SettingView } from "./contract.js";
import { apply, capacityFor, deviceList, initialState, portCandidates, statusSnapshot, validateSettings, settingsFor, REMOTE_READING_MS } from "./core/index.js";
import { decidePresence, presenceHostContract, type Presence, type RawPresence } from "./presence.js";
import { DiskStore, metrics, probePort } from "./runtime.js";
import { inputs, parseObserverEvents, parseRemoteHosts, remoteLoadSchema, parseDeviceHosts, deviceHostsSchema, observerEventsSchema, remoteHostsSchema, machineToolsSchema, parseMachineTools, rpcContract, stateSchema } from "./schemas.js";
import { createWatcher } from "./watcher.js";
import { registerCli } from "./cli.js";

export function formatNotification(message: import("./contract.js").NotificationMessage): string {
  return [`\`${message.title}\``, ...message.lines.map(line => line.label ? `- ${line.label}: ${line.value}` : line.value), ...(message.hint ? [message.hint] : [])].join("\n");
}

export interface Runtime {
  now: () => number;
  cores: () => number;
  totalMemory: () => number;
  metrics: typeof metrics;
  probePort: typeof probePort;
  store?: DiskStore;
  watchCollector?: Parameters<typeof createWatcher>[0]["collector"];
  realpath?: Parameters<typeof createWatcher>[0]["realpath"];
  /** Monotonic clock for presence sample ages. */
  monotonic: () => number;
  /** One machine's presence probe; defaults to this plugin's host entry on that machine. */
  presence?: (hostId: string) => Promise<RawPresence>;
}
export type Invoke = (method: keyof RpcMethods, params: unknown, defaultHost?: boolean) => Promise<Result<unknown>>;

export default function plugin(bb: BbPluginApi) { return register(bb); }
export async function register(bb: BbPluginApi, overrides: Partial<Runtime> = {}) {
  const runtime: Runtime = { now: Date.now, metrics, probePort, monotonic: () => performance.now(),
    cores: () => os.availableParallelism?.() ?? os.cpus().length,
    totalMemory: os.totalmem, ...overrides };
  const cores = Math.max(1, runtime.cores());
  const heavyDefault = Math.max(1, Math.min(Math.floor(cores / 4), Math.floor(runtime.totalMemory() / (16 * 1024 ** 3))));
  let settingsWarnings: string[] = [];
  let localHostId = "";
  /** Connection and display name of other machines, refreshed on the sampler tick. */
  const hostInfo = new Map<string, { connected: boolean; name: string | null }>();
  /** Other bb machines for the settings picker, refreshed on the sampler tick; empty when listing fails. */
  let knownHosts: { id: string; name: string | null; connected: boolean }[] = [];
  let hostsReady: Promise<void> = Promise.resolve();
  const descriptors = {
    watchPolicy: { type: "select", label: "Load watch", options: ["off", "warn"], default: "warn" },
    watchCores: { type: "number", label: "Watch cores", default: Math.min(3, Math.max(1, cores - 1)), experimental_schema: z.number().min(1).max(cores) },
    watchWindowSeconds: { type: "number", label: "Watch window seconds", default: 120, experimental_schema: z.number().int().min(60).max(900) },
    idleLeaseMinutes: { type: "number", label: "Idle lease minutes", default: 30, experimental_schema: z.number().int().min(10).max(240) },
    heavyCapacity: { type: "number", label: "Heavy jobs", description: `Default ${heavyDefault} · max ${cores} (CPU cores). Zero disables the pool.`, default: heavyDefault, experimental_schema: z.number().int().min(0).max(cores, `Heavy capacity cannot exceed ${cores} CPU cores`) },
    heavyCapacityWithModel: { type: "number", label: "Heavy jobs with a local model", default: -1, experimental_schema: z.number().int().min(0).max(cores) },
    remoteHostsWithModel: { type: "string", label: "Other machines with a local model", default: "", experimental_schema: remoteHostsSchema },
    deviceHosts: { type: "string", label: "Model devices and machines", default: "", experimental_schema: deviceHostsSchema },
    modelHoldMinutes: { type: "number", label: "Model hold minutes", default: 60, experimental_schema: z.number().int().min(1).max(10080) },
    localModelCapacity: { type: "number", label: "Local model", description: `Default 1 · max ${LOCAL_MODEL_MAX}. Zero disables the pool.`, default: 1, experimental_schema: z.number().int().min(0).max(LOCAL_MODEL_MAX, `Local model capacity cannot exceed ${LOCAL_MODEL_MAX}`) },
    memFreeMinPct: { type: "number", label: "Memory free minimum", description: `Minimum percentage of free memory required to start work.`, default: 20, experimental_schema: z.number().min(0).max(100) },
    loadMax: { type: "number", label: "Load limit", description: `Default and max ${cores} (CPU cores). Lower this to reserve machine capacity.`, default: cores, experimental_schema: z.number().positive().max(cores, `Load limit cannot exceed ${cores} CPU cores`) },
    gateSamples: { type: "number", label: "Checks in a row", description: `Consecutive passing readings required before automatic grants.`, default: 2, experimental_schema: z.number().int().min(1).max(100) },
    gateIntervalSeconds: { type: "number", label: "Seconds between checks", description: `Time between machine readings while work is waiting.`, default: 15, experimental_schema: z.number().int().min(1).max(3600) },
    leaseTtlMinutes: { type: "number", label: "Lease time", description: `Base lease time in minutes; estimates may extend it.`, default: 30, experimental_schema: z.number().int().min(2).max(10080) },
    maxEstimateMinutes: { type: "number", label: "Longest estimate", description: `Requests with a longer estimate are refused; also caps how far an estimate extends a lease.`, default: 720, experimental_schema: z.number().int().min(10).max(10080) },
    heartbeatIntervalMinutes: { type: "number", label: "Heartbeat interval", description: `Minutes before expiry to warn an idle holder; must be below lease time.`, default: 10, experimental_schema: z.number().int().min(1).max(10079) },
    observerThreadId: { type: "string", label: "Observer", description: `Session receiving manager notifications; leave empty for none.`, default: "", experimental_schema: z.string().max(200) },
    observerEvents: { type: "string", label: "Observer events", description: `Comma-separated event names; empty disables notifications.`, default: DEFAULT_SETTINGS.observerEvents.join(","), experimental_schema: observerEventsSchema },
    observerQueueWaitMinutes: { type: "number", label: "Request wait threshold", description: `Minutes before alerting the manager about queued work.`, default: 20, experimental_schema: z.number().int().min(1).max(10080) },
    observerGateHoldMinutes: { type: "number", label: "Machine busy threshold", description: `Minutes before alerting the manager about a failing machine check.`, default: 15, experimental_schema: z.number().int().min(1).max(10080) },
    portFrom: { type: "number", label: "Ports from", description: `First port available for development servers.`, default: 41000, experimental_schema: z.number().int().min(1).max(65535) },
    portTo: { type: "number", label: "Ports to", description: `Last port available; must be at least the first port.`, default: 41099, experimental_schema: z.number().int().min(1).max(65535) },
    remoteHosts: { type: "string", label: "Other machines", description: `bb host id=heavy capacity, comma-separated (e.g. host_example=4). Threads there may lease; \`slots-run --spill\` may run heavy work there. Its machine check is its latest presence probe (memory, load), closed when older than a minute; empty means this Mac only.`, default: "", experimental_schema: remoteHostsSchema },
    machineTools: { type: "string", label: "Installed tools", default: "", experimental_schema: machineToolsSchema },
    heavyCapacityAway: { type: "number", label: "Heavy jobs while away", description: `This Mac's heavy capacity after awayMinutes without input (or with the display asleep) and no media playing. Unset follows heavy jobs.`, default: -1, experimental_schema: z.number().int().min(0).max(cores) },
    loadMaxAway: { type: "number", label: "Load limit while away", description: `This Mac's load limit while away. Unset follows the load limit.`, default: -1, experimental_schema: z.number().positive().max(cores) },
    remoteHostsAway: { type: "string", label: "Other machines while away", description: `host_id=heavy capacity while the owner is away from that machine.`, default: "", experimental_schema: remoteHostsSchema },
    remoteLoadMax: { type: "string", label: "Other machines' load limit", description: `host_id=load limit; unset uses that machine's core count.`, default: "", experimental_schema: remoteLoadSchema },
    remoteLoadMaxAway: { type: "string", label: "Other machines' load limit while away", description: `host_id=load limit while away; unset follows that machine's load limit.`, default: "", experimental_schema: remoteLoadSchema },
    awayMinutes: { type: "number", label: "Away after minutes", description: `Minutes without keyboard or mouse input before a machine counts as away.`, default: 10, experimental_schema: z.number().int().min(1).max(1440) },
    grantMode: { type: "select", label: "Grant mode", description: `Automatic grants follow queue order and passing checks; manual grants wait for the manager.`, options: ["auto", "manual"], experimental_optionLabels: { auto: "Automatic", manual: "Manual (manager grants)" }, default: "auto" },
  } satisfies Record<string, PluginSettingDescriptor>;
  const nativeSettings = bb.settings.define({ machineTools: descriptors.machineTools });
  let nativeTools = (await nativeSettings.get()).machineTools;
  nativeSettings.onChange(next => { nativeTools = next.machineTools; bb.realtime.publish(SLOTS_CHANGED, { at: runtime.now() }); });
  const defaults = Object.fromEntries(SETTING_KEYS.map(key => [key, descriptors[key].default])) as SettingValues;
  const store = runtime.store ?? new DiskStore(dirname(bb.storage.database().name));
  const rawConfig = await store.loadConfig();
  const configSchema = z.object({ version: z.literal(1), values: z.partialRecord(z.enum(SETTING_KEYS), z.union([z.number(), z.string()])) }).strict();
  let explicit = rawConfig === undefined ? {} : configSchema.parse(rawConfig).values;
  const readValues = () => ({ ...defaults, ...explicit, machineTools: nativeTools }) as Awaited<ReturnType<typeof effectiveValues>>;
  function effectiveValues() { return Object.fromEntries(SETTING_KEYS.map(key => [key, descriptors[key].default])) as {
    watchPolicy: "off" | "warn"; watchCores: number; watchWindowSeconds: number; idleLeaseMinutes: number;
    heavyCapacity: number; heavyCapacityWithModel: number; remoteHostsWithModel: string; deviceHosts: string; modelHoldMinutes: number; localModelCapacity: number; memFreeMinPct: number; loadMax: number; gateSamples: number;
    gateIntervalSeconds: number; leaseTtlMinutes: number; maxEstimateMinutes: number; heartbeatIntervalMinutes: number; observerThreadId: string;
    observerEvents: string; observerQueueWaitMinutes: number; observerGateHoldMinutes: number; portFrom: number; portTo: number; grantMode: string; remoteHosts: string; machineTools: string;
    heavyCapacityAway: number; loadMaxAway: number; remoteHostsAway: string; remoteLoadMax: string; remoteLoadMaxAway: string; awayMinutes: number;
  }; }
  function validateField(key: SettingKey, value: unknown, stored = false) {
    const descriptor = descriptors[key];
    if ("experimental_schema" in descriptor) descriptor.experimental_schema.parse(stored && typeof value === "number" ? key === "localModelCapacity" ? Math.min(value, LOCAL_MODEL_MAX) : key === "heavyCapacity" || key === "loadMax" || key === "watchCores" || key === "heavyCapacityAway" || key === "loadMaxAway" ? Math.min(value, cores) : value : value);
    else if (typeof value !== "string" || !descriptor.options.includes(value)) throw new Error("Invalid grant mode");
    return value as number | string;
  }
  for (const key of SETTING_KEYS) if (explicit[key] !== undefined) validateField(key, explicit[key], true);
  async function persistConfig(patch: Partial<SettingValues>, unset: SettingKey[] = []) {
    const next = { ...explicit };
    for (const key of SETTING_KEYS) if (patch[key] !== undefined) next[key] = validateField(key, patch[key]);
    for (const key of unset) delete next[key];
    resolveSettings({ ...readValues(), ...next, ...Object.fromEntries(unset.map(key => [key, defaults[key]])) } as ReturnType<typeof readValues>);
    if (patch.machineTools !== undefined || unset.includes("machineTools")) {
      nativeTools = (await nativeSettings.experimental_set({ machineTools: unset.includes("machineTools") ? null : String(patch.machineTools) })).machineTools;
      delete next.machineTools;
    }
    await store.saveConfig(next);
    explicit = next;
    settings = await getSettings();
    if (initialized) await transition({ type: "restored" });
    bb.realtime.publish(SLOTS_CHANGED, { at: runtime.now() });
  }
  function settingView(key: SettingKey): SettingView {
    const view = formView();
    return { key, value: view.values[key], default: key === "heavyCapacityWithModel" || key === "heavyCapacityAway" ? view.values.heavyCapacity : key === "loadMaxAway" ? view.values.loadMax : defaults[key], ...(view.maxima[key] !== undefined ? { max: view.maxima[key] } : {}), set: key in explicit };
  }
  function formView(): SettingsFormView {
    return { values: { ...readValues(), heavyCapacity: settings.capacities.heavy, heavyCapacityWithModel: settings.withModel ?? settings.capacities.heavy, heavyCapacityAway: settings.heavyAway ?? settings.capacities.heavy, loadMax: settings.loadMax, loadMaxAway: settings.loadMaxAway ?? settings.loadMax, watchCores: settings.watchCores }, defaults: { ...defaults, heavyCapacityWithModel: settings.capacities.heavy, heavyCapacityAway: settings.capacities.heavy, loadMaxAway: settings.loadMax },
      maxima: { watchCores: cores, heavyCapacityAway: cores, loadMaxAway: cores, awayMinutes: 1440, watchWindowSeconds: 900, idleLeaseMinutes: 240, heavyCapacity: cores, heavyCapacityWithModel: cores, modelHoldMinutes: 10080, loadMax: cores, localModelCapacity: LOCAL_MODEL_MAX, memFreeMinPct: 100, gateSamples: 100, gateIntervalSeconds: 3600, leaseTtlMinutes: 10080, maxEstimateMinutes: 10080, heartbeatIntervalMinutes: 10079, observerQueueWaitMinutes: 10080, observerGateHoldMinutes: 10080, portFrom: 65535, portTo: 65535 }, setKeys: Object.keys(explicit) as SettingKey[], cores, heavyDefault, hosts: knownHosts };
  }
  const getSettings = async (): Promise<Settings> => {
    const current = readValues();
    const settings = resolveSettings(current);
    settingsWarnings = [
      ...(current.loadMax > cores ? [`Saved load limit ${current.loadMax} exceeds ${cores} CPU cores; using ${cores}.`] : []),
      ...(current.watchCores > cores ? [`Saved watch threshold ${current.watchCores} exceeds ${cores} CPU cores; using ${cores}.`] : []),
      ...(current.heavyCapacity > cores ? [`Saved heavy capacity ${current.heavyCapacity} exceeds ${cores} CPU cores; using ${cores}.`] : []),
      ...(current.localModelCapacity > LOCAL_MODEL_MAX ? [`Saved local model capacity ${current.localModelCapacity} exceeds ${LOCAL_MODEL_MAX}; using ${LOCAL_MODEL_MAX}.`] : []),
    ];
    return settings;
  };
  function resolveSettings(values: ReturnType<typeof readValues>): Settings {
    const settings: Settings = {
      watchPolicy: values.watchPolicy, watchCores: Math.min(values.watchCores, cores), watchWindowSeconds: values.watchWindowSeconds, idleLeaseMinutes: values.idleLeaseMinutes,
      capacities: { heavy: Math.min(values.heavyCapacity, cores), "local-model": Math.min(values.localModelCapacity, LOCAL_MODEL_MAX) },
      memFreeMinPct: values.memFreeMinPct, loadMax: Math.min(values.loadMax, cores), gateSamples: values.gateSamples,
      gateIntervalMs: values.gateIntervalSeconds * 1000, leaseTtlMs: values.leaseTtlMinutes * 60000, maxEstimateMs: values.maxEstimateMinutes * 60000,
      heartbeatIntervalMs: values.heartbeatIntervalMinutes * 60000, observerThreadId: values.observerThreadId.trim() || null,
      observerEvents: parseObserverEvents(values.observerEvents), observerQueueWaitMs: values.observerQueueWaitMinutes * 60000,
      observerGateHoldMs: values.observerGateHoldMinutes * 60000,
      withModel: values.heavyCapacityWithModel < 0 ? Math.min(values.heavyCapacity, cores) : Math.min(values.heavyCapacityWithModel, cores),
      ...(values.heavyCapacityAway < 0 ? {} : { heavyAway: Math.min(values.heavyCapacityAway, cores) }), ...(values.loadMaxAway < 0 ? {} : { loadMaxAway: Math.min(values.loadMaxAway, cores) }), deviceHosts: parseDeviceHosts(values.deviceHosts), modelHoldMinutes: values.modelHoldMinutes,
      primaryHostId: localHostId || undefined, machineTools: parseMachineTools(values.machineTools),
      portRange: { from: values.portFrom, to: values.portTo }, grantMode: values.grantMode as Settings["grantMode"], hosts: {},
    };
    // Other machines reuse these settings with their own heavy capacity; their check is their latest probe reading.
    const { hosts: _, heavyAway: _away, loadMaxAway: _loadAway, ...base } = settings;
    const away = new Map(parseRemoteHosts(values.remoteHostsAway)), load = new Map(parseRemoteHosts(values.remoteLoadMax)), loadAway = new Map(parseRemoteHosts(values.remoteLoadMaxAway));
    for (const [hostId, heavy] of parseRemoteHosts(values.remoteHosts)) if (hostId !== localHostId) {
      const loadMax = load.get(hostId) ?? presence.get(hostId)?.cores ?? base.loadMax;
      settings.hosts[hostId] = { ...base, capacities: { heavy, "local-model": 0 }, withModel: new Map(parseRemoteHosts(values.remoteHostsWithModel)).get(hostId) ?? heavy, gated: false, connected: hostInfo.get(hostId)?.connected ?? false, tools: parseMachineTools(values.machineTools)[hostId] ?? [],
        loadMax, ...(away.has(hostId) ? { heavyAway: away.get(hostId) } : {}), ...(loadAway.has(hostId) ? { loadMaxAway: loadAway.get(hostId) } : {}) };
    }
    const error = validateSettings(settings);
    if (error) throw new Error(error);
    return settings;
  }
  let projectSettings = await bb.storage.kv.get<Record<string, "auto" | "local">>("placement-v1") ?? {};
  const projectGet = async (projectId: string) => {
    if (!(await bb.sdk.projects.list()).some(p => p.id === projectId)) throw new Error("Unknown project");
    return { placement: projectSettings[projectId] ?? "auto" };
  };
  let projectWrites: Promise<unknown> = Promise.resolve();
  const projectSet = (projectId: string, value: "auto" | "local") => {
    const write = projectWrites.then(async () => {
      await projectGet(projectId);
      const next = { ...projectSettings, [projectId]: value };
      await bb.storage.kv.set("placement-v1", next); projectSettings = next;
      return { placement: value };
    });
    projectWrites = write.catch(() => {});
    return write;
  };
  /** Latest presence per machine; `at` is the monotonic start of its probe request. */
  const presence = new Map<string, Presence & { at: number; cores?: number }>();
  let settings = await getSettings();
  let state: State = initialState();
  let dataDir = "";
  let initialized = false;
  let disposed = false;
  const titles = new Map<string, { until: number; value: Promise<string> }>();
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(() => { if (disposed) throw new Error("Slots unloaded"); return fn(); });
    queue = next.catch(() => {}); return next;
  }
  class DeadlineError extends Error {}
  async function deadline<T>(promise: Promise<T>, ms = 10000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DeadlineError("SDK call timed out")), ms); })]); }
    finally { clearTimeout(timer); }
  }
  async function sendNotification(effect: Extract<Effect, { type: "notify" }>) {
    try {
      const text = formatNotification(effect);
      if (effect.queue) await sendOrAppend(bb, { threadId: effect.threadId, text, guard: deadline });
      else await deadline(bb.sdk.threads.send({ threadId: effect.threadId, mode: "auto", originPluginId: bb.pluginId,
        input: [{ type: "text", text: `[bb message from plugin:${bb.pluginId}]\n\n${text}`, mentions: [] }] }));
    } catch (error) { bb.log.warn(`Slots notify ${effect.threadId} failed: ${String(error)}`); }
  }
  async function transition(input: Input, manualSample = false, verified = new Set<string>(), pending: Extract<Effect, { type: "notify" }>[] = [], away?: Record<string, number>) {
    if (input.type === "threadEnded") titles.delete(input.threadId);
    const change = apply(state, input, { now: runtime.now(), settings: manualSample ? { ...settings, grantMode: "manual" } : settings, ...(away ? { away: { samples: away, clock: runtime.monotonic } } : {}) });
    if (!change.result.ok) return change.result;
    const serialized = JSON.stringify(change.state);
    const changed = serialized !== store.lastSaved;
    if (changed) await store.save(serialized);
    state = change.state;
    for (const effect of change.effects) {
      if (effect.type === "audit") await store.audit(effect.event);
      else {
        if (effect.watch) {
          if (verified.has(effect.watch.holderThreadId ? `${effect.watch.subject.key}\0${effect.watch.holderThreadId}` : effect.watch.subject.key) && settings.watchPolicy !== "off") pending.push(effect);
        } else await sendNotification(effect);
      }
    }
    if (changed) bb.realtime.publish(SLOTS_CHANGED, { at: runtime.now() });
    return change.result;
  }
  async function lookup(threadId: string) {
    try { return await deadline(bb.sdk.threads.get({ threadId })); }
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
    const config = await deadline(bb.sdk.system.config());
    if (!config.primaryHostId) throw new Error("Cannot resolve BB server host");
    localHostId = config.primaryHostId;
    hostsReady = refreshHosts();
    dataDir = config.dataDir;
    const saved = await store.load();
    state = saved === undefined ? initialState() : stateSchema.parse(saved);
    await transition({ type: "restored" });
    const ids = new Set([...(settings.observerThreadId ? [settings.observerThreadId] : []), ...state.requests.map(r => r.threadId), ...state.leases.map(l => l.ownerThreadId), ...state.leases.map(l => l.holderThreadId)]);
    // Owners first: a dead child must never return a lease to a dead owner.
    for (const id of ids) await checkThread(id);
    initialized = true;
  }
  async function sample(manual = false, away?: Record<string, number>) {
    let readings;
    try { readings = await runtime.metrics(); }
    catch (error) {
      bb.log.warn(`Slots metrics failed: ${String(error)}`);
      readings = { memFreePct: 0, load1: settings.loadMax };
    }
    return transition({ type: "gateSample", hostId: localHostId, ...readings, at: runtime.now() }, manual, undefined, undefined, away);
  }
  let presenceClient: ReturnType<typeof bb.hosts.experimental_client<typeof presenceHostContract>> | undefined;
  const probe = runtime.presence ?? (hostId => (presenceClient ??= bb.hosts.experimental_client({ contract: presenceHostContract })).call("presence", {}, { hostId, timeoutMs: 5000 }));
  /** Probes every machine in parallel (5 s each); one promise per machine with its raw readings, null when its probe failed. */
  function probePresence() {
    const hostIds = [localHostId, ...Object.keys(settings.hosts)];
    const awayMinutes = readValues().awayMinutes;
    return hostIds.map(async hostId => {
      const at = runtime.monotonic();
      const raw = await deadline(probe(hostId), 5000).catch(error => { bb.log.warn(`Slots presence ${hostId} failed: ${String(error)}`); return null; });
      presence.set(hostId, { ...decidePresence(raw, awayMinutes), at, ...(raw ? { cores: raw.cores } : {}) });
      return { hostId, raw, at };
    });
  }
  const invalid = (message: string): Result<never> => ({ ok: false, error: { code: "invalid-input", message } });
  async function localThread(threadId: string) {
    const thread = await checkThread(threadId);
    if (!thread) throw new Error("Thread is missing, archived or deleted");
    const hostId = (thread.environmentId ? (await deadline(bb.sdk.environments.get({ environmentId: thread.environmentId }))).hostId : null);
    if (hostId !== localHostId && !(hostId && Object.hasOwn(settings.hosts, hostId))) throw new Error(`Slots leases only on the BB server host (${localHostId}) and machines listed in the remoteHosts setting; thread ${threadId} is on ${hostId ?? "an unknown host"}`);
    return Object.assign(thread, { slotsHostId: hostId as string });
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
  let hostName: { until: number; value: string | null } | undefined;
  async function refreshHosts() {
    try { knownHosts = (await deadline(bb.sdk.hosts.list())).filter(h => h.id !== localHostId).map(h => ({ id: h.id, name: h.name, connected: h.status === "connected" })); }
    catch { knownHosts = []; }
    for (const host of knownHosts) hostInfo.set(host.id, { connected: host.connected, name: host.name });
  }
  const invoke: Invoke = async (method, raw, defaultHost = false) => {
    const result = await serial<Result<unknown>>(async () => {
    await initialize(); settings = await getSettings();
    const parsed = inputs[method].safeParse(defaultHost ? { ...(raw as object), hostId: (raw as Record<string, unknown>).hostId || localHostId } : raw);
    if (!parsed.success) return invalid(parsed.error.message);
    // Every surface uses the same validated dispatcher; caller host comes from the thread.
    const p = parsed.data as Record<string, any>;
    try {
      const thread = p.threadId ? await localThread(p.threadId) : null;
      const threadHost = thread?.slotsHostId ?? null;
      if (method === "acquire" && p.place === "project") p.place = thread?.projectId ? (projectSettings[thread.projectId] ?? "auto") : "auto";
      if (threadHost && (method === "request" || method === "acquire" || method === "gate" || method === "port")) {
        // Heavy work runs on the caller's own machine (spill picks another one in the engine); local-model devices and the machine check live on the server host.
        const own = (method === "request" || method === "acquire") && p.pool === "heavy" ? threadHost : localHostId;
        const asked = (raw as Record<string, unknown>).hostId;
        if (asked && asked !== own) return invalid(`hostId ${String(asked)} is not where this ${method} runs (${own}); omit hostId${method === "acquire" ? ", or pass spill to allow another machine" : ""}`);
        p.hostId = own;
      }
      if (p.hostId && p.hostId !== localHostId && !Object.hasOwn(settings.hosts, p.hostId)) return invalid(`Slots leases only on the BB server host (${localHostId}) and machines listed in the remoteHosts setting`);
      // The startup host list is bounded by deadline(); the first settings read waits for it.
      if (method === "settingsRead" || method === "config") await hostsReady;
      if (method === "settingsRead") return { ok: true, data: formView() };
      if (method === "settingsWrite" || method === "config") {
        let patch: Partial<SettingValues> = p.values ?? {};
        let unset: SettingKey[] = p.unset ?? [];
        if (method === "config") {
          // With a key, config reads and returns only that setting to keep agent output small.
          if (p.operation === "show" || p.operation === "get") return { ok: true, data: p.key ? settingView(p.key) : formView() };
          if (!p.key || (p.operation === "set" && p.value === undefined)) throw new Error("Config needs a key: `bb slots config get loadMax`, `bb slots config set loadMax 12` or `bb slots config unset loadMax`");
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
        return { ok: true, data: method === "config" ? settingView(p.key) : formView() };
      }
      if (method === "observer") {
        const target = p.clear ? null : p.self ? p.threadId : p.toThreadId ?? settings.observerThreadId;
        if (p.clear || p.self || p.toThreadId || p.events !== undefined) await changeObserver(target, p.events ?? settings.observerEvents.join(","));
        const thread = settings.observerThreadId ? await checkThread(settings.observerThreadId) : null;
        return { ok: true, data: { threadId: settings.observerThreadId, title: thread?.title ?? null, events: settings.observerEvents } };
      }
      if (method === "status") {
        // This Mac first, then the configured machines, then any other host that still holds work.
        const snapshot = statusSnapshot(state, { now: runtime.now(), settings }, p.hostId ?? [...new Set([localHostId, ...Object.keys(settings.hosts), ...Object.keys(state.hosts)])]);
        snapshot.pools = snapshot.pools.filter(pool => pool.hostId === localHostId || Object.hasOwn(settings.hosts, pool.hostId) || pool.leases.length || pool.queue.length);
        const hostSettings: Record<string, HostSettings> = { [localHostId]: settings, ...settings.hosts };
        for (const pool of snapshot.pools) {
          const reading = presence.get(pool.hostId);
          if (pool.pool !== "heavy" || !reading || runtime.monotonic() - reading.at > REMOTE_READING_MS) continue;
          const extra = reading.away && !pool.mode ? Math.max(0, capacityFor(state, pool.hostId, "heavy", settings, undefined, runtime.now(), true) - pool.capacity) : 0;
          pool.presence = { away: reading.away, idleMinutes: reading.idleMinutes, ...(reading.media.length ? { media: reading.media } : {}), extra, reason: reading.reason };
        }
        return { ok: true, data: { ...snapshot, hostSettings, localHostId, deviceHosts: settings.deviceHosts, modelHoldMinutes: settings.modelHoldMinutes, settingsWarnings, watcher: watcher.diagnostics() } };
      }
      // Device registration belongs to local-models; it is an RPC only, not an agent tool or CLI command.
      if (method === "devices") return p.devices ? transition({ type: "devices", hostId: localHostId, devices: p.devices }) : { ok: true, data: { devices: deviceList(state, localHostId) } };
      if (method === "log") return { ok: true, data: { events: await store.logs(p.since ?? 0, p.limit ?? 100, runtime.now(), p.hostId) } };
      if (method === "gate" || method === "grant") await sample(method === "grant");
      if (method === "transfer") {
        const target = await localThread(p.toThreadId);
        if (target.slotsHostId !== threadHost) return invalid("Transfer only to a child on the same machine; a child elsewhere leases its own machine's capacity");
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
      if (method === "setCapacity" && p.withModel) {
        if (p.pool !== "heavy") return invalid("With-model capacity applies only to heavy jobs");
        if (p.hostId === localHostId) {
          if (p.capacity > cores) return invalid(`Heavy capacity cannot exceed ${cores} CPU cores`);
          await persistConfig({ heavyCapacityWithModel: p.capacity });
        } else {
          const entries = new Map(parseRemoteHosts(readValues().remoteHostsWithModel));
          entries.set(p.hostId, p.capacity);
          await persistConfig({ remoteHostsWithModel: [...entries].map(([h, n]) => `${h}=${n}`).join(",") });
        }
        return { ok: true, data: { capacity: p.capacity } };
      }
      if (method === "setCapacity" && p.hostId !== localHostId) {
        if (p.pool !== "heavy") return invalid("Other machines have only the heavy pool");
        // Edit only this machine's entry of remoteHosts.
        await persistConfig({ remoteHosts: parseRemoteHosts(readValues().remoteHosts).map(([h, n]) => `${h}=${h === p.hostId ? p.capacity : n}`).join(",") });
        settings = await getSettings();
      } else if (method === "setCapacity") {
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
      ...snapshot.audit.flatMap(e => e.threadId ? [e.threadId] : [])]);
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
    if (!hostName || hostName.until <= runtime.now()) {
      const value = await deadline(bb.sdk.hosts.get({ hostId: localHostId })).then(host => host.name).catch(() => null);
      hostName = { until: runtime.now() + (value === null ? 30000 : 300000), value };
    }
    const localHostName = hostName.value;
    const leaseHosts = { [localHostId]: { pools: [...POOLS], name: localHostName, tools: settings.machineTools?.[localHostId] ?? [] },
      ...Object.fromEntries(Object.keys(settings.hosts).map(id => [id, { pools: ["heavy" as const], name: hostInfo.get(id)?.name ?? null, tools: settings.hosts[id].tools ?? [] }])) };
    return { ok: true, data: { ...snapshot, localHostName, leaseHosts, titles: Object.fromEntries(resolved) } };
  };
  const handlers = Object.fromEntries(Object.keys(inputs).map(method => [method, (p: unknown) => invoke(method as keyof RpcMethods, p)]));
  bb.rpc.register(rpcContract, { ...handlers,
    "config.get": async ({ projectId }: { projectId: string }) => projectGet(projectId),
    "config.set": async ({ projectId, value }: { projectId: string; value: "auto" | "local" }) => projectSet(projectId, value),
  } as unknown as Parameters<typeof bb.rpc.register<typeof rpcContract>>[1]);
  // Agent-facing rules live here, in the skill and in CLI help; keep the three in step.
  const TOOL_DESCRIPTIONS: Partial<Record<keyof RpcMethods, string>> = {
    request: "Queue a heavy or local-model slot for your thread and return at once (granted or queued). Example: {pool:\"heavy\", job:\"full test suite\", estMs:1200000} (estMs is milliseconds; estimates above maxEstimateMinutes, default 12 h, are refused). For a command, prefer the slots-run wrapper from `bb slots wrapper`; it waits and releases for you. local-model only: device pins a registered inference device (\"local\" = this Mac); without it the first free device is granted, then this Mac.",
    acquire: "Queue a use for a script and return a use ID at once. Renew with slots_heartbeatUse while it runs and finish with slots_done; an unrenewed use expires. local-model: device works as in slots_request.",
    done: "Finish one of your uses. The lease is released when its last use is done.",
    detach: "Stop waiting for a queued use while keeping its queue place for one heartbeat interval.",
    heartbeatUse: "Renew one of your uses so it does not expire.",
    release: "Release one of your leases or cancel one of your queued requests: pass leaseId (a lease or request ID). Without leaseId it works only when you hold exactly one; pass all:true to release every lease and request of your thread.",
    heartbeat: "Extend every lease your thread holds; run it after an expiry warning if you are still working.",
    gate: "Read the machine check (memory free, load) for this host. Read-only.",
    status: "Read pools, leases, queue and recent events. Read-only.",
    transfer: "Hand one of your leases to a child thread you spawned: toThreadId, and leaseId when you own more than one. The child's release returns it to you.",
    port: "Reserve a dev-server port; needs a lease held by your thread. Released with your last lease.",
    prioritize: "Manager only: change a queued request's priority (normal, high, urgent). Other agents must not call it; ask the manager.",
    revoke: "Manager only: take a lease back with a reason sent to the holder. Other agents must not call it; ask the manager.",
    grant: "Manager only: grant a queued request out of order; capacity and the machine check still apply. Other agents must not call it.",
    setCapacity: "Manager only: persist a pool's capacity; live leases are kept. Other agents must not call it.",
    log: "Read audit events (since, limit 1–1000). Read-only.",
    config: "Read or change one setting: {operation:\"get\", key:\"loadMax\"} or {operation:\"set\", key:\"loadMax\", value:12}; unset resets to the machine default. Returns only that key. operation \"show\" without key lists all.",
    observer: "Show or change the manager (observer) thread and its event filter. Only the manager or owner changes it.",
  };
  const agentMethods = (Object.keys(inputs) as (keyof RpcMethods)[]).filter(method => !["settingsRead", "settingsWrite", "devices"].includes(method));
  for (const method of agentMethods) {
    bb.agents.registerTool({ name: `slots_${method}`, description: TOOL_DESCRIPTIONS[method] ?? `Slots ${method}. Returns immediately.`,
      parameters: z.object(Object.fromEntries(Object.entries(inputs[method].shape).filter(([key]) => key !== "threadId").map(([key, schema]) => [key, key === "hostId" ? schema.optional() : schema]))),
      async execute(params, ctx) {
        const p = params as Record<string, unknown>;
        const threadId = ctx.threadId;
        const needsThread = "threadId" in inputs[method].shape;
        const result = await invoke(method, { ...p, ...(needsThread ? { threadId } : {}) }, "hostId" in inputs[method].shape && !["status", "log"].includes(method));
        return JSON.stringify(result);
      },
    });
  }
  registerCli(bb, invoke, projectGet, projectSet);
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
  const watcher = createWatcher({ sdk: bb.sdk, hostId: () => localHostId, dataDir: () => dataDir, enabled: () => initialized && settings.watchPolicy !== "off" && !disposed,
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
    // Active holders are renewed before any tick that may expire their lease (a delayed sampler included).
    const renewActive = async () => {
      const now = runtime.now();
      for (const id of new Set(state.leases.filter(l => {
        const host = settingsFor(settings, l.hostId);
        return now - l.lastHeartbeatAt >= Math.min(60000, (host.leaseTtlMs - host.heartbeatIntervalMs) / 2);
      }).map(l => l.holderThreadId))) {
        try {
          const thread = await lookup(id);
          if (thread?.status === "active") await transition({ type: "heartbeat", threadId: id });
        } catch (error) { bb.log.warn(`Slots sampler lookup ${id} failed: ${String(error)}`); }
      }
    };
    while (!signal.aborted) {
      // Outside the queue: an unreachable machine must not hold every call for the 5 s probe timeout.
      const probes = initialized && runtime.now() - lastTick >= 15000 ? probePresence() : undefined;
      /** Machines already scheduled on their own fresh probe; the common pass leaves them out. */
      const early = new Set<string>();
      // An away machine is scheduled as soon as its own probe answers, so a slow peer's 5 s timeout never ages its sample.
      const probed = probes && await Promise.all(probes.map(async probe => {
        const result = await probe;
        if (presence.get(result.hostId)?.away) await serial(async () => {
          await initialize(); settings = await getSettings();
          const raw = result.raw;
          // Another machine is gated only by its own reading: without both metrics it gets no early pass and no extra slot (the common pass treats it as present).
          if (result.hostId !== localHostId && !(Object.hasOwn(settings.hosts, result.hostId) && raw?.memFreePct != null && raw.load1 != null)) return;
          await renewActive();
          const away = { [result.hostId]: result.at };
          if (result.hostId === localHostId) { await sample(false, away); lastSample = runtime.now(); }
          else await transition({ type: "gateSample", hostId: result.hostId, memFreePct: raw!.memFreePct!, load1: raw!.load1!, at: runtime.now() }, false, undefined, undefined, away);
          await transition({ type: "tick" }, false, undefined, undefined, away);
          early.add(result.hostId);
        }).catch(error => bb.log.warn(`Slots away pass ${result.hostId} failed: ${String(error)}`));
        return result;
      }));
      await serial(async () => {
        await initialize(); settings = await getSettings();
        const now = runtime.now();
        if (now - lastTick >= 15000) {
          await renewActive();
          for (const hostId of parseRemoteHosts(readValues().remoteHosts).map(([h]) => h)) {
            const info = await deadline(bb.sdk.hosts.get({ hostId })).then(h => ({ connected: h.status === "connected", name: h.name }), () => ({ connected: false, name: hostInfo.get(hostId)?.name ?? null }));
            hostInfo.set(hostId, info);
          }
          await refreshHosts();
          settings = await getSettings();
          // Other machines' check is their probe reading; without a fresh reading no check applies.
          for (const { hostId, raw } of probed ?? []) if (!early.has(hostId) && hostId !== localHostId && Object.hasOwn(settings.hosts, hostId) && raw?.memFreePct != null && raw.load1 != null)
            await transition({ type: "gateSample", hostId, memFreePct: raw.memFreePct, load1: raw.load1, at: now });
        }
        if (now - lastSample >= (state.requests.length ? settings.gateIntervalMs : 60000)) { await sample(false); lastSample = now; }
        if (now - lastTick >= 15000) {
          await transition({ type: "tick" }); lastTick = now;
          await store.prune(now);
        }
      });
      const untilSample = lastSample + (state.requests.length ? settings.gateIntervalMs : 60000);
      await sleep(Math.max(1, Math.min(lastTick + 15000, untilSample) - runtime.now()), undefined, { signal }).catch(error => { if (!signal.aborted) throw error; });
    }
  } });
  bb.onDispose(async () => { disposed = true; watcher.dispose(); titles.clear(); await queue; });
  return { invoke };
}
