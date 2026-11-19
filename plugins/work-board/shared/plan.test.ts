import { describe, expect, it } from "vitest";
import { diffPlanBodies } from "./plan-diff";
import { assertPlanText, countOccurrences, findSection, getSection, parseHeadings, PlanEditError, replaceFragment, replaceSection } from "./plan";

const PLAN = [
  "# Plan",
  "Intro line.",
  "",
  "## Steps 1–4",
  "- first",
  "- second",
  "",
  "### Details",
  "Nested text.",
  "",
  "## Steps 5–8",
  "- third",
  "",
  "## Risks",
  "None.",
  "",
].join("\n");

describe("parseHeadings", () => {
  it("builds heading paths from nesting and ignores headings inside fenced code", () => {
    const body = ["# A", "```sh", "# not a heading", "```", "## B", "~~~", "## also not", "~~~", "### C #", "#", "text"].join("\n");
    expect(parseHeadings(body).map((heading) => heading.path.join(" > "))).toEqual(["A", "A > B", "A > B > C", ""]);
  });

  it("keeps a fence open until a matching closing fence", () => {
    const body = ["````md", "```", "# inside", "````", "# real"].join("\n");
    expect(parseHeadings(body).map((heading) => heading.text)).toEqual(["real"]);
  });
});

describe("sections", () => {
  it("covers the heading and its nested headings up to the next same-or-higher heading", () => {
    expect(getSection(PLAN, "Steps 1–4")).toBe(["## Steps 1–4", "- first", "- second", "", "### Details", "Nested text."].join("\n"));
    expect(getSection(PLAN, "Details")).toBe("### Details\nNested text.");
  });

  it("replaces a section including its heading and keeps the separating blank line", () => {
    const next = replaceSection(PLAN, "Steps 1–4", "## Steps 1–4\n- rewritten\n");
    expect(next).toBe(["# Plan", "Intro line.", "", "## Steps 1–4", "- rewritten", "", "## Steps 5–8", "- third", "", "## Risks", "None.", ""].join("\n"));
  });

  it("can rename a heading by replacing the section", () => {
    expect(replaceSection(PLAN, "Risks", "## Open risks\nTBD")).toContain("## Open risks\nTBD\n");
  });

  it("deletes a section when the replacement is empty", () => {
    const next = replaceSection(PLAN, "Steps 5–8", "  \n");
    expect(next).not.toContain("Steps 5–8");
    expect(next).toContain("## Risks");
    expect(next.endsWith("None.\n")).toBe(true);
  });

  it("disambiguates duplicate headings with a path", () => {
    const body = ["# Plan", "## Backend", "### Tests", "a", "## Frontend", "### Tests", "b"].join("\n");
    expect(() => findSection(body, "Tests")).toThrow(/ambiguous \(2 headings\)[\s\S]*Backend > Tests[\s\S]*Frontend > Tests/);
    expect(getSection(body, "Frontend > Tests")).toBe("### Tests\nb");
    expect(getSection(body, "Plan > Backend > Tests")).toBe("### Tests\na");
  });

  it("refuses a missing heading and lists what exists", () => {
    expect(() => findSection(PLAN, "Nope")).toThrow(PlanEditError);
    expect(() => findSection(PLAN, "Nope")).toThrow(/not found[\s\S]*Plan > Steps 1–4[\s\S]*Plan > Steps 1–4 > Details/);
    expect(() => findSection("no headings", "x")).toThrow(/has no headings/);
  });

  it("never matches a heading that only appears in fenced code", () => {
    expect(() => findSection("# A\n```\n## Fake\n```", "Fake")).toThrow(/not found/);
  });

  it("resolves a heading whose own text contains >", () => {
    expect(getSection("# a > b\ntext", "a > b")).toBe("# a > b\ntext");
  });
});

describe("fragments", () => {
  it("replaces a single exact occurrence", () => {
    expect(replaceFragment(PLAN, "- second", "- second ($1 safe)")).toContain("- second ($1 safe)\n");
  });

  it("refuses zero matches and several matches with their count", () => {
    expect(() => replaceFragment(PLAN, "absent", "x")).toThrow(/0 matches/);
    expect(() => replaceFragment("ab ab", "ab", "x")).toThrow(/2 matches/);
    expect(() => replaceFragment("aaa", "aa", "x")).toThrow(/2 matches/);
    expect(() => replaceFragment(PLAN, "", "x")).toThrow(/must not be empty/);
    expect(countOccurrences("aaa", "aa")).toBe(2);
  });
});

describe("limits and diff", () => {
  it("enforces the body size in UTF-8 bytes and the summary length", () => {
    expect(() => assertPlanText("a".repeat(256 * 1024), "ok")).not.toThrow();
    expect(() => assertPlanText("a".repeat(256 * 1024 + 1), "ok")).toThrow(/256 KB/);
    expect(() => assertPlanText("я".repeat(128 * 1024 + 1), "ok")).toThrow(/256 KB/);
    expect(() => assertPlanText("  ", "ok")).toThrow(/must not be empty/);
    expect(() => assertPlanText("x", "  ")).toThrow(/summary/);
    expect(() => assertPlanText("x", "s".repeat(301))).toThrow(/300/);
  });

  it("counts added and removed lines", () => {
    const result = diffPlanBodies("a\nb\nc\n", "a\nB\nc\nd\n", { from: "v1", to: "v2" });
    expect(result).toMatchObject({ added: 2, removed: 1 });
    expect(result.patch).toContain("-b");
    expect(result.patch).toContain("+B");
  });
});
