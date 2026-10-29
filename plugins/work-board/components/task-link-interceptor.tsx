import { useEffect, useRef } from "react";
import { experimental_useAppPanel, useBbContext } from "@get-bb/plugin-sdk/app";
import { TASK_TAB } from "../views/embed/index.js";

const TASK_LINK = /\/plugins\/work-board\/work-board\/task\/([^/?#]+)/;

/**
 * Opens chat links to Work Board tasks in the thread's Work Board side-panel tab
 * instead of the main area. Modified clicks and clicks outside a thread keep bb's navigation.
 */
export function TaskLinkInterceptor() {
  const panel = experimental_useAppPanel();
  const { threadId } = useBbContext();
  const current = useRef({ panel, threadId });
  current.current = { panel, threadId };

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (!current.current.threadId) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      const match = anchor?.getAttribute("href")?.match(TASK_LINK);
      if (!match) return;
      let taskKey: string;
      try {
        taskKey = decodeURIComponent(match[1]!);
      } catch {
        return;
      }
      if (!TASK_TAB.experimental_target.validate({ taskKey })) return;
      // Only swallow the click when the host actually opened the tab.
      if (current.current.panel.openTab({ tab: TASK_TAB, target: { taskKey } })) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    // Capture phase runs before bb's own link handling.
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  return null;
}
