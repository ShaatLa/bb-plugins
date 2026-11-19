import { expect, it } from "vitest";
import { dispatchedTask, dispatchMarker } from "./dispatch";
const a = "A".repeat(26), b = "B".repeat(26);
const text = (id: string) => ({ type: "text", text: dispatchMarker(id) + "\n# Work" });
it("recognizes only exact dispatch headers on the accepted request", () => {
  expect(dispatchedTask({ requestId: "r", input: [text(a)] }, "r")).toBe(a);
  expect(dispatchedTask({ requestId: "other", input: [text(a)] }, "r")).toBeNull();
  expect(dispatchedTask({ requestId: "r", input: [{ type: "text", text: "Discuss " + dispatchMarker(a) }] }, "r")).toBeNull();
  expect(dispatchedTask({ requestId: "r", input: [text(a)], inputGroups: [[text(a)], [text(b)]] }, "r")).toBeNull();
  expect(dispatchedTask({ requestId: "r", input: [text(a)], inputGroups: [[text(a)], [{ type: "text", text: "Unrelated work" }]] }, "r")).toBeNull();
  expect(dispatchedTask({ requestId: "r", input: [text(a)], inputGroups: [[text(a)], [text(a)]] }, "r")).toBe(a);
  // bb's origin line may precede the marker; nothing else may.
  expect(dispatchedTask({ requestId: "r", input: [{ type: "text", text: `[bb message from plugin:work-board]\n\n${dispatchMarker(a)}\n# Work` }] }, "r")).toBe(a);
  expect(dispatchedTask({ requestId: "r", input: [{ type: "text", text: `Note\n\n${dispatchMarker(a)}\n# Work` }] }, "r")).toBeNull();
});
