import type { ComponentType } from "react";
import type { ExperimentalThreadTabProps, PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { Task } from "./shared/contract.js";

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "01HZZZZZZZZZZZZZZZZZZZZZT1",
    projectId: "01HZZZZZZZZZZZZZZZZZZZZZP1",
    number: 1,
    key: "TSK-1",
    title: "Test task",
    description: "",
    status: "todo",
    archivedAt: null,
    priority: "none",
    dueDate: null,
    parentTaskId: null,
    type: "task",
    executionTarget: "agent",
    requesterThreadId: null,
    epicId: null,
    position: 0,
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    labelIds: [],
    ...overrides,
  };
}

export function rpcInput(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(
      `expected an RPC input object, got ${JSON.stringify(input)}`,
    );
  }
  return Object.fromEntries(Object.entries(input));
}

export function createMemoryStorage(
  initialEntries: Record<string, string> = {},
): Storage {
  const entries = new Map(Object.entries(initialEntries));
  return {
    get length() {
      return entries.size;
    },
    clear: () => {
      entries.clear();
    },
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => {
      entries.delete(key);
    },
    setItem: (key, value) => {
      entries.set(key, String(value));
    },
  };
}

/** The fixed Work Board tab of the thread side panel. */
export function taskTab(app: { tabs: readonly { id: string; context: { kind: string } }[] }) {
  const tab = app.tabs.find((candidate) => candidate.id === "task" && candidate.context.kind === "thread");
  if (!tab) throw new Error("Work Board thread tab is not registered");
  // The collector types tabs as a union of contexts; this one is the thread tab.
  return tab as unknown as { component: ComponentType<ExperimentalThreadTabProps>; layout?: "flush" | "padded" };
}

/** Fakes the GitHub PR Status keyed `pullRequests` read from a per-environment lookup. */
export function prStatusPlugin(lookup: (args: { environmentId: string }) => unknown) {
  return {
    callRpc: async ({ input }: { input?: unknown }) => {
      const { keys } = input as { keys: string[] };
      return Object.fromEntries(
        await Promise.all(keys.map(async (key) => [key, await lookup({ environmentId: key })] as const)),
      );
    },
  } as never;
}

/** A fixed tab of the Work Board page side panel ("navigation" or "kanban"). */
export function navTab(app: { tabs: readonly { id: string; context: { kind: string } }[] }, id: string) {
  const tab = app.tabs.find((candidate) => candidate.id === id && candidate.context.kind === "nav-panel");
  if (!tab) throw new Error(`Work Board page tab ${id} is not registered`);
  return tab as unknown as { component: ComponentType<PluginNavPanelProps>; layout?: "flush" | "padded" };
}
