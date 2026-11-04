import { expect, it } from "vitest";
import { hasClosedUnmergedPr } from "./diagnostics";
import type { PrLinkState } from "../shared/git-sync";

it("flags a linked closed unmerged PR using its last known snapshot", () => {
  const entry = { link: { excluded: false }, snapshot: { state: "closed" }, error: "offline", stale: true } as PrLinkState;
  expect(hasClosedUnmergedPr([entry])).toBe(true);
  expect(hasClosedUnmergedPr([{ ...entry, link: { ...entry.link, excluded: true } }])).toBe(false);
  expect(hasClosedUnmergedPr([{ ...entry, snapshot: { ...entry.snapshot!, state: "merged" } }])).toBe(false);
  expect(hasClosedUnmergedPr([{ ...entry, snapshot: null }])).toBe(false);
});
