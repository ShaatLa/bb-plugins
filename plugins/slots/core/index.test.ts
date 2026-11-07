import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type Input, type Settings, type Transition } from "../contract.js";
import { apply, initialState, logSince, portCandidates, statusSnapshot, validateSettings } from "./index.js";

const minute = 60_000;
function harness(overrides: Partial<Settings> = {}) {
  let state = initialState();
  let now = 0;
  const settings = { ...structuredClone(DEFAULT_SETTINGS), ...overrides };
  const send = (input: Input): Transition => {
    const result = apply(state, input, { now, settings });
    state = result.state;
    return result;
  };
  const request = (threadId: string, priority: "urgent" | "high" | "normal" = "normal", pool: "heavy" | "local-model" = "heavy", hostId = "h") =>
    send({ type: "request", threadId, hostId, pool, priority, job: `${threadId} tests`, estMs: minute });
  const sample = (memFreePct = 20, load1 = 17.9, hostId = "h") => send({ type: "gateSample", hostId, memFreePct, load1, at: now });
  const open = (hostId = "h") => { sample(50, 1, hostId); now += 15_000; return sample(50, 1, hostId); };
  return { send, request, sample, open, settings, get state() { return state; }, get now() { return now; }, set now(n: number) { now = n; } };
}

describe("Slots deterministic engine", () => {
  it("orders urgent/high/normal then FIFO, preserving idempotent requests and leases", () => {
    const h = harness();
    h.request("n"); h.request("high", "high"); h.request("first", "urgent"); h.request("second", "urgent");
    const nextId = h.state.nextId;
    h.request("first", "normal");
    expect(h.state.nextId).toBe(nextId);
    expect(h.state.requests).toHaveLength(4);
    for (const thread of ["first", "second", "high", "n"]) {
      h.open(); expect(h.state.leases.at(-1)?.holderThreadId).toBe(thread);
    }
    h.now += 100;
    const duplicate = h.request("first");
    expect(duplicate.result).toMatchObject({ ok: true, data: { kind: "leased", lease: { lastHeartbeatAt: h.now } } });
    expect(h.state.leases).toHaveLength(4);
    expect(h.state.leases.map(l => l.slotIndex)).toEqual([0, 1, 2, 3]);
    expect(duplicate.effects).toEqual([]);
  });

  it("counts spaced passing samples, audits fast ones, resets on failure and on every grant", () => {
    const h = harness(); h.request("a"); h.request("b");
    h.sample(); h.now = 14_999; h.sample();
    expect(h.state.hosts.h.gate.streak).toBe(1);
    expect(h.state.audit.filter(e => e.type === "gate")).toHaveLength(2);
    h.now = 15_000; h.sample(19, 1);
    expect(h.state.hosts.h.gate.streak).toBe(0);
    h.sample(50, 18); expect(h.state.hosts.h.gate.streak).toBe(0);
    h.open();
    expect(h.state.leases).toHaveLength(1);
    expect(h.state.hosts.h.gate.streak).toBe(0);
    h.send({ type: "tick" }); expect(h.state.leases).toHaveLength(1);
    h.now += 15_000; h.sample(); expect(h.state.leases).toHaveLength(1);
    h.now += 15_000; h.sample(); expect(h.state.leases).toHaveLength(2);
  });

  it("manual grant bypasses queue and streak but refuses failed/absent metrics and capacity", () => {
    const h = harness({ capacities: { heavy: 1, "local-model": 1 } });
    h.request("first", "urgent"); h.request("second");
    const second = h.state.requests[1].id;
    expect(h.send({ type: "grant", requestId: second }).result).toMatchObject({ ok: false, error: { code: "gate-closed" } });
    h.sample(10, 22);
    expect(h.send({ type: "grant", requestId: second }).result).toMatchObject({ ok: false, error: { readings: { memFreePct: 10, load1: 22 } } });
    h.sample();
    const result = h.send({ type: "grant", requestId: second });
    expect(h.state.leases[0].holderThreadId).toBe("second");
    expect(result.effects).toContainEqual(expect.objectContaining({ type: "audit", event: expect.objectContaining({ type: "grant", manual: true }) }));
    expect(h.send({ type: "grant", requestId: h.state.requests[0].id }).result).toMatchObject({ ok: false, error: { code: "capacity" } });
  });

  it("warns once per heartbeat window, clears warning and expires with holder/observer notifications", () => {
    const h = harness({ observerThreadId: "manager" }); h.request("a");
    const granted = h.open();
    expect(granted.effects.filter(e => e.type === "notify").map(e => e.threadId)).toEqual(["a", "manager"]);
    const firstExpiry = h.state.leases[0].expiresAt;
    h.now = firstExpiry - 10 * minute;
    expect(h.send({ type: "tick" }).effects.filter(e => e.type === "notify" && e.reason === "warn")).toHaveLength(1);
    expect(h.send({ type: "tick" }).effects).toEqual([]);
    h.send({ type: "heartbeat", threadId: "a" }); expect(h.state.leases[0].warnedAt).toBeNull();
    expect(h.state.leases[0].expiresAt).toBe(h.now + 30 * minute);
    h.now = h.state.leases[0].expiresAt - 10 * minute;
    expect(h.send({ type: "tick" }).effects.filter(e => e.type === "notify" && e.reason === "warn")).toHaveLength(1);
    h.now = h.state.leases[0].expiresAt;
    const expiry = h.send({ type: "tick" });
    expect(h.state.leases).toEqual([]);
    expect(expiry.effects.filter(e => e.type === "notify").map(e => e.threadId)).toEqual(["a", "manager"]);
    expect(h.state.audit.at(-1)?.type).toBe("expire");
  });

  it("uses estimate plus 15 minutes for a 60-minute job, including heartbeat extension", () => {
    const h = harness();
    h.send({ type: "request", hostId: "h", threadId: "long", pool: "heavy", job: "long suite", estMs: 60 * minute });
    h.open(); const at = h.now;
    expect(h.state.leases[0].expiresAt).toBe(at + 75 * minute);
    h.now = at + 30 * minute;
    expect(h.send({ type: "tick" }).effects).toEqual([]);
    h.now = at + 65 * minute;
    expect(h.send({ type: "tick" }).effects).toContainEqual(expect.objectContaining({ type: "notify", threadId: "long", reason: "warn" }));
    h.now = at + 75 * minute; h.send({ type: "tick" }); expect(h.state.leases).toEqual([]);
    h.request("other"); h.open();
    h.send({ type: "request", hostId: "h2", threadId: "long", pool: "heavy", job: "long", estMs: 60 * minute });
    h.open("h2"); h.now += minute;
    h.send({ type: "heartbeat", threadId: "long" });
    expect(h.state.leases.find(l => l.hostId === "h2")?.expiresAt).toBe(h.now + 75 * minute);
  });

  it("archive/deletion frees owned leases and cancels queued requests", () => {
    for (const reason of ["archived", "deleted"] as const) {
      const h = harness(); h.request("a"); h.open(); h.request("a", "normal", "local-model");
      const ended = h.send({ type: "threadEnded", threadId: "a", reason });
      expect(h.state.requests).toEqual([]); expect(h.state.leases).toEqual([]);
      expect(ended.result).toMatchObject({ ok: true, data: { released: [expect.any(String)], canceled: [expect.any(String)] } });
    }
  });

  it("transfers only owned leases to children; child release/end returns and owner end frees", () => {
    for (const end of [false, true]) {
      const h = harness(); h.request("owner"); h.open(); const id = h.state.leases[0].id;
      expect(h.send({ type: "transfer", threadId: "owner", toThreadId: "owner", isChild: true }).result.ok).toBe(false);
      expect(h.send({ type: "transfer", threadId: "owner", toThreadId: "child", isChild: false }).result.ok).toBe(false);
      h.send({ type: "transfer", threadId: "owner", toThreadId: "child", isChild: true });
      h.request("child"); h.request("owner"); expect(h.state.requests).toEqual([]);
      expect(h.send({ type: "transfer", threadId: "child", toThreadId: "grandchild", isChild: true }).result.ok).toBe(false);
      expect(h.send({ type: "release", threadId: "stranger", leaseId: id }).result.ok).toBe(false);
      const returned = end ? h.send({ type: "threadEnded", threadId: "child", reason: "archived" }) : h.send({ type: "release", threadId: "child" });
      expect(h.state.leases[0].holderThreadId).toBe("owner");
      expect(returned.effects).toContainEqual(expect.objectContaining({ type: "notify", threadId: "owner", reason: "transfer" }));
      h.send({ type: "transfer", threadId: "owner", toThreadId: "child", isChild: true });
      const freed = h.send({ type: "threadEnded", threadId: "owner", reason: "deleted" });
      expect(h.state.leases).toEqual([]);
      expect(freed.effects).toContainEqual(expect.objectContaining({ type: "notify", threadId: "child" }));
    }
  });

  it("preserves live leases on capacity reduction, raises immediately, uses lowest free index", () => {
    const h = harness(); h.request("a"); h.request("b"); h.open(); h.open();
    h.send({ type: "setCapacity", hostId: "h", pool: "heavy", capacity: 1 });
    expect(h.state.leases).toHaveLength(2);
    h.request("c"); h.open(); expect(h.state.leases).toHaveLength(2);
    h.send({ type: "setCapacity", hostId: "h", pool: "heavy", capacity: 3 });
    h.send({ type: "tick" }); expect(h.state.leases).toHaveLength(3);
    expect(h.state.leases[2].slotIndex).toBe(2);
    h.send({ type: "release", threadId: "a" }); h.request("d"); h.open();
    expect(h.state.leases.at(-1)?.slotIndex).toBe(0);
  });

  it("leases ports per host, excludes collisions, is idempotent, and keeps until last held lease", () => {
    const h = harness({ portRange: { from: 42000, to: 42001 } });
    expect(h.send({ type: "portLease", hostId: "h", threadId: "a", port: 42000 }).result.ok).toBe(false);
    h.request("a"); h.request("b"); h.open(); h.open();
    h.request("a", "normal", "local-model"); h.open();
    h.send({ type: "portLease", hostId: "h", threadId: "a", port: 42000 });
    h.now += minute;
    expect(h.send({ type: "portLease", hostId: "h", threadId: "a", port: 42001 }).result).toMatchObject({ ok: true, data: { port: 42000 } });
    expect(h.state.leases.filter(l => l.holderThreadId === "a").every(l => l.lastHeartbeatAt === h.now)).toBe(true);
    expect(h.send({ type: "portLease", hostId: "h", threadId: "b", port: 42000 }).result).toMatchObject({ ok: false, error: { code: "port-in-use" } });
    expect(portCandidates(h.state, "h", h.settings)).toEqual([42001]);
    expect(portCandidates(h.state, "other", h.settings)).toEqual([42000, 42001]);
    const id = h.state.leases.find(l => l.holderThreadId === "a")!.id;
    h.send({ type: "release", threadId: "a", leaseId: id }); expect(h.state.ports).toHaveLength(1);
    h.send({ type: "release", threadId: "a" }); expect(h.state.ports).toEqual([]);
    expect(h.state.audit.at(-1)?.type).toBe("port-release");
  });

  it("cleans ports after expiry, revoke, archive and transfer away from the last lease", () => {
    for (const action of ["expire", "revoke", "archive", "transfer"] as const) {
      const h = harness(); h.request("a"); h.open();
      h.send({ type: "portLease", hostId: "h", threadId: "a", port: 41000 });
      const lease = h.state.leases[0];
      if (action === "expire") { h.now = lease.expiresAt; h.send({ type: "tick" }); }
      if (action === "revoke") h.send({ type: "revoke", leaseId: lease.id, reason: "needed" });
      if (action === "archive") h.send({ type: "threadEnded", threadId: "a", reason: "archived" });
      if (action === "transfer") h.send({ type: "transfer", threadId: "a", toThreadId: "child", isChild: true });
      expect(h.state.ports).toEqual([]);
    }
  });

  it("manual mode never auto-grants and local-model uses the same host gate", () => {
    const h = harness({ grantMode: "manual" }); h.request("a", "normal", "local-model"); h.open(); h.send({ type: "tick" });
    expect(h.state.leases).toEqual([]);
    h.send({ type: "grant", requestId: h.state.requests[0].id }); expect(h.state.leases[0].pool).toBe("local-model");
    const auto = harness(); auto.request("a", "normal", "local-model"); auto.request("b"); auto.open();
    expect(auto.state.leases).toHaveLength(1); expect(auto.state.hosts.h.gate.streak).toBe(0);
    auto.open(); expect(auto.state.leases).toHaveLength(2);
  });

  it("restore retains leases and ports but requires fresh samples", () => {
    const h = harness(); h.request("a"); h.open(); h.open();
    h.send({ type: "portLease", hostId: "h", threadId: "a", port: 41000 });
    const old = structuredClone(h.state);
    h.send({ type: "restored" });
    expect(h.state.leases).toEqual(old.leases); expect(h.state.ports).toEqual(old.ports);
    expect(h.state.hosts.h.gate.streak).toBe(0);
    h.request("b"); h.send({ type: "tick" }); expect(h.state.leases).toHaveLength(1);
    h.open(); expect(h.state.leases).toHaveLength(2);
  });

  it("prioritize keeps timestamps; queries are isolated JSON and audit tail is bounded", () => {
    const h = harness(); h.request("a"); h.now = 5; h.request("b");
    const id = h.state.requests[1].id;
    h.send({ type: "prioritize", requestId: id, priority: "urgent" });
    const snapshot = statusSnapshot(h.state, { now: h.now, settings: h.settings });
    expect(snapshot.pools[0].queue[0]).toMatchObject({ id, createdAt: 5 });
    snapshot.pools[0].queue[0].job = "changed"; expect(h.state.requests[1].job).toBe("b tests");
    h.open(); expect(h.state.leases[0].holderThreadId).toBe("b");
    h.now += minute; h.send({ type: "gate", threadId: "b", hostId: "h" });
    expect(h.state.leases[0].lastHeartbeatAt).toBe(h.now);
    for (let i = 0; i < 55; i++) h.sample(1, 30);
    expect(h.state.audit).toHaveLength(50);
    expect(logSince(h.state, { since: h.now, limit: 2 })).toHaveLength(2);
    expect(logSince(h.state, { since: h.now + 1 })).toEqual([]);
    expect(logSince(h.state, { limit: 0 })).toEqual([]);
    expect(JSON.parse(JSON.stringify(h.state))).toEqual(h.state);
  });

  it("does not mutate inputs, isolates hosts, and rejects invalid values transactionally", () => {
    const h = harness(); const before = structuredClone(h.state);
    h.request("a"); expect(before).toEqual(initialState());
    const state = structuredClone(h.state);
    const first = apply(state, { type: "tick" }, { now: h.now, settings: h.settings });
    expect(apply(state, { type: "tick" }, { now: h.now, settings: h.settings })).toEqual(first);
    expect(state).toEqual(h.state);
    for (const input of [
      { type: "request", hostId: "h", pool: "unknown", threadId: "b", job: "j", estMs: 1 },
      { type: "request", hostId: "h", pool: "heavy", threadId: "b", job: "", estMs: 1 },
      { type: "request", hostId: "h", pool: "heavy", threadId: "b", job: "j", estMs: -1 },
      { type: "setCapacity", hostId: "h", pool: "heavy", capacity: -1 },
      { type: "gateSample", hostId: "h", memFreePct: 101, load1: 0, at: 0 },
    ]) {
      const result = h.send(input as Input);
      expect(result.result.ok).toBe(false); expect(result.effects).toEqual([]); expect(h.state).toEqual(state);
    }
    h.request("a", "normal", "heavy", "h2"); h.open("h2");
    expect(h.state.leases.map(l => l.hostId)).toEqual(["h2"]);
    expect(h.state.requests[0].hostId).toBe("h");
    expect(validateSettings({ ...h.settings, heartbeatIntervalMs: h.settings.leaseTtlMs })).toBeTypeOf("string");
    h.settings.hosts.h = { ...structuredClone(DEFAULT_SETTINGS), capacities: { heavy: 0, "local-model": 1 } };
    h.open(); expect(h.state.leases.filter(l => l.hostId === "h")).toEqual([]);
  });
});
