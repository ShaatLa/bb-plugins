// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
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
  expect(badge.getAttribute("aria-label")).toContain("Parent (Parent thread): Attached");
  expect(badge.getAttribute("aria-label")).toContain("Worker (Worker): Working");
  expect(badge.getAttribute("aria-label")).toContain("Ошибка связанного треда");
  expect(badge.getAttribute("aria-label")).toContain("работа продолжается");
  expect(container.querySelector(".animate-spin.motion-reduce\\:animate-none")).not.toBeNull();
});
it.each([["attached", "Attached"], ["abandoned", "Брошена"], ["error", "Ошибка"], ["waiting-owner", "Ждёт владельца"], ["queued", "В очереди"]] as const)("renders static %s", (state, label) => {
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
  expect(screen.getByText("Working · 2/5").getAttribute("aria-label")).toContain("Ошибка связанного треда");
});
