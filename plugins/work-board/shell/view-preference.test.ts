import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "../test-fixtures.js";
import {
  VIEW_PREFERENCE_STORAGE_KEY,
  VIEW_PREFERENCE_VERSION,
  loadViewMode,
  storeViewMode,
  loadLastProjectId,
  storeLastProjectId,
  loadKanbanChoice,
  storeKanbanChoice,
} from "./view-preference.js";

const PROJECT_A = "01HZZZZZZZZZZZZZZZZZZZZZP1";

let storage = createMemoryStorage();
let session = createMemoryStorage();

beforeEach(() => {
  storage = createMemoryStorage();
  session = createMemoryStorage();
  vi.stubGlobal("window", { localStorage: storage, sessionStorage: session });
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

describe("kanban panel choice", () => {
  const KEY = "bb-work-board:kanban-project";
  it("round-trips in session storage only", () => {
    expect(loadKanbanChoice()).toBeNull();
    storeKanbanChoice({ projectId: PROJECT_A, followed: null });
    expect(loadKanbanChoice()).toEqual({ projectId: PROJECT_A, followed: null });
    expect(storage.getItem(KEY)).toBeNull();
  });
  it.each(["{not json", "[]", "null", "\"text\"", "{}", JSON.stringify({ projectId: 1, followed: null }), JSON.stringify({ projectId: null })])("reads %s as nothing stored", (raw) => {
    session.setItem(KEY, raw);
    expect(loadKanbanChoice()).toBeNull();
  });
  it("tolerates storage that throws", () => {
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    vi.stubGlobal("window", { localStorage: storage, sessionStorage: broken });
    expect(loadKanbanChoice()).toBeNull();
    expect(() => storeKanbanChoice({ projectId: PROJECT_A, followed: PROJECT_A })).not.toThrow();
  });
  it("round-trips an open task or plan, and every write merges into what is stored", () => {
    storeKanbanChoice({ projectId: PROJECT_A, followed: PROJECT_A });
    storeKanbanChoice({ open: { kind: "task", taskKey: "EXA-1" } });
    expect(loadKanbanChoice()).toEqual({ projectId: PROJECT_A, followed: PROJECT_A, open: { kind: "task", taskKey: "EXA-1" } });
    storeKanbanChoice({ projectId: "proj_other", followed: "proj_other" });
    expect(loadKanbanChoice()).toEqual({ projectId: "proj_other", followed: "proj_other", open: { kind: "task", taskKey: "EXA-1" } });
    storeKanbanChoice({ open: { kind: "plan", taskKey: "EXA-1" } });
    expect(loadKanbanChoice()?.open).toEqual({ kind: "plan", taskKey: "EXA-1" });
    storeKanbanChoice({ open: null });
    expect(loadKanbanChoice()).toEqual({ projectId: "proj_other", followed: "proj_other" });
  });
  it.each([
    [{ kind: "board", taskKey: "EXA-1" }], [{ kind: "task" }], [{ kind: "task", taskKey: "no key" }], [{ kind: "task", taskKey: 5 }], ["EXA-1"], [null], [[]],
  ])("ignores a malformed open %j and keeps the rest", (open) => {
    session.setItem(KEY, JSON.stringify({ projectId: PROJECT_A, followed: null, open }));
    expect(loadKanbanChoice()).toEqual({ projectId: PROJECT_A, followed: null });
  });
});
