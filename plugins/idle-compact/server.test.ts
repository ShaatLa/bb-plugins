import { afterEach, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin, { IDLE_MS, LOG_RETENTION_MS, WARM_MS } from "./server.js";

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
  const emit = (event: "thread.idle" | "thread.active" | "thread.failed") => host.harness.behavior.emitThreadEvent(event, (event === "thread.idle" ? { thread, lastAssistantText: null } : event === "thread.failed" ? { thread, error: null } : { thread }) as any);
  return { host, compact, state, advance, emit, now, setClock: (ms: number) => { clock += ms; } };
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

it("never overlaps a compaction call that has not returned", async () => {
  const h = await setup();
  h.compact.mockImplementationOnce(() => new Promise(() => {}));
  await h.emit("thread.idle"); await h.advance(IDLE_MS);
  h.state.used += 1000; // a later turn grew the context
  await h.emit("thread.idle"); await h.advance(IDLE_MS);
  expect(h.compact).toHaveBeenCalledTimes(1);
});

it("treats the server refusing a thread that is no longer idle as a skip, not retried", async () => {
  const h = await setup();
  h.compact.mockRejectedValueOnce(new Error("Context can only be compacted while the thread is idle or errored"));
  await h.emit("thread.idle"); await h.advance(IDLE_MS);
  await h.emit("thread.idle"); await h.advance(IDLE_MS);
  expect(h.compact).toHaveBeenCalledTimes(1);
});

it.each([
  ["goes idle", "thread.idle", "idle", "claude-code"],
  ["fails", "thread.failed", "error", "claude-code"],
  ["goes idle on another provider", "thread.idle", "idle", "codex"],
] as const)("compacts at once a thread that %s at 80% of its window or more", async (_name, event, status, provider) => {
  const h = await setup({ used: 800_000, status, provider });
  await h.emit(event); await h.advance(0);
  expect(h.compact).toHaveBeenCalledTimes(1);
  await h.advance(IDLE_MS); // the 50-minute check sees the same usage and leaves it
  expect(h.compact).toHaveBeenCalledTimes(1);
});

it("leaves a thread just below 80% of its window (79.95%) until the 50-minute check", async () => {
  const h = await setup({ used: 799_500 });
  await h.emit("thread.idle"); await h.advance(0);
  expect(h.compact).not.toHaveBeenCalled();
  await h.advance(IDLE_MS);
  expect(h.compact).toHaveBeenCalledTimes(1);
});

it("does not compact again on the stop that ends its own compaction, even with usage still high, until a real turn", async () => {
  const h = await setup({ used: 900_000 });
  await h.emit("thread.idle"); await h.advance(0);
  expect(h.compact).toHaveBeenCalledTimes(1);
  await h.emit("thread.active"); h.state.used = 850_000; // the compaction turn, with a new but still high figure
  await h.emit("thread.idle"); await h.advance(IDLE_MS);
  expect(h.compact).toHaveBeenCalledTimes(1);
  await h.emit("thread.active"); h.state.used = 860_000; // a real turn
  await h.emit("thread.idle"); await h.advance(0);
  expect(h.compact).toHaveBeenCalledTimes(2);
});

it("follows the threshold setting, including a change while a check waits on the SDK", async () => {
  const h = await setup({ used: 900_000 });
  await h.host.harness.setSettings({ thresholdPercent: "95" });
  await h.emit("thread.idle"); await h.advance(0);
  expect(h.compact).not.toHaveBeenCalled();
  await h.emit("thread.active"); await h.host.harness.setSettings({ thresholdPercent: "90" });
  let release!: () => void;
  h.state.timeline = new Promise(resolve => { release = resolve; });
  await h.emit("thread.idle"); await h.advance(0);
  await h.host.harness.setSettings({ thresholdPercent: "off" });
  h.state.timeline = null; release(); await h.advance(0);
  expect(h.compact).not.toHaveBeenCalled();
  // Turned off after the usage passed, while the attempt is being recorded: the last check before the call sees it.
  await h.emit("thread.active"); await h.host.harness.setSettings({ thresholdPercent: "90" });
  const kv = h.host.bb.storage.kv, set = kv.set.bind(kv);
  vi.spyOn(kv, "set").mockImplementation(async (key: string, value: unknown) => { if (key.startsWith("own:")) await h.host.harness.setSettings({ thresholdPercent: "off" }); return set(key, value as never); });
  await h.emit("thread.idle"); await h.advance(0);
  expect(h.compact).not.toHaveBeenCalled();
});

it("does not compact when the threshold is raised above the usage while the attempt is recorded", async () => {
  const h = await setup({ used: 850_000 });
  const kv = h.host.bb.storage.kv, set = kv.set.bind(kv);
  vi.spyOn(kv, "set").mockImplementation(async (key: string, value: unknown) => { if (key.startsWith("own:")) await h.host.harness.setSettings({ thresholdPercent: "95" }); return set(key, value as never); });
  await h.emit("thread.idle"); await h.advance(0);
  expect(h.compact).not.toHaveBeenCalled();
});

it("logs the compactions it made for compactions.list, pages them, and prunes entries past 30 days", async () => {
  const h = await setup({ used: 900_000 });
  const list = (input: object) => h.host.harness.behavior.callRpc("compactions.list", input) as Promise<any>;
  const t0 = h.now();
  await h.emit("thread.idle"); await h.advance(0); // at once, over 80% of the window
  await h.emit("thread.active"); h.state.used = 300_000; await h.emit("thread.idle"); // its own compaction turn ends
  await h.emit("thread.active"); await h.emit("thread.idle"); await h.advance(IDLE_MS); // a real turn, then 50 minutes idle
  await h.emit("thread.active"); await h.emit("thread.idle"); // its own compaction turn ends
  // A compaction the server refuses is not logged.
  await h.emit("thread.active"); h.state.used = 310_000; h.compact.mockRejectedValueOnce(new Error("Context can only be compacted while the thread is idle or errored"));
  await h.emit("thread.idle"); await h.advance(IDLE_MS);
  expect(h.compact).toHaveBeenCalledTimes(3);
  const { items, nextCursor } = await list({});
  expect(nextCursor).toBeUndefined();
  expect(items).toEqual([
    { id: `${String(t0).padStart(15, "0")}:thr_a`, threadId: "thr_a", at: t0, trigger: "threshold", usedTokensBefore: 900_000, contextWindow: 1_000_000 },
    expect.objectContaining({ at: t0 + IDLE_MS, trigger: "idle", usedTokensBefore: 300_000 }),
  ]);
  const page = await list({ limit: 1 });
  expect(page).toEqual({ items: [items[0]], nextCursor: items[0].id });
  expect(await list({ after: page.nextCursor })).toEqual({ items: [items[1]] });
  expect(await list({ since: t0 })).toEqual({ items: [items[1]] });
  await expect(list({ limit: 501 })).rejects.toThrow();
  // A compaction 31 days later prunes the older entries.
  await h.emit("thread.active"); h.state.used = 400_000; h.setClock(31 * 86_400_000);
  await h.emit("thread.idle"); await h.advance(IDLE_MS);
  expect((await list({})).items).toEqual([expect.objectContaining({ usedTokensBefore: 400_000, trigger: "idle" })]);
});

it("gives same-millisecond compactions distinct ids in write order, and a read waits for a log write in progress", async () => {
  const h = await setup({ used: 900_000 });
  const list = (input: object) => h.host.harness.behavior.callRpc("compactions.list", input) as Promise<any>;
  const kv = h.host.bb.storage.kv, set = kv.set.bind(kv);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let delayed = false;
  vi.spyOn(kv, "set").mockImplementation(async (key: string, value: unknown) => { if (key.startsWith("log:") && !delayed) { delayed = true; await gate; } return set(key, value as never); });
  const t0 = h.now();
  await h.emit("thread.idle");
  await h.host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_b" } as any), lastAssistantText: null } as any);
  await h.advance(0);
  expect(h.compact).toHaveBeenCalledTimes(2);
  let read: any = null; const pending = list({}).then(result => { read = result; });
  await h.advance(0);
  expect(read).toBeNull(); // the second entry is not visible ahead of the first
  release(); await pending;
  expect(read.items.map((item: any) => [item.threadId, item.at])).toEqual([["thr_a", t0], ["thr_b", t0 + 1]]);
  expect(read.items[0].id < read.items[1].id).toBe(true);
  expect(await list({ after: read.items[0].id })).toEqual({ items: [read.items[1]] });
  expect(await list({ since: t0 - 1, after: read.items[0].id })).toEqual({ items: [read.items[1]] });
  expect(await list({ since: t0 + 1, after: read.items[0].id })).toEqual({ items: [] });
});

it("keeps an entry exactly 30 days old, hides and prunes older ones, 20 per write", async () => {
  const h = await setup({ used: 900_000 });
  const list = (input: object) => h.host.harness.behavior.callRpc("compactions.list", input) as Promise<any>;
  const kv = h.host.bb.storage.kv;
  const compactAgain = async (used: number) => {
    await h.emit("thread.active"); await h.emit("thread.idle"); // its own compaction turn ends
    await h.emit("thread.active"); h.state.used = used; await h.emit("thread.idle"); await h.advance(0);
  };
  const t0 = h.now();
  await h.emit("thread.idle"); await h.advance(0);
  h.setClock(LOG_RETENTION_MS); await compactAgain(910_000);
  expect((await list({})).items.map((item: any) => item.at)).toEqual([t0, t0 + LOG_RETENTION_MS]);
  h.setClock(1);
  expect((await list({})).items.map((item: any) => item.at)).toEqual([t0 + LOG_RETENTION_MS]);
  expect(await kv.list("log:")).toHaveLength(2); // hidden, not yet pruned
  for (let i = 1; i <= 25; i++) await kv.set(`log:${String(t0 - i).padStart(15, "0")}:thr_old`, { id: "", threadId: "thr_old", at: t0 - i, trigger: "idle", usedTokensBefore: 1, contextWindow: null });
  await compactAgain(920_000);
  expect(await kv.list("log:")).toHaveLength(2 + 6); // 26 expired, 20 pruned
  await compactAgain(930_000);
  expect(await kv.list("log:")).toHaveLength(3);
});
