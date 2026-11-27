// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PausedBlock, pauseDetailsFor, questionAnchor } from "./paused";

vi.mock("@get-bb/plugin-sdk/app", async (actual) => ({ ...await actual<object>(), useBbNavigate: () => ({ openUrl: () => false }) }));
afterEach(() => { cleanup(); vi.useRealTimers(); });
const until = "2026-11-01T14:00:00.000Z";
const pause = { signal: "manual", reason: "Waiting", until };
const row = { ...pause, source: "manual", threadId: "thr_example", startedAt: "2026-11-01T06:00:00.000Z" };
function time() { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-01T10:00:00.000Z")); }
it("shows the latest time, matched actor and elapsed bar", () => {
  time();
  const { container, rerender } = render(<PausedBlock pauses={[pause]} />);
  expect(screen.getByText("Paused · 4 h left")).toBeTruthy();
  expect(container.textContent).not.toContain("paused by");
  rerender(<PausedBlock pauses={[pause]} details={[row]} names={new Map([["thr_example", "Example thread"]])} />);
  expect(container.textContent).toContain("paused by Example thread");
  // The end time sits in the header, not in the "paused by" line, which is its own line under the reason.
  const header = container.querySelector('section[aria-label="Paused"] > div')!;
  expect(header.textContent).toMatch(/Paused · 4 h left\s*until \d{1,2}:\d{2}/);
  const meta = [...container.querySelectorAll("li > div")].find(el => el.textContent?.startsWith("paused by"));
  expect(meta?.textContent).not.toMatch(/until/i);
  expect(meta?.previousElementSibling?.textContent).toBe("Waiting");
  expect(container.querySelector('[style*="width: 50%"]')).toBeTruthy();
  rerender(<PausedBlock pauses={[pause, { ...pause, until: "2026-11-01T15:00:00.000Z" }]} details={[row, row]} />);
  expect(screen.getByText("Paused · 5 h left")).toBeTruthy();
  expect(container.textContent).not.toContain("paused by");
  rerender(<PausedBlock pauses={[pause, { signal: "owner_question", reason: "waiting", until: null, targets: [] }]} />);
  expect(screen.getByText("Paused")).toBeTruthy();
});
it("resumes and extends, disclosing automatic pauses in the Extend menu", async () => {
  time();
  const resume = vi.fn().mockResolvedValue(undefined), extend = vi.fn().mockResolvedValue(undefined);
  render(<PausedBlock pauses={[pause, { signal: "background", reason: "Running", until }, { signal: "owner_question", reason: "waiting", until: null, targets: [] }]} resume={resume} extend={extend} />);
  fireEvent.keyDown(screen.getByText("Extend ▾"), { key: "ArrowDown" });
  expect(screen.getByText("Also ends the automatic pause.")).toBeTruthy();
  // The menu floats over the card (a portal), so the block keeps its height.
  expect(screen.getByRole("menu").closest('section[aria-label="Paused"]')).toBeNull();
  fireEvent.click(screen.getByRole("menuitem", { name: "+1 h" }));
  expect(extend).toHaveBeenCalledWith("Waiting", 5 * 3600000);
  await vi.waitFor(() => expect(screen.getByText("Resume now")).not.toHaveProperty("disabled", true));
  fireEvent.click(screen.getByText("Resume now"));
  expect(resume).toHaveBeenCalled();
});
it("links open questions and expands their group", () => {
  const scroll = vi.fn();
  const details = document.createElement("details"), target = document.createElement("div");
  target.id = questionAnchor("q_example"); Object.defineProperty(target, "scrollIntoView", { value: scroll });
  details.append(target); document.body.append(details);
  render(<PausedBlock pauses={[{ signal: "owner_question", reason: "waiting", until: null, targets: [{ kind: "question", questionId: "q_example", label: "check 2" }] }]} />);
  fireEvent.click(screen.getByText("check 2"));
  expect(details.open).toBe(true); expect(scroll).toHaveBeenCalled(); details.remove();
});
it("does not show actions for a held pause", () => {
  render(<PausedBlock pauses={[{ signal: "held", reason: "waiting", until: null, targets: [] }]} />);
  expect(screen.getByText("Predecessor done — the pause ends within a minute.")).toBeTruthy();
  expect(screen.queryByText("Resume now")).toBeNull();
});
it("matches same-reason pauses by deadline and identifies owner and automatic actors", () => {
  time();
  const later = "2026-11-01T15:00:00.000Z";
  const first = { signal: "background", reason: "Running", until }, second = { ...first, until: later };
  const { container, rerender } = render(<PausedBlock pauses={[first, second]} details={[{ ...row, ...first, source: "auto" }, { ...row, ...second, source: "manual", threadId: "thr_other" }]} names={new Map([["thr_other", "Other"]])} />);
  expect(container.textContent).toContain("paused automatically");
  expect(container.textContent).toContain("paused by Other");
  rerender(<PausedBlock pauses={[pause]} details={[{ ...row, threadId: "owner" }]} />);
  expect(container.textContent).toContain("paused by the owner");
  // Only the relevant facts: no explanation of what ends the pause (owner's remark).
  expect(container.textContent).not.toMatch(/Ends (at|earlier|when)|stale-status notices|Resume ends/);
});
it("disables extension at the eight hour limit", () => {
  time();
  render(<PausedBlock pauses={[{ ...pause, until: "2026-11-01T18:00:00.000Z" }]} />);
  fireEvent.keyDown(screen.getByText("Extend ▾"), { key: "ArrowDown" });
  expect(screen.getByRole("menuitem", { name: "+1 h" }).getAttribute("aria-disabled")).toBe("true");
  expect(screen.getByRole("menuitem", { name: "8 h from now" }).getAttribute("aria-disabled")).toBe("true");
});
it("hides the resolved question id and uses its link when found", () => {
  const reason = "waiting on owner question q_example";
  const questions = [{ id: "q_example", kind: "decision", prompt: "Ready?" }] as import("../../shared/contract").TaskQuestion[];
  const { container, rerender } = render(<PausedBlock pauses={[{ signal: "owner_question", reason, until: null, targets: [] }]} questions={questions} />);
  expect(screen.getByText("decision «Ready?»")).toBeTruthy();
  expect(container.textContent).not.toContain("q_example");
  rerender(<PausedBlock pauses={[{ signal: "owner_question", reason, until: null, targets: [] }]} />);
  expect(container.querySelector("a")).toBeNull();
  expect(container.textContent).not.toContain("q_example");
});
it("reports action failures", async () => {
  const onError = vi.fn();
  render(<PausedBlock pauses={[pause]} resume={async () => { throw new Error("Could not resume"); }} onError={onError} />);
  fireEvent.click(screen.getByText("Resume now"));
  await vi.waitFor(() => expect(onError).toHaveBeenCalledWith("Could not resume"));
});

it("caps an extension at eight hours from now", async () => {
  time();
  const extend = vi.fn().mockResolvedValue(undefined);
  render(<PausedBlock pauses={[{ ...pause, until: "2026-11-01T16:00:00.000Z" }]} extend={extend} resume={vi.fn()} />);
  fireEvent.keyDown(screen.getByText("Extend ▾"), { key: "ArrowDown" });
  fireEvent.click(screen.getByRole("menuitem", { name: "+4 h" }));
  // Six hours are left: +4 h would be ten, so the call asks for the eight-hour maximum.
  expect(extend).toHaveBeenCalledWith("Waiting", 8 * 3600000);
});

it("uses pause details only for the card they were read for", () => {
  const data = { taskId: "task_a", rows: [row] };
  expect(pauseDetailsFor({ isFetching: false, error: null, data }, "task_a")).toEqual([row]);
  // A late answer for the previous card must not be shown on the new one.
  expect(pauseDetailsFor({ isFetching: false, error: null, data }, "task_b")).toBeUndefined();
  expect(pauseDetailsFor({ isFetching: true, error: null, data }, "task_a")).toBeUndefined();
  expect(pauseDetailsFor({ isFetching: false, error: "failed", data }, "task_a")).toBeUndefined();
});
