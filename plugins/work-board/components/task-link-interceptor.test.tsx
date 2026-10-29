// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("../app"));
const segment = app.threadContextSegments.find(({ id }) => id === "task-links")!;
const input = { threadId: "thr_1", projectId: "proj_1", environment: null };
let visible: boolean | undefined;
// Hosts the segment's useVisible hook the way bb does for an open thread.
const Host = () => {
  visible = segment.useVisible!(input);
  return null;
};

function clickLink(href: string, init: MouseEventInit = {}) {
  const anchor = document.createElement("a");
  anchor.href = href;
  document.body.append(anchor);
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  anchor.dispatchEvent(event);
  anchor.remove();
  return event;
}

afterEach(cleanup);

describe("task link interception", () => {
  it("opens task links in the thread's Work Board tab and never shows the segment", () => {
    const openTab = vi.fn(() => true);
    renderSlot({ component: Host }, {}, { experimental_panel: { openTab } });
    expect(visible).toBe(false);
    const event = clickLink("/plugins/work-board/work-board/task/ANV-12");
    expect(openTab).toHaveBeenCalledWith({
      tab: expect.objectContaining({ id: "task", context: { kind: "thread" }, availability: "fixed" }),
      target: { taskKey: "ANV-12" },
    });
    expect(event.defaultPrevented).toBe(true);
  });

  it("keeps normal navigation for modified clicks, other links and declined opens", () => {
    const openTab = vi.fn(() => false);
    renderSlot({ component: Host }, {}, { experimental_panel: { openTab } });
    expect(clickLink("/plugins/work-board/work-board/task/ANV-12", { metaKey: true }).defaultPrevented).toBe(false);
    expect(clickLink("/plugins/other/page").defaultPrevented).toBe(false);
    expect(clickLink("/plugins/work-board/work-board/task/ANV-12").defaultPrevented).toBe(false);
    expect(openTab).toHaveBeenCalledTimes(1);
  });
});
