// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
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

function render(surface: "main" | "side" = "main", withThread = false, queued = false, queuesPending = false, shown = task, pauses: unknown[] = [], presetName = "Worker") {
  const options = {
    sdk: { threads: { get: async () => makeThreadResponse({ id: "thr_example", title: "Example worker" }), list: async () => [] } },
    rpc: {
      listTaskDependencies: () => ({ blockedBy: [], blocks: [] }),
      listProjects: () => ({ projects: [{ id: PROJECT_ID, name: "Tasks Plugin", prefix: "TSK", nextTaskNumber: 6, color: "blue", folderId: null, linkedBbProjectId: null, planning: "optional", createdAt: "2026-07-15T00:00:00.000Z" }] }),
      listFolders: () => ({ folders: [] }),
      listPresets: () => ({ presets: [] }),
      sidebarSummary: () => ({ projects: [] }),
      getTaskByKey: () => ({ task: shown }),
      listTasks: (input: unknown) => (input !== null && rpcInput(input).parentTaskId ? { tasks: [] } : { tasks: [shown] }),
      listLabels: () => ({ labels: [] }),
      listAttachments: () => ({ attachments: [] }),
      listTaskThreads: () => ({ taskThreads: withThread ? [{ id: "row_example", taskId: task.id, threadId: "thr_example", title: "Example worker", presetName, liveStatus: "working", attachedAt: "2026-07-15T00:00:00.000Z", updatedAt: "2026-07-15T00:00:00.000Z" }] : [] }),
      listTaskPullRequests: () => ({ pullRequests: [], unavailableThreadIds: [] }),
      listQuestions: () => ({ questions: [] }),
      listComments: () => ({ comments: [] }),
      listBbProjects: () => ({ bbProjects: [] }),
      listTaskCardMeta: () => ({ metadata: queued || pauses.length ? [{ taskId: task.id, taskThreads: [], ...(queued ? { queue: { threadId: "thr_example", position: 2 } } : {}), ...(pauses.length ? { pauses } : {}) }] : [] }),
      queueRemove: () => ({}),
      queueList: () => (queuesPending ? new Promise(() => {}) : { queues: [{ projectId: PROJECT_ID, threadId: "thr_example", entries: [1, 2, 3, 4].map((position) => ({ position })) }] }),
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
  it.each([480, 640])("shows Status and Activity in the status card, and Queue and Start as their own sections at %ipx", async (width) => {
    setWidth(width);
    const slot = render("main", true, false, false, task, [{ signal: "owner_question", reason: "waiting", until: null, targets: [] }]);
    const activity = await slot.findByRole("region", { name: "Task activity status" });
    expect(within(activity).getByText("Status")).toBeTruthy();
    expect(within(activity).getByText("Activity")).toBeTruthy();
    for (const label of ["Queue", "Start", "Sessions"]) expect(within(activity).queryByText(label)).toBeNull();
    expect(within(activity).queryByRole("button", { name: "Add to queue" })).toBeNull();
    const sessions = slot.getByRole("region", { name: "Sessions" });
    const queue = slot.getByRole("region", { name: "Queue" });
    const start = slot.getByRole("region", { name: "Start" });
    const paused = await slot.findByRole("region", { name: "Paused" });
    // Each empty section is a header with its icon on the right, and a muted None below.
    expect(within(queue).getByRole("button", { name: "Add to queue" }).title).toBe("Add to queue");
    expect(within(start).getByRole("button", { name: "Schedule a start" }).title).toBe("Schedule a start");
    for (const section of [queue, start]) expect(within(section).getAllByText("None")).toHaveLength(1);
    expect(slot.getAllByRole("button", { name: "Add to queue" })).toHaveLength(1);
    expect(activity.compareDocumentPosition(sessions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(sessions.nextElementSibling).toBe(queue);
    expect(queue.nextElementSibling).toBe(start);
    expect(start.nextElementSibling).toBe(paused);
    expect(paused.compareDocumentPosition(slot.getByRole("button", { name: "Open thread Example worker" })) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    fireEvent.click(within(queue).getByRole("button", { name: "Add to queue" }));
    expect(await slot.findByRole("dialog", { name: "Add to a work queue" })).toBeTruthy();
  });
  it("keeps Sessions with its add icon and one None, before the dispatch control", async () => {
    const slot = render();
    const sessions = await slot.findByRole("region", { name: "Sessions" });
    expect(within(sessions).getByRole("button", { name: "Send to another thread" }).title).toBe("Send to another thread");
    expect(within(sessions).getAllByText("None")).toHaveLength(1);
    expect(sessions.compareDocumentPosition(slot.getByRole("button", { name: "Send to thread…" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it.each(["main", "side"] as const)("orders the status card, Sessions, Queue, Start and Paused in the %s view", async (surface) => {
    const slot = render(surface, true, false, false, task, [{ signal: "owner_question", reason: "waiting", until: null, targets: [] }]);
    const paused = await slot.findByRole("region", { name: "Paused" });
    const activity = slot.getByRole("region", { name: "Task activity status" });
    const sessions = slot.getByRole("region", { name: "Sessions" });
    expect(activity.compareDocumentPosition(sessions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(sessions.nextElementSibling).toBe(slot.getByRole("region", { name: "Queue" }));
    expect(slot.getByRole("region", { name: "Queue" }).nextElementSibling).toBe(slot.getByRole("region", { name: "Start" }));
    expect(slot.getByRole("region", { name: "Start" }).nextElementSibling).toBe(paused);
  });
  it("breaks a long unbroken preset name inside the Sessions card", async () => {
    const slot = render("main", true, false, false, task, [], `Preset${"x".repeat(80)}`);
    const sessions = await slot.findByRole("region", { name: "Sessions" });
    const line = await within(sessions).findByText(/^Preset(x{80}) · attached/);
    expect(line.className).toContain("[overflow-wrap:anywhere]");
  });
  it("renders neither Queue nor Start on an archived task, and Sessions has no add and no detach", async () => {
    const slot = render("main", true, false, false, { ...task, archivedAt: "2026-07-16T00:00:00.000Z" });
    const sessions = await slot.findByRole("region", { name: "Sessions" });
    await within(sessions).findByRole("button", { name: "Open thread Example worker" });
    expect(slot.queryByRole("region", { name: "Queue" })).toBeNull();
    expect(slot.queryByRole("region", { name: "Start" })).toBeNull();
    expect(slot.queryByRole("button", { name: "Add to queue" })).toBeNull();
    expect(slot.queryByRole("button", { name: "Schedule a start" })).toBeNull();
    expect(within(sessions).queryByRole("button", { name: "Send to another thread" })).toBeNull();
    expect(within(sessions).queryByRole("button", { name: /^Unassign/ })).toBeNull();
  });
  it("shows the queue place without the total while the queue loads", async () => {
    const slot = render("main", false, true, true);
    const queue = await slot.findByRole("region", { name: "Queue" });
    await waitFor(() => expect(queue.textContent).toContain("#2 · Example worker"));
    expect(callCount(slot, "queueList")).toBeGreaterThan(0);
  });
  it.each([480, 640])("shows the queue position on one truncated line in the Queue section at %ipx", async (width) => {
    setWidth(width);
    const slot = render("main", false, true);
    const queue = await slot.findByRole("region", { name: "Queue" });
    await waitFor(() => expect(queue.textContent).toContain("2 of 4 · Example worker"));
    const place = within(queue).getByTitle("2 of 4 · Example worker");
    expect(within(place).getByRole("button", { name: "Example worker" }).className).toContain("truncate");
    expect(slot.getAllByRole("button", { name: "Remove from queue" })).toHaveLength(1);
    fireEvent.click(within(queue).getByRole("button", { name: "Remove from queue" }));
    await waitFor(() => expect(slot.rpcCalls).toContainEqual(expect.objectContaining({ method: "queueRemove", input: { taskId: task.id, actor: "owner" } })));
  });
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

  it.each(["main", "side"] as const)("shows the Sessions section after Activity and before Details in the narrow %s view", async (surface) => {
    setWidth(480);
    const slot = render(surface, true);
    const session = await slot.findByRole("button", { name: "Open thread Example worker" });
    const section = details()!;
    const activity = slot.getByRole("region", { name: "Task activity status" });
    const sessions = slot.getByRole("region", { name: "Sessions" });
    expect(sessions.contains(session)).toBe(true);
    expect(activity.contains(session)).toBe(false);
    expect(section.contains(sessions)).toBe(false);
    expect(activity.compareDocumentPosition(sessions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(sessions.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(section.compareDocumentPosition(document.querySelector(".tiptap")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(slot.queryByText("Agent threads")).toBeNull();
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
