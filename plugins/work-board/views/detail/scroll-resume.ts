import { useLayoutEffect, type RefObject } from "react";
import { readListScroll, writeListScroll } from "../list/scroll-restoration.js";

const RESTORE_WINDOW_MS = 5_000;

/**
 * Keeps each task page's scroll offset for the app session and returns to it when the
 * task is shown again. The page grows as comments and activity load, so the saved offset
 * is re-applied every frame until it is reached, the user scrolls, or 5 s pass.
 */
export function useTaskScrollResume(ref: RefObject<HTMLElement | null>, taskKey: string | null): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null || taskKey === null) return;
    const key = `task:${taskKey}`;
    const saved = readListScroll(key) ?? 0;
    let restoring = saved > 0;
    el.scrollTop = 0;
    const apply = () => {
      if (!restoring) return;
      el.scrollTop = Math.min(saved, Math.max(0, el.scrollHeight - el.clientHeight));
      if (el.scrollTop >= saved - 1) restoring = false;
    };
    // Frames, not a ResizeObserver: the detail swaps its root element when loading finishes.
    let frame = 0;
    const tick = () => { apply(); if (restoring) frame = window.requestAnimationFrame(tick); };
    tick();
    const timeout = window.setTimeout(() => { restoring = false; }, RESTORE_WINDOW_MS);
    const stopRestoring = () => { restoring = false; };
    const remember = () => { if (!restoring) writeListScroll(key, el.scrollTop); };
    el.addEventListener("scroll", remember, { passive: true });
    for (const type of ["wheel", "touchstart", "keydown", "pointerdown"] as const) el.addEventListener(type, stopRestoring, { passive: true });
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
      el.removeEventListener("scroll", remember);
      for (const type of ["wheel", "touchstart", "keydown", "pointerdown"] as const) el.removeEventListener(type, stopRestoring);
    };
  }, [ref, taskKey]);
}
