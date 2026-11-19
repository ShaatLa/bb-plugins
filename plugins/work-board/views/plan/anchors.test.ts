// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { parseHeadings } from "../../shared/plan";
import { resolveAnchor } from "../../shared/plan-anchor";
import { anchorOfRange, headingPathAt, rangeOfSpan, textOf, textOffsetOf } from "./anchors";

function render(html: string) {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  return root;
}
const HTML = "<h1>Plan</h1><p>Intro text.</p><h2>Steps</h2><ul><li>first <b>bold</b> step</li><li>second step</li></ul><h3>Rollback</h3><p>Drop the table.</p>";
const headings = parseHeadings("# Plan\n\nIntro text.\n\n## Steps\n\n- first\n\n### Rollback\n\nDrop the table.\n");
const elementsOf = (root: Element) => [...root.querySelectorAll("h1,h2,h3")];

describe("DOM anchoring", () => {
  it("measures offsets in the plain text, for text points and for points between elements", () => {
    const root = render(HTML);
    expect(textOf(root)).toBe("PlanIntro text.Stepsfirst bold stepsecond stepRollbackDrop the table.");
    const intro = root.querySelector("p")!.firstChild!;
    expect(textOffsetOf(root, intro, 6)).toBe(10);
    expect(textOffsetOf(root, root, 1)).toBe(4);
    expect(textOffsetOf(root, root, root.childNodes.length)).toBe(textOf(root).length);
    expect(textOffsetOf(root, document.body, 0)).toBeNull();
  });

  it("builds an anchor from a selection across inline elements, with the nearest heading path", () => {
    const root = render(HTML);
    const li = root.querySelectorAll("li")[0]!;
    const range = document.createRange();
    range.setStart(li.firstChild!, 2);
    range.setEnd(li.lastChild!, 3);
    const found = anchorOfRange(root, range, elementsOf(root), headings)!;
    expect(found.anchor.exact).toBe("rst bold st");
    expect(found.anchor.prefix).toBe("PlanIntro text.Stepsfi");
    expect(found.anchor.suffix).toBe("epsecond stepRollbackDrop the ta");
    expect(found.headingPath).toBe("Plan > Steps");
    const drop = root.querySelector("h3 ~ p")!.firstChild!;
    const second = document.createRange();
    second.setStart(drop, 0);
    second.setEnd(drop, 4);
    expect(anchorOfRange(root, second, elementsOf(root), headings)!.headingPath).toBe("Plan > Steps > Rollback");
    const outside = document.createRange();
    outside.selectNodeContents(document.body);
    expect(anchorOfRange(root, outside, elementsOf(root), headings)).toBeNull();
    expect(anchorOfRange(root, document.createRange(), elementsOf(root), headings)).toBeNull();
  });

  it("takes a selection inside a heading as that heading's path and has none before the first heading", () => {
    const root = render("<p>Preface.</p><h2>Alpha</h2><p>Text.</p>");
    const parsed = parseHeadings("Preface.\n\n## Alpha\n\nText.\n");
    expect(headingPathAt(elementsOf(root), parsed, root.querySelector("h2")!.firstChild!)).toBe("Alpha");
    expect(headingPathAt(elementsOf(root), parsed, root.querySelector("p")!.firstChild!)).toBeNull();
    expect(headingPathAt([null], parsed, root.querySelector("p")!)).toBeNull();
  });

  it("turns a resolved span back into a DOM range", () => {
    const root = render(HTML);
    const text = textOf(root);
    const span = resolveAnchor(text, { exact: "first bold step", prefix: "", suffix: "" })!;
    expect(rangeOfSpan(root, span)!.toString()).toBe("first bold step");
    expect(rangeOfSpan(root, { start: 0, end: 4 })!.toString()).toBe("Plan");
    expect(rangeOfSpan(root, { start: 5, end: 9999 })).toBeNull();
  });
});
