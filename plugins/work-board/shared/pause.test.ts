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
