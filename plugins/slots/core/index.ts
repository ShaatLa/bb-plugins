import {
  DEFAULT_SETTINGS, OBSERVER_EVENTS, POOLS,
  type AuditEvent, type AuditType, type Context, type Effect, type EngineOutput,
  type ObserverEvent, type GateState, type HostSettings, type Input, type Lease, type LogParams,
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
    Number.isFinite(s.memFreeMinPct) && s.memFreeMinPct >= 0 && s.memFreeMinPct <= 100 &&
    Number.isFinite(s.loadMax) && s.loadMax > 0 &&
    Number.isSafeInteger(s.gateSamples) && s.gateSamples > 0 &&
    Number.isSafeInteger(s.gateIntervalMs) && s.gateIntervalMs > 0 &&
    Number.isSafeInteger(s.leaseTtlMs) && s.leaseTtlMs > 0 &&
    Number.isSafeInteger(s.heartbeatIntervalMs) && s.heartbeatIntervalMs > 0 &&
    s.heartbeatIntervalMs < s.leaseTtlMs &&
    (s.observerThreadId === null || text(s.observerThreadId)) &&
    Array.isArray(s.observerEvents) && s.observerEvents.every(e => OBSERVER_EVENTS.includes(e)) &&
    Number.isSafeInteger(s.observerQueueWaitMs) && s.observerQueueWaitMs > 0 &&
    Number.isSafeInteger(s.observerGateHoldMs) && s.observerGateHoldMs > 0 &&
    (s.grantMode === "auto" || s.grantMode === "manual") &&
    Number.isSafeInteger(s.portRange.from) && Number.isSafeInteger(s.portRange.to) &&
    s.portRange.from >= 1 && s.portRange.to <= 65535 && s.portRange.from <= s.portRange.to;
  return settings && settings.hosts && validHost(settings) && Object.values(settings.hosts).every(validHost)
    ? null : "Invalid settings (capacities, gate thresholds, TTL/heartbeat interval or port range)";
}
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const priority = (value: unknown): value is Priority => value === "urgent" || value === "high" || value === "normal";
const minutes = (ms: number): string => {
  const total = Math.round(ms / 60_000);
  return total < 60 ? `${total}m` : `${Math.floor(total / 60)}h${total % 60 ? ` ${total % 60}m` : ""}`;
};
const rank = { urgent: 0, high: 1, normal: 2 };
const sorted = (state: State) => state.requests.map((request, index) => ({ request, index }))
  .sort((a, b) => rank[a.request.priority] - rank[b.request.priority] ||
    a.request.createdAt - b.request.createdAt || a.index - b.index).map(x => x.request);
const emptyGate = (): GateState => ({ latest: null, streak: 0, lastCountedAt: null, failingSince: null, holdAlerted: false });
export function capacityFor(state: State, hostId: string, pool: (typeof POOLS)[number], settings: Settings): number {
  return settingsFor(settings, hostId).capacities[pool];
}
export function gateOpen(gate: GateState, settings: HostSettings): boolean {
  return gate.latest !== null && gate.latest.passed && gate.streak >= settings.gateSamples;
}
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
export function statusSnapshot(state: State, ctx: Context, hostId?: string): StatusSnapshot {
  const hosts = hostId === undefined ? [...new Set([...Object.keys(state.hosts), ...Object.keys(ctx.settings.hosts)])].sort() : [hostId];
  const queue = sorted(state);
  return structuredClone({
    at: ctx.now,
    pools: hosts.flatMap(host => POOLS.map(pool => ({ hostId: host, pool,
      capacity: capacityFor(state, host, pool, ctx.settings),
      leases: state.leases.filter(l => l.hostId === host && l.pool === pool),
      queue: queue.filter(r => r.hostId === host && r.pool === pool),
    }))),
    gates: Object.fromEntries(hosts.map(host => [host, Object.hasOwn(state.hosts, host) ? state.hosts[host].gate : emptyGate()])),
    ports: state.ports.filter(p => hostId === undefined || p.hostId === hostId),
    audit: logSince(state, { hostId }),
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
  const notify = (threadId: string, reason: AuditType, message: string) => effects.push({ type: "notify", threadId, reason, text: message });
  const observer = (hostId: string, reason: ObserverEvent, message: string, ...recipients: string[]) => {
    const { observerThreadId: id, observerEvents } = settingsFor(ctx.settings, hostId);
    if (id && !recipients.includes(id) && observerEvents.includes(reason)) notify(id, reason, message);
  };
  const fields = (l: Lease) => ({ hostId: l.hostId, pool: l.pool, threadId: l.holderThreadId, requestId: l.requestId, leaseId: l.id });
  const refresh = (l: Lease) => {
    l.lastHeartbeatAt = ctx.now;
    l.expiresAt = ctx.now + Math.max(settingsFor(ctx.settings, l.hostId).leaseTtlMs, l.estMs + 900_000);
    l.warnedAt = null;
  };
  const heartbeat = (id: string) => state.leases.filter(l => l.holderThreadId === id).forEach(refresh);
  const reset = (id: string) => { host(id).gate.streak = 0; host(id).gate.lastCountedAt = null; };
  const cleanupPorts = () => {
    state.ports = state.ports.filter(p => {
      if (state.leases.some(l => l.hostId === p.hostId && l.holderThreadId === p.threadId)) return true;
      audit("port-release", { hostId: p.hostId, threadId: p.threadId, port: p.port });
      return false;
    });
  };
  const free = (l: Lease, type: "release" | "expire" | "revoke", reason: string) => {
    state.leases = state.leases.filter(x => x.id !== l.id);
    audit(type, { ...fields(l), reason });
    const message = `${l.pool} slot ${l.slotIndex}, lease ${l.id}: ${reason}.`;
    notify(l.holderThreadId, type, message);
    if (l.ownerThreadId !== l.holderThreadId) notify(l.ownerThreadId, type, message);
    observer(l.hostId, type, message, l.holderThreadId, l.ownerThreadId);
  };
  const grant = (requestId: string, manual: boolean): Result<Lease> => {
    const request = state.requests.find(r => r.id === requestId);
    if (!request) return { ok: false, error: { code: "not-found", message: "Request not found" } };
    const { hostId, pool } = request;
    const gate = host(hostId).gate;
    if (!gate.latest?.passed || (!manual && !gateOpen(gate, settingsFor(ctx.settings, hostId)))) {
      return { ok: false, error: { code: "gate-closed", message: "Host gate is closed", ...(gate.latest ? { readings: gate.latest } : {}) } };
    }
    const capacity = capacityFor(state, hostId, pool, ctx.settings);
    const leases = state.leases.filter(l => l.hostId === hostId && l.pool === pool);
    let index = 0;
    while (leases.some(l => l.slotIndex === index)) index++;
    if (leases.length >= capacity || index >= capacity) return { ok: false, error: { code: "capacity", message: "Pool is at capacity" } };
    const lease: Lease = { id: `lease-${state.nextId++}`, requestId, hostId, pool, slotIndex: index,
      ownerThreadId: request.threadId, holderThreadId: request.threadId, job: request.job, estMs: request.estMs,
      grantedAt: ctx.now, lastHeartbeatAt: ctx.now, expiresAt: 0, warnedAt: null,
      uses: request.uses, autoRelease: request.autoRelease, graceUntil: request.graceUntil };
    refresh(lease);
    state.leases.push(lease);
    state.requests = state.requests.filter(r => r.id !== requestId);
    reset(hostId);
    audit("grant", { ...fields(lease), manual });
    const message = `Granted ${pool} slot ${index}, lease ${lease.id}: ${lease.job}. Run bb slots gate before each launch; bb slots heartbeat to extend; bb slots release ${lease.id} promptly.`;
    notify(lease.holderThreadId, "grant", message);
    observer(hostId, "grant", message, lease.holderThreadId);
    return { ok: true, data: lease };
  };
  const schedule = (onlyHost?: string) => {
    for (const request of sorted(state)) {
      if ((onlyHost === undefined || request.hostId === onlyHost) && settingsFor(ctx.settings, request.hostId).grantMode === "auto") grant(request.id, false);
    }
  };
  const release = (threadId: string, leaseId?: string, reason = "released", ended = false) => {
    const result = { released: [] as string[], returned: [] as string[], canceled: [] as string[] };
    for (const l of [...state.leases]) {
      if (leaseId !== undefined && l.id !== leaseId) continue;
      if (l.ownerThreadId === threadId) { free(l, "release", reason); result.released.push(l.id); }
      else if (l.holderThreadId === threadId) {
        for (const use of l.uses ?? []) audit("use-dropped", { ...fields(l), reason: use.id });
        l.uses = []; l.holderThreadId = l.ownerThreadId; refresh(l);
        audit("transfer", { ...fields(l), reason: "returned-to-owner" });
        const message = `${l.pool} slot ${l.slotIndex}, lease ${l.id} returned to you: ${l.job}.`;
        notify(l.ownerThreadId, "transfer", message);
        observer(l.hostId, "transfer", message, l.ownerThreadId);
        result.returned.push(l.id);
      }
    }
    if (ended || leaseId === undefined || leaseId.startsWith("req-")) state.requests = state.requests.filter(r => {
      if (r.threadId !== threadId || (leaseId !== undefined && r.id !== leaseId)) return true;
      result.canceled.push(r.id);
      audit("release", { hostId: r.hostId, pool: r.pool, threadId, requestId: r.id, reason });
      observer(r.hostId, "release", `Request ${r.id} (${r.pool}: ${r.job}) by ${threadId}: ${reason}.`);
      return false;
    });
    return result;
  };
  switch (input.type) {
    case "request": {
      if (!text(input.job) || !Number.isSafeInteger(input.estMs) || input.estMs <= 0 ||
          !Number.isSafeInteger(ctx.now + input.estMs + 900_000) ||
          (input.priority !== undefined && !priority(input.priority))) return fail("invalid-input", "Job, positive estimate and valid priority required");
      host(input.hostId);
      const lease = state.leases.find(l => l.hostId === input.hostId && l.pool === input.pool &&
        (l.holderThreadId === input.threadId || l.ownerThreadId === input.threadId));
      heartbeat(input.threadId);
      if (lease) { data = { kind: "leased", lease }; break; }
      const existing = state.requests.find(r => r.hostId === input.hostId && r.pool === input.pool && r.threadId === input.threadId);
      if (existing) { data = { kind: "queued", request: existing }; break; }
      const request = { id: `req-${state.nextId++}`, hostId: input.hostId, pool: input.pool,
        threadId: input.threadId, job: input.job, estMs: input.estMs, priority: input.priority ?? "normal", createdAt: ctx.now };
      state.requests.push(request);
      audit("request", { hostId: request.hostId, pool: request.pool, threadId: request.threadId, requestId: request.id });
      data = { kind: "queued", request }; break;
    }
    case "acquire": {
      if (!text(input.job) || !Number.isSafeInteger(input.estMs) || input.estMs <= 0 ||
          !Number.isSafeInteger(ctx.now + input.estMs + 900_000) ||
          (input.priority !== undefined && !priority(input.priority))) return fail("invalid-input", "Job, positive estimate and valid priority required");
      const lease = state.leases.find(l => l.hostId === input.hostId && l.pool === input.pool && (l.holderThreadId === input.threadId || l.ownerThreadId === input.threadId));
      if (lease && lease.holderThreadId !== input.threadId) return fail("transferred", "Lease is held by another thread");
      let request = state.requests.find(r => r.hostId === input.hostId && r.pool === input.pool && r.threadId === input.threadId);
      if (!lease && !request) {
        request = { id: `req-${state.nextId++}`, hostId: input.hostId, pool: input.pool, threadId: input.threadId,
          job: input.job, estMs: input.estMs, priority: input.priority ?? "normal", createdAt: ctx.now, autoRelease: true };
        state.requests.push(request);
        audit("request", { hostId: request.hostId, pool: request.pool, threadId: request.threadId, requestId: request.id });
      }
      const target = lease ?? request!;
      const use = { id: `use-${state.nextId++}`, threadId: input.threadId, startedAt: ctx.now,
        expiresAt: ctx.now + settingsFor(ctx.settings, input.hostId).heartbeatIntervalMs };
      (target.uses ??= []).push(use); target.graceUntil = null;
      if (lease) { refresh(lease); lease.expiresAt = Math.max(lease.expiresAt, use.expiresAt); data = { kind: "leased", lease, useId: use.id }; }
      else data = { kind: "queued", request: request!, useId: use.id };
      break;
    }
    case "done": case "detach": case "heartbeatUse": {
      const target = [...state.leases, ...state.requests].find(item => item.uses?.some(use => use.id === input.useId));
      if (!target) return fail("not-found", "Use not found");
      const use = target.uses!.find(use => use.id === input.useId)!;
      if (use.threadId !== input.threadId) return fail("forbidden", "Use belongs to another thread");
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
          else if (lease) free(lease, "release", "last use completed");
          else release(input.threadId, target.id, "last use completed");
        }
        if (input.type === "detach") data = { kind: "queued", position: sorted(state).filter(r => r.hostId === target.hostId && r.pool === target.pool).findIndex(r => r.id === target.id) + 1 };
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
      else if (gate.lastCountedAt === null || input.at - gate.lastCountedAt >= settings.gateIntervalMs) {
        gate.streak = Math.min(gate.streak + 1, settings.gateSamples); gate.lastCountedAt = input.at;
      }
      if (passed) schedule(input.hostId);
      data = { passed, open: gateOpen(gate, settings), gate }; break;
    }
    case "gate": {
      heartbeat(input.threadId);
      const gate = host(input.hostId).gate;
      data = { passed: gate.latest?.passed ?? false, open: gateOpen(gate, settingsFor(ctx.settings, input.hostId)), gate }; break;
    }
    case "heartbeat": heartbeat(input.threadId); data = { leases: state.leases.filter(l => l.holderThreadId === input.threadId) }; break;
    case "release": {
      if (input.leaseId !== undefined) {
        const lease = state.leases.find(l => l.id === input.leaseId);
        const request = state.requests.find(r => r.id === input.leaseId);
        if (!lease && !request) return fail("not-found", "Lease or request not found");
        if (request && request.threadId !== input.threadId) return fail("forbidden", "Only requester may cancel");
        if (lease && lease.ownerThreadId !== input.threadId && lease.holderThreadId !== input.threadId) return fail("forbidden", "Only owner or holder may release");
      }
      data = release(input.threadId, input.leaseId); break;
    }
    case "threadEnded": data = release(input.threadId, undefined, input.reason, true); break;
    case "transfer": {
      if (!text(input.toThreadId) || input.toThreadId === input.threadId) return fail("invalid-input", "Transfer needs a different target thread");
      const owned = state.leases.filter(l => l.ownerThreadId === input.threadId && (input.leaseId === undefined || l.id === input.leaseId));
      if (owned.length !== 1) return fail(owned.length ? "invalid-input" : "forbidden", "Specify exactly one lease owned by the caller");
      if (!input.isChild) return fail("forbidden", "Target must be a child of the holder");
      const lease = owned[0];
      if (lease.uses?.length || lease.graceUntil != null) return fail("in-use", "Lease has active uses or grace");
      if (state.leases.some(l => l.id !== lease.id && l.hostId === lease.hostId && l.pool === lease.pool &&
          (l.ownerThreadId === input.toThreadId || l.holderThreadId === input.toThreadId)) ||
          state.requests.some(r => r.hostId === lease.hostId && r.pool === lease.pool && r.threadId === input.toThreadId)) return fail("invalid-input", "Target already has an open request or lease in this pool");
      lease.holderThreadId = input.toThreadId; refresh(lease);
      audit("transfer", { ...fields(lease), reason: `from ${input.threadId}` });
      const message = `${lease.pool} slot ${lease.slotIndex}, lease ${lease.id} transferred to you: ${lease.job}. Run bb slots gate before each launch; bb slots heartbeat to extend; bb slots release ${lease.id} promptly.`;
      notify(lease.holderThreadId, "transfer", message);
      observer(lease.hostId, "transfer", message, lease.holderThreadId);
      data = lease; break;
    }
    case "portLease": {
      if (!state.leases.some(l => l.hostId === input.hostId && l.holderThreadId === input.threadId)) return fail("forbidden", "Port requires a held lease on this host");
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
      if (!text(input.reason)) return fail("invalid-input", "Revocation reason required");
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
      observer(input.hostId, "capacity", `${input.pool} capacity on ${input.hostId} set to ${input.capacity}.`);
      data = { capacity: input.capacity }; break;
    }
    case "tick": {
      for (const target of [...state.requests, ...state.leases]) {
        const expired = (target.uses ?? []).filter(u => ctx.now >= u.expiresAt);
        for (const use of expired) audit("use-expired", { hostId: target.hostId, pool: target.pool, threadId: use.threadId, reason: use.id });
        if (expired.length) target.uses = target.uses!.filter(u => ctx.now < u.expiresAt);
        if (target.autoRelease && !(target.uses?.length) && (expired.length > 0 || (target.graceUntil != null && ctx.now >= target.graceUntil))) {
          if (!expired.length) audit("unclaimed", { hostId: target.hostId, pool: target.pool, reason: target.id });
          if ("holderThreadId" in target) free(target, "release", expired.length ? "use expired" : "unclaimed");
          else release(target.threadId, target.id, expired.length ? "use expired" : "unclaimed");
        }
      }
      for (const lease of [...state.leases]) {
        if (ctx.now >= lease.expiresAt) free(lease, "expire", "expired");
        else if (lease.warnedAt === null && ctx.now >= lease.expiresAt - settingsFor(ctx.settings, lease.hostId).heartbeatIntervalMs) {
          lease.warnedAt = ctx.now; audit("warn", fields(lease));
          const message = `Lease ${lease.id} (${lease.pool}: ${lease.job}) expires at ${new Date(lease.expiresAt).toISOString()}; run bb slots heartbeat to keep it, or bb slots release ${lease.id}.`;
          notify(lease.holderThreadId, "warn", message);
          observer(lease.hostId, "warn", message, lease.holderThreadId);
        }
      }
      schedule();
      for (const request of sorted(state)) {
        const settings = settingsFor(ctx.settings, request.hostId);
        if (request.queueWaitAlerted || ctx.now - request.createdAt < settings.observerQueueWaitMs) continue;
        request.queueWaitAlerted = true;
        const reasons = [];
        if (state.leases.filter(l => l.hostId === request.hostId && l.pool === request.pool).length >= settings.capacities[request.pool]) reasons.push("no free slot");
        if (!gateOpen(host(request.hostId).gate, settings)) reasons.push("gate not open");
        if (settings.grantMode === "manual") reasons.push("manual grant mode");
        const position = sorted(state).filter(r => r.hostId === request.hostId && r.pool === request.pool).findIndex(r => r.id === request.id) + 1;
        const message = `Request ${request.id} by ${request.threadId} on ${request.hostId}, ${request.pool}: ${request.job}; estimate ${minutes(request.estMs)}, waiting ${minutes(ctx.now - request.createdAt)}, position ${position}: ${reasons.join(" / ")}.`;
        audit("queue-wait", { hostId: request.hostId, pool: request.pool, threadId: request.threadId, requestId: request.id, reason: message });
        observer(request.hostId, "queue-wait", message);
      }
      for (const [hostId, { gate }] of Object.entries(state.hosts)) {
        const settings = settingsFor(ctx.settings, hostId);
        if (gate.latest?.passed !== false || gate.failingSince == null || gate.holdAlerted ||
            ctx.now - gate.failingSince < settings.observerGateHoldMs || !state.requests.some(r => r.hostId === hostId)) continue;
        gate.holdAlerted = true;
        const { memFreePct, load1, at } = gate.latest;
        const message = `Gate on ${hostId} failing for ${minutes(ctx.now - gate.failingSince)}: memory free ${memFreePct.toFixed(0)}% (min ${settings.memFreeMinPct.toFixed(0)}%), load ${load1.toFixed(1)} (max ${settings.loadMax.toFixed(1)}), sampled ${new Date(at).toISOString().slice(11, 16)}Z.`;
        audit("gate-hold", { hostId, readings: { memFreePct, load1, at }, reason: message });
        observer(hostId, "gate-hold", message);
      }
      break;
    }
    case "observer": {
      const settings = settingsFor(ctx.settings, input.hostId);
      const next = settings.observerThreadId;
      audit("observer", { hostId: input.hostId, reason: `${input.previousThreadId ?? "none"} → ${next ?? "none"}; events: ${input.previousEvents.join(",")} → ${settings.observerEvents.join(",")}` });
      if (next) notify(next, "observer", `You are now the Machine Slots observer; you will receive: ${settings.observerEvents.join(", ") || "no events"}.`);
      if (!input.previousEnded && input.previousThreadId && input.previousThreadId !== next) notify(input.previousThreadId, "observer", `Observer handed over to ${input.title ?? "none"}.`);
      break;
    }
    case "restored": for (const id of Object.keys(state.hosts)) reset(id); break;
    default: return fail("invalid-input", "Unknown operation");
  }
  cleanupPorts();
  return { state, effects, result: { ok: true, data: structuredClone(data) } };
}
