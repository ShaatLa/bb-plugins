// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { TaskActivityIndicator } from "./task-activity";
import type { TaskActivity } from "../shared/task-activity.js";
afterEach(cleanup);
const base: TaskActivity = { state: "working", workingCount: 2, attachedCount: 5, sessions: [
  { threadId: "one", title: "Parent", role: "parent", state: "attached" },
  { threadId: "two", title: "Worker", role: "worker", state: "working" },
], terminalWarning: true, hasFailure: true };
it("shows counts, sessions, failure and terminal warning", () => {
  const { container } = render(<TaskActivityIndicator activity={base} />);
  const badge = screen.getByText("Working · 2/5");
  expect(badge.getAttribute("aria-label")).toContain("Parent (Parent thread): Assigned");
  expect(badge.getAttribute("aria-label")).toContain("Worker (Worker): Working");
  expect(badge.getAttribute("aria-label")).toContain("Linked thread failed");
  expect(badge.getAttribute("aria-label")).toContain("work continues");
  expect(container.querySelector("svg.animate-spin.motion-reduce\\:animate-none")).not.toBeNull();
  expect(container.querySelectorAll("svg")).toHaveLength(3);
});
it.each([["attached", "Assigned"], ["abandoned", "Abandoned"], ["error", "Error"], ["waiting-owner", "Waiting for owner"], ["queued", "Queued"]] as const)("renders static %s", (state, label) => {
  const { container } = render(<TaskActivityIndicator activity={{ ...base, state, terminalWarning: false, hasFailure: false }} />);
  expect(screen.getByText(label)).toBeTruthy();
  expect(container.querySelector(".animate-spin, .animate-pulse")).toBeNull();
});
it("omits absent and never-worked activity", () => {
  const { container, rerender } = render(<TaskActivityIndicator />);
  expect(container.textContent).toBe("");
  rerender(<TaskActivityIndicator activity={{ ...base, state: null }} />);
  expect(container.textContent).toBe("");
});

it("does not duplicate an existing failure marker", () => {
  const { container } = render(<TaskActivityIndicator activity={base} failureMarker />);
  expect(container.querySelectorAll(".text-destructive")).toHaveLength(0);
  expect(screen.getByText("Working · 2/5").getAttribute("aria-label")).toContain("Linked thread failed");
});

it("renders distinct SVG artwork for activity states without host icon fallbacks", () => {
  const { container, rerender } = render(<TaskActivityIndicator />);
  const artwork = new Set<string>();
  for (const state of ["working", "abandoned", "error", "waiting-owner", "queued"] as const) {
    rerender(<TaskActivityIndicator activity={{ ...base, state, terminalWarning: false, hasFailure: false }} />);
    const glyph = container.querySelector("svg");
    expect(glyph).not.toBeNull();
    expect(glyph!.querySelector("path, circle")).not.toBeNull();
    artwork.add(glyph!.innerHTML);
  }
  expect(artwork.size).toBe(5);
});
it("a paused indicator keeps the reason once: from its pause lines when given, from the explanation otherwise", () => {
  const paused: TaskActivity = { state: "paused", workingCount: 0, attachedCount: 0, sessions: [], terminalWarning: false, hasFailure: false,
    diagnostics: { explanation: "The card is paused: Waiting on EXA-2.", hasWorked: false, complete: true, checkedAt: "2026-01-01T00:00:00.000Z", inactiveSessions: [] } };
  const { unmount } = render(<TaskActivityIndicator activity={paused} />);
  expect(screen.getByText("Paused").getAttribute("aria-label")).toContain("Waiting on EXA-2");
  unmount();
  render(<TaskActivityIndicator activity={paused} pauses={[{ signal: "held", reason: "waiting on EXA-9", until: null, targets: [{ kind: "task", taskKey: "EXA-2" }] }]} />);
  const label = screen.getByText("Paused").getAttribute("aria-label")!;
  expect(label.match(/EXA-2/g)).toHaveLength(1);
});

it("can omit session details while retaining the explanation", () => {
  render(<TaskActivityIndicator activity={base} sessionLines={false} />);
  const label = screen.getByText("Working · 2/5").getAttribute("aria-label")!;
  expect(label).not.toContain("Parent (Parent thread)");
  expect(label).toContain("Linked thread failed");
});

it("keeps per-session lines in the default tooltip", async () => {
  render(<TaskActivityIndicator activity={base} />);
  fireEvent.pointerMove(screen.getByText("Working · 2/5"), { pointerType: "mouse" });
  const tooltip = await screen.findByRole("tooltip");
  expect(tooltip.textContent).toContain("Parent (Parent thread): Assigned");
  expect(tooltip.textContent).toContain("Worker (Worker): Working");
});
it("shows time left in the indicator and fallback chip", async () => {
  const { PausedChip } = await import("./task-activity");
  const pauses = [{ signal: "manual", reason: "Waiting", until: new Date(Date.now() + 4 * 3600000 + 1000).toISOString() }];
  const { unmount } = render(<TaskActivityIndicator activity={{ ...base, state: "paused" }} pauses={pauses} />);
  expect(screen.getByText("Paused · 4 h left")).toBeTruthy();
  unmount();
  render(<PausedChip activity={base} pauses={pauses} />);
  expect(screen.getByText("Paused · 4 h left")).toBeTruthy();
});
