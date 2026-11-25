// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LinkedText, withoutLinkTargets } from "./linked-text";

vi.mock("@get-bb/plugin-sdk/app", () => ({ useBbNavigate: () => ({ openUrl: () => false }) }));
afterEach(cleanup);

const links = (text: string) => {
  const { container } = render(<LinkedText text={text} />);
  return { text: container.textContent, links: [...container.querySelectorAll("a")].map((link) => [link.textContent, link.getAttribute("href")]) };
};

it("renders a Markdown link by its label and keeps bare URLs linked", () => {
  expect(links("Does [the empty state](https://example.com/a?x=1) match https://example.com/b.")).toEqual({
    text: "Does the empty state match https://example.com/b.",
    links: [["the empty state", "https://example.com/a?x=1"], ["https://example.com/b", "https://example.com/b"]],
  });
});

it("links an in-app path and keeps other targets as written, their URL text unlinked", () => {
  expect(links("See [EXA-1](/plugins/work-board/work-board/task/EXA-1).")).toEqual({
    text: "See EXA-1.", links: [["EXA-1", "/plugins/work-board/work-board/task/EXA-1"]],
  });
  for (const text of ["[x](javascript:alert(1))", "[x](//example.com/a)", "[x](/\\example.com/a)", "[x](ftp://example.com/https://example.com/a)"])
    expect(links(text)).toEqual({ text, links: [] });
});

it("handles one level of nested brackets in a label and of parentheses in a target", () => {
  expect(links("Read [API [v2]](/docs) and [guide](/docs/a(b)/end).")).toEqual({
    text: "Read API [v2] and guide.",
    links: [["API [v2]", "/docs"], ["guide", "/docs/a(b)/end"]],
  });
});

it("drops only recognised link targets for comparison", () => {
  expect(withoutLinkTargets("[a](https://example.com/1) and [b](/docs/a(b)/end). https://example.com/2.")).toBe("[a]() and [b](). .");
  expect(withoutLinkTargets("[x](javascript:alert(1))")).toBe("[x](javascript:alert(1))");
  expect(withoutLinkTargets("plain ](word) text")).toBe("plain ](word) text");
});
