import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin, { WORK_BOARD_PLUGIN_VERSION } from "./server";
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
      expect(await harness.callRpc("getBoardPreferences", null)).toEqual({ defaultScreen: "active", statusNotifications: "off" });
      await harness.callRpc("updateProject", { projectId: legacy.id, autoArchiveAfterDays: "off", staleIdleMinutes: "30" });
      const replacement = await harness.lifecycle.reload(plugin);
      try {
        expect(replacement.harness.registrations.settingsDescriptors).toEqual({});
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

  it("registers the CLI and RPC surfaces after opening plugin storage", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });

    await plugin(bb);

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
