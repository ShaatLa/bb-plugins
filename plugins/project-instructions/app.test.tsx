// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { rpcContract } from "./server";
import type { ConfigValues, ProjectStatus, StatusProject } from "./status-contract";

HTMLElement.prototype.scrollIntoView = vi.fn();
afterEach(cleanup);
const app = await loadPluginApp(() => import("./app"));
const example: StatusProject = { id: "proj_example", name: "Example", available: true, configured: true, enabled: true, allowSync: true };
const newProject: StatusProject = { id: "proj_other", name: "Other example", available: true, configured: false, enabled: false, allowSync: false };
const config: ConfigValues = {
  clonePath: "/path/to/example-process", branch: "main", rootFile: "ROOT.md", skillsDir: ".bb/skills",
  enabled: true, allowSync: true,
};
const healthy: ProjectStatus = {
  enabled: true, allowSync: true, rootFile: "ROOT.md",
  source: { ok: true, rootPath: "/path/to/example-process/ROOT.md", rootLength: 21, cap: 4096, branch: "main" },
  preview: "<b>Example notes</b>",
  skills: { selectable: ["example-check"], skipped: [], moreSkipped: 0 },
  sync: {
    lastAttempt: { at: 1, outcome: "up_to_date", reason: null },
    lastUpdate: { at: 0, from: "aaaabbbb", to: "bbbbcccc" },
  },
};

it("opens the dedicated status page with a root preview and sync history", async () => {
  const status = vi.fn(() => healthy);
  const view = renderSlot(app.navPanels[0], { subPath: "" }, {
    experimental_rpcContract: rpcContract,
    rpc: { "status.projects": () => [example, newProject], "status.detail": status },
  });
  expect(await view.findByRole("heading", { name: "Example" })).toBeTruthy();
  expect(await view.findByText("example-check")).toBeTruthy();
  expect(view.getByText(/21 \/ 4,096/)).toBeTruthy();
  expect(view.getByText(/Up to date/)).toBeTruthy();
  expect(view.getByText("aaaabbb")).toBeTruthy();
  expect(view.queryByText("Other example")).toBeNull();
  fireEvent.click(view.getByText("Preview ROOT.md"));
  expect(view.getByText("<b>Example notes</b>").tagName).toBe("PRE");
  fireEvent.click(view.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(status).toHaveBeenCalledTimes(2));
});

it("shows RPC errors and can retry into the empty status page", async () => {
  const projects = vi.fn(() => [newProject]).mockImplementationOnce(() => { throw new Error("Projects unavailable"); });
  const view = renderSlot(app.navPanels[0], { subPath: "" }, { experimental_rpcContract: rpcContract, rpc: { "status.projects": projects } });
  expect((await view.findByRole("alert")).textContent).toBe("Projects unavailable");
  fireEvent.click(view.getByRole("button", { name: "Refresh" }));
  expect(await view.findByText("No projects are configured.")).toBeTruthy();
  expect(view.getByRole("link", { name: "Open plugin settings" }).getAttribute("href")).toBe("/settings/plugins/project-instructions");
});

it("saves one field at a time, keeps an invalid draft and refreshes the source check", async () => {
  const read = (input: unknown) => config[(input as { key: keyof ConfigValues }).key];
  const save = vi.fn().mockImplementationOnce(() => { throw new Error("branch must be a plain branch name"); }).mockReturnValue("example/process");
  const detail = vi.fn(() => healthy);
  const view = renderSlot(app.settingsSections[0], {}, {
    experimental_rpcContract: rpcContract,
    rpc: { "status.projects": () => [example, newProject], "status.detail": detail, "config.get": read, "config.set": save },
  });
  const branch = await view.findByRole("textbox", { name: "Branch" }) as HTMLInputElement;
  expect(branch.value).toBe("main");
  const callsTo = (method: string) => view.inspection.rpcCalls.filter(call => call.method === method).map(call => call.input);
  expect(callsTo("config.get")).toEqual(Object.keys(config).map(key => ({ projectId: "proj_example", key })));
  fireEvent.change(branch, { target: { value: "wrong branch" } });
  fireEvent.click(view.getByRole("button", { name: "Save branch" }));
  expect((await view.findByRole("alert")).textContent).toBe("branch must be a plain branch name");
  expect(branch.value).toBe("wrong branch");
  fireEvent.change(branch, { target: { value: "example/process" } });
  fireEvent.click(view.getByRole("button", { name: "Save branch" }));
  expect(await view.findByText("Saved")).toBeTruthy();
  expect(callsTo("config.set")).toEqual([
    { projectId: "proj_example", key: "branch", value: "wrong branch" },
    { projectId: "proj_example", key: "branch", value: "example/process" },
  ]);
  await waitFor(() => expect(detail).toHaveBeenCalledTimes(2));
  fireEvent.keyDown(view.getByRole("combobox", { name: "Project" }), { key: "Enter" });
  fireEvent.keyDown(await view.findByRole("option", { name: newProject.name }), { key: "Enter" });
  await waitFor(() => expect(callsTo("status.detail").at(-1)).toEqual({ projectId: "proj_other" }));
});
