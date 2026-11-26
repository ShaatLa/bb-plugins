import { useCallback, useRef, useState } from "react";

/** The task view shows its rail beside the content from this container width (rem). */
export const WIDE_DETAIL_REM = 36;

function rootFontSize(): number {
  const size = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(size) && size > 0 ? size : 16;
}

function contentWidth(element: HTMLElement): number {
  const style = getComputedStyle(element);
  const padding = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
  return element.getBoundingClientRect().width - padding;
}

/**
 * One decision for the task view's layout and mounting: `wide` is `null` until the
 * root is measured (the callback ref measures during commit, before paint), then
 * `width >= 36rem` measured like a CSS rem. Attach `ref` to the layout root.
 */
export function useWideDetail(): { ref: (element: HTMLElement | null) => void; wide: boolean | null } {
  const [wide, setWide] = useState<boolean | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((element: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!element) return;
    const apply = (width: number) => setWide(width >= WIDE_DETAIL_REM * rootFontSize());
    apply(contentWidth(element));
    if (typeof ResizeObserver === "undefined") return;
    observer.current = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) apply(entry.contentRect.width);
    });
    observer.current.observe(element);
  }, []);
  return { ref, wide };
}
