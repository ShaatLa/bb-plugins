import { describe, expect, it } from "vitest";
import { ANCHOR_CONTEXT, buildAnchor, fold, markdownPlainText, resolveAnchor } from "./plan-anchor";

const TEXT = "Steps Add the table. Roll out slowly. Rollback Drop the table. Keep the backup. Risks Nothing known.";
const at = (text: string, quote: string, from = 0) => text.indexOf(quote, from);
const anchorOf = (text: string, quote: string, from = 0) => {
  const start = at(text, quote, from);
  return buildAnchor(text, start, start + quote.length)!;
};
const slice = (text: string, span: { start: number; end: number } | null) => (span ? text.slice(span.start, span.end) : null);

describe("buildAnchor", () => {
  it("keeps the quote and up to 32 characters of context on each side", () => {
    const anchor = anchorOf(TEXT, "Keep the backup.");
    expect(anchor.exact).toBe("Keep the backup.");
    expect(anchor.prefix).toBe(TEXT.slice(at(TEXT, "Keep the backup.") - ANCHOR_CONTEXT, at(TEXT, "Keep the backup.")));
    expect(anchor.prefix).toHaveLength(32);
    expect(anchor.suffix).toBe(" Risks Nothing known.");
  });

  it("shortens the context at the edges, trims the selection and refuses a blank one", () => {
    expect(buildAnchor(TEXT, 0, 5)).toMatchObject({ exact: "Steps", prefix: "" });
    expect(buildAnchor("a  quoted  b", 1, 11)).toMatchObject({ exact: "quoted", prefix: "a  " });
    expect(buildAnchor("a    b", 1, 5)).toBeNull();
  });
});

describe("resolveAnchor", () => {
  it("finds a unique quote", () => {
    expect(slice(TEXT, resolveAnchor(TEXT, anchorOf(TEXT, "Roll out slowly.")))).toBe("Roll out slowly.");
  });

  it("tells repeated quotes apart by their context", () => {
    const text = "Alpha Drop the table. Beta Gamma Drop the table. Delta";
    const second = anchorOf(text, "Drop the table.", 10);
    const first = anchorOf(text, "Drop the table.");
    expect(resolveAnchor(text, second)).toEqual({ start: at(text, "Drop the table.", 10), end: at(text, "Drop the table.", 10) + 15 });
    expect(resolveAnchor(text, first)!.start).toBe(at(text, "Drop the table."));
  });

  it("prefers the longest shared context when the surroundings changed", () => {
    const before = "One intro. Same words. Two outro. Other intro. Same words. Final outro.";
    const anchor = anchorOf(before, "Same words.", 20);
    const after = "One intro. Same words. Two outro. Other intro, rewritten. Same words. Final outro.";
    expect(resolveAnchor(after, anchor)!.start).toBe(at(after, "Same words.", 30));
  });

  it("leaves an ambiguous anchor unplaced instead of guessing", () => {
    const anchor = { exact: "Same words.", prefix: "zzzz", suffix: "qqqq" };
    expect(resolveAnchor("Same words. Alpha. Same words.", anchor)).toBeNull();
  });

  it("is unanchored when the quote is gone, and follows it when the plan moved on", () => {
    const anchor = anchorOf(TEXT, "Drop the table.");
    expect(resolveAnchor("Steps Add the table. Rollback Keep it all. Risks Nothing known.", anchor)).toBeNull();
    const moved = `New intro paragraph. ${TEXT}`;
    expect(slice(moved, resolveAnchor(moved, anchor))).toBe("Drop the table.");
    expect(resolveAnchor(TEXT, { exact: "", prefix: "", suffix: "" })).toBeNull();
  });

  it("ignores whitespace, punctuation and markup between the rendered and the source text", () => {
    const rendered = "StepsAdd the table.Roll out slowly.";
    const anchor = anchorOf(rendered, "table.Roll out");
    const source = "Steps\n\nAdd the table.\n\nRoll out slowly.";
    expect(slice(source, resolveAnchor(source, anchor))).toBe("table.\n\nRoll out");
  });

  it("returns offsets in the original text for folded text with accents and emoji", () => {
    const text = "Héllo 🙂 wörld — plan";
    const span = resolveAnchor(text, { exact: "wörld", prefix: "", suffix: "" })!;
    expect(text.slice(span.start, span.end)).toBe("wörld");
    expect(fold("a-b 1").folded).toBe("ab1");
  });
});

describe("markdownPlainText", () => {
  it("drops syntax that renders to no text", () => {
    const text = markdownPlainText(
      ["## Steps", "", "1. First **step**", "- [x] done [link](https://example.test/a) ![alt](img.png)", "> quoted", "", "```sh", "echo hi", "```", "| a | b |", "|---|---|", "| 1 | 2 |"].join("\n"),
    );
    expect(fold(text).folded).toBe("StepsFirststepdonelinkquotedechohiab12");
    expect(text).not.toContain("https://example.test");
    expect(text).not.toContain("```");
  });
});
