import { expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from "../api";
import { createGitSyncStore } from "../git-sync/store";
import { gitSyncConfigSchema } from "../shared/git-sync";

const setup = () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  const store = createStore(bb);
  registerTasksApi(bb, store);
  const project = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue" });
  const data = createGitSyncStore(bb.storage.database());
  const set = (key: string, value: unknown, expected: unknown) => harness.callRpc("config.set", { projectId: project.id, key, value, expected });
  return { harness, project, data, set };
};

it("compares expected with the effective value config.get returns, so an absent overlapEnabled is its boolean", async () => {
  const { harness, project, data, set } = setup();
  try {
    data.setConfig(project.id, gitSyncConfigSchema.parse({ overlapRules: [{ pattern: "docs/**", match: "changed" }] }));
    expect(data.config(project.id).overlapEnabled).toBeUndefined();
    await expect(set("git.overlapEnabled", false, null)).rejects.toThrow(/changed elsewhere/);
    await expect(set("git.overlapEnabled", false, false)).rejects.toThrow(/changed elsewhere/);
    expect(data.config(project.id).overlapEnabled).toBeUndefined();
    expect(await set("git.overlapEnabled", false, true)).toMatchObject({ value: false });
    expect(data.config(project.id).overlapEnabled).toBe(false);
  } finally { await harness.dispose(); }
});

it("compares expected structurally: object key order is ignored, array order is kept", async () => {
  const { harness, project, data, set } = setup();
  try {
    const rules = [{ pattern: "docs/**", match: "changed" as const }, { pattern: "src/**", match: "added" as const }];
    data.setConfig(project.id, gitSyncConfigSchema.parse({ overlapRules: rules }));
    await expect(set("git.overlapRules", [rules[0]], [rules[1], rules[0]])).rejects.toThrow(/changed elsewhere/);
    const reversed = rules.map(({ pattern, match }) => ({ match, pattern }));
    await set("git.overlapRules", [{ ...rules[0], match: "added" }, rules[1]], reversed);
    expect(data.config(project.id).overlapRules).toEqual([{ pattern: "docs/**", match: "added" }, rules[1]]);
  } finally { await harness.dispose(); }
});
