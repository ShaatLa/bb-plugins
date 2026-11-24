// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from "../api";
import { registerAttention } from "../attention/rpc";
import { transfers } from "../checks/transfer";
import { prEventSettings, setPrEventSetting } from "../git-sync/events";
import { tasksRpcContract } from "../shared/contract";

window.matchMedia ??= (media: string) => ({ matches: false, media, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false });
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
Element.prototype.scrollIntoView ??= () => {};
window.PointerEvent ??= window.MouseEvent as typeof PointerEvent;
Element.prototype.setPointerCapture ??= () => {};

const app = await loadPluginApp(() => import("../app"));
afterEach(() => { cleanup(); window.localStorage.clear(); });

// The delivery controls sit in a disclosure whose summary shows the sender and any warning.
const openDelivery = (section: HTMLElement) => {
  const details = section.querySelector("details")!;
  if (!details.open) fireEvent.click(details.querySelector("summary")!);
};

function threadSummary(overrides: Parameters<typeof makeThreadResponse>[0]) {
  return {
    ...makeThreadResponse(overrides),
    activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 },
    environmentBranchName: null, environmentHostId: null, environmentIsWorktree: null,
    environmentName: null, environmentPath: null, environmentProviderId: null,
    environmentWorkspaceDisplayKind: "other" as const, hasPendingInteraction: false,
    runtime: { displayStatus: "idle" as const }, pinSortKey: null, queuedWork: "none" as const,
  };
}

it("shows the mode with its gate, starts shadow, saves the manager on pick and lets the owner resolve an unknown notice", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  try {
    const store = createStore(bb);
    registerTasksApi(bb, store);
    registerAttention(bb, store);
    const project = store.tasks.createProject({ name: "Alpha", prefix: "ALP", color: "blue", linkedBbProjectId: "proj_example" });
    const manager = threadSummary({ id: "thr_example", title: "Release coordinator" });
    const slotOptions: NonNullable<Parameters<typeof renderSlot>[2]> = {
      rpc: Object.fromEntries(Object.keys(tasksRpcContract).map((method) => [method, (input: unknown) => harness.callRpc(method, input)])),
      sdk: {
        threads: {
          list: async (input) => {
            if (input?.threadIds?.includes(manager.id)) return [manager];
            if (input?.projectId !== "proj_example" || input.archived !== false) return [];
            return input.offset === 0
              ? Array.from({ length: 100 }, (_, index) => threadSummary({ id: `thr_example_${index}`, title: `Worker ${index}` }))
              : [manager, threadSummary({ id: "thr_noise", title: "Coordination round for a contributor" }), threadSummary({ id: "thr_old", title: "Release coordinator (archived)", archivedAt: 1 })];
          },
        },
      },
    };
    const settings = renderSlot(app.settingsSections[0]!, {}, slotOptions);
    const section = await settings.findByRole("region", { name: "Manager" });
    await waitFor(() => expect(within(section).getByTestId("attention-sender").textContent).toBe("Off · Sweep sends"));
    // The write RPC cannot tell the owner from an agent, so the copy must not promise that agents are kept out.
    expect(section.textContent).toMatch(/owner-only convention/);
    expect(section.textContent).not.toMatch(/agents cannot/i);
    expect(section.querySelector("details")!.open).toBe(false);
    openDelivery(section);
    expect(within(section).getByTestId("attention-mode").textContent).toBe("Off: Sweep sends");
    fireEvent.click(within(section).getByRole("button", { name: "Start shadow" }));
    await waitFor(() => expect(within(section).getByTestId("attention-mode").textContent, within(section).queryByRole("alert")?.textContent).toBe("Shadow: compare only, Sweep sends"));
    // The closed summary names the mode too, so comparison is visible without opening the actions.
    expect(within(section).getByTestId("attention-sender").textContent).toBe("Shadow · comparing, Sweep sends");
    // The mode has no "Changed … from …" line, and a missing manager is a warning that names the cause.
    expect(within(section).queryByTestId("attention-changed")).toBeNull();
    expect(section.textContent).not.toMatch(/Changed[^.]*from (off|shadow|live)/);
    const warning = await within(section).findByTestId("attention-manager-warning");
    expect(warning.textContent).toBe("No manager chosen; choose one before going live");
    // The warning sits in the disclosure summary, so it stays visible while the disclosure is closed.
    expect(warning.closest("summary")).not.toBeNull();
    fireEvent.click(section.querySelector("summary")!);
    expect(section.querySelector("details")!.open).toBe(false);
    expect(within(section).getByTestId("attention-manager-warning").closest("summary")).not.toBeNull();
    openDelivery(section);
    expect(within(section).getByTestId("attention-gate").textContent).toMatch(/48 hours/);
    expect(within(section).getByRole("button", { name: "Go live" })).toHaveProperty("disabled", true);
    const picker = within(section).getByRole("button", { name: /^Manager thread:/ });
    expect(picker.textContent).toContain("No manager");
    fireEvent.click(picker);
    const menu = within(document.body);
    fireEvent.change(await menu.findByPlaceholderText("Search by thread name"), { target: { value: "coordinator" } });
    const match = await menu.findByRole("option", { name: "Release coordinator" });
    expect(menu.queryByRole("option", { name: /archived/ })).toBeNull();
    expect(menu.queryByRole("option", { name: /Coordination round/ })).toBeNull();
    expect(menu.queryByRole("option", { name: "Worker 1" })).toBeNull();
    expect(menu.queryByRole("option", { name: "No manager" })).toBeNull();
    // With no manager set, the pick itself is the save: no confirmation and no Save button.
    fireEvent.click(match);
    expect(within(section).queryByRole("button", { name: "Save" })).toBeNull();
    await waitFor(() => expect(settings.rpcCalls).toContainEqual({ method: "updateAttentionManager", input: { projectId: project.id, manager: "thr_example" } }));
    const db = bb.storage.database();
    expect(db.prepare("SELECT manager FROM attention_manager WHERE tracker_id=?").get(project.id)).toEqual({ manager: "thr_example" });
    await waitFor(() => expect(section.textContent).toContain("from no manager"));
    db.prepare("INSERT INTO attention_attempts(attempt_id, tracker_id, kind, generation, batch_id, recipient_thread_id, recipient_source, started_at, outcome, rev) VALUES ('a1', ?, 'stale-status', 1, 'b1', 'thr_example', 'manager', ?, 'unknown', 1)").run(project.id, new Date().toISOString());
    db.prepare("INSERT INTO attention_attempt_items(attempt_id, occurrence_id) VALUES ('a1', 'o1')").run();
    fireEvent.click(within(section).getByRole("button", { name: "Switch off" }));
    await waitFor(() => expect(within(section).getByTestId("attention-mode").textContent).toBe("Off: Sweep sends"));
    // The unknown notice appears after the next read; resolving it records the owner's decision.
    fireEvent.click(within(section).getByRole("button", { name: "Start shadow" }));
    await within(section).findByTestId("attention-unknown");
    // An unresolved delivery is announced in the summary too.
    expect(within(section).getByTestId("attention-unknown-count").closest("summary")).not.toBeNull();
    fireEvent.click(within(section).getByRole("button", { name: "Accept the loss" }));
    await waitFor(() => expect(db.prepare("SELECT disposition FROM attention_attempts WHERE attempt_id='a1'").get()).toEqual({ disposition: "waived_loss" }));
    fireEvent.click(picker);
    fireEvent.click(await menu.findByRole("option", { name: "No manager" }));
    fireEvent.click(await menu.findByRole("button", { name: "Remove manager" }));
    await waitFor(() => expect(db.prepare("SELECT manager FROM attention_manager WHERE tracker_id=?").get(project.id)).toEqual({ manager: null }));
    // Clearing the picker saved no manager, and the empty selection displays as "No manager" again.
    await waitFor(() => expect(within(section).getByRole("button", { name: /^Manager thread:/ }).textContent).toContain("No manager"));
    expect((await within(section).findByTestId("attention-manager-warning")).textContent).toContain("No manager chosen");
    // Reopened, the saved empty selection still reads "No manager".
    cleanup();
    const reopened = renderSlot(app.settingsSections[0]!, {}, slotOptions);
    const again = await reopened.findByRole("region", { name: "Manager" });
    await waitFor(() => expect(within(again).getByRole("button", { name: /^Manager thread:/ }).textContent).toContain("No manager"));
    expect((await within(again).findByTestId("attention-manager-warning")).textContent).toContain("No manager chosen");
  } finally { cleanup(); await harness.dispose(); }
});

it("follows archive, unarchive and delete events of the manager in the open view without reopening", async () => {
  const thread = { archivedAt: null as number | null, failing: false };
  const { bb, harness } = createFakePluginHost({
    pluginId: "work-board",
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          if (thread.failing) throw new Error("backend unavailable");
          return makeThreadResponse({ id: threadId, ...(thread.archivedAt ? { archivedAt: thread.archivedAt } : {}) });
        },
      },
    } as never,
  });
  try {
    const store = createStore(bb);
    registerTasksApi(bb, store);
    registerAttention(bb, store);
    const project = store.tasks.createProject({ name: "Alpha", prefix: "ALP", color: "blue", linkedBbProjectId: "proj_example" });
    bb.storage.database().prepare("INSERT INTO attention_manager(tracker_id, manager, changed_at, previous) VALUES (?, 'thr_example', ?, NULL)").run(project.id, new Date().toISOString());
    const settings = renderSlot(app.settingsSections[0]!, {}, {
      rpc: Object.fromEntries(Object.keys(tasksRpcContract).map((method) => [method, (input: unknown) => harness.callRpc(method, input)])),
      sdk: { threads: { list: async () => [] } },
    });
    const section = await settings.findByRole("region", { name: "Manager" });
    await within(section).findByTestId("attention-sender");
    expect(within(section).queryByTestId("attention-manager-warning")).toBeNull();
    // The host's realtime signals are handed to the mounted view, as the platform does for a subscribed slot.
    let delivered = harness.realtimeSignals.length;
    const deliver = async () => {
      for (const signal of harness.realtimeSignals.slice(delivered)) if (signal.channel === "projects:changed" || signal.channel === "settings:changed") await settings.behavior.emitRealtime(signal.channel, signal.payload as never);
      delivered = harness.realtimeSignals.length;
    };
    const event = (type: "thread.archived" | "thread.unarchived" | "thread.deleted") => harness.emitThreadEvent(type, { thread: makeThreadResponse({ id: "thr_example" }) as never });
    const warning = () => within(section).queryByTestId("attention-manager-warning")?.textContent ?? null;
    thread.archivedAt = 1;
    await event("thread.archived");
    await deliver();
    await waitFor(() => expect(warning()).toBe("The manager session is archived; choose another before going live"));
    thread.archivedAt = null;
    await event("thread.unarchived");
    await deliver();
    await waitFor(() => expect(warning()).toBeNull());
    thread.failing = true;
    await event("thread.deleted");
    await deliver();
    await waitFor(() => expect(warning()).toBe("The manager session was deleted; choose another before going live"));
  } finally { cleanup(); await harness.dispose(); }
});

it("names Work Board's checks runner as the sender when it owns the checks, and shows why a transfer holds a ready transition", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  // Set before registration, so no attention pass can acknowledge the transition while the view is read.
  transfers.set("proj_example", "import-from-sweep");
  try {
    const store = createStore(bb);
    registerTasksApi(bb, store);
    const db = bb.storage.database();
    const project = store.tasks.createProject({ name: "Alpha", prefix: "ALP", color: "blue", linkedBbProjectId: "proj_example" });
    db.prepare("INSERT INTO checks_runner_owner (bb_project_id, owner, tracker_id, sent_id, sent_confirmed, received_id, updated_at) VALUES ('proj_example', 'work-board', ?, NULL, 0, NULL, ?)").run(project.id, new Date().toISOString());
    db.prepare("INSERT INTO attention_modes (tracker_id, kind, bound_tracker_id, bound_bb_project_id, effective_mode, effective_generation, requested_mode, requested_generation, transition_token, transition_direction, transition_state, ready_at) VALUES (?, 'stale-status', ?, 'proj_example', 'shadow', 1, 'live', 2, 'tok_example', 'to_live', 'ready', ?)")
      .run(project.id, project.id, new Date().toISOString());
    registerAttention(bb, store);
    const settings = renderSlot(app.settingsSections[0]!, {}, {
      rpc: Object.fromEntries(Object.keys(tasksRpcContract).map((method) => [method, (input: unknown) => harness.callRpc(method, input)])),
      sdk: { threads: { list: async () => [] } },
    });
    const section = await settings.findByRole("region", { name: "Manager" });
    await waitFor(() => expect(within(section).getByTestId("attention-sender").textContent).toBe("Shadow · comparing, Work Board's checks runner sends"));
    openDelivery(section);
    expect(within(section).getByTestId("attention-pending").textContent).toBe("Going live · A transfer (import-from-sweep) is running for this bb project. Wait for it to finish.");
  } finally { transfers.clear(); cleanup(); await harness.dispose(); }
});

it("confirms replacing or clearing a set manager, writes once on accept, and keeps the stored manager on cancel or rejection", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  try {
    const store = createStore(bb);
    registerTasksApi(bb, store);
    registerAttention(bb, store);
    const project = store.tasks.createProject({ name: "Alpha", prefix: "ALP", color: "blue", linkedBbProjectId: "proj_example" });
    const db = bb.storage.database();
    db.prepare("INSERT INTO attention_manager(tracker_id, manager, changed_at, previous) VALUES (?, 'thr_example', ?, NULL)").run(project.id, new Date().toISOString());
    const threads = [threadSummary({ id: "thr_example", title: "Release coordinator" }), threadSummary({ id: "thr_example_2", title: "Second coordinator" })];
    let reject = false;
    const rpc: Record<string, (input: unknown) => unknown> = Object.fromEntries(Object.keys(tasksRpcContract).map((method) => [method, (input: unknown) => harness.callRpc(method, input)]));
    rpc.updateAttentionManager = async (input) => {
      if (reject) throw new Error("Manager change refused");
      return harness.callRpc("updateAttentionManager", input);
    };
    const settings = renderSlot(app.settingsSections[0]!, {}, {
      rpc,
      sdk: { threads: { list: async (input) => (input?.threadIds ? threads.filter((thread) => input.threadIds!.includes(thread.id)) : input?.projectId === "proj_example" ? threads : []) } },
    });
    const section = await settings.findByRole("region", { name: "Manager" });
    const picker = () => within(section).getByRole("button", { name: /^Manager thread:/ });
    const menu = within(document.body);
    const writes = () => settings.rpcCalls.filter((call) => call.method === "updateAttentionManager");
    const choose = async (name: string) => {
      fireEvent.click(picker());
      fireEvent.click(await menu.findByRole("option", { name }));
    };
    await waitFor(() => expect(picker().textContent).toContain("Release coordinator"));
    // Picking the current manager again does nothing.
    await choose("Release coordinator");
    expect(menu.queryByRole("dialog")).toBeNull();
    expect(writes()).toHaveLength(0);
    // Cancel keeps the stored manager.
    await choose("Second coordinator");
    const dialog = await menu.findByRole("dialog", { name: "Replace the manager thread?" });
    expect(dialog.textContent).toContain("From Release coordinator to Second coordinator");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(menu.queryByRole("dialog")).toBeNull());
    expect(writes()).toHaveLength(0);
    expect(picker().textContent).toContain("Release coordinator");
    // A rejected write shows why and keeps the stored manager.
    reject = true;
    await choose("Second coordinator");
    fireEvent.click(await menu.findByRole("button", { name: "Replace manager" }));
    expect((await within(section).findByRole("alert")).textContent).toBe("Manager change refused");
    expect(picker().textContent).toContain("Release coordinator");
    expect(db.prepare("SELECT manager FROM attention_manager WHERE tracker_id=?").get(project.id)).toEqual({ manager: "thr_example" });
    // Accepting writes exactly once.
    reject = false;
    const before = writes().length;
    await choose("Second coordinator");
    fireEvent.click(await menu.findByRole("button", { name: "Replace manager" }));
    await waitFor(() => expect(db.prepare("SELECT manager FROM attention_manager WHERE tracker_id=?").get(project.id)).toEqual({ manager: "thr_example_2" }));
    expect(writes().slice(before)).toEqual([{ method: "updateAttentionManager", input: { projectId: project.id, manager: "thr_example_2" } }]);
    await waitFor(() => expect(picker().textContent).toContain("Second coordinator"));
    // Clearing to no manager asks too and stores null.
    await choose("No manager");
    expect((await menu.findByRole("dialog", { name: "Remove the manager thread?" })).textContent).toContain("to No manager");
    fireEvent.click(menu.getByRole("button", { name: "Remove manager" }));
    await waitFor(() => expect(db.prepare("SELECT manager FROM attention_manager WHERE tracker_id=?").get(project.id)).toEqual({ manager: null }));
    expect(writes().at(-1)).toEqual({ method: "updateAttentionManager", input: { projectId: project.id, manager: null } });
  } finally { cleanup(); await harness.dispose(); }
});

it("switches the two PR message settings one key at a time, survives a reload and a rejection, and never applies a write to another project", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  try {
    const store = createStore(bb);
    registerTasksApi(bb, store);
    registerAttention(bb, store);
    const alpha = store.tasks.createProject({ name: "Alpha", prefix: "ALP", color: "blue", linkedBbProjectId: "proj_example" });
    const beta = store.tasks.createProject({ name: "Beta", prefix: "BET", color: "red" });
    const db = bb.storage.database();
    setPrEventSetting(db, beta.id, "prEvents", "off");
    let gate: Promise<void> | null = null;
    let reject = false;
    const rpc: Record<string, (input: unknown) => unknown> = Object.fromEntries(Object.keys(tasksRpcContract).map((method) => [method, (input: unknown) => harness.callRpc(method, input)]));
    rpc["config.set"] = async (input) => {
      await gate;
      if (reject) throw new Error("Setting refused");
      return harness.callRpc("config.set", input);
    };
    const options = { rpc, sdk: { threads: { list: async () => [] } } };
    let settings = renderSlot(app.settingsSections[0]!, {}, options);
    const lifecycle = () => settings.getByRole("switch", { name: "PR lifecycle messages" });
    const copy = () => settings.getByRole("switch", { name: "Copy PR messages to the manager" });
    // Defaults: lifecycle messages on, the manager copy off; each switch is described by its hint.
    await waitFor(() => expect(lifecycle().hasAttribute("disabled")).toBe(false));
    expect(lifecycle().getAttribute("aria-checked")).toBe("true");
    expect(copy().getAttribute("aria-checked")).toBe("false");
    expect(document.getElementById(lifecycle().getAttribute("aria-describedby")!)?.textContent).toMatch(/pull request/);
    fireEvent.click(lifecycle());
    await waitFor(() => expect(prEventSettings(db, alpha.id).events).toBe("off"));
    await waitFor(() => expect(lifecycle().getAttribute("aria-checked")).toBe("false"));
    fireEvent.click(copy());
    await waitFor(() => expect(prEventSettings(db, alpha.id).manager).toBe("on"));
    await waitFor(() => expect(copy().getAttribute("aria-checked")).toBe("true"));
    expect(settings.rpcCalls.filter((call) => call.method === "config.set").map((call) => call.input)).toEqual([
      { projectId: alpha.id, key: "prEvents", value: "off" },
      { projectId: alpha.id, key: "prEventsManager", value: "on" },
    ]);
    fireEvent.click(copy());
    await waitFor(() => expect(prEventSettings(db, alpha.id).manager).toBe("off"));
    // A rejection keeps the stored value and says why.
    reject = true;
    fireEvent.click(lifecycle());
    expect((await settings.findByRole("alert")).textContent).toBe("Setting refused");
    expect(lifecycle().getAttribute("aria-checked")).toBe("false");
    expect(prEventSettings(db, alpha.id).events).toBe("off");
    reject = false;
    // A reload reads the stored values back.
    cleanup();
    settings = renderSlot(app.settingsSections[0]!, {}, options);
    await waitFor(() => expect(lifecycle().hasAttribute("disabled")).toBe(false));
    expect(lifecycle().getAttribute("aria-checked")).toBe("false");
    expect(copy().getAttribute("aria-checked")).toBe("false");
    // A write still pending when the project changes lands on its own project and never shows on the next one.
    let open!: () => void;
    gate = new Promise((resolve) => { open = resolve; });
    fireEvent.click(lifecycle());
    fireEvent.click(settings.getByRole("combobox", { name: "Settings project" }));
    fireEvent.click(await settings.findByRole("option", { name: "Beta" }));
    await waitFor(() => expect(settings.rpcCalls).toContainEqual({ method: "config.get", input: { projectId: beta.id } }));
    await waitFor(() => expect(lifecycle().hasAttribute("disabled")).toBe(false));
    open();
    await waitFor(() => expect(prEventSettings(db, alpha.id).events).toBe("on"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lifecycle().getAttribute("aria-checked")).toBe("false");
    expect(prEventSettings(db, beta.id).events).toBe("off");
  } finally { cleanup(); await harness.dispose(); }
});

it("makes the parity acknowledgement a local switch: no call when toggled, hidden until the gate expires, cleared by a new generation", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  try {
    const store = createStore(bb);
    registerTasksApi(bb, store);
    registerAttention(bb, store);
    const project = store.tasks.createProject({ name: "Alpha", prefix: "ALP", color: "blue", linkedBbProjectId: "proj_example" });
    const settings = renderSlot(app.settingsSections[0]!, {}, {
      rpc: Object.fromEntries(Object.keys(tasksRpcContract).map((method) => [method, (input: unknown) => harness.callRpc(method, input)])),
      sdk: { threads: { list: async () => [] } },
    });
    const section = await settings.findByRole("region", { name: "Manager" });
    await within(section).findByTestId("attention-sender");
    openDelivery(section);
    fireEvent.click(within(section).getByRole("button", { name: "Start shadow" }));
    await within(section).findByTestId("attention-gate");
    const name = "I reviewed the differences between Work Board and Sweep";
    expect(within(section).queryByRole("switch", { name })).toBeNull();
    // The gate expires: the shadow period began 49 hours ago.
    const db = bb.storage.database();
    db.prepare("UPDATE attention_modes SET shadow_started_at=? WHERE tracker_id=?").run(new Date(Date.now() - 49 * 3_600_000).toISOString(), project.id);
    await settings.behavior.emitRealtime("settings:changed", { projectId: project.id });
    const parity = await within(section).findByRole("switch", { name });
    const goLive = () => within(section).getByRole("button", { name: "Go live" });
    expect(parity.getAttribute("aria-checked")).toBe("false");
    expect(goLive()).toHaveProperty("disabled", true);
    const calls = settings.rpcCalls.length;
    // Keyboard-operable: the switch is a focusable button.
    parity.focus();
    fireEvent.click(parity);
    await waitFor(() => expect(within(section).getByRole("switch", { name }).getAttribute("aria-checked")).toBe("true"));
    expect(goLive()).toHaveProperty("disabled", false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settings.rpcCalls.slice(calls)).toEqual([]);
    // A new generation clears the acknowledgement.
    db.prepare("UPDATE attention_modes SET effective_generation=effective_generation+1 WHERE tracker_id=?").run(project.id);
    await settings.behavior.emitRealtime("settings:changed", { projectId: project.id });
    await waitFor(() => expect(within(section).getByRole("switch", { name }).getAttribute("aria-checked")).toBe("false"));
    expect(goLive()).toHaveProperty("disabled", true);
  } finally { cleanup(); await harness.dispose(); }
});

it("keeps the picker locked until the refreshed manager lands, so a second pick asks to replace it", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  try {
    const store = createStore(bb);
    registerTasksApi(bb, store);
    registerAttention(bb, store);
    store.tasks.createProject({ name: "Alpha", prefix: "ALP", color: "blue", linkedBbProjectId: "proj_example" });
    const threads = [threadSummary({ id: "thr_example", title: "Release coordinator" }), threadSummary({ id: "thr_example_2", title: "Second coordinator" })];
    const rpc: Record<string, (input: unknown) => unknown> = Object.fromEntries(Object.keys(tasksRpcContract).map((method) => [method, (input: unknown) => harness.callRpc(method, input)]));
    let hold: Promise<void> | null = null;
    rpc.getAttentionSettings = async (input) => { const gate = hold; if (gate) await gate; return harness.callRpc("getAttentionSettings", input); };
    const settings = renderSlot(app.settingsSections[0]!, {}, {
      rpc,
      sdk: { threads: { list: async (input) => (input?.threadIds ? threads.filter((thread) => input.threadIds!.includes(thread.id)) : input?.projectId === "proj_example" ? threads : []) } },
    });
    const section = await settings.findByRole("region", { name: "Manager" });
    const picker = () => within(section).getByRole("button", { name: /^Manager thread:/ });
    const menu = within(document.body);
    const writes = () => settings.rpcCalls.filter((call) => call.method === "updateAttentionManager");
    await waitFor(() => expect(picker().textContent).toContain("No manager"));
    let release!: () => void;
    hold = new Promise((resolve) => { release = resolve; });
    fireEvent.click(picker());
    fireEvent.click(await menu.findByRole("option", { name: "Release coordinator" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    // The refresh is still out: the picker cannot be used yet.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(picker().hasAttribute("disabled")).toBe(true);
    hold = null;
    release();
    await waitFor(() => expect(picker().hasAttribute("disabled")).toBe(false));
    await waitFor(() => expect(picker().textContent).toContain("Release coordinator"));
    fireEvent.click(picker());
    fireEvent.click(await menu.findByRole("option", { name: "Second coordinator" }));
    expect((await menu.findByRole("dialog", { name: "Replace the manager thread?" })).textContent).toContain("From Release coordinator to Second coordinator");
    expect(writes()).toHaveLength(1);
  } finally { cleanup(); await harness.dispose(); }
});

it("never lets a PR settings read that started before a write reverse the switch", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  try {
    const store = createStore(bb);
    registerTasksApi(bb, store);
    registerAttention(bb, store);
    const project = store.tasks.createProject({ name: "Alpha", prefix: "ALP", color: "blue", linkedBbProjectId: "proj_example" });
    const rpc: Record<string, (input: unknown) => unknown> = Object.fromEntries(Object.keys(tasksRpcContract).map((method) => [method, (input: unknown) => harness.callRpc(method, input)]));
    let hold: Promise<void> | null = null;
    // The read takes its values first and answers late, like a request already in flight.
    rpc["config.get"] = async (input) => { const result = await harness.callRpc("config.get", input); const gate = hold; if (gate) await gate; return result; };
    const settings = renderSlot(app.settingsSections[0]!, {}, { rpc, sdk: { threads: { list: async () => [] } } });
    const lifecycle = () => settings.getByRole("switch", { name: "PR lifecycle messages" });
    await waitFor(() => expect(lifecycle().hasAttribute("disabled")).toBe(false));
    let release!: () => void;
    hold = new Promise((resolve) => { release = resolve; });
    await settings.behavior.emitRealtime("projects:changed", { projectId: project.id });
    await waitFor(() => expect(settings.rpcCalls.filter((call) => call.method === "config.get")).toHaveLength(2));
    hold = null;
    fireEvent.click(lifecycle());
    await waitFor(() => expect(prEventSettings(bb.storage.database(), project.id).events).toBe("off"));
    await waitFor(() => expect(lifecycle().getAttribute("aria-checked")).toBe("false"));
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lifecycle().getAttribute("aria-checked")).toBe("false");
  } finally { cleanup(); await harness.dispose(); }
});

it("keeps an acknowledged manager and PR value when the read after the write fails, so a replacement still asks first", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  try {
    const store = createStore(bb);
    registerTasksApi(bb, store);
    registerAttention(bb, store);
    const project = store.tasks.createProject({ name: "Alpha", prefix: "ALP", color: "blue", linkedBbProjectId: "proj_example" });
    const threads = [threadSummary({ id: "thr_example", title: "Release coordinator" }), threadSummary({ id: "thr_example_2", title: "Second coordinator" })];
    const rpc: Record<string, (input: unknown) => unknown> = Object.fromEntries(Object.keys(tasksRpcContract).map((method) => [method, (input: unknown) => harness.callRpc(method, input)]));
    let failReads = false;
    rpc.getAttentionSettings = async (input) => { if (failReads) throw new Error("Read failed"); return harness.callRpc("getAttentionSettings", input); };
    rpc["config.get"] = async (input) => { if (failReads) throw new Error("Read failed"); return harness.callRpc("config.get", input); };
    const settings = renderSlot(app.settingsSections[0]!, {}, {
      rpc,
      sdk: { threads: { list: async (input) => (input?.threadIds ? threads.filter((thread) => input.threadIds!.includes(thread.id)) : input?.projectId === "proj_example" ? threads : []) } },
    });
    const section = await settings.findByRole("region", { name: "Manager" });
    const picker = () => within(section).getByRole("button", { name: /^Manager thread:/ });
    const lifecycle = () => within(section).getByRole("switch", { name: "PR lifecycle messages" });
    const menu = within(document.body);
    await waitFor(() => expect(picker().textContent).toContain("No manager"));
    await waitFor(() => expect(lifecycle().hasAttribute("disabled")).toBe(false));
    failReads = true;
    fireEvent.click(picker());
    fireEvent.click(await menu.findByRole("option", { name: "Release coordinator" }));
    await waitFor(() => expect(picker().hasAttribute("disabled")).toBe(false));
    await waitFor(() => expect(picker().textContent).toContain("Release coordinator"));
    fireEvent.click(picker());
    fireEvent.click(await menu.findByRole("option", { name: "Second coordinator" }));
    expect(await menu.findByRole("dialog", { name: "Replace the manager thread?" })).toBeTruthy();
    expect(settings.rpcCalls.filter((call) => call.method === "updateAttentionManager")).toHaveLength(1);
    fireEvent.click(menu.getByRole("button", { name: "Cancel" }));
    fireEvent.click(lifecycle());
    await waitFor(() => expect(prEventSettings(bb.storage.database(), project.id).events).toBe("off"));
    await waitFor(() => expect(lifecycle().hasAttribute("disabled")).toBe(false));
    expect(lifecycle().getAttribute("aria-checked")).toBe("false");
  } finally { cleanup(); await harness.dispose(); }
});
