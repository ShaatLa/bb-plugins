// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { transfers } from "../checks/transfer";
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

it("saves the changed fields with one Save, lets the owner enable the runner, and offers Retry and Reset where they apply", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board", sdk: { plugins: { list: async () => ({ plugins: [] }) } } as never });
  try {
    const store = createStore(bb);
    registerTasksApi(bb, store);
    registerChecks(bb);
    await getChecksEnvironment(bb);
    const project = store.tasks.createProject({ name: "Alpha", prefix: "ALP", color: "blue", linkedBbProjectId: "proj_example" });
    const rpc = Object.fromEntries(Object.keys(tasksRpcContract).map((method) => [method, (input: unknown) => harness.callRpc(method, input)]));
    const settings = renderSlot(app.settingsSections[0]!, {}, { rpc });
    const section = await settings.findByRole("region", { name: "Repository checks" });
    const enabled = await within(section).findByRole("switch", { name: "Run repository checks" });
    expect(enabled.getAttribute("aria-checked")).toBe("false");
    expect(section.textContent).toContain("Runner paths: General → Repository-check runner.");
    fireEvent.click(enabled);
    await waitFor(() => expect(within(section).getByRole("alert").textContent).toMatch(/Set branch and script/));
    expect(enabled.getAttribute("aria-checked")).toBe("false");
    const save = within(section).getByRole("button", { name: "Save" });
    expect(save.hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(section).getByLabelText("Branch"), { target: { value: "main" } });
    fireEvent.change(within(section).getByLabelText("Script"), { target: { value: "checks/run.py" } });
    fireEvent.change(within(section).getByLabelText("Arguments"), { target: { value: '["--root","{manager}"]' } });
    // Enabling waits for the edits; disabling never would.
    expect(within(section).getByRole("switch", { name: "Run repository checks" }).hasAttribute("disabled")).toBe(true);
    expect(section.textContent).toContain("Save or discard your changes first.");
    fireEvent.click(save);
    await waitFor(() => expect(checksService(bb).status(project.id).config).toMatchObject({ branch: "main", script: "checks/run.py", args: ["--root", "{manager}"] }));
    // One call with only the changed fields.
    expect(settings.rpcCalls.filter((call) => call.method === "checks.configPatch")).toEqual([
      { method: "checks.configPatch", input: { projectId: project.id, patch: { branch: "main", script: "checks/run.py", args: ["--root", "{manager}"] } } },
    ]);
    expect(settings.rpcCalls.some((call) => call.method === "updateChecksSetting")).toBe(false);
    await waitFor(() => expect(within(section).getByRole("switch", { name: "Run repository checks" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(within(section).getByRole("switch", { name: "Run repository checks" }));
    await waitFor(() => expect(checksService(bb).status(project.id).config.enabled).toBe(true));
    expect(section.textContent).toMatch(/owner-only convention/);
    // An unknown delivery offers Retry; state recorded for another bb project offers Reset once the runner is off.
    const db = bb.storage.database();
    db.prepare("INSERT INTO checks_delivery(tracker_id, report_id, pending_project, pending_exit, pending_tick, pending_body, pending_at) VALUES (?, 'rpt', 'proj_example', 1, 't', 'x', ?)").run(project.id, new Date().toISOString());
    db.prepare("INSERT INTO checks_attempts(attempt_id, tracker_id, report_id, tick_id, bb_project_id, manager_thread_id, marker, started_at, outcome) VALUES ('a', ?, 'rpt', 't', 'proj_example', 'thr_example', 'm', ?, 'unknown')").run(project.id, new Date().toISOString());
    await harness.callRpc("updateChecksEnabled", { projectId: project.id, enabled: false });
    // The out-of-band rows above are shown after the next refresh, which any saved setting triggers.
    const refresh = () => fireEvent.click(within(section).getByRole("switch", { name: "Snapshots" }));
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

const setup = async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board", sdk: { plugins: { list: async () => ({ plugins: [] }) } } as never });
  const store = createStore(bb);
  registerTasksApi(bb, store);
  registerChecks(bb);
  await getChecksEnvironment(bb);
  const project = store.tasks.createProject({ name: "Alpha", prefix: "ALP", color: "blue", linkedBbProjectId: "proj_example" });
  const rpc = Object.fromEntries(Object.keys(tasksRpcContract).map((method) => [method, (input: unknown) => harness.callRpc(method, input)]));
  return { bb, harness, store, project, rpc };
};

it("validates the whole patch first: an invalid second field writes nothing and keeps every draft", async () => {
  const { bb, harness, project, rpc } = await setup();
  try {
    const settings = renderSlot(app.settingsSections[0]!, {}, { rpc });
    const section = await settings.findByRole("region", { name: "Repository checks" });
    await within(section).findByLabelText("Branch");
    fireEvent.change(within(section).getByLabelText("Branch"), { target: { value: "main" } });
    fireEvent.change(within(section).getByLabelText("Interval (minutes)"), { target: { value: "5000" } });
    fireEvent.click(within(section).getByRole("button", { name: "Save" }));
    expect((await within(section).findByRole("alert")).textContent).toMatch(/intervalMinutes/);
    expect(checksService(bb).status(project.id).config).toMatchObject({ branch: null, intervalMinutes: 10 });
    expect((within(section).getByLabelText("Branch") as HTMLInputElement).value).toBe("main");
    expect((within(section).getByLabelText("Interval (minutes)") as HTMLInputElement).value).toBe("5000");
    // Discard returns the form to the stored values.
    fireEvent.click(within(section).getByRole("button", { name: "Discard" }));
    expect((within(section).getByLabelText("Branch") as HTMLInputElement).value).toBe("");
  } finally { cleanup(); await harness.dispose(); }
});

it("keeps the drafts and the enabled state apart: a concurrent disable is kept, and the patch never writes enabled", async () => {
  const { bb, harness, project, rpc } = await setup();
  try {
    checksService(bb).setFields(project.id, { branch: "main", script: "checks/run.py" });
    await checksService(bb).setEnabled(project.id, true);
    const settings = renderSlot(app.settingsSections[0]!, {}, { rpc });
    const section = await settings.findByRole("region", { name: "Repository checks" });
    const enabled = () => within(section).getByRole("switch", { name: "Run repository checks" });
    await waitFor(() => expect(enabled().getAttribute("aria-checked")).toBe("true"));
    fireEvent.change(within(section).getByLabelText("Timeout (seconds)"), { target: { value: "60" } });
    // Disabling stays available with unsaved edits.
    expect(enabled().hasAttribute("disabled")).toBe(false);
    await harness.callRpc("updateChecksEnabled", { projectId: project.id, enabled: false });
    await settings.behavior.emitRealtime("projects:changed", { projectId: project.id });
    await waitFor(() => expect(enabled().getAttribute("aria-checked")).toBe("false"));
    expect((within(section).getByLabelText("Timeout (seconds)") as HTMLInputElement).value).toBe("60");
    fireEvent.click(within(section).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(checksService(bb).status(project.id).config.timeoutSeconds).toBe(60));
    expect(checksService(bb).status(project.id).config.enabled).toBe(false);
    // Snapshots is a switch that saves at once.
    fireEvent.click(within(section).getByRole("switch", { name: "Snapshots" }));
    await waitFor(() => expect(checksService(bb).status(project.id).config.snapshots).toBe(true));
  } finally { cleanup(); await harness.dispose(); }
});

it("restores the stored switch state when enabling is refused by another owner or a running transfer", async () => {
  const { bb, harness, store, project, rpc } = await setup();
  try {
    checksService(bb).setFields(project.id, { branch: "main", script: "checks/run.py" });
    const other = store.tasks.createProject({ name: "Beta", prefix: "BET", color: "red", linkedBbProjectId: "proj_example" });
    checksService(bb).setFields(other.id, { branch: "main", script: "checks/run.py" });
    await checksService(bb).setEnabled(other.id, true);
    const settings = renderSlot(app.settingsSections[0]!, {}, { rpc });
    const section = await settings.findByRole("region", { name: "Repository checks" });
    const enabled = () => within(section).getByRole("switch", { name: "Run repository checks" });
    await waitFor(() => expect(enabled().hasAttribute("disabled")).toBe(false));
    fireEvent.click(enabled());
    expect((await within(section).findByRole("alert")).textContent).toMatch(/belong to tracker BET/);
    expect(enabled().getAttribute("aria-checked")).toBe("false");
    await checksService(bb).setEnabled(other.id, false);
    transfers.set("proj_example", "import-from-sweep");
    fireEvent.click(enabled());
    await waitFor(() => expect(within(section).getByRole("alert").textContent).toMatch(/transfer/));
    expect(enabled().getAttribute("aria-checked")).toBe("false");
    expect(checksService(bb).status(project.id).config.enabled).toBe(false);
  } finally { transfers.clear(); cleanup(); await harness.dispose(); }
});
