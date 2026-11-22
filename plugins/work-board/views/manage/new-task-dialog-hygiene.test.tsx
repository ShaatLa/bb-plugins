// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { makeTask, rpcInput } from "../../test-fixtures.js";
import { NEW_TASK_DRAFT_STORAGE_KEY } from "./new-task-draft.js";

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
const app = await loadPluginApp(() => import("../../app"));
afterEach(() => { cleanup(); window.localStorage.clear(); });

const ID_A = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const ID_B = "01HZZZZZZZZZZZZZZZZZZZZZP2";
const base = { prefix: "EXA", nextTaskNumber: 5, color: "blue", folderId: null, linkedBbProjectId: null, createdAt: "2026-07-15T00:00:00.000Z" };
const projectA = { ...base, id: ID_A, name: "Alpha" };
const projectB = { ...base, id: ID_B, name: "Beta", prefix: "BET" };

function rpcWith(extra: Record<string, (input: unknown) => unknown>, calls: string[] = []) {
  const handlers: Record<string, (input: unknown) => unknown> = {
    listProjects: () => ({ projects: [projectA] }),
    listFolders: () => ({ folders: [] }),
    listPresets: () => ({ presets: [] }),
    sidebarSummary: () => ({ projects: [] }),
    listTasks: () => ({ tasks: [] }),
    listLabels: () => ({ labels: [] }),
    listBbProjects: () => ({ bbProjects: [] }),
    ...extra,
  };
  return Object.fromEntries(Object.entries(handlers).map(([method, handler]) => [method, (input: unknown) => { calls.push(method); return handler(input); }]));
}

const created = (input: Record<string, unknown>) => makeTask({ id: "01HZZZZZZZZZZZZZZZZZZZZZT1", projectId: String(input.projectId), key: "EXA-5", title: String(input.title) });

describe("closed New task / New project dialogs", () => {
  it("fire no dialog-only reads until opened", async () => {
    const calls: string[] = [];
    const slot = renderSlot(app.navPanels[0]!, { subPath: ID_A }, { rpc: rpcWith({}, calls) });
    await slot.findAllByRole("button", { name: /New task/ });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(calls).not.toContain("listBbProjects");
    const labelReads = calls.filter((call) => call === "listLabels").length;
    fireEvent.click((await slot.findAllByRole("button", { name: /New task/ }))[0]!);
    await slot.findByRole("button", { name: /^Task\b/ });
    await waitFor(() => expect(calls.filter((call) => call === "listLabels").length).toBeGreaterThan(labelReads));
  });

  it("keeps Create more across dismiss and reopen of the same dialog, and still submits", async () => {
    const creates: Record<string, unknown>[] = [];
    const slot = renderSlot(app.navPanels[0]!, { subPath: ID_A }, { rpc: rpcWith({ createTask: (raw) => { const input = rpcInput(raw); creates.push(input); return { ok: true, task: created(input) }; } }) });
    const open = async () => { fireEvent.click((await slot.findAllByRole("button", { name: /New task/ }))[0]!); fireEvent.click(await slot.findByRole("button", { name: /^Task\b/ })); };
    await open();
    fireEvent.click(await slot.findByRole("checkbox", { name: "Create more" }));
    fireEvent.keyDown(slot.getByLabelText("Task title"), { key: "Escape" });
    await waitFor(() => expect(slot.queryByLabelText("Task title")).toBeNull());
    await open();
    expect((await slot.findByRole("checkbox", { name: "Create more" })).getAttribute("aria-checked") ?? (slot.getByRole("checkbox", { name: "Create more" }) as HTMLInputElement).checked).toSatisfy((value: unknown) => value === true || value === "true");
    fireEvent.change(slot.getByLabelText("Task title"), { target: { value: "Again" } });
    fireEvent.click(slot.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(creates).toHaveLength(1));
    expect(slot.getByLabelText("Task title")).toBeTruthy();
  });

  it("purges a legacy persisted draft on shell entry without opening the dialog", async () => {
    window.localStorage.setItem(NEW_TASK_DRAFT_STORAGE_KEY, JSON.stringify({ title: "legacy" }));
    const slot = renderSlot(app.navPanels[0]!, { subPath: ID_A }, { rpc: rpcWith({}) });
    await slot.findAllByRole("button", { name: /New task/ });
    expect(window.localStorage.getItem(NEW_TASK_DRAFT_STORAGE_KEY)).toBeNull();
  });

  it("keeps the caller's project while the project list does not hold it yet", async () => {
    const creates: Record<string, unknown>[] = [];
    let listed = [projectA];
    const slot = renderSlot(app.navPanels[0]!, { subPath: ID_B }, { rpc: rpcWith({
      listProjects: () => ({ projects: listed }),
      createTask: (raw) => { const input = rpcInput(raw); creates.push(input); return { ok: true, task: created(input) }; },
    }) });
    fireEvent.click((await slot.findAllByRole("button", { name: /New task/ }))[0]!);
    fireEvent.click(await slot.findByRole("button", { name: /^Task\b/ }));
    // Typing before the list holds the route's project must not retarget the draft to the first project.
    fireEvent.change(await slot.findByLabelText("Task title"), { target: { value: "Before B arrives" } });
    listed = [projectA, projectB];
    await slot.behavior.emitRealtime("projects:changed", {});
    fireEvent.click(slot.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(creates).toHaveLength(1));
    expect(creates[0]!.projectId).toBe(ID_B);
  });
});
