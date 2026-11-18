import { useLayoutEffect, useRef, type RefObject } from 'react';

// Rows marked data-flip glide from their old place to the new one after a re-order, like a drop in drag-and-drop.
export function useFlip(root: RefObject<HTMLElement | null>) {
  const tops = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches, next = new Map<string, number>();
    // offsetTop ignores running transforms and the list's scroll, so a re-render mid-glide measures the real layout.
    for (const el of Array.from(node.querySelectorAll<HTMLElement>('[data-flip]'))) {
      const key = el.dataset.flip!, top = el.offsetTop, was = tops.current.get(key);
      next.set(key, top);
      if (!still && was !== undefined && Math.abs(was - top) > 1) el.animate?.([{ transform: `translateY(${was - top}px)` }, { transform: 'none' }], { duration: 280, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
    }
    tops.current = next;
  });
}
