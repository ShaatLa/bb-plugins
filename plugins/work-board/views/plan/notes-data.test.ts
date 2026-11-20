import { describe, expect, it } from "vitest";
import { deliveryNotice } from "./notes-data";

const handoff = { key: "EXA-1", version: 2, verdict: "needs changes" };
const commands = "bb work-board plan show EXA-1 and bb work-board plan notes EXA-1 --all";

describe("deliveryNotice", () => {
  it("confirms a delivery to everyone", () => {
    expect(deliveryNotice({ delivered: "sent", deliveries: [{ delivered: "sent", threadId: "thr_a" }] }, "Feedback", handoff)).toEqual({ tone: "ok", text: "Feedback sent to the agent" });
  });

  it("names the one recipient that failed, with the version, the verdict and the handoff commands", () => {
    expect(deliveryNotice({ delivered: "failed", deliveries: [{ delivered: "failed", threadId: "thr_a" }] }, "Feedback", handoff).text).toBe(
      `Feedback saved, but not delivered: tell thr_a yourself that EXA-1 plan v2 needs changes. They read it with ${commands}`,
    );
  });

  it("names every thread that was not reached after a partial delivery", () => {
    const text = deliveryNotice({ delivered: "failed", deliveries: [{ delivered: "sent", threadId: "thr_a" }, { delivered: "failed", threadId: "thr_b" }, { delivered: "no_thread", threadId: "thr_c" }] }, "Approval", { ...handoff, verdict: "is approved" }).text;
    expect(text).toContain("tell thr_b, thr_c yourself that EXA-1 plan v2 is approved");
    expect(text).not.toContain("thr_a");
  });

  it("says there is nobody to notify when no thread could be found at all", () => {
    expect(deliveryNotice({ delivered: "no_thread", deliveries: [{ delivered: "no_thread", threadId: null }] }, "Approval", handoff).text).toContain("there is no thread to notify: tell the plan author yourself");
  });
});
