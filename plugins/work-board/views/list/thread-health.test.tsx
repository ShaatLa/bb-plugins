// @vitest-environment jsdom
import { cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { makeTask } from "../../test-fixtures.js";

window.matchMedia ??= (media: string) => ({
  matches: false,
  media,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => false,
});
window.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView ??= () => {};

const app = await loadPluginApp(() => import("../../app"));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const project = { id: PROJECT_ID, name: "Tasks Plugin", prefix: "TSK", nextTaskNumber: 5, color: "blue", folderId: null, linkedBbProjectId: null, createdAt: "2026-07-15T00:00:00.000Z" };

it("marks failed and stale-idle tasks in the list", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-28T08:52:00.000Z"));
  const failed = makeTask({ id: "01HZT1", projectId: PROJECT_ID, number: 1, key: "TSK-1", title: "Failed", position: 1 });
  const idle = makeTask({ id: "01HZT2", projectId: PROJECT_ID, number: 2, key: "TSK-2", title: "Idle", position: 2 });
  const quiet = makeTask({ id: "01HZT3", projectId: PROJECT_ID, number: 3, key: "TSK-3", title: "Quiet", position: 3 });
  const meta = (taskId: string, threadHealth: unknown) => ({ taskId, attachmentCount: 0, taskThreads: [], threadHealth });
  const slot = renderSlot(app.navPanels[0]!, { subPath: PROJECT_ID }, { rpc: {
    listProjects: () => ({ projects: [project] }),
    listFolders: () => ({ folders: [] }),
    listPresets: () => ({ presets: [] }),
    sidebarSummary: () => ({ projects: [] }),
    listLabels: () => ({ labels: [] }),
    listTasks: () => ({ tasks: [failed, idle, quiet] }),
    listQuestions: () => ({ questions: [] }),
    listTaskCardMeta: () => ({ metadata: [
      meta(failed.id, { failed: [{ threadId: "thr_f", title: "Broken worker", failedAt: "2026-10-28T08:40:00.000Z" }], idle: null }),
      meta(idle.id, { failed: [], idle: { threadId: "thr_i", since: "2026-10-28T08:00:00.000Z", thresholdMinutes: 45 } }),
      meta(quiet.id, { failed: [], idle: null }),
    ] }),
  } });
  const row = (key: string) => slot.container.querySelector(`[data-task-key="${key}"]`)!;
  await slot.findByRole("img", { name: /^Thread Broken worker failed/ });
  expect(row("TSK-1").querySelector('[data-thread-health="failed"]')).not.toBeNull();
  const idleMarker = await slot.findByRole("img", { name: "Thread idle 52 min, task not updated" });
  expect(row("TSK-2").contains(idleMarker)).toBe(true);
  expect(idleMarker.querySelector("svg")).not.toBeNull();
  expect(idleMarker.className).not.toContain("rounded-full");
  expect(row("TSK-3").querySelector("[data-thread-health]")).toBeNull();
});

it("renders activity on a list row", async () => {
  const task = makeTask({ id: "01HZT4", projectId: PROJECT_ID, number: 4, key: "TSK-4", title: "Queued task", position: 1 });
  const slot = renderSlot(app.navPanels[0]!, { subPath: PROJECT_ID }, { rpc: {
    listProjects: () => ({ projects: [project] }), listFolders: () => ({ folders: [] }),
    listPresets: () => ({ presets: [] }), sidebarSummary: () => ({ projects: [] }),
    listLabels: () => ({ labels: [] }), listTasks: () => ({ tasks: [task] }), listQuestions: () => ({ questions: [] }),
    listTaskCardMeta: () => ({ metadata: [{ taskId: task.id, attachmentCount: 0, taskThreads: [], threadHealth: { failed: [], idle: null }, activity: { state: "queued", workingCount: 0, attachedCount: 1, sessions: [{ threadId: "t", title: "Worker", role: "worker", state: "queued" }], terminalWarning: false, hasFailure: false } }] }),
  } });
  const badge = await slot.findByText("Queued");
  expect(slot.container.querySelector('[data-task-key="TSK-4"]')?.contains(badge)).toBe(true);
});

it("shows a pause on a list row: its reasons on the Paused state, and a Paused chip when another state wins", async () => {
  const paused = makeTask({ id: "01HZT5", projectId: PROJECT_ID, number: 5, key: "TSK-5", title: "Paused task", position: 1 });
  const working = makeTask({ id: "01HZT6", projectId: PROJECT_ID, number: 6, key: "TSK-6", title: "Working task", position: 2 });
  const pauses = [{ signal: "held", reason: "waiting on EXA-9", until: null, targets: [{ kind: "task", taskKey: "EXA-2" }] }];
  const activity = (state: string, workingCount: number) => ({ state, workingCount, attachedCount: workingCount, sessions: workingCount ? [{ threadId: "t", title: "Worker", role: "worker", state: "working" }] : [], terminalWarning: false, hasFailure: false });
  const slot = renderSlot(app.navPanels[0]!, { subPath: PROJECT_ID }, { rpc: {
    listProjects: () => ({ projects: [project] }), listFolders: () => ({ folders: [] }),
    listPresets: () => ({ presets: [] }), sidebarSummary: () => ({ projects: [] }),
    listLabels: () => ({ labels: [] }), listTasks: () => ({ tasks: [paused, working] }), listQuestions: () => ({ questions: [] }),
    listTaskCardMeta: () => ({ metadata: [
      { taskId: paused.id, attachmentCount: 0, taskThreads: [], threadHealth: { failed: [], idle: null }, activity: activity("paused", 0), pauses },
      { taskId: working.id, attachmentCount: 0, taskThreads: [], threadHealth: { failed: [], idle: null }, activity: activity("working", 1), pauses },
    ] }),
  } });
  const row = (key: string) => slot.container.querySelector(`[data-task-key="${key}"]`)!;
  await slot.findAllByText("Paused");
  expect(row("TSK-5").querySelector('[aria-label^="Paused"]')?.getAttribute("aria-label")).toContain("Waiting on EXA-2");
  expect(row("TSK-6").textContent).toContain("Working");
  const chip = [...row("TSK-6").querySelectorAll("span")].find((span) => span.textContent === "Paused");
  expect(chip?.getAttribute("title")).toContain("EXA-2");
  expect(row("TSK-5").textContent).not.toContain("Paused:");
});
