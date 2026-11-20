// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
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

it("shows the mode with its gate, starts shadow, saves the manager and lets the owner resolve an unknown notice", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  try {
    const store = createStore(bb);
    registerTasksApi(bb, store);
    registerAttention(bb, store);
    const project = store.tasks.createProject({ name: "Alpha", prefix: "ALP", color: "blue", linkedBbProjectId: "proj_example" });
    const settings = renderSlot(app.settingsSections[0]!, {}, { rpc: Object.fromEntries(Object.keys(tasksRpcContract).map((method) => [method, (input: unknown) => harness.callRpc(method, input)])) });
    const section = await settings.findByRole("region", { name: "Manager attention" });
    await within(section).findByText("off");
    // The write RPC cannot tell the owner from an agent, so the copy must not promise that agents are kept out.
    expect(section.textContent).toMatch(/owner-only convention/);
    expect(section.textContent).not.toMatch(/agents cannot/i);
    fireEvent.click(within(section).getByRole("button", { name: "Start shadow" }));
    await waitFor(() => expect(within(section).getByTestId("attention-mode").textContent, within(section).queryByRole("alert")?.textContent).toContain("shadow"));
    expect(within(section).getByTestId("attention-gate").textContent).toMatch(/48 hours/);
    expect(within(section).getByRole("button", { name: "Go live" })).toHaveProperty("disabled", true);
    fireEvent.change(within(section).getByLabelText("Manager thread"), { target: { value: "thr_example" } });
    fireEvent.click(within(section).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(settings.rpcCalls).toContainEqual({ method: "updateAttentionManager", input: { projectId: project.id, manager: "thr_example" } }));
    const db = bb.storage.database();
    expect(db.prepare("SELECT manager FROM attention_manager WHERE tracker_id=?").get(project.id)).toEqual({ manager: "thr_example" });
    db.prepare("INSERT INTO attention_attempts(attempt_id, tracker_id, kind, generation, batch_id, recipient_thread_id, recipient_source, started_at, outcome, rev) VALUES ('a1', ?, 'stale-status', 1, 'b1', 'thr_example', 'manager', ?, 'unknown', 1)").run(project.id, new Date().toISOString());
    db.prepare("INSERT INTO attention_attempt_items(attempt_id, occurrence_id) VALUES ('a1', 'o1')").run();
    fireEvent.click(within(section).getByRole("button", { name: "Switch off" }));
    await waitFor(() => expect(within(section).getByTestId("attention-mode").textContent).toContain("off"));
    // The unknown notice appears after the next read; resolving it records the owner's decision.
    fireEvent.click(within(section).getByRole("button", { name: "Start shadow" }));
    await within(section).findByTestId("attention-unknown");
    fireEvent.click(within(section).getByRole("button", { name: "Accept the loss" }));
    await waitFor(() => expect(db.prepare("SELECT disposition FROM attention_attempts WHERE attempt_id='a1'").get()).toEqual({ disposition: "waived_loss" }));
  } finally { cleanup(); await harness.dispose(); }
});
