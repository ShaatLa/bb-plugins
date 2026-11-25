import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeHostResponse, makeThreadResponse, experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { register, formatNotification } from "./server.js";
import { DiskStore, parseMemoryPressure, parseMeminfo, parseSince, probePort } from "./runtime.js";
import { DEFAULT_SETTINGS, SLOTS_CHANGED, type StatusView, type Result, type RequestOutcome } from "./contract.js";
import { stateSchema } from "./schemas.js";
import type { RawPresence } from "./presence.js";
import { registerCli, renderResult } from "./cli.js";
import type { Invoke } from "./server.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup(dir?: string, machine = { cores: 18, totalMemory: 64 * 1024 ** 3 }, storedConfig?: Record<string, number | string>) {
  const path = dir ?? await mkdtemp(join(tmpdir(), "slots-test-"));
  if (!dir) cleanups.push(() => rm(path, { recursive: true, force: true }));
  if (storedConfig) await new DiskStore(path).saveConfig(storedConfig);
  let now = Date.parse("2026-11-07T12:00:00Z");
  const threads = new Map(["a", "b", "child"].map(id => [id, makeThreadResponse({ id, title: `Title ${id}`, environmentId: "env", ...(id === "child" ? { parentThreadId: "a" } : {}) })]));
  const send = vi.fn(async () => ({ threadId: "a" }));
  const host = createFakePluginHost({ pluginId: "slots", agentSkillIds: ["slots"], sdk: {
    hosts: { get: async () => ({ ...makeHostResponse({ id: "local", name: "Work laptop" }), connectMachineId: null, threadStorageRootPath: null }) },
    system: { config: async () => ({ primaryHostId: "local" }) },
    environments: { get: async () => ({ hostId: "local" }) },
    threads: { get: async ({ threadId }: { threadId: string }) => {
      const t = threads.get(threadId); if (!t) throw Object.assign(new Error("missing"), { status: 404 }); return t;
    }, send },
  } });
  const metrics = vi.fn(async () => ({ memFreePct: 75, load1: 1 }));
  let mono = 0;
  const presence = vi.fn(async (_hostId: string): Promise<RawPresence> => ({ idleSeconds: 0, displayAsleep: false, media: [], memFreePct: 75, load1: 1, cores: 8 }));
  const runtime = { cores: () => machine.cores, totalMemory: () => machine.totalMemory, store: new DiskStore(path), now: () => now, metrics, presence, monotonic: () => mono };
  const { invoke } = await register(host.bb, runtime);
  cleanups.push(() => host.harness.lifecycle.dispose());
  async function configure(values: Record<string, number | string>) {
    const result = await invoke("settingsWrite", { values });
    if (!result.ok) throw new Error(result.error.message);
  }
  async function view() { const result = await invoke("status", {}); if (!result.ok) throw new Error(result.error.message); return result.data as StatusView; }
  async function request(threadId = "a") {
    return await invoke("request", { threadId, hostId: "local", pool: "heavy", job: "tests", estMs: 60000 }) as Result<RequestOutcome>;
  }
  async function grant(threadId = "a") {
    await request(threadId); await invoke("gate", { threadId, hostId: "local" }); now += 15000; await invoke("gate", { threadId, hostId: "local" });
    return (await view()).pools[0].leases.find(l => l.ownerThreadId === threadId)!;
  }
  /** One sampler pass: probes, samples, tick; resolves once `done` holds. */
  async function samplerPass(done: () => Promise<boolean>) {
    const service = host.harness.behavior.runService("sampler");
    try { await vi.waitFor(async () => expect(await done()).toBe(true)); }
    finally { service.controller.abort(); await service.done; }
  }
  return { ...host, invoke, view, request, grant, threads, send, metrics, presence, samplerPass, path, runtime, configure, advance: (ms: number) => { now += ms; }, advanceMono: (ms: number) => { mono += ms; } };
}
it("parses macOS/Linux memory and duration/ISO log bounds", () => {
  expect(parseMemoryPressure("System-wide memory free percentage: 24%\n")).toBe(24);
  expect(parseMeminfo("MemTotal: 1000 kB\nMemAvailable: 250 kB\n")).toBe(25);
  expect(() => parseMemoryPressure("failed")).toThrow(); expect(() => parseMeminfo("MemTotal: 0 kB")).toThrow();
  expect(parseSince("2h", 10000000)).toBe(2800000);
  expect(parseSince("2026-11-07T12:00:00Z", 0)).toBe(Date.parse("2026-11-07T12:00:00Z"));
  expect(() => parseSince("oops", 0)).toThrow();
});
it("gate exit code reflects a failed reading and prints thresholds", async () => {
  const h = await setup(); h.metrics.mockRejectedValueOnce(new Error("probe failed"));
  const foreign = await h.harness.behavior.runCli(["release", "--thread", "b", "--json"], { threadId: "a" });
  expect(foreign.exitCode).toBe(1);
  expect(JSON.parse(foreign.stdout)).toMatchObject({ ok: false, error: { code: "forbidden" } });
  const gate = await h.harness.behavior.runCli(["gate", "--json"], { threadId: "a" });
  expect(gate.exitCode).toBe(1); expect(JSON.parse(gate.stdout!)).toMatchObject({ ok: true, data: { passed: false, thresholds: { local: { loadMax: 18 } } } });
  expect(renderResult("gate", { ok: true, data: { passed: true } }, true).exitCode).toBe(0);
});
it("serializes concurrent idempotent requests, persists and restores after a liveness recheck", async () => {
  const h = await setup(); await Promise.all([h.request(), h.request()]); expect((await h.view()).pools[0].queue).toHaveLength(1);
  const lease = await h.grant();
  expect(JSON.parse(await readFile(join(h.path, "state.json"), "utf8")).leases[0].id).toBe(lease.id);
  const restored = await setup(h.path);
  expect((await restored.view()).pools[0].leases[0].id).toBe(lease.id);
  expect((await restored.view()).gates.local.streak).toBe(0);
  await restored.harness.lifecycle.dispose();
  const gone = await setup(h.path); gone.threads.delete("a");
  expect((await gone.view()).pools[0].leases).toEqual([]);
});
it("archives release leases, cancel queues, and grant/warning notifications wake threads", async () => {
  const h = await setup(); const lease = await h.grant();
  expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ threadId: "a", mode: "queue-if-active", originPluginId: "slots", input: [expect.objectContaining({ text: expect.stringMatching(/^\[bb message from plugin:slots\]\n\n[\s\S]*bb slots wrapper/) })] }));
  h.advance(1200000);
  // The service heartbeats active holders only; idle holders get the warning.
  const service = h.harness.behavior.runService("sampler");
  await vi.waitFor(() => expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ input: [expect.objectContaining({ text: expect.stringContaining("bb slots heartbeat` to keep it") })], mode: "auto" })));
  service.controller.abort(); await service.done;
  const event = await h.harness.behavior.emitThreadEvent("thread.archived", { thread: h.threads.get("a")! });
  expect(event.errors).toEqual([]); expect((await h.view()).pools[0].leases).toEqual([]);
  expect(h.harness.inspection.realtimeSignals).toContainEqual(expect.objectContaining({ channel: SLOTS_CHANGED }));
  const logs = await h.invoke("log", { limit: 100 }); expect(JSON.stringify(logs)).toContain(lease.id);
});
it("transfer checks the child's parent; active events heartbeat the holder", async () => {
  const h = await setup(); const lease = await h.grant();
  expect((await h.invoke("transfer", { threadId: "a", toThreadId: "b" })).ok).toBe(false);
  expect((await h.invoke("transfer", { threadId: "a", toThreadId: "child" })).ok).toBe(true);
  h.advance(10000); await h.harness.behavior.emitThreadEvent("thread.active", { thread: h.threads.get("child")! });
  expect((await h.view()).pools[0].leases[0].lastHeartbeatAt).toBe(lease.lastHeartbeatAt + 10000);
  await h.invoke("release", { threadId: "child" }); expect((await h.view()).pools[0].leases[0].holderThreadId).toBe("a");
});
it("persists capacity in settings, rejects remote callers and validates RPC/tool inputs", async () => {
  const h = await setup(); await h.grant();
  expect((await h.invoke("setCapacity", { hostId: "local", pool: "heavy", capacity: 0 })).ok).toBe(true);
  expect((await h.view()).pools[0]).toMatchObject({ capacity: 0, leases: [expect.anything()] });
  expect(JSON.parse(await readFile(join(h.path, "state.json"), "utf8")).hosts.local).not.toHaveProperty("capacities");
  h.harness.sdk.stub("environments.get", async () => ({ hostId: "remote" }));
  expect(await h.request("b")).toMatchObject({ ok: false, error: { message: expect.stringContaining("leases only on the BB server host") } });
  await expect(h.harness.behavior.callRpc("request", { pool: "bad" })).rejects.toThrow();
  expect(JSON.parse(await h.harness.behavior.callAgentTool("slots_status", {}) as string)).toMatchObject({ ok: true });
});
it("skips a bound port and probes both loopback families", async () => {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  expect(await probePort(port)).toBe(false);
  const h = await setup();
  await h.configure({ portFrom: port, portTo: Math.min(65535, port + 20) });
  await h.grant(); const result = await h.invoke("port", { threadId: "a", hostId: "local" });
  expect(result).toMatchObject({ ok: true, data: { port: expect.any(Number) } });
  if (result.ok) expect((result.data as { port: number }).port).toBeGreaterThan(port);
});
it("reads retained JSONL with inclusive bounds and removes old daily files", async () => {
  const h = await setup(); await h.request();
  await writeFile(join(h.path, "2026-10-01.jsonl"), "old\n");
  const log = await h.invoke("log", { since: Date.parse("2026-11-07T12:00:00Z"), limit: 1 });
  expect(log).toMatchObject({ ok: true, data: { events: [expect.objectContaining({ type: "request" })] } });
  expect((await h.invoke("log", { since: Date.parse("2026-11-08T12:00:00Z") }))).toMatchObject({ ok: true, data: { events: [] } });
  await expect(readFile(join(h.path, "2026-10-01.jsonl"))).rejects.toThrow();
});
it("CLI timeout keeps queued request and remote-free status stays bounded", async () => {
  const h = await setup();
  const result = await h.harness.behavior.runCli(["request", "--pool", "heavy", "--job", "tests", "--est", "1m", "--wait", "--timeout", "1ms", "--json"], { threadId: "a" });
  expect(result.exitCode).toBe(75); const queue = (await h.view()).pools[0].queue; expect(queue).toHaveLength(1);
  const retry = await h.request();
  expect(retry).toMatchObject({ ok: true, data: { kind: "queued", request: { id: queue[0].id, createdAt: queue[0].createdAt } } });
});
it("resolves a grant at the wait deadline and withdraws on abort", async () => {
  const host = createFakePluginHost({ pluginId: "slots", sdk: { system: { config: async () => ({ primaryHostId: "local" }) } } });
  const lease = { id: "lease-2", requestId: "req-1", pool: "heavy", slotIndex: 0, holderThreadId: "a", job: "tests", expiresAt: 10000 };
  const invoke = vi.fn(async (method: string) => method === "request" ? { ok: true, data: { kind: "queued", request: { id: "req-1" } } } :
    method === "status" ? { ok: true, data: { pools: [{ leases: [lease], queue: [] }] } } : { ok: true, data: {} });
  registerCli(host.bb, invoke as Invoke);
  const args = ["request", "--pool", "heavy", "--job", "tests", "--est", "1m", "--wait", "--timeout", "1ms"];
  expect((await host.harness.behavior.runCli(args, { threadId: "a" })).exitCode).toBe(0);
  const controller = new AbortController(); controller.abort();
  expect((await host.harness.behavior.runCli(args, { threadId: "a", signal: controller.signal })).exitCode).toBe(1);
  expect(invoke).toHaveBeenCalledWith("release", { threadId: "a", leaseId: "req-1" });
  await host.harness.lifecycle.dispose();
});
it("uses public SDK imports only", () => {
  const scan = experimental_scanPublicSdkOnly(import.meta.dirname, { allow: [/^(react|react-dom|@radix-ui\/react-slot|@radix-ui\/react-select|class-variance-authority|clsx|tailwind-merge|@testing-library\/react)$/] });
  expect(scan.violations).toEqual([]); expect(scan.privateDependencies).toEqual([]);
});

it("manual grant preserves the requested order override and notification failures do not roll back", async () => {
  const h = await setup(); const first = await h.request("a"); const second = await h.request("b");
  if (!first.ok || !second.ok || second.data.kind !== "queued") throw new Error("expected queue");
  h.send.mockRejectedValueOnce(new Error("delivery failed"));
  expect(await h.invoke("grant", { requestId: second.data.request.id })).toMatchObject({ ok: true, data: { holderThreadId: "b" } });
  expect((await h.view()).pools[0].queue).toHaveLength(1);
  expect((await h.view()).pools[0].leases).toHaveLength(1);
  expect(h.harness.inspection.logEntries).toContainEqual(expect.objectContaining({ level: "warn", message: expect.stringContaining("notify b failed") }));
});
it("settings reject invalid intervals and restore refuses malformed state", async () => {
  const h = await setup();
  await expect(h.configure({ gateIntervalSeconds: 0 })).rejects.toThrow();
  await expect(h.configure({ heartbeatIntervalMinutes: 30 })).rejects.toThrow("Invalid settings");
  expect((await h.view()).hostSettings.local.heartbeatIntervalMs).toBe(600000);
  await h.harness.lifecycle.dispose();
  await writeFile(join(h.path, "state.json"), JSON.stringify({ version: 1, leases: "broken" }));
  const next = await setup(h.path);
  await expect(next.invoke("status", {})).rejects.toThrow();
});

it("converts typed human-unit settings and capacity updates only their matching field", async () => {
  const h = await setup();
  await h.configure({ heavyCapacity: 6, localModelCapacity: 2, gateIntervalSeconds: 20, leaseTtlMinutes: 45,
    heartbeatIntervalMinutes: 5, observerThreadId: " b ", grantMode: "manual" });
  expect((await h.view()).hostSettings.local).toMatchObject({ capacities: { heavy: 6, "local-model": 2 },
    gateIntervalMs: 20000, leaseTtlMs: 2700000, heartbeatIntervalMs: 300000, observerThreadId: "b", grantMode: "manual", hosts: {} });
  await h.invoke("setCapacity", { hostId: "local", pool: "local-model", capacity: 3 });
  expect((await h.view()).hostSettings.local.capacities).toEqual({ heavy: 6, "local-model": 3 });
  await expect(h.configure({ portFrom: 50000, portTo: 49999 })).rejects.toThrow("Invalid settings");
  expect((await h.view()).hostSettings.local.portRange.from).toBe(41000);
});
it("resolves titles outside the queue in parallel, shares cache entries, expires and invalidates them", async () => {
  const h = await setup(); await h.request("a"); await h.request("b");
  const pending = new Map<string, (thread: ReturnType<typeof makeThreadResponse>) => void>();
  const lookup = vi.fn(({ threadId }: { threadId: string }) => new Promise<ReturnType<typeof makeThreadResponse>>(resolve => pending.set(threadId, resolve)));
  h.harness.sdk.stub("threads.get", lookup);
  const first = h.view();
  await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(2));
  // This mutation completes even while every status title lookup is blocked.
  expect(await h.invoke("setCapacity", { hostId: "local", pool: "heavy", capacity: 5 })).toMatchObject({ ok: true });
  const second = h.view();
  for (const [id, resolve] of pending) resolve(h.threads.get(id)!);
  expect((await first).titles).toEqual({ a: "Title a", b: "Title b" });
  await second; await h.view(); expect(lookup).toHaveBeenCalledTimes(2);
  h.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => {
    lookup.mock.calls.push([{ threadId }]); return makeThreadResponse({ ...h.threads.get(threadId), title: `Updated ${threadId}` });
  });
  await h.harness.behavior.emitThreadEvent("thread.archived", { thread: h.threads.get("a")! });
  expect((await h.view()).titles).toEqual({ a: "Updated a", b: "Title b" });
  expect(lookup).toHaveBeenCalledTimes(3);
  h.advance(60001); expect((await h.view()).titles).toEqual({ a: "Updated a", b: "Updated b" });
  expect(lookup).toHaveBeenCalledTimes(5);
});
it("renders short human CLI output while preserving JSON envelopes", async () => {
  const h = await setup();
  const request = await h.harness.behavior.runCli(["request", "--pool", "heavy", "--job", "full suite", "--est", "5m"], { threadId: "a" });
  expect(request.stdout).toContain("Queued req-"); expect(request.stdout).toContain("estimate 5m");
  const gate = await h.harness.behavior.runCli(["gate"], { threadId: "a" });
  expect(gate.stdout).toBe("PASS memory free 75.0% (min 20%) · load 1.0 (max 18) · streak 1/2 · sampled 12:00:00.000Z");
  await h.grant();
  const status = await h.harness.behavior.runCli(["status"]);
  expect(status.stdout).toContain("heavy · 1/4 slots held · 0 queued"); expect(status.stdout).toContain("Title a");
  const log = await h.harness.behavior.runCli(["log", "--limit", "1"]);
  expect(log.stdout).toContain("2026-11-07T12:00:15.000Z · grant");
  const json = await h.harness.behavior.runCli(["status", "--json"]);
  expect(JSON.parse(json.stdout!)).toMatchObject({ ok: true, data: { titles: { a: "Title a" } } });
});

it("validates and parses comma-separated observer settings, including empty and whitespace", async () => {
  const h = await setup();
  await h.configure({ observerEvents: " grant, warn,grant ", observerQueueWaitMinutes: 3, observerGateHoldMinutes: 2 });
  expect((await h.view()).hostSettings.local).toMatchObject({ observerEvents: ["grant", "warn"], observerQueueWaitMs: 180000, observerGateHoldMs: 120000 });
  await expect(h.configure({ observerEvents: "warn,unknown" })).rejects.toThrow();
  await expect(h.configure({ observerEvents: "warn," })).rejects.toThrow();
  await expect(h.configure({ observerGateHoldMinutes: 0 })).rejects.toThrow();
  await expect(h.configure({ observerQueueWaitMinutes: -1 })).rejects.toThrow();
  await h.configure({ observerEvents: " " });
  expect((await h.view()).hostSettings.local.observerEvents).toEqual([]);
});
it("loads 0.1.0 state with default alert flags and retains leases, ports and queues", async () => {
  const h = await setup(); await h.grant(); await h.request("b"); await h.invoke("port", { threadId: "a", hostId: "local" });
  const saved = JSON.parse(await readFile(join(h.path, "state.json"), "utf8"));
  for (const request of saved.requests) delete request.queueWaitAlerted;
  for (const host of Object.values(saved.hosts) as any[]) { delete host.gate.failingSince; delete host.gate.holdAlerted; }
  const parsed = stateSchema.parse(saved);
  expect(parsed.requests[0].queueWaitAlerted).toBe(false);
  expect(parsed.hosts.local.gate).toMatchObject({ failingSince: null, holdAlerted: false });
  await writeFile(join(h.path, "state.json"), JSON.stringify(saved));
  const restored = await setup(h.path); const view = await restored.view();
  expect(view.pools[0].leases).toHaveLength(1); expect(view.pools[0].queue).toHaveLength(1); expect(view.ports).toHaveLength(1);
});
it("observer CLI and tool show, self, hand over, filter and clear through settings", async () => {
  const h = await setup();
  expect(await h.invoke("observer", {})).toMatchObject({ ok: true, data: { threadId: null, title: null, events: DEFAULT_SETTINGS.observerEvents } });
  const self = await h.harness.behavior.runCli(["observer", "--self", "--events", " warn,expire ", "--json"], { threadId: "a" });
  expect(self.exitCode).toBe(0); expect(JSON.parse(self.stdout!)).toMatchObject({ data: { threadId: "a", title: "Title a", events: ["warn", "expire"] } });
  expect((await h.view()).hostSettings.local.observerThreadId).toBe("a");
  h.send.mockClear();
  const handover = await h.harness.behavior.runCli(["observer", "--thread", "b", "--json"]);
  expect(handover.exitCode).toBe(0);
  expect(h.send).toHaveBeenCalledTimes(2);
  expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ threadId: "b", input: [expect.objectContaining({ text: expect.stringContaining("Events: warn, expire") })] }));
  expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ threadId: "a", input: [expect.objectContaining({ text: expect.stringContaining("Observer handed over to Title b") })] }));
  expect((await h.harness.behavior.runCli(["observer"])).stdout).toContain("b · Title b");
  expect(JSON.parse(await h.harness.behavior.callAgentTool("slots_observer", { self: true }, { threadId: "a" }) as string)).toMatchObject({ ok: true, data: { threadId: "a" } });
  expect(await h.invoke("observer", { events: "" })).toMatchObject({ ok: true, data: { events: [] } });
  expect((await h.harness.behavior.runCli(["observer", "--clear", "--json"])).exitCode).toBe(0);
  expect((await h.view()).hostSettings.local.observerThreadId).toBeNull();
  expect(JSON.stringify(await h.invoke("log", {}))).toContain("observer");
});
it("observer rejects invalid targets, conflicting operations and unknown events", async () => {
  const h = await setup();
  for (const params of [{ toThreadId: "missing" }, { self: true }, { self: true, threadId: "a", clear: true }, { events: "unknown" }])
    expect((await h.invoke("observer", params)).ok).toBe(false);
  h.threads.set("b", makeThreadResponse({ id: "b", archivedAt: Date.parse("2026-11-07T12:00:00Z") }));
  expect((await h.invoke("observer", { toThreadId: "b" })).ok).toBe(false);
  h.harness.sdk.stub("environments.get", async () => ({ hostId: "remote" }));
  expect((await h.invoke("observer", { toThreadId: "a" })).ok).toBe(false);
});
it.each(["thread.archived", "thread.deleted"] as const)("clears and audits an ended observer: %s", async event => {
  const h = await setup(); await h.invoke("observer", { toThreadId: "a" }); h.send.mockClear();
  await h.harness.behavior.emitThreadEvent(event, { thread: h.threads.get("a")! });
  expect(await h.invoke("observer", {})).toMatchObject({ data: { threadId: null } });
  expect(h.send).not.toHaveBeenCalled();
  expect((await h.view()).audit[0]).toMatchObject({ type: "observer", reason: expect.stringContaining("a → none") });
});
it("startup clears a dead configured observer", async () => {
  const h = await setup(undefined, undefined, { observerThreadId: "missing" });
  expect(await h.invoke("observer", {})).toMatchObject({ data: { threadId: null } });
  expect((await h.view()).audit).toContainEqual(expect.objectContaining({ type: "observer", reason: expect.stringContaining("missing → none") }));
});

it("returns the SDK machine display name and tolerates a failed name lookup", async () => {
  const h = await setup();
  expect((await h.view()).localHostName).toBe("Work laptop");
  h.harness.sdk.stub("hosts.get", async () => { throw new Error("offline"); });
  expect((await h.view()).localHostName).toBe("Work laptop");
  h.advance(300001);
  expect((await h.view()).localHostName).toBeNull();
});

it.each([0, 1, 4])("pluralizes CLI capacity and pool status for %s slots", capacity => {
  const noun = capacity === 1 ? "slot" : "slots";
  expect(renderResult("setCapacity", { ok: true, data: { capacity } }, false).stdout).toBe(`Capacity ${capacity} ${noun}`);
  expect(renderResult("status", { ok: true, data: { pools: [{ pool: "heavy", capacity, leases: [], queue: [] }], titles: {} } }, false).stdout)
    .toBe(`heavy · 0/${capacity} ${noun} held · 0 queued`);
});

it.each([
  [18, 64, 4], [8, 128, 2], [32, 32, 2], [1, 4, 1], [0, 0, 1],
])("derives limits from %s cores and %s GiB", async (cores, memoryGiB, capacity) => {
  const h = await setup(undefined, { cores, totalMemory: memoryGiB * 1024 ** 3 });
  expect(await h.view()).toMatchObject({
    hostSettings: { local: { loadMax: Math.max(1, cores), capacities: { heavy: capacity, "local-model": 1 } } }, settingsWarnings: [] });
});

it("keeps explicit values, permits disabled pools, and rejects writes above machine limits", async () => {
  const h = await setup(undefined, { cores: 24, totalMemory: 128 * 1024 ** 3 }, { loadMax: 18, heavyCapacity: 2 });
  expect(await h.view()).toMatchObject({ hostSettings: { local: { loadMax: 18, capacities: { heavy: 2 } } } });
  await expect(h.configure({ loadMax: 25 })).rejects.toThrow("Load limit cannot exceed 24 CPU cores");
  await expect(h.configure({ heavyCapacity: 25 })).rejects.toThrow("Heavy capacity cannot exceed 24 CPU cores");
  expect(await h.invoke("setCapacity", { hostId: "local", pool: "heavy", capacity: 25 })).toMatchObject({ ok: false, error: { message: "Heavy capacity cannot exceed 24 CPU cores" } });
  const cli = await h.harness.behavior.runCli(["capacity", "--pool", "heavy", "25"]);
  expect(cli.exitCode).toBe(1);
  expect(cli.stdout).toContain("Heavy capacity cannot exceed 24 CPU cores");
  expect((await h.view()).hostSettings.local.capacities.heavy).toBe(2);
  await h.configure({ loadMax: 12, heavyCapacity: 0 });
  expect((await h.view()).hostSettings.local).toMatchObject({ loadMax: 12, capacities: { heavy: 0 } });
  await expect(h.configure({ loadMax: 0 })).rejects.toThrow();
});

it.each([false, true])("uses current definition defaults after reload; explicit settings: %s", async explicit => {
  const h = await setup();
  await h.view();
  if (explicit) await h.configure({ loadMax: 18, heavyCapacity: 4 });
  let invoke = h.invoke;
  const replacement = await h.harness.lifecycle.reload(async bb => {
    ({ invoke } = await register(bb, { ...h.runtime, cores: () => 24, totalMemory: () => 128 * 1024 ** 3 }));
  });
  cleanups.push(() => replacement.harness.lifecycle.dispose());
  const result = await invoke("status", {});
  expect(result).toMatchObject({ ok: true, data: { hostSettings: { local: { loadMax: explicit ? 18 : 24, capacities: { heavy: explicit ? 4 : 6 } } } } });
});

it("settings list other bb machines by name, and an empty list when listing fails or times out", async () => {
  const h = await setup();
  h.harness.sdk.stub("hosts.list", async () => [makeHostResponse({ id: "local", name: "Work laptop" }), makeHostResponse({ id: "host_example", name: "Build box", status: "disconnected" })] as never);
  const expected = [{ id: "host_example", name: "Build box", connected: false }];
  expect(await h.invoke("settingsRead", {})).toMatchObject({ ok: true, data: { hosts: expected } });
  expect(await h.invoke("config", { operation: "show" })).toMatchObject({ ok: true, data: { hosts: expected } });
  for (const failing of [() => Promise.reject(new Error("offline")), () => new Promise(() => {})]) {
    const next = await setup();
    next.harness.sdk.stub("hosts.list", failing as never);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const read = next.invoke("settingsRead", {}); await vi.advanceTimersByTimeAsync(10001);
      expect(await read).toMatchObject({ ok: true, data: { hosts: [] } });
    } finally { vi.useRealTimers(); }
  }
});

it("caps local model capacity at 16: maxima, writes, setCapacity, and a stored larger value warns and clamps", async () => {
  const h = await setup(undefined, undefined, { localModelCapacity: 40 });
  expect(await h.view()).toMatchObject({ hostSettings: { local: { capacities: { "local-model": 16 } } }, settingsWarnings: ["Saved local model capacity 40 exceeds 16; using 16."] });
  expect(await h.invoke("settingsRead", {})).toMatchObject({ ok: true, data: { maxima: { localModelCapacity: 16 } } });
  await expect(h.configure({ localModelCapacity: 17 })).rejects.toThrow("Local model capacity cannot exceed 16");
  expect(await h.invoke("setCapacity", { hostId: "local", pool: "local-model", capacity: 17 })).toMatchObject({ ok: false });
  expect(await h.invoke("setCapacity", { hostId: "local", pool: "local-model", capacity: 16 })).toMatchObject({ ok: true });
});

it("clamps saved values on smaller machines and surfaces warnings without rewriting them", async () => {
  const h = await setup(undefined, { cores: 8, totalMemory: 32 * 1024 ** 3 }, { loadMax: 18, heavyCapacity: 12 });
  expect(await h.view()).toMatchObject({
    hostSettings: { local: { loadMax: 8, capacities: { heavy: 8 } } }, settingsWarnings: [
      "Saved load limit 18 exceeds 8 CPU cores; using 8.", "Saved heavy capacity 12 exceeds 8 CPU cores; using 8.",
    ] });
  expect((await h.harness.behavior.runCli(["status"])).stdout).toContain("Warning: Saved load limit 18 exceeds 8 CPU cores; using 8.");
  let invoke = h.invoke;
  const replacement = await h.harness.lifecycle.reload(async bb => {
    ({ invoke } = await register(bb, { ...h.runtime, cores: () => 24 }));
  });
  cleanups.push(() => replacement.harness.lifecycle.dispose());
  expect(await invoke("status", {})).toMatchObject({ ok: true, data: { settingsWarnings: [], hostSettings: { local: { loadMax: 18, capacities: { heavy: 12 } } } } });
});

it("uses the resolved limit in gate CLI and observer hold messages", async () => {
  const h = await setup(undefined, { cores: 6, totalMemory: 64 * 1024 ** 3 });
  await h.configure({ observerThreadId: "b", observerGateHoldMinutes: 1 });
  h.metrics.mockResolvedValue({ memFreePct: 75, load1: 25 });
  await h.request();
  const gate = await h.harness.behavior.runCli(["gate"], { threadId: "a" });
  expect(gate.stdout).toContain("(max 6)");
  h.advance(60000);
  const service = h.harness.behavior.runService("sampler");
  try {
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ threadId: "b", input: [expect.objectContaining({ text: expect.stringContaining("(max 6.0)") })] })));
  } finally { service.controller.abort(); await service.done; }
});

it("settings RPC validates before saving, unsets defaults, and validates observer targets", async () => {
  const h = await setup();
  expect(await h.invoke("settingsRead", {})).toMatchObject({ ok: true, data: { cores: 18, heavyDefault: 4, values: { heavyCapacity: 4 } } });
  expect(await h.invoke("settingsWrite", { values: { ["heavyCapacity"]: 19 } })).toMatchObject({ ok: false });
  expect(await h.invoke("settingsWrite", { values: { ["portFrom"]: 42000 } })).toMatchObject({ ok: false });
  expect(await h.invoke("settingsWrite", { values: { ["heartbeatIntervalMinutes"]: 60 } })).toMatchObject({ ok: false });
  expect(await h.invoke("settingsWrite", { values: { ["grantMode"]: "invalid" } })).toMatchObject({ ok: false });
  expect(await h.invoke("settingsWrite", { values: { ["unknown"]: 1 } })).toMatchObject({ ok: false });
  expect((await h.view()).hostSettings.local.portRange.from).toBe(41000);
  expect(await h.invoke("settingsWrite", { values: { ["heavyCapacity"]: 2 } })).toMatchObject({ ok: true });
  expect(await h.invoke("settingsWrite", { unset: ["heavyCapacity"] })).toMatchObject({ ok: true, data: { values: { heavyCapacity: 4 } } });
  expect(await h.invoke("settingsWrite", { values: { ["observerThreadId"]: "missing" } })).toMatchObject({ ok: false });
  expect(await h.invoke("settingsWrite", { values: { ["observerThreadId"]: "b" } })).toMatchObject({ ok: true });
  expect(await h.invoke("settingsWrite", { values: { ["observerEvents"]: "warn,expire" } })).toMatchObject({ ok: true });
  expect((await h.view()).hostSettings.local).toMatchObject({ observerThreadId: "b", observerEvents: ["warn", "expire"] });
  expect(await h.invoke("settingsWrite", { values: { ["observerThreadId"]: "" } })).toMatchObject({ ok: true });
  let invoke = h.invoke;
  const replacement = await h.harness.lifecycle.reload(async bb => { ({ invoke } = await register(bb, { ...h.runtime, cores: () => 24, totalMemory: () => 128 * 1024 ** 3 })); });
  cleanups.push(() => replacement.harness.lifecycle.dispose());
  expect(await invoke("settingsRead", {})).toMatchObject({ ok: true, data: { values: { heavyCapacity: 6 } } });
});





it("config CLI and tool share validation, unset explicit keys, and preserve config on failed writes", async () => {
  const h = await setup();
  expect((await h.harness.behavior.runCli(["config", "set", "heavyCapacity", "2"])).exitCode).toBe(0);
  expect((await h.harness.behavior.runCli(["config", "show"])).stdout).toContain("heavyCapacity = 2");
  expect((await h.harness.behavior.runCli(["config", "set", "loadMax", "19"])).exitCode).toBe(1);
  expect((await h.harness.behavior.runCli(["config", "set", "portFrom", "42000"])).exitCode).toBe(1);
  expect((await h.harness.behavior.runCli(["config", "set", "unknown", "1"])).exitCode).toBe(1);
  expect((await h.harness.behavior.runCli(["config", "unset", "heavyCapacity", "--json"])).stdout).toContain('"set":false');
  expect((await h.harness.behavior.runCli(["config", "get", "loadMax"])).stdout.trim()).toBe(`loadMax = ${(await h.view()).hostSettings.local.loadMax}`);
  const response = await h.harness.behavior.callAgentTool("slots_config", { operation: "set", key: "loadMax", value: 12 });
  expect(JSON.parse(response as string)).toEqual({ ok: true, data: { key: "loadMax", value: 12, default: expect.any(Number), max: expect.any(Number), set: true } });
  expect(await h.invoke("config", { operation: "get", key: "grantMode" })).toEqual({ ok: true, data: { key: "grantMode", value: "auto", default: "auto", set: false } });
  expect(await h.invoke("config", { operation: "show" })).toMatchObject({ ok: true, data: { values: { loadMax: 12 }, setKeys: ["loadMax"] } });
  vi.spyOn(h.runtime.store, "saveConfig").mockRejectedValueOnce(new Error("disk full"));
  expect(await h.invoke("settingsWrite", { values: { loadMax: 10 } })).toMatchObject({ ok: false });
  expect((await h.view()).hostSettings.local.loadMax).toBe(12);
  expect(JSON.parse(await readFile(join(h.path, "config.json"), "utf8"))).toEqual({ version: 1, values: { loadMax: 12 } });
  expect(h.harness.inspection.realtimeSignals).toContainEqual(expect.objectContaining({ channel: SLOTS_CHANGED }));
});


it("missing config uses defaults without consulting old plugin settings or creating config", async () => {
  const h = await setup();
  const legacyRead = vi.fn(async () => ({ ok: true, values: { observerThreadId: "b", heavyCapacity: 2 } }));
  h.harness.sdk.stub("plugins.getSettings", legacyRead);
  expect(await h.invoke("settingsRead", {})).toMatchObject({ ok: true, data: { setKeys: [], values: { observerThreadId: "", heavyCapacity: 4, loadMax: 18 } } });
  expect(legacyRead).not.toHaveBeenCalled();
  await expect(readFile(join(h.path, "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps observer and explicit overrides from an existing config file on restart", async () => {
  const h = await setup(undefined, undefined, { observerThreadId: "b", heavyCapacity: 2 });
  expect(await h.invoke("observer", {})).toMatchObject({ ok: true, data: { threadId: "b" } });
  let invoke = h.invoke;
  const replacement = await h.harness.lifecycle.reload(async bb => { ({ invoke } = await register(bb, h.runtime)); });
  cleanups.push(() => replacement.harness.lifecycle.dispose());
  expect(await invoke("settingsRead", {})).toMatchObject({ ok: true, data: { values: { observerThreadId: "b", heavyCapacity: 2 }, setKeys: expect.arrayContaining(["heavyCapacity", "observerThreadId"]) } });
});

it("exposes acquire, use heartbeat and done through CLI and RPC", async () => {
  const h = await setup();
  const queued = await h.harness.behavior.runCli(["acquire", "--pool", "heavy", "--job", "test", "--est", "1m", "--timeout", "1ms"], { threadId: "a" });
  expect(queued.exitCode).toBe(75);
  expect((await h.view()).pools[0].queue[0].graceUntil).not.toBeNull();
  const acquired = await h.invoke("acquire", { hostId: "local", pool: "heavy", threadId: "a", job: "test", estMs: 60000 });
  if (!acquired.ok) throw new Error(acquired.error.message);
  const useId = (acquired.data as { useId: string }).useId;
  expect((await h.harness.behavior.runCli(["heartbeat", "--use", useId], { threadId: "b" })).exitCode).toBe(2);
  expect((await h.harness.behavior.runCli(["heartbeat", "--use", useId], { threadId: "a" })).exitCode).toBe(0);
  expect((await h.harness.behavior.runCli(["done", useId], { threadId: "a" })).exitCode).toBe(0);
  expect((await h.view()).pools[0].queue).toHaveLength(0);
});


it("loads 0.3 state and restores active uses", async () => {
  const h = await setup(); await h.request();
  const old = JSON.parse(await readFile(join(h.path, "state.json"), "utf8"));
  expect(stateSchema.parse(old).requests[0]).toMatchObject({ uses: [], autoRelease: false, graceUntil: null });
  await h.invoke("acquire", { hostId: "local", pool: "heavy", threadId: "a", job: "test", estMs: 60000 });
  const restored = await setup(h.path);
  expect((await restored.view()).pools[0].queue[0].uses).toHaveLength(1);
});

it("acquire resolves a grant at its deadline and cleans up on abort", async () => {
  const host = createFakePluginHost({ pluginId: "slots", sdk: { system: { config: async () => ({ primaryHostId: "local" }) } } });
  const lease = { id: "lease-2", requestId: "req-1" };
  const invoke = vi.fn(async (method: string) => {
    if (method === "acquire") return { ok: true, data: { kind: "queued", request: { id: "req-1", hostId: "local" }, useId: "use-3" } };
    if (method === "status") return { ok: true, data: { hostSettings: { other: { heartbeatIntervalMs: 120000 }, local: { heartbeatIntervalMs: 600000 } },
      pools: [{ leases: [], queue: [{ id: "req-1", uses: [{ id: "use-3" }] }] }] } };
    if (method === "heartbeatUse") return { ok: true, data: { kind: "queued", useId: "use-3" } };
    if (method === "detach") return { ok: true, data: { kind: "leased", lease, useId: "use-3" } };
    return { ok: true, data: null };
  });
  registerCli(host.bb, invoke as Invoke);
  const args = ["acquire", "--pool", "heavy", "--job", "tests", "--est", "1m", "--timeout", "1ms"];
  const granted = await host.harness.behavior.runCli(args, { threadId: "a" });
  expect(granted).toMatchObject({ exitCode: 0, stdout: "use use-3 lease lease-2 renew 200" });
  const controller = new AbortController(); controller.abort();
  expect((await host.harness.behavior.runCli(args, { threadId: "a", signal: controller.signal })).exitCode).toBe(1);
  expect(invoke).toHaveBeenCalledWith("done", { threadId: "a", useId: "use-3" });
  await host.harness.lifecycle.dispose();
});
it("withdraws a lease granted concurrently with a request wait abort", async () => {
  const host = createFakePluginHost({ pluginId: "slots", sdk: { system: { config: async () => ({ primaryHostId: "local" }) } } });
  const invoke = vi.fn(async (method: string, params: unknown) => {
    if (method === "request") return { ok: true, data: { kind: "queued", request: { id: "req-1" } } };
    if (method === "status") return { ok: true, data: { pools: [{ leases: [{ id: "lease-2", requestId: "req-1" }], queue: [] }] } };
    if (method === "release" && (params as { leaseId: string }).leaseId === "req-1") return { ok: false, error: { code: "not-found", message: "gone" } };
    return { ok: true, data: {} };
  });
  registerCli(host.bb, invoke as Invoke);
  const controller = new AbortController(); controller.abort();
  await host.harness.behavior.runCli(["request", "--pool", "heavy", "--job", "tests", "--est", "1m", "--wait", "--timeout", "1m"], { threadId: "a", signal: controller.signal });
  expect(invoke).toHaveBeenCalledWith("release", { threadId: "a", leaseId: "lease-2" });
  await host.harness.lifecycle.dispose();
});
it("expires a restored use even when its thread remains active", async () => {
  const h = await setup();
  await h.invoke("acquire", { hostId: "local", pool: "heavy", threadId: "a", job: "test", estMs: 60000 });
  await h.invoke("gate", { hostId: "local", threadId: "a" }); h.advance(15000); await h.invoke("gate", { hostId: "local", threadId: "a" });
  const next = await setup(h.path); next.advance(610000);
  const service = next.harness.behavior.runService("sampler");
  await vi.waitFor(async () => expect((await next.view()).pools[0].leases).toHaveLength(0));
  service.controller.abort(); await service.done;
});
it("prints the wrapper through the CLI", async () => {
  const h = await setup();
  const result = await h.harness.behavior.runCli(["wrapper"], { threadId: "a" });
  expect(result.exitCode).toBe(0); expect(result.stdout).toContain('bb slots acquire');
});

it("validates watch settings, machine defaults/clamp, and preserves explicit 0.3.x observer filters", async () => {
  const h = await setup(undefined, { cores: 2, totalMemory: 8 * 1024 ** 3 }, { observerEvents: "warn,expire", watchCores: 8 });
  expect((await h.view()).hostSettings.local).toMatchObject({ watchPolicy: "warn", watchCores: 2, watchWindowSeconds: 120, idleLeaseMinutes: 30, observerEvents: ["warn", "expire"] });
  const invalid: Record<string, string | number>[] = [{watchPolicy:"pause"},{watchCores:0},{watchCores:3},{watchWindowSeconds:59},{watchWindowSeconds:901},{idleLeaseMinutes:9},{idleLeaseMinutes:241}];
  for (const values of invalid) await expect(h.configure(values)).rejects.toThrow();
  await h.configure({ watchPolicy: "off", watchWindowSeconds: 60, idleLeaseMinutes: 10 });
  expect(JSON.parse(await readFile(join(h.path, "config.json"), "utf8")).values).toMatchObject({ watchPolicy: "off", watchWindowSeconds: 60, idleLeaseMinutes: 10 });
  expect((await h.invoke("config", {operation:"unset",key:"watchCores"}))).toMatchObject({ok:true,data:{key:"watchCores",value:1,set:false}});
  expect((await h.harness.behavior.runCli(["status","--json"])).stdout).toContain('"average10m"');
});
it("restores 0.3.x leases/config without watch fields and keeps the original config file", async () => {
  const h=await setup(); await h.grant(); await h.configure({observerEvents:"warn"});
  const config=await readFile(join(h.path,"config.json"),"utf8");
  const saved=JSON.parse(await readFile(join(h.path,"state.json"),"utf8"));
  for(const host of Object.values(saved.hosts) as any[]) delete host.watch;
  for(const lease of saved.leases) {delete lease.idle;delete lease.holdingSince;}
  await writeFile(join(h.path,"state.json"),JSON.stringify(saved));
  const restored=await setup(h.path);
  expect((await restored.view()).pools[0].leases).toHaveLength(1);
  expect((await restored.view()).hostSettings.local).toMatchObject({watchPolicy:"warn",watchCores:3,observerEvents:["warn"]});
  expect(await readFile(join(h.path,"config.json"),"utf8")).toBe(config);
});
it("a hung watcher SDK read leaves gate operations and sampler ticks independent", async () => {
  const h=await setup(); await h.view();
  h.harness.sdk.stub("threads.list", ()=>new Promise(()=>{}));
  const watcher=h.harness.behavior.runService("watcher");
  const sampler=h.harness.behavior.runService("sampler");
  const gate=await h.invoke("gate",{threadId:"a",hostId:"local"}); expect(gate.ok).toBe(true);
  await vi.waitFor(()=>expect(h.metrics).toHaveBeenCalled());
  watcher.controller.abort(); sampler.controller.abort(); await Promise.all([watcher.done,sampler.done]);
});
it("watcher initialization errors leave the loop running for recovery", async () => {
  const h=await setup(); let calls=0;
  h.harness.sdk.stub("system.config",async()=>{if(calls++===0) throw new Error("temporary config failure"); return {primaryHostId:"local"};});
  const service=h.harness.behavior.runService("watcher");
  await vi.waitFor(()=>expect(h.harness.logEntries.some(e=>e.message.includes("temporary config failure"))).toBe(true));
  expect((await h.invoke("gate",{threadId:"a",hostId:"local"})).ok).toBe(true);
  service.controller.abort(); await service.done;
});

it("formats structured notifications as short readable Markdown", () => {
  expect(formatNotification({ title: "Idle heavy slot", lines: [{ value: "Tests" }, { label: "Lease", value: "`lease-199` · heavy slot 2" }, { label: "Holder", value: "`thr-a`" }], hint: "Run `bb slots release lease-199`." })).toBe("`Idle heavy slot`\nTests\n- Lease: `lease-199` · heavy slot 2\n- Holder: `thr-a`\nRun `bb slots release lease-199`.");
  expect(formatNotification({ title: "Slot granted", lines: [] })).not.toContain("[Slots]");
});

it("deduplicates restored state and publishes settings-only changes", async () => {
  const h = await setup(); await h.view();
  const save = vi.spyOn(h.runtime.store, "save");
  const before = h.harness.inspection.realtimeSignals.length;
  await h.configure({ loadMax: 10 });
  expect(h.harness.inspection.realtimeSignals.length).toBeGreaterThan(before);
  expect(save).not.toHaveBeenCalled();
  await h.invoke("gate", { threadId: "a", hostId: "local" });
  expect(save).toHaveBeenCalled();
});

it("retries a failed state save and remembers a loaded serialization", async () => {
  const h = await setup(); await h.view();
  const store = h.runtime.store;
  const saved = store.lastSaved;
  await mkdir(join(h.path, "state.json.tmp"));
  await expect(store.save('{"changed":true}')).rejects.toThrow();
  expect(store.lastSaved).toBe(saved);
  await rm(join(h.path, "state.json.tmp"), { recursive: true });
  await store.save('{"changed":true}');
  const restored = new DiskStore(h.path); await restored.load();
  expect(restored.lastSaved).toBe('{"changed":true}');
});


it("caches the host name and initializes before a host-requiring tool", async () => {
  const h = await setup();
  const get = vi.fn(async () => ({ ...makeHostResponse({ id: "local", name: "Work laptop" }), connectMachineId: null, threadStorageRootPath: null }));
  h.harness.sdk.stub("hosts.get", get);
  const result = JSON.parse(await h.harness.behavior.callAgentTool("slots_gate", {}, { threadId: "a" }) as string);
  expect(result.ok).toBe(true);
  for (let i = 0; i < 10; i++) await h.view();
  expect(get).toHaveBeenCalledTimes(1);
});

it("times out a hung lookup without ending the lease or applying a late result", async () => {
  const h = await setup(); await h.grant();
  let finish!: (value: ReturnType<typeof makeThreadResponse>) => void;
  h.harness.sdk.stub("threads.get", () => new Promise(resolve => { finish = resolve; }));
  vi.useFakeTimers();
  try {
    const pending = h.invoke("release", { threadId: "a" });
    await vi.advanceTimersByTimeAsync(10001);
    expect(await pending).toMatchObject({ ok: false, error: { message: expect.stringContaining("timed out") } });
    finish(makeThreadResponse({ id: "a", environmentId: "env" }));
    await Promise.resolve();
  } finally { vi.useRealTimers(); }
  h.harness.sdk.stub("threads.get", async () => h.threads.get("a")!);
  expect((await h.view()).pools[0].leases).toHaveLength(1);
});

it("throttles active holder heartbeats across sampler ticks", async () => {
  const h = await setup(); const lease = await h.grant();
  const get = vi.fn(async () => makeThreadResponse({ id: "a", environmentId: "env", status: "active" }));
  h.harness.sdk.stub("threads.get", get);
  for (let i = 1; i <= 8; i++) {
    h.advance(15000); const count = h.metrics.mock.calls.length;
    const service = h.harness.behavior.runService("sampler");
    try { await vi.waitFor(() => expect(h.metrics.mock.calls.length).toBeGreaterThan(count)); }
    finally { service.controller.abort(); await service.done; }
    expect(get).toHaveBeenCalledTimes(Math.floor(i / 4));
  }
  expect((await h.view()).pools[0].leases[0].lastHeartbeatAt).toBe(lease.lastHeartbeatAt + 120000);
});

it("keeps active holders ahead of the 30 minute TTL and 29 minute warning boundary", async () => {
  const h = await setup(); await h.configure({ leaseTtlMinutes: 30, heartbeatIntervalMinutes: 29 });
  await h.grant(); h.send.mockClear();
  h.harness.sdk.stub("threads.get", async () => makeThreadResponse({ id: "a", environmentId: "env", status: "active" }));
  for (let i = 0; i < 12; i++) {
    h.advance(15000); const count = h.metrics.mock.calls.length;
    const service = h.harness.behavior.runService("sampler");
    try { await vi.waitFor(() => expect(h.metrics.mock.calls.length).toBeGreaterThan(count)); }
    finally { service.controller.abort(); await service.done; }
  }
  const lease = (await h.view()).pools[0].leases[0];
  expect(lease.warnedAt).toBeNull();
  expect(h.send).not.toHaveBeenCalledWith(expect.objectContaining({ input: [expect.objectContaining({ text: expect.stringContaining("to keep it") })] }));
});

it("continues the sampler after a holder lookup times out without late mutation", async () => {
  const h = await setup(); await h.grant(); h.advance(60000);
  let finish!: (thread: ReturnType<typeof makeThreadResponse>) => void;
  const get = vi.fn(() => new Promise<ReturnType<typeof makeThreadResponse>>(resolve => { finish = resolve; }));
  const prune = vi.spyOn(h.runtime.store, "prune"); h.metrics.mockClear();
  h.harness.sdk.stub("threads.get", get);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const service = h.harness.behavior.runService("sampler");
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10001);
    h.harness.sdk.stub("threads.get", async () => h.threads.get("a")!);
    // Queue a read behind the sampler: it completes only after tick and sample.
    const view = await h.view();
    expect(view.pools[0].leases).toHaveLength(1);
    expect(h.metrics).toHaveBeenCalled();
    expect(prune).toHaveBeenCalled();
    const before = await readFile(join(h.path, "state.json"), "utf8");
    finish(makeThreadResponse({ id: "a", environmentId: "env", status: "active" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await readFile(join(h.path, "state.json"), "utf8")).toBe(before);
  } finally { service.controller.abort(); await service.done; vi.useRealTimers(); }
});

it("uses a short null cache after a host name timeout", async () => {
  const h = await setup(); await h.view(); h.advance(300001); let calls = 0;
  h.harness.sdk.stub("hosts.get", () => { calls++; return calls === 1 ? new Promise(() => {}) : Promise.resolve(makeHostResponse({ id: "local", name: "Recovered" })); });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const pending = h.view(); await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1); await vi.advanceTimersByTimeAsync(10001);
    expect((await pending).localHostName).toBeNull();
    h.advance(29999); expect((await h.view()).localHostName).toBeNull(); expect(calls).toBe(1);
    h.advance(1); expect((await h.view()).localHostName).toBe("Recovered"); expect(calls).toBe(2);
  } finally { vi.useRealTimers(); }
});
it.each([["slots", true], ["someone-else", false]])("a queued notification extends the last queued row when it is ours: %s", async (origin, merges) => {
  const h = await setup();
  const row = { id: "q1", content: [{ type: "text", text: "Earlier notice", mentions: [] }], originPluginId: origin, state: "queued", editable: true, updatedAt: 42 };
  h.harness.sdk.stub("threads.queuedMessages.list", async () => [row] as never);
  h.harness.sdk.stub("threads.queuedMessages.update", async () => row as never);
  await h.grant();
  const update = h.harness.sdk.callsTo("threads.queuedMessages.update") as [{ threadId: string; queuedMessageId: string; expectedUpdatedAt: number; input: { text: string }[] }][];
  if (merges) {
    expect(h.send).not.toHaveBeenCalled();
    expect(update[0][0]).toMatchObject({ threadId: "a", queuedMessageId: "q1", expectedUpdatedAt: 42 });
    expect(update[0][0].input[0].text).toMatch(/^Earlier notice\n\n---\n\n[\s\S]*bb slots wrapper/);
    expect(update[0][0].input[0].text).not.toContain("[bb message from plugin");
  } else {
    expect(update).toEqual([]);
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ threadId: "a", mode: "queue-if-active" }));
  }
});
it("the auto-mode warning stays a plain send even when our row is queued", async () => {
  const h = await setup(); await h.grant(); h.send.mockClear();
  const row = { id: "q1", content: [{ type: "text", text: "Earlier notice", mentions: [] }], originPluginId: "slots", state: "queued", editable: true, updatedAt: 42 };
  h.harness.sdk.stub("threads.queuedMessages.list", async () => [row] as never);
  h.harness.sdk.stub("threads.queuedMessages.update", async () => row as never);
  h.advance(1200000);
  const service = h.harness.behavior.runService("sampler");
  await vi.waitFor(() => expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ mode: "auto" })));
  service.controller.abort(); await service.done;
  expect(h.harness.sdk.callsTo("threads.queuedMessages.update")).toEqual([]);
});

it("registers inference devices over RPC only, persists them, and leases a pinned device from the CLI", async () => {
  const h = await setup();
  expect(await h.harness.behavior.callRpc("devices", {})).toMatchObject({ ok: true, data: { devices: [] } });
  await expect(h.harness.behavior.callRpc("devices", { devices: [{ name: "bad name" }] })).rejects.toThrow();
  expect(await h.harness.behavior.callRpc("devices", { devices: [{ name: "M1" }] })).toEqual({ ok: true, data: { devices: [{ name: "M1", capacity: 1 }] } });
  await expect(h.harness.behavior.callAgentTool("slots_devices", {})).rejects.toThrow();
  const pinned = await h.harness.behavior.runCli(["request", "--pool", "local-model", "--device", "M1", "--job", "ask", "--est", "5m"], { threadId: "a" });
  expect(pinned.stdout).toContain("Granted lease-"); expect(pinned.stdout).toContain("local-model M1 #0");
  const status = await h.harness.behavior.runCli(["status"]);
  expect(status.stdout).toContain("local-model · this Mac · 0/1 slot held"); expect(status.stdout).toContain("local-model · M1 · 1/1 slot held");
  expect(await h.invoke("request", { threadId: "b", hostId: "local", pool: "local-model", job: "ask", estMs: 60000, device: "M1" })).toMatchObject({ ok: true, data: { kind: "queued" } });
  const restored = await setup(h.path);
  expect((await restored.view()).pools.find(p => p.device === "M1")).toMatchObject({ capacity: 1, leases: [{ device: "M1", holderThreadId: "a" }], queue: [{ device: "M1", threadId: "b" }] });
  expect((await restored.view()).audit.find(e => e.type === "grant")).toMatchObject({ device: "M1" });
});

it("lets threads on a configured machine lease its heavy capacity, reports leaseHosts, and spills only on acquire", async () => {
  const h = await setup();
  h.threads.set("remote-child", makeThreadResponse({ id: "remote-child", title: "Remote", environmentId: "env-r" }));
  h.harness.sdk.stub("environments.get", async ({ environmentId }: { environmentId: string }) => ({ hostId: environmentId === "env-r" ? "host_example" : "local" }));
  const heavy = (threadId: string, extra: Record<string, unknown> = {}) => h.invoke("acquire", { threadId, pool: "heavy", job: "suite", estMs: 60000, ...extra }, true);
  expect(await heavy("remote-child")).toMatchObject({ ok: false, error: { message: expect.stringContaining("remoteHosts") } });
  expect((await h.invoke("config", { operation: "set", key: "remoteHosts", value: "host_example=x" })).ok).toBe(false);
  await h.configure({ remoteHosts: "host_example=1", heavyCapacity: 1 });
  expect((await h.view()).leaseHosts).toEqual({ local: { pools: ["heavy", "local-model"], name: "Work laptop", tools: [] }, host_example: { pools: ["heavy"], name: null, tools: [] } });
  await h.samplerPass(async () => (await h.view()).gates.host_example?.latest?.passed === true); // its probe reading opens its check
  // A remote thread leases its own machine at once on a fresh reading; naming another host is refused.
  expect(await heavy("remote-child")).toMatchObject({ ok: true, data: { kind: "leased", lease: { hostId: "host_example" } } });
  expect(await heavy("b", { hostId: "host_example" })).toMatchObject({ ok: false, error: { message: expect.stringContaining("omit hostId") } });
  // local-model from a remote thread uses the server host, where the devices are.
  expect(await h.invoke("request", { threadId: "remote-child", pool: "local-model", job: "ask", estMs: 60000 }, true)).toMatchObject({ ok: true, data: { lease: { hostId: "local" } } }); // granted: the sampler pass read this Mac's memory
  await expect(h.harness.behavior.callRpc("request", { threadId: "a", hostId: "local", pool: "heavy", job: "x", estMs: 60000, spill: true })).rejects.toThrow();
  // capacity --host edits only that machine's entry.
  expect((await h.harness.behavior.runCli(["capacity", "--pool", "heavy", "--host", "host_example", "3"])).exitCode).toBe(0);
  expect((await h.invoke("config", { operation: "get", key: "remoteHosts" }))).toMatchObject({ ok: true, data: { value: "host_example=3" } });
  const status = await h.harness.behavior.runCli(["status"]);
  expect(status.stdout).toContain("heavy · Work laptop · 1/3 slots held"); // the fake names every host "Work laptop"
});

it("reads and writes one project placement field and persists queued constraints", async () => {
  const h = await setup();
  h.harness.sdk.stub("projects.list", async () => [{ id: "proj_example", name: "Example" }]);
  h.threads.set("a", makeThreadResponse({ id: "a", title: "A", environmentId: "env", projectId: "proj_example" }));
  expect(await h.harness.behavior.callRpc("config.get", { projectId: "proj_example", key: "placement" })).toEqual({ placement: "auto" });
  expect(await h.harness.behavior.callRpc("config.set", { projectId: "proj_example", key: "placement", value: "local" })).toEqual({ placement: "local" });
  const result = await h.invoke("acquire", { threadId: "a", pool: "heavy", job: "suite", estMs: 60000, place: "project", needs: ["go"] }, true);
  expect(result).toMatchObject({ ok: true, data: { kind: "queued", request: { place: "local", needs: ["go"] } } });
  const state = stateSchema.parse(JSON.parse(await readFile(join(h.path, "state.json"), "utf8")));
  expect(state.requests[0]).toMatchObject({ place: "local", needs: ["go"] });
  await h.configure({ remoteHosts: "host_example=1", machineTools: "host_example=go,docker" });
  expect((await h.view()).leaseHosts?.host_example.tools).toEqual(["go", "docker"]);
});

it("persists per-machine model settings and changes only the selected with-model capacity", async () => {
  const h = await setup();
  await h.configure({ heavyCapacity: 4, remoteHosts: "host_example=5,host_other=3", deviceHosts: "GPU=host_example", remoteHostsWithModel: "host_other=1", modelHoldMinutes: 45 });
  expect((await h.harness.behavior.runCli(["capacity", "--pool", "heavy", "--host", "host_example", "--with-model", "2"])).exitCode).toBe(0);
  expect(await h.invoke("config", { operation: "get", key: "remoteHostsWithModel" })).toMatchObject({ ok: true, data: { value: "host_other=1,host_example=2" } });
  expect(await h.view()).toMatchObject({ deviceHosts: { GPU: "host_example" }, modelHoldMinutes: 45, hostSettings: { local: { withModel: 4 }, host_example: { withModel: 2 }, host_other: { withModel: 1 } } });
  expect((await h.invoke("config", { operation: "set", key: "deviceHosts", value: "GPU=host_example,GPU=host_other" })).ok).toBe(false);
  expect((await h.harness.behavior.runCli(["capacity", "--pool", "heavy", "--with-model", "0"])).exitCode).toBe(0);
  expect((await h.view()).hostSettings.local.withModel).toBe(0);
});

it("keeps concurrent placement updates for different projects", async () => {
  const h = await setup();
  h.harness.sdk.stub("projects.list", async () => [{ id: "proj_example", name: "Example" }, { id: "proj_other", name: "Other" }]);
  await Promise.all(["proj_example", "proj_other"].map(projectId => h.harness.behavior.callRpc("config.set", { projectId, key: "placement", value: "local" })));
  for (const projectId of ["proj_example", "proj_other"]) expect(await h.harness.behavior.callRpc("config.get", { projectId, key: "placement" })).toEqual({ placement: "local" });
  expect(await h.bb.storage.kv.get("placement-v1")).toEqual({ proj_example: "local", proj_other: "local" });
});

it("probes presence on the sampler tick and grants one extra heavy slot only while away", async () => {
  const h = await setup();
  await h.configure({ heavyCapacity: 1, heavyCapacityAway: 2, gateSamples: 1 });
  const lease = await h.grant("a"); await h.request("b");
  const away = { idleSeconds: 700, displayAsleep: false, media: [], memFreePct: 75, load1: 1, cores: 8 };
  // Media playing: present, no extra.
  h.presence.mockResolvedValue({ ...away, media: ["audio"] }); h.advance(15000);
  await h.samplerPass(async () => (await h.view()).pools[0].presence?.reason === "media playing (audio)");
  expect((await h.view()).pools[0]).toMatchObject({ leases: [{ id: lease.id }], presence: { away: false, extra: 0, media: ["audio"] } });
  expect((await h.harness.behavior.runCli(["status"])).stdout).toContain("Present: media playing (audio)");
  // The probe answers after 6 s: the sample is too old for an extra at grant time.
  h.presence.mockImplementation(async () => { h.advanceMono(6000); return away; }); h.advance(15000);
  await h.samplerPass(async () => (await h.view()).pools[0].presence?.away === true);
  expect((await h.view()).pools[0].leases).toHaveLength(1);
  // A fresh away reading: the tick's pass grants b above the base value.
  h.presence.mockResolvedValue(away); h.advance(15000);
  await h.samplerPass(async () => (await h.view()).pools[0].leases.length === 2);
  expect((await h.view()).pools[0]).toMatchObject({ capacity: 1, presence: { away: true, idleMinutes: 11, extra: 1 } });
  expect((await h.harness.behavior.runCli(["status"])).stdout).toContain("Away 11 min: +1 heavy");
  // Owner back: running leases continue.
  h.presence.mockResolvedValue({ ...away, idleSeconds: 5 }); h.advance(15000);
  await h.samplerPass(async () => (await h.view()).pools[0].presence?.away === false);
  expect((await h.view()).pools[0].leases).toHaveLength(2);
});
it("renews an active holder's expired lease before an away probe's tick can free it", async () => {
  const h = await setup(); await h.configure({ heavyCapacity: 1, heavyCapacityAway: 2, gateSamples: 1 });
  const lease = await h.grant("a");
  h.harness.sdk.stub("threads.get", async () => makeThreadResponse({ id: "a", environmentId: "env", status: "active" }));
  h.presence.mockResolvedValue({ idleSeconds: 700, displayAsleep: false, media: [], memFreePct: 75, load1: 1, cores: 8 });
  h.advance(31 * 60000); // a delayed sampler: the lease is past its 30 minute expiry
  await h.samplerPass(async () => (await h.view()).pools[0].presence?.away === true);
  expect((await h.view()).pools[0].leases).toMatchObject([{ id: lease.id }]);
});
it("schedules an away machine on its own fresh probe while another machine's probe hangs", async () => {
  const h = await setup();
  await h.configure({ heavyCapacity: 1, heavyCapacityAway: 2, gateSamples: 1, remoteHosts: "host_example=2" });
  await h.grant("a"); await h.request("b");
  h.presence.mockImplementation(async hostId => hostId === "local" ? { idleSeconds: 700, displayAsleep: false, media: [], memFreePct: 75, load1: 1, cores: 8 } : new Promise<never>(() => {}));
  h.advance(15000);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const service = h.harness.behavior.runService("sampler");
  try {
    // The remote probe has not timed out yet; this Mac's extra slot is already granted.
    await vi.waitFor(async () => expect((await h.view()).pools[0].leases).toHaveLength(2));
    h.advanceMono(6000); await vi.advanceTimersByTimeAsync(5001);
  } finally { service.controller.abort(); vi.useRealTimers(); await service.done; }
  expect((await h.view()).pools[0]).toMatchObject({ capacity: 1, leases: [{}, {}] });
});
describe("a remote away probe without metrics", () => {
  const away = (metrics: Partial<RawPresence> = {}): RawPresence => ({ idleSeconds: 700, displayAsleep: false, media: [], memFreePct: 75, load1: 1, cores: 8, ...metrics });
  async function remote() {
    const h = await setup();
    for (const id of ["remote-a", "remote-b"]) h.threads.set(id, makeThreadResponse({ id, title: id, environmentId: "env-r" }));
    h.harness.sdk.stub("environments.get", async ({ environmentId }: { environmentId: string }) => ({ hostId: environmentId === "env-r" ? "host_example" : "local" }));
    await h.configure({ remoteHosts: "host_example=1", remoteHostsAway: "host_example=3", gateSamples: 1 });
    const heavy = (threadId: string) => h.invoke("acquire", { threadId, pool: "heavy", job: "suite", estMs: 60000 }, true);
    const pass = () => h.samplerPass(async () => (await h.view()).gates.local?.latest != null && (await h.view()).pools.find(p => p.hostId === "host_example")?.presence?.away === true);
    return { h, heavy, pass, leases: async () => (await h.view()).pools.find(p => p.hostId === "host_example")!.leases.length };
  }
  const noMetrics = (h: Awaited<ReturnType<typeof setup>>) => h.presence.mockImplementation(async hostId => hostId === "local" ? away({ idleSeconds: 0 }) : away({ memFreePct: null, load1: null }));
  it("grants no extra slot with no earlier reading, and base-capacity work still places there", async () => {
    const { h, heavy, pass, leases } = await remote();
    noMetrics(h);
    expect(await heavy("remote-a")).toMatchObject({ ok: true, data: { kind: "leased", lease: { hostId: "host_example" } } });
    expect(await heavy("remote-b")).toMatchObject({ ok: true, data: { kind: "queued" } });
    await pass();
    expect(await leases()).toBe(1);
  });
  it("grants no extra slot on a reading older than a minute", async () => {
    const { h, heavy, pass, leases } = await remote();
    h.presence.mockImplementation(async () => away({ idleSeconds: 0 }));
    await h.samplerPass(async () => (await h.view()).gates.host_example?.latest?.passed === true);
    h.advance(61000);
    noMetrics(h);
    expect(await heavy("remote-a")).toMatchObject({ ok: true, data: { kind: "leased" } });
    expect(await heavy("remote-b")).toMatchObject({ ok: true, data: { kind: "queued" } });
    await pass();
    expect(await leases()).toBe(1);
  });
});
it("a failed or timed-out probe reads present and, after a minute without a reading, leaves another machine working as before", async () => {
  const h = await setup();
  h.threads.set("remote-child", makeThreadResponse({ id: "remote-child", title: "Remote", environmentId: "env-r" }));
  h.harness.sdk.stub("environments.get", async ({ environmentId }: { environmentId: string }) => ({ hostId: environmentId === "env-r" ? "host_example" : "local" }));
  await h.configure({ remoteHosts: "host_example=2", remoteLoadMax: "host_example=4" });
  h.presence.mockImplementation(async hostId => hostId === "local" ? Promise.reject(new Error("probe failed")) : { idleSeconds: 0, displayAsleep: false, media: [], memFreePct: 75, load1: 3, cores: 8 });
  await h.samplerPass(async () => (await h.view()).gates.host_example?.latest?.passed === true);
  expect((await h.view()).pools[0].presence).toMatchObject({ away: false, reason: "presence unknown (probe failed)" });
  expect((await h.view()).hostSettings.host_example).toMatchObject({ loadMax: 4 });
  // The remote probe hangs; the 5 s timeout reads present and adds no reading.
  h.presence.mockImplementation(async hostId => hostId === "local" ? { idleSeconds: 0, displayAsleep: false, media: [], memFreePct: 75, load1: 1, cores: 8 } : new Promise<never>(() => {}));
  h.advance(61000);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const service = h.harness.behavior.runService("sampler");
  try { await vi.advanceTimersByTimeAsync(5001); await vi.advanceTimersByTimeAsync(0); }
  finally { service.controller.abort(); vi.useRealTimers(); await service.done; }
  expect((await h.view()).pools.find(p => p.hostId === "host_example")?.presence).toMatchObject({ away: false, reason: "presence unknown (probe failed)" });
  expect(await h.invoke("acquire", { threadId: "remote-child", pool: "heavy", job: "suite", estMs: 60000 }, true)).toMatchObject({ ok: true, data: { kind: "leased", lease: { hostId: "host_example" } } });
});
it("round-trips the away settings one field at a time", async () => {
  const h = await setup();
  expect(await h.invoke("config", { operation: "get", key: "heavyCapacityAway" })).toMatchObject({ ok: true, data: { value: 4, default: 4, set: false } });
  expect(await h.invoke("config", { operation: "set", key: "heavyCapacityAway", value: "6" })).toMatchObject({ ok: true, data: { value: 6, set: true } });
  expect(await h.invoke("config", { operation: "set", key: "loadMaxAway", value: 19 })).toMatchObject({ ok: false });
  expect(await h.invoke("config", { operation: "set", key: "awayMinutes", value: 15 })).toMatchObject({ ok: true, data: { value: 15 } });
  expect(await h.invoke("config", { operation: "set", key: "remoteLoadMax", value: "host_example=0" })).toMatchObject({ ok: false });
  await h.configure({ remoteHosts: "host_example=2", remoteHostsAway: "host_example=3", remoteLoadMax: "host_example=6", remoteLoadMaxAway: "host_example=9" });
  expect((await h.view()).hostSettings.host_example).toMatchObject({ capacities: { heavy: 2 }, heavyAway: 3, loadMax: 6, loadMaxAway: 9 });
  expect((await h.view()).hostSettings.local).toMatchObject({ heavyAway: 6 });
  expect(await h.invoke("config", { operation: "unset", key: "heavyCapacityAway" })).toMatchObject({ ok: true, data: { value: 4, set: false } });
});
