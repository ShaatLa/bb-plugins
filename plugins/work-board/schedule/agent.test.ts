import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureProject } from "../archive/storage";
import { historyLimits, receiptPolling } from "../steer";
import { fixture, fixtures } from "./fixture";
import { insertStart, markerOf } from "./store";

const limits = { ...historyLimits };
beforeEach(() => { receiptPolling.tries = 1; receiptPolling.delayMs = 0; });
afterEach(async () => { Object.assign(historyLimits, limits); vi.useRealTimers(); vi.restoreAllMocks(); await Promise.all(fixtures.splice(0).map((f) => f.dispose())); });

/** A project without Spawn Gate's Script mode: Work Board launches the session itself. */
function ownSpawn() { const f = fixture(); f.world.installed = false; return f; }

describe("an agent start", () => {
  it("validates against the card project's catalog, is stored, changes and cancels", async () => {
    const f = ownSpawn();
    const { scheduledStart } = await f.schedule("+10m", { ...f.viaAgent, brief: "Run the focused tests." });
    expect(f.world.catalog.calls).toEqual([{ projectId: "proj_example", providerId: "codex", preferCached: true }]);
    expect(scheduledStart).toMatchObject({ mode: "preset", state: "scheduled", agent: { providerId: "codex", model: "gpt-5", reasoningLevel: "high", permissionMode: "auto" }, brief: "Run the focused tests." });
    expect(scheduledStart.presetId).toBeUndefined();
    expect(f.comments()[0]).toContain("agent codex/gpt-5, high");
    await f.call("changeScheduledStart", { taskId: f.task.id, at: "+20m", launch: { ...f.viaAgent, reasoningLevel: "low", permissionMode: "full" }, actor: "thr_setter" });
    expect(JSON.parse(f.row().agent)).toMatchObject({ reasoningLevel: "low", permissionMode: "full" });
    // A change with no launch keeps the agent as it was.
    await f.call("changeScheduledStart", { taskId: f.task.id, at: "+30m", actor: "thr_setter" });
    expect(JSON.parse(f.row().agent)).toMatchObject({ reasoningLevel: "low", permissionMode: "full" });
    await f.call("cancelScheduledStart", { taskId: f.task.id, actor: "thr_setter" });
    expect(f.row().state).toBe("canceled");
    expect(f.events()).toEqual(["scheduled", "changed", "changed", "canceled"]);
  });

  it.each([
    ["a provider the catalog does not list", (f: ReturnType<typeof ownSpawn>) => f.schedule("+10m", { ...f.viaAgent, providerId: "nope" }), /provider_unavailable/],
    ["a provider that is not available", (f: ReturnType<typeof ownSpawn>) => { f.world.catalog.available = false; return f.schedule("+10m", f.viaAgent); }, /provider_unavailable/],
    ["a provider whose models failed to load", (f: ReturnType<typeof ownSpawn>) => { f.world.catalog.modelLoadError = { code: "auth_required", detail: "sign in", providerId: "codex" }; return f.schedule("+10m", f.viaAgent); }, /auth_required.*sign in|sign in.*auth_required/],
    ["a model the provider does not list", (f: ReturnType<typeof ownSpawn>) => f.schedule("+10m", { ...f.viaAgent, model: "custom-model" }), /model_unknown.*bb thread spawn|bb thread spawn.*model_unknown/],
    ["a reasoning level the model does not support", (f: ReturnType<typeof ownSpawn>) => f.schedule("+10m", { ...f.viaAgent, reasoningLevel: "ultra" }), /reasoning_unsupported/],
    ["a service tier the model does not offer", (f: ReturnType<typeof ownSpawn>) => f.schedule("+10m", { ...f.viaAgent, serviceTier: "turbo" }), /service_tier_unsupported/],
    ["a permission mode the provider does not offer", (f: ReturnType<typeof ownSpawn>) => { f.world.catalog.permissionModes = ["auto"]; return f.schedule("+10m", { ...f.viaAgent, permissionMode: "full" }); }, /permission_unsupported/],
    ["a permission mode above the ceiling", (f: ReturnType<typeof ownSpawn>) => { f.world.catalog.ceiling = "auto"; return f.schedule("+10m", { ...f.viaAgent, permissionMode: "full" }); }, /permission_above_ceiling/],
    ["a catalog that cannot be read", (f: ReturnType<typeof ownSpawn>) => { f.world.catalog.fail = new Error("host offline"); return f.schedule("+10m", f.viaAgent); }, /catalog_unavailable.*host offline|host offline.*catalog_unavailable/],
  ])("refuses %s and stores nothing", async (_name, act, message) => {
    const f = ownSpawn();
    await expect(act(f)).rejects.toThrow(message);
    expect(f.rows()).toHaveLength(0);
  });

  it("lets any reasoning level pass when the model's levels are unknown", async () => {
    const f = ownSpawn();
    f.world.catalog.reasoningDiscovery = "unknown";
    expect((await f.schedule("+10m", { ...f.viaAgent, reasoningLevel: "ultra" })).scheduledStart.agent?.reasoningLevel).toBe("ultra");
  });

  it("answers a check with the reason code, and refuses an agent in a Script-mode project", async () => {
    const f = ownSpawn();
    expect(await f.call("checkScheduledStart", { taskId: f.task.id, launch: f.viaAgent, actor: "owner" })).toMatchObject({ ok: true, mode: "preset" });
    expect(await f.call("checkScheduledStart", { taskId: f.task.id, launch: { ...f.viaAgent, model: "custom-model" }, actor: "owner" })).toMatchObject({ ok: false, reasonCode: "model_unknown" });
    f.world.installed = true;
    await expect(f.schedule("+10m", f.viaAgent)).rejects.toThrow(/Spawn Gate launches this project's sessions/);
  });

  it("is a preset or an agent, exactly one, in the store", async () => {
    const f = ownSpawn();
    const input = { taskId: f.task.id, startAt: "2099-01-01T00:00:00.000Z", setter: "thr_setter", parentThreadId: "thr_setter" };
    expect(() => insertStart(f.db, { ...input, launch: { mode: "preset", presetId: f.preset.id, agent: { providerId: "codex", model: "gpt-5" } } })).toThrow(/exactly one/);
    expect(() => insertStart(f.db, { ...input, launch: { mode: "preset" } })).toThrow(/exactly one/);
    expect(f.rows()).toHaveLength(0);
  });

  it("spawns at its time with exactly the agent's provider, model, reasoning, tier and permission, marker in the prompt", async () => {
    const f = ownSpawn();
    await f.schedule("+10m", { ...f.viaAgent, serviceTier: "fast", permissionMode: "accept-edits", brief: "Night run." });
    await f.sweep();
    expect(f.world.spawned).toHaveLength(0);
    f.due();
    await f.sweep();
    expect(f.world.spawned).toHaveLength(1);
    expect(f.world.spawned[0]).toMatchObject({ providerId: "codex", model: "gpt-5", reasoningLevel: "high", serviceTier: "fast", permissionMode: "accept-edits", projectId: "proj_example", environment: { type: "project-default" }, parentThreadId: "thr_setter" });
    expect(f.world.spawned[0]!.prompt).toContain("Night run.");
    expect(f.world.spawned[0]!.prompt).toContain(markerOf(f.row().launch_id));
    expect(f.row()).toMatchObject({ state: "launched", thread_id: "thr_spawned_1", attached: 1 });
    expect(f.events()).toEqual(["scheduled", "launching", "launched"]);
    expect(f.world.catalog.calls).toHaveLength(1);
  });

  it("omits an unset reasoning level and tier from the spawn, and defaults the permission mode to auto", async () => {
    const f = ownSpawn();
    await f.schedule("+10m", { kind: "agent", providerId: "codex", model: "gpt-5" });
    f.due();
    await f.sweep();
    const spawned = f.world.spawned[0]!;
    expect(spawned).toMatchObject({ permissionMode: "auto" });
    expect(spawned).not.toHaveProperty("reasoningLevel");
    expect(spawned).not.toHaveProperty("serviceTier");
  });

  it("stores a lost spawn response as unknown and reconciles it by the marker, as a preset start does", async () => {
    const f = ownSpawn();
    await f.schedule("+10m", f.viaAgent);
    f.world.spawnLoseResponse = true;
    f.due();
    await f.sweep();
    expect(f.row().state).toBe("unknown");
    f.world.children.push({ id: "thr_spawned_1", parentThreadId: "thr_setter", createdAt: Date.now() });
    f.threads.dispatch(`Seed ${markerOf(f.row().launch_id)}`, "thr_spawned_1");
    await f.sweep();
    expect(f.row()).toMatchObject({ state: "launched", thread_id: "thr_spawned_1" });
    expect(f.events()).toContain("reconciled");
  });

  it("still launches a preset start as before", async () => {
    const f = ownSpawn();
    await f.schedule("+10m", f.viaPreset);
    f.due();
    await f.sweep();
    expect(f.world.spawned[0]).toMatchObject({ providerId: "claude-code", model: "claude-sonnet-5", reasoningLevel: "high", permissionMode: "full" });
    expect(f.row()).toMatchObject({ state: "launched" });
  });
});

describe("what an agent start exposes", () => {
  it("carries the agent in the card meta, the start and the log, and exports nothing of it", async () => {
    const f = ownSpawn();
    await f.schedule("+10m", f.viaAgent);
    expect((await f.call("getScheduledStart", { taskId: f.task.id })).scheduledStart.agent).toMatchObject({ providerId: "codex", model: "gpt-5" });
    const meta = (await f.call("listTaskCardMeta", { taskIds: [f.task.id] })).metadata[0];
    expect(meta.scheduledStart).toMatchObject({ mode: "preset", agent: { providerId: "codex" } });
    const { events } = await f.call("listScheduledStartLog", { taskId: f.task.id });
    expect(events[0].detail.agent).toMatchObject({ providerId: "codex", model: "gpt-5" });

    // What an export writes is this capture: manifest and records, from the same tables a snapshot reads.
    const text = JSON.stringify(captureProject(f.bb, f.store, f.tracker.id));
    expect(text).toContain(f.task.title);
    // The card's own system comment travels like any comment; the start itself (its fields) does not.
    expect(text).not.toMatch(/scheduled_?start|launch_id|"agent"|"providerId"|"builderArgs"/i);
  });
});
