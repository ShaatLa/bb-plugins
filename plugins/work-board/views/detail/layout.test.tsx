// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { makeTask, rpcInput, taskTab } from "../../test-fixtures.js";
import { stubDetailWidth } from "./test-width.js";

class TestResizeObserver {
  static all = new Set<TestResizeObserver>();
  constructor(private readonly callback: (entries: { contentRect: { width: number } }[]) => void) {
    TestResizeObserver.all.add(this);
  }
  observe() {}
  unobserve() {}
  disconnect() { TestResizeObserver.all.delete(this); }
  static deliver(width: number) {
    act(() => { for (const observer of TestResizeObserver.all) observer.callback([{ contentRect: { width } }]); });
  }
}
globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;

const app = await loadPluginApp(() => import("../../app"));
const setWidth = stubDetailWidth(640);

beforeEach(() => { window.localStorage.clear(); document.documentElement.style.fontSize = ""; });
afterEach(() => { cleanup(); TestResizeObserver.all.clear(); });

const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const task = makeTask({ id: "01HZZZZZZZZZZZZZZZZZZZZZT5", projectId: PROJECT_ID, number: 5, key: "TSK-5", title: "Ship the rail", position: 1 });

function render(surface: "main" | "side" = "main") {
  const options = {
    rpc: {
      listTaskDependencies: () => ({ blockedBy: [], blocks: [] }),
      listProjects: () => ({ projects: [{ id: PROJECT_ID, name: "Tasks Plugin", prefix: "TSK", nextTaskNumber: 6, color: "blue", folderId: null, linkedBbProjectId: null, planning: "optional", createdAt: "2026-07-15T00:00:00.000Z" }] }),
      listFolders: () => ({ folders: [] }),
      listPresets: () => ({ presets: [] }),
      sidebarSummary: () => ({ projects: [] }),
      getTaskByKey: () => ({ task }),
      listTasks: (input: unknown) => (input !== null && rpcInput(input).parentTaskId ? { tasks: [] } : { tasks: [task] }),
      listLabels: () => ({ labels: [] }),
      listAttachments: () => ({ attachments: [] }),
      listTaskThreads: () => ({ taskThreads: [] }),
      listTaskPullRequests: () => ({ pullRequests: [], unavailableThreadIds: [] }),
      listQuestions: () => ({ questions: [] }),
      listComments: () => ({ comments: [] }),
      listBbProjects: () => ({ bbProjects: [] }),
      listTaskCardMeta: () => ({ metadata: [] }),
    },
  };
  return surface === "main"
    ? renderSlot(app.navPanels[0]!, { subPath: "task/TSK-5" }, options)
    : renderSlot(taskTab(app), { threadId: "thr_context", environment: null }, { ...options, experimental_fixedTabTarget: { tabId: "task", target: { taskKey: "TSK-5" } } });
}

const root = () => document.querySelector<HTMLElement>("[data-wide]")!;
const details = () => document.querySelector('section[aria-label="Details"]');
const rail = () => document.querySelector('aside[aria-label="Task details"]');
const callCount = (slot: ReturnType<typeof render>, method: string) => slot.rpcCalls.filter((call) => call.method === method).length;

describe("task view layout", () => {
  it.each(["main", "side"] as const)("shows the rail beside the content at 640px in the %s view", async (surface) => {
    const slot = render(surface);
    await slot.findByRole("textbox", { name: "Task title" });
    expect(root().dataset.wide).toBe("true");
    expect(details()).toBeNull();
    expect(rail()!.textContent).toContain("Properties");
    expect(rail()!.textContent).toContain("Dispatch target");
    expect(rail()!.querySelector('[aria-label="Task activity status"]')).toBeTruthy();
  });

  it("mounts the right layout from the first commit", async () => {
    const seen: string[] = [];
    const observer = new MutationObserver(() => {
      if (details()) seen.push("details");
      if (rail()) seen.push("rail");
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const slot = render();
    await slot.findByRole("textbox", { name: "Task title" });
    observer.disconnect();
    expect(new Set(seen)).toEqual(new Set(["rail"]));
  });

  it("puts Details after the inline properties and before the description at 480px", async () => {
    setWidth(480);
    const slot = render();
    await slot.findByRole("textbox", { name: "Task title" });
    expect(root().dataset.wide).toBe("false");
    expect(rail()).toBeNull();
    const section = details()!;
    expect(section.textContent).toContain("Dispatch target");
    const labels = document.querySelector('button[aria-label="Edit labels"]')!;
    const description = document.querySelector(".tiptap")!;
    expect(labels.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(section.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(slot.getAllByRole("region", { name: "Task activity status" })).toHaveLength(1);
  });

  it.each([480, 640])("runs the cost, claims and pull request queries once at %ipx", async (width) => {
    setWidth(width);
    const slot = render();
    await slot.findByRole("textbox", { name: "Task title" });
    await waitFor(() => expect(callCount(slot, "getTaskCostSpans")).toBeGreaterThan(0));
    for (const method of ["getTaskCostSpans", "listTaskClaims"]) expect(callCount(slot, method)).toBe(1);
    for (const method of ["listTaskPullRequests", "listPrLinks"]) expect(callCount(slot, method)).toBeLessThanOrEqual(1);
  });

  it("remembers a collapsed Details section across cards", async () => {
    setWidth(480);
    const first = render();
    await first.findByRole("textbox", { name: "Task title" });
    const toggle = () => details()!.querySelector("button")!;
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    cleanup();
    const second = render();
    await second.findByRole("textbox", { name: "Task title" });
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  it.each([
    ["16px", 575, 576],
    ["20px", 719, 720],
  ])("switches at 36rem for a %s root font size, driven by the observer", async (fontSize, narrow, wide) => {
    document.documentElement.style.fontSize = fontSize;
    setWidth(0);
    const slot = render();
    await slot.findByRole("textbox", { name: "Task title" });
    TestResizeObserver.deliver(narrow);
    expect(root().dataset.wide).toBe("false");
    expect(details()).toBeTruthy();
    expect(rail()).toBeNull();
    TestResizeObserver.deliver(wide);
    expect(root().dataset.wide).toBe("true");
    expect(rail()).toBeTruthy();
    expect(details()).toBeNull();
    TestResizeObserver.deliver(narrow);
    expect(root().dataset.wide).toBe("false");
    expect(details()).toBeTruthy();
    expect(rail()).toBeNull();
  });
});
