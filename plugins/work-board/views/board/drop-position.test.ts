import { describe, expect, it, vi } from "vitest";
import type { TaskStatus } from "../../shared/contract.js";
import {
  applyBoardMove,
  dropIndexForLayout,
  dropIndexForPointer,
  dropNeighborsForIndex,
  updateDragState,
  visibleBoardStatuses,
} from "./drop-position.js";
import { cardLayout } from "./card-window.js";

describe("visibleBoardStatuses", () => {
  const columns = (canceled: number): Record<TaskStatus, unknown[]> => ({
    backlog: [],
    todo: ["t1"],
    in_progress: [],
    in_review: [],
    done: [],
    canceled: Array.from({ length: canceled }, (_, index) => `c${index}`),
  });

  it("hides the Canceled column while it is empty", () => {
    expect(visibleBoardStatuses(columns(0))).toEqual([
      "backlog",
      "todo",
      "in_progress",
      "in_review",
      "done",
    ]);
  });

  it("shows Canceled once it holds cards", () => {
    expect(visibleBoardStatuses(columns(2))).toEqual([
      "backlog",
      "todo",
      "in_progress",
      "in_review",
      "done",
      "canceled",
    ]);
  });

  it("keeps Canceled in its configured position", () => {
    expect(visibleBoardStatuses({ backlog: [], canceled: ["c1"], in_testing: [], done: [] })).toEqual([
      "backlog", "canceled", "in_testing", "done",
    ]);
  });
});

describe("dropNeighborsForIndex", () => {
  const column = ["a", "b", "c"];

  it("returns both neighbors for a drop between cards in another column", () => {
    expect(dropNeighborsForIndex(column, "dragged", 1)).toEqual({
      beforeTaskId: "a",
      afterTaskId: "b",
    });
  });

  it("returns only an after neighbor at the top of a column", () => {
    expect(dropNeighborsForIndex(column, "dragged", 0)).toEqual({
      beforeTaskId: null,
      afterTaskId: "a",
    });
  });

  it("returns only a before neighbor at the bottom of a column", () => {
    expect(dropNeighborsForIndex(column, "dragged", 3)).toEqual({
      beforeTaskId: "c",
      afterTaskId: null,
    });
  });

  it("returns no neighbors for an empty column", () => {
    expect(dropNeighborsForIndex([], "dragged", 0)).toEqual({
      beforeTaskId: null,
      afterTaskId: null,
    });
  });

  it("excludes the dragged card on a same-column reorder", () => {
    expect(dropNeighborsForIndex(column, "a", 1)).toEqual({
      beforeTaskId: "b",
      afterTaskId: "c",
    });
  });

  it("clamps out-of-range indexes into the column", () => {
    expect(dropNeighborsForIndex(column, "dragged", 99)).toEqual({
      beforeTaskId: "c",
      afterTaskId: null,
    });
    expect(dropNeighborsForIndex(column, "dragged", -1)).toEqual({
      beforeTaskId: null,
      afterTaskId: "a",
    });
  });
});

describe("dropIndexForPointer", () => {
  const centers = [10, 30, 50];

  it("maps a pointer above every card to the top slot", () => {
    expect(dropIndexForPointer(centers, 5)).toBe(0);
  });

  it("maps a pointer between card centers to the slot between them", () => {
    expect(dropIndexForPointer(centers, 20)).toBe(1);
    expect(dropIndexForPointer(centers, 40)).toBe(2);
  });

  it("maps a pointer below every card to the end slot", () => {
    expect(dropIndexForPointer(centers, 100)).toBe(3);
  });

  it("returns 0 for an empty column", () => {
    expect(dropIndexForPointer([], 42)).toBe(0);
  });
});

describe("dropIndexForLayout", () => {
  it("uses variable-height card centers and excludes the dragged card at boundaries", () => {
    const layout = cardLayout(["a", "b", "c"], new Map([["a", 40], ["b", 100], ["c", 20]]));
    expect(dropIndexForLayout(layout, 20, "elsewhere")).toBe(0);
    expect(dropIndexForLayout(layout, 20.01, "elsewhere")).toBe(1);
    expect(dropIndexForLayout(layout, 98, "elsewhere")).toBe(1);
    expect(dropIndexForLayout(layout, 98.01, "elsewhere")).toBe(2);
    expect(dropIndexForLayout(layout, 160, "b")).toBe(1);
    expect(dropIndexForLayout(layout, 166.01, "b")).toBe(2);
    expect(dropIndexForLayout(layout, 999, "c")).toBe(2);
  });

  it("reads logarithmically many card positions in a large column", () => {
    const layout = cardLayout(Array.from({ length: 327 }, (_, index) => String(index)), new Map());
    let reads = 0;
    const positions = new Proxy(layout.offsets, { get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    } });
    expect(dropIndexForLayout({ ...layout, offsets: positions }, 10_000, "170")).toBeGreaterThan(0);
    expect(reads).toBeLessThanOrEqual(9);
  });
});

it("retains the same drag state when the pointer and drop position are unchanged", () => {
  const current = { x: 10, y: 20, overStatus: "todo" as TaskStatus, dropIndex: 2 };
  const setDrag = vi.fn();
  expect(updateDragState(current, { ...current }, setDrag)).toBe(current);
  expect(setDrag).not.toHaveBeenCalled();
  expect(updateDragState(current, { ...current, x: 11 }, setDrag)).not.toBe(current);
  expect(updateDragState(current, { ...current, dropIndex: 3 }, setDrag)).not.toBe(current);
  expect(updateDragState(null, current, setDrag)).toBe(current);
  expect(setDrag).toHaveBeenCalledTimes(3);
});

describe("applyBoardMove", () => {
  const task = (id: string, status: TaskStatus) => ({ id, status });
  const columns = () => ({
    backlog: [task("a", "backlog"), task("b", "backlog")],
    todo: [task("c", "todo")],
    in_progress: [],
    in_review: [],
    done: [],
    canceled: [],
  });

  it("moves a card across columns and updates its status", () => {
    const next = applyBoardMove(columns(), "a", "todo", 1);
    expect(next.backlog.map((t) => t.id)).toEqual(["b"]);
    expect(next.todo.map((t) => t.id)).toEqual(["c", "a"]);
    expect(next.todo[1]).toEqual({ id: "a", status: "todo" });
  });

  it("reorders within a column using the dragged-excluded index", () => {
    const next = applyBoardMove(columns(), "a", "backlog", 1);
    expect(next.backlog.map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("leaves the board unchanged for an unknown task", () => {
    const next = applyBoardMove(columns(), "nope", "todo", 0);
    expect(next.backlog.map((t) => t.id)).toEqual(["a", "b"]);
    expect(next.todo.map((t) => t.id)).toEqual(["c"]);
  });
});


it("keeps configured custom columns and moves cards into and out of them", () => {
  const columns = { backlog: [{ id: "a", status: "backlog" }], in_testing: [], todo: [], in_progress: [], in_review: [], done: [], canceled: [] };
  expect(visibleBoardStatuses(columns)).toEqual(["backlog", "in_testing", "todo", "in_progress", "in_review", "done"]);
  const moved = applyBoardMove(columns, "a", "in_testing", 0);
  expect(moved.in_testing).toEqual([{ id: "a", status: "in_testing" }]);
  expect(applyBoardMove(moved, "a", "done", 0).in_testing).toEqual([]);
});
