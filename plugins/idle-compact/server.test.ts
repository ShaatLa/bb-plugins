import { afterEach, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin, { COMPACT_TIMEOUT_MS, IDLE_MS, WARM_MS } from "./server.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.useRealTimers(); });

async function setup({ used = 250_000, provider = "claude-code", status = "idle" } = {}) {
  vi.useFakeTimers();
  let clock = Date.parse("2026-11-14T12:00:00Z");
  const now = () => clock;
  const state = { used, provider, status, timeline: null as Promise<void> | null };
  const compact = vi.fn(async (_input: { threadId: string }): Promise<{ ok: true }> => ({ ok: true }));
  const host = createFakePluginHost({ pluginId: "idle-compact", sdk: { threads: {
    get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: state.status, providerId: state.provider } as any),
    timeline: async () => (await state.timeline, { contextWindowUsage: { usedTokens: state.used, modelContextWindow: 1_000_000, estimated: true } }) as any,
    compact,
  } } as any });
  await plugin(host.bb, now);
  cleanups.push(() => host.harness.lifecycle.dispose());
  const thread = makeThreadResponse({ id: "thr_a" } as any);
  const advance = async (ms: number) => { clock += ms; await vi.advanceTimersByTimeAsync(ms); };
  const emit = (event: "thread.idle" | "thread.active") => host.harness.behavior.emitThreadEvent(event, (event === "thread.idle" ? { thread, lastAssistantText: null } : { thread }) as any);
  return { host, compact, state, advance, emit, setClock: (ms: number) => { clock += ms; } };
}

it("compacts a large Claude Code thread after 50 minutes idle, once", async () => {
  const h = await setup();
  await h.emit("thread.idle");
  await h.advance(IDLE_MS - 1000);
  expect(h.compact).not.toHaveBeenCalled();
  await h.advance(1000);
  expect(h.compact).toHaveBeenCalledWith({ threadId: "thr_a" });
  // Compaction settles the thread idle again; the stale usage figure must not compact it twice.
  await h.emit("thread.idle"); await h.advance(IDLE_MS);
  expect(h.compact).toHaveBeenCalledTimes(1);
});

it("cancels the timer when the thread goes active", async () => {
  const h = await setup();
  await h.emit("thread.idle"); await h.advance(IDLE_MS / 2);
  await h.emit("thread.active"); await h.advance(IDLE_MS);
  expect(h.compact).not.toHaveBeenCalled();
});

it.each([
  ["a small context", { used: 99_999 }],
  ["another provider", { provider: "codex" }],
  ["a thread that is no longer idle", { status: "active" }],
])("leaves %s alone", async (_name, options) => {
  const h = await setup(options);
  await h.emit("thread.idle"); await h.advance(IDLE_MS);
  expect(h.compact).not.toHaveBeenCalled();
});

it("skips a thread exempted with keep, and compacts it again after release", async () => {
  const h = await setup();
  expect((await h.host.harness.behavior.runCli(["keep"], { threadId: "thr_a" } as any)).exitCode).toBe(0);
  expect(JSON.parse((await h.host.harness.behavior.runCli(["status", "--json"])).stdout!)).toMatchObject({ kept: ["thr_a"], minTokens: 100_000 });
  await h.emit("thread.idle"); await h.advance(IDLE_MS);
  expect(h.compact).not.toHaveBeenCalled();
  await h.host.harness.behavior.runCli(["release", "thr_a"]);
  await h.emit("thread.idle"); await h.advance(IDLE_MS);
  expect(h.compact).toHaveBeenCalledTimes(1);
});

it("skips a timer that fires late, after the cache went cold", async () => {
  const h = await setup();
  await h.emit("thread.idle");
  h.setClock(WARM_MS + 60_000); // the machine slept; the clock jumped but the timer had not fired
  await h.advance(IDLE_MS);
  expect(h.compact).not.toHaveBeenCalled();
});

it("reschedules an idle thread after a restart while its cache is still warm", async () => {
  const h = await setup();
  await h.emit("thread.idle"); await h.advance(IDLE_MS / 2);
  await h.host.harness.lifecycle.reload(bb => plugin(bb, () => Date.parse("2026-11-14T12:00:00Z") + IDLE_MS / 2));
  await vi.advanceTimersByTimeAsync(IDLE_MS / 2);
  expect(h.compact).toHaveBeenCalledTimes(1);
});

it("does not compact when the thread goes active while the check waits on the SDK", async () => {
  const h = await setup();
  let release!: () => void;
  h.state.timeline = new Promise(resolve => { release = resolve; });
  await h.emit("thread.idle"); await h.advance(IDLE_MS);
  await h.emit("thread.active");
  release(); await h.advance(0);
  expect(h.compact).not.toHaveBeenCalled();
});

it("does not let a stale check touch a newer idle period", async () => {
  const h = await setup();
  let release!: () => void;
  h.state.timeline = new Promise(resolve => { release = resolve; });
  await h.emit("thread.idle"); await h.advance(IDLE_MS);
  await h.emit("thread.active"); await h.emit("thread.idle");
  h.state.timeline = null; release(); await h.advance(0);
  expect(h.compact).not.toHaveBeenCalled();
  expect(JSON.parse((await h.host.harness.behavior.runCli(["status", "--json"])).stdout!).pending).toHaveProperty("thr_a");
  await h.advance(IDLE_MS);
  expect(h.compact).toHaveBeenCalledTimes(1);
});

it("does not retry a failed compaction on the same usage", async () => {
  const h = await setup();
  h.compact.mockRejectedValueOnce(new Error("boom"));
  await h.emit("thread.idle"); await h.advance(IDLE_MS);
  await h.emit("thread.idle"); await h.advance(IDLE_MS);
  expect(h.compact).toHaveBeenCalledTimes(1);
});

it("never overlaps a compaction that hangs", async () => {
  const h = await setup();
  h.compact.mockImplementationOnce(() => new Promise(() => {}));
  await h.emit("thread.idle"); await h.advance(IDLE_MS + COMPACT_TIMEOUT_MS);
  h.state.used += 1000; // a later turn grew the context
  await h.emit("thread.idle"); await h.advance(IDLE_MS);
  expect(h.compact).toHaveBeenCalledTimes(1);
});
