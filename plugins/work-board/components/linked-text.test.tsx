// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LinkedText, withoutLinkTargets } from "./linked-text";

const copy = vi.hoisted(() => vi.fn(async (_input: { text: string }) => true));
vi.mock("@get-bb/plugin-sdk/app", async (actual) => ({ ...await actual<object>(), useBbNavigate: () => ({ openUrl: () => false }), experimental_copyToClipboard: copy }));
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

it("renders inline code without backticks and copies its exact value in one click", async () => {
  const pattern = "^(?:/$|/(?:[0-9a-f]{64}/)?_frame$|/(?:work|review)(?:/|$)) \\d+ a|b".padEnd(500, "x");
  const { container, getByRole, getByText } = render(<LinkedText text={`Set the pattern to \`${pattern}\` and save.`} />);
  expect(container.querySelector("code")?.textContent).toBe(pattern);
  expect(container.textContent).not.toContain("`");
  fireEvent.click(getByRole("button", { name: "Copy code" }));
  await vi.waitFor(() => expect(getByRole("status").textContent).toBe("Copied"));
  expect(copy).toHaveBeenLastCalledWith({ text: pattern });
  copy.mockResolvedValueOnce(false);
  fireEvent.click(getByRole("button", { name: "Copy code" }));
  await vi.waitFor(() => expect(getByText("Copy failed")).toBeTruthy());
  copy.mockRejectedValueOnce(new Error("denied"));
  await act(async () => { fireEvent.click(getByRole("button", { name: "Copy code" })); });
  expect(getByRole("status").textContent).toBe("Copy failed");
});

it("keeps URLs inside code unlinked, links next to code linked, and lone backticks literal", () => {
  expect(links("Open `https://example.com/a` or [b](https://example.com/b)")).toEqual({
    text: "Open https://example.com/a or b", links: [["b", "https://example.com/b"]],
  });
  for (const text of ["a lone ` backtick", "empty `` pair", "split `across\nlines`"]) expect(links(text)).toEqual({ text, links: [] });
  const { container } = render(<LinkedText text="`x` and `y`" copy={false} />);
  expect([...container.querySelectorAll("code")].map(code => code.textContent)).toEqual(["x", "y"]);
  expect(container.querySelector("button")).toBeNull();
  expect(withoutLinkTargets("Check `https://example.com/a` at https://example.com/b")).toBe("Check `https://example.com/a` at ");
});

it("keeps the copy feedback for 2 s after each attempt, including a repeated result", async () => {
  vi.useFakeTimers();
  try {
    const { getByRole } = render(<LinkedText text="`x`" />);
    const click = () => act(async () => { fireEvent.click(getByRole("button", { name: "Copy code" })); });
    await click();
    expect(getByRole("status").textContent).toBe("Copied");
    await act(async () => { vi.advanceTimersByTime(1500); });
    await click();
    await act(async () => { vi.advanceTimersByTime(1500); });
    expect(getByRole("status").textContent).toBe("Copied");
    await act(async () => { vi.advanceTimersByTime(600); });
    expect(getByRole("status").textContent).toBe("");
  } finally { vi.useRealTimers(); }
});
