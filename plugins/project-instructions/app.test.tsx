// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { rpcContract } from "./server";
import type { ConfigValues, ProjectStatus, StatusProject } from "./status-contract";

HTMLElement.prototype.scrollIntoView = vi.fn();
afterEach(() => {
  cleanup();
  localStorage.clear();
});
function leaveField(input: HTMLElement) {
  fireEvent.blur(input, { relatedTarget: document.body });
}

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

it("autosaves one field at a time, keeps invalid drafts and offers an inline retry", async () => {
  const read = (input: unknown) => config[(input as { key: keyof ConfigValues }).key];
  const save = vi.fn().mockImplementationOnce(() => { throw new Error("Write failed"); }).mockReturnValue("example/process");
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
  leaveField(branch);
  expect((await view.findByRole("alert")).textContent).toBe("must be a plain branch name");
  expect(branch.value).toBe("wrong branch");
  expect(save).not.toHaveBeenCalled();

  fireEvent.change(branch, { target: { value: "example/process" } });
  fireEvent.compositionStart(branch);
  fireEvent.keyDown(branch, { key: "Enter", isComposing: true });
  expect(save).not.toHaveBeenCalled();
  fireEvent.compositionEnd(branch);
  fireEvent.keyDown(branch, { key: "Enter" });
  expect((await view.findByRole("alert")).textContent).toBe("Write failed");
  expect(branch.value).toBe("example/process");
  const retry = view.getByRole("button", { name: "Retry saving Branch" });
  expect(retry.parentElement).toBe(branch.parentElement);
  fireEvent.click(retry);
  expect(await view.findByText("Saved")).toBeTruthy();
  expect(callsTo("config.set")).toEqual([
    { projectId: "proj_example", key: "branch", value: "example/process" },
    { projectId: "proj_example", key: "branch", value: "example/process" },
  ]);
  await waitFor(() => expect(detail).toHaveBeenCalledTimes(2));
  fireEvent.keyDown(view.getByRole("combobox", { name: "Project" }), { key: "Enter" });
  fireEvent.keyDown(await view.findByRole("option", { name: newProject.name }), { key: "Enter" });
  await waitFor(() => expect(callsTo("status.detail").at(-1)).toEqual({ projectId: "proj_other" }));
});


it("keeps a partial path in the draft and serializes completed edits for the same field", async () => {
  let resolveWrite!: (value: string) => void;
  const write = vi.fn(({ value }: { value: string }) => Promise.resolve(value))
    .mockImplementationOnce(() => new Promise<string>(resolve => { resolveWrite = resolve; }));
  const view = renderSlot(app.settingsSections[0], {}, {
    experimental_rpcContract: rpcContract,
    rpc: {
      "status.projects": () => [example],
      "status.detail": () => healthy,
      "config.get": input => config[(input as { key: keyof ConfigValues }).key],
      "config.set": input => write(input as { value: string }),
    },
  });
  const path = await view.findByRole("textbox", { name: "Clone path" }) as HTMLInputElement;
  fireEvent.change(path, { target: { value: "/example" } });
  vi.useFakeTimers();
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
  } finally {
    vi.useRealTimers();
  }
  expect(write).not.toHaveBeenCalled();

  fireEvent.change(path, { target: { value: "/example/process" } });
  leaveField(path);
  await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
  expect(view.getByText("Saving…").parentElement).toBe(path.parentElement);
  fireEvent.change(path, { target: { value: "/example/process-next" } });
  leaveField(path);
  expect(write).toHaveBeenCalledTimes(1);

  await act(async () => { resolveWrite("/example/process"); });
  await waitFor(() => expect(write.mock.calls.map(([call]) => call.value)).toEqual(["/example/process", "/example/process-next"]));
  expect(path.value).toBe("/example/process-next");
  expect(await view.findByText("Saved")).toBeTruthy();
});

it("restores an unsent draft without writing over a newer saved value", async () => {
  let branch = "main";
  const write = vi.fn(({ value }: { value: string }) => value);
  function openSettings() {
    return renderSlot(app.settingsSections[0], {}, {
      experimental_rpcContract: rpcContract,
      rpc: {
        "status.projects": () => [example],
        "status.detail": () => healthy,
        "config.get": input => {
          const { key } = input as { key: keyof ConfigValues };
          return key === "branch" ? branch : config[key];
        },
        "config.set": input => write(input as { value: string }),
      },
    });
  }
  const first = openSettings();
  const input = await first.findByRole("textbox", { name: "Branch" });
  fireEvent.change(input, { target: { value: "example/draft" } });
  first.unmount();

  branch = "example/remote";
  const reopened = openSettings();
  const restored = await reopened.findByRole("textbox", { name: "Branch" }) as HTMLInputElement;
  expect(restored.value).toBe("example/draft");
  expect((await reopened.findByRole("alert")).textContent).toContain("The saved value changed");
  leaveField(restored);
  expect(write).not.toHaveBeenCalled();
  fireEvent.click(reopened.getByRole("button", { name: "Retry saving Branch" }));
  await waitFor(() => expect(write).toHaveBeenCalledWith(expect.objectContaining({ value: "example/draft" })));
});

it("retains a newer local draft after a write from a previous settings view resolves", async () => {
  let branch = "main";
  let resolveWrite!: () => void;
  const write = vi.fn(({ value }: { value: string }) => new Promise<string>(resolve => {
    resolveWrite = () => { branch = value; resolve(value); };
  }));
  function openSettings() {
    return renderSlot(app.settingsSections[0], {}, {
      experimental_rpcContract: rpcContract,
      rpc: {
        "status.projects": () => [example],
        "status.detail": () => healthy,
        "config.get": input => {
          const { key } = input as { key: keyof ConfigValues };
          return key === "branch" ? branch : config[key];
        },
        "config.set": input => write(input as { value: string }),
      },
    });
  }

  const first = openSettings();
  const firstInput = await first.findByRole("textbox", { name: "Branch" });
  fireEvent.change(firstInput, { target: { value: "example/first" } });
  leaveField(firstInput);
  await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
  first.unmount();

  const second = openSettings();
  const secondInput = await second.findByRole("textbox", { name: "Branch" });
  fireEvent.change(secondInput, { target: { value: "example/newer" } });
  await act(async () => { resolveWrite(); });
  second.unmount();

  const reopened = openSettings();
  const restored = await reopened.findByRole("textbox", { name: "Branch" }) as HTMLInputElement;
  expect(restored.value).toBe("example/newer");
  expect(write).toHaveBeenCalledTimes(1);
});

it("keeps the draft when the window blurs or the page is hidden", async () => {
  const write = vi.fn(({ value }: { value: string }) => value);
  const view = renderSlot(app.settingsSections[0], {}, {
    experimental_rpcContract: rpcContract,
    rpc: {
      "status.projects": () => [example],
      "status.detail": () => healthy,
      "config.get": input => config[(input as { key: keyof ConfigValues }).key],
      "config.set": input => write(input as { value: string }),
    },
  });
  const path = await view.findByRole("textbox", { name: "Clone path" }) as HTMLInputElement;
  path.focus();
  fireEvent.change(path, { target: { value: "/example" } });

  const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
  try {
    fireEvent.blur(path);
    expect(write).not.toHaveBeenCalled();
  } finally {
    focus.mockRestore();
  }

  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  try {
    fireEvent.blur(path);
    expect(write).not.toHaveBeenCalled();
  } finally {
    visibility.mockRestore();
  }

  expect(path.value).toBe("/example");
  fireEvent.change(path, { target: { value: "/example/process" } });
  leaveField(path);
  await waitFor(() => expect(write).toHaveBeenCalledOnce());
  expect(write).toHaveBeenCalledWith(expect.objectContaining({ value: "/example/process" }));
});

it("keeps focus on a switch and ignores repeat activation during a pending write", async () => {
  let finishWrite!: (value: boolean) => void;
  const write = vi.fn(() => new Promise<boolean>(resolve => { finishWrite = resolve; }));
  const view = renderSlot(app.settingsSections[0], {}, {
    experimental_rpcContract: rpcContract,
    rpc: {
      "status.projects": () => [example],
      "status.detail": () => healthy,
      "config.get": input => config[(input as { key: keyof ConfigValues }).key],
      "config.set": write,
    },
  });
  const enabled = await view.findByRole("switch", { name: "Enabled" });
  enabled.focus();
  fireEvent.click(enabled);
  await waitFor(() => expect(write).toHaveBeenCalledOnce());
  expect(enabled.getAttribute("aria-disabled")).toBe("true");
  expect(document.activeElement).toBe(enabled);
  fireEvent.click(enabled);
  expect(write).toHaveBeenCalledOnce();
  await act(async () => { finishWrite(false); });
  expect(enabled.getAttribute("aria-checked")).toBe("false");
  expect(document.activeElement).toBe(enabled);
});
