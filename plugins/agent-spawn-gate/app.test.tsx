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
  const write = vi.fn(async ({ projectId, values }) => { const project = projects.find(p => p.id === projectId)!; project.values = values; return values; });
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
  await choose("Other — off");
  expect(slot.queryByLabelText("Launch script")).toBeNull();
  expect(slot.getByLabelText("Launch method")).toBeTruthy();
  expect(slot.getAllByRole("switch")).toHaveLength(1);
  await act(async () => { fireEvent.click(slot.getByRole("switch")); });
  expect(write).toHaveBeenCalledTimes(1);
  expect(write).toHaveBeenCalledWith(expect.objectContaining({ projectId: "proj_other", values: expect.objectContaining({ enabled: true }) }));
  await choose("Third — off");
  expect(slot.getByRole("switch").getAttribute("aria-checked")).toBe("false");
  await choose("Other — on");
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
