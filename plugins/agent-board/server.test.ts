import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin, { AGENT_BOARD_PLUGIN_VERSION } from "./server";

describe("Tasks plugin scaffold", () => {
  it("registers the CLI and RPC surfaces after opening plugin storage", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "agent-board" });

    await plugin(bb);

    expect(harness.logEntries).toEqual([
      {
        level: "info",
        message: `Agent Board ${AGENT_BOARD_PLUGIN_VERSION} loaded`,
      },
    ]);
    await expect(harness.callRpc("ping", null)).resolves.toEqual({
      ok: true,
      version: AGENT_BOARD_PLUGIN_VERSION,
    });
    await expect(harness.runCli(["status"])).resolves.toEqual({
      exitCode: 0,
      stdout: `Agent Board ${AGENT_BOARD_PLUGIN_VERSION}`,
      stderr: "",
    });
    await expect(harness.runCli(["status", "--json"])).resolves.toEqual({
      exitCode: 0,
      stdout: JSON.stringify({
        name: "Agent Board",
        version: AGENT_BOARD_PLUGIN_VERSION,
      }),
      stderr: "",
    });

    await harness.dispose();
  });
});
