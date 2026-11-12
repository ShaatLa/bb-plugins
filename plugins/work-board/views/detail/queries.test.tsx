// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { makeTask, rpcInput } from "../../test-fixtures.js";

if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  });
}
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const app = await loadPluginApp(() => import("../../app"));
afterEach(cleanup);

const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const task = makeTask({ id: "01HZZZZZZZZZZZZZZZZZZZZZT5", projectId: PROJECT_ID, number: 5, key: "TSK-5", title: "Open task", position: 1 });
const sibling = makeTask({ id: "01HZZZZZZZZZZZZZZZZZZZZZT6", projectId: PROJECT_ID, number: 6, key: "TSK-6", title: "Sibling", position: 2 });
const OTHER_ID = "01HZZZZZZZZZZZZZZZZZZZZZT9";
const epic = (id: string, number: number) => makeTask({ id, projectId: PROJECT_ID, number, key: `TSK-${number}`, title: `Epic ${number}`, type: "epic", position: number });

const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

function render(epics: () => ReturnType<typeof epic>[] = () => []) {
  return renderSlot(app.navPanels[0]!, { subPath: "task/TSK-5" }, { rpc: {
    listTaskDependencies: () => ({ blockedBy: [], blocks: [] }),
    listProjects: () => ({ projects: [{ id: PROJECT_ID, name: "Tasks", prefix: "TSK", nextTaskNumber: 10, color: "blue", folderId: null, linkedBbProjectId: null, createdAt: "2026-07-15T00:00:00.000Z" }] }),
    listFolders: () => ({ folders: [] }),
    listPresets: () => ({ presets: [] }),
    sidebarSummary: () => ({ projects: [] }),
    getTaskByKey: () => ({ task }),
    getTask: (input: unknown) => ({ task: [task, sibling, ...epics()].find((entry) => entry.id === rpcInput(input).taskId) ?? null }),
    listTasks: (input: unknown) => {
      const query = rpcInput(input);
      return { tasks: query.type === "epic" ? epics() : query.parentTaskId || query.epicId ? [] : [task, sibling] };
    },
    listLabels: () => ({ labels: [] }),
    listAttachments: () => ({ attachments: [] }),
    listTaskThreads: () => ({ taskThreads: [] }),
    listTaskPullRequests: () => ({ pullRequests: [], unavailableThreadIds: [] }),
    listPrLinks: () => ({ links: [], overlaps: [] }),
    listQuestions: () => ({ questions: [] }),
    listComments: () => ({ comments: [] }),
    listBbProjects: () => ({ bbProjects: [] }),
    listTaskCardMeta: () => ({ metadata: [] }),
  } });
}

describe("task detail realtime cost", () => {
  it("makes no list/read RPCs for a tasks:changed event on an unrelated task", async () => {
    const slot = render();
    await slot.findByRole("textbox", { name: "Task title" });
    await slot.findByText("1 / 2");
    await settle();
    const before = slot.rpcCalls.length;
    await slot.behavior.emitRealtime("tasks:changed", { taskId: OTHER_ID, projectId: PROJECT_ID });
    await settle();
    // Only the shared-dataset patch (one getTask per search/pager subscriber) is allowed; no list or detail refetch.
    const added = slot.rpcCalls.slice(before).filter(({ method }) => method !== "getTask");
    expect(added).toEqual([]);
  });

  it("reads PR links once for an event on the open task", async () => {
    const slot = render();
    await slot.findByRole("textbox", { name: "Task title" });
    await settle();
    const count = () => slot.rpcCalls.filter(({ method }) => method === "listPrLinks").length;
    expect(count()).toBe(1);
    await slot.behavior.emitRealtime("tasks:changed", { taskId: task.id, projectId: PROJECT_ID });
    await waitFor(() => expect(count()).toBe(2));
    await settle();
    expect(count()).toBe(2);
  });

  it("still lists an epic created elsewhere once the picker is opened", async () => {
    const epics = [epic("01HZZZZZZZZZZZZZZZZZZZZZE1", 7)];
    const slot = render(() => epics);
    await slot.findByRole("textbox", { name: "Task title" });
    await settle();
    epics.push(epic("01HZZZZZZZZZZZZZZZZZZZZZE2", 8));
    await slot.behavior.emitRealtime("tasks:changed", { taskId: "01HZZZZZZZZZZZZZZZZZZZZZE2", projectId: PROJECT_ID });
    await settle();
    fireEvent.click(slot.getAllByRole("button", { name: "Epic" })[0]!);
    await slot.findByText("TSK-8 · Epic 8");
  });
});
