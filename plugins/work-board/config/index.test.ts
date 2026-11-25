import { afterEach, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { createStore, registerTasksApi } from "../api";
import { createGitSyncStore } from "../git-sync/store";
import { gitSyncConfigSchema } from "../shared/git-sync";

const setup = () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  const store = createStore(bb);
  registerTasksApi(bb, store);
  const project = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue" });
  const data = createGitSyncStore(bb.storage.database());
  const set = (key: string, value: unknown, expected?: unknown) => harness.callRpc("config.set", { projectId: project.id, key, value, expected });
  return { harness, project, data, set, store };
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

const receipt = { validatorId: "example", timeoutSeconds: 60, hint: "Generate a receipt", linkPathPattern: "^/example/" };
const registration = { cwd: "/example", argv: ["example"] };
const receiptSetup = () => {
  const f = setup();
  const dir = mkdtempSync(join(os.tmpdir(), "receipt-config-"));
  vi.spyOn(os, "homedir").mockReturnValue(dir);
  mkdirSync(join(dir, ".bb"));
  const registryPath = join(dir, ".bb", "work-board-receipt-validators.json");
  const register = () => writeFileSync(registryPath, JSON.stringify({ example: registration }));
  register();
  const dispose = async () => {
    rmSync(dir, { recursive: true, force: true });
    await f.harness.dispose();
  };
  const write = vi.spyOn(f.store.tasks, "updateProject");
  const logs = () => f.harness.logEntries.map(e => e.message).filter(line => line.startsWith("check receipt for EXA: "))
    .map(line => line.slice("check receipt for EXA: ".length).split(" → ").map(pair => JSON.parse(pair)));
  const current = () => f.store.tasks.getProject(f.project.id)?.checkReceipt;
  const set = (value: unknown) => f.set("checkReceipt", value);
  const panel = (checkReceipt: unknown) => f.harness.callRpc("updateProject", { projectId: f.project.id, checkReceipt });
  return { ...f, registryPath, register, dispose, write, logs, current, set, panel };
};
afterEach(() => vi.restoreAllMocks());

it("writes and logs only changed, registered, equal-or-tighter receipt settings", async () => {
  const f = receiptSetup();
  try {
    await f.set(null);
    expect(f.write).not.toHaveBeenCalled();
    expect(f.logs()).toEqual([]);
    await expect(f.set({ ...receipt, validatorId: "missing" })).rejects.toThrow(/unknown host-registered/i);
    rmSync(f.registryPath);
    await expect(f.set(receipt)).rejects.toThrow(/no receipt validators are registered/i);
    writeFileSync(f.registryPath, "{");
    await expect(f.set(receipt)).rejects.toThrow(/invalid JSON/i);
    f.register();
    expect(f.current()).toBeNull();
    expect(f.write).not.toHaveBeenCalled();
    expect(f.logs()).toEqual([]);
    await f.set(receipt);
    expect(f.current()).toEqual(receipt);
    expect(f.logs()).toEqual([[[null, null], [receipt, registration]]]);
    await expect(f.set(null)).rejects.toThrow(/off is owner-only.*EXA project settings/);
    await expect(f.set({ ...receipt, linkPathPattern: "other" })).rejects.toThrow(/pattern is owner-only.*EXA project settings/);
    writeFileSync(f.registryPath, "{}");
    await f.set({ ...receipt, timeoutSeconds: undefined });
    await expect(f.set({ ...receipt, linkWrappers: ["/view?src"] })).rejects.toThrow(/unknown host-registered/i);
    expect(f.current()).toEqual(receipt);
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(f.logs()).toHaveLength(1);
  } finally { await f.dispose(); }
});

it("judges a competing wrapper addition against the first committed addition", async () => {
  const f = receiptSetup();
  try {
    await f.set(receipt);
    const first = { ...receipt, linkWrappers: ["/first?src"] };
    const second = { ...receipt, linkWrappers: ["/second?src"] };
    const logsBefore = f.logs();
    const transaction = f.store.transaction.bind(f.store);
    vi.spyOn(f.store, "transaction").mockImplementationOnce(operation => {
      // The first addition commits after the second request starts, just before its transaction.
      transaction(() => f.store.tasks.updateProject(f.project.id, { checkReceipt: first }));
      return transaction(operation);
    });
    await expect(f.set(second)).rejects.toThrow(/wrapper is owner-only/);
    expect(f.current()).toEqual(first);
    expect(f.logs()).toEqual(logsBefore);
  } finally { await f.dispose(); }
});

it.each(["config", "panel"] as const)("logs the committed previous receipt for a %s change", async path => {
  const f = receiptSetup();
  try {
    const save = path === "panel" ? f.panel : f.set;
    const previous = { ...receipt, linkWrappers: ["/first?src"] };
    const next = { ...previous, linkWrappers: [...previous.linkWrappers, "/second?src"] };
    // Another writer commits just before this write enters its transaction.
    const transaction = f.store.transaction.bind(f.store);
    vi.spyOn(f.store, "transaction").mockImplementationOnce(operation => {
      transaction(() => f.store.tasks.updateProject(f.project.id, { checkReceipt: previous }));
      return transaction(operation);
    });
    await save(next);
    expect(f.logs()).toEqual([[[previous, registration], [next, registration]]]);
    await save(next);
    expect(f.logs()).toHaveLength(1);
  } finally { await f.dispose(); }
});
