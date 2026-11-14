// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TaskAdvisories } from "./task-advisories";
import type { TaskAdvisory } from "../shared/task-advisories";
const { go, toThread, openUrl } = vi.hoisted(() => ({ go: vi.fn(), toThread: vi.fn(), openUrl: vi.fn() }));
vi.mock("../shell/routes", () => ({ useTasksNavigation: () => ({ go }) }));
vi.mock("@get-bb/plugin-sdk/app", async importOriginal => ({ ...await importOriginal<typeof import("@get-bb/plugin-sdk/app")>(), useBbNavigate: () => ({ toThread, openUrl: (url: string) => { openUrl(url); return true; } }) }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });
function items(): TaskAdvisory[] {
  const checkedAt = new Date().toISOString(), validUntil = new Date(Date.now() + 60_000).toISOString();
  return [{ kind: "merged-predecessor", checkedAt, validUntil, predecessor: { id: "p", key: "ADV-1", title: "Predecessor", status: "in_review" }, pr: { url: "https://github.com/org/repo/pull/1", repository: "org/repo", number: 1, mergeSha: "b".repeat(40), mergedAt: checkedAt } }, { kind: "no-live-session", checkedAt, validUntil, lastActivityAt: checkedAt, lastAttachment: { threadId: "thr_old", title: "Previous worker", attachedAt: checkedAt, updatedAt: checkedAt } }];
}
it("shows actionable evidence and opens the predecessor, PR and last session", () => {
  render(<TaskAdvisories items={items()} />);
  fireEvent.click(screen.getByText("Needs attention · 2"));
  expect(screen.getByText(/Merge bbbb/).textContent).toContain("b".repeat(40));
  expect(screen.getByRole("link", { name: "org/repo#1" }).getAttribute("href")).toBe("https://github.com/org/repo/pull/1");
  fireEvent.click(screen.getByRole("link", { name: "org/repo#1" }));
  expect(openUrl).toHaveBeenCalledWith("https://github.com/org/repo/pull/1");
  fireEvent.click(screen.getByRole("button", { name: /ADV-1 · Predecessor/ }));
  expect(go).toHaveBeenCalledWith({ kind: "task", taskKey: "ADV-1" });
  fireEvent.click(screen.getByRole("button", { name: /Last attachment: Previous worker/ }));
  expect(toThread).toHaveBeenCalledWith("thr_old");
  expect(screen.getAllByText(/Checked .*valid until/)).toHaveLength(2);
});
it("expires advice without making a network request or retaining a stale warning", () => {
  vi.useFakeTimers();
  const { container } = render(<TaskAdvisories items={items()} compact />);
  expect(screen.getByText("Needs attention · 2").getAttribute("title")).toContain("Check acceptance criteria");
  act(() => { vi.advanceTimersByTime(60_001); });
  expect(container.textContent).toBe("");
  expect(vi.getTimerCount()).toBe(0);
});
it("does not show expired snapshots on mount", () => {
  const { container } = render(<TaskAdvisories items={items().map(item => ({ ...item, validUntil: new Date(Date.now() - 1).toISOString() }))} />);
  expect(container.textContent).toBe("");
});
