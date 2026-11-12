// @vitest-environment jsdom
import { act, cleanup } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, expect, it, vi } from "vitest";
import type { MentionItem } from "../editor/extensions.js";
import { makeTask } from "../test-fixtures.js";
import { useMentionItems } from "./data.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const task = (key: string, number: number) =>
  makeTask({ id: `01HZT${number}`, projectId: PROJECT_ID, number, key, title: key, position: number });

// Captures the hook's search function so tests can drive it like the editor does.
function renderMentions(rpc: Record<string, (input: never) => unknown>) {
  let getItems: (query: string) => Promise<MentionItem[]> = () => Promise.resolve([]);
  function Probe() {
    getItems = useMentionItems();
    return null;
  }
  const slot = renderSlot({ component: Probe } as never, {}, { rpc: rpc as never });
  return { slot, getItems: (query: string) => getItems(query) };
}

it("debounces keystrokes into one search whose result every superseded call receives", async () => {
  vi.useFakeTimers();
  const { slot, getItems } = renderMentions({
    listTasks: () => ({ tasks: [task("TSK-1", 1)] }),
    searchThreads: () => ({ threads: [] }),
  });
  const first = getItems("a");
  const second = getItems("au");
  const third = getItems("auth");
  await act(() => vi.advanceTimersByTimeAsync(150));
  const [a, au, auth] = await Promise.all([first, second, third]);
  expect(a).toEqual(auth);
  expect(au).toEqual(auth);
  const searches = slot.inspection.rpcCalls.filter(({ method }) => method === "listTasks");
  expect(searches.map(({ input }) => (input as { search?: string }).search)).toEqual(["auth"]);
});

it("runs an empty query without waiting for the debounce", async () => {
  vi.useFakeTimers();
  const { slot, getItems } = renderMentions({
    listTasks: () => ({ tasks: [] }),
    searchThreads: () => ({ threads: [] }),
  });
  const items = getItems("");
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(await items).toEqual([]);
  expect(slot.inspection.rpcCalls.filter(({ method }) => method === "listTasks")).toHaveLength(1);
});

it("does not let a slower, older response overwrite a newer search", async () => {
  vi.useFakeTimers();
  let releaseStale: ((value: { tasks: unknown[] }) => void) | undefined;
  const { getItems } = renderMentions({
    listTasks: (input: { search?: string }) =>
      input.search === "au"
        ? new Promise((resolve) => {
            releaseStale = resolve;
          })
        : { tasks: [task("TSK-2", 2)] },
    searchThreads: () => ({ threads: [] }),
  });
  const stale = getItems("au");
  await act(() => vi.advanceTimersByTimeAsync(150));
  const fresh = getItems("auth");
  await act(() => vi.advanceTimersByTimeAsync(150));
  const freshItems = await fresh;
  expect(freshItems.map((item) => item.type === "task" && item.key)).toEqual(["TSK-2"]);

  releaseStale!({ tasks: [task("TSK-9", 9)] });
  expect(await stale).toEqual(freshItems);
});
