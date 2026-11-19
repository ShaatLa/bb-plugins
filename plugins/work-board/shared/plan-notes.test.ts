import { describe, expect, it } from "vitest";
import { buildAnchor } from "./plan-anchor";
import { buildApprovalMessage, buildFeedbackBody, buildFeedbackMessage, orderNotes, parseNoteNumber, type NoteLike } from "./plan-notes";

const PLAN = ["# Release", "", "## Steps", "", "Add the new table.", "Roll it out slowly.", "", "### Rollback", "", "Drop the table.", "", "## Risks", "", "Nothing known."].join("\n");

const note = (number: number, patch: Partial<NoteLike> = {}): NoteLike => ({
  number,
  kind: "comment",
  exact: null,
  prefix: "",
  suffix: "",
  headingPath: null,
  madeOnVersion: 1,
  body: "",
  state: "sent",
  ...patch,
});
const quote = (text: string, quoted: string) => {
  const start = text.indexOf(quoted);
  return buildAnchor(text, start, start + quoted.length)!;
};
const placed = (number: number, quoted: string, patch: Partial<NoteLike> = {}) => note(number, { ...quote(PLAN, quoted), ...patch });

describe("orderNotes", () => {
  it("puts placed notes in plan order, then unanchored ones, then general ones", () => {
    const notes = [
      note(1, { kind: "general", body: "Add a rollback step." }),
      placed(2, "Nothing known.", { body: "Say how we know." }),
      note(3, { exact: "Text that is gone", body: "Gone." }),
      placed(4, "Add the new table.", { body: "Behind a flag." }),
      note(5, { kind: "general", body: "Second general." }),
      placed(6, "Drop the table.", { kind: "remove" }),
    ];
    expect(orderNotes(notes, PLAN).map(({ note, placement }) => `${note.number}:${placement}`)).toEqual([
      "4:anchored",
      "6:anchored",
      "2:anchored",
      "3:unanchored",
      "1:general",
      "5:general",
    ]);
  });
});

describe("feedback message", () => {
  const notes = [
    { note: placed(1, "Add the new table.", { headingPath: "Steps", body: "Use the existing flag service, not a new env var.", exact: "Add the new table behind a flag." }), placement: "anchored" as const },
    { note: placed(2, "Drop the table.", { kind: "remove", headingPath: "Steps > Rollback", body: "Keep the table for a week before dropping it.", exact: "Drop the table." }), placement: "anchored" as const },
    { note: note(3, { kind: "general", body: "Add a rollback step for each migration." }), placement: "general" as const },
  ];

  it("is exactly the approved text", () => {
    expect(buildFeedbackMessage({ taskKey: "EXA-1", version: 1, notes })).toBe(
      [
        "EXA-1 · plan v1: changes requested by the owner",
        "",
        "YOUR PLAN WAS NOT APPROVED. Revise it to address every note below, then submit it again.",
        "",
        "Rules:",
        "- Edit the plan, never comments. Re-read it first: bb work-board plan show EXA-1",
        '  Then: bb work-board plan edit EXA-1 --section "<heading>" --file part.md --base-version 1 --summary "…"',
        "  (or --find-file / --replace-file for a single passage)",
        '- Answer every note: bb work-board plan reply EXA-1 N1 --body "what changed, or why not" --addressed',
        "- Do not resubmit the plan unchanged. When every note is answered: bb work-board plan submit EXA-1",
        "- Plan: [EXA-1 plan](/plugins/work-board/work-board/task/EXA-1/plan)",
        "",
        "Owner's notes on v1 (3), in plan order:",
        "",
        'N1 · Comment · section "Steps"',
        "> Add the new table behind a flag.",
        "Use the existing flag service, not a new env var.",
        "",
        'N2 · Remove · section "Steps > Rollback"',
        "> Drop the table.",
        "Keep the table for a week before dropping it.",
        "",
        "N3 · General",
        "Add a rollback step for each migration.",
      ].join("\n"),
    );
  });

  it("cuts a long quote to 200 characters, joins its lines and omits a missing section", () => {
    const long = `${"word ".repeat(60)}\nend`;
    const text = buildFeedbackBody({ taskKey: "EXA-1", version: 2, notes: [{ note: note(1, { exact: long, body: "Shorter." }), placement: "anchored" }] });
    const line = text.split("\n").find((entry) => entry.startsWith("> "))!;
    expect(line).toBe(`> ${"word ".repeat(40)}…`);
    expect(line.length).toBe(2 + 200 + 1);
    expect(text).toContain("\nN1 · Comment\n> ");
    expect(text.split("in plan order:")[1]).not.toContain("section");
  });

  it("marks a note whose quote is gone and keeps its original quote", () => {
    const text = buildFeedbackBody({ taskKey: "EXA-1", version: 3, notes: [{ note: note(4, { exact: "Old sentence.", headingPath: "Steps", madeOnVersion: 2, body: "Fix it." }), placement: "unanchored" }] });
    expect(text).toContain('N4 · Comment · section "Steps" · unanchored (made on v2)\n> Old sentence.\nFix it.');
    expect(text).toContain("--base-version 3");
  });

  it("lists a remove note without a reason by its quote alone, and details state and reply on demand", () => {
    const body = buildFeedbackBody({ taskKey: "EXA-1", version: 1, detail: true, notes: [{ note: note(2, { kind: "remove", exact: "Drop it.", state: "addressed", addressedInVersion: 2, reply: "Removed.", replyBy: "agent" }), placement: "anchored" }] });
    expect(body).toContain("N2 · Remove · addressed in v2\n> Drop it.\nReply from agent: Removed.");
  });
});

describe("approval message", () => {
  it("is exactly the approved text, with the note line only when a note was given", () => {
    const base = [
      "EXA-1 · plan v1 approved by the owner",
      "",
      "Start the work as planned. The approved plan is v1: any new version returns it to draft and needs a new review.",
      "Plan: [EXA-1 plan](/plugins/work-board/work-board/task/EXA-1/plan)",
    ];
    expect(buildApprovalMessage({ taskKey: "EXA-1", version: 1 })).toBe(base.join("\n"));
    expect(buildApprovalMessage({ taskKey: "EXA-1", version: 1, note: "  " })).toBe(base.join("\n"));
    expect(buildApprovalMessage({ taskKey: "EXA-1", version: 1, note: "Go ahead." })).toBe([...base, "", "Owner's note: Go ahead."].join("\n"));
  });
});

describe("parseNoteNumber", () => {
  it("accepts N3, n3 and 3 only", () => {
    expect([parseNoteNumber("N3"), parseNoteNumber("n12"), parseNoteNumber(" 7 "), parseNoteNumber("N0"), parseNoteNumber("x3"), parseNoteNumber("")]).toEqual([3, 12, 7, null, null, null]);
  });
});
