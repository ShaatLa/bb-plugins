import { afterEach, expect, it, vi } from "vitest";
import { createMemoryStorage } from "../test-fixtures";
import { migrateBrowserPreferences } from "./migrate-preferences";

afterEach(() => vi.unstubAllGlobals());
it("migrates device preferences once, preserving current choices and rollback values", () => {
  const storage = createMemoryStorage({
    "bb-tasks-plus:last-project": "project-1",
    "bb-agent-board:last-project": "project-current",
    "bb-agent-board:preferences-migrated": "1",
    "bb-agent-board:query-snapshot:v1:tasks": "stale-agent-cache",
    "bb-tasks-plus:default-thread:project-1":
      '{"id":"thr_old","title":"Worker"}',
    "bb-tasks:view-preferences":
      '{"version":1,"lastUsed":"board","projects":{}}',
    "bb-tasks:list-preferences": "old-list",
    "bb-tasks:last-dispatch-preset": "preset-1",
    "bb-tasks:query-snapshot:v1:projects": "stale-cache",
    "bb-work-board:list-preferences": "new-list",
  });
  vi.stubGlobal("window", { localStorage: storage });
  migrateBrowserPreferences();
  expect(storage.getItem("bb-work-board:last-project")).toBe("project-current");
  expect(storage.getItem("bb-work-board:list-preferences")).toBe("new-list");
  expect(storage.getItem("bb-work-board:last-dispatch-preset")).toBe(
    "preset-1",
  );
  expect(
    storage.getItem("bb-work-board:query-snapshot:v1:projects"),
  ).toBeNull();
  expect(storage.getItem("bb-tasks-plus:last-project")).toBe("project-1");
  expect(storage.getItem("bb-work-board:query-snapshot:v1:tasks")).toBeNull();
  storage.removeItem("bb-work-board:default-thread:project-1");
  migrateBrowserPreferences();
  expect(storage.getItem("bb-work-board:default-thread:project-1")).toBeNull();
});
