// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { TagInput } from "./tag-input";

afterEach(cleanup);

function Field({ initial = [] as string[] }) {
  const [values, setValues] = useState(initial);
  return (
    <>
      <TagInput label="Checks" values={values} onChange={setValues} />
      <output>{values.join("|")}</output>
    </>
  );
}
const input = () => screen.getByRole("textbox", { name: "Checks" });
const shown = () => screen.getByRole("status").textContent;

it("adds names as separate entries with Enter, a comma, a pasted list or on blur, without duplicates", () => {
  render(<Field />);
  fireEvent.change(input(), { target: { value: " build " } });
  fireEvent.keyDown(input(), { key: "Enter" });
  fireEvent.change(input(), { target: { value: "lint" } });
  fireEvent.keyDown(input(), { key: "," });
  fireEvent.paste(input(), { clipboardData: { getData: () => "test\nbuild, e2e" } });
  fireEvent.change(input(), { target: { value: "docs" } });
  fireEvent.blur(input());
  expect(shown()).toBe("build|lint|test|e2e|docs");
  expect(input()).toHaveProperty("value", "");
  expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["build", "lint", "test", "e2e", "docs"]);
});

it("removes an entry with its button, and the last one with Backspace in an empty field", () => {
  render(<Field initial={["build", "lint", "test"]} />);
  fireEvent.click(screen.getByRole("button", { name: "Remove lint" }));
  expect(shown()).toBe("build|test");
  fireEvent.keyDown(input(), { key: "Backspace" });
  expect(shown()).toBe("build");
  fireEvent.change(input(), { target: { value: "x" } });
  fireEvent.keyDown(input(), { key: "Backspace" });
  expect(shown()).toBe("build");
});

it("ignores Enter and a comma while an input method is composing, then adds on the next Enter", () => {
  render(<Field />);
  fireEvent.change(input(), { target: { value: "ビルド" } });
  fireEvent.keyDown(input(), { key: "Enter", isComposing: true });
  fireEvent.keyDown(input(), { key: ",", isComposing: true });
  expect(shown()).toBe("");
  expect(input()).toHaveProperty("value", "ビルド");
  fireEvent.keyDown(input(), { key: "Enter" });
  expect(shown()).toBe("ビルド");
});
