// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from "../api";
import { registerAttention } from "../attention/rpc";
import { tasksRpcContract } from "../shared/contract";
import { navTab } from "../test-fixtures.js";

window.matchMedia ??= (media: string) => ({ matches: false, media, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false });
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
Element.prototype.scrollIntoView ??= () => {};

const app = await loadPluginApp(() => import("../app"));
afterEach(() => { cleanup(); window.localStorage.clear(); });

const thread = (overrides: Parameters<typeof makeThreadResponse>[0]) => ({
  ...makeThreadResponse(overrides),
  activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 },
  environmentBranchName: null, environmentHostId: null, environmentIsWorktree: null,
  environmentName: null, environmentPath: null, environmentProviderId: null,
  environmentWorkspaceDisplayKind: "other" as const, hasPendingInteraction: false,
  runtime: { displayStatus: "idle" as const }, pinSortKey: null, queuedWork: "none" as const,
});

// The fake host is in-memory: the manager row below is a fixture, never a real project's setting.
async function setup(options: { manager?: string; linked?: boolean; extraThreads?: ReturnType<typeof thread>[] } = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  const store = createStore(bb);
  registerTasksApi(bb, store);
  registerAttention(bb);
  const project = store.tasks.createProject({ name: "Alpha", prefix: "EXA", color: "blue", ...(options.linked === false ? {} : { linkedBbProjectId: "proj_example" }) });
  const db = bb.storage.database();
  if (options.manager) db.prepare("INSERT INTO attention_manager(tracker_id, manager, changed_at, previous) VALUES (?, ?, ?, NULL)").run(project.id, options.manager, new Date().toISOString());
  const listed = [thread({ id: "thr_example_2", title: "Second coordinator" }), thread({ id: "thr_example", title: "Release coordinator" }), thread({ id: "thr_hidden", title: "Archived coordinator", archivedAt: 1 })];
  const all = [...listed, ...(options.extraThreads ?? [])];
  const rpc = Object.fromEntries(Object.keys(tasksRpcContract).map((method) => [method, (input: unknown) => harness.callRpc(method, input)]));
  const slot = renderSlot({ component: navTab(app, "kanban").component }, { subPath: project.id }, {
    rpc,
    sdk: { threads: { list: async (input) => input?.threadIds ? all.filter((item) => input.threadIds!.includes(item.id)) : input?.projectId === "proj_example" ? listed : [] } },
  });
  const stored = () => db.prepare("SELECT manager FROM attention_manager WHERE tracker_id=?").get(project.id);
  const writes = () => slot.rpcCalls.filter((call) => call.method === "updateAttentionManager");
  return { slot, project, stored, writes, dispose: async () => { cleanup(); await harness.dispose(); } };
}
const rowNames = (dialog: HTMLElement) => within(dialog).getAllByRole("button").map((button) => button.textContent).filter((text) => /coordinator|No manager/.test(text ?? ""));

it("sets the manager from the header without a confirmation when none is set", async () => {
  const t = await setup();
  try {
    fireEvent.click(await t.slot.findByRole("button", { name: "Set manager" }));
    const dialog = await t.slot.findByRole("dialog", { name: "Choose the manager thread" });
    await within(dialog).findByRole("button", { name: /Release coordinator/ });
    expect(rowNames(dialog)).toHaveLength(2);
    expect(within(dialog).queryByRole("button", { name: /Archived/ })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "No manager" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: /Release coordinator/ }));
    await waitFor(() => expect(t.stored()).toEqual({ manager: "thr_example" }));
    expect(t.writes()).toEqual([{ method: "updateAttentionManager", input: { projectId: t.project.id, manager: "thr_example" } }]);
    expect(t.slot.queryByRole("dialog")).toBeNull();
    expect(await t.slot.findByRole("button", { name: "Manager: Release coordinator" })).toBeTruthy();
  } finally { await t.dispose(); }
});

it("pins the manager first, asks before replacing or removing it, and does nothing on the same pick", async () => {
  const t = await setup({ manager: "thr_example" });
  try {
    const open = async () => {
      fireEvent.click(await t.slot.findByRole("button", { name: "Manager: Release coordinator" }));
      const dialog = await t.slot.findByRole("dialog", { name: "Choose the manager thread" });
      await within(dialog).findByRole("button", { name: /Second coordinator/ });
      return dialog;
    };
    let dialog = await open();
    expect(rowNames(dialog)).toEqual(["No manager", "Release coordinatorManageridle", "Second coordinatoridle"]);
    // Picking the current manager again closes the chooser and writes nothing.
    fireEvent.click(within(dialog).getByRole("button", { name: /Release coordinator/ }));
    await waitFor(() => expect(t.slot.queryByRole("dialog")).toBeNull());
    expect(t.writes()).toHaveLength(0);
    dialog = await open();
    fireEvent.click(within(dialog).getByRole("button", { name: /Second coordinator/ }));
    const confirm = await t.slot.findByRole("dialog", { name: "Replace the manager thread?" });
    expect(confirm.textContent).toContain("From Release coordinator to Second coordinator");
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(t.slot.queryByRole("dialog")).toBeNull());
    expect(t.writes()).toHaveLength(0);
    expect(t.stored()).toEqual({ manager: "thr_example" });
    dialog = await open();
    fireEvent.click(within(dialog).getByRole("button", { name: /Second coordinator/ }));
    fireEvent.click(await t.slot.findByRole("button", { name: "Replace manager" }));
    await waitFor(() => expect(t.stored()).toEqual({ manager: "thr_example_2" }));
    expect(await t.slot.findByRole("button", { name: "Manager: Second coordinator" })).toBeTruthy();
    expect(t.writes()).toHaveLength(1);
    fireEvent.click(t.slot.getByRole("button", { name: "Manager: Second coordinator" }));
    fireEvent.click(await t.slot.findByRole("button", { name: "No manager" }));
    expect((await t.slot.findByRole("dialog", { name: "Remove the manager thread?" })).textContent).toContain("From Second coordinator to No manager");
    fireEvent.click(t.slot.getByRole("button", { name: "Remove manager" }));
    await waitFor(() => expect(t.stored()).toEqual({ manager: null }));
    expect(await t.slot.findByRole("button", { name: "Set manager" })).toBeTruthy();
  } finally { await t.dispose(); }
});

it("fetches a manager outside the project's thread list by its id", async () => {
  const t = await setup({ manager: "thr_elsewhere", extraThreads: [thread({ id: "thr_elsewhere", title: "Other-project coordinator" })] });
  try {
    fireEvent.click(await t.slot.findByRole("button", { name: /^Manager:/ }));
    const dialog = await t.slot.findByRole("dialog", { name: "Choose the manager thread" });
    await waitFor(() => expect(rowNames(dialog)[1]).toBe("Other-project coordinatorManageridle"));
  } finally { await t.dispose(); }
});

it("is disabled with a hint when the project is not linked to a BB project", async () => {
  const t = await setup({ linked: false });
  try {
    const button = await t.slot.findByRole("button", { name: "Set manager" });
    expect(button).toHaveProperty("disabled", true);
    expect(button.parentElement!.title).toMatch(/^Link this project to a BB project/);
  } finally { await t.dispose(); }
});
