import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin, { WORK_BOARD_PLUGIN_VERSION } from "./server";

describe("Tasks plugin scaffold", () => {
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
      "[ANV-12](/plugins/work-board/work-board/task/ANV-12)",
    );
    expect(provider({ threadId: "thr_b", projectId: "proj_other" })).toBeNull();
    const shown = JSON.parse((await harness.runCli(["create", "--project", "LNK", "--title", "One", "--json"])).stdout);
    expect(shown.link).toBe(`[${shown.task.key}](/plugins/work-board/work-board/task/${shown.task.key})`);
    await harness.dispose();
  });
});
