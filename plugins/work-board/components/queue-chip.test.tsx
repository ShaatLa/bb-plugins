// @vitest-environment jsdom
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QueueChip } from "./queue-chip";

vi.mock("@get-bb/plugin-sdk/app", () => ({ useSdk: () => ({ threads: { get: async ({ threadId }: { threadId: string }) => ({ title: `Name ${threadId}` }) } }) }));
afterEach(cleanup);
it("uses the new executor name when the queue changes", async () => {
  const cached = render(<QueueChip queue={{ threadId: "thr_b", position: 1 }} />);
  await waitFor(() => expect(screen.getByText(/Name thr_b/)).toBeTruthy());
  cached.unmount();
  const { rerender } = render(<QueueChip queue={{ threadId: "thr_a", position: 1 }} />);
  await waitFor(() => expect(screen.getByText(/Name thr_a/)).toBeTruthy());
  rerender(<QueueChip queue={{ threadId: "thr_b", position: 1 }} />);
  expect(screen.queryByText(/Name thr_a/)).toBeNull();
  expect(screen.getByText(/Name thr_b/)).toBeTruthy();
});
