// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DisplayComment } from "../../shared/contract";
import { CommentAuthor } from "./comment-author";

const { toThread, list } = vi.hoisted(() => ({ toThread: vi.fn(), list: vi.fn() }));
vi.mock("@get-bb/plugin-sdk/app", () => ({
  useBbNavigate: () => ({ toThread }),
  useSdk: () => ({ threads: { list } }),
  useSettings: () => ({ values: {}, isLoading: false }),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const comment = (overrides: Partial<DisplayComment>): DisplayComment => ({
  id: "01HZZZZZZZZZZZZZZZZZZZZZC1",
  taskId: "01HZZZZZZZZZZZZZZZZZZZZZT1",
  kind: "agent",
  authorName: "agent (thr_worker)",
  presetName: null,
  threadId: "thr_worker",
  threadTitle: "Fix the login bug",
  provider: null,
  body: "Done",
  notifiedCount: 0,
  createdAt: "2026-07-15T00:00:00.000Z",
  ...overrides,
});

it("shows a comment from a thread as a thread chip that opens it, keeping the known title while the lookup is pending", async () => {
  list.mockResolvedValue([{ id: "thr_worker", title: "Fix the login bug" }]);
  render(<CommentAuthor comment={comment({})} />);
  expect(screen.getByRole("button", { name: "Open thread Fix the login bug" })).toBeTruthy();
  screen.getByRole("button", { name: "Open thread Fix the login bug" }).click();
  expect(toThread).toHaveBeenCalledWith("thr_worker");
});

it("shows a thread comment whose title is unknown with the thread id, and a person's comment as plain text", () => {
  list.mockResolvedValue([]);
  render(<><CommentAuthor comment={comment({ threadTitle: null })} /><CommentAuthor comment={comment({ kind: "user", threadId: null, authorName: "You" })} /></>);
  expect(screen.getByRole("button", { name: "Open thread thr_worker" })).toBeTruthy();
  expect(screen.getByText("You")).toBeTruthy();
});
