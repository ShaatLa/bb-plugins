import { expect, it } from "vitest";
import { pauseReasonText } from "./pause";

it("reads a Markdown link in a manual reason as its label, and leaves other text alone", () => {
  const manual = (reason: string) => pauseReasonText({ signal: "manual", reason, until: null });
  expect(manual("Waiting for the look check on [EXA-1](/plugins/work-board/work-board/task/EXA-1)")).toBe("Waiting for the look check on EXA-1");
  expect(manual("Waiting on a [design](https://example.com/a) and [EXA-2](/x)")).toBe("Waiting on a design and EXA-2");
  expect(manual("Waiting on [brackets] and (parens)")).toBe("Waiting on [brackets] and (parens)");
});
