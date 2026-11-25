import { duration as minutes } from "../lib/duration.js";
import { updateWatch } from "./watch.js";
import {
  DEFAULT_SETTINGS, OBSERVER_EVENTS, POOLS, THIS_MAC,
  type AuditEvent, type AuditType, type Context, type Effect, type EngineOutput, type NotificationMessage,
  type DeviceInfo, type ObserverEvent, type GateState, type HostSettings, type PoolName, type Input, type Lease, type LogParams,
  type Priority, type Result, type Settings, type SlotsError, type State,
  type StatusSnapshot, type Transition,
} from "../contract.js";

export function initialState(): State {
  return { version: 1, nextId: 1, nextAuditSeq: 1, hosts: {}, requests: [], leases: [], ports: [], audit: [] };
}
export function settingsFor(settings: Settings, hostId: string): HostSettings {
  return Object.hasOwn(settings.hosts, hostId) ? settings.hosts[hostId] : settings;
}
export function validateSettings(settings: Settings): string | null {
  const validHost = (s: HostSettings): boolean => Boolean(s && s.capacities && s.portRange) &&
    POOLS.every(p => Number.isSafeInteger(s.capacities[p]) && s.capacities[p] >= 0) &&
    (s.withModel === undefined || (Number.isSafeInteger(s.withModel) && s.withModel >= 0)) &&
    Number.isFinite(s.memFreeMinPct) && s.memFreeMinPct >= 0 && s.memFreeMinPct <= 100 &&
    Number.isFinite(s.loadMax) && s.loadMax > 0 &&
    Number.isSafeInteger(s.gateSamples) && s.gateSamples > 0 &&
    Number.isSafeInteger(s.gateIntervalMs) && s.gateIntervalMs > 0 &&
    Number.isSafeInteger(s.leaseTtlMs) && s.leaseTtlMs > 0 &&
    Number.isSafeInteger(s.maxEstimateMs) && s.maxEstimateMs > 0 &&
    Number.isSafeInteger(s.heartbeatIntervalMs) && s.heartbeatIntervalMs > 0 &&
    s.heartbeatIntervalMs < s.leaseTtlMs &&
    (s.observerThreadId === null || text(s.observerThreadId)) &&
    Array.isArray(s.observerEvents) && s.observerEvents.every(e => OBSERVER_EVENTS.includes(e)) &&
    Number.isSafeInteger(s.observerQueueWaitMs) && s.observerQueueWaitMs > 0 &&
    Number.isSafeInteger(s.observerGateHoldMs) && s.observerGateHoldMs > 0 &&
    ["off", "warn"].includes(s.watchPolicy) && Number.isFinite(s.watchCores) && s.watchCores >= 1 &&
    Number.isInteger(s.watchWindowSeconds) && s.watchWindowSeconds >= 60 && s.watchWindowSeconds <= 900 &&
    Number.isInteger(s.idleLeaseMinutes) && s.idleLeaseMinutes >= 10 && s.idleLeaseMinutes <= 240 &&
    (s.grantMode === "auto" || s.grantMode === "manual") &&
    Number.isSafeInteger(s.portRange.from) && Number.isSafeInteger(s.portRange.to) &&
    s.portRange.from >= 1 && s.portRange.to <= 65535 && s.portRange.from <= s.portRange.to;
  return settings && settings.hosts && (settings.modelHoldMinutes === undefined || (Number.isSafeInteger(settings.modelHoldMinutes) && settings.modelHoldMinutes > 0)) && validHost(settings) && Object.values(settings.hosts).every(validHost)
    ? null : "Invalid settings (capacities, gate thresholds, TTL/heartbeat interval or port range)";
}
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const priority = (value: unknown): value is Priority => value === "urgent" || value === "high" || value === "normal";
const rank = { urgent: 0, high: 1, normal: 2 };
const URGENT = new Set<AuditType>(["warn", "revoke", "expire", "release", "unleased-load"]);
const sorted = (state: State) => state.requests.map((request, index) => ({ request, index }))
  .sort((a, b) => rank[a.request.priority] - rank[b.request.priority] ||
    a.request.createdAt - b.request.createdAt || a.index - b.index).map(x => x.request);
const emptyGate = (): GateState => ({ latest: null, streak: 0, lastCountedAt: null, failingSince: null, holdAlerted: false });
const modelHost = (hostId: string, device: string | undefined, settings: Settings): string | undefined =>
  device === undefined ? hostId : settings.deviceHosts && Object.hasOwn(settings.deviceHosts, device) ? settings.deviceHosts[device] : undefined;
const modelCandidates = (state: State, request: { hostId: string; device?: string }) =>
  (request.device === undefined ? [...(state.hosts[request.hostId]?.devices ?? []).map(d => d.name), undefined] : [request.device === THIS_MAC ? undefined : request.device]);
const blockedDevice = (state: State, hostId: string, settings: Settings): string | undefined => {
  for (const request of state.requests.filter(r => r.pool === "local-model")) {
    for (const device of modelCandidates(state, request)) {
      if (modelHost(request.hostId, device, settings) !== hostId) continue;
      const capacity = device === undefined ? settingsFor(settings, request.hostId).capacities["local-model"] : state.hosts[request.hostId]?.devices?.find(d => d.name === device)?.capacity ?? 0;
      if (state.leases.filter(l => l.pool === "local-model" && l.hostId === request.hostId && l.device === device).length < capacity) return device ?? THIS_MAC;
    }
  }
  return undefined;
};
const modelMode = (state: State, hostId: string, settings: Settings, now: number) => {
  const high = settingsFor(settings, hostId).capacities.heavy;
  const withModel = settingsFor(settings, hostId).withModel ?? high;
  const queued = blockedDevice(state, hostId, settings);
  const models = state.leases.filter(l => l.pool === "local-model" && modelHost(l.hostId, l.device, settings) === hostId);
  const running = models.find(l => now - l.grantedAt < (settings.modelHoldMinutes ?? 60) * 60000);
  const lease = running ?? models[0];
  if (!queued && !lease) return undefined;
  return { high, withModel, reason: queued ? "model-queued" as const : running ? "model-running" as const : "hold-expired" as const, device: queued ?? lease?.device ?? THIS_MAC, admitting: !queued };
};
export function capacityFor(state: State, hostId: string, pool: (typeof POOLS)[number], settings: Settings, device?: string, now = 0): number {
  if (pool === "heavy") {
    const mode = modelMode(state, hostId, settings, now);
    return mode && state.leases.some(l => l.pool === "local-model" && modelHost(l.hostId, l.device, settings) === hostId && now - l.grantedAt < (settings.modelHoldMinutes ?? 60) * 60000) ? mode.withModel : settingsFor(settings, hostId).capacities.heavy;
  }
  return device === undefined ? settingsFor(settings, hostId).capacities[pool] : state.hosts[hostId]?.devices?.find(d => d.name === device)?.capacity ?? 0;
}
/** Pool and device of a lease for notices, e.g. `local-model M1`. */
const slotName = (l: Lease) => `${l.pool}${l.device ? ` ${l.device}` : ""}${l.homeHostId ? ` on ${l.hostId}` : ""}`;
/** Host the lease's request came from; differs from `hostId` only for a spilled lease. */
const home = (l: Lease) => l.homeHostId ?? l.hostId;
/** Slot group of a lease or request: a device name, or undefined for this Mac (pinned with `local` or unpinned). */
const group = (item: { device?: string }) => item.device === THIS_MAC ? undefined : item.device;
const same = (item: { hostId: string; pool: PoolName; device?: string }, hostId: string, pool: PoolName, device?: string) =>
  item.hostId === hostId && item.pool === pool && group(item) === device;
/** A lease serves a call: an unpinned call takes the thread's lease on any device, a pinned one only on its device. */
const serves = (l: Lease, hostId: string, pool: PoolName, device?: string) =>
  home(l) === hostId && l.pool === pool && (device === undefined || l.device === group({ device }));
export function deviceList(state: State, hostId: string): DeviceInfo[] {
  return structuredClone(state.hosts[hostId]?.devices ?? []);
}
export function gateOpen(gate: GateState, settings: HostSettings): boolean {
  return gate.latest !== null && gate.latest.passed && gate.streak >= settings.gateSamples;
}
/** The local model runs on the GPU, so its pool checks only free (shared) memory in the latest reading. */
export function poolGateOpen(gate: GateState, settings: HostSettings, pool: PoolName, manual = false): boolean {
  if (settings.gated === false) return true;
  if (pool === "local-model") return gate.latest !== null && gate.latest.memFreePct >= settings.memFreeMinPct;
  return Boolean(gate.latest?.passed) && (manual || gateOpen(gate, settings));
}
/** A finished local-model lease stays with its thread this long, so the next turn re-acquires without a gate wait. */
export const LOCAL_MODEL_GRACE_MS = 90_000;
export function portCandidates(state: State, hostId: string, settings: Settings = DEFAULT_SETTINGS): number[] {
  const range = settingsFor(settings, hostId).portRange;
  const used = new Set(state.ports.filter(p => p.hostId === hostId).map(p => p.port));
  return Array.from({ length: range.to - range.from + 1 }, (_, i) => range.from + i).filter(p => !used.has(p));
}
export function logSince(state: State, filter: LogParams = {}): AuditEvent[] {
  const events = state.audit.filter(e => (filter.since === undefined || e.at >= filter.since) &&
    (filter.hostId === undefined || e.hostId === filter.hostId));
  return structuredClone(filter.limit === undefined ? events : filter.limit <= 0 ? [] : events.slice(-filter.limit));
}
export function statusSnapshot(state: State, ctx: Context, hostId?: string | string[]): StatusSnapshot {
  const hosts = hostId === undefined ? [...new Set([...Object.keys(state.hosts), ...Object.keys(ctx.settings.hosts)])].sort() : [hostId].flat();
  const queue = sorted(state);
  return structuredClone({
    at: ctx.now,
    // local-model splits per device: this Mac, registered devices, then unregistered ones still in use.
    pools: hosts.flatMap(host => POOLS.filter(pool => pool === "heavy" || settingsFor(ctx.settings, host).gated !== false).flatMap(pool => [undefined, ...(pool === "heavy" ? [] : [...new Set([...deviceList(state, host).map(d => d.name),
      ...[...state.leases, ...state.requests].filter(x => x.hostId === host && x.pool === pool && group(x) !== undefined).map(x => x.device!).sort()])])].map(device => ({
      hostId: host, pool, ...(device === undefined ? {} : { device }),
      capacity: capacityFor(state, host, pool, ctx.settings, device, ctx.now),
      ...(pool === "heavy" && modelMode(state, host, ctx.settings, ctx.now) ? { mode: modelMode(state, host, ctx.settings, ctx.now) } : {}),
      leases: state.leases.filter(l => same(l, host, pool, device)),
      queue: queue.filter(r => same(r, host, pool, device)),
    })))),
    gates: Object.fromEntries(hosts.map(host => [host, Object.hasOwn(state.hosts, host) ? state.hosts[host].gate : emptyGate()])),
    ports: state.ports.filter(p => hosts.includes(p.hostId)),
    audit: logSince(state, typeof hostId === "string" ? { hostId } : {}).filter(e => e.type !== "gate").sort((a, b) => b.at - a.at || b.seq - a.seq).slice(0, 15),
  });
}

/** Pure transaction: failed operations return the original state and no effects. */
export function apply(original: State, input: Input, ctx: Context): Transition {
  const fail = (code: SlotsError["code"], message: string, readings?: SlotsError["readings"]): Transition => ({
    state: original, effects: [], result: { ok: false, error: { code, message, ...(readings ? { readings } : {}) } },
  });
  const invalid = validateSettings(ctx.settings);
  if (invalid || !Number.isSafeInteger(ctx.now) || ctx.now < 0) return fail("invalid-input", invalid ?? "Invalid clock");
  if ("hostId" in input && !text(input.hostId)) return fail("invalid-input", "hostId is required");
  if ("threadId" in input && !text(input.threadId)) return fail("invalid-input", "threadId is required");
  if ("pool" in input && !POOLS.includes(input.pool)) return fail("invalid-input", "Unknown pool");
  const state = structuredClone(original);
  const effects: Effect[] = [];
  let data: EngineOutput = null;
  const host = (id: string) => {
    if (!Object.hasOwn(state.hosts, id)) Object.defineProperty(state.hosts, id, {
      value: { gate: emptyGate() }, enumerable: true, writable: true, configurable: true,
    });
    return state.hosts[id];
  };
  const audit = (type: AuditType, fields: Omit<AuditEvent, "type" | "seq" | "at"> = {}) => {
    const event: AuditEvent = { seq: state.nextAuditSeq++, at: ctx.now, type, ...fields };
    if (type !== "gate") state.audit.push(event);
    state.audit = state.audit.slice(-50);
    effects.push({ type: "audit", event: structuredClone(event) });
  };
  // Steer only notices the agent must act on now; the rest wait until it is free.
  const notify = (threadId: string, reason: AuditType, message: NotificationMessage, queue = !URGENT.has(reason)) => effects.push({ type: "notify", threadId, reason, ...(queue ? { queue: true as const } : {}), ...message });
  const observer = (hostId: string, reason: ObserverEvent, message: NotificationMessage, ...recipients: string[]) => {
    const { observerThreadId: id, observerEvents } = settingsFor(ctx.settings, hostId);
    if (id && !recipients.includes(id) && observerEvents.includes(reason)) notify(id, reason, message, true);
  };
  const fields = (l: Lease) => ({ hostId: l.hostId, pool: l.pool, ...(l.device ? { device: l.device } : {}), threadId: l.holderThreadId, requestId: l.requestId, leaseId: l.id });
  const refresh = (l: Lease) => {
    l.lastHeartbeatAt = ctx.now;
    l.expiresAt = ctx.now + Math.max(settingsFor(ctx.settings, l.hostId).leaseTtlMs, Math.min(l.estMs, settingsFor(ctx.settings, l.hostId).maxEstimateMs) + 900_000);
    l.warnedAt = null;
  };
  // The owner keeps a local-model lease alive while its child holds it: the child is never asked to.
  const keeps = (l: Lease, id: string) => l.holderThreadId === id || (l.pool === "local-model" && l.ownerThreadId === id);
  const heartbeat = (id: string) => state.leases.filter(l => keeps(l, id)).forEach(refresh);
  const registered = (hostId: string) => (state.hosts[hostId]?.devices ?? []).map(d => d.name);
  /** Where a request may be granted, in preference order: local-model devices, or its own host then, with spill, other connected machines. */
  const candidates = (r: { hostId: string; pool: PoolName; device?: string; spill?: boolean; place?: "auto" | "local"; needs?: string[] }): { hostId: string; device?: string }[] =>
    r.pool === "local-model" ? (r.device === undefined ? [...registered(r.hostId), undefined] : [group(r)]).map(device => ({ hostId: r.hostId, device }))
      : [r.hostId, ...((r.place === "auto" || r.spill) ? [...new Set([...(ctx.settings.primaryHostId ? [ctx.settings.primaryHostId] : []), ...Object.keys(ctx.settings.hosts)])].filter(h => h !== r.hostId && (h === ctx.settings.primaryHostId || ctx.settings.hosts[h]?.connected !== false) && (r.needs ?? []).every(tool => (ctx.settings.hosts[h]?.tools ?? ctx.settings.machineTools?.[h] ?? []).includes(tool))) : [])].map(hostId => ({ hostId }));
  const gateless = (hostId: string) => settingsFor(ctx.settings, hostId).gated === false;
  const checkDevice = (hostId: string, pool: PoolName, device?: string): string | null => {
    if (device === undefined) return null;
    if (pool !== "local-model") return "A device applies only to the local-model pool; drop --device for heavy work";
    const names = registered(hostId);
    return device === THIS_MAC || names.includes(device) ? null : `Device ${device} is not registered (registered: ${names.join(", ") || "none"}). Pass --device ${THIS_MAC} for this Mac, or omit --device to take the first free device; local-models registers the devices it reaches.`;
  };
  const reset = (id: string) => { host(id).gate.streak = 0; host(id).gate.lastCountedAt = null; };
  const cleanupPorts = () => {
    state.ports = state.ports.filter(p => {
      if (state.leases.some(l => l.hostId === p.hostId && l.holderThreadId === p.threadId)) return true;
      audit("port-release", { hostId: p.hostId, threadId: p.threadId, port: p.port });
      return false;
    });
  };
  const free = (l: Lease, type: "release" | "expire" | "revoke", reason: string, by: string | null = null) => {
    if (l.pool === "heavy") { const h = host(l.hostId); h.watch ??= { lastEndAt: null, settings: "", heavyEndAt: {}, subjects: {} }; h.watch.heavyEndAt[l.holderThreadId] = ctx.now; }
    state.leases = state.leases.filter(x => x.id !== l.id);
    audit(type, { ...fields(l), reason });
    const message: NotificationMessage = { title: type === "release" ? "Slot released" : type === "expire" ? "Lease expired" : "Lease revoked", lines: [{ value: l.job }, { label: "Lease", value: `\`${l.id}\` · ${slotName(l)} slot ${l.slotIndex}` }, ...(reason === `${type}d` ? [] : [{ label: "Reason", value: type === "revoke" ? reason : `\`${reason}\`` }])] };
    const initiator = by; // the thread that released (CLI release, or its own last `done`) already knows
    // A local-model child holding its parent's lease is not woken for its end; the owner still hears unless it ended the lease itself.
    for (const id of new Set([l.holderThreadId, l.ownerThreadId])) if (id !== initiator && !(l.pool === "local-model" && id !== l.ownerThreadId)) notify(id, type, message);
    observer(l.hostId, type, message, l.holderThreadId, l.ownerThreadId);
  };
  const grant = (requestId: string, manual: boolean): Result<Lease> => {
    const request = state.requests.find(r => r.id === requestId);
    if (!request) return { ok: false, error: { code: "not-found", message: "Request not found" } };
    const { pool } = request;
    let failure: SlotsError | null = null;
    let hostId = request.hostId, device: string | undefined, index = 0;
    // An unpinned local-model request takes the first free registered device, then this Mac; a spilled heavy one its own host, then other machines.
    for ({ hostId, device } of candidates(request)) {
      const machine = pool === "local-model" ? modelHost(hostId, device, ctx.settings) : hostId;
      if (pool === "heavy" && blockedDevice(state, hostId, ctx.settings)) { failure = { code: "capacity", message: "Local model queued on this machine" }; continue; }
      if (pool === "local-model" && machine && state.leases.filter(l => l.pool === "heavy" && l.hostId === machine).length > (settingsFor(ctx.settings, machine).withModel ?? settingsFor(ctx.settings, machine).capacities.heavy)) { failure = { code: "capacity", message: "Waiting for heavy jobs to finish" }; continue; }
      const gate = host(hostId).gate;
      // This Mac's readings say nothing about another device, so a registered device has no machine check.
      if (device === undefined && !poolGateOpen(gate, settingsFor(ctx.settings, hostId), pool, manual)) {
        failure = { code: "gate-closed", message: "Host gate is closed", ...(gate.latest ? { readings: gate.latest } : {}) }; continue;
      }
      const capacity = capacityFor(state, hostId, pool, ctx.settings, device, ctx.now);
      const leases = state.leases.filter(l => same(l, hostId, pool, device));
      index = 0;
      while (leases.some(l => l.slotIndex === index)) index++;
      if (leases.length < capacity && index < capacity) { failure = null; break; }
      failure = { code: "capacity", message: "Pool is at capacity" };
    }
    if (failure) return { ok: false, error: failure };
    const lease: Lease = { id: `lease-${state.nextId++}`, requestId, hostId, pool, slotIndex: index,
      ownerThreadId: request.threadId, holderThreadId: request.threadId, job: request.job, estMs: request.estMs,
      grantedAt: ctx.now, lastHeartbeatAt: ctx.now, expiresAt: 0, warnedAt: null,
      uses: request.uses ?? [], autoRelease: request.autoRelease ?? false, graceUntil: request.graceUntil ?? null, ...(device === undefined ? {} : { device }), ...(hostId === request.hostId ? {} : { homeHostId: request.hostId }) };
    refresh(lease);
    state.leases.push(lease);
    state.requests = state.requests.filter(r => r.id !== requestId);
    if (device === undefined && !gateless(hostId)) reset(hostId); // a grant on another device or machine leaves this Mac's streak alone
    audit("grant", { ...fields(lease), manual });
    const message: NotificationMessage = { title: "Slot granted", lines: [{ value: lease.job }, { label: "Lease", value: `\`${lease.id}\` · ${slotName(lease)} slot ${index}` }], hint: `Run heavy commands through \`slots-run\` (\`bb slots wrapper\`); release with \`bb slots release ${lease.id}\`.` };
    // A live use means a waiter (slots-run, acquire RPC) already sees the grant; a message would only cost a turn.
    if (!lease.uses?.length) notify(lease.holderThreadId, "grant", message);
    observer(hostId, "grant", message, lease.holderThreadId);
    return { ok: true, data: lease };
  };
  const schedule = () => {
    for (const request of sorted(state).sort((a, b) => Number(a.pool === "heavy") - Number(b.pool === "heavy"))) {
      if (settingsFor(ctx.settings, request.hostId).grantMode === "auto") grant(request.id, false);
    }
  };
  const release = (threadId: string, leaseId?: string, reason = "released", ended = false, quiet = false) => {
    const result = { released: [] as string[], returned: [] as string[], canceled: [] as string[] };
    for (const l of [...state.leases]) {
      if (leaseId !== undefined && l.id !== leaseId) continue;
      if (l.ownerThreadId === threadId) { free(l, "release", reason, reason === "released" ? threadId : null); result.released.push(l.id); }
      else if (l.holderThreadId === threadId) {
        for (const use of l.uses ?? []) audit("use-dropped", { ...fields(l), reason: use.id });
        l.uses = []; l.holderThreadId = l.ownerThreadId; refresh(l);
        audit("transfer", { ...fields(l), reason: "returned-to-owner" });
        const message: NotificationMessage = { title: "Slot returned to you", lines: [{ value: l.job }, { label: "Lease", value: `\`${l.id}\` · ${slotName(l)} slot ${l.slotIndex}` }] };
        // A local-model thread has nothing to do with the notice, and reading it costs a full model turn; the owner hears from its child's report.
        if (l.pool !== "local-model") notify(l.ownerThreadId, "transfer", message);
        observer(l.hostId, "transfer", message, l.ownerThreadId);
        result.returned.push(l.id);
      }
    }
    if (ended || leaseId === undefined || leaseId.startsWith("req-")) state.requests = state.requests.filter(r => {
      if (r.threadId !== threadId || (leaseId !== undefined && r.id !== leaseId)) return true;
      result.canceled.push(r.id);
      audit("release", { hostId: r.hostId, pool: r.pool, threadId, requestId: r.id, reason });
      if (!quiet) observer(r.hostId, "release", { title: "Slot released", lines: [{ value: r.job }, { label: "Request", value: `\`${r.id}\` · ${r.pool}` }, { label: "Thread", value: `\`${threadId}\`` }, ...(reason === "released" ? [] : [{ label: "Reason", value: `\`${reason}\`` }])] });
      return false;
    });
    return result;
  };
  switch (input.type) {
    case "usage": {
      if (![input.startAt, input.endAt].every(n => Number.isSafeInteger(n) && n >= 0) || !Number.isFinite(input.unknownCores) || input.unknownCores < 0 || input.subjects.some(s => !text(s.key) || !s.threadIds.length || s.threadIds.some(t => !text(t)) || !Number.isFinite(s.cores) || s.cores < 0)) return fail("invalid-input", "Invalid usage");
      for (const alert of updateWatch(host(input.hostId), state.leases, input, ctx)) {
        audit(alert.reason, { hostId: input.hostId, reason: [alert.message.title, ...alert.message.lines.map(line => line.value), alert.message.hint].filter(Boolean).join("; ") });
        const recipients = alert.reason === "unleased-load" && alert.subject.threadIds.length === 1 ? [...alert.subject.threadIds] : [];
        const config = settingsFor(ctx.settings, input.hostId);
        if (config.observerThreadId && config.observerEvents.includes(alert.reason) && !recipients.includes(config.observerThreadId)) recipients.push(config.observerThreadId);
        for (const threadId of recipients) effects.push({ type: "notify", threadId, reason: alert.reason, ...(alert.subject.threadIds.includes(threadId) ? {} : { queue: true as const }), ...alert.message, watch: { hostId: input.hostId, subject: alert.subject, holderThreadId: alert.holderThreadId } });
      }
      break;
    }
    case "request": {
      if (!text(input.job) || !Number.isSafeInteger(input.estMs) || input.estMs <= 0 ||
          !Number.isSafeInteger(ctx.now + input.estMs + 900_000) ||
          (input.priority !== undefined && !priority(input.priority))) return fail("invalid-input", "Job, positive estimate and valid priority required, e.g. --job \"full test suite\" --est 20m");
      const estCap = settingsFor(ctx.settings, input.hostId).maxEstimateMs;
      if (input.estMs > estCap) return fail("invalid-input", `Estimate ${minutes(input.estMs)} is above the ${minutes(estCap)} ceiling. Pass a realistic estimate with a unit, e.g. --est 45m or --est 2h (a bare --est number means minutes; the tool's estMs is milliseconds). Heartbeats keep a longer job's lease alive.`);
      const deviceError = checkDevice(input.hostId, input.pool, input.device);
      if (deviceError) return fail("invalid-input", deviceError);
      host(input.hostId);
      const lease = state.leases.find(l => serves(l, input.hostId, input.pool, input.device) &&
        (l.holderThreadId === input.threadId || l.ownerThreadId === input.threadId));
      heartbeat(input.threadId);
      if (lease) { data = { kind: "leased", lease }; break; }
      const existing = state.requests.find(r => r.hostId === input.hostId && r.pool === input.pool && r.device === input.device && r.threadId === input.threadId);
      if (existing) { data = { kind: "queued", request: existing }; break; }
      const request = { id: `req-${state.nextId++}`, hostId: input.hostId, pool: input.pool,
        threadId: input.threadId, job: input.job, estMs: input.estMs, priority: input.priority ?? "normal", createdAt: ctx.now, ...(input.device === undefined ? {} : { device: input.device }) };
      state.requests.push(request);
      audit("request", { hostId: request.hostId, pool: request.pool, threadId: request.threadId, requestId: request.id });
      if (request.pool === "local-model" || gateless(request.hostId)) schedule();
      const granted = state.leases.find(l => l.requestId === request.id);
      data = granted ? { kind: "leased", lease: granted } : { kind: "queued", request }; break;
    }
    case "acquire": {
      if (!text(input.job) || !Number.isSafeInteger(input.estMs) || input.estMs <= 0 ||
          !Number.isSafeInteger(ctx.now + input.estMs + 900_000) ||
          (input.priority !== undefined && !priority(input.priority))) return fail("invalid-input", "Job, positive estimate and valid priority required, e.g. --job \"full test suite\" --est 20m");
      const estCap = settingsFor(ctx.settings, input.hostId).maxEstimateMs;
      if (input.estMs > estCap) return fail("invalid-input", `Estimate ${minutes(input.estMs)} is above the ${minutes(estCap)} ceiling. Pass a realistic estimate with a unit, e.g. --est 45m or --est 2h (a bare --est number means minutes; the tool's estMs is milliseconds). Heartbeats keep a longer job's lease alive.`);
      if (input.spill && input.pool !== "heavy") return fail("invalid-input", "--spill applies only to heavy work; local-model already picks a device");
      const deviceError = checkDevice(input.hostId, input.pool, input.device);
      if (deviceError) return fail("invalid-input", deviceError);
      const lease = state.leases.find(l => serves(l, input.hostId, input.pool, input.device) && (l.holderThreadId === input.threadId || l.ownerThreadId === input.threadId));
      if (lease && lease.holderThreadId !== input.threadId) return fail("transferred", "Lease is held by another thread");
      const place = input.place === "auto" || input.spill ? "auto" : "local";
      if (lease && lease.hostId !== input.hostId && (place === "local" || !(input.needs ?? []).every(tool => (ctx.settings.hosts[lease.hostId]?.tools ?? ctx.settings.machineTools?.[lease.hostId] ?? []).includes(tool)))) { data = { kind: "busy" }; break; }
      let request = state.requests.find(r => r.hostId === input.hostId && r.pool === input.pool && r.device === input.device && r.threadId === input.threadId);
      if (request && input.pool === "heavy") {
        request.place = request.place === "local" || (!request.place && !request.spill) || place === "local" ? "local" : "auto";
        request.spill = request.place === "auto";
        request.needs = [...new Set([...(request.needs ?? []), ...(input.needs ?? [])])];
      }
      if (!lease && !request) {
        request = { id: `req-${state.nextId++}`, hostId: input.hostId, pool: input.pool, threadId: input.threadId,
          job: input.job, estMs: input.estMs, priority: input.priority ?? "normal", createdAt: ctx.now, autoRelease: true, ...(input.device === undefined ? {} : { device: input.device }), ...(input.pool === "heavy" ? { place, needs: input.needs ?? [] } : {}) };
        state.requests.push(request);
        audit("request", { hostId: request.hostId, pool: request.pool, threadId: request.threadId, requestId: request.id });
      }
      const target = lease ?? request!;
      const use = { id: `use-${state.nextId++}`, threadId: input.threadId, startedAt: ctx.now,
        expiresAt: ctx.now + settingsFor(ctx.settings, input.hostId).heartbeatIntervalMs };
      (target.uses ??= []).push(use); target.graceUntil = null;
      if (!lease && (target.pool === "local-model" || (request!.place === "auto" || request!.spill) || gateless(target.hostId))) {
        schedule();
        const granted = state.leases.find(l => l.requestId === target.id);
        if (granted) { data = { kind: "leased", lease: granted, useId: use.id }; break; }
      }
      if (lease) { refresh(lease); lease.expiresAt = Math.max(lease.expiresAt, use.expiresAt); data = { kind: "leased", lease, useId: use.id }; }
      else data = { kind: "queued", request: request!, useId: use.id };
      break;
    }
    case "done": case "detach": case "heartbeatUse": {
      const target = [...state.leases, ...state.requests].find(item => item.uses?.some(use => use.id === input.useId));
      if (!target) return fail("not-found", "Use not found; it may have expired. Start a new one with `bb slots acquire`");
      const use = target.uses!.find(use => use.id === input.useId)!;
      if (use.threadId !== input.threadId) return fail("forbidden", "Use belongs to another thread; finish only uses your thread started");
      const lease = "holderThreadId" in target ? target : undefined;
      if (input.type === "heartbeatUse") {
        use.expiresAt = ctx.now + settingsFor(ctx.settings, target.hostId).heartbeatIntervalMs;
        if (lease) { refresh(lease); lease.expiresAt = Math.max(lease.expiresAt, use.expiresAt); }
        data = lease ? { kind: "leased", lease, useId: use.id } : { kind: "queued", request: target as import("../contract.js").SlotRequest, useId: use.id };
      } else if (input.type === "detach" && lease) data = { kind: "leased", lease, useId: use.id };
      else {
        target.uses = target.uses!.filter(u => u.id !== use.id);
        if (target.autoRelease && !target.uses.length) {
          if (input.type === "detach") target.graceUntil = ctx.now + settingsFor(ctx.settings, target.hostId).heartbeatIntervalMs;
          else if (lease && lease.pool === "local-model") lease.graceUntil = ctx.now + LOCAL_MODEL_GRACE_MS;
          else if (lease) free(lease, "release", "last use completed", input.threadId);
          else release(input.threadId, target.id, "last use completed");
        }
        if (input.type === "detach") data = { kind: "queued", position: sorted(state).filter(r => same(r, target.hostId, target.pool, group(target))).findIndex(r => r.id === target.id) + 1 };
      }
      break;
    }
    case "gateSample": {
      const gate = host(input.hostId).gate;
      if (!Number.isFinite(input.memFreePct) || input.memFreePct < 0 || input.memFreePct > 100 ||
          !Number.isFinite(input.load1) || input.load1 < 0 || !Number.isSafeInteger(input.at) || input.at < 0 ||
          input.at > ctx.now || (gate.latest && input.at < gate.latest.at)) return fail("invalid-input", "Invalid or out-of-order gate readings");
      const settings = settingsFor(ctx.settings, input.hostId);
      const readings = { memFreePct: input.memFreePct, load1: input.load1, at: input.at };
      const passed = input.memFreePct >= settings.memFreeMinPct && input.load1 < settings.loadMax;
      gate.latest = { ...readings, passed };
      audit("gate", { hostId: input.hostId, readings });
      if (passed) { gate.failingSince = null; gate.holdAlerted = false; }
      else gate.failingSince ??= input.at;
      if (!passed) reset(input.hostId);
      // Sampler ticks land a few ms early; a strict interval would skip every other reading.
      else if (gate.lastCountedAt === null || input.at - gate.lastCountedAt >= settings.gateIntervalMs * 0.9) {
        gate.streak = Math.min(gate.streak + 1, settings.gateSamples); gate.lastCountedAt = input.at;
      }
      schedule(); // a local-model request needs only memory, so try even when the full gate failed
      data = { passed, open: gateOpen(gate, settings), gate }; break;
    }
    case "gate": {
      heartbeat(input.threadId);
      const gate = host(input.hostId).gate;
      data = { passed: gate.latest?.passed ?? false, open: gateOpen(gate, settingsFor(ctx.settings, input.hostId)), gate }; break;
    }
    case "heartbeat": heartbeat(input.threadId); data = { leases: state.leases.filter(l => keeps(l, input.threadId)) }; break;
    case "release": {
      if (input.leaseId !== undefined) {
        // A request id also names the lease it was granted as.
        const lease = state.leases.find(l => l.id === input.leaseId || l.requestId === input.leaseId);
        const request = state.requests.find(r => r.id === input.leaseId);
        if (!lease && !request) return fail("not-found", "Lease or request not found; list your leases and requests with `bb slots status`");
        if (request && request.threadId !== input.threadId) return fail("forbidden", "Request belongs to another thread; only the thread that queued it can cancel it");
        if (lease && lease.ownerThreadId !== input.threadId && lease.holderThreadId !== input.threadId) return fail("forbidden", "Lease is held by another thread; release only your own leases (see `bb slots status`)");
      } else if (!input.all) {
        // A bare release must not quietly free more than the caller meant.
        const mine = [...state.leases.filter(l => l.ownerThreadId === input.threadId || l.holderThreadId === input.threadId).map(l => l.id),
          ...state.requests.filter(r => r.threadId === input.threadId).map(r => r.id)];
        if (mine.length > 1) return fail("invalid-input", `Your thread has ${mine.length} leases or requests (${mine.join(", ")}). Release one with \`bb slots release <id>\`, or all of them with \`bb slots release --all\``);
      }
      data = release(input.threadId, state.leases.find(l => l.requestId === input.leaseId)?.id ?? input.leaseId); break;
    }
    case "threadEnded": data = release(input.threadId, undefined, input.reason, true); break;
    case "transfer": {
      if (!text(input.toThreadId) || input.toThreadId === input.threadId) return fail("invalid-input", "Transfer needs a different target thread: --to <child-thread-id>");
      const owned = state.leases.filter(l => l.ownerThreadId === input.threadId && (input.leaseId === undefined || l.id === input.leaseId));
      if (owned.length !== 1) return fail(owned.length ? "invalid-input" : "forbidden", owned.length ? "You own several leases; pass --lease <id> (see `bb slots status`)" : "You own no lease to transfer; only the lease owner can transfer it");
      if (!input.isChild) return fail("forbidden", "Target must be a child thread you spawned; transfer only to your own children");
      const lease = owned[0];
      if (lease.uses?.length || lease.graceUntil != null) return fail("in-use", "Lease has active uses or grace; transfer after its slots-run or acquire uses finish");
      if (state.leases.some(l => l.id !== lease.id && home(l) === home(lease) && l.pool === lease.pool &&
          (l.ownerThreadId === input.toThreadId || l.holderThreadId === input.toThreadId)) ||
          state.requests.some(r => r.hostId === home(lease) && r.pool === lease.pool && r.threadId === input.toThreadId)) return fail("invalid-input", "Target already has an open request or lease in this pool; the child can use its own slot instead");
      lease.holderThreadId = input.toThreadId; refresh(lease);
      audit("transfer", { ...fields(lease), reason: `from ${input.threadId}` });
      const message: NotificationMessage = { title: "Slot transferred to you", lines: [{ value: lease.job }, { label: "Lease", value: `\`${lease.id}\` · ${slotName(lease)} slot ${lease.slotIndex}` }], hint: `Run heavy commands through \`slots-run\` (\`bb slots wrapper\`); release with \`bb slots release ${lease.id}\`.` };
      // A transferred local-model lease only marks the child as the GPU user; the child has nothing to do with the notice, and reading it costs a full model turn.
      if (lease.pool !== "local-model") notify(lease.holderThreadId, "transfer", message);
      observer(lease.hostId, "transfer", message, lease.holderThreadId);
      data = lease; break;
    }
    case "portLease": {
      if (!state.leases.some(l => l.hostId === input.hostId && l.holderThreadId === input.threadId)) return fail("forbidden", "Port requires a lease held by your thread; get one first with slots-run or `bb slots request --wait`");
      heartbeat(input.threadId);
      const existing = state.ports.find(p => p.hostId === input.hostId && p.threadId === input.threadId);
      if (existing) { data = existing; break; }
      const range = settingsFor(ctx.settings, input.hostId).portRange;
      if (!Number.isSafeInteger(input.port) || input.port < range.from || input.port > range.to) return fail("invalid-input", "Port outside configured range");
      if (state.ports.some(p => p.hostId === input.hostId && p.port === input.port)) return fail("port-in-use", "Port already leased");
      const port = { hostId: input.hostId, threadId: input.threadId, port: input.port, createdAt: ctx.now };
      state.ports.push(port); audit("port", { hostId: input.hostId, threadId: input.threadId, port: input.port });
      data = port; break;
    }
    case "prioritize": {
      if (!priority(input.priority)) return fail("invalid-input", "Unknown priority");
      const request = state.requests.find(r => r.id === input.requestId);
      if (!request) return fail("not-found", "Request not found");
      request.priority = input.priority;
      audit("prioritize", { hostId: request.hostId, pool: request.pool, threadId: request.threadId, requestId: request.id, reason: input.priority });
      data = request; break;
    }
    case "revoke": {
      if (!text(input.reason)) return fail("invalid-input", "Revocation reason required: --reason \"why the lease is taken back\"");
      const lease = state.leases.find(l => l.id === input.leaseId);
      if (!lease) return fail("not-found", "Lease not found");
      free(lease, "revoke", input.reason);
      data = { released: [lease.id], returned: [], canceled: [] }; break;
    }
    case "grant": {
      const result = grant(input.requestId, true);
      if (!result.ok) return fail(result.error.code, result.error.message, result.error.readings);
      data = result.data; break;
    }
    case "setCapacity": {
      if (!Number.isSafeInteger(input.capacity) || input.capacity < 0) return fail("invalid-input", "Capacity must be a nonnegative integer");
      host(input.hostId);
      audit("capacity", { hostId: input.hostId, pool: input.pool, reason: String(input.capacity) });
      observer(input.hostId, "capacity", { title: "Capacity changed", lines: [{ value: `${input.pool} capacity set to ${input.capacity}.` }, { label: "Host", value: `\`${input.hostId}\`` }] });
      data = { capacity: input.capacity }; break;
    }
    case "devices": {
      const next = new Map<string, number>();
      for (const d of input.devices) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(d.name) || d.name === THIS_MAC || !Number.isSafeInteger(d.capacity) || d.capacity < 0 || d.capacity > 100 || next.has(d.name)) return fail("invalid-input", `Invalid or duplicate device ${JSON.stringify(d.name)}: a name is 1–32 letters, digits, '.', '_' or '-', not "${THIS_MAC}"; capacity 0–100`);
        next.set(d.name, d.capacity);
      }
      const h = host(input.hostId), previous = new Map((h.devices ?? []).map(d => [d.name, d.capacity]));
      const changes = [...[...previous.keys()].filter(name => !next.has(name)).map(name => [name, "removed"]),
        ...[...next].filter(([name, capacity]) => previous.get(name) !== capacity).map(([name, capacity]) => [name, `capacity ${capacity}`])];
      const reordered = [...previous.keys()].filter(name => next.has(name)).join() !== [...next.keys()].filter(name => previous.has(name)).join();
      if (changes.length || reordered) {
        h.devices = [...next].map(([name, capacity]) => ({ name, capacity }));
        for (const [device, reason] of changes) audit("capacity", { hostId: input.hostId, pool: "local-model", device, reason });
        if (changes.length) observer(input.hostId, "capacity", { title: "Capacity changed", lines: [...changes.map(([device, reason]) => ({ value: `local-model ${device}: ${reason}.` })), { label: "Host", value: `\`${input.hostId}\`` }] });
        schedule();
      }
      data = { devices: deviceList(state, input.hostId) }; break;
    }
    case "tick": {
      for (const target of [...state.requests, ...state.leases]) {
        const expired = (target.uses ?? []).filter(u => ctx.now >= u.expiresAt);
        for (const use of expired) audit("use-expired", { hostId: target.hostId, pool: target.pool, threadId: use.threadId, reason: use.id });
        if (expired.length) target.uses = target.uses!.filter(u => ctx.now < u.expiresAt);
        if (target.autoRelease && !(target.uses?.length) && (expired.length > 0 || (target.graceUntil != null && ctx.now >= target.graceUntil))) {
          if (!expired.length) audit("unclaimed", { hostId: target.hostId, pool: target.pool, reason: target.id });
          // An unclaimed local-model lease is the idle grace ending; its thread is not waiting, so no message.
          if ("holderThreadId" in target) free(target, "release", expired.length ? "use expired" : "unclaimed", !expired.length && target.pool === "local-model" ? target.holderThreadId : null);
          else if (!expired.length) release(target.threadId, target.id, "unclaimed");
          else {
            // The waiter stopped renewing (its process ended or the thread went idle): tell the thread it is no longer queued.
            release(target.threadId, target.id, "use expired", false, true);
            const message: NotificationMessage = { title: "Queued request dropped", lines: [{ value: target.job }, { label: "Request", value: `\`${target.id}\` · ${target.pool}` }, { label: "Reason", value: "use expired while queued; you are no longer in the queue" }],
              hint: `Queue again with \`sh -c "$(bb slots wrapper)" slots-run …\` or \`bb slots request --wait\`, and keep that waiter running until it is granted.` };
            if (target.pool !== "local-model") notify(target.threadId, "expire", message); // a local-models thread's withSlot sees its use vanish; a message would cost it a model turn
            // One observer notice: on `expire` when the observer follows it, else on `release` as before.
            observer(target.hostId, settingsFor(ctx.settings, target.hostId).observerEvents.includes("expire") ? "expire" : "release", message, ...(target.pool !== "local-model" ? [target.threadId] : []));
          }
        }
      }
      for (const lease of [...state.leases]) {
        if (ctx.now >= lease.expiresAt) free(lease, "expire", "expired");
        else if (lease.warnedAt === null && ctx.now >= lease.expiresAt - settingsFor(ctx.settings, lease.hostId).heartbeatIntervalMs) {
          lease.warnedAt = ctx.now; audit("warn", fields(lease));
          const message: NotificationMessage = { title: "Expiry warning", lines: [{ value: lease.job }, { label: "Lease", value: `\`${lease.id}\` · ${slotName(lease)}` }, { label: "Expires", value: `in ${minutes(lease.expiresAt - ctx.now)}` }], hint: `Run \`bb slots heartbeat\` to keep it, or \`bb slots release ${lease.id}\`.` };
          // The owner of a transferred local-model lease keeps it alive; its child is not woken for the warning.
          const warned = lease.pool === "local-model" ? lease.ownerThreadId : lease.holderThreadId;
          notify(warned, "warn", message);
          observer(lease.hostId, "warn", message, warned);
        }
      }
      schedule();
      for (const request of sorted(state)) {
        const settings = settingsFor(ctx.settings, request.hostId);
        if (request.queueWaitAlerted || ctx.now - request.createdAt < settings.observerQueueWaitMs) continue;
        request.queueWaitAlerted = true;
        const reasons = [];
        const devices = candidates(request);
        if (group(request) !== undefined && !registered(request.hostId).includes(request.device!)) reasons.push("device not registered");
        else if (devices.every(c => state.leases.filter(l => same(l, c.hostId, request.pool, c.device)).length >= capacityFor(state, c.hostId, request.pool, ctx.settings, c.device))) reasons.push("no free slot");
        if (devices.some(c => c.hostId === request.hostId && c.device === undefined) && !poolGateOpen(host(request.hostId).gate, settings, request.pool)) reasons.push("gate not open");
        if (settings.grantMode === "manual") reasons.push("manual grant mode");
        const position = sorted(state).filter(r => same(r, request.hostId, request.pool, group(request))).findIndex(r => r.id === request.id) + 1;
        const message = `Request ${request.id} by ${request.threadId} on ${request.hostId}, ${request.pool}: ${request.job}; estimate ${minutes(request.estMs)}, waiting ${minutes(ctx.now - request.createdAt)}, position ${position}: ${reasons.join(" / ")}.`;
        audit("queue-wait", { hostId: request.hostId, pool: request.pool, threadId: request.threadId, requestId: request.id, reason: message });
        observer(request.hostId, "queue-wait", { title: "Request waiting too long", lines: [{ value: request.job }, { label: "Request", value: `\`${request.id}\` · ${request.pool} · \`${request.hostId}\`` }, { label: "Thread", value: `\`${request.threadId}\`` }, { label: "Queue", value: `estimate ${minutes(request.estMs)}, waiting ${minutes(ctx.now - request.createdAt)}, position ${position}` }, { label: "Reasons", value: reasons.join(" / ") }] });
      }
      for (const [hostId, { gate }] of Object.entries(state.hosts)) {
        const settings = settingsFor(ctx.settings, hostId);
        if (gate.latest?.passed !== false || gate.failingSince == null || gate.holdAlerted ||
            ctx.now - gate.failingSince < settings.observerGateHoldMs || !state.requests.some(r => r.hostId === hostId && group(r) === undefined && !poolGateOpen(gate, settings, r.pool))) continue;
        gate.holdAlerted = true;
        const { memFreePct, load1, at } = gate.latest;
        const message = `Gate on ${hostId} failing for ${minutes(ctx.now - gate.failingSince)}: memory free ${memFreePct.toFixed(0)}% (min ${settings.memFreeMinPct.toFixed(0)}%), load ${load1.toFixed(1)} (max ${settings.loadMax.toFixed(1)}), sampled ${new Date(at).toISOString().slice(11, 16)}Z.`;
        audit("gate-hold", { hostId, readings: { memFreePct, load1, at }, reason: message });
        observer(hostId, "gate-hold", { title: "Machine busy too long", lines: [{ value: `Gate failing for ${minutes(ctx.now - gate.failingSince)}.` }, { label: "Host", value: `\`${hostId}\`` }, { label: "Memory free", value: `${memFreePct.toFixed(0)}% (min ${settings.memFreeMinPct.toFixed(0)}%)` }, { label: "Load", value: `${load1.toFixed(1)} (max ${settings.loadMax.toFixed(1)})` }] });
      }
      break;
    }
    case "observer": {
      const settings = settingsFor(ctx.settings, input.hostId);
      const next = settings.observerThreadId;
      audit("observer", { hostId: input.hostId, reason: `${input.previousThreadId ?? "none"} → ${next ?? "none"}; events: ${input.previousEvents.join(",")} → ${settings.observerEvents.join(",")}` });
      if (next) notify(next, "observer", { title: "Observer changed", lines: [{ value: "You are now the Machine Slots observer." }, { label: "Events", value: settings.observerEvents.join(", ") || "no events" }] });
      if (!input.previousEnded && input.previousThreadId && input.previousThreadId !== next) notify(input.previousThreadId, "observer", { title: "Observer changed", lines: [{ value: `Observer handed over to ${input.title ?? "none"}.` }] });
      break;
    }
    case "restored":
      for (const id of Object.keys(state.hosts)) { reset(id); const w = state.hosts[id].watch; if (w) { w.lastEndAt = null; for (const s of Object.values(w.subjects)) { s.intervals = []; s.episode = false; } } }
      for (const l of state.leases) l.idle = { since: null, alerted: false };
      break;
    default: return fail("invalid-input", "Unknown operation");
  }
  for (const old of original.leases.filter(l => l.pool === "heavy")) {
    const current = state.leases.find(l => l.id === old.id);
    if (!current || current.holderThreadId !== old.holderThreadId) { const h = host(old.hostId); h.watch ??= { lastEndAt: null, settings: "", heavyEndAt: {}, subjects: {} }; h.watch.heavyEndAt[old.holderThreadId] = ctx.now; }
  }
  for (const l of state.leases.filter(l => l.pool === "heavy")) {
    const old = original.leases.find(o => o.id === l.id);
    if (!old || old.holderThreadId !== l.holderThreadId) { l.idle = { since: null, alerted: false }; l.holdingSince = ctx.now; }
  }
  if (original.leases.some(l => !state.leases.some(current => current.id === l.id)) || original.requests.some(r => r.pool === "local-model" && !state.requests.some(current => current.id === r.id))) schedule();
  cleanupPorts();
  return { state, effects, result: { ok: true, data: structuredClone(data) } };
}
