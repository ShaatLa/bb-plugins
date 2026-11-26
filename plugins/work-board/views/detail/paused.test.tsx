// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PausedBlock, questionAnchor } from "./paused";

vi.mock("@get-bb/plugin-sdk/app", async (actual) => ({ ...await actual<object>(), useBbNavigate: () => ({ openUrl: () => false }) }));
afterEach(cleanup);

it("shows each pause as linked, current reasons with the time left", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-01T10:00:00.000Z"));
  const scroll = vi.fn();
  const target = document.createElement("div");
  target.id = questionAnchor("q_example");
  Object.defineProperty(target, "scrollIntoView", { value: scroll });
  document.body.append(target);
  render(<PausedBlock pauses={[
    { signal: "held", reason: "waiting on EXA-2", until: null, targets: [{ kind: "task", taskKey: "EXA-3" }, { kind: "task", taskKey: "EXA-4" }] },
    { signal: "owner_question", reason: "waiting on owner question q_example", until: null, targets: [{ kind: "question", questionId: "q_example", label: "check 2" }] },
    { signal: "held", reason: "waiting on EXA-9", until: null, targets: [] },
    { signal: "manual", reason: "Reply from [the docs](https://example.com/docs)", until: "2026-11-01T10:45:00.000Z" },
  ]} />);
  const block = screen.getByRole("region", { name: "Paused" });
  expect(block.textContent).not.toContain("Paused:");
  expect(screen.getByRole("link", { name: "EXA-3" }).getAttribute("href")).toBe("/plugins/work-board/work-board/task/EXA-3");
  expect(screen.getByRole("link", { name: "EXA-4" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: "EXA-2" })).toBeNull();
  expect(screen.queryByRole("link", { name: "EXA-9" })).toBeNull();
  expect(block.textContent).toContain("waiting on EXA-9 (resolved — the pause ends on the next check)");
  expect(screen.getByRole("link", { name: "the docs" }).getAttribute("href")).toBe("https://example.com/docs");
  expect(block.textContent).toContain("until in 45m");
  fireEvent.click(screen.getByRole("link", { name: "check 2" }));
  expect(scroll).toHaveBeenCalled();
  target.remove();
  vi.useRealTimers();
});

it("renders nothing without pauses", () => {
  const { container } = render(<PausedBlock pauses={[]} />);
  expect(container.firstChild).toBeNull();
});
