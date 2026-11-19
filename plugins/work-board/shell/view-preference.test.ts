import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "../test-fixtures.js";
import {
  VIEW_PREFERENCE_STORAGE_KEY,
  VIEW_PREFERENCE_VERSION,
  loadViewMode,
  storeViewMode,
  loadLastProjectId,
  storeLastProjectId,
} from "./view-preference.js";

const PROJECT_A = "01HZZZZZZZZZZZZZZZZZZZZZP1";

let storage = createMemoryStorage();

beforeEach(() => {
  storage = createMemoryStorage();
  vi.stubGlobal("window", { localStorage: storage });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("view preference storage", () => {
  it("remembers the last project independently of the per-project view", () => {
    expect(loadLastProjectId()).toBeNull();
    storeLastProjectId(PROJECT_A);
    storeViewMode(PROJECT_A, "list");
    expect(loadLastProjectId()).toBe(PROJECT_A);
    expect(loadViewMode(PROJECT_A)).toBe("list");
  });
  it("falls back to the board before anything is stored", () => {
    expect(loadViewMode(PROJECT_A)).toBe("board");
  });

  it("drops choices saved before version 2, when the toggle drove the side panel", () => {
    storage.setItem(VIEW_PREFERENCE_STORAGE_KEY, JSON.stringify({ version: 1, lastUsed: "list", projects: { [PROJECT_A]: "list" } }));
    expect(loadViewMode(PROJECT_A)).toBe("board");
  });

  it("treats corrupt or partial documents as unset rather than throwing", () => {
    storage.setItem(VIEW_PREFERENCE_STORAGE_KEY, "{not json");
    expect(loadViewMode(PROJECT_A)).toBe("board");

    storage.setItem(
      VIEW_PREFERENCE_STORAGE_KEY,
      JSON.stringify({
        version: VIEW_PREFERENCE_VERSION,
        lastUsed: "kanban",
        projects: { [PROJECT_A]: "gallery" },
      }),
    );
    expect(loadViewMode(PROJECT_A)).toBe("board");
  });

  it("leaves a document written by a newer client untouched", () => {
    const future = JSON.stringify({
      version: VIEW_PREFERENCE_VERSION + 1,
      lastUsed: "board",
      projects: { [PROJECT_A]: "board" },
      timeline: "view a future build added",
    });
    storage.setItem(VIEW_PREFERENCE_STORAGE_KEY, future);

    expect(loadViewMode(PROJECT_A)).toBe("board");
    storeViewMode(PROJECT_A, "list");
    expect(storage.getItem(VIEW_PREFERENCE_STORAGE_KEY)).toBe(future);
  });
});
