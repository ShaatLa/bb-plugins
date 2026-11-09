import { expect, it } from "vitest";
import { acceptedScheduledRuns, scheduledRunMarker } from "./acceptance";

it("correlates only the accepted request and finds each marked input group", () => {
  const a = "12345678-1234-4123-8123-123456789abc";
  const b = "abcdefab-1234-4123-8123-123456789abc";
  const text = (value: string) => ({ type: "text", text: value });
  const request = { requestId: "r", input: [], inputGroups: [[text(`${scheduledRunMarker(a)}\nA`)], [text("unrelated"), text(`${scheduledRunMarker(b)}\nB`)]] };
  expect(acceptedScheduledRuns(request, "r")).toEqual([a, b]);
  expect(acceptedScheduledRuns(request, "other")).toEqual([]);
  expect(acceptedScheduledRuns({ requestId: "r", input: [text(`quoted ${scheduledRunMarker(a)}`)] }, "r")).toEqual([]);
});
