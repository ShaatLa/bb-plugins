import { useEffect, useState, type RefObject } from "react";

/**
 * Pairs each parsed heading with its rendered element: the n-th parsed heading is the n-th rendered h1..h6.
 * Headings the parser skips but the renderer shows (inside quotes or lists) break that count; then the
 * elements are matched by text, in order, and a heading without a match gets null.
 */
export function mapHeadings<T extends { textContent: string | null }>(parsed: readonly { text: string }[], rendered: readonly T[]): (T | null)[] {
  if (parsed.length === rendered.length) return [...rendered];
  let from = 0;
  return parsed.map((heading) => {
    const at = rendered.findIndex((element, index) => index >= from && element.textContent?.trim() === heading.text);
    if (at === -1) return null;
    from = at + 1;
    return rendered[at]!;
  });
}

const sameElements = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((item, index) => item === b[index]);

/** Rendered heading elements of `root` for the parsed headings; follows the editor as it renders and re-renders. */
export function useRenderedHeadings(root: RefObject<HTMLElement | null>, parsed: readonly { text: string }[], contentKey: string): (HTMLElement | null)[] {
  const [elements, setElements] = useState<(HTMLElement | null)[]>([]);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const collect = () => {
      const next = mapHeadings(parsed, [...element.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")]);
      setElements((current) => (sameElements(current, next) ? current : next));
    };
    collect();
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(collect);
    observer.observe(element, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [root, parsed, contentKey]);
  return elements;
}

/** Index of the heading nearest the top of the scroll area; null until one has been seen. */
export function useActiveHeading(scroller: RefObject<HTMLElement | null>, elements: readonly (HTMLElement | null)[]): [number | null, (index: number) => void] {
  const [active, setActive] = useState<number | null>(null);
  useEffect(() => {
    setActive(null);
    if (typeof IntersectionObserver === "undefined") return;
    const visible = new Set<number>();
    const observer = new IntersectionObserver(
      (entries) => {
        let leftBelow: number | null = null;
        for (const entry of entries) {
          const index = elements.indexOf(entry.target as HTMLElement);
          if (index === -1) continue;
          if (entry.isIntersecting) visible.add(index);
          else {
            visible.delete(index);
            // A heading that slid back down out of the reading zone hands over to the one before it.
            if (entry.boundingClientRect.top > (entry.rootBounds?.top ?? 0)) leftBelow = Math.max(index - 1, 0);
          }
        }
        if (visible.size > 0) setActive(Math.min(...visible));
        else if (leftBelow !== null) setActive(leftBelow);
      },
      // Only the top 30% of the scroll area counts as "where the reader is".
      { root: scroller.current, rootMargin: "0px 0px -70% 0px" },
    );
    for (const element of elements) if (element) observer.observe(element);
    return () => observer.disconnect();
  }, [scroller, elements]);
  return [active, setActive];
}
