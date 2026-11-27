import { expect, it } from "vitest";
import { pauseReasonText, shownPauses } from "./pause";

it("reads a Markdown link in a manual reason as its label, and leaves other text alone", () => {
  const manual = (reason: string) => pauseReasonText({ signal: "manual", reason, until: null });
  expect(manual("Waiting for the look check on [EXA-1](/plugins/work-board/work-board/task/EXA-1)")).toBe("Waiting for the look check on EXA-1");
  expect(manual("Waiting on a [design](https://example.com/a) and [EXA-2](/x)")).toBe("Waiting on a design and EXA-2");
  expect(manual("Waiting on [brackets] and (parens)")).toBe("Waiting on [brackets] and (parens)");
});

it("shows no pause on a blocked card and never a wait on a predecessor", () => {
  const manual = { signal: "manual", reason: "Waiting on the owner", until: null };
  const held = { signal: "held", reason: "waiting on EXA-2", until: null, targets: [{ kind: "task" as const, taskKey: "EXA-2" }] };
  expect(shownPauses([manual, held], [])).toEqual([manual]);
  expect(shownPauses([manual, held], [{ key: "EXA-2" }])).toEqual([]);
  expect(shownPauses(undefined, undefined)).toEqual([]);
});

it("formats remaining time and hides resolved target ids", async () => {
  const { formatLeft, pauseHeading } = await import("./pause");
  const now = Date.parse("2026-01-01T00:00:00Z");
  expect(formatLeft("2026-01-01T00:35:00Z", now)).toBe("35 min left");
  expect(formatLeft("2026-01-01T04:00:00Z", now)).toBe("4 h left");
  expect(formatLeft("2026-01-01T00:00:30Z", now)).toBe("less than a minute left");
  expect(formatLeft("2025-12-31T23:59:00Z", now)).toBe("less than a minute left");
  expect(pauseReasonText({ signal: "owner_question", reason: "waiting on owner question q_example", until: null, targets: [] })).toBe("Answered — the pause ends within a minute.");
  expect(pauseReasonText({ signal: "held", reason: "waiting on EXA-2", until: null, targets: [] })).toBe("Predecessor done — the pause ends within a minute.");
  expect(pauseHeading([{ signal: "manual", reason: "x", until: "2026-01-01T04:00:00Z" }], now)).toBe("Paused · 4 h left");
});
