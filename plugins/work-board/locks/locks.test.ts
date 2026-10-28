import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import plugin from "../server";
import { LOCK_HISTORY_LIMIT } from "../shared/locks";

type ThreadOverrides = Parameters<typeof makeThreadResponse>[0];

async function setup(threads: Record<string, ThreadOverrides> = {}) {
  const get = vi.fn(async ({ threadId }: { threadId: string }) => {
    const overrides = threads[threadId];
    if (!overrides) {
      throw Object.assign(new Error("not found"), { code: "thread_not_found" });
    }
    return makeThreadResponse({ id: threadId, ...overrides });
  });
  const { bb, harness } = createFakePluginHost({
    pluginId: "work-board",
    sdk: { threads: { get } },
  });
  await plugin(bb);
  await harness.runCli(["project", "create", "--name", "Anv", "--prefix", "ANV"]);
  const run = (args: string[], threadId?: string) =>
    harness.runCli([...args, "--project", "ANV"], threadId ? { threadId } : {});
  const json = async (args: string[], threadId?: string) => {
    const result = await run([...args, "--json"], threadId);
    return { exitCode: result.exitCode, body: JSON.parse(result.stdout || "null") };
  };
  return { bb, harness, run, json, get };
}

const WORKER = { title: "Dev QA run" };

afterEach(() => vi.useRealTimers());

describe("resource locks", () => {
  it("lets exactly one of two concurrent acquires win", async () => {
    const { json, harness } = await setup({ thr_a: WORKER, thr_b: WORKER });
    const [a, b] = await Promise.all([
      json(["lock", "acquire", "dev", "--reason", "QA a"], "thr_a"),
      json(["lock", "acquire", "dev", "--reason", "QA b"], "thr_b"),
    ]);
    expect([a.exitCode, b.exitCode].sort()).toEqual([0, 1]);
    const loser = a.exitCode === 1 ? a : b;
    expect(loser.body).toMatchObject({
      ok: false,
      error: { code: "held" },
      lock: { name: "dev", stale: null },
    });
    await harness.dispose();
  });

  it("prints the holder on success and on a held failure without --json", async () => {
    const { run, harness } = await setup({ thr_a: WORKER, thr_b: WORKER });
    const ok = await run(["lock", "acquire", "dev", "--reason", "dev QA ANV-12", "--task", "anv-12"], "thr_a");
    expect(ok).toMatchObject({ exitCode: 0 });
    expect(ok.stdout).toContain("thr_a");
    expect(ok.stdout).toContain("ANV-12");
    const held = await run(["lock", "acquire", "dev", "--reason", "mine"], "thr_b");
    expect(held.exitCode).toBe(1);
    expect(held.stderr).toContain("lock dev is held by Dev QA run (thr_a)");
    expect(held.stderr).toContain("dev QA ANV-12");
    await harness.dispose();
  });

  it("refreshes reason and ttl when the holder re-acquires", async () => {
    const { json, harness } = await setup({ thr_a: WORKER });
    const first = await json(["lock", "acquire", "dev", "--reason", "one"], "thr_a");
    const again = await json(["lock", "acquire", "dev", "--reason", "two", "--ttl", "30"], "thr_a");
    expect(again.exitCode).toBe(0);
    expect(again.body.lock).toMatchObject({ reason: "two", acquiredAt: first.body.lock.acquiredAt });
    expect(again.body.lock.expiresAt).not.toBeNull();
    const shown = await json(["lock", "show", "dev"]);
    expect(shown.body.events.map((event: { kind: string }) => event.kind)).toEqual(["acquired"]);
    await harness.dispose();
  });

  it("only lets the holder release; force records who and why", async () => {
    const { json, harness } = await setup({ thr_a: WORKER, thr_b: WORKER });
    await json(["lock", "acquire", "dev", "--reason", "QA"], "thr_a");

    const denied = await json(["lock", "release", "dev"], "thr_b");
    expect(denied).toMatchObject({ exitCode: 1, body: { error: { code: "not_holder" } } });

    const noReason = await harness.runCli(["lock", "release", "dev", "--project", "ANV", "--force"], { threadId: "thr_b" });
    expect(noReason.exitCode).toBe(1);

    const forced = await json(["lock", "release", "dev", "--force", "--reason", "holder is gone"], "thr_b");
    expect(forced).toMatchObject({ exitCode: 0, body: { ok: true, lock: null } });

    const shown = await json(["lock", "show", "dev"]);
    expect(shown.body.lock).toBeNull();
    expect(shown.body.events[0]).toMatchObject({
      kind: "released",
      forced: true,
      threadId: "thr_b",
      previousThreadId: "thr_a",
      reason: "holder is gone",
    });

    const free = await json(["lock", "release", "dev"], "thr_a");
    expect(free).toMatchObject({ exitCode: 1, body: { error: { code: "not_held" } } });
    await harness.dispose();
  });

  it("marks an expired lock stale and allows takeover only then", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-28T10:00:00Z"));
    const { json, harness } = await setup({ thr_a: WORKER, thr_b: WORKER });
    await json(["lock", "acquire", "dev", "--reason", "QA", "--ttl", "10"], "thr_a");

    const early = await json(["lock", "acquire", "dev", "--reason", "mine", "--takeover"], "thr_b");
    expect(early).toMatchObject({ exitCode: 1, body: { lock: { stale: null } } });

    vi.setSystemTime(new Date("2026-10-28T10:11:00Z"));
    expect((await json(["lock", "list"])).body.locks[0]).toMatchObject({ stale: "expired" });
    const noTakeover = await json(["lock", "acquire", "dev", "--reason", "mine"], "thr_b");
    expect(noTakeover).toMatchObject({ exitCode: 1, body: { lock: { stale: "expired" } } });

    const taken = await json(["lock", "acquire", "dev", "--reason", "mine", "--takeover"], "thr_b");
    expect(taken).toMatchObject({ exitCode: 0, body: { lock: { holderThreadId: "thr_b", stale: null } } });
    const events = (await json(["lock", "show", "dev"])).body.events.map((event: { kind: string }) => event.kind);
    expect(events).toEqual(["taken_over", "expired", "acquired"]);
    await harness.dispose();
  });

  it.each([
    ["failed", { status: "error" as const }, "thread_failed"],
    ["archived", { archivedAt: 1 }, "thread_archived"],
    ["deleted", { deletedAt: 1 }, "thread_deleted"],
  ])("treats a %s holder thread as stale", async (_, overrides, stale) => {
    const threads: Record<string, ThreadOverrides> = { thr_a: WORKER, thr_b: WORKER };
    const { json, harness } = await setup(threads);
    await json(["lock", "acquire", "dev", "--reason", "QA"], "thr_a");
    threads.thr_a = { ...WORKER, ...overrides };
    expect((await json(["lock", "list"])).body.locks[0]).toMatchObject({ stale });
    const taken = await json(["lock", "acquire", "dev", "--reason", "mine", "--takeover"], "thr_b");
    expect(taken.exitCode).toBe(0);
    await harness.dispose();
  });

  it("treats a vanished holder thread as deleted but an SDK error as unknown", async () => {
    const threads: Record<string, ThreadOverrides> = { thr_a: WORKER };
    const { json, get, harness } = await setup(threads);
    await json(["lock", "acquire", "dev", "--reason", "QA"], "thr_a");
    get.mockRejectedValueOnce(new Error("backend unavailable"));
    expect((await json(["lock", "list"])).body.locks[0]).toMatchObject({ stale: null });
    delete threads.thr_a;
    expect((await json(["lock", "list"])).body.locks[0]).toMatchObject({ stale: "thread_deleted" });
    await harness.dispose();
  });

  it("treats a person (no thread) as a holder", async () => {
    const { json, harness } = await setup({ thr_a: WORKER });
    expect((await json(["lock", "acquire", "dev", "--reason", "manual"])).exitCode).toBe(0);
    expect((await json(["lock", "list"])).body.locks[0]).toMatchObject({ holderThreadId: null, stale: null });
    expect((await json(["lock", "release", "dev"], "thr_a")).exitCode).toBe(1);
    expect((await json(["lock", "release", "dev"])).exitCode).toBe(0);
    await harness.dispose();
  });

  it("validates names and reasons and applies the secret guard", async () => {
    const { run, harness } = await setup({ thr_a: WORKER });
    for (const name of ["Dev", "1dev", "has space", "a".repeat(65)]) {
      const result = await run(["lock", "acquire", name, "--reason", "QA"], "thr_a");
      expect(result.exitCode, name).toBe(1);
    }
    expect((await run(["lock", "acquire", "dev", "--reason", ""], "thr_a")).exitCode).toBe(1);
    expect((await run(["lock", "acquire", "dev", "--reason", "x".repeat(201)], "thr_a")).exitCode).toBe(1);
    expect((await run(["lock", "acquire", "dev", "--reason", "QA", "--ttl", "0"], "thr_a")).exitCode).toBe(1);
    expect((await run(["lock", "acquire", "dev", "--reason", "QA", "--ttl", "1441"], "thr_a")).exitCode).toBe(1);

    const secret = await run(["lock", "acquire", "dev", "--reason", "token sk-ant-api03-abcdefghijklmnopqrstuvwx"], "thr_a");
    expect(secret.exitCode).toBe(1);
    expect(secret.stderr).toContain("Cannot save lock reason");
    expect((await run(["lock", "list"])).stdout).toContain("No locks held.");

    await run(["lock", "acquire", "dev", "--reason", "QA"], "thr_a");
    const forced = await run(["lock", "release", "dev", "--force", "--reason", "sk-ant-api03-abcdefghijklmnopqrstuvwx"]);
    expect(forced.stderr).toContain("Cannot save lock release reason");
    await harness.dispose();
  });

  it("keeps only the last 50 events per lock", async () => {
    const { json, harness } = await setup({ thr_a: WORKER });
    for (let index = 0; index < LOCK_HISTORY_LIMIT; index++) {
      await json(["lock", "acquire", "dev", "--reason", `run ${index}`], "thr_a");
      await json(["lock", "release", "dev"], "thr_a");
    }
    const { events } = (await json(["lock", "show", "dev"])).body;
    expect(events).toHaveLength(LOCK_HISTORY_LIMIT);
    expect(events[0].kind).toBe("released");
    await harness.dispose();
  });

  it("scopes locks to their project", async () => {
    const { harness, json } = await setup({ thr_a: WORKER });
    await harness.runCli(["project", "create", "--name", "Other", "--prefix", "OTH"]);
    await json(["lock", "acquire", "dev", "--reason", "QA"], "thr_a");
    const other = await harness.runCli(["lock", "list", "--project", "OTH", "--json"]);
    expect(JSON.parse(other.stdout)).toEqual({ locks: [] });
    await harness.dispose();
  });
});
