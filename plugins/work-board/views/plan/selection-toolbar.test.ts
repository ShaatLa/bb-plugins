import { describe, expect, it } from "vitest";
import { placeFloating } from "./selection-toolbar";

const viewport = { width: 1000, height: 700 };
const size = { width: 168, height: 36 };

describe("placeFloating", () => {
  it("centers under the selection when there is room", () => {
    expect(placeFloating({ x: 500, y: 200, top: 180 }, size, viewport)).toEqual({ left: 416, top: 206 });
  });

  it("keeps the box inside the right and left edges", () => {
    expect(placeFloating({ x: 990, y: 200, top: 180 }, size, viewport).left).toBe(1000 - 168 - 8);
    expect(placeFloating({ x: 2197, y: 200, top: 180 }, size, viewport).left).toBe(1000 - 168 - 8);
    expect(placeFloating({ x: 2, y: 200, top: 180 }, size, viewport).left).toBe(8);
  });

  it("flips above the selection when there is no room below", () => {
    expect(placeFloating({ x: 500, y: 690, top: 660 }, size, viewport).top).toBe(660 - 6 - 36);
  });

  it("stays below, inside the viewport, when there is no room above either", () => {
    const tall = { width: 280, height: 176 };
    expect(placeFloating({ x: 500, y: 150, top: 20 }, tall, { width: 1000, height: 250 })).toEqual({ left: 360, top: 250 - 176 - 8 });
  });
});
