// @vitest-environment jsdom
import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
const app = await loadPluginApp(() => import("../app"));
const panel = app.navPanels[0]!;
const first = "01HZZZZZZZZZZZZZZZZZZZZZP1", second = "01HZZZZZZZZZZZZZZZZZZZZZP2";
const projects = [first, second].map((id, i) => ({ id, name: `Project ${i}`, prefix: `EX${i}`, nextTaskNumber: 1, color: "blue", folderId: null, linkedBbProjectId: null, createdAt: "2026-01-01T00:00:00.000Z" }));
const queue = (projectId: string) => ({ projectId, threadId: "thr_example", entries: [{ taskId: "task_example", key: "EXA-1", title: "Example", status: "todo", position: 1, addedBy: "owner", addedAt: "2026-01-01T00:00:00.000Z" }] });
afterEach(cleanup);
it("refreshes a closed trigger when the first queue appears", async () => {
  let queues: ReturnType<typeof queue>[] = [];
  const slot = renderSlot(panel, { subPath: first }, { sdk: { threads: { list: async () => [] } }, rpc: { listProjects: () => ({ projects }), listFolders: () => ({ folders: [] }), listTasks: () => ({ tasks: [] }), queueList: () => ({ queues }) } });
  await slot.findByText("Project 0");
  expect(slot.queryByText("Queues · 1")).toBeNull();
  queues = [queue(first)];
  await slot.emitRealtime("tasks:changed", { projectId: first, taskId: "task_example" });
  await slot.findByText("Queues · 1");
  queues = [];
  await slot.emitRealtime("tasks:changed", { projectId: first, taskId: "task_example" });
  await waitFor(() => expect(slot.queryByText("Queues · 1")).toBeNull());
});
it("drops a late read after switching projects", async () => {
  const releases: Array<() => void> = [];
  const slot = renderSlot(panel, { subPath: first }, { sdk: { threads: { list: async () => [] } }, rpc: { listProjects: () => ({ projects }), listFolders: () => ({ folders: [] }), listTasks: () => ({ tasks: [] }), queueList: (input: any) => input.projectId === first ? new Promise((resolve) => releases.push(() => resolve({ queues: [queue(first)] }))) : { queues: [] } } });
  await slot.findByText("Project 0");
  await waitFor(() => expect(releases.length).toBeGreaterThan(0));
  slot.lifecycle.rerender(<panel.component subPath={second} />);
  await slot.findByText("Project 1");
  await act(async () => { releases.forEach((release) => release()); });
  expect(slot.queryByText("Queues · 1")).toBeNull();
});
