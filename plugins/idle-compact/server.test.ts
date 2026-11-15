import { afterEach, expect, it, vi } from "vitest";
import { createFakePluginHost, makeMessageDispatchHookContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin, { IDLE_MS, LOG_RETENTION_MS, WARM_MS } from "./server.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.useRealTimers(); });

async function setup({ used = 250_000, provider = "claude-code", status = "idle", seed = [] as readonly (readonly [string, unknown])[] } = {}) {
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
  for (const [key, value] of seed) await host.bb.storage.kv.set(key, value as never);
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
    { id: `${String(t0).padStart(15, "0")}:${String(t0).padStart(15, "0")}:thr_a`, threadId: "thr_a", at: t0, trigger: "threshold", usedTokensBefore: 900_000, contextWindow: 1_000_000 },
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
  h.setClock(5 * 60_000); // a stalled storage write does not move the acceptance time
  release(); await pending;
  expect(read.items.map((item: any) => [item.threadId, item.at])).toEqual([["thr_a", t0], ["thr_b", t0]]);
  expect(read.items[0].id < read.items[1].id).toBe(true);
  expect(await list({ after: read.items[0].id })).toEqual({ items: [read.items[1]] });
  expect(await list({ since: t0 - 1, after: read.items[0].id })).toEqual({ items: [read.items[1]] });
  expect(await list({ since: t0, after: read.items[0].id })).toEqual({ items: [] });
});

it("prunes by the real acceptance time, not the ordering key, after a clock that ran fast", async () => {
  const day = 86_400_000, t0 = Date.parse("2026-11-14T12:00:00Z");
  const pad = (ms: number) => String(ms).padStart(15, "0");
  const entry = (key: number, at: number, threadId: string) => [`log:${pad(key)}:${pad(at)}:${threadId}`, { id: `${pad(key)}:${pad(at)}:${threadId}`, threadId, at, trigger: "idle", usedTokensBefore: 1, contextWindow: null }] as const;
  // Left by an instance whose clock ran 40 days fast, next to an entry 20 days old by the real clock.
  const h = await setup({ used: 900_000, seed: [entry(t0 + 40 * day, t0 + 40 * day, "thr_fast"), entry(t0 - 20 * day, t0 - 20 * day, "thr_old")] });
  const list = () => h.host.harness.behavior.callRpc("compactions.list", {}) as Promise<any>;
  await h.emit("thread.idle"); await h.advance(0);
  const { items } = await list();
  expect(items.map((item: any) => [item.threadId, item.at])).toEqual([["thr_old", t0 - 20 * day], ["thr_fast", t0 + 40 * day], ["thr_a", t0]]);
  // thr_a's ordering key is 40 days ahead; it is still pruned 30 days after its real acceptance.
  h.setClock(30 * day + 1);
  expect((await list()).items.map((item: any) => item.threadId)).toEqual(["thr_fast"]);
  await h.emit("thread.active"); await h.emit("thread.idle"); // its own compaction turn ends
  await h.emit("thread.active"); h.state.used = 910_000; await h.emit("thread.idle"); await h.advance(0);
  expect((await h.host.bb.storage.kv.list("log:")).map(key => key.split(":").at(-1)).sort()).toEqual(["thr_a", "thr_fast"]);
  expect((await list()).items.map((item: any) => [item.threadId, item.at])).toEqual([["thr_fast", t0 + 40 * day], ["thr_a", t0 + 30 * day + 1]]);
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
  for (let i = 1; i <= 25; i++) await kv.set(`log:${String(t0 - i).padStart(15, "0")}:${String(t0 - i).padStart(15, "0")}:thr_old`, { id: "", threadId: "thr_old", at: t0 - i, trigger: "idle", usedTokensBefore: 1, contextWindow: null });
  await compactAgain(920_000);
  expect(await kv.list("log:")).toHaveLength(2 + 6); // 26 expired, 20 pruned
  await compactAgain(930_000);
  expect(await kv.list("log:")).toHaveLength(3);
});

it("compacts from the header button regardless of provider, settings and size, logs it as manual, and starts nothing when its turn ends", async () => {
  const h = await setup({ used: 50_000, provider: "codex" });
  await h.host.harness.setSettings({ enabled: false });
  const compact = (threadId = "thr_a") => h.host.harness.behavior.callRpc("compact", { threadId }) as Promise<any>;
  const list = async () => (await h.host.harness.behavior.callRpc("compactions.list", {}) as any).items;
  await h.emit("thread.idle");
  const t0 = h.now();
  // A double click: the second call is refused while the first is in flight.
  const [first, second] = await Promise.allSettled([compact(), compact()]);
  expect(first).toEqual({ status: "fulfilled", value: { ok: true } });
  expect(second).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: expect.stringMatching(/has not finished/) }) });
  expect(h.compact).toHaveBeenCalledTimes(1);
  expect(await list()).toEqual([expect.objectContaining({ threadId: "thr_a", at: t0, trigger: "manual", usedTokensBefore: 50_000, contextWindow: 1_000_000 })]);
  // Its compaction turn ends over the threshold: no check runs.
  await h.host.harness.setSettings({ enabled: true });
  await h.emit("thread.active"); h.state.used = 900_000; await h.emit("thread.idle"); await h.advance(IDLE_MS);
  expect(h.compact).toHaveBeenCalledTimes(1);
  // A refused call is not logged and leaves no marker: the next real stop is checked as usual.
  h.compact.mockRejectedValueOnce(new Error("Context can only be compacted while the thread is idle or errored"));
  await expect(compact()).rejects.toThrow(/only be compacted/);
  expect(await list()).toHaveLength(1);
  h.state.provider = "claude-code"; h.state.used = 910_000;
  await h.emit("thread.active"); await h.emit("thread.idle"); await h.advance(0);
  expect(h.compact).toHaveBeenCalledTimes(3);
  // An unknown context size is logged as null.
  h.state.used = undefined as never;
  await h.emit("thread.active"); await h.emit("thread.idle");
  await compact();
  expect((await list()).at(-1)).toMatchObject({ trigger: "manual", usedTokensBefore: null });
});

it("leaves a header compaction alone when an automatic check overlaps it", async () => {
  const h = await setup({ used: 900_000 });
  let open!: () => void, accept!: () => void;
  h.state.timeline = new Promise<void>(resolve => { open = resolve; });
  h.compact.mockImplementationOnce(() => new Promise(resolve => { accept = () => resolve({ ok: true }); }));
  await h.emit("thread.idle"); await h.advance(0); // the check at once waits on the usage
  const manual = h.host.harness.behavior.callRpc("compact", { threadId: "thr_a" });
  await h.advance(0);
  // Its compaction turn starts while the automatic check would be writing its markers.
  const kv = h.host.bb.storage.kv, set = kv.set.bind(kv);
  vi.spyOn(kv, "set").mockImplementation(async (key, value) => { await set(key, value); if (key === "compacted:thr_a") { vi.mocked(kv.set).mockRestore(); void h.emit("thread.active"); } });
  open(); await h.advance(0); // both read the usage; the header call dispatches
  expect(h.compact).toHaveBeenCalledTimes(1);
  accept(); await manual;
  h.state.used = 850_000; await h.emit("thread.idle"); await h.advance(IDLE_MS); // its turn ends, still over the threshold
  expect(h.compact).toHaveBeenCalledTimes(1);
  expect((await h.host.harness.behavior.callRpc("compactions.list", {}) as any).items).toEqual([expect.objectContaining({ trigger: "manual", usedTokensBefore: 900_000 })]);
});

function queueing(h: Awaited<ReturnType<typeof setup>>) {
  const call = (method: string, input: object = {}) => h.host.harness.behavior.callRpc(method, { threadId: "thr_a", ...input }) as Promise<any>;
  const dispatch = (status = "idle", attempt: "start-turn" | "join-turn" = "start-turn") => h.host.harness.registrations.hooks["message.dispatch"]!(makeMessageDispatchHookContext({ thread: { id: "thr_a", status: status as never }, attempt }));
  return { call, dispatch, state: () => call("compactState"), rechecks: () => h.host.harness.recheckCount };
}

it("queues a compaction during a turn, runs it at the stop before the next message, then releases that message", async () => {
  const h = await setup({ status: "active", used: 900_000 });
  const q = queueing(h), base = q.rechecks();
  expect(await q.call("compact", { queue: true })).toEqual({ ok: true, queued: true });
  expect(await q.call("compact", { queue: true })).toEqual({ ok: true, queued: true }); // a repeat is a no-op
  expect(await q.state()).toEqual({ queued: true, running: false });
  expect(h.compact).not.toHaveBeenCalled();
  // A steer joins the running turn; a message that would start the next turn waits.
  expect(await q.dispatch("active", "join-turn")).toEqual({ action: "proceed" });
  expect(await q.dispatch("active")).toMatchObject({ action: "wait" });
  // The turn stops: the queued compaction runs instead of the automatic checks, and the message keeps waiting on its turn.
  h.state.status = "idle"; await h.emit("thread.idle"); await h.advance(0);
  expect(h.compact).toHaveBeenCalledTimes(1);
  expect(await q.state()).toEqual({ queued: false, running: true });
  expect(await q.dispatch("active")).toMatchObject({ action: "wait" });
  expect(q.rechecks()).toBe(base);
  // Its turn ends: bb is asked to dispatch the waiting message, and nothing else is compacted.
  await h.emit("thread.active"); await h.emit("thread.idle"); await h.advance(IDLE_MS);
  expect(q.rechecks()).toBe(base + 1);
  expect(await q.dispatch()).toEqual({ action: "proceed" });
  expect(await q.state()).toEqual({ queued: false, running: false });
  expect(h.compact).toHaveBeenCalledTimes(1);
  expect((await h.host.harness.behavior.callRpc("compactions.list", {}) as any).items).toEqual([expect.objectContaining({ trigger: "manual", usedTokensBefore: 900_000 })]);
});

it("compacts at once when queued on a stopped thread, and cancels a queued request", async () => {
  const h = await setup();
  const q = queueing(h);
  expect(await q.call("compact", { queue: true })).toEqual({ ok: true });
  expect(h.compact).toHaveBeenCalledTimes(1);
  expect(await q.call("compact", { queue: true })).toEqual({ ok: true }); // already compacting: nothing more
  await h.emit("thread.active"); await h.emit("thread.idle");
  h.state.status = "active"; await h.emit("thread.active");
  await q.call("compact", { queue: true });
  const base = q.rechecks();
  expect(await q.call("cancelQueuedCompact")).toEqual({ ok: true });
  expect(q.rechecks()).toBe(base + 1);
  expect(await q.dispatch("active")).toEqual({ action: "proceed" });
  h.state.status = "idle"; await h.emit("thread.idle"); await h.advance(0);
  expect(h.compact).toHaveBeenCalledTimes(1);
});

it("keeps a queued compaction across a restart", async () => {
  const h = await setup({ status: "active" });
  await queueing(h).call("compact", { queue: true });
  // The thread stopped while the plugin was down: the compaction runs on start.
  h.state.status = "idle";
  await h.host.harness.lifecycle.reload(bb => plugin(bb, h.now)); await h.advance(0);
  expect(h.compact).toHaveBeenCalledTimes(1);
});

it("drops a queued compaction the server refuses, so the waiting message is not stuck behind it", async () => {
  const h = await setup({ status: "active" });
  const q = queueing(h);
  await q.call("compact", { queue: true });
  h.compact.mockRejectedValueOnce(new Error("Provider does not support context compaction"));
  const base = q.rechecks();
  h.state.status = "idle"; await h.emit("thread.idle"); await h.advance(0);
  expect(await q.state()).toEqual({ queued: false, running: false });
  expect(q.rechecks()).toBeGreaterThan(base);
  expect(await q.dispatch()).toEqual({ action: "proceed" });
});

const deferred = () => { let resolve!: () => void, reject!: (error: Error) => void; const promise = new Promise<{ ok: true }>((ok, fail) => { resolve = () => ok({ ok: true }); reject = fail; }); return { promise, resolve, reject }; };

it("keeps a request made while an automatic compaction is in flight, and runs it when that one is refused", async () => {
  const h = await setup({ used: 900_000 });
  const q = queueing(h), auto = deferred();
  h.compact.mockImplementationOnce(() => auto.promise);
  await h.emit("thread.idle"); await h.advance(0); // the check at once is dispatching
  expect(await q.call("compact", { queue: true })).toEqual({ ok: true, queued: true });
  expect(h.compact).toHaveBeenCalledTimes(1);
  auto.reject(new Error("Context can only be compacted while the thread is idle or errored")); await h.advance(0);
  expect(h.compact).toHaveBeenCalledTimes(2);
  expect(await q.state()).toEqual({ queued: false, running: true });
});

it("lets an in-flight automatic compaction that the server accepts cover a request made meanwhile", async () => {
  const h = await setup({ used: 900_000 });
  const q = queueing(h), auto = deferred();
  h.compact.mockImplementationOnce(() => auto.promise);
  await h.emit("thread.idle"); await h.advance(0);
  await q.call("compact", { queue: true });
  // Its stop arrives before the call returns.
  await h.emit("thread.active"); await h.emit("thread.idle");
  const base = q.rechecks();
  auto.resolve(); await h.advance(0);
  expect(h.compact).toHaveBeenCalledTimes(1);
  expect(await q.state()).toEqual({ queued: false, running: false });
  expect(q.rechecks()).toBeGreaterThan(base);
  expect(await q.dispatch()).toEqual({ action: "proceed" });
});

it("releases waiting messages when a queued compaction's stop arrives before the call returns", async () => {
  const h = await setup({ status: "active" });
  const q = queueing(h), call = deferred();
  h.compact.mockImplementationOnce(() => call.promise);
  await q.call("compact", { queue: true });
  h.state.status = "idle"; await h.emit("thread.idle"); await h.advance(0);
  await h.emit("thread.active"); await h.emit("thread.idle");
  call.resolve(); await h.advance(0);
  expect(await q.state()).toEqual({ queued: false, running: false });
  expect(await q.dispatch()).toEqual({ action: "proceed" });
  expect(h.compact).toHaveBeenCalledTimes(1);
});

it("does not run a queued compaction again after a restart while the server was accepting it", async () => {
  const h = await setup({ status: "active" });
  h.compact.mockImplementationOnce(() => new Promise(() => {})); // accepted, but the call never returns to this instance
  await queueing(h).call("compact", { queue: true });
  h.state.status = "idle"; await h.emit("thread.idle"); await h.advance(0);
  h.state.status = "active";
  const next = await h.host.harness.lifecycle.reload(bb => plugin(bb, h.now)); await h.advance(0);
  // The compaction is still running: the new instance keeps the next turn waiting until its stop.
  const hook = () => next.harness.registrations.hooks["message.dispatch"]!(makeMessageDispatchHookContext({ thread: { id: "thr_a", status: "active" as never }, attempt: "start-turn" }));
  expect(await next.harness.behavior.callRpc("compactState", { threadId: "thr_a" })).toEqual({ queued: false, running: true });
  expect(await hook()).toMatchObject({ action: "wait" });
  h.state.status = "idle";
  await next.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_a" } as any), lastAssistantText: null } as any); await h.advance(0);
  expect(await hook()).toEqual({ action: "proceed" });
  expect(h.compact).toHaveBeenCalledTimes(1);
});

it("does not run a queued compaction again after a restart that follows its stop", async () => {
  const h = await setup({ status: "active" });
  h.compact.mockImplementationOnce(() => new Promise(() => {}));
  await queueing(h).call("compact", { queue: true });
  h.state.status = "idle"; await h.emit("thread.idle"); await h.advance(0);
  await h.emit("thread.active"); await h.emit("thread.idle"); // its stop, before the call returns
  await h.host.harness.lifecycle.reload(bb => plugin(bb, h.now)); await h.advance(0);
  expect(h.compact).toHaveBeenCalledTimes(1);
});

it("keeps a cancel made while the queued compaction's call is pending", async () => {
  const h = await setup({ status: "active" });
  const q = queueing(h), call = deferred();
  h.compact.mockImplementationOnce(() => call.promise);
  await q.call("compact", { queue: true });
  h.state.status = "idle"; await h.emit("thread.idle"); await h.advance(0);
  await q.call("cancelQueuedCompact");
  call.reject(new Error("Context can only be compacted while the thread is idle or errored")); await h.advance(0);
  expect(await q.state()).toEqual({ queued: false, running: false });
  expect(await q.dispatch()).toEqual({ action: "proceed" });
  await h.emit("thread.active"); await h.emit("thread.idle"); await h.advance(0);
  expect(h.compact).toHaveBeenCalledTimes(1);
});

it("runs a stored request after a restart even when an OWN marker is left over", async () => {
  const h = await setup({ seed: [["queued:thr_a", true], ["own:thr_a", true]] });
  await h.advance(0);
  expect(h.compact).toHaveBeenCalledTimes(1);
});

it("releases the thread when the queued key cannot be removed before the call", async () => {
  const h = await setup({ status: "active" });
  const q = queueing(h);
  await q.call("compact", { queue: true });
  const kv = h.host.bb.storage.kv, remove = kv.delete.bind(kv);
  vi.spyOn(kv, "delete").mockImplementation(async key => { if (key === "queued:thr_a") { vi.mocked(kv.delete).mockRestore(); throw new Error("disk full"); } return remove(key); });
  h.state.status = "idle"; await h.emit("thread.idle"); await h.advance(0);
  expect(h.compact).not.toHaveBeenCalled();
  expect((await q.state()).running).toBe(false);
  expect(await q.dispatch()).toEqual({ action: "proceed" });
});
