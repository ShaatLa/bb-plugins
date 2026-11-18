// @vitest-environment jsdom
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
const app = await loadPluginApp(() => import("./app"));
afterEach(cleanup);
HTMLElement.prototype.scrollIntoView = vi.fn();
it("renders one project form and saves only the selected project", async () => {
  const defaults = { enabled: false, method: "instruction", instruction: "Review the task.", script: "spawn.py", ttlMinutes: 10 };
  const projects = [
    { id: "proj_sample", name: "Sample", values: { ...defaults, method: "script", script: "tools/spawn.py" } },
    { id: "proj_other", name: "Other", values: { ...defaults } },
    { id: "proj_third", name: "Third", values: { ...defaults } },
  ];
  const write = vi.fn(async ({ projectId, values }) => { const project = projects.find(p => p.id === projectId)!; project.values = { ...project.values, ...values }; return project.values; });
  const slot = renderSlot(app.settingsSections[0], {}, { rpc: { "settings.read": () => ({ projects }), "settings.write": write } });
  await slot.findByRole("combobox", { name: "Project" });
  async function choose(name: string) {
    fireEvent.keyDown(slot.getByRole("combobox", { name: "Project" }), { key: "Enter" });
    const option = await slot.findByRole("option", { name });
    await act(async () => { fireEvent.keyDown(option, { key: "Enter" }); });
  }
  expect(slot.getAllByRole("switch")).toHaveLength(1);
  expect(slot.queryByRole("button", { name: "Save" })).toBeNull();
  expect(write).not.toHaveBeenCalled();
  expect(slot.getByLabelText("Launch script")).toBeTruthy();
  await choose("Other");
  expect(slot.queryByLabelText("Launch script")).toBeNull();
  expect(slot.getByLabelText("Launch method")).toBeTruthy();
  expect(slot.getAllByRole("switch")).toHaveLength(1);
  await act(async () => { fireEvent.click(slot.getByRole("switch")); });
  expect(write).toHaveBeenCalledTimes(1);
  expect(write).toHaveBeenCalledWith(expect.objectContaining({ projectId: "proj_other", values: expect.objectContaining({ enabled: true }) }));
  await choose("Third");
  expect(slot.getByRole("switch").getAttribute("aria-checked")).toBe("false");
  await choose("Other");
  expect(slot.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  expect(projects[0].values.enabled).toBe(false);
});

it("serializes autosaves without replacing controls, losing focus or overwriting newer edits", async () => {
  const values = { enabled: false, method: "script", instruction: "", script: "spawn.py", ttlMinutes: 10 };
  let finish!: (value: typeof values) => void;
  const write = vi.fn(async ({ values }) => values);
  write.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const read = vi.fn(() => ({ projects: [{ id: "proj_sample", name: "Sample", values }] }));
  const slot = renderSlot(app.settingsSections[0], {}, { rpc: { "settings.read": read, "settings.write": write } });
  const input = await slot.findByLabelText("Launch script") as HTMLInputElement;
  input.focus();
  await act(async () => { fireEvent.change(input, { target: { value: "first.py" } }); });
  await act(async () => { fireEvent.change(input, { target: { value: "second.py" } }); });
  input.setSelectionRange(3, 3);
  expect(write).toHaveBeenCalledTimes(1);
  expect(input.disabled).toBe(false);
  await act(async () => { finish({ ...values, script: "first.py" }); });
  expect(write).toHaveBeenCalledTimes(2);
  expect(write.mock.calls.map(([request]) => request.values.script)).toEqual(["first.py", "second.py"]);
  expect(slot.getByLabelText("Launch script")).toBe(input);
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe("second.py");
  expect(input.selectionStart).toBe(3);
  expect(read).toHaveBeenCalledTimes(1);
});

it("keeps invalid drafts editable and reports failed autosaves without blocking a retry", async () => {
  const values = { enabled: false, method: "script", instruction: "", script: "spawn.py", ttlMinutes: 10 };
  const write = vi.fn(async ({ values }) => values).mockRejectedValueOnce(new Error("Offline"));
  const slot = renderSlot(app.settingsSections[0], {}, { rpc: { "settings.read": () => ({ projects: [{ id: "proj_sample", name: "Sample", values }] }), "settings.write": write } });
  const input = await slot.findByLabelText("Admission lifetime, minutes") as HTMLInputElement;
  await act(async () => { fireEvent.change(input, { target: { value: "" } }); });
  expect(input.value).toBe("");
  expect(write).not.toHaveBeenCalled();
  expect(slot.getByRole("status").textContent).toContain("Enter valid values");
  await act(async () => { fireEvent.change(input, { target: { value: "20" } }); });
  expect(slot.getByRole("alert").textContent).toContain("Offline");
  await act(async () => { fireEvent.change(input, { target: { value: "21" } }); });
  expect(write).toHaveBeenCalledTimes(2);
  expect(slot.getByRole("alert").textContent).toBe("");
  expect(slot.getByLabelText("Admission lifetime, minutes")).toBe(input);
});

it("uses the sidebar's project and UTC period for activity and edits that same project's settings", async () => {
  const defaults = { enabled: false, method: "instruction", instruction: "Review the task.", script: "spawn.py", ttlMinutes: 10 };
  const projects = [
    { id: "proj_sample", name: "Sample", values: { ...defaults, method: "script" } },
    { id: "proj_other", name: "Other", values: { ...defaults } },
  ];
  const report = vi.fn(({ projectId, from, to }) => ({
    from, to, coverageStartedAt: "2025-01-01T12:00:00.000Z",
    projects: [{
      projectId, name: projectId === "proj_sample" ? "Sample" : "Other", starts: projectId === "proj_sample" ? 4 : 6, dryRuns: 2, blockedStarts: 1,
      refusals: projectId === "proj_sample" ? [{ operation: "dispatch", reason: "missing_admission", count: 1 }] : [],
    }],
  }));
  const write = vi.fn(async ({ values }) => values);
  const panel = app.navPanels[0]!;
  expect(panel.title).toBe("Spawn Gate");
  const slot = renderSlot(panel, { subPath: "" }, {
    rpc: { "settings.read": () => ({ projects }), report, "settings.write": write },
  });
  expect(await slot.findByRole("cell", { name: "missing_admission" })).toBeTruthy();
  const initial = report.mock.calls[0]![0];
  expect(initial.projectId).toBe("proj_sample");
  expect(Date.parse(initial.to) - Date.parse(initial.from)).toBe(6 * 86_400_000);

  async function choose(label: string, optionName: string) {
    fireEvent.keyDown(slot.getByRole("combobox", { name: label }), { key: "Enter" });
    const option = await slot.findByRole("option", { name: optionName });
    await act(async () => { fireEvent.keyDown(option, { key: "Enter" }); });
  }
  await choose("Period", "Today");
  expect(report.mock.calls.at(-1)?.[0]).toEqual({ projectId: "proj_sample", from: initial.to, to: initial.to });
  await choose("Project", "Other");
  expect(report.mock.calls.at(-1)?.[0]).toEqual({ projectId: "proj_other", from: initial.to, to: initial.to });
  await slot.findByText("6");
  expect(slot.queryByRole("table", { name: "Refusals by reason" })).toBeNull();
  expect(slot.queryByText("No refusals recorded in this period.")).toBeNull();
  expect(slot.getByRole("heading", { name: "Spawn Gate" }).parentElement?.contains(slot.getByRole("switch"))).toBe(true);
  write.mockRejectedValueOnce(new Error("Offline"));
  await act(async () => { fireEvent.click(slot.getByRole("switch")); });
  expect(slot.getByRole("switch").getAttribute("aria-checked")).toBe("false");
  expect(slot.getByRole("alert").textContent).toContain("Offline");
  await act(async () => { fireEvent.click(slot.getByRole("switch")); });
  expect(slot.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  expect(write).toHaveBeenCalledWith({ projectId: "proj_other", values: { enabled: true } });
  fireEvent.click(slot.getByText("Project settings"));
  await act(async () => { fireEvent.change(slot.getByLabelText("Launch instructions"), { target: { value: "Follow the launch checklist." } }); });
  expect(write.mock.calls.at(-1)?.[0].values).not.toHaveProperty("enabled");
});

it("shows the single project without an active selector and links to plugin settings", async () => {
  const projects = [{ id: "proj_sample", name: "Sample", values: {
    enabled: false, method: "script", instruction: "", script: "spawn.py", ttlMinutes: 10,
  } }];
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
    rpc: {
      "settings.read": () => ({ projects }),
      report: () => ({
        from: "2025-01-01", to: "2025-01-01", coverageStartedAt: "2025-01-01T00:00:00.000Z",
        projects: [{ projectId: "proj_sample", name: "Sample", starts: 0, dryRuns: 0, blockedStarts: 0, refusals: [] }],
      }),
    },
  });
  const selector = await slot.findByRole("combobox", { name: "Project" });
  expect((selector as HTMLButtonElement).disabled).toBe(true);
  expect(selector.textContent).toBe("Sample");
  expect(slot.getByRole("link", { name: "Plugin settings" }).getAttribute("href")).toBe("/settings/plugins/agent-spawn-gate");
});
