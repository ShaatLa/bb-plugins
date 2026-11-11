// @vitest-environment jsdom
import { act, cleanup, fireEvent } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { makeTask, rpcInput } from "../../test-fixtures.js";
import { WorkBoardTaskEmbed, type WorkBoardHost } from "../../embed.js";

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
    dispatchEvent: () => false,
  });
}

afterEach(() => cleanup());

const task = makeTask({ id: "01HZZZZZZZZZZZZZZZZZZZZZT1", projectId: "01HZZZZZZZZZZZZZZZZZZZZZP1", number: 4, key: "TSK-4", title: "Embedded from Answers" });

/** A host backed by an in-memory RPC map and a local realtime bus, like a foreign plugin would provide. */
function fakeHost(title: () => string) {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const results: Record<string, (input: unknown) => unknown> = {
    getTaskByKey: () => ({ task: { ...task, title: title() } }),
    listProjects: () => ({ projects: [] }),
    getTask: () => ({ task: null }),
    listTasks: () => ({ tasks: [] }),
    listLabels: () => ({ labels: [] }),
    listAttachments: () => ({ attachments: [] }),
    listTaskThreads: () => ({ taskThreads: [] }),
    listPresets: () => ({ presets: [] }),
    listQuestions: () => ({ questions: [] }),
    listComments: () => ({ comments: [] }),
    searchThreads: () => ({ threads: [] }),
  };
  const call = vi.fn(async (method: string, input?: unknown) => {
    const result = results[method];
    if (!result) throw new Error(`unexpected ${method}`);
    return result(input);
  });
  const host: WorkBoardHost = {
    call,
    useRealtime(channel, handler) {
      const latest = useRef(handler);
      latest.current = handler;
      useEffect(() => {
        const listener = (payload: unknown) => latest.current(payload);
        const set = listeners.get(channel) ?? new Set();
        listeners.set(channel, set.add(listener));
        return () => void set.delete(listener);
      }, [channel]);
    },
    openInWorkBoard: vi.fn(),
  };
  const emit = (channel: string, payload: unknown) => act(() => listeners.get(channel)?.forEach((listener) => listener(payload)));
  return { host, call, emit };
}

describe("WorkBoardTaskEmbed", () => {
  it("loads the task through the injected host, not the embedding plugin's RPC", async () => {
    const { host, call } = fakeHost(() => "Embedded from Answers");
    const slot = renderSlot({ component: WorkBoardTaskEmbed }, { taskKey: "TSK-4", host }, { rpc: {} });

    await slot.findByText("Embedded from Answers");
    expect(call.mock.calls.some(([method, input]) => method === "getTaskByKey" && rpcInput(input).taskKey === "TSK-4")).toBe(true);
    expect(slot.rpcCalls).toEqual([]);

    fireEvent.click(slot.getByRole("button", { name: "Open TSK-4 in Work Board" }));
    expect(host.openInWorkBoard).toHaveBeenCalledWith("task/TSK-4");
    expect(slot.navigateCalls).toEqual([]);
  });

  it("refreshes on the host's realtime events and ignores the embedding plugin's channel", async () => {
    let title = "Before";
    const { host, emit } = fakeHost(() => title);
    const slot = renderSlot({ component: WorkBoardTaskEmbed }, { taskKey: "TSK-4", host }, { rpc: {} });
    await slot.findByText("Before");

    title = "After";
    await slot.emitRealtime("tasks:changed", { taskId: task.id });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(slot.queryByText("After")).toBeNull();

    emit("tasks:changed", { taskId: task.id });
    await slot.findByText("After");
  });
});
