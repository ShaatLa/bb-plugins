// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { buildDiffRows, PlanDiffView } from "./diff-view";

afterEach(cleanup);

describe("buildDiffRows", () => {
  it("marks added and removed lines and pairs a changed line for word highlights", () => {
    const rows = buildDiffRows("# T\n\nkeep\nold words here\nlast\n", "# T\n\nkeep\nnew words here\nlast\nextra\n");
    expect(rows.map((row) => [row.kind, row.text])).toEqual([
      ["same", "# T"], ["same", ""], ["same", "keep"],
      ["del", "old words here"], ["add", "new words here"],
      ["same", "last"], ["add", "extra"],
    ]);
    expect(rows[3]!.segments).toEqual([{ text: "old", changed: true }, { text: " words here", changed: false }]);
    expect(rows[4]!.segments).toEqual([{ text: "new", changed: true }, { text: " words here", changed: false }]);
    expect(rows[6]!.segments).toBeUndefined();
  });

  it("treats a first version as all added and equal texts as no rows changed", () => {
    expect(buildDiffRows("", "a\nb\n").map((row) => row.kind)).toEqual(["add", "add"]);
    expect(buildDiffRows("a\n", "a\n").map((row) => row.kind)).toEqual(["same"]);
  });
});

describe("PlanDiffView", () => {
  it("says so when nothing differs", () => {
    const view = render(<PlanDiffView from="a\n" to="a\n" />);
    expect(view.getByText("No differences between these versions.")).toBeTruthy();
  });

  it("folds long unchanged runs and expands them on click", () => {
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index}`);
    const view = render(<PlanDiffView from={`${lines.join("\n")}\n`} to={`${lines.join("\n")}\nadded\n`} />);
    expect(view.container.querySelectorAll("[data-diff]")).toHaveLength(4);
    fireEvent.click(view.getByRole("button", { name: "Show 27 unchanged lines" }));
    expect(view.container.querySelectorAll("[data-diff]")).toHaveLength(31);
  });
});
