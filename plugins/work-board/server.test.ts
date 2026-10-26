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
