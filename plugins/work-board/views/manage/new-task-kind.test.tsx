// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { makeTask, rpcInput } from "../../test-fixtures.js";

window.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView ??= () => {};
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

const app = await loadPluginApp(() => import("../../app"));
const { NEW_TASK_DRAFT_STORAGE_KEY } = await import("./new-task-draft.js");

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const PRESET_ID = "01HZZZZZZZZZZZZZZZZZZZZZR1";
const S1 = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-11-07T10:00:00.000Z";
const project = {
  id: PROJECT_ID,
  name: "Tasks Plugin",
  prefix: "TSK",
  nextTaskNumber: 5,
  color: "blue",
  folderId: null,
  linkedBbProjectId: null,
  createdAt: NOW,
};
const preset = {
  id: PRESET_ID,
  name: "Nightly agent",
  providerId: "p",
  modelId: "m1",
  reasoningLevel: "medium",
  serviceTier: null,
  permissionMode: "default",
  environmentKind: "current",
  baseBranch: null,
  machineId: null,
  instructions: "",
  builtin: false,
  createdAt: NOW,
};

function harness() {
  const createTask: Array<Record<string, unknown>> = [];
  const createSchedule: Array<Record<string, unknown>> = [];
  const rpc = {
    listProjects: () => ({ projects: [project] }),
    listFolders: () => ({ folders: [] }),
    listPresets: () => ({ presets: [preset] }),
    sidebarSummary: () => ({ projects: [] }),
    listTasks: (raw: unknown) => ({
      tasks:
        rpcInput(raw).type === "epic"
          ? [makeTask({ id: "01HZZZZZZZZZZZZZZZZZZZZZE1", projectId: PROJECT_ID, key: "TSK-1", title: "Big epic", type: "epic" })]
          : [],
      nextCursor: null,
    }),
    listLabels: () => ({ labels: [] }),
    getBoardPreferences: () => ({}),
    previewSchedule: () => ({ dates: ["2026-11-08T08:00:00.000Z"] }),
    createTask: (raw: unknown) => {
      const input = rpcInput(raw);
      createTask.push(input);
      return {
        ok: true,
        task: makeTask({
          id: "01HZZZZZZZZZZZZZZZZZZZZZT1",
          projectId: PROJECT_ID,
          key: "TSK-5",
          title: String(input.title),
          type: input.type as "task" | "epic",
        }),
      };
    },
    createSchedule: (raw: unknown) => {
      const input = rpcInput(raw);
      createSchedule.push(input);
      return {
        schedule: {
          id: S1,
          projectId: PROJECT_ID,
          templateTaskId: "01HZZZZZZZZZZZZZZZZZZZZZT9",
          title: String(input.title),
          rule: input.rule,
          target: input.target,
          enabled: true,
          nextDueAt: "2026-11-08T08:00:00.000Z",
          createdAt: NOW,
          updatedAt: NOW,
          overlapRunIds: [],
        },
      };
    },
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: PROJECT_ID }, { rpc });
  return { slot, createTask, createSchedule };
}
type Slot = ReturnType<typeof harness>["slot"];

async function openChooser(slot: Slot) {
  fireEvent.click((await slot.findAllByRole("button", { name: /New task/ }))[0]!);
  await slot.findByRole("button", { name: "Scheduled task" });
}
const choose = async (slot: Slot, name: "Task" | "Epic" | "Scheduled task") =>
  fireEvent.click(await slot.findByRole("button", { name }));
const titleInput = async (slot: Slot) =>
  (await slot.findByLabelText("Task title")) as HTMLInputElement;

describe("New task creation kind chooser", () => {
  it("offers Task, Epic and Scheduled task first, and Cancel creates nothing", async () => {
    const { slot, createTask, createSchedule } = harness();
    await openChooser(slot);
    expect(slot.getByRole("button", { name: "Task" })).toBeTruthy();
    expect(slot.getByRole("button", { name: "Epic" })).toBeTruthy();
    expect(slot.queryByLabelText("Task title")).toBeNull();

    fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(slot.queryByRole("button", { name: "Epic" })).toBeNull());
    expect(createTask).toEqual([]);
    expect(createSchedule).toEqual([]);
  });

  it("opens a fixed Epic form without a type dropdown and creates an epic", async () => {
    const { slot, createTask } = harness();
    await openChooser(slot);
    await choose(slot, "Epic");
    fireEvent.change(await titleInput(slot), { target: { value: "Launch initiative" } });
    expect(slot.queryByRole("button", { name: "Type" })).toBeNull();
    expect(slot.queryByRole("button", { name: "Epic" })).toBeNull(); // no parent-epic picker for an epic
    expect(createTask).toEqual([]); // nothing is created before the explicit submit

    fireEvent.click(slot.getByRole("button", { name: "Create epic" }));
    await waitFor(() => expect(createTask).toHaveLength(1));
    expect(createTask[0]).toMatchObject({ title: "Launch initiative", type: "epic", epicId: null });
  });

  it("keeps input and staged files across Back, releases files on close and clears the draft on success", async () => {
    const { slot, createTask } = harness();
    await openChooser(slot);
    await choose(slot, "Task");
    const title = await titleInput(slot);
    fireEvent.change(title, { target: { value: "Keep me" } });
    fireEvent.paste(title, {
      clipboardData: { files: [new File(["png"], "shot.png", { type: "image/png" })], types: [] },
    });
    await slot.findByText("shot.png");

    fireEvent.click(slot.getByRole("button", { name: "Back" }));
    await slot.findByRole("button", { name: "Scheduled task" });
    expect(slot.queryByLabelText("Task title")).toBeNull();
    expect(createTask).toEqual([]);

    await choose(slot, "Epic");
    expect((await titleInput(slot)).value).toBe("Keep me");
    await slot.findByText("shot.png");

    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(slot.queryByLabelText("Task title")).toBeNull());
    await openChooser(slot);
    await choose(slot, "Task");
    expect((await titleInput(slot)).value).toBe(""); // the draft does not outlive the dialog
    expect(slot.queryByText("shot.png")).toBeNull(); // neither do staged files
    expect(window.localStorage.getItem(NEW_TASK_DRAFT_STORAGE_KEY)).toBeNull();
    expect(createTask).toEqual([]);

    fireEvent.change(await titleInput(slot), { target: { value: "Fresh" } });
    fireEvent.click(slot.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(createTask).toHaveLength(1));
    expect(createTask[0]).toMatchObject({ title: "Fresh", type: "task" });
    expect(window.localStorage.getItem(NEW_TASK_DRAFT_STORAGE_KEY)).toBeNull();
  });

  it("keeps the parent epic when switching Task -> Epic -> Task, and never sends it for an epic", async () => {
    const { slot, createTask } = harness();
    await openChooser(slot);
    await choose(slot, "Task");
    fireEvent.change(await titleInput(slot), { target: { value: "Child" } });
    fireEvent.click(slot.getByRole("button", { name: "Epic" })); // the parent-epic picker
    fireEvent.click(await slot.findByRole("option", { name: /Big epic/ }));
    await waitFor(() => expect(slot.getByRole("button", { name: "Epic" }).textContent).toContain("TSK-1"));

    fireEvent.click(slot.getByRole("button", { name: "Back" }));
    await choose(slot, "Epic");
    expect(slot.queryByRole("button", { name: "Epic" })).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Back" }));
    await choose(slot, "Task");
    await waitFor(() => expect(slot.getByRole("button", { name: "Epic" }).textContent).toContain("TSK-1"));
    expect(createTask).toEqual([]);

    fireEvent.click(slot.getByRole("button", { name: "Back" }));
    await choose(slot, "Epic");
    fireEvent.click(slot.getByRole("button", { name: "Create epic" }));
    await waitFor(() => expect(createTask).toHaveLength(1));
    expect(createTask[0]).toMatchObject({ type: "epic", epicId: null });
  });

  it("opens the existing Schedule dialog, creates only a schedule and does not send the ordinary draft", async () => {
    const { slot, createTask, createSchedule } = harness();
    await openChooser(slot);
    await choose(slot, "Task");
    fireEvent.change(await titleInput(slot), { target: { value: "Ordinary draft" } });
    fireEvent.click(slot.getByRole("button", { name: "Back" }));
    await choose(slot, "Scheduled task");

    const scheduleTitle = (await slot.findByLabelText("Schedule title")) as HTMLInputElement;
    expect(scheduleTitle.value).toBe(""); // the ordinary draft is not sent to the schedule form
    fireEvent.change(scheduleTitle, { target: { value: "Morning digest" } });
    await slot.findByText(/Next runs/);
    fireEvent.click(slot.getByRole("button", { name: "Preset" }));
    fireEvent.click(await slot.findByRole("option", { name: /Nightly agent/ }));
    const create = slot.getByRole("button", { name: "Create schedule" });
    await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false));
    expect(createSchedule).toEqual([]);

    fireEvent.click(create);
    await waitFor(() => expect(createSchedule).toHaveLength(1));
    expect(createSchedule[0]).toMatchObject({
      projectId: PROJECT_ID,
      title: "Morning digest",
      target: { kind: "preset", presetId: PRESET_ID },
      rule: { kind: "daily", time: "09:00" },
      enabled: true,
    });
    expect(createTask).toEqual([]);
    await waitFor(() =>
      expect(slot.navigateCalls).toContainEqual({
        method: "toPluginPanel",
        path: "work-board",
        options: { subPath: "scheduled" },
      }),
    );
    expect(window.localStorage.getItem(NEW_TASK_DRAFT_STORAGE_KEY)).toBeNull();
  });

  it("keeps the schedule form across Back, and Cancel closes everything fresh without creating anything", async () => {
    const { slot, createTask, createSchedule } = harness();
    await openChooser(slot);
    await choose(slot, "Scheduled task");
    fireEvent.change(await slot.findByLabelText("Schedule title"), { target: { value: "Weekly report" } });
    fireEvent.click(slot.getByRole("button", { name: "Weekly" }));

    fireEvent.click(slot.getByRole("button", { name: "Back" }));
    await slot.findByRole("button", { name: "Epic" });
    expect(slot.queryByLabelText("Schedule title")).toBeNull();
    await choose(slot, "Scheduled task");
    expect(((await slot.findByLabelText("Schedule title")) as HTMLInputElement).value).toBe("Weekly report");
    expect(slot.getByRole("button", { name: "Weekly" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(slot.queryByLabelText("Schedule title")).toBeNull());
    await openChooser(slot);
    await choose(slot, "Scheduled task");
    expect(((await slot.findByLabelText("Schedule title")) as HTMLInputElement).value).toBe("");
    expect(createTask).toEqual([]);
    expect(createSchedule).toEqual([]);
  });
});
