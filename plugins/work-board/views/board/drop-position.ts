import { type TaskStatus } from "../../shared/contract.js";
import { type cardLayout } from "./card-window.js";

export const BOARD_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
] as const satisfies readonly TaskStatus[];

export function visibleBoardStatuses(
  columns: Readonly<Record<TaskStatus, readonly unknown[]>>,
): TaskStatus[] {
  return Object.keys(columns).filter(
    (status) => status !== "canceled" || columns[status]!.length > 0,
  );
}

interface BoardDropNeighbors {
  beforeTaskId: string | null;
  afterTaskId: string | null;
}

export function dropNeighborsForIndex(
  columnTaskIds: readonly string[],
  draggedTaskId: string,
  dropIndex: number,
): BoardDropNeighbors {
  const ids = columnTaskIds.filter((id) => id !== draggedTaskId);
  const index = Math.max(0, Math.min(dropIndex, ids.length));
  return {
    beforeTaskId: ids[index - 1] ?? null,
    afterTaskId: ids[index] ?? null,
  };
}

export function dropIndexForPointer(
  cardCenterYs: readonly number[],
  pointerY: number,
): number {
  let index = 0;
  for (const centerY of cardCenterYs) {
    if (pointerY > centerY) index += 1;
  }
  return index;
}

export function dropIndexForLayout(
  layout: ReturnType<typeof cardLayout>,
  pointerY: number,
  draggedTaskId: string,
): number {
  const excluded = layout.indices.get(draggedTaskId) ?? layout.heights.length;
  let low = 0;
  let high = layout.heights.length - Number(excluded < layout.heights.length);
  while (low < high) {
    const mid = (low + high) >>> 1;
    const index = mid >= excluded ? mid + 1 : mid;
    const center = layout.offsets[index]! + layout.heights[index]! / 2;
    if (pointerY > center) low = mid + 1;
    else high = mid;
  }
  return low;
}

export function updateDragState<T extends { x: number; y: number; overStatus: TaskStatus | null; dropIndex: number }>(
  current: T | null,
  next: T,
  setDrag: (next: T) => void,
): T {
  if (current && current.x === next.x && current.y === next.y &&
    current.overStatus === next.overStatus && current.dropIndex === next.dropIndex) return current;
  setDrag(next);
  return next;
}

export function applyBoardMove<T extends { id: string; status: TaskStatus }>(
  columns: Readonly<Record<TaskStatus, readonly T[]>>,
  taskId: string,
  toStatus: TaskStatus,
  dropIndex: number,
): Record<TaskStatus, T[]> {
  let moved: T | undefined;
  const next: Record<TaskStatus, T[]> = {};
  for (const [status, tasks] of Object.entries(columns)) {
    next[status] = tasks.filter((task) => {
      if (task.id !== taskId) return true;
      moved = task;
      return false;
    });
  }
  if (!moved) return next;
  const destination = next[toStatus] ?? (next[toStatus] = []);
  const index = Math.max(0, Math.min(dropIndex, destination.length));
  destination.splice(index, 0, { ...moved, status: toStatus });
  return next;
}
