import { legacyBoard } from "./db/legacy-schedule-fixture";
import { navigationBadgeCounts } from "./api/badge";
import { attachNamedTaskThread } from "./lifecycle/discovery";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import plugin, { WORK_BOARD_PLUGIN_VERSION } from "./server";
import pkg from "./package.json" with { type: "json" };
import { createStore } from "./api";

describe("Tasks plugin scaffold", () => {
  it("migrates legacy settings once without replacing project overrides", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "work-board", settings: {
      autoArchiveAfterDays: "14", staleIdleMinutes: "120", defaultScreen: "active",
    } });
    try {
      const store = createStore(bb);
      const legacy = store.tasks.createProject({ name: "Legacy", prefix: "OLD", color: "blue" });
      const explicit = store.tasks.createProject({ name: "Explicit", prefix: "EXP", color: "red" });
      bb.storage.database().prepare("UPDATE projects SET auto_archive_after_days = NULL, stale_idle_minutes = NULL WHERE id = ?").run(legacy.id);
      await plugin(bb);
      expect(store.tasks.getProject(legacy.id)).toMatchObject({ autoArchiveAfterDays: "14", staleIdleMinutes: "120" });
      expect(store.tasks.getProject(explicit.id)).toMatchObject({ autoArchiveAfterDays: "off", staleIdleMinutes: "45" });
      expect(await harness.callRpc("getBoardPreferences", null)).toEqual({ defaultScreen: "active" });
      await harness.callRpc("updateProject", { projectId: legacy.id, autoArchiveAfterDays: "off", staleIdleMinutes: "30" });
      const replacement = await harness.lifecycle.reload(plugin);
      try {
        // Only the native global settings stay; the legacy migration fields are gone.
        expect(Object.keys(replacement.harness.registrations.settingsDescriptors ?? {})).toEqual(["startScreen", "openThreadsIn", "checksBbCli", "checksRuntimePath", "badgeOpen", "badgeWaitingOnOwner", "badgeInReview", "badgeNeedsAnswer", "badgeFailedThread", "badgeStaleIdle"]);
        const projects = await replacement.harness.callRpc("listProjects", {});
        expect(projects).toMatchObject({ projects: expect.arrayContaining([
          expect.objectContaining({ id: legacy.id, autoArchiveAfterDays: "off", staleIdleMinutes: "30" }),
        ]) });
        const created = await replacement.harness.callRpc("createProject", { name: "New", prefix: "NEW", color: "blue" });
        expect(created).toMatchObject({ project: { autoArchiveAfterDays: "off", staleIdleMinutes: "45" } });
        await expect(replacement.harness.callRpc("updateProject", { projectId: legacy.id, autoArchiveAfterDays: "1" })).rejects.toThrow();
      } finally {
        await replacement.harness.dispose();
      }
    } finally {
      await harness.dispose();
    }
  });

  it("counts, discovers and sends status notices for upgraded result cards", async () => {
    const send = vi.fn(async (_input: unknown) => ({ ok: true, channels: ["desktop"] }));
    const { bb, harness } = createFakePluginHost({ pluginId: "work-board", sdk: { plugins: { callRpc: send } } });
    try {
      const f = legacyBoard(bb.storage.database());
      const store = createStore(bb);
      expect(navigationBadgeCounts(bb, store, ["open"], Date.now()).count).toBe(3);
      const thread = makeThreadResponse({ id: "thr_discovered", title: "Review EXA-2", projectId: "proj_example", status: "active" });
      attachNamedTaskThread(bb, store, thread);
      expect(store.tasks.listTaskThreads(f.pending).map(link => link.threadId)).toContain(thread.id);
      store.tasks.updateTask(f.pending, { status: "in_progress" });
      await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({
        method: "notifications.send", input: expect.objectContaining({ title: "EXA-2 · In Progress" }),
      })));
    } finally { await harness.dispose(); }
  });

  it("reports the version of the package manifest", () => {
    expect(WORK_BOARD_PLUGIN_VERSION).toBe(pkg.version);
    expect(WORK_BOARD_PLUGIN_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("registers the CLI and RPC surfaces after opening plugin storage", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });

    await plugin(bb);

    const { schedules, cli, rpcMethods } = harness.registrations;
    expect(schedules.map(job => job.name).sort()).toEqual(["attention-reconcile", "auto-archive-tasks", "capacity-waits", "checks", "git-pr-sync", "held-check-answers", "pause-samples", "pause-signals", "plan-debt", "queue-scan", "scheduled-starts", "storage-maintenance"]);
    // Recurring cards moved to Automations; the only schedule surface is a card's scheduled start (schedule/).
    expect(cli!.commands.filter(cmd => /^schedule(?: |$)/.test(cmd.name)).map(cmd => cmd.name).sort()).toEqual(["schedule"]);
    expect(rpcMethods.filter(method => /schedule/i.test(method)).sort()).toEqual(["cancelScheduledStart", "changeScheduledStart", "checkScheduledStart", "getScheduledStart", "listScheduledStartLog", "resolveScheduledStart", "scheduleOptions", "scheduleStart"]);
    expect(harness.logEntries).toEqual([
      {
        level: "info",
        message: `Work Board ${WORK_BOARD_PLUGIN_VERSION} loaded`,
      },
    ]);
    await expect(harness.callRpc("ping", null)).resolves.toEqual({
      ok: true,
      version: WORK_BOARD_PLUGIN_VERSION,
    });
    await expect(harness.runCli(["status"])).resolves.toEqual({
      exitCode: 0,
      stdout: `Work Board ${WORK_BOARD_PLUGIN_VERSION}`,
      stderr: "",
    });
    await expect(harness.runCli(["status", "--json"])).resolves.toEqual({
      exitCode: 0,
      stdout: JSON.stringify({
        name: "Work Board",
        version: WORK_BOARD_PLUGIN_VERSION,
      }),
      stderr: "",
    });

    await harness.dispose();
  });
});

describe("task link instructions", () => {
  it("are contributed only to threads in bb projects linked to Work Board", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
    await plugin(bb);
    await harness.runCli(["project", "create", "--name", "Linked", "--prefix", "LNK", "--bb-project", "proj_linked"]);

    const provider = harness.registrations.instructionProvider!;
    expect(provider({ threadId: "thr_a", projectId: "proj_linked" })).toContain(
      "[EXA-12](/plugins/work-board/work-board/task/EXA-12)",
    );
    expect(provider({ threadId: "thr_b", projectId: "proj_other" })).toBeNull();
    const shown = JSON.parse((await harness.runCli(["create", "--project", "LNK", "--title", "One", "--json"])).stdout);
    expect(shown.link).toBe(`[${shown.task.key}](/plugins/work-board/work-board/task/${shown.task.key})`);
    await harness.dispose();
  });
});
