// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from "../api";
import { registerChecks } from "../checks/rpc";
import { checksService } from "../checks/service";
import { getChecksEnvironment } from "../global-settings";
import { tasksRpcContract } from "../shared/contract";

window.matchMedia ??= (media: string) => ({ matches: false, media, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false });
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
Element.prototype.scrollIntoView ??= () => {};
window.PointerEvent ??= window.MouseEvent as typeof PointerEvent;
Element.prototype.setPointerCapture ??= () => {};

const app = await loadPluginApp(() => import("../app"));
afterEach(() => { cleanup(); window.localStorage.clear(); });

it("edits one field at a time, lets the owner enable the runner, and offers Retry and Reset where they apply", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  try {
    const store = createStore(bb);
    registerTasksApi(bb, store);
    registerChecks(bb);
    await getChecksEnvironment(bb);
    const project = store.tasks.createProject({ name: "Alpha", prefix: "ALP", color: "blue", linkedBbProjectId: "proj_example" });
    const rpc = Object.fromEntries(Object.keys(tasksRpcContract).map((method) => [method, (input: unknown) => harness.callRpc(method, input)]));
    const settings = renderSlot(app.settingsSections[0]!, {}, { rpc });
    const section = await settings.findByRole("region", { name: "Repository checks" });
    const enabled = await within(section).findByRole("checkbox", { name: "Run repository checks" });
    expect(enabled).toHaveProperty("checked", false);
    fireEvent.click(enabled);
    await waitFor(() => expect(within(section).getByRole("alert").textContent).toMatch(/Set branch and script/));
    fireEvent.change(within(section).getByLabelText("Branch"), { target: { value: "main" } });
    fireEvent.click(within(section).getAllByRole("button", { name: "Save" })[0]!);
    await waitFor(() => expect(checksService(bb).status(project.id).config.branch).toBe("main"));
    fireEvent.change(within(section).getByLabelText("Script"), { target: { value: "checks/run.py" } });
    fireEvent.click(within(section).getAllByRole("button", { name: "Save" })[1]!);
    await waitFor(() => expect(checksService(bb).status(project.id).config.script).toBe("checks/run.py"));
    fireEvent.change(within(section).getByLabelText("Arguments"), { target: { value: '["--root","{manager}"]' } });
    fireEvent.click(within(section).getAllByRole("button", { name: "Save" })[2]!);
    await waitFor(() => expect(checksService(bb).status(project.id).config.args).toEqual(["--root", "{manager}"]));
    fireEvent.click(within(section).getByRole("checkbox", { name: "Run repository checks" }));
    await waitFor(() => expect(checksService(bb).status(project.id).config.enabled).toBe(true));
    expect(section.textContent).toMatch(/owner-only convention/);
    // An unknown delivery offers Retry; state recorded for another bb project offers Reset once the runner is off.
    const db = bb.storage.database();
    db.prepare("INSERT INTO checks_delivery(tracker_id, report_id, pending_project, pending_exit, pending_tick, pending_body, pending_at) VALUES (?, 'rpt', 'proj_example', 1, 't', 'x', ?)").run(project.id, new Date().toISOString());
    db.prepare("INSERT INTO checks_attempts(attempt_id, tracker_id, report_id, tick_id, bb_project_id, manager_thread_id, marker, started_at, outcome) VALUES ('a', ?, 'rpt', 't', 'proj_example', 'thr_example', 'm', ?, 'unknown')").run(project.id, new Date().toISOString());
    await harness.callRpc("updateChecksEnabled", { projectId: project.id, enabled: false });
    // The out-of-band rows above are shown after the next refresh, which any saved setting triggers.
    const refresh = () => fireEvent.click(within(section).getByRole("checkbox", { name: "Snapshots" }));
    refresh();
    fireEvent.click(await within(section).findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(db.prepare("SELECT outcome FROM checks_attempts").get()).toEqual({ outcome: "superseded" }));
    db.prepare("DELETE FROM checks_delivery").run();
    db.prepare("INSERT INTO checks_delivery(tracker_id, committed, committed_project) VALUES (?, x'7b7d', 'proj_old')").run(project.id);
    await waitFor(() => expect(within(section).queryByRole("button", { name: "Retry" })).toBeNull());
    refresh();
    const mismatch = await within(section).findByTestId("checks-mismatch");
    expect(mismatch.textContent).toContain("State belongs to proj_old; reset it");
    fireEvent.click(within(mismatch).getByRole("button", { name: "Reset state" }));
    await waitFor(() => expect(db.prepare("SELECT COUNT(*) AS n FROM checks_delivery").get()).toEqual({ n: 0 }));
  } finally { await harness.dispose(); }
});
