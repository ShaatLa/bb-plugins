// @vitest-environment jsdom
import { z } from "zod";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Task } from "../shared/contract";
import { makeTask } from "../test-fixtures";
import type { TasksRpc } from "./data";
import { querySnapshotStorageKey, readQuerySnapshot, resetQuerySnapshotStateForTest, writeQuerySnapshot } from "./query-snapshot";

beforeEach(() => { resetQuerySnapshotStateForTest(); localStorage.clear(); vi.useFakeTimers(); });
afterEach(() => { resetQuerySnapshotStateForTest(); vi.useRealTimers(); });
it("prunes without skipping keys or counting a replacement twice", () => {
  localStorage.setItem("unrelated", "keep");
  for (let i = 0; i < 32; i++) localStorage.setItem(querySnapshotStorageKey(`key${i}`), JSON.stringify("x".repeat(20_000)));
  writeQuerySnapshot("key0", "latest".repeat(100_000), 2);
  vi.advanceTimersByTime(25);
  const keys = Object.keys(localStorage).filter(key => key.startsWith("bb-work-board:"));
  expect(keys.length).toBeLessThanOrEqual(32);
  expect(keys.reduce((bytes, key) => bytes + (key.length + localStorage.getItem(key)!.length) * 2, 0)).toBeLessThanOrEqual(2 * 1024 * 1024);
  expect(localStorage.getItem("unrelated")).toBe("keep");
  expect(readQuerySnapshot("key0", z.string())).toBe("latest".repeat(100_000));
});
it("keeps revision ordering after an oversized write is skipped and bounds pending keys", () => {
  writeQuerySnapshot("big", "x".repeat(2 * 1024 * 1024), 2);
  vi.advanceTimersByTime(25);
  writeQuerySnapshot("big", "stale", 1);
  for (let i = 0; i < 50; i++) writeQuerySnapshot(`pending${i}`, i, 1);
  expect(vi.getTimerCount()).toBe(32);
  vi.advanceTimersByTime(25);
  expect(localStorage.getItem(querySnapshotStorageKey("big"))).toBeNull();
  expect(Object.keys(localStorage)).toHaveLength(32);
});

it("keeps the task dataset, board metadata and sidebar snapshots resident while switching between All tasks and a project", async () => {
  const { loadTaskDataset } = await import("./task-dataset");
  const removed: string[] = [];
  const remove = Storage.prototype.removeItem;
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (this: Storage, key: string) { removed.push(key); return remove.call(this, key); });
  // Body-heavy synthetic tasks served the way the real handler does: bodies only unless `omitBodies` is sent.
  const bodyHeavy = (scope: string) => Array.from({ length: 300 }, (_, index) => makeTask({
    id: `${scope}-${index}`, key: `EXA-${index}`, title: `Card ${index}`, description: "Acceptance criteria. ".repeat(100), progressNote: "Progress note. ".repeat(20),
  }));
  const rows: Record<string, Task[]> = { all: bodyHeavy("all"), proj: bodyHeavy("proj") };
  const rpc = { async call(_method: string, input: { projectId?: string; omitBodies?: boolean }) {
    const tasks = rows[input.projectId ?? "all"]!;
    return { tasks: input.omitBodies ? tasks.map((task) => ({ ...task, description: "", progressNote: null })) : tasks, nextCursor: null };
  } } as unknown as TasksRpc;
  const payloads: Record<string, unknown> = {
    "task-search-index:all": await loadTaskDataset(rpc, null), "task-search-index:proj": await loadTaskDataset(rpc, "proj"),
    "board-metadata:proj": "m".repeat(146_000), projects: "s".repeat(3_000), folders: "s".repeat(3_000), "sidebar-summary": "s".repeat(3_000),
  };
  let revision = 0;
  const put = (name: string) => { writeQuerySnapshot(name, payloads[name], ++revision); vi.advanceTimersByTime(25); };
  for (const name of ["projects", "folders", "sidebar-summary"]) put(name);
  for (let cycle = 0; cycle < 5; cycle++) {
    put("task-search-index:all");
    put("task-search-index:proj"); put("board-metadata:proj");
  }
  expect(removed).toEqual([]);
  for (const name of Object.keys(payloads)) expect(localStorage.getItem(querySnapshotStorageKey(name))).not.toBeNull();
  vi.restoreAllMocks();
});
