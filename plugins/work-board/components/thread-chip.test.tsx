// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ActorLabel, ThreadChip } from "./thread-chip";

const { toThread, list } = vi.hoisted(() => ({ toThread: vi.fn(), list: vi.fn() }));
const sdk = { threads: { list }, plugins: { list: vi.fn() } };
vi.mock("@get-bb/plugin-sdk/app", () => ({
  useBbNavigate: () => ({ toThread }),
  useSdk: () => sdk,
  useSettings: () => ({ values: {}, isLoading: false }),
}));
beforeEach(() => {
  list.mockImplementation(async ({ threadIds }: { threadIds: string[] }) => threadIds.filter((id) => id !== "thr_gone").map((id) => ({ id, title: id === "thr_untitled" ? null : `Title of ${id}`, titleFallback: id === "thr_untitled" ? null : null })));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("shows the thread title as an accessible button and opens the thread on click", async () => {
  render(<ThreadChip threadId="thr_example" />);
  const chip = await screen.findByRole("button", { name: "Open thread Title of thr_example" });
  expect(chip.textContent).toBe("Title of thr_example");
  expect(chip.className).toContain("rounded-full");
  expect(chip.className).toContain("max-w-");
  fireEvent.click(chip);
  expect(toThread).toHaveBeenCalledWith("thr_example");
});

it("labels the chip with the thread id while the title is unknown, for example for a deleted thread", async () => {
  render(<ThreadChip threadId="thr_gone" />);
  expect((await screen.findByRole("button", { name: "Open thread thr_gone" })).textContent).toBe("thr_gone");
  await waitFor(() => expect(list).toHaveBeenCalled());
  expect(screen.getByRole("button", { name: "Open thread thr_gone" })).toBeTruthy();
});

it("looks every chip on screen up in one batched call", async () => {
  render(<><ThreadChip threadId="thr_a" /><ThreadChip threadId="thr_b" /><ActorLabel name="agent (thr_c)" /></>);
  await screen.findByRole("button", { name: "Open thread Title of thr_c" });
  expect(list).toHaveBeenCalledTimes(1);
  expect(list.mock.calls[0]![0].threadIds.sort()).toEqual(["thr_a", "thr_b", "thr_c"]);
  expect(screen.getByRole("button", { name: "Open thread Title of thr_a" })).toBeTruthy();
});

it("shows an actor as a chip when it is a thread, from its id or from a trailing (thr_…), and as plain text otherwise", async () => {
  render(<p><ActorLabel name="agent (thr_one)" /> · <ActorLabel name="ignored" threadId="thr_two" /> · <ActorLabel name="thr_three" /> · <ActorLabel name="You" /></p>);
  expect((await screen.findByRole("button", { name: "Open thread Title of thr_one" })).textContent).toBe("Title of thr_one");
  expect(screen.getByRole("button", { name: "Open thread Title of thr_two" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open thread Title of thr_three" })).toBeTruthy();
  expect(screen.getByText(/You/)).toBeTruthy();
  expect(screen.queryByText(/agent/)).toBeNull();
});

it("uses the given fallback title before the thread id", async () => {
  render(<ThreadChip threadId="thr_gone" fallbackTitle="Fix the login bug" />);
  expect(await screen.findByRole("button", { name: "Open thread Fix the login bug" })).toBeTruthy();
});
