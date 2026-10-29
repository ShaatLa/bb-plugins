// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("../app"));
const overlay = app.appOverlays.find(({ id }) => id === "task-links")!;

function clickLink(href: string, init: MouseEventInit = {}) {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.textContent = "link";
  document.body.append(anchor);
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  anchor.dispatchEvent(event);
  anchor.remove();
  return event;
}

afterEach(cleanup);

describe("task link interceptor", () => {
  it("opens task links in the thread's Work Board tab", () => {
    const openTab = vi.fn(() => true);
    renderSlot(overlay, {}, { context: { projectId: "proj_1", threadId: "thr_1" }, experimental_panel: { openTab } });
    const event = clickLink("/plugins/work-board/work-board/task/ANV-12");
    expect(openTab).toHaveBeenCalledWith({
      tab: expect.objectContaining({ id: "task", context: { kind: "thread" }, availability: "fixed" }),
      target: { taskKey: "ANV-12" },
    });
    expect(event.defaultPrevented).toBe(true);
  });

  it("keeps normal navigation for modified clicks, other links, declined opens and non-thread pages", () => {
    const openTab = vi.fn(() => false);
    renderSlot(overlay, {}, { context: { projectId: "proj_1", threadId: "thr_1" }, experimental_panel: { openTab } });
    expect(clickLink("/plugins/work-board/work-board/task/ANV-12", { metaKey: true }).defaultPrevented).toBe(false);
    expect(clickLink("/plugins/other/page").defaultPrevented).toBe(false);
    expect(clickLink("/plugins/work-board/work-board/task/ANV-12").defaultPrevented).toBe(false);
    expect(openTab).toHaveBeenCalledTimes(1);
    cleanup();

    const elsewhere = vi.fn(() => true);
    renderSlot(overlay, {}, { context: { projectId: null, threadId: null }, experimental_panel: { openTab: elsewhere } });
    expect(clickLink("/plugins/work-board/work-board/task/ANV-12").defaultPrevented).toBe(false);
    expect(elsewhere).not.toHaveBeenCalled();
  });
});
