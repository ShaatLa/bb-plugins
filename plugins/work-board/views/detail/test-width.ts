import { afterEach, beforeEach, vi } from "vitest";

/**
 * jsdom has no layout: make every element report a width, as the task view's initial measurement reads it.
 * Returns a setter for tests that need another width before they render.
 */
export function stubDetailWidth(initial: number): (width: number) => void {
  let width = initial;
  let spy: { mockRestore: () => void } | undefined;
  beforeEach(() => {
    width = initial;
    spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
      width, height: 600, top: 0, left: 0, right: width, bottom: 600, x: 0, y: 0, toJSON: () => ({}),
    }) as DOMRect);
  });
  afterEach(() => spy?.mockRestore());
  return (next) => { width = next; };
}
