// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { DRAFT_TTL_MS, readAnswerDraft, sweepAnswerDrafts, writeAnswerDraft } from "./answer-draft";

afterEach(() => window.localStorage.clear());

it("drops a draft for an older question revision when it is read", () => {
  writeAnswerDraft("q1", 1, { selected: [], other: true, text: "old" });
  expect(readAnswerDraft("q1", 2)).toBeNull();
  expect(window.localStorage.getItem("bb-work-board:answer-draft:q1")).toBeNull();
});

it("sweeps drafts untouched for the TTL and unreadable entries, keeping fresh ones", async () => {
  writeAnswerDraft("fresh", 1, { selected: [], other: true, text: "keep" });
  window.localStorage.setItem("bb-work-board:answer-draft:stale", JSON.stringify({ revision: 1, selected: [], other: true, text: "x", savedAt: Date.now() - DRAFT_TTL_MS - 1 }));
  window.localStorage.setItem("bb-work-board:answer-draft:broken", "{");
  window.localStorage.setItem("unrelated", "stay");
  await sweepAnswerDrafts(Date.now(), true);
  expect(Object.keys(window.localStorage).sort()).toEqual(["bb-work-board:answer-draft:fresh", "unrelated"]);
});
