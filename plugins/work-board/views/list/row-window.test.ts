import { describe, expect, it } from "vitest";
import { ROW_WINDOW_THRESHOLD, rowWindows } from "./row-window.js";

const base = { headerHeight: 40, rowHeight: 36, viewportHeight: 700 };

describe("rowWindows", () => {
  it("renders small groups in full", () => {
    expect(rowWindows({ ...base, counts: [3, 10], scrollTop: 0 })).toEqual([
      [0, 3],
      [0, 10],
    ]);
  });

  it("windows a large group around the viewport", () => {
    const [range] = rowWindows({ ...base, counts: [5000], scrollTop: 36_000 });
    const [start, end] = range!;
    const firstVisible = Math.floor((36_000 - base.headerHeight) / 36);
    const lastVisible = Math.ceil((36_700 - base.headerHeight) / 36);
    expect(start).toBeLessThanOrEqual(firstVisible);
    expect(end).toBeGreaterThanOrEqual(lastVisible);
    expect(end - start).toBeLessThan(200);
  });

  it("offsets later groups by the rows above them", () => {
    const above = ROW_WINDOW_THRESHOLD - 20;
    const [first, second] = rowWindows({
      ...base,
      counts: [above, 5000],
      scrollTop: 0,
    });
    expect(first![0]).toBe(0);
    expect(first![1]).toBeLessThanOrEqual(above);
    expect(second).toEqual([0, 0]);
  });

  it("windows many mid-size groups once the whole list is large", () => {
    const counts = [94, 44, 15, 14, 13, 5, 4];
    const ranges = rowWindows({ ...base, counts, scrollTop: 0 });
    const mounted = ranges.reduce((sum, [start, end]) => sum + end - start, 0);
    expect(mounted).toBeLessThan(60);
    expect(ranges[0]![0]).toBe(0);
    for (const [start, end] of ranges.slice(2)) expect(end - start).toBe(0);
  });

  it("keeps ranges contiguous with spacers when scrolled into a mid group", () => {
    const counts = [100, 100, 100];
    const scrollTop = 40 + 100 * 36 + 40 + 50 * 36;
    const ranges = rowWindows({ ...base, counts, scrollTop });
    expect(ranges[0]).toEqual([100, 100]);
    expect(ranges[1]![0]).toBeGreaterThan(0);
    expect(ranges[1]![0]).toBeLessThanOrEqual(50);
    expect(ranges[1]![1]).toBeGreaterThanOrEqual(50);
    expect(ranges[2]![1]).toBe(0);
  });

  it("renders a small list in full across several groups", () => {
    const counts = [40, 30, 20, 10];
    expect(
      rowWindows({ ...base, counts, scrollTop: 0 }),
    ).toEqual(counts.map((count) => [0, count]));
  });

  it("falls back to a bounded slice before the viewport is measured", () => {
    const [range] = rowWindows({
      counts: [5000],
      headerHeight: 0,
      rowHeight: 0,
      scrollTop: 0,
      viewportHeight: 0,
    });
    expect(range![0]).toBe(0);
    expect(range![1]).toBeLessThan(5000);
  });
});
