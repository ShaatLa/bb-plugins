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
  expect(row("TSK-3").querySelector("[data-thread-health]")).toBeNull();
});
