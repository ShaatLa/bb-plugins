// @vitest-environment jsdom
import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { makeTask } from "../../test-fixtures.js";
import { resetTaskDatasetCachesForTest } from "../../shell/task-dataset";
import { resetQuerySnapshotStateForTest } from "../../shell/query-snapshot";

const app = await loadPluginApp(() => import("../../app"));
const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const ROW = 34;
const HEADER = 33;
const VIEWPORT = 600;

const project = { id: PROJECT_ID, name: "Example", prefix: "EXA", nextTaskNumber: 301, color: "blue", folderId: null, linkedBbProjectId: null, createdAt: "2026-07-15T00:00:00.000Z" };
const tasks = Array.from({ length: 300 }, (_, i) => makeTask({ id: `01HZZZZZZZZZZZZZZZZZZZ${String(i).padStart(4, "0")}`, projectId: PROJECT_ID, number: i + 1, key: `EXA-${i + 1}`, title: `Task ${i + 1}`, position: i }));

// A small layout engine: rows and headers have fixed heights, spacers contribute their inline height.
const tops = new WeakMap<Element, number>();
const original = {
  offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight"),
  clientHeight: Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight"),
  scrollHeight: Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight"),
  scrollTop: Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop"),
};
const isScroller = (el: Element) => el.classList.contains("overflow-y-auto");
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get(this: HTMLElement) { return this.hasAttribute("data-task-key") ? ROW : this.hasAttribute("data-status-group-header") ? HEADER : 0; } });
  Object.defineProperty(Element.prototype, "clientHeight", { configurable: true, get(this: Element) { return isScroller(this) ? VIEWPORT : 0; } });
  Object.defineProperty(Element.prototype, "scrollHeight", { configurable: true, get(this: Element) {
    if (!isScroller(this)) return 0;
    let total = this.querySelectorAll("[data-task-key]").length * ROW + this.querySelectorAll("[data-status-group-header]").length * HEADER;
    for (const spacer of this.querySelectorAll<HTMLElement>("div[aria-hidden]")) total += Number.parseInt(spacer.style.height || "0", 10);
    return total;
  } });
  Object.defineProperty(Element.prototype, "scrollTop", { configurable: true, get(this: Element) { return tops.get(this) ?? 0; }, set(this: Element, value: number) { tops.set(this, value); } });
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  for (const [name, descriptor] of Object.entries(original)) {
    const target = name === "offsetHeight" ? HTMLElement.prototype : Element.prototype;
    if (descriptor) Object.defineProperty(target, name, descriptor); else delete (target as unknown as Record<string, unknown>)[name];
  }
});

function renderList() {
  return renderSlot(app.navPanels[0]!, { subPath: `${PROJECT_ID}?view=list` }, {
    rpc: {
      listProjects: () => ({ projects: [project] }),
      listFolders: () => ({ folders: [] }),
      listPresets: () => ({ presets: [] }),
      sidebarSummary: () => ({ projects: [] }),
      listLabels: () => ({ labels: [] }),
      listTasks: () => ({ tasks }),
    },
  });
}

describe("windowed list scroll restoration", () => {
  it("restores an offset deeper than the 60-row cold fallback", async () => {
    const first = renderList();
    await waitFor(() => expect(first.container.querySelectorAll("[data-task-key]").length).toBeGreaterThan(0));
    const scroller = () => first.container.querySelector<HTMLElement>("div.overflow-y-auto")!;
    await waitFor(() => expect(first.container.querySelectorAll("[data-task-key]").length).toBeLessThan(60));
    const target = 8000;
    act(() => { scroller().scrollTop = target; scroller().dispatchEvent(new Event("scroll")); });
    await waitFor(() => expect(first.container.querySelector(`[data-task-key="EXA-${Math.floor(target / ROW)}"]`)).not.toBeNull());
    first.unmount();
    // A cold load: the data arrives settled (not loading) in one commit, over the unmeasured fallback DOM.
    resetTaskDatasetCachesForTest();
    resetQuerySnapshotStateForTest();
    // The first mount persisted its task snapshot; remove it so the second mount really loads cold.
    window.localStorage.clear();

    const second = renderList();
    await waitFor(() => expect(second.container.querySelectorAll("[data-task-key]").length).toBeGreaterThan(0));
    const restored = () => second.container.querySelector<HTMLElement>("div.overflow-y-auto")!.scrollTop;
    await waitFor(() => expect(restored()).toBeGreaterThanOrEqual(target - 200));
  });
});
