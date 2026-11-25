import { useEffect, useRef } from "react";
import {
  type ExperimentalThreadContextSegmentInput,
  experimental_useAppPanel,
} from "@get-bb/plugin-sdk/app";
import { TASK_TAB } from "../views/embed/index.js";
import { openPlanTab } from "../views/plan/open.js";

const TASK_LINK = /^\/plugins\/work-board\/work-board\/task\/([^/?#]+)(\/plan(?![^/?#]))?/;

/**
 * Opens chat links to Work Board tasks (and their plans) in the thread's side-panel tabs
 * instead of the main area. Modified clicks and declined opens keep bb's navigation.
 *
 * It is the `useVisible` hook of a never-shown thread context segment: bb runs it for
 * every open thread inside the thread screen, where the side-panel controller exists.
 * App overlays only get bb's default controller, whose openTab always declines.
 */
export function useTaskLinkInterception(_input: ExperimentalThreadContextSegmentInput): boolean {
  const panel = experimental_useAppPanel();
  const current = useRef(panel);
  current.current = panel;

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      const href = anchor?.getAttribute("href");
      if (!href) return;
      let url: URL;
      try {
        url = new URL(href, document.baseURI);
      } catch {
        return;
      }
      // Only this app's own task routes; an external page with the same path stays a web link.
      if (url.origin !== new URL(document.baseURI).origin) return;
      const match = url.pathname.match(TASK_LINK);
      if (!match) return;
      let taskKey: string;
      try {
        taskKey = decodeURIComponent(match[1]!);
      } catch {
        return;
      }
      if (!TASK_TAB.experimental_target.validate({ taskKey })) return;
      // Only swallow the click when the host actually opened the tab.
      const opened = match[2]
        ? openPlanTab(current.current, taskKey)
        : current.current.openTab({ tab: TASK_TAB, target: { taskKey } });
      if (opened) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    // Capture phase runs before bb's own link handling in the message renderer.
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  return false;
}
