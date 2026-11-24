// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
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

it("applies the changed fields with one Apply shown only while they differ, lets the owner enable the runner, and offers Retry and Reset where they apply", async () => {
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
    expect(section.textContent).not.toContain("Runner paths: General");
    fireEvent.click(enabled);
    await waitFor(() => expect(within(section).getByRole("alert").textContent).toMatch(/^Failed: .*Set branch and script/));
    expect(enabled.getAttribute("aria-checked")).toBe("false");
    expect(within(section).queryByRole("button", { name: "Apply" })).toBeNull();
    // Each field reads label, input, hint.
    const branch = within(section).getByLabelText("Branch");
    expect(branch.previousElementSibling?.textContent).toBe("Branch");
    expect(branch.nextElementSibling).toBe(document.getElementById(branch.getAttribute("aria-describedby")!));
    expect(branch.nextElementSibling?.textContent).toBe("For example main");
    fireEvent.change(branch, { target: { value: "main" } });
    fireEvent.change(within(section).getByLabelText("Script"), { target: { value: "checks/run.py" } });
    fireEvent.change(within(section).getByLabelText("Arguments"), { target: { value: '["--root","{manager}"]' } });
    // Unapplied edits never lock the switch.
    expect(within(section).getByRole("switch", { name: "Run repository checks" }).hasAttribute("disabled")).toBe(false);
    expect(settings.rpcCalls.some((call) => call.method === "checks.configPatch")).toBe(false);
    fireEvent.click(within(section).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(checksService(bb).status(project.id).config).toMatchObject({ branch: "main", script: "checks/run.py", args: ["--root", "{manager}"] }));
    // One call with only the changed fields.
    expect(settings.rpcCalls.filter((call) => call.method === "checks.configPatch")).toEqual([
      { method: "checks.configPatch", input: { projectId: project.id, patch: { branch: "main", script: "checks/run.py", args: ["--root", "{manager}"] } } },
    ]);
    expect(settings.rpcCalls.some((call) => call.method === "updateChecksSetting")).toBe(false);
    await waitFor(() => expect(within(section).queryByRole("button", { name: "Apply" })).toBeNull());
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
    fireEvent.click(within(await within(section).findByTestId("checks-retry")).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(db.prepare("SELECT outcome FROM checks_attempts").get()).toEqual({ outcome: "superseded" }));
    db.prepare("DELETE FROM checks_delivery").run();
    db.prepare("INSERT INTO checks_delivery(tracker_id, committed, committed_project) VALUES (?, x'7b7d', 'proj_old')").run(project.id);
    await waitFor(() => expect(within(section).queryByTestId("checks-retry")).toBeNull());
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
    fireEvent.click(within(section).getByRole("button", { name: "Apply" }));
    expect((await within(section).findByRole("alert")).textContent).toMatch(/^Failed: .*intervalMinutes/);
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
    // Disabling stays available with unapplied edits.
    expect(enabled().hasAttribute("disabled")).toBe(false);
    await harness.callRpc("updateChecksEnabled", { projectId: project.id, enabled: false });
    await settings.behavior.emitRealtime("projects:changed", { projectId: project.id });
    await waitFor(() => expect(enabled().getAttribute("aria-checked")).toBe("false"));
    expect((within(section).getByLabelText("Timeout (seconds)") as HTMLInputElement).value).toBe("60");
    fireEvent.click(within(section).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(checksService(bb).status(project.id).config.timeoutSeconds).toBe(60));
    expect(checksService(bb).status(project.id).config.enabled).toBe(false);
    // Snapshots is a switch that saves at once.
    fireEvent.click(within(section).getByRole("switch", { name: "Snapshots" }));
    await waitFor(() => expect(checksService(bb).status(project.id).config.snapshots).toBe(true));
  } finally { cleanup(); await harness.dispose(); }
});

it("restores the stored switch state when enabling is refused by another owner", async () => {
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
    expect(checksService(bb).status(project.id).config.enabled).toBe(false);
  } finally { cleanup(); await harness.dispose(); }
});

it("shows the manager thread's title, not its id, as the recipient of the last report", async () => {
  const { harness, project, rpc } = await setup();
  try {
    const rows = await rpc.getChecksStatus!({ projectId: project.id }) as Record<string, unknown>;
    rpc.getChecksStatus = async () => ({ ...rows, lastDelivery: { at: Date.now(), to: "thr_example", receipt: null, reportId: null, tickId: null } });
    const settings = renderSlot(app.settingsSections[0]!, {}, {
      rpc, sdk: { threads: { list: async () => [makeThreadResponse({ id: "thr_example", title: "Release coordinator" })] } } as never,
    });
    const status = await settings.findByTestId("checks-status");
    await waitFor(() => expect(status.textContent).toContain("to Release coordinator (recorded)"));
    expect(status.textContent).not.toContain("thr_example");
  } finally { cleanup(); await harness.dispose(); }
});

// The Repository checks card with its runner-paths block open, once the native values have loaded.
async function openRunner(settings: ReturnType<typeof renderSlot>) {
  const section = await settings.findByRole("region", { name: "Repository checks" });
  fireEvent.click(within(section).getByText("Runner paths (all projects)"));
  const cli = within(section).getByLabelText("BB CLI absolute path") as HTMLInputElement;
  const path = within(section).getByLabelText("Script PATH") as HTMLInputElement;
  await waitFor(() => expect(cli.disabled).toBe(false));
  return { section, cli, path };
}
const runnerWrites = (settings: ReturnType<typeof renderSlot>) => settings.rpcCalls.filter((call) => call.method === "globalSettings.set").map((call) => call.input);

it("saves the runner paths of all projects from the Repository checks card on blur or Enter only, never an invalid bb path", async () => {
  const { bb, harness, rpc } = await setup();
  try {
    const settings = renderSlot(app.settingsSections[0]!, {}, { rpc, settings: {} });
    const section = await settings.findByRole("region", { name: "Repository checks" });
    const runner = within(section).getByText("Runner paths (all projects)").closest("details")!;
    expect(runner.open).toBe(false);
    expect(runner.textContent).toContain("applies to all projects");
    const { cli, path } = await openRunner(settings);
    // A relative path shows its error and is never sent.
    fireEvent.change(cli, { target: { value: "bin/bb" } });
    expect(within(runner).getByRole("alert").textContent).toMatch(/absolute path/);
    fireEvent.blur(cli);
    fireEvent.keyDown(cli, { key: "Enter" });
    // A valid prefix typed during a pause is not sent either: only leaving the field or Enter saves.
    fireEvent.change(cli, { target: { value: "/opt" } });
    expect(within(runner).queryByRole("alert")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(runnerWrites(settings)).toEqual([]);
    fireEvent.change(cli, { target: { value: "/opt/bin/bb" } });
    fireEvent.keyDown(cli, { key: "Enter" });
    await waitFor(async () => expect(await getChecksEnvironment(bb)).toEqual({ bbCli: "/opt/bin/bb", runtimePath: "" }));
    await waitFor(() => expect(within(section).getByTestId("save-status").textContent).toBe("Saved"));
    fireEvent.change(path, { target: { value: "/usr/bin" } });
    fireEvent.blur(path);
    await waitFor(async () => expect(await getChecksEnvironment(bb)).toEqual({ bbCli: "/opt/bin/bb", runtimePath: "/usr/bin" }));
    // Each write names the stored value it was edited from.
    expect(runnerWrites(settings)).toEqual([
      { values: { checksBbCli: "/opt/bin/bb" }, expected: { checksBbCli: "" } },
      { values: { checksRuntimePath: "/usr/bin" }, expected: { checksRuntimePath: "" } },
    ]);
  } finally { cleanup(); await harness.dispose(); }
});

it("refuses a runner path changed in another window since the edit started, keeps the edit, and Reload shows the stored value", async () => {
  const { bb, harness, rpc } = await setup();
  try {
    const settings = renderSlot(app.settingsSections[0]!, {}, { rpc, settings: {} });
    const { section, path } = await openRunner(settings);
    fireEvent.change(path, { target: { value: "/usr/bin" } });
    await harness.callRpc("globalSettings.set", { values: { checksRuntimePath: "/opt/other" } });
    fireEvent.blur(path);
    const conflict = await within(section).findByTestId("runner-conflict");
    expect(conflict.textContent).toMatch(/^Changed elsewhere/);
    expect((await getChecksEnvironment(bb)).runtimePath).toBe("/opt/other");
    expect(path.value).toBe("/usr/bin");
    expect(within(section).queryByTestId("save-status")).toBeNull();
    // Leaving the field again writes nothing while the conflict stands.
    fireEvent.blur(path);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(runnerWrites(settings)).toHaveLength(1);
    fireEvent.click(within(conflict).getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(path.value).toBe("/opt/other"));
    expect(within(section).queryByTestId("runner-conflict")).toBeNull();
    // A new edit is built on the reloaded value.
    fireEvent.change(path, { target: { value: "/usr/bin" } });
    fireEvent.blur(path);
    await waitFor(async () => expect((await getChecksEnvironment(bb)).runtimePath).toBe("/usr/bin"));
    expect(runnerWrites(settings).at(-1)).toEqual({ values: { checksRuntimePath: "/usr/bin" }, expected: { checksRuntimePath: "/opt/other" } });
  } finally { cleanup(); await harness.dispose(); }
});

it("disables a runner field while its write is in flight and writes nothing over it; a revert after it is written", async () => {
  const { bb, harness, rpc } = await setup();
  try {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const write = rpc["globalSettings.set"]!;
    let first = true;
    rpc["globalSettings.set"] = async (input: unknown) => { if (first) { first = false; await held; } return write(input); };
    const settings = renderSlot(app.settingsSections[0]!, {}, { rpc, settings: {} });
    const { section, cli, path } = await openRunner(settings);
    fireEvent.change(path, { target: { value: "/a" } });
    fireEvent.keyDown(path, { key: "Enter" });
    await waitFor(() => expect(path.matches(":disabled")).toBe(true));
    // Enter, then the blur it causes, send one write; the other field stays editable.
    fireEvent.blur(path);
    expect(cli.matches(":disabled")).toBe(false);
    expect(runnerWrites(settings)).toHaveLength(1);
    release();
    await waitFor(() => expect(path.matches(":disabled")).toBe(false));
    await waitFor(() => expect(within(section).getByTestId("save-status").textContent).toBe("Saved"));
    expect(path.value).toBe("/a");
    fireEvent.change(path, { target: { value: "" } });
    fireEvent.blur(path);
    await waitFor(() => expect(runnerWrites(settings)).toHaveLength(2));
    await waitFor(async () => expect((await getChecksEnvironment(bb)).runtimePath).toBe(""));
    expect(runnerWrites(settings)).toEqual([
      { values: { checksRuntimePath: "/a" }, expected: { checksRuntimePath: "" } },
      { values: { checksRuntimePath: "" }, expected: { checksRuntimePath: "/a" } },
    ]);
  } finally { cleanup(); await harness.dispose(); }
});

it("disables a runner field while its Reload is in flight and shows the stored value after it", async () => {
  const { harness, rpc } = await setup();
  try {
    const settings = renderSlot(app.settingsSections[0]!, {}, { rpc, settings: {} });
    const { section, path } = await openRunner(settings);
    fireEvent.change(path, { target: { value: "/usr/bin" } });
    await harness.callRpc("globalSettings.set", { values: { checksRuntimePath: "/opt/other" } });
    fireEvent.blur(path);
    const conflict = await within(section).findByTestId("runner-conflict");
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const read = rpc["globalSettings.get"]!;
    rpc["globalSettings.get"] = async (input: unknown) => { await held; return read(input); };
    fireEvent.click(within(conflict).getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(path.matches(":disabled")).toBe(true));
    expect(path.value).toBe("/usr/bin");
    release();
    await waitFor(() => expect(path.matches(":disabled")).toBe(false));
    expect(path.value).toBe("/opt/other");
    expect(within(section).queryByTestId("runner-conflict")).toBeNull();
  } finally { cleanup(); await harness.dispose(); }
});

it("keeps a runner path whose save failed; Retry writes the field's current draft over the original value and hides while it is invalid", async () => {
  const { bb, harness, rpc } = await setup();
  try {
    let fail = true;
    const write = rpc["globalSettings.set"]!;
    rpc["globalSettings.set"] = async (input: unknown) => { if (fail) throw new Error("Settings are read-only"); return write(input); };
    const settings = renderSlot(app.settingsSections[0]!, {}, { rpc, settings: {} });
    const { section, cli } = await openRunner(settings);
    const status = () => within(section).queryByTestId("save-status");
    fireEvent.change(cli, { target: { value: "/opt/bin/bb" } });
    fireEvent.blur(cli);
    await waitFor(() => expect(status()?.textContent).toMatch(/^Failed: Settings are read-only/));
    expect(cli.value).toBe("/opt/bin/bb");
    // An invalid draft hides the Retry that would write the old path.
    fireEvent.change(cli, { target: { value: "bin/bb" } });
    expect(status()).toBeNull();
    // A new valid draft that fails offers Retry again; Retry sends the draft in the field at that time.
    fireEvent.change(cli, { target: { value: "/opt/bin/bb2" } });
    fireEvent.blur(cli);
    await waitFor(() => expect(within(status()!).getByRole("button", { name: "Retry" })).toBeTruthy());
    fireEvent.change(cli, { target: { value: "/opt/bin/bb3" } });
    fail = false;
    fireEvent.click(within(status()!).getByRole("button", { name: "Retry" }));
    await waitFor(async () => expect((await getChecksEnvironment(bb)).bbCli).toBe("/opt/bin/bb3"));
    expect(runnerWrites(settings).at(-1)).toEqual({ values: { checksBbCli: "/opt/bin/bb3" }, expected: { checksBbCli: "" } });
    await waitFor(() => expect(status()?.textContent).toBe("Saved"));
  } finally { cleanup(); await harness.dispose(); }
});

it("keeps one runner field's failure and Retry while the other field saves", async () => {
  const { bb, harness, rpc } = await setup();
  try {
    let fail = true;
    const write = rpc["globalSettings.set"]!;
    rpc["globalSettings.set"] = async (input: unknown) => {
      if (fail && "checksBbCli" in (input as { values: object }).values) throw new Error("Settings are read-only");
      return write(input);
    };
    const settings = renderSlot(app.settingsSections[0]!, {}, { rpc, settings: {} });
    const { section, cli, path } = await openRunner(settings);
    const status = () => within(section).getByTestId("save-status");
    fireEvent.change(cli, { target: { value: "/opt/bin/bb" } });
    fireEvent.blur(cli);
    await waitFor(() => expect(status().textContent).toMatch(/^Failed: Settings are read-only/));
    fireEvent.change(path, { target: { value: "/usr/bin" } });
    fireEvent.blur(path);
    await waitFor(async () => expect((await getChecksEnvironment(bb)).runtimePath).toBe("/usr/bin"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(status().textContent).toMatch(/^Failed: Settings are read-only/);
    fail = false;
    fireEvent.click(within(status()).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(status().textContent).toBe("Saved"));
    expect((await getChecksEnvironment(bb)).bbCli).toBe("/opt/bin/bb");
  } finally { cleanup(); await harness.dispose(); }
});

it("clears a runner field's failure when it is reverted to the stored value or refused as a conflict", async () => {
  const { harness, rpc } = await setup();
  try {
    let fail = true;
    const write = rpc["globalSettings.set"]!;
    rpc["globalSettings.set"] = async (input: unknown) => { if (fail) throw new Error("Settings are read-only"); return write(input); };
    const settings = renderSlot(app.settingsSections[0]!, {}, { rpc, settings: {} });
    const { section, path } = await openRunner(settings);
    const status = () => within(section).queryByTestId("save-status");
    fireEvent.change(path, { target: { value: "/usr/bin" } });
    fireEvent.blur(path);
    await waitFor(() => expect(status()?.textContent).toMatch(/^Failed: Settings are read-only/));
    // Back at the stored value: nothing is left to retry.
    fireEvent.change(path, { target: { value: "" } });
    fireEvent.blur(path);
    await waitFor(() => expect(status()).toBeNull());
    fireEvent.change(path, { target: { value: "/usr/bin" } });
    fireEvent.blur(path);
    await waitFor(() => expect(status()?.textContent).toMatch(/^Failed: Settings are read-only/));
    // Another window writes meanwhile: the Retry is refused as a conflict, which replaces the failure.
    await harness.callRpc("globalSettings.set", { values: { checksRuntimePath: "/opt/other" } });
    fail = false;
    fireEvent.click(within(status()!).getByRole("button", { name: "Retry" }));
    const conflict = await within(section).findByTestId("runner-conflict");
    expect(status()).toBeNull();
    fireEvent.click(within(conflict).getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(path.value).toBe("/opt/other"));
    expect(status()).toBeNull();
  } finally { cleanup(); await harness.dispose(); }
});

it("reloads only the conflicting runner field: the other field keeps its draft and its saved value", async () => {
  const { bb, harness, rpc } = await setup();
  try {
    const settings = renderSlot(app.settingsSections[0]!, {}, { rpc, settings: {} });
    const { section, cli, path } = await openRunner(settings);
    // The bb path is saved here, then typed again without leaving the field.
    fireEvent.change(cli, { target: { value: "/opt/bin/bb" } });
    fireEvent.blur(cli);
    await waitFor(async () => expect((await getChecksEnvironment(bb)).bbCli).toBe("/opt/bin/bb"));
    fireEvent.change(cli, { target: { value: "/opt/bin/bb2" } });
    // Another window changes both fields; only the script PATH conflicts here.
    fireEvent.change(path, { target: { value: "/usr/bin" } });
    await harness.callRpc("globalSettings.set", { values: { checksRuntimePath: "/opt/other", checksBbCli: "/srv/bb" } });
    fireEvent.blur(path);
    const conflict = await within(section).findByTestId("runner-conflict");
    fireEvent.click(within(conflict).getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(path.value).toBe("/opt/other"));
    expect(cli.value).toBe("/opt/bin/bb2");
    // Leaving the bb path field without its draft shows the value this page saved, not the one reloaded for the other key.
    fireEvent.change(cli, { target: { value: "/opt/bin/bb" } });
    fireEvent.blur(cli);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(cli.value).toBe("/opt/bin/bb");
    expect(runnerWrites(settings).filter((write) => "checksBbCli" in (write as { values: object }).values)).toHaveLength(1);
  } finally { cleanup(); await harness.dispose(); }
});
