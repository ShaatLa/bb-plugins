// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from "../api";
import { registerAttention } from "../attention/rpc";
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

it("shows the mode with its gate, starts shadow, saves the manager and lets the owner resolve an unknown notice", async () => {
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
    const section = await settings.findByRole("region", { name: "Manager attention" });
    await waitFor(() => expect(within(section).getByTestId("attention-sender").textContent).toBe("Sweep sends"));
    // The write RPC cannot tell the owner from an agent, so the copy must not promise that agents are kept out.
    expect(section.textContent).toMatch(/owner-only convention/);
    expect(section.textContent).not.toMatch(/agents cannot/i);
    expect(section.querySelector("details")!.open).toBe(false);
    openDelivery(section);
    expect(within(section).getByTestId("attention-mode").textContent).toBe("Off: Sweep sends");
    fireEvent.click(within(section).getByRole("button", { name: "Start shadow" }));
    await waitFor(() => expect(within(section).getByTestId("attention-mode").textContent, within(section).queryByRole("alert")?.textContent).toBe("Shadow: compare only, Sweep sends"));
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
    fireEvent.click(match);
    expect(picker.textContent).toContain("Release coordinator");
    fireEvent.click(within(section).getByRole("button", { name: "Save" }));
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
    fireEvent.click(within(section).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(db.prepare("SELECT manager FROM attention_manager WHERE tracker_id=?").get(project.id)).toEqual({ manager: null }));
    // Clearing the picker saved no manager, and the empty selection displays as "No manager" again.
    await waitFor(() => expect(within(section).getByRole("button", { name: /^Manager thread:/ }).textContent).toContain("No manager"));
    expect((await within(section).findByTestId("attention-manager-warning")).textContent).toContain("No manager chosen");
    // Reopened, the saved empty selection still reads "No manager".
    cleanup();
    const reopened = renderSlot(app.settingsSections[0]!, {}, slotOptions);
    const again = await reopened.findByRole("region", { name: "Manager attention" });
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
    const section = await settings.findByRole("region", { name: "Manager attention" });
    await within(section).findByTestId("attention-sender");
    expect(within(section).queryByTestId("attention-manager-warning")).toBeNull();
    // The host's realtime signals are handed to the mounted view, as the platform does for a subscribed slot.
    let delivered = harness.realtimeSignals.length;
    const deliver = async () => {
      for (const signal of harness.realtimeSignals.slice(delivered)) if (signal.channel === "projects:changed") await settings.behavior.emitRealtime("projects:changed", signal.payload as never);
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
