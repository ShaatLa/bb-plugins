// @vitest-environment jsdom
import { z } from "zod";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
