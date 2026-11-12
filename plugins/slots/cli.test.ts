import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { registerCli } from "./cli.js";
import type { Invoke } from "./server.js";

// Virtual clock: sleeping advances Date.now() instead of waiting.
vi.mock("node:timers/promises", () => ({
  setTimeout: async (ms: number, _value: unknown, opts?: { signal?: AbortSignal }) => {
    if (opts?.signal?.aborted) throw new Error("aborted");
    vi.setSystemTime(Date.now() + ms);
  },
}));
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(0); });
afterEach(() => { vi.useRealTimers(); });

const USE = "use-1", REQ = "req-1";
const queuedOutcome = { kind: "queued", request: { id: REQ }, useId: USE };
const leaseOf = { id: "lease-1", requestId: REQ, uses: [{ id: USE }] };
const queuedView = (uses: { id: string }[] = [{ id: USE }]) => ({ pools: [{ leases: [], queue: [{ id: REQ, uses }] }] });
const args = (timeout: string) => ["acquire", "--pool", "heavy", "--job", "tests", "--est", "1m", "--timeout", timeout];

async function run(ttl: number, timeout: string, status: (elapsed: number) => unknown, extra: Record<string, (p: unknown) => unknown> = {}, signal?: AbortSignal) {
  const host = createFakePluginHost({ pluginId: "slots", sdk: { system: { config: async () => ({ primaryHostId: "local" }) } } });
  const calls: string[] = [];
  const start = Date.now();
  const invoke = vi.fn(async (method: string, params: unknown) => {
    calls.push(method);
    if (extra[method]) return extra[method](params);
    if (method === "acquire") return { ok: true, data: queuedOutcome };
    if (method === "status") return { ok: true, data: { hostSettings: { local: { heartbeatIntervalMs: ttl } }, ...(status(Date.now() - start) as object) } };
    if (method === "heartbeatUse") return { ok: true, data: { kind: "queued", request: { id: REQ }, useId: USE } };
    return { ok: true, data: null };
  });
  registerCli(host.bb, invoke as Invoke);
  const out = await host.harness.behavior.runCli(args(timeout), { threadId: "a", signal });
  await host.harness.lifecycle.dispose();
  return { out, calls, invoke };
}

it.each([[30_000, 30], [600_000, 200], [1_800_000, 600]])("renews a queued use every max(30s, ttl/3) with read-only polls (ttl %i)", async (ttl, renewSec) => {
  const grantAt = 1_200_000;
  const grantedHeartbeat = { ok: true, data: { kind: "leased", lease: leaseOf, useId: USE } };
  let heartbeats = 0;
  const { out, calls } = await run(ttl, "30m", elapsed => elapsed >= grantAt ? { pools: [{ leases: [leaseOf], queue: [] }] } : queuedView(), {
    heartbeatUse: () => (++heartbeats, Date.now() >= grantAt ? grantedHeartbeat : { ok: true, data: { kind: "queued", request: { id: REQ }, useId: USE } }),
  });
  expect(out).toMatchObject({ exitCode: 0, stdout: `use ${USE} lease lease-1 renew ${renewSec}` });
  const polls = calls.filter(c => c === "status").length;
  expect(polls).toBeGreaterThanOrEqual(grantAt / 3000);
  // Renewals every ~renewSec plus the single heartbeat that fetches the grant.
  expect(heartbeats).toBeGreaterThanOrEqual(Math.floor(grantAt / 1000 / (renewSec + 3)));
  expect(heartbeats).toBeLessThanOrEqual(Math.floor(grantAt / 1000 / renewSec) + 1);
  expect(calls.at(-1)).toBe("heartbeatUse");
});

it("does not mutate while queued and the use is alive", async () => {
  const { out, calls } = await run(600_000, "30s", () => queuedView(), { detach: () => ({ ok: true, data: { kind: "queued", position: 2 } }) });
  expect(out.exitCode).toBe(75);
  expect(calls).not.toContain("heartbeatUse");
  expect(calls.at(-1)).toBe("detach");
});

it("fetches the authoritative error when another use on the request expired", async () => {
  const gone = { ok: false, error: { code: "not-found", message: "Use not found" } };
  const { out, invoke } = await run(600_000, "5m", elapsed => queuedView(elapsed >= 9000 ? [{ id: "use-other" }] : [{ id: USE }]), { heartbeatUse: () => gone });
  expect(out).toMatchObject({ exitCode: 1, stdout: "Use not found" });
  expect(invoke.mock.calls.filter(c => c[0] === "heartbeatUse")).toHaveLength(1);
  expect(invoke).toHaveBeenCalledWith("done", { threadId: "a", useId: USE });
});

it("asks heartbeatUse once when the request vanished without a lease", async () => {
  const gone = { ok: false, error: { code: "not-found", message: "Use not found" } };
  const { out, invoke } = await run(600_000, "5m", elapsed => elapsed >= 6000 ? { pools: [{ leases: [], queue: [] }] } : queuedView(), { heartbeatUse: () => gone });
  expect(out.exitCode).toBe(1);
  expect(invoke.mock.calls.filter(c => c[0] === "heartbeatUse")).toHaveLength(1);
});

it("fetches the leased outcome once the grant shows up in status", async () => {
  const leased = { ok: true, data: { kind: "leased", lease: leaseOf, useId: USE } };
  const { out, calls } = await run(600_000, "5m", elapsed => elapsed >= 9000 ? { pools: [{ leases: [leaseOf], queue: [] }] } : queuedView(), { heartbeatUse: () => leased });
  expect(out.exitCode).toBe(0);
  expect(calls.filter(c => c === "heartbeatUse")).toHaveLength(1);
});

it("detaches at the deadline and returns a grant that raced it", async () => {
  const lease = { ok: true, data: { kind: "leased", lease: leaseOf, useId: USE } };
  const { out, calls } = await run(600_000, "10s", () => queuedView(), { detach: () => lease });
  expect(out).toMatchObject({ exitCode: 0, stdout: `use ${USE} lease lease-1 renew 200` });
  expect(calls).not.toContain("heartbeatUse");
});

it("finishes the use when the status poll fails", async () => {
  const failure = { ok: false, error: { code: "internal", message: "boom" } };
  let n = 0;
  const { out, invoke } = await run(600_000, "5m", () => queuedView(), {
    status: () => ++n === 1 ? { ok: true, data: { hostSettings: { local: { heartbeatIntervalMs: 600_000 } }, ...queuedView() } } : failure,
  });
  expect(out).toMatchObject({ exitCode: 1, stdout: "boom" });
  expect(invoke).toHaveBeenCalledWith("done", { threadId: "a", useId: USE });
});

it("cleans up when aborted while waiting", async () => {
  const controller = new AbortController();
  let polls = 0;
  const { out, invoke } = await run(600_000, "5m", () => { if (++polls === 3) controller.abort(); return queuedView(); }, {}, controller.signal);
  expect(out.exitCode).toBe(1);
  expect(invoke).toHaveBeenCalledWith("done", { threadId: "a", useId: USE });
  expect(invoke).not.toHaveBeenCalledWith("detach", expect.anything());
});
