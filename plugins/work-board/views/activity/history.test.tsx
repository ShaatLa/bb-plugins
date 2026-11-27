// @vitest-environment jsdom
import { cleanup, fireEvent } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { makeTask, rpcInput } from "../../test-fixtures.js";

const app = await loadPluginApp(() => import("../../app"));
afterEach(cleanup);
const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const TASK_ID = "01HZZZZZZZZZZZZZZZZZZZZZT5";
const task = makeTask({ id: TASK_ID, projectId: PROJECT_ID, number: 5, key: "TSK-5", title: "Example task", position: 1 });
function detailRpc(overrides: Record<string, unknown>) {
  return {
    listTaskDependencies: () => ({ blockedBy: [], blocks: [] }),
    listProjects: () => ({ projects: [{ id: PROJECT_ID, name: "Example", prefix: "TSK", nextTaskNumber: 6, color: "blue", folderId: null, linkedBbProjectId: null, planning: "optional", createdAt: "2026-07-15T00:00:00.000Z" }] }),
    listFolders: () => ({ folders: [] }), listPresets: () => ({ presets: [] }), sidebarSummary: () => ({ projects: [] }),
    getTaskByKey: () => ({ task }), listTasks: (input: unknown) => input !== null && rpcInput(input).parentTaskId ? { tasks: [] } : { tasks: [task] },
    listLabels: () => ({ labels: [] }), listAttachments: () => ({ attachments: [] }), listTaskThreads: () => ({ taskThreads: [] }),
    listTaskPullRequests: () => ({ pullRequests: [], unavailableThreadIds: [] }), listQuestions: () => ({ questions: [] }),
    listComments: () => ({ comments: [] }), listBbProjects: () => ({ bbProjects: [] }), listTaskCardMeta: () => ({ metadata: [] }), ...overrides,
  };
}

function historySlot(bodies: string[]) {
  const comments = bodies.map((body, i) => ({ id: `comment_${i}`, taskId: TASK_ID, kind: "system", authorName: "Work Board", threadId: null, presetName: null, body, notifiedCount: 0, createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() }));
  return renderSlot(app.navPanels[0]!, { subPath: "task/TSK-5" }, { rpc: detailRpc({ listComments: () => ({ comments }) }) });
}
const attached = "Thread attached: @thread:thr_example";
const detached = "Thread detached: @thread:thr_example";

it("folds session events with counts and expands their original records", async () => {
  const slot = historySlot([attached, attached, detached, 'Thread "Worker" failed · thr_example']);
  const group = await slot.findByRole("button", { name: /Sessions changed: 2 attached, 1 detached, 1 failed/ });
  expect(slot.queryByText(/Thread detached:/)).toBeNull();
  fireEvent.click(group);
  expect(slot.getByText(/Thread detached:/)).toBeTruthy();
  expect(slot.getAllByText(/Thread attached:/)).toHaveLength(2);
});

it("leaves a single session event unfolded", async () => {
  const slot = historySlot([attached]);
  expect(await slot.findByText(/Thread attached:/)).toBeTruthy();
  expect(slot.queryByRole("button", { name: /Sessions changed/ })).toBeNull();
});

it("splits session runs at another system event", async () => {
  const slot = historySlot([attached, detached, "Status changed to Todo", attached, detached]);
  expect(await slot.findAllByRole("button", { name: /Sessions changed: 1 attached, 1 detached/ })).toHaveLength(2);
  expect(slot.getByText(/Status changed to Todo/)).toBeTruthy();
});

it("counts records rather than folded rows when paging", async () => {
  const slot = historySlot([...Array.from({ length: 20 }, (_, i) => `Note ${i}`), attached, detached, attached, detached, attached]);
  await slot.findByRole("button", { name: /Sessions changed: 3 attached, 2 detached/ });
  expect(slot.getByText("Showing 20 of 25")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Show earlier activity" }));
  expect(slot.queryByText("Showing 20 of 25")).toBeNull();
  expect(slot.getByText(/Note 0/)).toBeTruthy();
});
