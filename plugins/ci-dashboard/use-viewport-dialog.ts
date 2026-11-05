import { useLayoutEffect, type RefObject } from "react";

/**
 * Opens a modal <dialog> centered on the dashboard's own viewport instead of the whole BB window:
 * native browser panes are drawn above web content and would cover a window-centered dialog.
 * The dialog needs `fixed m-0 -translate-x-1/2 -translate-y-1/2` classes; this sets left/top and max sizes.
 */
export function useViewportDialog(dialog: RefObject<HTMLDialogElement | null>, onOpen?: (element: HTMLDialogElement) => void) {
  useLayoutEffect(() => {
    const element = dialog.current!;
    const viewport = window.visualViewport;
    const container = element.closest<HTMLElement>("[data-ci-dashboard-viewport]");
    function position() {
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      let left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
      let right = left + width, bottom = top + height;
      const bounds = container?.getBoundingClientRect();
      if (bounds && bounds.width > 0 && bounds.height > 0) {
        left = Math.max(left, bounds.left);
        top = Math.max(top, bounds.top);
        right = Math.min(right, bounds.right);
        bottom = Math.min(bottom, bounds.bottom);
      }
      Object.assign(element.style, {
        left: `${(left + right) / 2}px`,
        top: `${(top + bottom) / 2}px`,
        maxWidth: `${Math.max(0, right - left - 32)}px`,
        maxHeight: `${Math.max(0, bottom - top - 32)}px`,
      });
    }
    position();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(position);
    if (container) observer?.observe(container);
    window.addEventListener("resize", position);
    viewport?.addEventListener("resize", position);
    viewport?.addEventListener("scroll", position);
    element.showModal();
    onOpen?.(element);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", position);
      viewport?.removeEventListener("resize", position);
      viewport?.removeEventListener("scroll", position);
      element.close();
    };
  }, []); // Opened once per mount.
}
