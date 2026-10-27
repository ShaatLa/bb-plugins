import { expect, it } from "vitest";
import { cardLayout, cardWindow } from "./card-window";

it("bounds rendered cards while preserving the full variable-height scroll geometry", () => {
  const ids = Array.from({ length: 2500 }, (_, index) => String(index));
  const sizes = new Map([["0", 70], ["1", 300], ["2499", 200]]);
  const layout = cardLayout(ids, sizes);
  for (const scroll of [0, 500, 20_000, layout.total, 1_000_000]) {
    const range = cardWindow(layout, scroll, 600);
    expect(range.end - range.start).toBeLessThan(25);
    expect(range.end).toBeGreaterThan(range.start);
    const visible = layout.heights.slice(range.start, range.end).reduce((sum, height) => sum + height, 0)
      + Math.max(0, range.end - range.start - 1) * 8;
    expect(range.before + (range.start ? 8 : 0) + visible + (range.end < ids.length ? 8 : 0) + range.after).toBe(layout.total);
  }
  expect(cardWindow(layout, layout.total, 600).end).toBe(2500);
  expect(cardWindow(layout, 0, 600).start).toBe(0);
});
