import { expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from "./api";
import { getBadgeCriteria, getBoardPreferences, getChecksEnvironment } from "./global-settings";

const setup = () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  registerTasksApi(bb, createStore(bb));
  const set = (values: Record<string, unknown>) => harness.callRpc("globalSettings.set", { values }) as Promise<{ values: Record<string, unknown> }>;
  return { bb, harness, set };
};

it("writes the runner paths as one patch, rejects the whole patch for a relative CLI path, and clearing restores inheritance", async () => {
  const { bb, harness, set } = setup();
  try {
    expect(await set({ checksBbCli: "/opt/bin/bb", checksRuntimePath: "/usr/bin:/bin" })).toEqual({ values: { checksBbCli: "/opt/bin/bb", checksRuntimePath: "/usr/bin:/bin" } });
    await expect(set({ checksBbCli: "bin/bb", checksRuntimePath: "/usr/local/bin" })).rejects.toThrow(/absolute path/);
    // Nothing of the rejected patch was written.
    expect(await getChecksEnvironment(bb)).toEqual({ bbCli: "/opt/bin/bb", runtimePath: "/usr/bin:/bin" });
    expect(await set({ checksBbCli: "", checksRuntimePath: "" })).toEqual({ values: { checksBbCli: "", checksRuntimePath: "" } });
    expect(await getChecksEnvironment(bb)).toEqual({ bbCli: "", runtimePath: "" });
  } finally { await harness.dispose(); }
});

it("changes one badge key without touching the other five, and validates selects against their options", async () => {
  const { bb, harness, set } = setup();
  try {
    expect(await getBadgeCriteria(bb)).toEqual(["open", "waiting_on_owner"]);
    expect(await set({ badgeInReview: true })).toEqual({ values: { badgeInReview: true } });
    expect(await getBadgeCriteria(bb)).toEqual(["open", "waiting_on_owner", "in_review"]);
    await set({ badgeOpen: false });
    expect(await getBadgeCriteria(bb)).toEqual(["waiting_on_owner", "in_review"]);
    await expect(set({ startScreen: "nowhere" })).rejects.toThrow(/startScreen/);
    await expect(set({ badgeOpen: "yes" })).rejects.toThrow();
    await set({ startScreen: "all", openThreadsIn: "agent-hub" });
    expect(await getBoardPreferences(bb)).toEqual({ defaultScreen: "all" });
  } finally { await harness.dispose(); }
});

it("serializes writes that carry the same expected value: one is written, the other is refused", async () => {
  const { bb, harness } = setup();
  try {
    const write = (path: string) => harness.callRpc("globalSettings.set", { values: { checksRuntimePath: path }, expected: { checksRuntimePath: "" } });
    const results = await Promise.allSettled([write("/usr/bin"), write("/opt/bin")]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(String((results[1] as PromiseRejectedResult).reason)).toMatch(/changed elsewhere/);
    expect((await getChecksEnvironment(bb)).runtimePath).toBe("/usr/bin");
    // A write over the stored value goes through.
    await harness.callRpc("globalSettings.set", { values: { checksRuntimePath: "/opt/bin" }, expected: { checksRuntimePath: "/usr/bin" } });
    expect((await getChecksEnvironment(bb)).runtimePath).toBe("/opt/bin");
  } finally { await harness.dispose(); }
});
