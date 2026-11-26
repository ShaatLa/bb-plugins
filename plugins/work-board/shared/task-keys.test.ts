import { expect, it } from "vitest";
import { findTaskKeys, withTaskKeyLinks } from "./task-keys";

const keys = (text: string) => findTaskKeys(text).map((range) => range.key);

it("finds a key at the start, middle and end, and before punctuation", () => {
  expect(keys("EXA-1 is blocked by OTH-22, see (EXA-3); fixed in EXA-4.")).toEqual(["EXA-1", "OTH-22", "EXA-3", "EXA-4"]);
  expect(findTaskKeys("see EXA-12")).toEqual([{ key: "EXA-12", start: 4, end: 10 }]);
});

it("takes any prefix shape, so a key of another project counts", () => {
  expect(keys("EXA-1 and OTH-2 and A1B2-3 and ISO-9001")).toEqual(["EXA-1", "OTH-2", "A1B2-3", "ISO-9001"]);
});

it("ignores lowercase, a zero or leading-zero number and a prefix that is too long", () => {
  expect(keys("exa-12 Exa-12 EXA-0 EXA-012 ABCDEFGHIJK-1")).toEqual([]);
});

it("ignores a key glued to letters, digits or dashes", () => {
  expect(keys("xEXA-1 1EXA-1 EXA-1x EXA-12_3 pre-EXA-1 EXA-1-2 EXA-1-b")).toEqual([]);
  expect(keys("EXA-1-")).toEqual(["EXA-1"]);
});

const links = (text: string, ...pairs: Array<[string, string]>) => withTaskKeyLinks(text, new Map(pairs));
const href = (key: string) => `/plugins/work-board/work-board/task/${key}`;

it("links a resolved key in text and leaves an unknown one as written", () => {
  expect(links("EXA-1 then OTH-2.", ["EXA-1", "EXA-1"])).toBe(`[EXA-1](${href("EXA-1")}) then OTH-2.`);
  expect(links("nothing here", ["EXA-1", "EXA-1"])).toBe("nothing here");
});

it("points an old key at the card's current key, keeping the key as written as the label", () => {
  expect(links("see OLD-3", ["OLD-3", "EXA-7"])).toBe(`see [OLD-3](${href("EXA-7")})`);
});

it("leaves fences, inline code, link labels and targets, reference definitions and URLs untouched", () => {
  const untouched = [
    "```\nEXA-1\n```",
    "~~~ts\nEXA-1\n~~~",
    "run `EXA-1` now",
    "[EXA-1](https://example.com)",
    "[docs](https://example.com/EXA-1)",
    "[EXA-1][ref]\n\n[ref]: https://example.com",
    "[ref]: https://example.com/EXA-1",
    "https://example.com/EXA-1/x and <https://example.com/EXA-1>",
  ];
  for (const text of untouched) expect(links(text, ["EXA-1", "EXA-1"])).toBe(text);
  expect(links("```\nEXA-1\n```\nEXA-1 `EXA-1`", ["EXA-1", "EXA-1"])).toBe(`\`\`\`\nEXA-1\n\`\`\`\n[EXA-1](${href("EXA-1")}) \`EXA-1\``);
});

it("leaves code spans of any backtick length, indented and HTML blocks, and nested link labels untouched", () => {
  const same = (text: string) => expect(links(text, ["EXA-1", "EXA-1"])).toBe(text);
  same("run ``EXA-1`` now");
  same("run ``a ` EXA-1 b`` now");
  same("run ```EXA-1``` now");
  same("a `multi\nEXA-1 line` span");
  same("text\n\n    EXA-1 indented\n    more");
  same("~~~\nEXA-1\n~~~");
  same("<div>\nEXA-1\n</div>");
  same("<a href=\"/x/EXA-1\">label</a>");
  same("[see [EXA-1]](https://example.com)");
  same("![EXA-1](https://example.com/a.png)");
  same("<https://example.com/EXA-1>");
});

it("protects a reference only when the body defines it", () => {
  const defs = "\n\n[ref]: https://example.com";
  expect(links(`[EXA-1][ref]${defs}`, ["EXA-1", "EXA-1"])).toBe(`[EXA-1][ref]${defs}`);
  expect(links(`[EXA-1][]\n\n[EXA-1]: https://example.com`, ["EXA-1", "EXA-1"])).toBe(`[EXA-1][]\n\n[EXA-1]: https://example.com`);
  expect(links(`[EXA-1]\n\n[EXA-1]: https://example.com`, ["EXA-1", "EXA-1"])).toBe(`[EXA-1]\n\n[EXA-1]: https://example.com`);
  expect(links("[EXA-1][ref] and [EXA-1]", ["EXA-1", "EXA-1"])).toBe(`[[EXA-1](${href("EXA-1")})][ref] and [[EXA-1](${href("EXA-1")})]`);
});

it("still links a key right after a code span, and in a list item after an unclosed backtick run", () => {
  expect(links("`code`EXA-1 and ``x`` EXA-1", ["EXA-1", "EXA-1"])).toBe(`\`code\`[EXA-1](${href("EXA-1")}) and \`\`x\`\` [EXA-1](${href("EXA-1")})`);
  expect(links("- stray ` then EXA-1", ["EXA-1", "EXA-1"])).toBe(`- stray \` then [EXA-1](${href("EXA-1")})`);
});
