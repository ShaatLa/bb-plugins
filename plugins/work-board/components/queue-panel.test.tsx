// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QueueChip } from "./queue-chip";
import { QueuePanel } from "./queue-panel";

const calls: [string, unknown][] = [];
const queues = [{ projectId: "proj_example", threadId: "thr_example", entries: [
  { taskId: "t1", key: "EXA-1", title: "First", status: "in_progress", position: 1, addedBy: "owner", addedAt: "2026-01-01T00:00:00.000Z" },
  { taskId: "t2", key: "EXA-2", title: "Second", status: "todo", position: 2, addedBy: "owner", addedAt: "2026-01-01T00:00:00.000Z" },
] }];
vi.mock("@get-bb/plugin-sdk/app", async (actual) => ({ ...await actual<object>(), useSdk: () => ({ threads: { get: async () => ({ title: "Example executor" }) } }) }));
vi.mock("../shell/data", () => ({
  useTasksRpc: () => ({ call: async (method: string, input: unknown) => { calls.push([method, input]); return {}; } }),
  useTasksQuery: () => ({ data: queues, refresh: vi.fn() }),
}));
vi.mock("../shell/routes", () => ({ useTasksNavigation: () => ({ go: vi.fn() }) }));
afterEach(() => { cleanup(); calls.length = 0; });

it("shows the chip on a waiting and on the current card", async () => {
  render(<><QueueChip queue={{ threadId: "thr_example", position: 3 }} /><QueueChip queue={{ threadId: "thr_example", position: 1 }} /></>);
  await waitFor(() => expect(screen.getByText("Queued #3 · Example executor")).toBeTruthy());
  expect(screen.getByText("Current in queue · Example executor")).toBeTruthy();
});

it("lists the queue in order, reorders by drag and removes a card", async () => {
  render(<QueuePanel threadId="thr_example" />);
  const items = screen.getAllByRole("listitem");
  expect(items.map((item) => item.textContent)).toEqual([expect.stringContaining("CurrentEXA-1 · First"), expect.stringContaining("#2EXA-2 · Second")]);
  const data = { effectAllowed: "" };
  fireEvent.dragStart(items[1]!, { dataTransfer: data });
  fireEvent.dragOver(items[0]!, { dataTransfer: data });
  fireEvent.drop(items[0]!, { dataTransfer: data });
  await waitFor(() => expect(calls).toContainEqual(["queueMove", { taskId: "t2", position: 1, actor: "owner" }]));
  fireEvent.click(screen.getByRole("button", { name: "Remove EXA-2 from the queue" }));
  await waitFor(() => expect(calls).toContainEqual(["queueRemove", { taskId: "t2", actor: "owner" }]));
});

it("keeps each project's queue apart and refuses a drop into another project's queue", async () => {
  queues.push({ projectId: "proj_other", threadId: "thr_example", entries: [
    { taskId: "o1", key: "OTH-1", title: "Other", status: "todo", position: 1, addedBy: "owner", addedAt: "2026-01-01T00:00:00.000Z" },
  ] });
  try {
    render(<QueuePanel threadId="thr_example" />);
    expect(screen.getAllByRole("list").map((list) => list.getAttribute("aria-label"))).toEqual(["EXA queue", "OTH queue"]);
    const items = screen.getAllByRole("listitem");
    const data = { effectAllowed: "" };
    fireEvent.dragStart(items[1]!, { dataTransfer: data });
    fireEvent.dragOver(items[2]!, { dataTransfer: data });
    fireEvent.drop(items[2]!, { dataTransfer: data });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([]);
  } finally {
    queues.pop();
  }
});
